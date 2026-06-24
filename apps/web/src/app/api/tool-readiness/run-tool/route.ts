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
import { createHash } from "node:crypto";

/** Playwright Ungga puede tardar ~1–2 min en dry-run. */
export const maxDuration = 180;
import { createClient } from "@/lib/supabase/server";
import {
  createOperationalCaseDocument,
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  listAccountAssets,
  getOperationalCase,
  getOperationalCaseTypeById,
  getGoogleCalendarAccessToken,
  getOrCreateSession,
  listOperationalCaseDocuments,
  expireExternalContactNotificationsForCase,
  updateOperationalCase,
  createToolCall,
  updateToolCallStatus,
} from "@agents/db";
import {
  buildLangChainTools,
  deriveComparableAreaBand,
  sanitizeComparableSearchFilters,
  deriveCommissionContractTemplateData,
  getBusinessBrainWarehouse,
  getSkillRegistryForUser,
  resolveSkill,
  TOOL_CATALOG,
  type ToolContext,
} from "@agents/agent";
import type {
  AccountAsset,
  OperationalCase,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  OperationalCaseIntakeField,
  OperationalCaseRequiredAsset,
  ToolDefinition,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { mergeContextForToolRecipes } from "@/lib/operational-cases/property-search-zone";
import { buildTestContext } from "../../operational-case-tests/test-context-samples";

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
  /** Paso/skill desde el que se abrió la prueba en Preparación operativa. */
  readiness_skill_slug?: string;
  readiness_flow_step_key?: string;
};

type ToolRecipeInput = {
  ctx: Record<string, unknown>;
  testCase?: OperationalCase | null;
  caseType?: { case_type: string; intake_schema_jsonb?: unknown };
  skillSlug?: string;
  flowStepKey?: string;
};

const TEST_DEFAULTS: Record<string, Record<string, unknown>> = {
  telegram_send_message_to_contact: {
    text: "Hola, soy parte del equipo inmobiliario. Esta es una prueba controlada de mensaje externo; no requiere accion.",
    purpose: "tool_readiness_test",
  },
  notify_user: {
    text: "Prueba controlada desde Ajustes: valida que la notificacion al asesor pueda entregarse.",
    kind: "tool_readiness_test",
    urgency: "low",
  },
  operational_case_register_document: {
    kind: "escritura_descripcion",
    display_name: "Escritura - descripcion",
    source: "settings_test",
    blocking: true,
  },
  bigquery_lookup_local_comparables: { months_back: 24, limit: 100 },
  easybroker_search_listings: { limit: 50 },
  easybroker_search_closed_deals: { limit: 50 },
  geocode_property_address: {
    street: "San Carlos",
    exterior_number: "710",
    neighborhood: "San Carlos",
    municipality: "Metepec",
    state: "Estado de México",
    postal_code: "52159",
    country: "MX",
  },
  get_avaclick_valuation: {
    customer_name: "Cliente de prueba",
    customer_email: "cliente.prueba@example.com",
    customer_phone: "3331234567",
    property_type: "condo_house",
    latitude: 19.270469527143423,
    longitude: -99.62444830066556,
    state_name: "Estado de México",
    municipality_name: "Metepec",
    neighborhood_name: "San Carlos",
    zip_code: "52159",
    street: "San Carlos",
    exterior_number: "710",
    land_area_m2: 1095,
    construction_area_m2: 545,
    age_years: 20,
    parking_spaces: 1,
    bedrooms: 1,
    full_bathrooms: 1,
    half_bathrooms: 1,
    floors: 1,
    conservation: "new",
    private_amenities: [],
    common_amenities: [],
  },
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
  generate_document_from_template: {
    template_slug: "commission_contract",
    format: "docx",
    data: {
      owner_name: "Contacto de prueba",
      property_address:
        "Privada del Tulipán 1501, Sendas Residencial G1, Zapopan, Jalisco",
      property_type: "departamento",
      area_m2: 116.93,
      salida_price: 25000,
      minimum_price: 20000,
      commission_pct: 5,
      exclusive: true,
      duration_months: 6,
    },
  },
  // Catálogo sin properties (schema vacío): smoke/caso envían {} a propósito.
  get_user_preferences: {},
  list_enabled_tools: {},
  read_skill_reference: { name: "coach-routing" },
};

/** Referencia bajo `property-optioning-coach/references/` usada en N1 transversal. */
const READ_SKILL_REFERENCE_CASE_CONTEXT_KEY = "skill_reference_name";

function smokeDefaultsForTool(
  toolId: string,
  caseType: { case_type: string; intake_schema_jsonb?: unknown }
): Record<string, unknown> {
  if (toolId === "operational_case_create") {
    const fields = Array.isArray(caseType.intake_schema_jsonb)
      ? (caseType.intake_schema_jsonb as OperationalCaseIntakeField[])
      : [];
    return {
      case_type: caseType.case_type,
      context: {
        ...buildTestContext(fields, caseType.case_type),
        created_from: "tool_readiness_test",
        test_mode: true,
      },
    };
  }
  return TEST_DEFAULTS[toolId] ?? {};
}

const TEST_PROPERTY_DOCUMENT_ASSET_KEY = "test_property_document";
const TEST_PROPERTY_DOCUMENT_KIND = "escritura_descripcion";
const DOCUMENT_READINESS_TOOLS = new Set([
  "operational_case_register_document",
  "operational_case_list_documents",
  "operational_case_extract_document_fields",
]);

class MissingTestDocumentAssetError extends Error {
  constructor() {
    super("missing_test_document_asset");
    this.name = "MissingTestDocumentAssetError";
  }
}

/**
 * Recipes para derivar args desde `context_jsonb` del caso de prueba.
 * Cada recipe recibe el contexto plano y devuelve args parciales para la
 * tool. Diseñado para ser sustituido por `test_inputs_mapping` declarativo
 * desde skill-authoring cuando exista para el flow específico.
 */
const TOOL_TEST_ARG_RECIPES: Record<
  string,
  (input: ToolRecipeInput) => Record<string, unknown>
> = {
  easybroker_search_listings: (input) => easyBrokerCaseRecipe(input.ctx),
  easybroker_search_closed_deals: (input) => easyBrokerCaseRecipe(input.ctx),
  bigquery_lookup_local_comparables: (input) =>
    bigQueryLocalComparablesCaseRecipe(input.ctx),
  geocode_property_address: (input) => geocodeAddressCaseRecipe(input.ctx),
  get_avaclick_valuation: (input) => avaclickValuationCaseRecipe(input.ctx),
  telegram_send_message_to_contact: telegramContactCaseRecipe,
  notify_user: (input) => notifyUserCaseRecipe(input.ctx),
  generate_document_from_template: generateDocumentFromTemplateCaseRecipe,
  image_watermark: () => ({
    asset_key: "listing_photo_watermark",
    position: "bottom-right",
    opacity: 0.6,
    scale: 0.18,
  }),
  easybroker_create_listing: (input) => easyBrokerCreateCaseRecipe(input.ctx),
  easybroker_upload_images: (input) =>
    easyBrokerUploadImagesCaseRecipe(input.ctx),
  ungga_publish_listing: (input) => unggaPublishCaseRecipe(input.ctx),
  operational_case_create: operationalCaseCreateCaseRecipe,
  operational_case_update_state: operationalCaseUpdateStateCaseRecipe,
  calendar_list_events: calendarListEventsCaseRecipe,
  calendar_create_event: calendarCreateEventCaseRecipe,
  calendar_update_event: calendarUpdateEventCaseRecipe,
  read_skill_reference: readSkillReferenceCaseRecipe,
};

function readSkillReferenceCaseRecipe(
  input: ToolRecipeInput
): Record<string, unknown> {
  const fromContext = input.ctx[READ_SKILL_REFERENCE_CASE_CONTEXT_KEY];
  if (typeof fromContext === "string" && fromContext.trim()) {
    return { name: fromContext.trim() };
  }
  return TEST_DEFAULTS.read_skill_reference ?? { name: "coach-routing" };
}

/**
 * Tools que en smoke no tienen plantilla estática útil (requieren `case_id` real).
 * Si existe el caso aislado de Preparación operativa, smoke arma args como en
 * Caso de prueba (recipe o match por nombre de param + `case_id`).
 */
/** Tools que en N1 no registran tool_calls en el adapter; persistimos evidencia para el pill «Probada». */
const READINESS_RECORDS_TOOL_CALL = new Set([
  "get_user_preferences",
  "list_enabled_tools",
  "calendar_create_event",
  "calendar_update_event",
]);

const SMOKE_BINDS_TEST_CASE_WHEN_PRESENT = new Set([
  "operational_case_update_state",
  "operational_case_list_documents",
  "operational_case_extract_document_fields",
  "operational_case_register_document",
]);

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function intakeFieldsForCaseType(
  caseType: ToolRecipeInput["caseType"]
): OperationalCaseIntakeField[] {
  return Array.isArray(caseType?.intake_schema_jsonb)
    ? (caseType.intake_schema_jsonb as OperationalCaseIntakeField[])
    : [];
}

function intakeContextFromSettingsTestCase(input: ToolRecipeInput): Record<string, unknown> {
  const fields = intakeFieldsForCaseType(input.caseType);
  const base = buildTestContext(fields, input.caseType?.case_type ?? "property_optioning");
  const intake: Record<string, unknown> = {};
  const allowedNames = new Set(fields.map((field) => field.name));

  for (const field of fields) {
    const value = input.ctx[field.name];
    if (value === undefined || value === null || value === "") {
      if (base[field.name] !== undefined && base[field.name] !== "") {
        intake[field.name] = base[field.name];
      }
      continue;
    }
    intake[field.name] = value;
  }

  // Preserva valores auxiliares que las recipes usan pero que algunos case types
  // no declaran en intake. No copia artefactos de readiness ni historial del caso.
  for (const key of ["condition", "age_range", "current_status", "address", "currency"]) {
    if (!allowedNames.has(key) && input.ctx[key] != null && input.ctx[key] !== "") {
      intake[key] = input.ctx[key];
    } else if (!allowedNames.has(key) && base[key] != null && base[key] !== "") {
      intake[key] = base[key];
    }
  }
  return intake;
}

/**
 * Deriva `case_type` + `context` desde el caso de prueba de Preparación operativa.
 * Crea una instancia nueva (no reutiliza el caso aislado de settings).
 */
function operationalCaseCreateCaseRecipe(
  input: ToolRecipeInput
): Record<string, unknown> {
  const caseType =
    typeof input.testCase?.case_type === "string" && input.testCase.case_type.trim()
      ? input.testCase.case_type.trim()
      : typeof input.caseType?.case_type === "string" && input.caseType.case_type.trim()
        ? input.caseType.case_type.trim()
        : typeof input.ctx.case_type === "string" && input.ctx.case_type.trim()
          ? String(input.ctx.case_type).trim()
        : "property_optioning";
  const intake = intakeContextFromSettingsTestCase(input);
  const args: Record<string, unknown> = {
    case_type: caseType,
    context: {
      ...intake,
      created_from: "tool_readiness_test",
      test_mode: true,
    },
  };
  const chatId = firstNumber(input.ctx, ["telegram_chat_id"]);
  const displayName =
    firstString(input.ctx, ["owner_name", "lead_name", "contact_name"]) ??
    "Contacto de prueba";
  const external = input.testCase?.external_contact_jsonb;
  if (Number.isFinite(chatId)) {
    args.external_contact = {
      channel: "telegram",
      chat_id: chatId,
      display_name: displayName,
    };
  } else if (external && typeof external === "object") {
    args.external_contact = external;
  }
  return args;
}

/** Args mínimos para validar `operational_case_update_state` contra el caso de prueba. */
function operationalCaseUpdateStateCaseRecipe(
  input: ToolRecipeInput
): Record<string, unknown> {
  const testCase = input.testCase;
  if (!testCase) return {};
  const args: Record<string, unknown> = {
    case_id: testCase.id,
    expected_version: testCase.version,
  };
  if (testCase.current_step === "intake" || testCase.current_step == null) {
    args.current_step = "awaiting_documents";
    args.status = "active";
    args.context_patch = {
      intake_validated_by: "tool_readiness_test",
    };
  }
  return args;
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
  "telegram_send_message_to_contact",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "calendar_create_event",
]);
const CONTROLLED_REAL_WRITE_CONFIRMATIONS: Record<string, string> = {
  telegram_send_message_to_contact: "ENVIAR PRUEBA",
  easybroker_create_listing: "CREAR BORRADOR",
  easybroker_upload_images: "FOTOS A BORRADOR",
  calendar_create_event: "CREAR EVENTO PRUEBA",
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
  const events = Array.isArray(parsed.events) ? parsed.events : null;
  return {
    ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
    status: typeof parsed.status === "string" ? parsed.status : null,
    count:
      typeof parsed.count === "number"
        ? parsed.count
        : events?.length ?? results?.length ?? null,
    preview: events ? events.slice(0, 3) : results ? results.slice(0, 3) : null,
  };
}

function isPlaceholderCalendarEventId(eventId: unknown) {
  const id = cleanText(typeof eventId === "string" ? eventId : "");
  return (
    !id ||
    id === "EVENT_ID_FROM_PRIOR_CREATE_EVENT_TEST" ||
    /^replace_with_/i.test(id)
  );
}

/**
 * Varios adapters devuelven errores en el JSON (p. ej. Calendar API 404) sin lanzar
 * excepción; N1 debe fallar en esos casos, no marcar Éxito por invoke sin throw.
 */
function evaluateGenericToolReadinessResult(
  parsed: unknown,
  toolId: string
): { ok: boolean; hint?: string } {
  if (!isRecord(parsed)) {
    return { ok: false, hint: "La tool no devolvió un resultado JSON interpretable." };
  }
  if (parsed.ok === false) {
    return {
      ok: false,
      hint:
        typeof parsed.error === "string" && parsed.error.trim()
          ? parsed.error
          : "La tool devolvió ok: false.",
    };
  }
  if (typeof parsed.error === "string" && parsed.error.trim()) {
    const httpStatus =
      typeof parsed.status === "number" && Number.isFinite(parsed.status)
        ? parsed.status
        : null;
    if (toolId === "calendar_update_event" && httpStatus === 404) {
      return {
        ok: false,
        hint:
          "Google Calendar respondió 404: el event_id no existe. Crea un evento de prueba con «Crear evento de calendario» (confirma ejecución), copia el campo id del JSON de respuesta y pégalo en Avanzado como event_id.",
      };
    }
    if (toolId.startsWith("calendar_") && httpStatus != null && httpStatus >= 400) {
      return {
        ok: false,
        hint: `${parsed.error} (HTTP ${httpStatus}). Revisa los args y la integración de Google Calendar.`,
      };
    }
    return { ok: false, hint: parsed.error };
  }
  if (parsed.needs_period === true) {
    return {
      ok: true,
      hint: "Integración OK: la tool pidió un período (comportamiento esperado sin time_min/time_max).",
    };
  }
  if (toolId === "read_skill_reference") {
    const status = typeof parsed.status === "string" ? parsed.status : "";
    if (status === "ok") {
      return { ok: true };
    }
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message
        : status
          ? `read_skill_reference devolvió status=${status}.`
          : "read_skill_reference no devolvió contenido (revisa skill activa y el stem name).";
    return { ok: false, hint: message };
  }
  return { ok: true };
}

async function resolveReadinessActiveSkill(
  registry: Awaited<ReturnType<typeof getSkillRegistryForUser>>,
  rootSlug: string | undefined
): Promise<{
  activeSkillName?: string;
  activeSkillReferenceNames?: readonly string[];
}> {
  const slug = rootSlug?.trim();
  if (!slug) return {};
  try {
    const resolved = await resolveSkill(slug, registry);
    return {
      activeSkillName: resolved.rootName,
      activeSkillReferenceNames: resolved.composedFrom,
    };
  } catch (err) {
    console.warn(
      `[run-tool] resolveSkill failed for ${slug}:`,
      err instanceof Error ? err.message : err
    );
    return { activeSkillName: slug };
  }
}

function documentExtractionHasStructuredFields(extraction: unknown) {
  if (!isRecord(extraction)) return false;
  const meaningfulKeys = [
    "property_description",
    "address",
    "area_total_m2",
    "area_construida_m2",
    "owner_names",
    "folio_real",
    "predial_account",
  ];
  return meaningfulKeys.some((key) => {
    const value = extraction[key];
    if (Array.isArray(value)) return value.length > 0;
    return value != null && value !== "";
  });
}

function evaluateDocumentExtractionTest(parsed: unknown) {
  if (!isRecord(parsed) || parsed.ok !== true) {
    return { ok: false as const, hint: undefined as string | undefined };
  }
  const status =
    typeof parsed.extraction_status === "string" ? parsed.extraction_status : "";
  const extraction = isRecord(parsed.extraction) ? parsed.extraction : null;
  const hasFields = documentExtractionHasStructuredFields(extraction);
  const missingDeedArea =
    extraction &&
    typeof extraction.document_kind === "string" &&
    extraction.document_kind.toLowerCase().includes("escritura") &&
    typeof extraction.area_total_m2 !== "number";
  if (status === "ok" && hasFields && !missingDeedArea) {
    return { ok: true as const, hint: undefined as string | undefined };
  }
  if (status === "low_confidence" || status === "failed" || !hasFields || missingDeedArea) {
    const warnings = extraction?.warnings;
    const warningText = Array.isArray(warnings)
      ? warnings.filter((item): item is string => typeof item === "string").join(" ")
      : "";
    return {
      ok: false as const,
      hint:
        (missingDeedArea
          ? "La extracción no capturó area_total_m2 de la escritura. Verifica que la página con superficie esté legible o prueba con force=true tras reemplazar el archivo."
          : warningText) ||
        "La tool respondió, pero no extrajo campos estructurados. Sube una imagen legible (jpg/png) de la escritura-descripción o usa Avanzado con force=true tras reemplazar el archivo.",
    };
  }
  return { ok: true as const, hint: undefined as string | undefined };
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

function splitMexicanZone(value: string | null): {
  neighborhood?: string;
  municipality?: string;
  state?: string;
} {
  if (!value) return {};
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return { neighborhood: value };
  const state = parts.at(-1);
  const municipality = parts.at(-2);
  const neighborhood = parts.slice(0, -2).join(", ");
  return { neighborhood, municipality, state };
}

function contextWithPropertyData(ctx: Record<string, unknown>) {
  const propertyData = isRecord(ctx.property_data) ? ctx.property_data : {};
  return { ...propertyData, ...ctx };
}

function comparablePropertyTypes(ctx: Record<string, unknown>) {
  return Array.from(
    new Set(
      firstStringArray(ctx, ["property_type", "tipo_propiedad", "tipo"]).filter(Boolean)
    )
  );
}

function comparableText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function comparablePropertyKind(propertyTypes: string[]) {
  const normalized = propertyTypes.map(comparableText);
  if (normalized.some((value) => /\b(terreno|lote|land)\b/.test(value))) {
    return "land" as const;
  }
  if (normalized.some((value) => /\b(bodega|nave industrial|nave)\b/.test(value))) {
    return "industrial" as const;
  }
  if (
    normalized.some((value) => /\b(casa|departamento|depto|apartment|residencial)\b/.test(value))
  ) {
    return "residential" as const;
  }
  return "other" as const;
}

function easyBrokerComparablePropertyTypes(
  ctx: Record<string, unknown>,
  propertyTypes: string[]
) {
  const contextText = comparableText(
    [
      ...propertyTypes,
      ctx.land_context,
      ctx.property_context,
      ctx.industrial_context,
      ctx.notes,
    ].join(" ")
  );
  const out: string[] = [];
  const add = (...values: string[]) => {
    for (const value of values) {
      if (!out.includes(value)) out.push(value);
    }
  };

  for (const type of propertyTypes) {
    const normalized = comparableText(type);
    if (!normalized) continue;
    if (normalized.includes("casa en condominio")) {
      add("Casa en condominio");
    } else if (/\bcasa\b/.test(normalized)) {
      add("Casa", "Casa en condominio");
    } else if (/\b(departamento|depto|apartment)\b/.test(normalized)) {
      add("Departamento");
    } else if (/\b(terreno|lote|land)\b/.test(normalized)) {
      if (normalized.includes("industrial") || contextText.includes("parque industrial")) {
        add("Terreno industrial");
      } else {
        add("Terreno");
      }
    } else if (normalized.includes("bodega comercial")) {
      add("Bodega comercial");
    } else if (/\b(bodega|nave industrial|nave)\b/.test(normalized)) {
      add("Bodega industrial", "Nave industrial");
    } else if (/\boficina\b/.test(normalized)) {
      add("Oficina");
    } else if (normalized.includes("local en centro comercial")) {
      add("Local en centro comercial");
    } else if (/\blocal\b/.test(normalized)) {
      add("Local comercial");
    } else {
      add(type);
    }
  }

  return out.length > 0 ? out : propertyTypes;
}

function comparableOperationArgs(ctx: Record<string, unknown>) {
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
  return {
    operation: uniqueOperations.length === 1 ? uniqueOperations[0] : undefined,
    operations: uniqueOperations.length > 1 ? uniqueOperations : undefined,
  };
}

function comparableAreaArgs(ctx: Record<string, unknown>) {
  const merged = contextWithPropertyData(ctx);
  const minAreaM2 = firstNumber(merged, [
    "min_area_m2",
    "area_min_m2",
    "superficie_min",
  ]);
  const maxAreaM2 = firstNumber(merged, [
    "max_area_m2",
    "area_max_m2",
    "superficie_max",
  ]);
  if (minAreaM2 != null || maxAreaM2 != null) {
    return {
      min_area_m2: minAreaM2 ?? undefined,
      max_area_m2: maxAreaM2 ?? undefined,
    };
  }
  const areaBand = deriveComparableAreaBand({ propertyData: merged });
  if (!areaBand) return {};
  return {
    min_area_m2: areaBand.min_area_m2,
    max_area_m2: areaBand.max_area_m2,
  };
}

function comparablePriceArgs(
  ctx: Record<string, unknown>,
  allowTargetBand: boolean
): {
  min_price?: number;
  max_price?: number;
  target_price?: number;
} {
  const minPrice = firstNumber(ctx, ["min_price", "price_min", "precio_min"]);
  const maxPrice = firstNumber(ctx, ["max_price", "price_max", "precio_max"]);
  const targetPrice = firstNumber(ctx, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  if (minPrice != null || maxPrice != null) {
    return {
      min_price: minPrice ?? undefined,
      max_price: maxPrice ?? undefined,
      target_price: targetPrice ?? undefined,
    };
  }
  if (!allowTargetBand || targetPrice == null) return {};
  return {
    min_price: Math.round(targetPrice * 0.8),
    max_price: Math.round(targetPrice * 1.2),
    target_price: targetPrice,
  };
}

/** Offset fijo CST (UTC-6) para ventanas de prueba; suficiente para N1 de coordinación de fotos. */
const CALENDAR_TEST_TZ_OFFSET_HOURS = -6;

function calendarPartsInTestTimezone(now: Date) {
  const shifted = new Date(now.getTime() - CALENDAR_TEST_TZ_OFFSET_HOURS * 3600000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function instantAtTestTimezone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
) {
  return new Date(
    Date.UTC(year, month, day, hour - CALENDAR_TEST_TZ_OFFSET_HOURS, minute, 0)
  );
}

/** Mañana 8:00 → +5 días 20:00 (coordinate-photo-session). */
function photoSessionCalendarListWindow(now = new Date()) {
  const { year, month, day } = calendarPartsInTestTimezone(now);
  return {
    time_min: instantAtTestTimezone(year, month, day + 1, 8).toISOString(),
    time_max: instantAtTestTimezone(year, month, day + 6, 20).toISOString(),
  };
}

function propertyAddressLabel(ctx: Record<string, unknown>) {
  const merged = contextWithPropertyData(ctx);
  const address = isRecord(merged.address) ? merged.address : {};
  return (
    firstString(address as Record<string, unknown>, [
      "formatted",
      "full",
      "line1",
      "street",
    ]) ??
    firstString(merged, [
      "property_address",
      "address",
      "title",
      "property_title",
    ]) ??
    "propiedad en prueba"
  );
}

/** Primera ventana diurna ~2 días después, 10:00–12:00 (horario de propuesta de fotos). */
function photoSessionDefaultSlot(now = new Date()) {
  const { year, month, day } = calendarPartsInTestTimezone(now);
  const start = instantAtTestTimezone(year, month, day + 2, 10);
  const end = instantAtTestTimezone(year, month, day + 2, 12);
  return { start, end };
}

function calendarListEventsCaseRecipe(): Record<string, unknown> {
  const window = photoSessionCalendarListWindow();
  return {
    calendar_id: "primary",
    time_min: window.time_min,
    time_max: window.time_max,
  };
}

function calendarCreateEventCaseRecipe(input: ToolRecipeInput): Record<string, unknown> {
  const ctx = input.ctx;
  const photoSession = isRecord(ctx.photo_session) ? ctx.photo_session : {};
  const scheduledAt =
    typeof photoSession.scheduled_at === "string" ? photoSession.scheduled_at.trim() : "";
  const slot =
    scheduledAt && Number.isFinite(Date.parse(scheduledAt))
      ? {
          start: new Date(scheduledAt),
          end: new Date(Date.parse(scheduledAt) + 2 * 3600000),
        }
      : photoSessionDefaultSlot();
  const address = propertyAddressLabel(ctx);
  const caseId = input.testCase?.id;
  const descriptionParts = [
    caseId ? `case_id: ${caseId}` : null,
    "Prueba N1 — coordinación de fotos (settings test).",
  ].filter(Boolean);
  return {
    calendar_id: "primary",
    summary: `Sesión fotos · ${address}`,
    start_datetime: slot.start.toISOString(),
    end_datetime: slot.end.toISOString(),
    description: descriptionParts.join(" "),
  };
}

function calendarUpdateEventCaseRecipe(input: ToolRecipeInput): Record<string, unknown> {
  const ctx = input.ctx;
  const photoSession = isRecord(ctx.photo_session) ? ctx.photo_session : {};
  const eventId = firstString(photoSession, ["calendar_event_id", "event_id"]);
  const base = calendarCreateEventCaseRecipe(input);
  const start =
    typeof base.start_datetime === "string" && Number.isFinite(Date.parse(base.start_datetime))
      ? new Date(base.start_datetime)
      : photoSessionDefaultSlot().start;
  const end =
    typeof base.end_datetime === "string" && Number.isFinite(Date.parse(base.end_datetime))
      ? new Date(base.end_datetime)
      : photoSessionDefaultSlot().end;
  const shiftedStart = new Date(start.getTime() + 24 * 3600000);
  const shiftedEnd = new Date(end.getTime() + 24 * 3600000);
  return {
    calendar_id: "primary",
    event_id: eventId ?? "EVENT_ID_FROM_PRIOR_CREATE_EVENT_TEST",
    summary: base.summary,
    start_datetime: shiftedStart.toISOString(),
    end_datetime: shiftedEnd.toISOString(),
    description: eventId
      ? String(base.description ?? "")
      : `${base.description ?? ""} Sin calendar_event_id en el caso: usa «Crear evento de prueba en Google Calendar» en la tool de crear evento o pega event_id en Avanzado.`.trim(),
  };
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

/** Args N1 alineados a prepare-commission-contract / catálogo (template_slug, format, data). */
function generateDocumentFromTemplateCaseRecipe(
  input: ToolRecipeInput
): Record<string, unknown> {
  const ctx = input.ctx;
  const propertyData = isRecord(ctx.property_data) ? ctx.property_data : {};
  const proposal = isRecord(ctx.pricing_proposal) ? ctx.pricing_proposal : {};
  const commission = isRecord(ctx.commission_terms) ? ctx.commission_terms : {};

  const external = input.testCase?.external_contact_jsonb;

  const args: Record<string, unknown> = {
    template_slug: "commission_contract",
    format: "docx",
    data: deriveCommissionContractTemplateData({
      case_context: ctx,
      property_data: propertyData,
      pricing_proposal: proposal,
      commission_terms: commission,
      external_contact:
        external && typeof external === "object" && !Array.isArray(external)
          ? (external as Record<string, unknown>)
          : {},
    }),
  };
  if (input.testCase?.id) args.case_id = input.testCase.id;
  return args;
}

function isCharacteristicsTelegramContext(input: ToolRecipeInput) {
  if (input.skillSlug === "extract-property-characteristics") return true;
  const currentStep =
    typeof input.testCase?.current_step === "string"
      ? input.testCase.current_step
      : firstString(input.ctx, ["current_step"]);
  return currentStep === "documents_received";
}

function missingCriticalPropertyQuestions(propertyData: Record<string, unknown>) {
  const address = isRecord(propertyData.address) ? propertyData.address : {};
  const merged = { ...propertyData, ...address };
  const questions: string[] = [];
  if (!firstString(merged, ["operation", "operation_type", "tipo_operacion"])) {
    questions.push("¿La propiedad es para venta o renta?");
  }
  if (!firstString(merged, ["property_type", "tipo_propiedad", "tipo"])) {
    questions.push("¿Qué tipo de propiedad es (departamento, casa, terreno, etc.)?");
  }
  if (
    !firstString(merged, ["street", "street_name", "calle"]) &&
    !firstString(merged, ["property_address", "address"])
  ) {
    questions.push("¿Cuál es la calle y número de la propiedad?");
  }
  if (typeof propertyData.area_total_m2 !== "number") {
    questions.push("¿Cuántos metros cuadrados totales tiene?");
  }
  if (propertyData.bedrooms == null) {
    questions.push("¿Cuántas recámaras tiene?");
  }
  if (propertyData.bathrooms == null) {
    questions.push("¿Cuántos baños completos tiene?");
  }
  return questions.slice(0, 4);
}

function telegramCharacteristicsMessage(input: ToolRecipeInput) {
  const merged = contextWithPropertyData(input.ctx);
  const ownerName =
    firstString(merged, ["owner_name", "contact_name", "lead_name"]) ??
    "Contacto";
  const propertyTitle =
    firstString(merged, ["title", "property_title"]) ?? "la propiedad";
  const propertyData = isRecord(input.ctx.property_data)
    ? input.ctx.property_data
    : {};
  const questions = missingCriticalPropertyQuestions(propertyData);
  const questionBlock =
    questions.length > 0
      ? questions.map((question, index) => `${index + 1}. ${question}`).join("\n")
      : "1. ¿Puedes confirmar que los datos de la propiedad que tenemos son correctos?";
  return (
    `Hola ${ownerName}, gracias por los documentos de ${propertyTitle}. ` +
    "Para completar la ficha antes de comparables, me ayudaría confirmar:\n\n" +
    `${questionBlock}\n\n` +
    "Puedes responder por aquí con texto. Si además cuentas con boleta registral, predial, escritura, identificación o comprobante, también envíalos para fortalecer la validación documental."
  );
}

function telegramRequestDocumentsMessage(input: ToolRecipeInput) {
  const merged = contextWithPropertyData(input.ctx);
  const ownerName =
    firstString(merged, ["owner_name", "contact_name", "lead_name"]) ??
    "Contacto";
  const propertyTitle =
    firstString(merged, ["title", "property_title"]) ?? "la propiedad";
  const zona =
    firstString(merged, ["property_zone", "zona", "neighborhood", "colonia"]) ??
    "la zona capturada";
  return (
    `Hola ${ownerName}, estamos preparando la opción de comercialización de ${propertyTitle} en ${zona}. ` +
    "Para validar la propiedad de forma más sólida, envíame por favor los documentos disponibles en este orden: boleta registral (referencia principal de titularidad), predial más reciente, escritura (primera/última hoja o sección descriptiva), identificación oficial y comprobante de domicilio. " +
    "Si alguno no lo tienes a la mano, envía lo disponible y seguimos; los faltantes se pueden confirmar por texto sin detener el proceso."
  );
}

function telegramContactCaseRecipe(input: ToolRecipeInput): Record<string, unknown> {
  const merged = contextWithPropertyData(input.ctx);
  const telegramChatId = firstNumber(merged, [
    "telegram_chat_id",
    "external_chat_id",
    "chat_id",
  ]);
  const characteristicsContext = isCharacteristicsTelegramContext(input);
  return {
    ...(telegramChatId != null ? { chat_id: telegramChatId } : {}),
    text: characteristicsContext
      ? telegramCharacteristicsMessage(input)
      : telegramRequestDocumentsMessage(input),
    purpose: characteristicsContext ? "characteristics_pending" : "request_documents",
  };
}

function easyBrokerCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const merged = contextWithPropertyData(ctx);
  const args: Record<string, unknown> = { limit: 50 };
  const propertyTypes = comparablePropertyTypes(merged);
  const propertyKind = comparablePropertyKind(propertyTypes);
  const easyBrokerPropertyTypes = easyBrokerComparablePropertyTypes(merged, propertyTypes);

  const zona = firstString(merged, [
    "zona",
    "property_zone",
    "neighborhood",
    "colonia",
    "city_area",
    "property_address",
  ]);
  if (zona) args.zona = zona;
  const operationArgs = comparableOperationArgs(merged);
  if (operationArgs.operation) args.operation = operationArgs.operation;
  if (operationArgs.operations) args.operations = operationArgs.operations;

  const uniquePropertyTypes = easyBrokerPropertyTypes;
  if (uniquePropertyTypes.length === 1) {
    args.property_type = uniquePropertyTypes[0];
  } else if (uniquePropertyTypes.length > 1) {
    args.property_types = uniquePropertyTypes;
  }
  const priceArgs = comparablePriceArgs(merged, propertyKind === "residential");
  if (priceArgs.min_price != null) args.min_price = priceArgs.min_price;
  if (priceArgs.max_price != null) args.max_price = priceArgs.max_price;

  const areaArgs = comparableAreaArgs(merged);
  if (areaArgs.min_area_m2 != null) args.min_area_m2 = areaArgs.min_area_m2;
  if (areaArgs.max_area_m2 != null) args.max_area_m2 = areaArgs.max_area_m2;

  const shouldUseResidentialRooms = propertyKind === "residential";
  if (shouldUseResidentialRooms) {
    const bedrooms = firstNumber(merged, ["bedrooms", "recamaras"]);
    if (bedrooms != null) args.bedrooms = bedrooms;
    const bathrooms = firstNumber(merged, ["bathrooms", "banos"]);
    if (bathrooms != null) args.bathrooms = bathrooms;
    const parking = firstNumber(merged, ["parking_spaces", "parking", "estacionamientos"]);
    if (parking != null) args.parking_spaces = parking;
  }
  const sanitized = sanitizeComparableSearchFilters({
    raw: args,
    propertyData: merged,
  });
  return sanitized.search_validity === "valid"
    ? sanitized.filters
    : sanitized.suggested_filters ?? sanitized.filters;
}

function bigQueryLocalComparablesCaseRecipe(
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const merged = contextWithPropertyData(ctx);
  const args: Record<string, unknown> = { months_back: 24, limit: 100 };
  const propertyTypes = comparablePropertyTypes(merged);
  const propertyKind = comparablePropertyKind(propertyTypes);
  const zona = firstString(merged, [
    "zona",
    "property_zone",
    "neighborhood",
    "colonia",
    "city_area",
    "property_address",
    "address",
  ]);
  if (zona) args.zona = zona;

  const operationArgs = comparableOperationArgs(merged);
  if (operationArgs.operation) args.operation = operationArgs.operation;

  const propertyType = propertyTypes[0];
  if (propertyType) args.property_type = propertyType;

  const priceArgs = comparablePriceArgs(merged, propertyKind === "residential");
  if (priceArgs.target_price != null) args.target_price = priceArgs.target_price;
  if (priceArgs.min_price != null) args.min_price = priceArgs.min_price;
  if (priceArgs.max_price != null) args.max_price = priceArgs.max_price;

  const areaArgs = comparableAreaArgs(merged);
  if (areaArgs.min_area_m2 != null) args.min_area_m2 = areaArgs.min_area_m2;
  if (areaArgs.max_area_m2 != null) args.max_area_m2 = areaArgs.max_area_m2;

  const sanitized = sanitizeComparableSearchFilters({
    raw: args,
    propertyData: merged,
  });
  return sanitized.search_validity === "valid"
    ? sanitized.filters
    : sanitized.suggested_filters ?? sanitized.filters;
}

function avaclickValuationCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const merged = contextWithPropertyData(ctx);
  const addressRecord = isRecord(merged.address)
    ? (merged.address as Record<string, unknown>)
    : {};
  const args: Record<string, unknown> = {};
  const propertyTypes = firstStringArray(merged, [
    "property_type",
    "tipo_propiedad",
    "tipo",
  ]);
  const normalizedTypes = propertyTypes.map((value) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
  );
  const isHouse = normalizedTypes.some((value) => value.includes("casa"));
  const isApartment = normalizedTypes.some(
    (value) => value.includes("departamento") || value.includes("depto")
  );
  if (isApartment) {
    args.property_type = "condo_apartment";
    args.land_area_m2 = 0;
    args.floors = 0;
  } else if (isHouse) {
    const condoHint =
      firstString(merged, ["land_context", "property_context", "notes"]) ?? "";
    const normalizedHint = condoHint
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    args.property_type = normalizedHint.includes("condominio")
      ? "condo_house"
      : "house";
  } else {
    args.property_type = TEST_DEFAULTS.get_avaclick_valuation?.property_type ?? "house";
  }

  const zona = firstString(merged, [
    "property_zone",
    "zona",
    "neighborhood",
    "colonia",
    "city_area",
  ]);
  const parsedZone = splitMexicanZone(zona);
  const state =
    firstString(merged, ["state_name", "state", "estado"]) ??
    firstString(addressRecord, ["state", "estado"]) ??
    parsedZone.state;
  if (state) args.state_name = state;
  const municipality =
    firstString(merged, ["municipality_name", "municipality", "municipio", "city"]) ??
    firstString(addressRecord, ["municipality", "municipio", "city"]) ??
    parsedZone.municipality;
  if (municipality) args.municipality_name = municipality;
  const neighborhood =
    firstString(merged, ["neighborhood_name", "neighborhood", "colonia"]) ??
    firstString(addressRecord, ["neighborhood", "colonia"]) ??
    parsedZone.neighborhood ??
    zona;
  if (neighborhood) args.neighborhood_name = neighborhood;

  const street =
    firstString(merged, ["street", "calle"]) ??
    firstString(addressRecord, ["street", "calle"]) ??
    neighborhood ??
    firstString(merged, ["property_address", "address"]);
  if (street) args.street = street;
  const exteriorNumber =
    firstString(merged, ["exterior_number", "numero_exterior"]) ??
    firstString(addressRecord, ["exterior_number", "numero_exterior"]);
  if (exteriorNumber) args.exterior_number = exteriorNumber;
  const interiorNumber =
    firstString(merged, ["interior_number", "numero_interior"]) ??
    firstString(addressRecord, ["interior_number", "numero_interior"]);
  if (interiorNumber) args.interior_number = interiorNumber;
  const postal =
    firstString(merged, ["postal_code", "cp", "zip_code"]) ??
    firstString(addressRecord, ["postal_code", "cp", "zip_code"]);
  args.zip_code = postal ?? "00000";

  const latitude = firstNumber(merged, ["latitude", "lat"]);
  if (latitude != null) args.latitude = latitude;
  const longitude = firstNumber(merged, ["longitude", "lng", "lon"]);
  if (longitude != null) args.longitude = longitude;

  const areaM2 = firstNumber(merged, [
    "construction_area_m2",
    "area_construida_m2",
    "construction_m2",
    "construction_size",
    "area_m2",
    "m2",
  ]);
  if (areaM2 != null && areaM2 > 0) args.construction_area_m2 = Math.round(areaM2);
  const landM2 = firstNumber(merged, ["land_area_m2", "area_total_m2", "terreno"]);
  if (landM2 != null) args.land_area_m2 = Math.round(landM2);

  const bedrooms = firstNumber(merged, ["bedrooms", "recamaras"]);
  if (bedrooms != null) args.bedrooms = bedrooms;
  const bathrooms = firstNumber(merged, ["bathrooms", "banos"]);
  if (bathrooms != null) {
    args.full_bathrooms = Math.floor(bathrooms);
    args.half_bathrooms = bathrooms % 1 > 0 ? 1 : 0;
  }
  const parking = firstNumber(merged, ["parking_spaces", "parking", "estacionamientos"]);
  if (parking != null) args.parking_spaces = parking;
  const floors = firstNumber(merged, ["floors", "numero_pisos", "plantas"]);
  if (floors != null) args.floors = floors;
  const age = firstNumber(merged, ["age_years", "edad"]);
  if (age != null) args.age_years = age;
  const conservation = firstString(merged, ["conservation", "conservacion"]);
  if (conservation) args.conservation = conservation;

  const ownerName =
    firstString(merged, ["customer_name", "owner_name", "lead_name", "contact_name"]) ??
    null;
  args.customer_name =
    ownerName ?? TEST_DEFAULTS.get_avaclick_valuation?.customer_name ?? "Cliente de prueba";
  const customerEmail = firstString(merged, ["customer_email", "email"]);
  args.customer_email =
    customerEmail ??
    TEST_DEFAULTS.get_avaclick_valuation?.customer_email ??
    "cliente.prueba@example.com";
  const customerPhone = firstString(merged, ["customer_phone", "phone", "telefono"]);
  args.customer_phone =
    customerPhone ?? TEST_DEFAULTS.get_avaclick_valuation?.customer_phone ?? "3331234567";

  return args;
}

function geocodeAddressCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const merged = contextWithPropertyData(ctx);
  const addressRecord = isRecord(merged.address)
    ? (merged.address as Record<string, unknown>)
    : {};
  const defaults = TEST_DEFAULTS.geocode_property_address ?? {};
  const zona = firstString(merged, ["property_zone", "zona", "city_area"]);
  const parsedZone = splitMexicanZone(zona);
  const hasCaseLocation = Boolean(
    zona ||
      firstString(merged, ["neighborhood", "colonia"]) ||
      firstString(addressRecord, ["neighborhood", "colonia"]) ||
      firstString(merged, ["municipality", "municipio", "city"]) ||
      firstString(addressRecord, ["municipality", "municipio", "city"]) ||
      firstString(merged, ["state", "estado"]) ||
      firstString(addressRecord, ["state", "estado"])
  );

  const neighborhood =
    firstString(merged, ["neighborhood", "colonia"]) ??
    firstString(addressRecord, ["neighborhood", "colonia"]) ??
    parsedZone.neighborhood ??
    (hasCaseLocation ? null : defaults.neighborhood ?? "San Carlos");

  const municipality =
    firstString(merged, ["municipality", "municipio", "city"]) ??
    firstString(addressRecord, ["municipality", "municipio", "city"]) ??
    parsedZone.municipality ??
    (hasCaseLocation ? null : defaults.municipality ?? "Metepec");

  const state =
    firstString(merged, ["state", "estado"]) ??
    firstString(addressRecord, ["state", "estado"]) ??
    parsedZone.state ??
    (hasCaseLocation ? null : defaults.state ?? "Estado de México");

  const street =
    firstString(merged, ["street", "calle"]) ??
    firstString(addressRecord, ["street", "calle"]) ??
    (() => {
      const fullAddress = firstString(merged, ["address", "property_address"]);
      if (fullAddress && parsedZone.neighborhood) {
        return parsedZone.neighborhood;
      }
      const firstPart = fullAddress?.split(",")[0]?.trim();
      return firstPart || neighborhood || null;
    })() ??
    (hasCaseLocation ? neighborhood : defaults.street ?? "San Carlos");

  const exteriorNumber =
    firstString(merged, ["exterior_number", "numero_exterior"]) ??
    firstString(addressRecord, ["exterior_number", "numero_exterior"]) ??
    (hasCaseLocation ? null : defaults.exterior_number ?? "710");

  const postalCode =
    firstString(merged, ["zip_code", "postal_code", "cp"]) ??
    firstString(addressRecord, ["zip_code", "postal_code", "cp"]) ??
    (hasCaseLocation ? null : defaults.postal_code ?? "52159");

  const country =
    firstString(merged, ["country", "pais"]) ??
    firstString(addressRecord, ["country", "pais"]) ??
    defaults.country ??
    "MX";

  const args: Record<string, unknown> = { country };
  if (street) args.street = street;
  if (exteriorNumber) args.exterior_number = exteriorNumber;
  if (neighborhood) args.neighborhood = neighborhood;
  if (municipality) args.municipality = municipality;
  if (state) args.state = state;
  if (postalCode) args.postal_code = postalCode;
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

function calendarEventIdFromToolResult(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const id = cleanText(parsed.id);
  return id || null;
}

async function persistPhotoSessionCalendarEventIdForTestCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string | null | undefined,
  eventId: string
) {
  const trimmed = eventId.trim();
  if (!caseId || !trimmed) return;
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  if (
    context.created_from !== "case_type_settings_test" &&
    context.test_mode !== true
  ) {
    return;
  }
  const photoSession = isRecord(context.photo_session)
    ? (context.photo_session as Record<string, unknown>)
    : {};
  await updateOperationalCase(db, opCase.id, opCase.version, {
    context: {
      ...context,
      photo_session: {
        ...photoSession,
        calendar_event_id: trimmed,
        source: "tool_readiness_test",
      },
    },
  });
}

function applyControlledRealWriteSafeguards(
  toolId: string,
  args: Record<string, unknown>
) {
  if (toolId === "calendar_create_event") {
    const summary =
      typeof args.summary === "string" && args.summary.trim()
        ? args.summary.trim()
        : "Sesión fotos · prueba";
    const safeSummary = summary.startsWith("[PRUEBA CONTROLADA]")
      ? summary
      : `[PRUEBA CONTROLADA] ${summary}`;
    return {
      ...args,
      calendar_id:
        typeof args.calendar_id === "string" && args.calendar_id.trim()
          ? args.calendar_id
          : "primary",
      summary: safeSummary,
    };
  }
  if (toolId === "telegram_send_message_to_contact") {
    const currentText =
      typeof args.text === "string" && args.text.trim()
        ? args.text.trim()
        : "Mensaje de prueba";
    return {
      ...args,
      text: currentText.startsWith("[PRUEBA CONTROLADA]")
        ? currentText
        : `[PRUEBA CONTROLADA]\n${currentText}`,
      purpose:
        typeof args.purpose === "string" && args.purpose.trim()
          ? args.purpose
          : "tool_readiness_test",
    };
  }
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

function enrichCaseContextFromDocuments(
  ctx: Record<string, unknown>,
  documents: Awaited<ReturnType<typeof listOperationalCaseDocuments>>
) {
  const propertyData = isRecord(ctx.property_data) ? { ...ctx.property_data } : {};
  for (const doc of documents) {
    const extraction = doc.extraction_jsonb;
    if (!isRecord(extraction) || doc.extraction_status !== "ok") continue;
    if (
      typeof propertyData.area_total_m2 !== "number" &&
      typeof extraction.area_total_m2 === "number"
    ) {
      propertyData.area_total_m2 = extraction.area_total_m2;
    }
    if (
      typeof propertyData.area_construida_m2 !== "number" &&
      typeof extraction.area_construida_m2 === "number"
    ) {
      propertyData.area_construida_m2 = extraction.area_construida_m2;
    }
    if (isRecord(extraction.address) && !isRecord(propertyData.address)) {
      propertyData.address = extraction.address;
    }
    if (
      !firstString(propertyData, ["property_description", "description"]) &&
      typeof extraction.property_description === "string"
    ) {
      propertyData.property_description = extraction.property_description;
    }
  }
  return { ...ctx, property_data: propertyData };
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
  readinessSkillSlug?: string;
  readinessFlowStepKey?: string;
}): Promise<ArgResolution> {
  const {
    db,
    userId,
    caseType,
    caseId,
    toolId,
    def,
    mode,
    userArgs,
    readinessSkillSlug,
    readinessFlowStepKey,
  } = params;

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
    const ctxRaw = (testCase.context_jsonb ?? {}) as Record<string, unknown>;
    const ctx =
      toolId === "telegram_send_message_to_contact" &&
      (readinessSkillSlug === "extract-property-characteristics" ||
        testCase.current_step === "documents_received")
        ? enrichCaseContextFromDocuments(
            ctxRaw,
            await listOperationalCaseDocuments(db, { caseId: testCase.id })
          )
        : ctxRaw;
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
      derived = recipe({
        ctx: mergeContextForToolRecipes(ctx),
        testCase,
        caseType,
        skillSlug: readinessSkillSlug,
        flowStepKey: readinessFlowStepKey,
      });
      source = "tool_recipe";
    } else {
      derived = genericArgsFromContext(def, ctx);
    }
    // Defaults de smoke siguen aplicando para campos no derivados (ej. limit),
    // salvo en tools con datos de direccion/propiedad de fixture completo
    // (Avaclick, Geocoding): no deben mezclarse con el formulario del caso.
    const caseDefaults =
      toolId === "get_avaclick_valuation" || toolId === "geocode_property_address"
        ? {}
        : (TEST_DEFAULTS[toolId] ?? {});
    const merged = {
      ...caseDefaults,
      ...derived,
      ...userArgs,
    };
    if (
      (toolId === "telegram_send_message_to_contact" ||
        toolId === "operational_case_register_document" ||
        toolId === "operational_case_list_documents" ||
        toolId === "generate_document_from_template") &&
      !merged.case_id
    ) {
      merged.case_id = testCase.id;
    }
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

  if (SMOKE_BINDS_TEST_CASE_WHEN_PRESENT.has(toolId)) {
    const testCase = await loadLatestTestCase(db, userId, caseType.id);
    if (testCase) {
      const ctx = (testCase.context_jsonb ?? {}) as Record<string, unknown>;
      const recipe = TOOL_TEST_ARG_RECIPES[toolId];
      const derived = recipe
        ? recipe({
            ctx,
            testCase,
            caseType,
            skillSlug: readinessSkillSlug,
            flowStepKey: readinessFlowStepKey,
          })
        : (() => {
            const fromContext = genericArgsFromContext(def, ctx);
            if (!fromContext.case_id) fromContext.case_id = testCase.id;
            return fromContext;
          })();
      const normalized = applyUserOverrideSemantics(
        toolId,
        { ...(TEST_DEFAULTS[toolId] ?? {}), ...derived, ...userArgs },
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
        source: "smoke_bound_test_case",
        case_id: testCase.id,
        case_context_sample: ctx,
      };
    }
  }

  const normalized = applyUserOverrideSemantics(
    toolId,
    { ...smokeDefaultsForTool(toolId, caseType), ...userArgs },
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

function originalNameForAsset(asset: AccountAsset) {
  const originalName = asset.metadata_jsonb?.original_name;
  return typeof originalName === "string" && originalName.trim()
    ? originalName.trim()
    : asset.display_name;
}

function documentKindFromAsset(asset: AccountAsset) {
  const kind = asset.metadata_jsonb?.document_kind;
  return typeof kind === "string" && kind.trim()
    ? kind.trim()
    : TEST_PROPERTY_DOCUMENT_KIND;
}

function documentKindLabel(kind: string) {
  const labels: Record<string, string> = {
    escritura_descripcion: "Escritura - descripcion",
    predial: "Predial",
    ine: "INE",
    comprobante_domicilio: "Comprobante de domicilio",
    boleta_registral: "Boleta registral",
    escritura_primera_hoja: "Escritura - primera hoja",
    escritura_ultima_hoja: "Escritura - ultima hoja",
    unknown: "Sin clasificar",
  };
  return labels[kind] ?? kind;
}

function isBlockingDocumentKind(kind: string) {
  return kind === TEST_PROPERTY_DOCUMENT_KIND;
}

async function loadAllDocumentTestAssets(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>;
  def: ToolDefinition;
  toolId: string;
}) {
  const requirements = await testAssetRequirementsForTool(params);
  const requirement =
    requirements.find(
      (item) => item.asset_key === TEST_PROPERTY_DOCUMENT_ASSET_KEY
    ) ?? requirements[0];
  if (!requirement) return [];
  const assets = await listAccountAssets(params.db, {
    userId: params.userId,
    assetKeys: [requirement.asset_key],
    assetKeyPrefixes: isAssetCollection(requirement)
      ? [requirement.asset_key]
      : undefined,
  });
  return assetsForRequirement(assets, requirement);
}

async function sha256ForAsset(
  db: ReturnType<typeof createServerClient>,
  asset: AccountAsset
) {
  const { data: blob, error } = await db.storage
    .from(asset.storage_bucket)
    .download(asset.storage_path);
  if (error || !blob) return null;
  const bytes = Buffer.from(await blob.arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureSettingsTestDocumentArgs(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseType: NonNullable<Awaited<ReturnType<typeof getOperationalCaseTypeById>>>;
  def: ToolDefinition;
  toolId: string;
  args: Record<string, unknown>;
  caseId?: string | null;
  preview: boolean;
  mode: ToolRunMode;
}) {
  if (!DOCUMENT_READINESS_TOOLS.has(params.toolId)) return params.args;
  if (params.mode === "manual") return params.args;
  const caseId = cleanText(params.args.case_id) || cleanText(params.caseId);
  if (!caseId) return params.args;
  const assets = await loadAllDocumentTestAssets({
    db: params.db,
    userId: params.userId,
    caseType: params.caseType,
    def: params.def,
    toolId: params.toolId,
  });
  if (assets.length === 0) {
    const existingDocument = await findPreferredSettingsTestDocument(params.db, {
      caseId,
    });
    if (!existingDocument) throw new MissingTestDocumentAssetError();
    if (params.toolId === "operational_case_extract_document_fields") {
      return cleanText(params.args.document_id)
        ? params.args
        : { ...params.args, document_id: existingDocument.id };
    }
    return { ...params.args, case_id: caseId };
  }

  if (params.toolId === "operational_case_register_document") {
    const asset = assets[0];
    const kind = cleanText(params.args.kind) || documentKindFromAsset(asset);
    return {
      case_id: caseId,
      kind,
      display_name:
        cleanText(params.args.display_name) || documentKindLabel(kind),
      storage_bucket: asset.storage_bucket,
      storage_path: asset.storage_path,
      original_name: originalNameForAsset(asset),
      content_type: asset.content_type ?? undefined,
      file_size_bytes: asset.file_size_bytes ?? undefined,
      source: "settings_test",
      blocking:
        typeof params.args.blocking === "boolean"
          ? params.args.blocking
          : isBlockingDocumentKind(kind),
      metadata: {
        source: "tool_readiness_test",
        asset_key: asset.asset_key,
        case_type_id: params.caseType.id,
      },
      ...params.args,
    };
  }

  if (params.preview) {
    const existingPreview = await findPreferredSettingsTestDocument(params.db, {
      caseId,
    });
    return params.toolId === "operational_case_extract_document_fields" &&
      existingPreview &&
      !cleanText(params.args.document_id)
      ? { ...params.args, document_id: existingPreview.id }
      : { ...params.args, case_id: caseId };
  }

  const documents = await syncSettingsTestDocumentsFromAssets(params.db, {
    caseId,
    userId: params.userId,
    caseTypeId: params.caseType.id,
    assets,
  });
  const preferredDocument = pickPreferredSettingsTestDocument(documents);

  if (params.toolId === "operational_case_extract_document_fields") {
    return cleanText(params.args.document_id)
      ? params.args
      : {
          ...params.args,
          document_id: preferredDocument?.id,
        };
  }
  return { ...params.args, case_id: caseId };
}

async function syncSettingsTestDocumentsFromAssets(
  db: ReturnType<typeof createServerClient>,
  input: {
    caseId: string;
    userId: string;
    caseTypeId: string;
    assets: AccountAsset[];
  }
) {
  const documents: Awaited<ReturnType<typeof listOperationalCaseDocuments>> = [];
  for (const asset of input.assets) {
    const kind = documentKindFromAsset(asset);
    const metadata = {
      source: "tool_readiness_test",
      asset_key: asset.asset_key,
      case_type_id: input.caseTypeId,
    };
    const existing = await findSettingsTestDocumentForAsset(db, {
      caseId: input.caseId,
      asset,
    });
    if (existing) {
      documents.push(existing);
      continue;
    }
    const created = await createOperationalCaseDocument(db, {
      caseId: input.caseId,
      userId: input.userId,
      kind,
      displayName: documentKindLabel(kind),
      storageBucket: asset.storage_bucket,
      storagePath: asset.storage_path,
      originalName: originalNameForAsset(asset),
      contentType: asset.content_type ?? null,
      fileSizeBytes: asset.file_size_bytes ?? null,
      sha256: await sha256ForAsset(db, asset),
      source: "settings_test",
      sourceMetadata: metadata,
      blocking: isBlockingDocumentKind(kind),
    });
    documents.push(created);
  }
  return documents;
}

function pickPreferredSettingsTestDocument(
  documents: Awaited<ReturnType<typeof listOperationalCaseDocuments>>
) {
  return (
    documents.find(
      (document) =>
        document.kind === TEST_PROPERTY_DOCUMENT_KIND &&
        document.source === "settings_test"
    ) ??
    documents.find((document) => document.source === "settings_test") ??
    null
  );
}

async function findPreferredSettingsTestDocument(
  db: ReturnType<typeof createServerClient>,
  input: { caseId: string }
) {
  const documents = await listOperationalCaseDocuments(db, {
    caseId: input.caseId,
    statuses: ["received"],
  });
  return pickPreferredSettingsTestDocument(documents);
}

async function findSettingsTestDocumentForAsset(
  db: ReturnType<typeof createServerClient>,
  input: { caseId: string; asset: AccountAsset }
) {
  const documents = await listOperationalCaseDocuments(db, {
    caseId: input.caseId,
    statuses: ["received"],
  });
  return (
    documents.find((document) => {
      const metadata = document.source_metadata_jsonb ?? {};
      return (
        document.source === "settings_test" &&
        document.storage_bucket === input.asset.storage_bucket &&
        document.storage_path === input.asset.storage_path &&
        metadata.asset_key === input.asset.asset_key
      );
    }) ?? null
  );
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
  rootSkill: string,
  flowTools: readonly string[] = []
) {
  if (
    rootSkill === "property-optioning-coach" &&
    toolId === "bigquery_run_query" &&
    allowedTools.includes("bigquery_lookup_local_comparables")
  ) {
    return false;
  }
  return allowedTools.includes(toolId) || flowTools.includes(toolId);
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
    const readinessSkillSlug =
      cleanText(body.readiness_skill_slug) || caseType.default_skill_slug;
    const readinessActiveSkill = await resolveReadinessActiveSkill(
      registry,
      readinessSkillSlug
    );
    const flow = await effectiveFlowForCaseType(db, caseType);
    const flowToolIds = flattenFlow(flow).map((tool) => tool.tool_id);
    if (
      !toolAllowedForCaseType(
        toolId,
        allowed,
        caseType.default_skill_slug,
        flowToolIds
      )
    ) {
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
      readinessSkillSlug: readinessSkillSlug || undefined,
      readinessFlowStepKey: cleanText(body.readiness_flow_step_key) || undefined,
    });
    let resolvedArgs = await hydrateEasyBrokerUploadListingId({
      db,
      userId: user.id,
      toolId,
      args: resolution.args,
    });
    try {
      resolvedArgs = await ensureSettingsTestDocumentArgs({
        db,
        userId: user.id,
        caseType,
        def,
        toolId,
        args: resolvedArgs,
        caseId: resolution.case_id ?? null,
        preview,
        mode: requestedMode,
      });
    } catch (err) {
      if (err instanceof MissingTestDocumentAssetError) {
        return NextResponse.json(
          {
            ok: false,
            executed: false,
            tool_id: toolId,
            dry_run: true,
            reason: "missing_test_document_asset",
            risk: def.risk,
            requested_mode: requestedMode,
            mode_used: resolution.mode_used,
            mode_source: resolution.source,
            case_id: resolution.case_id ?? null,
            resolved_args: resolvedArgs,
            error: "missing_test_document_asset",
            hint:
              "Sube primero el activo de prueba test_property_document. Sin ese documento, una lista vacia no valida el flujo documental.",
          },
          { status: 400 }
        );
      }
      throw err;
    }

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
    toolId === "telegram_send_message_to_contact" &&
    (typeof resolvedArgs.chat_id !== "number" ||
      !Number.isFinite(resolvedArgs.chat_id) ||
      typeof resolvedArgs.text !== "string" ||
      !resolvedArgs.text.trim())
  ) {
    return NextResponse.json(
      {
        error: "controlled_real_write_missing_telegram_args",
        hint:
          "Para enviar una prueba real por Telegram necesitas chat_id numérico y text. Usa Datos del caso o args avanzados.",
        resolved_args: resolvedArgs,
      },
      { status: 400 }
    );
  }
    if (
      controlledRealWriteRequested &&
      toolId === "calendar_create_event" &&
      (!cleanText(resolvedArgs.summary) ||
        !cleanText(resolvedArgs.start_datetime) ||
        !cleanText(resolvedArgs.end_datetime))
    ) {
      return NextResponse.json(
        {
          error: "controlled_real_write_missing_calendar_args",
          hint:
            "Para crear un evento de prueba necesitas summary, start_datetime y end_datetime (la receta Caso de prueba ya los arma).",
          resolved_args: resolvedArgs,
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
            : toolId === "telegram_send_message_to_contact"
              ? "Esta tool enviaría un mensaje real a un contacto externo. En prueba individual sólo se validan los args; usa «Prueba real controlada por Telegram» con un chat de prueba, o ejecuta «Probar habilidad» / tick E2E para pasar por HITL del flow."
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
      googleCalendarAccessToken,
    ] = await Promise.all([
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id),
      supabase
        .from("profiles")
        .select("business_brain, is_ungga_admin, timezone")
        .eq("id", user.id)
        .single(),
      getGoogleCalendarAccessToken(db, user.id),
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
      ...readinessActiveSkill,
      tenantOrganizationId,
      bigQueryProjectId: warehouse?.project_id?.trim() || undefined,
      bigQueryLocation: warehouse?.location?.trim() || undefined,
      userTimezone:
        typeof profile?.timezone === "string" && profile.timezone.trim()
          ? profile.timezone.trim()
          : undefined,
      googleCalendarAccessToken: googleCalendarAccessToken ?? undefined,
    };

    const tools = buildLangChainTools(ctx);
    const lcTool = tools.find((item) => item.name === toolId) as
      | { invoke: (args: unknown) => Promise<unknown> }
      | undefined;
    if (!lcTool) {
      const calendarTool = def.requires_integration === "google_calendar";
      const calendarIntegrationActive = (integrations ?? []).some(
        (row) =>
          (row as { provider?: string; status?: string }).provider ===
            "google_calendar" &&
          (row as { status?: string }).status === "active"
      );
      const calendarToolEnabled = (toolSettings ?? []).some(
        (row) =>
          (row as { tool_id?: string; enabled?: boolean }).tool_id === toolId &&
          (row as { enabled?: boolean }).enabled === true
      );
      let hint =
        "La tool existe en el catálogo pero no está disponible para esta cuenta. Revisa que la tool esté activada en Ajustes → Herramientas.";
      if (calendarTool && !calendarToolEnabled) {
        hint = `Activa «${toolId}» en Ajustes → Herramientas antes de probarla aquí.`;
      } else if (calendarTool && !calendarIntegrationActive) {
        hint =
          "Conecta Google Calendar en Ajustes → Integraciones antes de probar herramientas calendar_*.";
      } else if (calendarTool && !googleCalendarAccessToken) {
        hint =
          "Google Calendar aparece conectado pero no hay token usable (expirado o ENCRYPTION_KEY). Reconecta la integración en Ajustes.";
      }
      return NextResponse.json(
        {
          error: "tool_not_built_for_user",
          tool_id: toolId,
          hint,
        },
        { status: 400 }
      );
    }

    const calendarUpdateEventId = isRecord(resolvedArgsForExecution)
      ? (resolvedArgsForExecution as Record<string, unknown>)["event_id"]
      : undefined;
    if (
      toolId === "calendar_update_event" &&
      policy.execute &&
      isPlaceholderCalendarEventId(calendarUpdateEventId)
    ) {
      return NextResponse.json({
        ok: false,
        executed: false,
        tool_id: toolId,
        risk: def.risk,
        dry_run: false,
        reason: "placeholder_event_id",
        requested_mode: requestedMode,
        mode_used: resolution.mode_used,
        mode_source: resolution.source,
        case_id: resolution.case_id ?? null,
        resolved_args: resolvedArgsForExecution,
        hint:
          "Falta un event_id real. En la misma preparación operativa abre «Crear evento de calendario», usa la sección «Crear evento de prueba en Google Calendar» (escribe CREAR EVENTO PRUEBA) y vuelve aquí; el id se guardará en el caso automáticamente. También puedes pegar un event_id manual en Avanzado.",
      });
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
    const extractionEval =
      toolId === "operational_case_extract_document_fields"
        ? evaluateDocumentExtractionTest(parsed)
        : null;
    const genericEval =
      extractionEval == null ? evaluateGenericToolReadinessResult(parsed, toolId) : null;
    const toolOk = extractionEval
      ? extractionEval.ok
      : genericEval
        ? genericEval.ok
        : summary.ok ?? (invokeError === null ? true : false);

    const ok = invokeError === null && toolOk !== false;
    const resultHint = extractionEval?.hint ?? genericEval?.hint;

    if (READINESS_RECORDS_TOOL_CALL.has(toolId)) {
      try {
        const readinessFlowStepKey =
          cleanText(body.readiness_flow_step_key) || undefined;
        const readinessSkillSlug =
          cleanText(body.readiness_skill_slug) || undefined;
        const record = await createToolCall(
          db,
          session.id,
          toolId,
          resolvedArgsForExecution,
          false,
          null,
          {
            metadata: {
              ...(resolution.case_id ? { case_id: resolution.case_id } : {}),
              ...(readinessFlowStepKey
                ? { operational_step_key: readinessFlowStepKey }
                : {}),
              ...(readinessSkillSlug ? { skill_slug: readinessSkillSlug } : {}),
              source: readinessFlowStepKey
                ? "step_test"
                : readinessSkillSlug
                  ? "skill_test"
                  : undefined,
              channel: "case_runner",
            },
          }
        );
        const resultPayload: Record<string, unknown> = invokeError
          ? { error: invokeError }
          : isRecord(parsed)
            ? (parsed as Record<string, unknown>)
            : { raw: parsed ?? text };
        await updateToolCallStatus(
          db,
          record.id,
          ok ? "executed" : "failed",
          resultPayload
        );
      } catch (auditErr) {
        console.warn("[run-tool] readiness tool_call audit failed:", auditErr);
      }
    }

    if (
      controlledRealWriteRequested &&
      toolId === "telegram_send_message_to_contact" &&
      ok &&
      resolution.case_id
    ) {
      const linkedCase = await getOperationalCase(db, resolution.case_id);
      if (
        linkedCase?.context_jsonb?.created_from === "case_type_settings_test" ||
        linkedCase?.context_jsonb?.test_mode === true
      ) {
        await expireExternalContactNotificationsForCase(db, linkedCase.id);
      }
    }
    let persistedCalendarEventId: string | null = null;
    if (
      controlledRealWriteRequested &&
      toolId === "calendar_create_event" &&
      ok &&
      resolution.case_id
    ) {
      const createdId = calendarEventIdFromToolResult(parsed);
      if (createdId) {
        await persistPhotoSessionCalendarEventIdForTestCase(
          db,
          resolution.case_id,
          createdId
        );
        persistedCalendarEventId = createdId;
      }
    }
    return NextResponse.json({
      ok,
      executed: true,
      tool_id: toolId,
      risk: def.risk,
      dry_run: forceCliDryRun,
      reason: controlledRealWriteRequested
        ? "high_risk_controlled_real_write"
        : policy.reason,
      hint: !ok && resultHint
        ? resultHint
        : extractionEval?.hint
        ? extractionEval.hint
        : forceCliDryRun
        ? toolId === "ungga_publish_listing"
          ? "Dry-run completado: Playwright abrió Ungga y recorrió el wizard sin guardar borrador ni publicar. Revisa status, stages y validation_errors en el JSON."
          : "Dry-run completado: se validó el payload sin enviar escritura real a EasyBroker."
        : controlledRealWriteRequested && !ok
          ? toolId === "telegram_send_message_to_contact"
            ? "Telegram no confirmó el envío. Revisa el error de la respuesta; puedes continuar con «B · Simular respuesta y procesar» para validar la actualización del caso sin enviar otro mensaje."
            : "La prueba real controlada falló. Revisa el error de la respuesta antes de continuar."
        : controlledRealWriteRequested && ok && toolId === "calendar_create_event"
          ? persistedCalendarEventId
            ? `Evento creado en Google Calendar (id ${persistedCalendarEventId}). Quedó en photo_session.calendar_event_id del caso de prueba; abre «Actualizar evento» y vuelve a probar (recarga el panel si la vista previa sigue con el marcador). Borra el evento en Calendar cuando termines.`
            : "La tool respondió OK pero no devolvió id; revisa el JSON. Si hay id, pégalo en Avanzado de Actualizar evento."
          : controlledRealWriteRequested
          ? toolId === "telegram_send_message_to_contact"
            ? "Prueba real controlada ejecutada: se intentó enviar el mensaje al chat_id externo indicado por Telegram."
            : toolId === "easybroker_upload_images"
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
