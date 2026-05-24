/**
 * POST /api/tool-readiness/run-tool
 *
 * Capa general de prueba individual de tools. Ejecuta UNA tool del catálogo
 * con args derivados de uno de tres modos y devuelve su resultado normalizado
 * para validar configuración (API keys, plantillas, conectividad) y la forma
 * del resultado sin tener que correr el flow completo.
 *
 * Modos (body.mode):
 *   - "smoke"   → args mínimos genéricos por tool (TEST_DEFAULTS). Valida que
 *                 la integración responde. Default cuando no se especifica.
 *   - "case"    → deriva args desde el `context_jsonb` del caso de prueba más
 *                 reciente del case type. Usa, en este orden:
 *                   1. `OperationalCaseFlowTool.test_inputs_mapping` (si el
 *                       flow lo trae) — mapping declarativo skill-authoring.
 *                   2. `TOOL_TEST_ARG_RECIPES[tool_id]` — recipe TypeScript
 *                       para tools comunes (EasyBroker, etc.).
 *                   3. Genérico por nombre: si el catálogo declara params y
 *                       el caso trae claves con el mismo nombre, las copia.
 *   - "manual"  → usa `body.args` tal cual. Soporta JSON arbitrario.
 *
 * Política por riesgo (V1):
 *   - low                → ejecuta directo.
 *   - medium             → ejecuta sólo si el body trae `confirm: true`; si
 *                          no, devuelve `dry_run: true` con los args
 *   - high (ungga_publish_listing) → ejecuta dry-run real vía Playwright
 *                          (UNGGA_CLI_DRY_RUN=true); no guarda ni publica.
 *   - high (otras)       → no ejecuta; devuelve dry_run con hint (HITL en flow).
 *
 * Modo `preview` (body.preview === true):
 *   No ejecuta la tool; sólo resuelve y devuelve `resolved_args` y
 *   `mode_used`. Útil para que la UI pre-muestre los args antes de correr.
 *
 * El handler se apoya en `buildLangChainTools(ctx)` para reutilizar
 * exactamente los mismos adapters runtime que usa el agente, en vez de
 * volver a implementar la ejecución.
 */
import { NextResponse } from "next/server";

/** Playwright Ungga puede tardar ~1–2 min en dry-run. */
export const maxDuration = 180;
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  listAccountAssets,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOrCreateSession,
} from "@agents/db";
import {
  buildLangChainTools,
  getBusinessBrainWarehouse,
  getSkillRegistryForUser,
  TOOL_CATALOG,
  type ToolContext,
} from "@agents/agent";
import type {
  AccountAsset,
  OperationalCase,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  OperationalCaseRequiredAsset,
  ToolDefinition,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";

type ToolRunMode = "smoke" | "case" | "manual";

type ToolRunBody = {
  case_type_id?: string;
  case_id?: string;
  tool_id?: string;
  mode?: ToolRunMode;
  args?: Record<string, unknown>;
  confirm?: boolean;
  preview?: boolean;
  controlled_real_write?: boolean;
  confirmation_text?: string;
};

const TEST_DEFAULTS: Record<string, Record<string, unknown>> = {
  notify_user: {
    text: "Prueba controlada desde Ajustes: valida que la notificacion al asesor pueda entregarse.",
    kind: "tool_readiness_test",
    urgency: "low",
  },
  bigquery_lookup_local_comparables: { months_back: 24, limit: 100 },
  easybroker_search_listings: { limit: 50 },
  easybroker_search_closed_deals: { limit: 50 },
  ungga_publish_listing: {
    action: "prepare_draft",
    title: "POC test - DELETE ME",
    operation: "sale",
    property_type: "Departamento",
    price: 1000000,
    currency: "MXN",
    construction_m2: 80,
    land_m2: 80,
    condition: "Bueno",
    age_range: "1-5 años",
    current_status: "Habitable",
  },
};

/**
 * Recipes para derivar args desde `context_jsonb` del caso de prueba.
 * Cada recipe recibe el contexto plano y devuelve args parciales para la
 * tool. Diseñado para ser sustituido por `test_inputs_mapping` declarativo
 * desde skill-authoring cuando exista para el flow específico.
 */
const TOOL_TEST_ARG_RECIPES: Record<
  string,
  (ctx: Record<string, unknown>) => Record<string, unknown>
> = {
  easybroker_search_listings: easyBrokerCaseRecipe,
  easybroker_search_closed_deals: easyBrokerCaseRecipe,
  bigquery_lookup_local_comparables: bigQueryLocalComparablesCaseRecipe,
  notify_user: notifyUserCaseRecipe,
  image_watermark: () => ({
    asset_key: "listing_photo_watermark",
    position: "bottom-right",
    opacity: 0.6,
    scale: 0.18,
  }),
  easybroker_create_listing: easyBrokerCreateCaseRecipe,
  easybroker_upload_images: easyBrokerUploadImagesCaseRecipe,
  ungga_publish_listing: unggaPublishCaseRecipe,
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Tools de riesgo alto que sí pueden ejecutarse en dry-run desde esta capa de prueba. */
const HIGH_RISK_DRY_RUN_TOOLS = new Set([
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
]);

const CONTROLLED_REAL_WRITE_TOOLS = new Set([
  "easybroker_create_listing",
  "easybroker_upload_images",
]);
const CONTROLLED_REAL_WRITE_CONFIRMATIONS: Record<string, string> = {
  easybroker_create_listing: "CREAR BORRADOR",
  easybroker_upload_images: "FOTOS A BORRADOR",
};

function controlledRealWriteConfirmation(toolId: string) {
  return CONTROLLED_REAL_WRITE_CONFIRMATIONS[toolId] ?? "";
}

function pickRiskPolicy(
  def: ToolDefinition | undefined,
  confirm: boolean,
  toolId?: string
) {
  const risk = def?.risk ?? "medium";
  if (risk === "low") return { execute: true, reason: "low_risk_auto_execute", forceCliDryRun: false };
  if (risk === "medium") {
    return confirm
      ? { execute: true, reason: "medium_risk_confirmed", forceCliDryRun: false }
      : { execute: false, reason: "medium_risk_requires_confirm", forceCliDryRun: false };
  }
  if (toolId && HIGH_RISK_DRY_RUN_TOOLS.has(toolId)) {
    return {
      execute: true,
      reason: "high_risk_dry_run",
      forceCliDryRun: true,
    };
  }
  return { execute: false, reason: "high_risk_requires_hitl", forceCliDryRun: false };
}

function parseToolOutput(raw: unknown): {
  parsed: unknown;
  text: string | null;
} {
  if (typeof raw === "string") {
    try {
      return { parsed: JSON.parse(raw), text: raw };
    } catch {
      return { parsed: null, text: raw };
    }
  }
  return { parsed: raw, text: null };
}

function summarizeResult(parsed: unknown) {
  if (!isRecord(parsed)) {
    return {
      ok: null,
      status: null,
      count: null,
      preview: null,
    };
  }
  const results = Array.isArray(parsed.results) ? parsed.results : null;
  return {
    ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
    status: typeof parsed.status === "string" ? parsed.status : null,
    count: typeof parsed.count === "number" ? parsed.count : results?.length ?? null,
    preview: results ? results.slice(0, 3) : null,
  };
}

function numericFromContext(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.\-]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstString(ctx: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstStringArray(ctx: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = ctx[key];
    if (Array.isArray(value)) {
      const strings = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
      if (strings.length > 0) return strings;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
  }
  return [];
}

function firstNumber(ctx: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = numericFromContext(ctx[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function contextWithPropertyData(ctx: Record<string, unknown>) {
  const propertyData = isRecord(ctx.property_data) ? ctx.property_data : {};
  return { ...propertyData, ...ctx };
}

function notifyUserCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const merged = contextWithPropertyData(ctx);
  const propertyType =
    firstStringArray(merged, ["property_type", "tipo_propiedad", "tipo"])[0] ??
    "propiedad";
  const operationRaw =
    firstStringArray(merged, ["operation", "operation_type", "tipo_operacion"])[0] ??
    "";
  const normalizedOperation = operationRaw.toLowerCase();
  const operation =
    normalizedOperation === "rent" || normalizedOperation.includes("renta")
    ? "renta"
    : normalizedOperation === "sale" || normalizedOperation.includes("venta")
      ? "venta"
      : "operacion";
  const zona =
    firstString(merged, [
      "zona",
      "property_zone",
      "neighborhood",
      "colonia",
      "property_address",
      "address",
    ]) ?? "la zona capturada";
  const price = firstNumber(merged, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  const priceText =
    price != null
      ? ` Precio de referencia capturado: ${new Intl.NumberFormat("es-MX", {
          style: "currency",
          currency: "MXN",
          maximumFractionDigits: 0,
        }).format(price)}.`
      : "";
  return {
    text: `Prueba controlada desde Ajustes: la habilidad solicita revision del asesor para ${propertyType} en ${operation} en ${zona}.${priceText} No requiere accion real; valida que notify_user pueda entregar mensajes del flow.`,
    kind: "tool_readiness_test",
    urgency: "low",
  };
}

function easyBrokerCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { limit: 50 };
  const zona = firstString(ctx, [
    "zona",
    "property_zone",
    "neighborhood",
    "colonia",
    "city_area",
    "property_address",
  ]);
  if (zona) args.zona = zona;
  const operationRawValues = firstStringArray(ctx, [
    "operation",
    "operation_type",
    "tipo_operacion",
  ]).map((value) => value.toLowerCase());
  const operations = operationRawValues
    .map((operationRaw) => {
      if (operationRaw === "rent" || operationRaw.includes("renta")) return "rent";
      if (operationRaw === "sale" || operationRaw.includes("venta")) return "sale";
      return null;
    })
    .filter((value): value is "sale" | "rent" => value != null);
  const uniqueOperations = Array.from(new Set(operations));
  if (uniqueOperations.length === 1) {
    args.operation = uniqueOperations[0];
  } else if (uniqueOperations.length > 1) {
    args.operations = uniqueOperations;
  }
  const propertyTypes = firstStringArray(ctx, [
    "property_type",
    "tipo_propiedad",
    "tipo",
  ]);
  const uniquePropertyTypes = Array.from(new Set(propertyTypes));
  if (uniquePropertyTypes.length === 1) {
    args.property_type = uniquePropertyTypes[0];
  } else if (uniquePropertyTypes.length > 1) {
    args.property_types = uniquePropertyTypes;
  }
  const minPrice = firstNumber(ctx, ["min_price", "price_min", "precio_min"]);
  const maxPrice = firstNumber(ctx, ["max_price", "price_max", "precio_max"]);
  const targetPrice = firstNumber(ctx, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  if (minPrice != null) args.min_price = minPrice;
  if (maxPrice != null) args.max_price = maxPrice;
  if (targetPrice != null && minPrice == null && maxPrice == null) {
    args.min_price = Math.round(targetPrice * 0.8);
    args.max_price = Math.round(targetPrice * 1.2);
  }
  const minAreaM2 = firstNumber(ctx, ["min_area_m2", "area_min_m2", "superficie_min"]);
  const maxAreaM2 = firstNumber(ctx, ["max_area_m2", "area_max_m2", "superficie_max"]);
  if (minAreaM2 != null) args.min_area_m2 = minAreaM2;
  if (maxAreaM2 != null) args.max_area_m2 = maxAreaM2;
  const bedrooms = firstNumber(ctx, ["bedrooms", "recamaras"]);
  if (bedrooms != null) args.bedrooms = bedrooms;
  const bathrooms = firstNumber(ctx, ["bathrooms", "banos"]);
  if (bathrooms != null) args.bathrooms = bathrooms;
  const parking = firstNumber(ctx, ["parking_spaces", "parking", "estacionamientos"]);
  if (parking != null) args.parking_spaces = parking;
  return args;
}

function bigQueryLocalComparablesCaseRecipe(
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const args: Record<string, unknown> = { months_back: 24, limit: 100 };
  const zona = firstString(ctx, [
    "zona",
    "property_zone",
    "neighborhood",
    "colonia",
    "city_area",
    "property_address",
    "address",
  ]);
  if (zona) args.zona = zona;

  const operation = firstStringArray(ctx, [
    "operation",
    "operation_type",
    "tipo_operacion",
  ])
    .map((value) => value.toLowerCase())
    .map((value) => {
      if (value === "rent" || value.includes("renta")) return "rent";
      if (value === "sale" || value.includes("venta")) return "sale";
      return null;
    })
    .find((value): value is "sale" | "rent" => value != null);
  if (operation) args.operation = operation;

  const propertyType = firstStringArray(ctx, [
    "property_type",
    "tipo_propiedad",
    "tipo",
  ])[0];
  if (propertyType) args.property_type = propertyType;

  const minPrice = firstNumber(ctx, ["min_price", "price_min", "precio_min"]);
  const maxPrice = firstNumber(ctx, ["max_price", "price_max", "precio_max"]);
  const targetPrice = firstNumber(ctx, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  if (targetPrice != null) args.target_price = targetPrice;
  if (minPrice != null) args.min_price = minPrice;
  if (maxPrice != null) args.max_price = maxPrice;

  const areaM2 = firstNumber(ctx, [
    "area_m2",
    "construction_m2",
    "construction_size",
    "superficie",
    "m2",
  ]);
  if (areaM2 != null) {
    args.min_area_m2 = Math.round(areaM2 * 0.7);
    args.max_area_m2 = Math.round(areaM2 * 1.3);
  }

  return args;
}

function unggaPublishCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { action: "prepare_draft" };
  const propertyType =
    firstStringArray(ctx, ["property_type", "tipo_propiedad", "tipo"])[0] ??
    null;
  const operationRaw =
    firstStringArray(ctx, ["operation", "operation_type", "tipo_operacion"])[0] ??
    "sale";
  const operation =
    operationRaw.toLowerCase().includes("renta") || operationRaw === "rent"
      ? "rent"
      : "sale";
  const price = firstNumber(ctx, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  const areaM2 = firstNumber(ctx, [
    "area_m2",
    "construction_m2",
    "construction_size",
    "superficie",
    "m2",
  ]);
  const zona = firstString(ctx, [
    "address",
    "property_address",
    "property_zone",
    "zona",
    "neighborhood",
    "colonia",
  ]);
  args.title =
    firstString(ctx, ["title", "listing_title", "property_title"]) ??
    `POC ${propertyType ?? "propiedad"} en ${zona ?? "Ungga"}`;
  args.description =
    firstString(ctx, ["description", "listing_description"]) ??
    "Borrador generado por Gu OS para revision humana antes de publicar.";
  args.operation = operation;
  if (propertyType) args.property_type = propertyType;
  if (price != null) args.price = price;
  args.currency = firstString(ctx, ["currency", "moneda"]) ?? "MXN";
  if (areaM2 != null) {
    args.construction_m2 = areaM2;
    args.land_m2 = areaM2;
  }
  args.country = firstString(ctx, ["country", "pais"]) ?? "México";
  if (zona) {
    args.address = zona;
    args.location = { zona };
  }
  const bedrooms = firstNumber(ctx, ["bedrooms", "recamaras"]);
  if (bedrooms != null) args.bedrooms = bedrooms;
  const bathrooms = firstNumber(ctx, ["bathrooms", "banos"]);
  if (bathrooms != null) {
    args.bathrooms_full = Math.floor(bathrooms);
    args.bathrooms_half = bathrooms % 1 > 0 ? 1 : 0;
  }
  const parking = firstNumber(ctx, ["parking_spaces", "parking", "estacionamientos"]);
  if (parking != null) args.parking_spaces = parking;
  if (price != null) {
    args.operations = [{ type: operation, price, currency: args.currency }];
  }
  // Ungga exige área de construcción para avanzar en el wizard; si el caso no la trae, usar default de prueba.
  if (args.construction_m2 == null) {
    args.construction_m2 = 80;
    args.land_m2 = 80;
  }
  args.condition =
    firstString(ctx, ["condition", "estado_propiedad", "property_condition"]) ??
    "Bueno";
  args.age_range =
    firstString(ctx, ["age_range", "antiguedad", "property_age"]) ?? "1-5 años";
  args.current_status =
    firstString(ctx, ["current_status", "estado_actual"]) ?? "Habitable";
  // Ungga exige pin en mapa (autocomplete); default de prueba si el caso no trae dirección.
  if (!args.address) {
    args.address =
      "Av. Paseo de la Reforma 222, Juárez, Ciudad de México, CDMX, México";
    args.location = {
      ...(typeof args.location === "object" && args.location
        ? (args.location as Record<string, unknown>)
        : {}),
      zona: "Juárez, Ciudad de México",
    };
  }
  return args;
}

function easyBrokerCreateCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const propertyType = selectPublishPropertyType(ctx);
  const operationRaw =
    firstStringArray(ctx, ["operation", "operation_type", "tipo_operacion"])[0] ??
    "sale";
  const operation =
    operationRaw.toLowerCase().includes("renta") || operationRaw === "rent"
      ? "rent"
      : "sale";
  const price =
    firstNumber(ctx, ["target_price", "expected_price", "asking_price", "price", "precio"]) ??
    21000;
  const zona = firstString(ctx, [
    "zona",
    "property_zone",
    "neighborhood",
    "colonia",
    "property_address",
    "address",
  ]);
  const street =
    firstString(ctx, ["street", "calle"]) ??
    "Av. Patria 2644";
  const locationName =
    firstString(ctx, ["location_name", "neighborhood", "colonia"]) ??
    "Colomos Providencia";
  const locationFullName =
    firstString(ctx, ["location_full_name", "easybroker_location_full_name"]) ??
    zona ??
    "Colomos Providencia, Guadalajara, Jalisco";
  const city = firstString(ctx, ["city", "ciudad"]) ?? "Guadalajara";
  const state = firstString(ctx, ["state", "estado"]) ?? "Jalisco";
  const country = firstString(ctx, ["country", "pais"]) ?? "México";
  const cityArea =
    firstString(ctx, ["city_area", "neighborhood", "colonia"]) ??
    locationName;
  const bedrooms = firstNumber(ctx, ["bedrooms", "recamaras"]) ?? 2;
  const bathrooms = firstNumber(ctx, ["bathrooms", "banos"]);
  const fullBathrooms = bathrooms != null ? Math.floor(bathrooms) : 2;
  const parking = firstNumber(ctx, ["parking_spaces", "parking", "estacionamientos"]) ?? 1;
  const operationLabel = operation === "rent" ? "renta" : "venta";
  args.title =
    firstString(ctx, ["title", "listing_title", "property_title"]) ??
    `${propertyType} en ${operationLabel} en ${cityArea}`;
  args.description =
    firstString(ctx, ["description", "listing_description"]) ??
    `${propertyType} en ${operationLabel} en ${locationFullName}. Cuenta con ${formatCount(
      bedrooms,
      "recámara",
      "recámaras"
    )}, ${formatCount(fullBathrooms, "baño", "baños")} y ${formatCount(
      parking,
      "estacionamiento",
      "estacionamientos"
    )}. Borrador generado por Gu OS para revisión humana antes de publicar.`;
  args.operation = operation;
  args.property_type = propertyType;
  args.price = price;
  args.currency = firstString(ctx, ["currency", "moneda"]) ?? "MXN";
  args.status = "not_published";
  args.street = street;
  const latitude =
    firstNumber(ctx, ["latitude", "lat", "easybroker_latitude"]) ?? 20.7044;
  const longitude =
    firstNumber(ctx, ["longitude", "lng", "lon", "easybroker_longitude"]) ?? -103.3793;
  args.location = {
    street,
    name: locationName,
    full_name: locationFullName,
    type: firstString(ctx, ["location_type"]) ?? "Neighborhood",
    city,
    state,
    country,
    city_area: cityArea,
    latitude,
    longitude,
  };
  const areaM2 = firstNumber(ctx, ["area_m2", "construction_m2", "construction_size", "superficie", "m2"]);
  if (areaM2 != null) args.construction_size = areaM2;
  args.bedrooms = bedrooms;
  args.bathrooms = fullBathrooms;
  if (bathrooms != null && bathrooms % 1 > 0) args.half_bathrooms = 1;
  args.parking_spaces = parking;
  args.features = [
    "Alberca",
    "Gimnasio",
    "Salón de usos múltiples",
    "Terraza",
    "Área de juegos",
  ];
  return args;
}

function formatCount(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function selectPublishPropertyType(ctx: Record<string, unknown>) {
  const explicit =
    firstStringArray(ctx, [
      "publish_property_type",
      "listing_property_type",
      "easybroker_property_type",
    ])[0] ?? null;
  if (explicit) return explicit;
  const candidates = firstStringArray(ctx, [
    "property_type",
    "tipo_propiedad",
    "tipo",
  ]);
  if (candidates.length === 1) return candidates[0];
  const apartment = candidates.find((value) =>
    value.toLowerCase().includes("departamento")
  );
  return apartment ?? candidates[0] ?? "Departamento";
}

function validEasyBrokerListingId(value: unknown) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim() !== "REEMPLAZA-CON-LISTING-ID"
  );
}

function listingIdFromResult(result: unknown) {
  if (!isRecord(result)) return null;
  const listingId = cleanText(result.listing_id);
  if (validEasyBrokerListingId(listingId)) return listingId;
  const publicId = cleanText(result.public_id);
  if (validEasyBrokerListingId(publicId)) return publicId;
  return null;
}

async function latestEasyBrokerCreateListingIdForUser(
  db: ReturnType<typeof createServerClient>,
  userId: string
) {
  const { data: sessions, error: sessionsError } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (sessionsError) {
    console.warn("[run-tool] listing_id session lookup failed:", sessionsError);
    return null;
  }
  const sessionIds = (sessions ?? [])
    .map((session) => (typeof session.id === "string" ? session.id : null))
    .filter((id): id is string => Boolean(id));
  if (sessionIds.length === 0) return null;

  const { data: calls, error: callsError } = await db
    .from("tool_calls")
    .select("result_json")
    .in("session_id", sessionIds)
    .eq("tool_name", "easybroker_create_listing")
    .eq("status", "executed")
    .order("created_at", { ascending: false })
    .limit(20);
  if (callsError) {
    console.warn("[run-tool] listing_id tool_call lookup failed:", callsError);
    return null;
  }

  for (const call of calls ?? []) {
    const listingId = listingIdFromResult(call.result_json);
    if (listingId) return listingId;
  }
  return null;
}

async function hydrateEasyBrokerUploadListingId(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  toolId: string;
  args: Record<string, unknown>;
}) {
  if (params.toolId !== "easybroker_upload_images") return params.args;
  if (validEasyBrokerListingId(params.args.listing_id)) return params.args;
  const listingId = await latestEasyBrokerCreateListingIdForUser(
    params.db,
    params.userId
  );
  if (!listingId) return params.args;
  return {
    ...params.args,
    listing_id: listingId,
  };
}

function applyControlledRealWriteSafeguards(
  toolId: string,
  args: Record<string, unknown>
) {
  if (toolId === "easybroker_upload_images") {
    return {
      ...args,
      dry_run: false,
    };
  }
  const currentTitle =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : "Borrador EasyBroker";
  const safeTitle = currentTitle.startsWith("[PRUEBA - BORRAR]")
    ? currentTitle
    : `[PRUEBA - BORRAR] ${currentTitle}`;
  return {
    ...args,
    title: safeTitle,
    status: "not_published",
    dry_run: false,
  };
}

function easyBrokerUploadImagesCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  return {
    listing_id:
      firstString(ctx, [
        "easybroker_listing_id",
        "listing_id",
        "public_id",
        "easybroker_public_id",
      ]) ?? "REEMPLAZA-CON-LISTING-ID",
  };
}

function genericArgsFromContext(
  def: ToolDefinition,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const schema = def.parameters_schema as
    | { properties?: Record<string, unknown> }
    | undefined;
  const declaredParams = schema?.properties;
  if (!declaredParams || typeof declaredParams !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const paramName of Object.keys(declaredParams)) {
    if (paramName in ctx && ctx[paramName] != null && ctx[paramName] !== "") {
      out[paramName] = ctx[paramName];
    }
  }
  return out;
}

function applyTestInputsMapping(
  mapping: Record<string, string>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [argName, expression] of Object.entries(mapping)) {
    if (typeof expression !== "string") continue;
    const trimmed = expression.trim();
    if (!trimmed) continue;
    if (trimmed in ctx && ctx[trimmed] != null && ctx[trimmed] !== "") {
      out[argName] = ctx[trimmed];
    }
  }
  return out;
}

function flattenFlow(flow: OperationalCaseFlowStep[]): OperationalCaseFlowTool[] {
  const out: OperationalCaseFlowTool[] = [];
  for (const step of flow) {
    for (const tool of step.step_tools ?? []) out.push(tool);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) out.push(tool);
    }
  }
  return out;
}

async function loadLatestTestCase(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseTypeId: string
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type_id", caseTypeId)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[run-tool] loadLatestTestCase failed:", error);
    return null;
  }
  return (data as OperationalCase | null) ?? null;
}

async function effectiveFlowForCaseType(
  db: ReturnType<typeof createServerClient>,
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>
): Promise<OperationalCaseFlowStep[]> {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? caseType.operational_flow_jsonb
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? globalCaseType.operational_flow_jsonb
    : [];
}

function validAssetRequirements(
  requirements: OperationalCaseRequiredAsset[] | undefined
) {
  return Array.isArray(requirements)
    ? requirements.filter(
        (item): item is OperationalCaseRequiredAsset =>
          Boolean(item?.asset_key && item.label)
      )
    : [];
}

function mergeAssetRequirementsWithDefaults(
  defaults: OperationalCaseRequiredAsset[],
  overrides: OperationalCaseRequiredAsset[]
) {
  if (overrides.length === 0) return defaults;
  return overrides.map((override) => {
    const fallback = defaults.find(
      (item) => item.asset_key === override.asset_key
    );
    return fallback ? { ...fallback, ...override } : override;
  });
}

function maxAssetCount(requirement: OperationalCaseRequiredAsset) {
  if (typeof requirement.max_count === "number") return requirement.max_count;
  return 1;
}

function isAssetCollection(requirement: OperationalCaseRequiredAsset) {
  return requirement.collection === true || maxAssetCount(requirement) > 1;
}

function assetsForRequirement(
  assets: AccountAsset[],
  requirement: OperationalCaseRequiredAsset
) {
  const exact = assets.filter((asset) => asset.asset_key === requirement.asset_key);
  if (!isAssetCollection(requirement)) return exact;
  const prefixed = assets.filter((asset) =>
    asset.asset_key.startsWith(`${requirement.asset_key}__`)
  );
  return [...exact, ...prefixed].sort((a, b) =>
    a.asset_key.localeCompare(b.asset_key)
  );
}

async function testAssetRequirementsForTool(params: {
  db: ReturnType<typeof createServerClient>;
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>;
  def: ToolDefinition;
  toolId: string;
}) {
  const flow = await effectiveFlowForCaseType(params.db, params.caseType);
  const flowTool = flattenFlow(flow).find((tool) => tool.tool_id === params.toolId);
  const defaults = validAssetRequirements(params.def.asset_profile?.test);
  const overrides = validAssetRequirements(flowTool?.test_assets);
  return mergeAssetRequirementsWithDefaults(defaults, overrides);
}

interface ArgResolution {
  args: Record<string, unknown>;
  mode_used: ToolRunMode;
  source: string;
  case_id?: string | null;
  case_context_sample?: Record<string, unknown> | null;
}

async function resolveArgsForMode(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseType: NonNullable<Awaited<ReturnType<typeof getOperationalCaseTypeById>>>;
  caseId?: string | null;
  toolId: string;
  def: ToolDefinition;
  mode: ToolRunMode;
  userArgs: Record<string, unknown>;
}): Promise<ArgResolution> {
  const { db, userId, caseType, caseId, toolId, def, mode, userArgs } = params;

  if (mode === "manual") {
    return {
      args: await applyTestAssetsToArgs({
        db,
        userId,
        caseType,
        def,
        toolId,
        args: { ...userArgs },
      }),
      mode_used: "manual",
      source: "manual_user_args",
    };
  }

  if (mode === "case") {
    const requestedCase = caseId ? await getOperationalCase(db, caseId) : null;
    const testCase =
      requestedCase &&
      requestedCase.user_id === userId &&
      requestedCase.case_type_id === caseType.id &&
      requestedCase.context_jsonb?.created_from === "case_type_settings_test" &&
      requestedCase.context_jsonb?.test_mode === true
        ? requestedCase
        : await loadLatestTestCase(db, userId, caseType.id);
    if (!testCase) {
      const normalized = { ...(TEST_DEFAULTS[toolId] ?? {}), ...userArgs };
      return {
        args: await applyTestAssetsToArgs({
          db,
          userId,
          caseType,
          def,
          toolId,
          args: normalized,
        }),
        mode_used: "smoke",
        source: "fallback_smoke_no_test_case",
        case_id: null,
      };
    }
    const ctx = (testCase.context_jsonb ?? {}) as Record<string, unknown>;
    const flow = await effectiveFlowForCaseType(db, caseType);
    const flowTool = flattenFlow(flow).find((tool) => tool.tool_id === toolId);
    const mapping = flowTool?.test_inputs_mapping;
    const recipe = TOOL_TEST_ARG_RECIPES[toolId];

    let derived: Record<string, unknown> = {};
    let source = "generic_param_name_match";
    if (mapping && Object.keys(mapping).length > 0) {
      derived = applyTestInputsMapping(mapping, ctx);
      source = "flow_test_inputs_mapping";
    } else if (recipe) {
      derived = recipe(ctx);
      source = "tool_recipe";
    } else {
      derived = genericArgsFromContext(def, ctx);
    }
    // Defaults de smoke siguen aplicando para campos no derivados (ej. limit),
    // y los args del usuario tienen precedencia final.
    const merged = {
      ...(TEST_DEFAULTS[toolId] ?? {}),
      ...derived,
      ...userArgs,
    };
    const normalized = applyUserOverrideSemantics(toolId, merged, userArgs);
    return {
      args: await applyTestAssetsToArgs({
        db,
        userId,
        caseType,
        def,
        toolId,
        args: normalized,
      }),
      mode_used: "case",
      source,
      case_id: testCase.id,
      case_context_sample: ctx,
    };
  }

  const normalized = applyUserOverrideSemantics(
    toolId,
    { ...(TEST_DEFAULTS[toolId] ?? {}), ...userArgs },
    userArgs
  );
  return {
    args: await applyTestAssetsToArgs({
      db,
      userId,
      caseType,
      def,
      toolId,
      args: normalized,
    }),
    mode_used: "smoke",
    source: "smoke_defaults",
  };
}

async function applyTestAssetsToArgs(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>;
  def: ToolDefinition;
  toolId: string;
  args: Record<string, unknown>;
}) {
  const requirements = await testAssetRequirementsForTool({
    db: params.db,
    caseType: params.caseType,
    def: params.def,
    toolId: params.toolId,
  });
  if (requirements.length === 0) return params.args;
  const assetKeys = requirements.map((requirement) => requirement.asset_key);
  const assetKeyPrefixes = requirements
    .filter(isAssetCollection)
    .map((requirement) => requirement.asset_key);
  const assets = await listAccountAssets(params.db, {
    userId: params.userId,
    assetKeys,
    assetKeyPrefixes,
  });

  const nextArgs = { ...params.args };
  for (const requirement of requirements) {
    if (!requirement.param) continue;
    if (
      Array.isArray(nextArgs[requirement.param]) &&
      (nextArgs[requirement.param] as unknown[]).length > 0
    ) {
      continue;
    }
    const paths = assetsForRequirement(assets, requirement)
      .filter((asset) => typeof asset.storage_path === "string" && asset.storage_path)
      .map((asset) => `${asset.storage_bucket}:${asset.storage_path}`)
      .slice(0, maxAssetCount(requirement));
    if (paths.length > 0) {
      nextArgs[requirement.param] = paths;
    }
  }
  return nextArgs;
}

function applyUserOverrideSemantics(
  toolId: string,
  args: Record<string, unknown>,
  userArgs: Record<string, unknown>
) {
  if (
    toolId !== "easybroker_search_listings" &&
    toolId !== "easybroker_search_closed_deals"
  ) {
    return args;
  }
  const normalized = { ...args };
  const hasUserArg = (key: string) => Object.prototype.hasOwnProperty.call(userArgs, key);

  if (hasUserArg("operation") && !hasUserArg("operations")) {
    delete normalized.operations;
  }
  if (hasUserArg("operations") && !hasUserArg("operation")) {
    delete normalized.operation;
  }
  if (hasUserArg("property_type") && !hasUserArg("property_types")) {
    delete normalized.property_types;
  }
  if (hasUserArg("property_types") && !hasUserArg("property_type")) {
    delete normalized.property_type;
  }

  const roomKeys = [
    "bedrooms",
    "min_bedrooms",
    "bathrooms",
    "min_bathrooms",
    "parking_spaces",
    "min_parking_spaces",
  ];
  const userTouchedRooms = roomKeys.some(hasUserArg);
  if (userTouchedRooms) {
    for (const key of roomKeys) {
      if (!hasUserArg(key)) delete normalized[key];
    }
  } else {
    removeExactIfMinimumWasProvided(normalized, userArgs, "bedrooms", "min_bedrooms");
    removeExactIfMinimumWasProvided(normalized, userArgs, "bathrooms", "min_bathrooms");
    removeExactIfMinimumWasProvided(
      normalized,
      userArgs,
      "parking_spaces",
      "min_parking_spaces"
    );
  }

  return normalized;
}

function removeExactIfMinimumWasProvided(
  args: Record<string, unknown>,
  userArgs: Record<string, unknown>,
  exactKey: string,
  minKey: string
) {
  const hasUserArg = (key: string) => Object.prototype.hasOwnProperty.call(userArgs, key);
  if (hasUserArg(minKey) && !hasUserArg(exactKey)) {
    delete args[exactKey];
  }
}

function toolAllowedForCaseType(
  toolId: string,
  allowedTools: readonly string[],
  rootSkill: string
) {
  if (
    rootSkill === "property-optioning-coach" &&
    toolId === "bigquery_run_query" &&
    allowedTools.includes("bigquery_lookup_local_comparables")
  ) {
    return false;
  }
  return allowedTools.includes(toolId);
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as ToolRunBody;
    const caseTypeId = cleanText(body.case_type_id);
    const caseId = cleanText(body.case_id);
    const toolId = cleanText(body.tool_id);
    const confirm = body.confirm === true;
    const preview = body.preview === true;
    const requestedMode: ToolRunMode =
      body.mode === "case" || body.mode === "manual" || body.mode === "smoke"
        ? body.mode
        : "smoke";
    if (!caseTypeId || !toolId) {
      return NextResponse.json(
        { error: "case_type_id and tool_id are required" },
        { status: 400 }
      );
    }
    const userArgs = isRecord(body.args) ? body.args : {};

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType || (caseType.user_id && caseType.user_id !== user.id)) {
      return NextResponse.json({ error: "case_type_not_found" }, { status: 404 });
    }

    const registry = await getSkillRegistryForUser(db, user.id);
    const skillRecord = registry.get(caseType.default_skill_slug);
    const allowed = skillRecord?.metadata.allowedTools ?? [];
    if (!toolAllowedForCaseType(toolId, allowed, caseType.default_skill_slug)) {
      return NextResponse.json(
        {
          error: "tool_not_allowed_for_case_type",
          tool_id: toolId,
          case_type: caseType.case_type,
        },
        { status: 400 }
      );
    }
    const def = TOOL_CATALOG.find((tool) => tool.id === toolId);
    if (!def) {
      return NextResponse.json(
        { error: "tool_not_in_catalog", tool_id: toolId },
        { status: 400 }
      );
    }

    const resolution = await resolveArgsForMode({
      db,
      userId: user.id,
      caseType,
      caseId: caseId || null,
      toolId,
      def,
      mode: requestedMode,
      userArgs,
    });
    const resolvedArgs = await hydrateEasyBrokerUploadListingId({
      db,
      userId: user.id,
      toolId,
      args: resolution.args,
    });

    const controlledRealWriteRequested = body.controlled_real_write === true;
    const expectedControlledConfirmation = controlledRealWriteConfirmation(toolId);
    if (
      controlledRealWriteRequested &&
      (!CONTROLLED_REAL_WRITE_TOOLS.has(toolId) ||
        cleanText(body.confirmation_text) !== expectedControlledConfirmation)
    ) {
      return NextResponse.json(
        {
          error: "controlled_real_write_not_allowed",
          hint: `Esta prueba real controlada requiere una tool permitida y escribir "${expectedControlledConfirmation}".`,
        },
        { status: 400 }
      );
    }
    if (
      controlledRealWriteRequested &&
      toolId === "easybroker_upload_images" &&
      !validEasyBrokerListingId(resolvedArgs.listing_id)
    ) {
      return NextResponse.json(
        {
          error: "controlled_real_write_missing_listing_id",
          hint:
            "Para subir fotos realmente debes indicar un listing_id real de EasyBroker en los args avanzados o en el caso de prueba.",
          resolved_args: resolvedArgs,
        },
        { status: 400 }
      );
    }
    const policy = pickRiskPolicy(def, confirm, toolId);
    const resolvedArgsForExecution = controlledRealWriteRequested
      ? applyControlledRealWriteSafeguards(toolId, resolvedArgs)
      : policy.forceCliDryRun === true &&
          (toolId === "easybroker_create_listing" ||
            toolId === "easybroker_upload_images")
        ? { ...resolvedArgs, dry_run: true }
        : resolvedArgs;

    if (preview) {
      return NextResponse.json({
        ok: true,
        executed: false,
        tool_id: toolId,
        dry_run: true,
        reason: "preview_only",
        risk: def.risk,
        requested_mode: requestedMode,
        mode_used: resolution.mode_used,
        mode_source: resolution.source,
        case_id: resolution.case_id ?? null,
        case_context_sample: resolution.case_context_sample ?? null,
        resolved_args: resolvedArgsForExecution,
      });
    }

    if (!controlledRealWriteRequested && !policy.execute) {
      return NextResponse.json({
        ok: true,
        executed: false,
        tool_id: toolId,
        dry_run: true,
        reason: policy.reason,
        risk: def.risk,
        requested_mode: requestedMode,
        mode_used: resolution.mode_used,
        mode_source: resolution.source,
        case_id: resolution.case_id ?? null,
        resolved_args: resolvedArgsForExecution,
        hint:
          policy.reason === "medium_risk_requires_confirm"
            ? "Esta tool es de riesgo medio; envía confirm:true para ejecutarla desde la prueba individual."
            : "Esta tool es de riesgo alto. Por seguridad sólo se ejecuta dentro del flow con HITL.",
      });
    }

    const forceCliDryRun =
      !controlledRealWriteRequested && policy.forceCliDryRun === true;
    if (forceCliDryRun && toolId === "ungga_publish_listing") {
      process.env.UNGGA_TOOL_TEST_DRY_RUN = "true";
    }

    ensureAgentToolDepsWired();
    const [
      { data: toolSettings },
      { data: integrations },
      { data: profile },
    ] = await Promise.all([
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id),
      supabase
        .from("profiles")
        .select("business_brain, is_ungga_admin")
        .eq("id", user.id)
        .single(),
    ]);
    const session = await getOrCreateSession(db, user.id, "web");
    const businessBrain =
      profile?.business_brain &&
      typeof profile.business_brain === "object" &&
      !Array.isArray(profile.business_brain)
        ? profile.business_brain
        : {};
    const warehouse = getBusinessBrainWarehouse(businessBrain);
    const tenantOrganizationId =
      profile?.is_ungga_admin === true
        ? undefined
        : warehouse?.organization_id?.trim() || undefined;

    const ctx: ToolContext = {
      db,
      userId: user.id,
      sessionId: session.id,
      channel: "web",
      enabledTools: (toolSettings ?? []) as UserToolSetting[],
      integrations: (integrations ?? []) as UserIntegration[],
      // Sólo dejamos disponible esta tool durante la prueba individual:
      // evita que el agente o adapters dependientes confundan el contexto.
      activeSkillAllowedTools: [toolId],
      tenantOrganizationId,
      bigQueryProjectId: warehouse?.project_id?.trim() || undefined,
      bigQueryLocation: warehouse?.location?.trim() || undefined,
    };

    const tools = buildLangChainTools(ctx);
    const lcTool = tools.find((item) => item.name === toolId) as
      | { invoke: (args: unknown) => Promise<unknown> }
      | undefined;
    if (!lcTool) {
      return NextResponse.json(
        {
          error: "tool_not_built_for_user",
          tool_id: toolId,
          hint:
            "La tool existe en el catálogo pero no está disponible para esta cuenta. Revisa user_tool_settings y permisos.",
        },
        { status: 400 }
      );
    }

    const startedAt = Date.now();
    let invokeError: string | null = null;
    let raw: unknown = null;
    try {
      raw = await lcTool.invoke(resolvedArgsForExecution);
    } catch (err) {
      invokeError = err instanceof Error ? err.message : String(err);
    } finally {
      if (forceCliDryRun && toolId === "ungga_publish_listing") {
        delete process.env.UNGGA_TOOL_TEST_DRY_RUN;
      }
    }
    const elapsedMs = Date.now() - startedAt;
    const { parsed, text } = parseToolOutput(raw);
    const summary = summarizeResult(parsed);
    const toolOk = summary.ok ?? (invokeError === null ? true : false);

    return NextResponse.json({
      ok: invokeError === null && toolOk !== false,
      executed: true,
      tool_id: toolId,
      risk: def.risk,
      dry_run: forceCliDryRun,
      reason: controlledRealWriteRequested
        ? "high_risk_controlled_real_write"
        : policy.reason,
      hint: forceCliDryRun
        ? toolId === "ungga_publish_listing"
          ? "Dry-run completado: Playwright abrió Ungga y recorrió el wizard sin guardar borrador ni publicar. Revisa status, stages y validation_errors en el JSON."
          : "Dry-run completado: se validó el payload sin enviar escritura real a EasyBroker."
        : controlledRealWriteRequested
          ? toolId === "easybroker_upload_images"
            ? "Prueba real controlada ejecutada: se intentó adjuntar las fotos al borrador indicado en EasyBroker. Revisa la ficha y elimina el borrador cuando termines de validar."
            : "Prueba real controlada ejecutada: se intentó crear un borrador not_published en EasyBroker. Si fue exitoso, bórralo manualmente del inventario cuando termines de validar."
        : undefined,
      requested_mode: requestedMode,
      mode_used: resolution.mode_used,
      mode_source: resolution.source,
      case_id: resolution.case_id ?? null,
      resolved_args: resolvedArgsForExecution,
      elapsed_ms: elapsedMs,
      error: invokeError,
      summary,
      result: parsed,
      raw_text: parsed == null ? text : undefined,
    });
  } catch (err) {
    console.error("[POST /api/tool-readiness/run-tool] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
