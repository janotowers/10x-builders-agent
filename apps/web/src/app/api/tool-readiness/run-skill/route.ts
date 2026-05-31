import { NextResponse } from "next/server";
import { runAgent, TOOL_CATALOG } from "@agents/agent";
import {
  createServerClient,
  decryptToken,
  getGlobalOperationalCaseTypeBySlug,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOrCreateSession,
  getProfile,
  getRecentOperationalCaseEvents,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  insertOperationalCaseEvent,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseExternalContact,
  OperationalCaseFlowSkill,
  OperationalCaseFlowStep,
  OperationalCaseStatus,
  ToolCall,
  ToolApprovalPolicy,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import {
  validateComparablesCaseOutcome,
} from "@/lib/operational-cases/comparables-analysis-validation";
import { validatePackageReadyPreflightOutcome } from "@/lib/operational-cases/package-ready-preflight-validation";
import { validatePhotosScheduledProposeSlotsOutcome } from "@/lib/operational-cases/photos-scheduled-propose-slots-validation";
import { settingsTestPropertyDataSeed } from "@/lib/operational-cases/property-search-zone";
import { settingsTestApprovedPricingProposalSeed } from "@/lib/operational-cases/step-test-seeds";
import { isolateContextForSkillTest } from "@/lib/operational-cases/settings-test-run-isolation";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";
import { readinessToolIdsForSkill } from "@/lib/operational-cases/tool-surface-classification";
import {
  missingTestedTools,
  testedToolsForUser,
} from "@/lib/operational-cases/tested-tools-for-user";

export const maxDuration = 180;

type SkillRunBody = {
  case_type_id?: string;
  case_id?: string;
  skill_slug?: string;
};

type SkillTestContract = {
  expected_context_keys: string[];
  expected_events?: string[];
  expected_tool_calls?: string[];
  expected_internal_tool_calls?: string[];
  optional_tool_calls?: string[];
  tool_coverage_policy?: "all_step_tools" | "expected_only" | "any_step_tool" | "none";
  required_tools_policy: "all_ready_and_tested" | "none";
  allow_partial_sources?: boolean;
};

const SKILL_TEST_CONTRACTS: Record<string, SkillTestContract> = {
  "request-property-documents": {
    expected_context_keys: [],
    expected_events: ["reminder_sent"],
    expected_tool_calls: [
      "operational_case_list_documents",
      "telegram_send_message_to_contact",
    ],
    expected_internal_tool_calls: [
      "operational_case_add_event",
      "operational_case_update_state",
    ],
    optional_tool_calls: ["notify_user"],
    tool_coverage_policy: "expected_only",
    required_tools_policy: "all_ready_and_tested",
  },
  "extract-property-characteristics": {
    expected_context_keys: ["property_data"],
    expected_events: ["step_completed"],
    expected_tool_calls: ["operational_case_list_documents", "notify_user"],
    expected_internal_tool_calls: [
      "operational_case_add_event",
      "operational_case_update_state",
    ],
    optional_tool_calls: [
      "operational_case_extract_document_fields",
      "telegram_send_message_to_contact",
    ],
    tool_coverage_policy: "expected_only",
    required_tools_policy: "all_ready_and_tested",
  },
  "perform-comparable-analysis": {
    expected_context_keys: ["comparables_analysis"],
    tool_coverage_policy: "any_step_tool",
    required_tools_policy: "all_ready_and_tested",
    allow_partial_sources: true,
  },
  "prepare-listing-price": {
    expected_context_keys: ["pricing_proposal"],
    expected_events: ["human_decision:price_proposed"],
    expected_tool_calls: ["notify_user"],
    tool_coverage_policy: "expected_only",
    required_tools_policy: "none",
  },
  "publish-listing-package": {
    expected_context_keys: [],
    expected_tool_calls: ["notify_user"],
    expected_internal_tool_calls: ["operational_case_update_state"],
    optional_tool_calls: [
      "image_watermark",
      "easybroker_create_listing",
      "easybroker_upload_images",
      "ungga_publish_listing",
      "generate_document_from_template",
    ],
    tool_coverage_policy: "expected_only",
    required_tools_policy: "all_ready_and_tested",
  },
  "coordinate-photo-session": {
    expected_context_keys: [],
    expected_events: ["reminder_sent"],
    expected_tool_calls: [
      "calendar_list_events",
      "telegram_send_message_to_contact",
    ],
    expected_internal_tool_calls: ["operational_case_update_state"],
    optional_tool_calls: [
      "calendar_create_event",
      "calendar_update_event",
      "notify_user",
      "operational_case_add_event",
    ],
    tool_coverage_policy: "expected_only",
    required_tools_policy: "all_ready_and_tested",
  },
};

/** Persistencia del caso; no son tools de negocio del paso (p. ej. Telegram). */
const SKILL_TEST_CASE_WRITE_TOOLS = new Set<string>([
  "operational_case_update_state",
  "operational_case_add_event",
]);

function classifySkillTestToolCalls(params: {
  toolCalls: ToolCall[];
  sourceToolIds: Set<string>;
  expectedInternalToolCalls: string[];
}) {
  const internalIds = new Set([
    ...SKILL_TEST_CASE_WRITE_TOOLS,
    ...params.expectedInternalToolCalls,
  ]);
  const sourceToolCalls = params.toolCalls.filter((call) =>
    params.sourceToolIds.has(call.tool_name)
  );
  const internalToolCalls = params.toolCalls.filter(
    (call) =>
      internalIds.has(call.tool_name) && !params.sourceToolIds.has(call.tool_name)
  );
  const otherToolCalls = params.toolCalls.filter(
    (call) =>
      !params.sourceToolIds.has(call.tool_name) && !internalIds.has(call.tool_name)
  );
  return { sourceToolCalls, internalToolCalls, otherToolCalls };
}

const RESPONSE_PREVIEW_MAX_CHARS = 6000;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSettingsTestCase(opCase: OperationalCase) {
  const context = opCase.context_jsonb;
  if (!isRecord(context)) return false;
  return (
    context.created_from === "case_type_settings_test" &&
    (context.test_mode === true || context.test_mode === "true")
  );
}

function responsePreview(response: string | undefined | null) {
  if (!response) return { text: null, truncated: false };
  if (response.length <= RESPONSE_PREVIEW_MAX_CHARS) {
    return { text: response, truncated: false };
  }
  const candidate = response.slice(0, RESPONSE_PREVIEW_MAX_CHARS);
  const lastLineBreak = candidate.lastIndexOf("\n");
  const safeText =
    lastLineBreak > RESPONSE_PREVIEW_MAX_CHARS * 0.8
      ? candidate.slice(0, lastLineBreak).trimEnd()
      : candidate.trimEnd();
  return {
    text: `${safeText}\n\n[Preview truncado. Ver resultado completo en el artefacto guardado.]`,
    truncated: true,
  };
}

async function effectiveFlowForCaseType(
  db: ReturnType<typeof createServerClient>,
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>
) {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? (caseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? (globalCaseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
}

async function latestSettingsTestCase(
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
  if (error) throw error;
  return (data as OperationalCase | null) ?? null;
}

function skillInFlow(flow: OperationalCaseFlowStep[], skillSlug: string) {
  for (const step of flow) {
    const found = (step.step_skills ?? []).find(
      (skill) => skill.skill_slug === skillSlug
    );
    if (found) return { step, skill: found as OperationalCaseFlowSkill };
  }
  return null;
}

function normalizeSkillTestContract(value: unknown): SkillTestContract | null {
  if (!isRecord(value)) return null;
  const expected = Array.isArray(value.expected_context_keys)
    ? value.expected_context_keys.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : [];
  const events = Array.isArray(value.expected_events)
    ? value.expected_events.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const toolCalls = Array.isArray(value.expected_tool_calls)
    ? value.expected_tool_calls.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const internalToolCalls = Array.isArray(value.expected_internal_tool_calls)
    ? value.expected_internal_tool_calls.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const optionalToolCalls = Array.isArray(value.optional_tool_calls)
    ? value.optional_tool_calls.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const coveragePolicy =
    value.tool_coverage_policy === "expected_only" ||
    value.tool_coverage_policy === "any_step_tool" ||
    value.tool_coverage_policy === "none"
      ? value.tool_coverage_policy
      : "all_step_tools";
  const policy =
    value.required_tools_policy === "none" ? "none" : "all_ready_and_tested";
  return {
    expected_context_keys: expected,
    expected_events: events,
    expected_tool_calls: toolCalls,
    expected_internal_tool_calls: internalToolCalls,
    optional_tool_calls: optionalToolCalls,
    tool_coverage_policy: coveragePolicy,
    required_tools_policy: policy,
    allow_partial_sources: value.allow_partial_sources === true,
  };
}

async function listToolCallsForTurn(
  db: ReturnType<typeof createServerClient>,
  turnId: string
): Promise<ToolCall[]> {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .eq("turn_id", turnId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[run-skill] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as ToolCall[];
}

function contextHasKey(context: Record<string, unknown>, dottedKey: string) {
  let current: unknown = context;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return current != null;
}

function contextValue(context: Record<string, unknown>, dottedKey: string) {
  let current: unknown = context;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validatePricingProposal(value: unknown) {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["pricing_proposal debe ser un objeto."];
  }
  const salida = value.salida;
  const ideal = value.ideal;
  const minimo = value.minimo;
  if (!positiveNumber(salida)) errors.push("pricing_proposal.salida debe ser mayor a 0.");
  if (!positiveNumber(ideal)) errors.push("pricing_proposal.ideal debe ser mayor a 0.");
  if (!positiveNumber(minimo)) errors.push("pricing_proposal.minimo debe ser mayor a 0.");
  const salidaNumber = positiveNumber(salida) ? salida : null;
  const idealNumber = positiveNumber(ideal) ? ideal : null;
  const minimoNumber = positiveNumber(minimo) ? minimo : null;
  if (salidaNumber != null && idealNumber != null && salidaNumber < idealNumber) {
    errors.push("pricing_proposal.salida debe ser mayor o igual a ideal.");
  }
  if (idealNumber != null && minimoNumber != null && idealNumber < minimoNumber) {
    errors.push("pricing_proposal.ideal debe ser mayor o igual a minimo.");
  }
  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
    errors.push("pricing_proposal.rationale no debe estar vacio.");
  }
  if (!Array.isArray(value.comparables_used) || value.comparables_used.length === 0) {
    errors.push("pricing_proposal.comparables_used debe incluir al menos un comparable.");
  }
  return errors;
}

function validatePropertyData(value: unknown) {
  if (!isRecord(value)) return ["property_data debe ser un objeto."];
  const errors: string[] = [];
  for (const field of ["bedrooms", "bathrooms", "parking_spots"] as const) {
    if (!positiveNumber(value[field])) {
      errors.push(
        `property_data.${field} debe ser mayor a 0 para el escenario de revisión interna (notify_user).`
      );
    }
  }
  return errors;
}

function validateComparablesAnalysisArtifact(value: unknown) {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["comparables_analysis debe ser un objeto."];
  }
  if (!isRecord(value.filters_used)) {
    errors.push("comparables_analysis.filters_used es obligatorio.");
  }
  if (!isRecord(value.stats)) {
    errors.push("comparables_analysis.stats es obligatorio.");
  }
  return errors;
}

function validateArtifactValue(key: string, value: unknown) {
  if (key === "pricing_proposal") return validatePricingProposal(value);
  if (key === "property_data") return validatePropertyData(value);
  if (key === "comparables_analysis") return validateComparablesAnalysisArtifact(value);
  return [];
}

function mergeSkillTestContext(
  base: Record<string, unknown>,
  patch?: Record<string, unknown>
) {
  if (!patch) return base;
  const next = { ...base, ...patch };
  if (isRecord(patch.property_data)) {
    const basePd = isRecord(base.property_data)
      ? (base.property_data as Record<string, unknown>)
      : {};
    const patchPd = patch.property_data as Record<string, unknown>;
    const mergedPd: Record<string, unknown> = { ...basePd, ...patchPd };
    if (isRecord(basePd.address) || isRecord(patchPd.address)) {
      mergedPd.address = {
        ...(isRecord(basePd.address) ? basePd.address : {}),
        ...(isRecord(patchPd.address) ? patchPd.address : {}),
      };
    }
    next.property_data = mergedPd;
  }
  return next;
}

async function applyExtractCharacteristicsSkillTestSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCase> {
  const rawContext = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const context = isolateContextForSkillTest(
    rawContext,
    "extract-property-characteristics"
  );
  const existing = isRecord(context.property_data)
    ? (context.property_data as Record<string, unknown>)
    : {};
  const existingAddress = isRecord(existing.address)
    ? (existing.address as Record<string, unknown>)
    : {};
  const propertyData: Record<string, unknown> = {
    ...existing,
    operation: existing.operation ?? "rent",
    property_type: existing.property_type ?? "departamento",
    area_total_m2: positiveNumber(existing.area_total_m2)
      ? existing.area_total_m2
      : 116.93,
    address: {
      street: "Privada del Tulipán",
      exterior_number: "1501",
      neighborhood: "Sendas Residencial G1",
      city: "Zapopan",
      state: "Jalisco",
      country: "MX",
      postal_code: "45050",
      ...existingAddress,
    },
    bedrooms: positiveNumber(existing.bedrooms) ? existing.bedrooms : 3,
    bathrooms: positiveNumber(existing.bathrooms) ? existing.bathrooms : 2,
    parking_spots: positiveNumber(existing.parking_spots)
      ? existing.parking_spots
      : 1,
    current_state: existing.current_state ?? "habitable",
  };
  delete propertyData.missing_critical_fields;

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: "documents_received",
    status: "active" as OperationalCaseStatus,
    context: mergeSkillTestContext(context, {
      property_data: propertyData,
      skill_test_n3_seed: "extract_characteristics_internal_review",
    }),
  });
  return updated ?? opCase;
}

function telegramChatIdFromCase(opCase: OperationalCase, context: Record<string, unknown>) {
  const external = isRecord(opCase.external_contact_jsonb)
    ? (opCase.external_contact_jsonb as Record<string, unknown>)
    : {};
  const fromExternal = external.chat_id;
  if (typeof fromExternal === "number" && Number.isFinite(fromExternal)) {
    return fromExternal;
  }
  const fromContext = context.telegram_chat_id ?? context.external_chat_id;
  if (typeof fromContext === "number" && Number.isFinite(fromContext)) {
    return fromContext;
  }
  if (typeof fromContext === "string" && fromContext.trim()) {
    const parsed = Number(fromContext);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function applyPhotosScheduledSkillTestSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCase> {
  const rawContext = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const context = isolateContextForSkillTest(
    rawContext,
    "coordinate-photo-session"
  );
  const propertyData = settingsTestPropertyDataSeed(context);
  const ownerName =
    cleanText(context.owner_name) ||
    cleanText(context.lead_name) ||
    cleanText(context.contact_name) ||
    "Contacto de prueba";
  const chatId = telegramChatIdFromCase(opCase, context);
  const existingExternalContact = isRecord(opCase.external_contact_jsonb)
    ? (opCase.external_contact_jsonb as Record<string, unknown>)
    : {};
  const existingChannel = existingExternalContact.channel;
  const externalContact: OperationalCaseExternalContact = {
    ...(existingChannel === "telegram" ||
    existingChannel === "whatsapp" ||
    existingChannel === "email"
      ? { channel: existingChannel }
      : {}),
    ...(typeof existingExternalContact.chat_id === "number"
      ? { chat_id: existingExternalContact.chat_id }
      : {}),
    ...(typeof existingExternalContact.identifier === "string"
      ? { identifier: existingExternalContact.identifier }
      : {}),
    display_name: ownerName,
    ...(chatId != null
      ? { channel: "telegram", chat_id: chatId }
      : {}),
  };

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: "photos_scheduled",
    status: "active" as OperationalCaseStatus,
    externalContact,
    context: mergeSkillTestContext(context, {
      property_data: propertyData,
      skill_test_n3_seed: "photos_scheduled_propose_slots",
    }),
  });
  return updated ?? opCase;
}

async function applyPackageReadySkillTestSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCase> {
  const rawContext = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const context = isolateContextForSkillTest(
    rawContext,
    "publish-listing-package"
  );
  const propertyData = settingsTestPropertyDataSeed(context);

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: "package_ready",
    status: "active" as OperationalCaseStatus,
    context: mergeSkillTestContext(context, {
      property_data: propertyData,
      pricing_proposal: settingsTestApprovedPricingProposalSeed(),
      raw_photos: [],
      skill_test_n3_seed: "package_ready_preflight_blocked",
    }),
  });
  return updated ?? opCase;
}

async function applyComparablesSkillTestSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCase> {
  const rawContext = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const context = isolateContextForSkillTest(
    rawContext,
    "perform-comparable-analysis"
  );
  const propertyData = settingsTestPropertyDataSeed(context);
  const nextContext = mergeSkillTestContext(context, {
    property_data: propertyData,
    skill_test_n3_seed: "comparables_in_progress_aligned_zone",
  });

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: "comparables_in_progress",
    status: "active" as OperationalCaseStatus,
    context: nextContext,
  });
  return updated ?? opCase;
}

async function repairPropertyDataForExtractSkillTest(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<{ opCase: OperationalCase; repaired: boolean; reason?: string }> {
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const current = context.property_data;
  const errors = validatePropertyData(current);
  if (errors.length === 0) return { opCase, repaired: false };

  const existing = isRecord(current) ? { ...current } : {};
  const nextPd: Record<string, unknown> = { ...existing };
  const repairedFields: string[] = [];

  if (!positiveNumber(nextPd.bedrooms)) {
    nextPd.bedrooms = 3;
    repairedFields.push("bedrooms");
  }
  if (!positiveNumber(nextPd.bathrooms)) {
    nextPd.bathrooms = 2;
    repairedFields.push("bathrooms");
  }
  if (!positiveNumber(nextPd.parking_spots)) {
    nextPd.parking_spots = 1;
    repairedFields.push("parking_spots");
  }
  if (typeof nextPd.operation !== "string" || !nextPd.operation.trim()) {
    nextPd.operation = "rent";
    repairedFields.push("operation");
  }
  if (typeof nextPd.property_type !== "string" || !nextPd.property_type.trim()) {
    nextPd.property_type = "departamento";
    repairedFields.push("property_type");
  }
  if (!positiveNumber(nextPd.area_total_m2)) {
    nextPd.area_total_m2 = 116.93;
    repairedFields.push("area_total_m2");
  }

  const address = isRecord(nextPd.address) ? { ...nextPd.address } : {};
  if (
    !cleanText(address.exterior_number) &&
    cleanText(address.number)
  ) {
    address.exterior_number = cleanText(address.number);
    repairedFields.push("address.exterior_number");
  }
  if (!cleanText(address.city) && cleanText(address.municipality)) {
    address.city = cleanText(address.municipality);
    repairedFields.push("address.city");
  }
  if (!cleanText(address.country)) {
    address.country = "MX";
  }
  if (Object.keys(address).length > 0) {
    nextPd.address = address;
  }

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: mergeSkillTestContext(context, {
      property_data: nextPd,
      skill_test_repairs: {
        ...(isRecord(context.skill_test_repairs)
          ? context.skill_test_repairs
          : {}),
        "extract-property-characteristics": {
          repaired_at: new Date().toISOString(),
          fields: repairedFields,
          validation_errors: errors,
        },
      },
    }),
  });
  if (!updated) return { opCase, repaired: false };
  return {
    opCase: updated,
    repaired: true,
    reason: errors.join(" "),
  };
}

function roundPrice(value: number) {
  const step =
    value > 5_000_000
      ? 50_000
      : value >= 1_000_000
        ? 10_000
        : value >= 100_000
          ? 5_000
          : 500;
  return Math.ceil(value / step) * step;
}

function numberAtPath(root: unknown, path: string[]) {
  let current = root;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function stringAtPath(root: unknown, path: string[]) {
  let current = root;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function arrayIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
    .filter((item): item is string => item != null)
    .slice(0, 8);
}

function derivePricingProposalFromComparables(context: Record<string, unknown>) {
  const analysis = context.comparables_analysis;
  if (!isRecord(analysis)) return null;
  const priceP25 = numberAtPath(analysis, ["stats", "price", "p25"]);
  const priceP50 = numberAtPath(analysis, ["stats", "price", "p50"]);
  if (priceP25 == null || priceP50 == null || priceP25 <= 0 || priceP50 <= 0) {
    return null;
  }
  const ideal = roundPrice(priceP50);
  const minimo = roundPrice(priceP25);
  const salida = roundPrice(ideal * 1.05);
  const activeCount = numberAtPath(analysis, ["stats", "active_count"]) ?? 0;
  const historicalCount =
    numberAtPath(analysis, ["stats", "historical_reference_count"]) ?? 0;
  const internalCount =
    numberAtPath(analysis, ["stats", "internal_inventory_count"]) ?? 0;
  const notes = stringAtPath(analysis, ["notes"]);
  return {
    salida,
    ideal,
    minimo,
    currency: "MXN",
    rationale:
      notes ??
      `Propuesta basada en precio total publicado: p25=${priceP25}, p50=${priceP50}. Muestra: ${activeCount} activas, ${historicalCount} historicas y ${internalCount} internas.`,
    comparables_used: [
      ...arrayIds(analysis.active_listings),
      ...arrayIds(analysis.historical_references),
      ...arrayIds(analysis.closed_deals),
      ...arrayIds(analysis.internal_inventory),
    ].slice(0, 8),
    approval_status: "pending",
  };
}

async function repairPricingProposalForSkillTest(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<{ opCase: OperationalCase; repaired: boolean; reason?: string }> {
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const current = context.pricing_proposal;
  const currentErrors = validatePricingProposal(current);
  if (currentErrors.length === 0) return { opCase, repaired: false };
  const proposal = derivePricingProposalFromComparables(context);
  if (!proposal) return { opCase, repaired: false };
  const { updateOperationalCase } = await import("@agents/db");
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: {
      ...context,
      pricing_proposal: proposal,
      skill_test_repairs: {
        ...(isRecord(context.skill_test_repairs)
          ? context.skill_test_repairs
          : {}),
        "prepare-listing-price": {
          repaired_at: new Date().toISOString(),
          reason: currentErrors,
        },
      },
    },
  });
  if (!updated) return { opCase, repaired: false };
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "system",
    payload: {
      kind: "price_proposed",
      source: "tool_readiness_deterministic_repair",
      salida: proposal.salida,
      ideal: proposal.ideal,
      minimo: proposal.minimo,
    },
  });
  return {
    opCase: updated,
    repaired: true,
    reason: currentErrors.join(" "),
  };
}

function eventMatchesSpec(event: OperationalCaseEvent, spec: string) {
  const [eventType, expectedKind] = spec.split(":");
  if (event.event_type !== eventType) return false;
  if (!expectedKind) return true;
  const payload = event.payload_jsonb;
  return isRecord(payload) && payload.kind === expectedKind;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function callCoversTool(call: ToolCall, toolName: string) {
  return (
    call.tool_name === toolName &&
    (call.status === "executed" || call.status === "pending_confirmation")
  );
}

function expectedSourceToolCalls(
  contract: SkillTestContract,
  skillToolIds: string[]
) {
  const optional = new Set(contract.optional_tool_calls ?? []);
  if (contract.expected_tool_calls) {
    return uniqueStrings(contract.expected_tool_calls);
  }
  if (contract.tool_coverage_policy === "none") return [];
  if (contract.tool_coverage_policy === "expected_only") return [];
  if (contract.tool_coverage_policy === "any_step_tool") return [];
  return uniqueStrings(skillToolIds.filter((toolId) => !optional.has(toolId)));
}

function validateContract(
  contract: SkillTestContract,
  before: OperationalCase,
  after: OperationalCase,
  events: OperationalCaseEvent[],
  toolCalls: ToolCall[],
  skillToolIds: string[],
  skillSlug?: string
) {
  const context = (after.context_jsonb ?? {}) as Record<string, unknown>;
  const beforeContext = (before.context_jsonb ?? {}) as Record<string, unknown>;
  const expected_tool_calls = expectedSourceToolCalls(contract, skillToolIds);
  const missing_context_keys = contract.expected_context_keys.filter(
    (key) => !contextHasKey(context, key)
  );
  const created_context_keys = contract.expected_context_keys.filter(
    (key) => contextHasKey(context, key) && !contextHasKey(beforeContext, key)
  );
  const artifact_errors = contract.expected_context_keys.flatMap((key) =>
    validateArtifactValue(key, contextValue(context, key))
  );
  const missing_events = (contract.expected_events ?? []).filter(
    (spec) => !events.some((event) => eventMatchesSpec(event, spec))
  );
  const missing_tool_calls = expected_tool_calls.filter(
    (toolName) => !toolCalls.some((call) => callCoversTool(call, toolName))
  );
  const missing_internal_tool_calls = (
    contract.expected_internal_tool_calls ?? []
  ).filter(
    (toolName) => !toolCalls.some((call) => callCoversTool(call, toolName))
  );
  const missing_any_tool_call =
    contract.tool_coverage_policy === "any_step_tool" &&
    skillToolIds.length > 0 &&
    !skillToolIds.some((toolName) =>
      toolCalls.some((call) => callCoversTool(call, toolName))
    )
      ? [`al menos una de: ${skillToolIds.join(", ")}`]
      : [];
  let package_ready_outcome_errors: string[] = [];
  let photos_scheduled_outcome_errors: string[] = [];
  let comparables_outcome_errors: string[] = [];
  let comparables_usable_count: number | null = null;
  let comparables_defensible: boolean | null = null;
  if (skillSlug === "publish-listing-package") {
    const outcome = validatePackageReadyPreflightOutcome({
      current_step: after.current_step ?? "",
      status: after.status ?? "",
      context,
      notify_user_executed: toolCalls.some(
        (call) =>
          call.tool_name === "notify_user" &&
          (call.status === "executed" || call.status === "pending_confirmation")
      ),
      toolCalls,
    });
    package_ready_outcome_errors = outcome.errors;
  }
  if (skillSlug === "coordinate-photo-session") {
    const outcome = validatePhotosScheduledProposeSlotsOutcome({
      current_step: after.current_step ?? "",
      status: after.status ?? "",
      toolCalls,
      reminder_sent_event: events.some((event) => event.event_type === "reminder_sent"),
    });
    photos_scheduled_outcome_errors = outcome.errors;
  }
  if (skillSlug === "perform-comparable-analysis") {
    const outcome = validateComparablesCaseOutcome({
      comparables_analysis: contextValue(context, "comparables_analysis"),
      current_step: after.current_step ?? "",
      status: after.status ?? "",
      notify_user_executed: toolCalls.some(
        (call) =>
          call.tool_name === "notify_user" &&
          (call.status === "executed" || call.status === "pending_confirmation")
      ),
    });
    comparables_outcome_errors = outcome.errors;
    comparables_usable_count = outcome.usable_count;
    comparables_defensible = outcome.defensible;
  }
  return {
    ok:
      missing_context_keys.length === 0 &&
      artifact_errors.length === 0 &&
      missing_events.length === 0 &&
      missing_tool_calls.length === 0 &&
      missing_internal_tool_calls.length === 0 &&
      missing_any_tool_call.length === 0 &&
      comparables_outcome_errors.length === 0 &&
      package_ready_outcome_errors.length === 0 &&
      photos_scheduled_outcome_errors.length === 0,
    expected_tool_calls,
    expected_internal_tool_calls: contract.expected_internal_tool_calls ?? [],
    optional_tool_calls: contract.optional_tool_calls ?? [],
    missing_context_keys,
    created_context_keys,
    missing_events,
    missing_tool_calls,
    missing_internal_tool_calls,
    missing_any_tool_call,
    artifact_errors,
    comparables_outcome_errors,
    comparables_usable_count,
    comparables_defensible,
    package_ready_outcome_errors,
    photos_scheduled_outcome_errors,
  };
}

function buildSkillTestMessage(params: {
  opCase: OperationalCase;
  skill: OperationalCaseFlowSkill;
  stepKey: string;
  contract: SkillTestContract;
}) {
  const objectiveLine =
    params.skill.skill_slug === "coordinate-photo-session"
      ? "Objetivo de prueba: consultar calendario, proponer 3 ventanas diurnas al contacto por Telegram y dejar waiting_external. No hace falta photo_session previo ni claves nuevas en context_jsonb."
      : params.contract.expected_context_keys.length > 0
        ? `Objetivo de prueba: generar o actualizar en context_jsonb estas claves: ${params.contract.expected_context_keys.join(", ")}.`
        : "Objetivo de prueba: cubrir el contrato operativo del paso aunque no haya artefacto context_jsonb nuevo.";
  const lines = [
    `Prueba controlada de habilidad desde Ajustes para el caso ${params.opCase.id}.`,
    `Ejecuta únicamente la habilidad ${params.skill.skill_slug} del paso ${params.stepKey}.`,
    objectiveLine,
    "Usa las tools disponibles sólo si son necesarias. No ejecutes escrituras reales de alto riesgo sin confirmación humana; si una fuente no está disponible, registra la limitación y continúa cuando el contrato lo permita.",
  ];
  if ((params.contract.expected_tool_calls ?? []).length > 0) {
    lines.push(
      `Para que la prueba pase, cubre estas tools del paso: ${params.contract.expected_tool_calls?.join(", ")}.`
    );
  }
  if ((params.contract.expected_internal_tool_calls ?? []).length > 0) {
    lines.push(
      `También registra estas acciones internas: ${params.contract.expected_internal_tool_calls?.join(", ")}.`
    );
  }
  if ((params.contract.expected_events ?? []).length > 0) {
    lines.push(
      `Debe quedar evidencia en eventos: ${params.contract.expected_events?.join(", ")}.`
    );
  }
  if ((params.contract.optional_tool_calls ?? []).length > 0) {
    lines.push(
      `Estas tools son condicionales/opcionales en este escenario: ${params.contract.optional_tool_calls?.join(", ")}.`
    );
  }
  if (params.skill.skill_slug === "prepare-listing-price") {
    lines.push(
      "Antes de guardar pricing_proposal, calcula numeros concretos desde context_jsonb.comparables_analysis.stats.price. Si hay p25/p50/p75 disponibles, no uses placeholders ni ceros. Debes llamar notify_user con kind='price_approval' para pedir aprobacion al asesor interno. Inserta tambien operational_case_add_event con event_type='human_decision' y payload.kind='price_proposed'. Usa status='waiting_internal', no waiting_external, cuando esperas respuesta del asesor interno."
    );
  }
  if (params.skill.skill_slug === "extract-property-characteristics") {
    const expectsNotify = (params.contract.expected_tool_calls ?? []).includes(
      "notify_user"
    );
    if (expectsNotify) {
      lines.push(
        "Esta prueba N3 cubre el camino con datos críticos completos (bedrooms, bathrooms y parking_spots > 0 en property_data). Tras operational_case_list_documents debes llamar notify_user con kind='property_data_review' de forma OBLIGATORIA en este tick, luego operational_case_add_event(step_completed) y operational_case_update_state a status='waiting_internal' y current_step='property_data_review'. Al actualizar context_jsonb.property_data haz merge con lo existente: conserva bedrooms, bathrooms, parking_spots, operation y property_type (no los borres al volcar datos de escritura). No uses telegram_send_message_to_contact ni avances a property_data_review sin haber ejecutado notify_user."
      );
    } else {
      lines.push(
        "Si faltan datos críticos en property_data, pregunta solo esos faltantes al contacto externo con telegram_send_message_to_contact(purpose='characteristics_pending') y deja status='waiting_external'."
      );
    }
  }
  if (
    params.skill.skill_slug === "request-property-documents" ||
    (params.contract.expected_tool_calls ?? []).includes(
      "telegram_send_message_to_contact"
    )
  ) {
    lines.push(
      "Invoca telegram_send_message_to_contact como máximo una vez en este tick de prueba; no repitas el mismo mensaje al contacto externo."
    );
  }
  if (params.skill.skill_slug === "perform-comparable-analysis") {
    lines.push(
      "Usa la zona efectiva del caso: prioriza property_zone/zona del contexto del caso de prueba y alinea property_data.address.neighborhood con esa zona (no uses otra colonia). Consulta easybroker_search_listings, easybroker_search_closed_deals y bigquery_lookup_local_comparables con operación, tipo y m² de property_data.",
      "Después de las búsquedas, NO escribas comparables_analysis a mano con operational_case_update_state. Debes llamar operational_case_persist_comparables_analysis para que el sistema construya stats/listas/data_quality desde los tool_calls del turno.",
      "Si operational_case_persist_comparables_analysis devuelve usable_count=0 en todas las fuentes: NO avances a price_proposal_pending; deja current_step=comparables_in_progress y status=waiting_internal; ejecuta notify_user al asesor con datos de la propiedad, filtros usados y sugerencias concretas para ampliar búsqueda (precio, m², meses).",
      "Si devuelve defensible_sample=true: operational_case_update_state a price_proposal_pending y status=active, y notify_user resumiendo el análisis. No uses telegram_send_message_to_contact."
    );
  }
  if (params.skill.skill_slug === "prepare-commission-contract") {
    lines.push(
      "Llama generate_document_from_template exactamente una vez en este tick. Reutiliza el signed_url/output_path devuelto para notify_user y operational_case_add_event; no generes el mismo contrato dos veces."
    );
  }
  if (params.skill.skill_slug === "coordinate-photo-session") {
    lines.push(
      "Flujo de este escenario: calendar_list_events (ventana mañana +5 días, calendar_id=primary) para ver disponibilidad; propone 3 ventanas diurnas al dueño con telegram_send_message_to_contact(purpose=propose_photo_slots) usando external_contact_jsonb.chat_id del caso.",
      "Inserta operational_case_add_event(reminder_sent, payload con purpose=propose_photo_slots y las opciones). operational_case_update_state: current_step=photos_scheduled, status=waiting_external.",
      "NO uses calendar_create_event ni calendar_update_event en este tick (el dueño aún no confirmó horario).",
      "Invoca telegram_send_message_to_contact como máximo una vez en este tick."
    );
  }
  if (params.skill.skill_slug === "publish-listing-package") {
    lines.push(
      "Preflight obligatorio: verifica pricing_proposal.approval_status=approved, evento human_decision kind=contract_signed en el timeline y raw_photos con al menos 5 fotos.",
      "Si falla algún gate (en esta prueba raw_photos está vacío o insuficiente): NO uses image_watermark, easybroker_create_listing, easybroker_upload_images ni ungga_publish_listing.",
      "En preflight bloqueado: notify_user al asesor listando qué falta (fotos crudas, contrato firmado si aplica), luego operational_case_update_state con current_step=package_ready y status=paused (no waiting_internal ni completed). operational_case_add_event es opcional en este escenario.",
      "No avances a published ni marques el caso completed en este escenario."
    );
  }
  return lines.join(" ");
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

    const body = (await request.json().catch(() => ({}))) as SkillRunBody;
    const caseTypeId = cleanText(body.case_type_id);
    const caseId = cleanText(body.case_id);
    const skillSlug = cleanText(body.skill_slug);
    if (!caseTypeId || !skillSlug) {
      return NextResponse.json(
        { error: "case_type_id and skill_slug are required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType || (caseType.user_id && caseType.user_id !== user.id)) {
      return NextResponse.json({ error: "case_type_not_found" }, { status: 404 });
    }

    let opCase = caseId
      ? await getOperationalCase(db, caseId)
      : await latestSettingsTestCase(db, user.id, caseType.id);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json(
        { error: "test_case_required", hint: "Crea primero un caso de prueba." },
        { status: 400 }
      );
    }

    const flow = await effectiveFlowForCaseType(db, caseType);
    const located = skillInFlow(flow, skillSlug);
    if (!located) {
      return NextResponse.json(
        { error: "skill_not_in_flow", skill_slug: skillSlug },
        { status: 400 }
      );
    }

    const flowContract = normalizeSkillTestContract(
      (located.skill as unknown as { test_contract?: unknown }).test_contract
    );
    const readinessSkillToolIds = uniqueStrings(
      readinessToolIdsForSkill(located.skill.skill_tools ?? [])
    );
    const allSkillToolIds = uniqueStrings(
      (located.skill.skill_tools ?? []).map((tool) => tool.tool_id)
    );
    const contract =
      flowContract ??
      SKILL_TEST_CONTRACTS[skillSlug] ?? {
        expected_context_keys: [],
        tool_coverage_policy: "all_step_tools",
        required_tools_policy: "all_ready_and_tested",
      };
    if (contract.required_tools_policy === "all_ready_and_tested") {
      const tested = await testedToolsForUser(db, user.id, readinessSkillToolIds);
      const missing = missingTestedTools(readinessSkillToolIds, tested);
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: "skill_blocked_by_tools",
            skill_slug: skillSlug,
            missing_tested_tools: missing,
            hint:
              "Primero prueba exitosamente las tools de integración/acción de esta habilidad (N1). Las tools internas de plataforma no requieren N1.",
          },
          { status: 400 }
        );
      }
    }

    if (
      skillSlug === "extract-property-characteristics" &&
      isSettingsTestCase(opCase)
    ) {
      opCase = await applyExtractCharacteristicsSkillTestSeed(db, opCase);
    }
    if (
      skillSlug === "perform-comparable-analysis" &&
      isSettingsTestCase(opCase)
    ) {
      opCase = await applyComparablesSkillTestSeed(db, opCase);
    }
    if (
      skillSlug === "publish-listing-package" &&
      isSettingsTestCase(opCase)
    ) {
      opCase = await applyPackageReadySkillTestSeed(db, opCase);
    }
    if (
      skillSlug === "coordinate-photo-session" &&
      isSettingsTestCase(opCase)
    ) {
      opCase = await applyPhotosScheduledSkillTestSeed(db, opCase);
    }

    ensureAgentToolDepsWired();
    const startedEvent = await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "skill_test_started",
        source: "tool_readiness_run_skill",
        skill_slug: skillSlug,
        step_key: located.step.step_key,
        expected_context_keys: contract.expected_context_keys,
        expected_tool_calls: expectedSourceToolCalls(contract, allSkillToolIds),
        expected_internal_tool_calls: contract.expected_internal_tool_calls ?? [],
      },
    });

    const profile = await getProfile(db, user.id);
    const [toolSettings, skillSettings, integrations, googleCalendarAccessToken] =
      await Promise.all([
        getUserToolSettings(db, user.id),
        getUserSkillSettings(db, user.id),
        getUserIntegrations(db, user.id),
        getGoogleCalendarAccessToken(db, user.id),
      ]);
    const githubIntegration = integrations.find((item) => item.provider === "github");
    let githubToken: string | undefined;
    if (githubIntegration) {
      const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
        .encrypted_tokens;
      if (raw) {
        try {
          githubToken = decryptToken(raw);
        } catch {
          /* ignore invalid GitHub token for skill tests */
        }
      }
    }

    const session = await getOrCreateSession(db, user.id, "case_runner");
    const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    const toolApprovalPolicy: ToolApprovalPolicy = {};
    for (const tool of located.skill.skill_tools ?? []) {
      const risk = catalogById.get(tool.tool_id)?.risk ?? "medium";
      toolApprovalPolicy[tool.tool_id] =
        risk === "low" ? "auto_execute" : "request_approval";
    }
    if (isSettingsTestCase(opCase)) {
      Object.assign(
        toolApprovalPolicy,
        buildSettingsTestToolApprovalPolicy(located.skill.skill_tools?.map((t) => t.tool_id))
      );
    }

    const agentResult = await runAgent({
      message: buildSkillTestMessage({
        opCase,
        skill: located.skill,
        stepKey: located.step.step_key,
        contract,
      }),
      userId: user.id,
      sessionId: session.id,
      systemPrompt: profile.agent_system_prompt,
      db,
      enabledTools: toolSettings,
      enabledSkills: skillSettings,
      integrations,
      githubToken,
      userTimezone: profile.timezone,
      userName: profile.name,
      userEmail: profile.email,
      userPhone: profile.phone,
      businessBrain: profile.business_brain ?? {},
      isUnggaAdmin: profile.is_ungga_admin ?? false,
      channel: "case_runner",
      googleCalendarAccessToken: googleCalendarAccessToken ?? undefined,
      autoApproveTools: false,
      forcedSkillId: skillSlug,
      caseId: opCase.id,
      toolApprovalPolicy,
    });

    let after = (await getOperationalCase(db, opCase.id)) ?? opCase;
    let deterministicRepair:
      | { applied: false }
      | { applied: true; reason?: string } = { applied: false };
    if (skillSlug === "prepare-listing-price") {
      const repair = await repairPricingProposalForSkillTest(db, after);
      after = repair.opCase;
      deterministicRepair = repair.repaired
        ? { applied: true, reason: repair.reason }
        : { applied: false };
    }
    if (
      skillSlug === "extract-property-characteristics" &&
      isSettingsTestCase(after)
    ) {
      const repair = await repairPropertyDataForExtractSkillTest(db, after);
      after = repair.opCase;
      if (repair.repaired) {
        deterministicRepair = { applied: true, reason: repair.reason };
      }
    }
    const recentEvents = (await getRecentOperationalCaseEvents(db, opCase.id, 100)).filter(
      (event) => event.created_at >= startedEvent.created_at
    );
    const toolCalls = await listToolCallsForTurn(db, agentResult.turnId);
    const validation = validateContract(
      contract,
      opCase,
      after,
      recentEvents,
      toolCalls,
      allSkillToolIds,
      skillSlug
    );
    const status = validation.ok
      ? "tested_ok"
      : agentResult.pendingConfirmation
        ? "partial"
        : "tested_failed";
    const sourceToolIds = new Set(
      (located.skill.skill_tools ?? []).map((tool) => tool.tool_id)
    );
    const { sourceToolCalls, internalToolCalls, otherToolCalls } =
      classifySkillTestToolCalls({
        toolCalls,
        sourceToolIds,
        expectedInternalToolCalls: contract.expected_internal_tool_calls ?? [],
      });
    const toToolCallSummary = (call: ToolCall) => ({
      tool_name: call.tool_name,
      status: call.status,
    });
    const toToolCallDetails = (call: ToolCall) => ({
      tool_name: call.tool_name,
      status: call.status,
      arguments_json: call.arguments_json,
      result_json: call.result_json,
      created_at: call.created_at,
      finished_at: call.finished_at ?? null,
    });
    const afterContext = (after.context_jsonb ?? {}) as Record<string, unknown>;
    const artifacts = Object.fromEntries(
      contract.expected_context_keys
        .map((key) => [key, contextValue(afterContext, key)] as const)
        .filter(([, value]) => value !== undefined)
    );
    const preview = responsePreview(agentResult.response);

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "skill_test_completed",
        source: "tool_readiness_run_skill",
        skill_slug: skillSlug,
        step_key: located.step.step_key,
        status,
        validation,
        expected_step_tools: allSkillToolIds,
        readiness_step_tools: readinessSkillToolIds,
        pending_confirmation: Boolean(agentResult.pendingConfirmation),
        deterministic_repair: deterministicRepair,
        source_tool_calls: sourceToolCalls.map(toToolCallSummary),
        internal_tool_calls: internalToolCalls.map(toToolCallSummary),
        other_tool_calls: otherToolCalls.map(toToolCallSummary),
        tool_calls: toolCalls.map(toToolCallSummary),
      },
    });

    return NextResponse.json({
      ok: validation.ok,
      status,
      skill_slug: skillSlug,
      step_key: located.step.step_key,
      expected_context_keys: contract.expected_context_keys,
      expected_step_tools: allSkillToolIds,
      readiness_step_tools: readinessSkillToolIds,
      validation,
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      deterministic_repair: deterministicRepair,
      response_preview: preview.text,
      response_preview_truncated: preview.truncated,
      artifacts,
      source_tool_calls: sourceToolCalls.map(toToolCallDetails),
      internal_tool_calls: internalToolCalls.map(toToolCallDetails),
      other_tool_calls: otherToolCalls.map(toToolCallDetails),
      tool_calls: toolCalls.map(toToolCallDetails),
      case: after,
    });
  } catch (err) {
    console.error("[POST /api/tool-readiness/run-skill] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
