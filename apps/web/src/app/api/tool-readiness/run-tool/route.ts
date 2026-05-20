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
 *                          resueltos para que el usuario revise antes.
 *   - high               → nunca ejecuta desde esta capa; devuelve
 *                          `dry_run: true`. Las tools de escritura siguen
 *                          requiriendo HITL real desde el flow.
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
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCaseTypeById,
  getOrCreateSession,
} from "@agents/db";
import {
  buildLangChainTools,
  getSkillRegistryForUser,
  TOOL_CATALOG,
  type ToolContext,
} from "@agents/agent";
import type {
  OperationalCase,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  ToolDefinition,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";

type ToolRunMode = "smoke" | "case" | "manual";

type ToolRunBody = {
  case_type_id?: string;
  tool_id?: string;
  mode?: ToolRunMode;
  args?: Record<string, unknown>;
  confirm?: boolean;
  preview?: boolean;
};

const TEST_DEFAULTS: Record<string, Record<string, unknown>> = {
  easybroker_search_listings: { limit: 5 },
  easybroker_search_closed_deals: { limit: 5 },
  ungga_publish_listing: {
    title: "POC test - DELETE ME",
    operation: "sale",
    property_type: "Departamento",
    price: 1000000,
    currency: "MXN",
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
  ungga_publish_listing: unggaPublishCaseRecipe,
};

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickRiskPolicy(def: ToolDefinition | undefined, confirm: boolean) {
  const risk = def?.risk ?? "medium";
  if (risk === "low") return { execute: true, reason: "low_risk_auto_execute" };
  if (risk === "medium") {
    return confirm
      ? { execute: true, reason: "medium_risk_confirmed" }
      : { execute: false, reason: "medium_risk_requires_confirm" };
  }
  return { execute: false, reason: "high_risk_requires_hitl" };
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

function easyBrokerCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { limit: 10 };
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
  const targetPrice = firstNumber(ctx, [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]);
  if (targetPrice != null) {
    args.min_price = Math.round(targetPrice * 0.8);
    args.max_price = Math.round(targetPrice * 1.2);
  }
  const areaM2 = firstNumber(ctx, [
    "area_m2",
    "construction_size",
    "lot_size",
    "superficie",
    "m2",
  ]);
  if (areaM2 != null) {
    args.min_area_m2 = Math.round(areaM2 * 0.8);
    args.max_area_m2 = Math.round(areaM2 * 1.2);
  }
  return args;
}

function unggaPublishCaseRecipe(ctx: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
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
  return args;
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
  toolId: string;
  def: ToolDefinition;
  mode: ToolRunMode;
  userArgs: Record<string, unknown>;
}): Promise<ArgResolution> {
  const { db, userId, caseType, toolId, def, mode, userArgs } = params;

  if (mode === "manual") {
    return {
      args: { ...userArgs },
      mode_used: "manual",
      source: "manual_user_args",
    };
  }

  if (mode === "case") {
    const testCase = await loadLatestTestCase(db, userId, caseType.id);
    if (!testCase) {
      return {
        args: { ...(TEST_DEFAULTS[toolId] ?? {}), ...userArgs },
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
    return {
      args: merged,
      mode_used: "case",
      source,
      case_id: testCase.id,
      case_context_sample: ctx,
    };
  }

  return {
    args: { ...(TEST_DEFAULTS[toolId] ?? {}), ...userArgs },
    mode_used: "smoke",
    source: "smoke_defaults",
  };
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
    if (!allowed.includes(toolId)) {
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
      toolId,
      def,
      mode: requestedMode,
      userArgs,
    });

    const policy = pickRiskPolicy(def, confirm);

    if (preview) {
      return NextResponse.json({
        ok: true,
        tool_id: toolId,
        dry_run: true,
        reason: "preview_only",
        risk: def.risk,
        requested_mode: requestedMode,
        mode_used: resolution.mode_used,
        mode_source: resolution.source,
        case_id: resolution.case_id ?? null,
        case_context_sample: resolution.case_context_sample ?? null,
        resolved_args: resolution.args,
      });
    }

    if (!policy.execute) {
      return NextResponse.json({
        ok: true,
        tool_id: toolId,
        dry_run: true,
        reason: policy.reason,
        risk: def.risk,
        requested_mode: requestedMode,
        mode_used: resolution.mode_used,
        mode_source: resolution.source,
        case_id: resolution.case_id ?? null,
        resolved_args: resolution.args,
        hint:
          policy.reason === "medium_risk_requires_confirm"
            ? "Esta tool es de riesgo medio; envía confirm:true para ejecutarla desde la prueba individual."
            : "Esta tool es de riesgo alto. Por seguridad sólo se ejecuta dentro del flow con HITL.",
      });
    }

    ensureAgentToolDepsWired();
    const [{ data: toolSettings }, { data: integrations }] = await Promise.all([
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id),
    ]);
    const session = await getOrCreateSession(db, user.id, "web");

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
      raw = await lcTool.invoke(resolution.args);
    } catch (err) {
      invokeError = err instanceof Error ? err.message : String(err);
    }
    const elapsedMs = Date.now() - startedAt;
    const { parsed, text } = parseToolOutput(raw);
    const summary = summarizeResult(parsed);

    return NextResponse.json({
      ok: invokeError === null,
      tool_id: toolId,
      risk: def.risk,
      dry_run: false,
      reason: policy.reason,
      requested_mode: requestedMode,
      mode_used: resolution.mode_used,
      mode_source: resolution.source,
      case_id: resolution.case_id ?? null,
      resolved_args: resolution.args,
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
