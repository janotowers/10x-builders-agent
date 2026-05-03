import type {
  BusinessBrain,
  BusinessBrainWarehouseSource,
} from "@agents/types";

export type BusinessBrainReviewSlot =
  | "agent_identity.role"
  | "agent_identity.short_description"
  | "soul.voice"
  | "soul.tone"
  | "soul.style"
  | "soul.brevity"
  | "business_context.notes"
  | "operating_preferences.text";

export const BUSINESS_BRAIN_TEXT_LIMITS: Record<BusinessBrainReviewSlot, number> = {
  "agent_identity.role": 220,
  "agent_identity.short_description": 400,
  "soul.voice": 300,
  "soul.tone": 300,
  "soul.style": 300,
  "soul.brevity": 220,
  "business_context.notes": 800,
  "operating_preferences.text": 800,
};

export const BUSINESS_BRAIN_SLOT_DESCRIPTIONS: Record<
  BusinessBrainReviewSlot,
  string
> = {
  "agent_identity.role":
    "Rol breve del colaborador IA para este perfil. Define su función principal sin cambiar permisos ni herramientas.",
  "agent_identity.short_description":
    "Descripción corta de quién es el agente para esta cuenta.",
  "soul.voice":
    "Voz del agente: cómo suena al responder. Solo afecta estilo.",
  "soul.tone":
    "Tono o formalidad del agente. Solo afecta estilo.",
  "soul.style":
    "Preferencias de formato y redacción. No define capacidades.",
  "soul.brevity":
    "Preferencia de longitud de respuestas. No anula requisitos de claridad.",
  "business_context.notes":
    "Contexto estable del negocio/trabajo. No debe contener reglas de seguridad ni playbooks largos.",
  "operating_preferences.text":
    "Preferencias operativas editables que aplican solo si son compatibles con reglas de sistema, aprobaciones humanas, herramientas habilitadas y aislamiento de datos por cuenta.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map(cleanString)
    .filter((item): item is string => !!item);
  return cleaned.length > 0 ? cleaned : [];
}

/**
 * Returns the effective warehouse binding. New `data_sources.warehouse` values
 * win; legacy `identity`/`bigquery` fills gaps during the transition.
 */
export function getBusinessBrainWarehouse(
  businessBrain: BusinessBrain | undefined | null
): BusinessBrainWarehouseSource | undefined {
  if (!businessBrain || !isRecord(businessBrain)) return undefined;
  const legacyIdentity = isRecord(businessBrain.identity)
    ? businessBrain.identity
    : {};
  const legacyBigquery = isRecord(businessBrain.bigquery)
    ? businessBrain.bigquery
    : {};
  const dataSources = isRecord(businessBrain.data_sources)
    ? businessBrain.data_sources
    : {};
  const warehouse = isRecord(dataSources.warehouse)
    ? dataSources.warehouse
    : {};

  const datasetAllowlist =
    cleanStringArray(warehouse.dataset_allowlist) ??
    cleanStringArray(legacyBigquery.dataset_allowlist);

  const result: BusinessBrainWarehouseSource = {
    provider: "bigquery",
    organization_id:
      cleanString(warehouse.organization_id) ??
      cleanString(legacyIdentity.organization_id),
    org_name:
      cleanString(warehouse.org_name) ?? cleanString(legacyIdentity.org_name),
    country:
      cleanString(warehouse.country) ?? cleanString(legacyIdentity.country),
    project_id:
      cleanString(warehouse.project_id) ??
      cleanString(legacyBigquery.project_id),
    location:
      cleanString(warehouse.location) ?? cleanString(legacyBigquery.location),
    dataset_allowlist: datasetAllowlist,
  };

  const hasValue = Object.entries(result).some(([key, value]) => {
    if (key === "provider") return false;
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
  return hasValue ? result : undefined;
}

export function buildWarehouseCompatibilityPatch(
  warehouse: BusinessBrainWarehouseSource
): Partial<BusinessBrain> {
  const identity = {
    organization_id: cleanString(warehouse.organization_id),
    org_name: cleanString(warehouse.org_name),
    country: cleanString(warehouse.country),
  };
  const bigquery = {
    project_id: cleanString(warehouse.project_id),
    location: cleanString(warehouse.location),
    dataset_allowlist: Array.isArray(warehouse.dataset_allowlist)
      ? warehouse.dataset_allowlist
      : undefined,
  };
  return {
    data_sources: { warehouse: { ...warehouse, provider: "bigquery" } },
    identity,
    bigquery,
  };
}

export function truncateBusinessBrainText(
  slot: BusinessBrainReviewSlot,
  text: string
): string {
  const limit = BUSINESS_BRAIN_TEXT_LIMITS[slot];
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, limit).trim() : normalized;
}
