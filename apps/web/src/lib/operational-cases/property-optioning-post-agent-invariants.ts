import {
  buildComparablesAnalysisFromToolCalls,
  buildPropertyDataMinimumsSummaryMessage,
  comparablesHasDefensibleSample,
  documentExtractionMinimumsContext,
  evaluatePropertyAdvanceGate,
  evaluatePropertyDataMinimumsForReview,
  resolveSubjectAreaM2FromPropertyData,
  runDocumentFieldExtraction,
  tryAdvanceComparablesAfterPersist,
  validateComparablesAnalysisArtifact,
  type PropertyAdvanceGateBlock,
} from "@agents/agent";
import {
  createServerClient,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCase,
} from "@agents/db";
import {
  operationalCaseDocumentRequestTargetFromContext,
  type OperationalCase,
} from "@agents/types";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import { resolveParkingSpacesForDisplay } from "./parse-owner-characteristics";
import { createAdvisedCaseUpdate } from "./advised-case-update";
import {
  deliverInternalCaseFollowUp,
  notifyUserRespectingActiveInternalChannel,
} from "./deliver-internal-case-follow-up";
import { ensureContractCommercialDataAsk } from "./ensure-contract-commercial-ask";

// Paridad lab/producción (S1.6): las transiciones de paso de los invariants
// pasan por el mismo evaluador de definiciones que el resto del runtime. Las
// escrituras solo-contexto siguen directas (no proponen transición).
const advisedInvariantCaseUpdate = createAdvisedCaseUpdate(
  "post_agent_invariants",
  "runtime"
);

type ApplyPropertyOptioningPostAgentInvariantsResult = {
  case: OperationalCase | null;
  action:
    | "not_applicable"
    | "no_action"
    | "deferred_pending_extraction"
    | "remediated_extraction"
    | "escalated_extraction_to_human"
    | "asked_missing_characteristics"
    | "asked_missing_characteristics_internal"
    | "asked_missing_characteristics_again"
    | "asked_missing_characteristics_again_internal"
    | "requested_property_data_review"
    | "remediated_comparables"
    | "requested_comparables_decision"
    | "advanced_to_price_proposal"
    | "requested_property_data_quality_review"
    | "requested_contract_data_review";
};

/**
 * Circuit breaker para la auto-remediación determinística de extracción (WS3).
 * Tras N intentos sin lograr extraer un documento, dejamos de reintentar y
 * escalamos a humano en vez de congelar el caso (sub-decisión A).
 */
const MAX_EXTRACTION_REMEDIATION_ATTEMPTS = (() => {
  const raw = Number(process.env.DOCUMENT_EXTRACTION_MAX_REMEDIATION_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
})();
const MAX_PREDIAL_QUALITY_REMEDIATION_ATTEMPTS = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Score de confianza por fuente de un dato de propiedad. Documentos oficiales
 * mandan sobre insumos manuales/formulario (que quedan en 0). Reutilizado por el
 * sync del laboratorio (lab_form) para respetar la misma precedencia.
 */
export function surfaceSourceScore(value: unknown): number {
  if (typeof value !== "string") return 0;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes("predial")) return 4;
  if (normalized.includes("boleta")) return 3;
  if (normalized.includes("escritura")) return 2;
  if (normalized.includes("documento")) return 1;
  return 0;
}

type MergeDocumentSurfacesResult = {
  context: Record<string, unknown>;
  changed: boolean;
  adopted: {
    area_total_m2?: number;
    area_construida_m2?: number;
  };
};

export function mergeDocumentSurfacesIntoContextPropertyData(input: {
  context: Record<string, unknown> | null | undefined;
  documentFields: Record<string, unknown>;
}): MergeDocumentSurfacesResult {
  const baseContext = asRecord(input.context) ?? {};
  const basePropertyData = asRecord(baseContext.property_data) ?? {};
  const documentFields = input.documentFields;
  const nextContext: Record<string, unknown> = {
    ...baseContext,
    property_data: { ...basePropertyData },
  };
  const nextPropertyData = nextContext.property_data as Record<string, unknown>;
  const adopted: MergeDocumentSurfacesResult["adopted"] = {};
  let changed = false;

  const maybeAdopt = (field: "area_total_m2" | "area_construida_m2") => {
    const sourceField = `${field}_source` as const;
    const incoming = positiveNumberOrNull(documentFields[field]);
    if (incoming == null) return;
    const existing = positiveNumberOrNull(nextPropertyData[field]);
    const incomingSource = documentFields[sourceField];
    const existingSource = nextPropertyData[sourceField];
    const shouldAdopt =
      existing == null ||
      surfaceSourceScore(incomingSource) > surfaceSourceScore(existingSource) ||
      (typeof incomingSource === "string" &&
        incomingSource.toLowerCase().includes("predial") &&
        incoming !== existing);
    if (!shouldAdopt) return;

    nextPropertyData[field] = incoming;
    if (incomingSource != null && incomingSource !== "") {
      nextPropertyData[sourceField] = incomingSource;
    }
    // Backfill top-level context for legacy readers outside property_data.
    nextContext[field] = incoming;
    if (incomingSource != null && incomingSource !== "") {
      nextContext[sourceField] = incomingSource;
    }
    adopted[field] = incoming;
    changed = true;
  };

  maybeAdopt("area_total_m2");
  maybeAdopt("area_construida_m2");

  return { context: nextContext, changed, adopted };
}

type CanonicalAddress = {
  street?: string;
  exterior_number?: string;
  neighborhood?: string;
  municipality?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  source?: string;
};

type AddressConflict = {
  field: string;
  existing: string;
  incoming: string;
  existing_source: string | null;
  incoming_source: string | null;
  detected_at: string;
};

type MergeDocumentAddressResult = {
  context: Record<string, unknown>;
  changed: boolean;
  adopted: CanonicalAddress;
  /** Conflictos NUEVOS detectados en esta ejecución (excluye los ya presentes). */
  newConflicts: AddressConflict[];
};

/**
 * Clave de deduplicación de un conflicto de dirección. Excluye `detected_at`
 * (varía en cada corrida) para que re-ejecutar la consolidación con los mismos
 * insumos no genere conflictos "nuevos" ni dispare escrituras/eventos.
 */
function addressConflictDedupeKey(conflict: Record<string, unknown>): string {
  return [
    String(conflict.field ?? ""),
    String(conflict.existing ?? ""),
    String(conflict.incoming ?? ""),
    String(conflict.existing_source ?? ""),
    String(conflict.incoming_source ?? ""),
  ].join("|");
}

/** ¿`adopted` trae al menos un campo de dirección visible para el operador? */
function addressAdoptedHasVisibleField(adopted: CanonicalAddress): boolean {
  return Boolean(
    cleanAddressString(adopted.street) ||
      cleanAddressString(adopted.exterior_number) ||
      cleanAddressString(adopted.neighborhood) ||
      cleanAddressString(adopted.municipality) ||
      cleanAddressString(adopted.state) ||
      cleanAddressString(adopted.postal_code) ||
      cleanAddressString(adopted.country)
  );
}

type MergeDocumentLegalIdentityResult = {
  context: Record<string, unknown>;
  changed: boolean;
  adopted: {
    owner_names?: string[];
    owner_name?: string;
    owner_names_source?: string;
    legal_addresses?: string[];
    legal_address?: string;
    legal_addresses_source?: string;
  };
};

function cleanAddressString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const cleaned = cleanAddressString(item);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function legalIdentitySourceScore(value: unknown): number {
  if (typeof value !== "string") return 0;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes("boleta")) return 5;
  if (normalized.includes("escritura")) return 4;
  if (normalized.includes("predial")) return 3;
  if (normalized.includes("document")) return 2;
  return 1;
}

export function mergeDocumentLegalIdentityIntoContextPropertyData(input: {
  context: Record<string, unknown> | null | undefined;
  documentFields: Record<string, unknown>;
}): MergeDocumentLegalIdentityResult {
  const baseContext = asRecord(input.context) ?? {};
  const basePropertyData = asRecord(baseContext.property_data) ?? {};
  const nextContext: Record<string, unknown> = {
    ...baseContext,
    property_data: { ...basePropertyData },
  };
  const nextPropertyData = nextContext.property_data as Record<string, unknown>;
  const adopted: MergeDocumentLegalIdentityResult["adopted"] = {};
  let changed = false;

  const incomingOwnerNames = cleanStringArray(input.documentFields.owner_names);
  const incomingOwnerSource =
    cleanAddressString(input.documentFields.owner_names_source) ??
    cleanAddressString(input.documentFields.owner_source) ??
    "";
  const existingOwnerNames = cleanStringArray(nextPropertyData.owner_names);
  const existingOwnerSource =
    cleanAddressString(nextPropertyData.owner_names_source) ??
    cleanAddressString(nextPropertyData.owner_source) ??
    cleanAddressString(nextContext.owner_names_source) ??
    "";
  const shouldAdoptOwners =
    incomingOwnerNames.length > 0 &&
    (existingOwnerNames.length === 0 ||
      legalIdentitySourceScore(incomingOwnerSource) >=
        legalIdentitySourceScore(existingOwnerSource));
  const ownerValuesDiffer = !sameStringArray(incomingOwnerNames, existingOwnerNames);
  const ownerSourceImproves =
    legalIdentitySourceScore(incomingOwnerSource) >
    legalIdentitySourceScore(existingOwnerSource);
  const ownerSourceChanges =
    incomingOwnerSource.length > 0 && incomingOwnerSource !== existingOwnerSource;
  const ownersMateriallyChanged =
    ownerValuesDiffer || (ownerSourceChanges && ownerSourceImproves);
  if (shouldAdoptOwners && ownersMateriallyChanged) {
    nextPropertyData.owner_names = incomingOwnerNames;
    nextPropertyData.owner_name = incomingOwnerNames[0];
    if (incomingOwnerSource) {
      nextPropertyData.owner_names_source = incomingOwnerSource;
    }
    nextContext.owner_names = incomingOwnerNames;
    nextContext.owner_name = incomingOwnerNames[0];
    if (incomingOwnerSource) {
      nextContext.owner_names_source = incomingOwnerSource;
    }
    adopted.owner_names = incomingOwnerNames;
    adopted.owner_name = incomingOwnerNames[0];
    if (incomingOwnerSource) adopted.owner_names_source = incomingOwnerSource;
    changed = true;
  }

  const incomingLegalAddresses = [
    ...cleanStringArray(input.documentFields.legal_addresses),
    ...(() => {
      const one = cleanAddressString(input.documentFields.legal_address);
      return one ? [one] : [];
    })(),
  ];
  const dedupedIncomingLegalAddresses = [...new Set(incomingLegalAddresses)];
  const incomingLegalSource =
    cleanAddressString(input.documentFields.legal_addresses_source) ??
    cleanAddressString(input.documentFields.legal_address_source) ??
    "";
  const existingLegalAddresses = cleanStringArray(nextPropertyData.legal_addresses);
  const existingLegalSource =
    cleanAddressString(nextPropertyData.legal_addresses_source) ??
    cleanAddressString(nextPropertyData.legal_address_source) ??
    cleanAddressString(nextContext.legal_addresses_source) ??
    "";
  const shouldAdoptLegalAddress =
    dedupedIncomingLegalAddresses.length > 0 &&
    (existingLegalAddresses.length === 0 ||
      legalIdentitySourceScore(incomingLegalSource) >=
        legalIdentitySourceScore(existingLegalSource));
  const legalValuesDiffer = !sameStringArray(
    dedupedIncomingLegalAddresses,
    existingLegalAddresses
  );
  const legalSourceImproves =
    legalIdentitySourceScore(incomingLegalSource) >
    legalIdentitySourceScore(existingLegalSource);
  const legalSourceChanges =
    incomingLegalSource.length > 0 && incomingLegalSource !== existingLegalSource;
  const legalMateriallyChanged =
    legalValuesDiffer || (legalSourceChanges && legalSourceImproves);
  if (shouldAdoptLegalAddress && legalMateriallyChanged) {
    nextPropertyData.legal_addresses = dedupedIncomingLegalAddresses;
    nextPropertyData.legal_address = dedupedIncomingLegalAddresses[0];
    if (incomingLegalSource) {
      nextPropertyData.legal_addresses_source = incomingLegalSource;
    }
    nextContext.legal_addresses = dedupedIncomingLegalAddresses;
    nextContext.legal_address = dedupedIncomingLegalAddresses[0];
    if (incomingLegalSource) {
      nextContext.legal_addresses_source = incomingLegalSource;
    }
    adopted.legal_addresses = dedupedIncomingLegalAddresses;
    adopted.legal_address = dedupedIncomingLegalAddresses[0];
    if (incomingLegalSource) adopted.legal_addresses_source = incomingLegalSource;
    changed = true;
  }

  return { context: nextContext, changed, adopted };
}

function firstAddressString(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const cleaned = cleanAddressString(source[key]);
    if (cleaned) return cleaned;
  }
  return null;
}

function addressSourceScore(value: unknown): number {
  if (typeof value !== "string") return 0;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes("boleta")) return 5;
  if (normalized.includes("predial")) return 4;
  if (normalized.includes("escritura")) return 3;
  if (normalized.includes("document")) return 2;
  return 1;
}

function parseStreetAndExteriorFromLegalAddress(value: string): CanonicalAddress {
  const normalized = value.replace(/\s+/g, " ").trim();
  const streetCommaNumber = normalized.match(
    /^(?:C(?:ALLE)?\.?\s+)?([^,]+?)\s*,\s*([0-9]+[A-Z0-9-]*)\b/i
  );
  if (streetCommaNumber) {
    return {
      street: streetCommaNumber[1]?.trim(),
      exterior_number: streetCommaNumber[2]?.trim(),
    };
  }
  const byNumero = normalized.match(
    /NUMERO\s+([A-Z0-9-]+)\s*,?\s*(?:DE\s+LA\s+CALLE|CALLE)\s+([^,]+)/i
  );
  if (byNumero) {
    return {
      exterior_number: byNumero[1]?.trim(),
      street: byNumero[2]?.trim(),
    };
  }
  const compactStreet = normalized.match(
    /^(?:C(?:ALLE)?\.?\s+)?([A-ZÁÉÍÓÚÑ0-9 .-]+?)\s+([0-9]+[A-Z0-9-]*)$/i
  );
  if (compactStreet) {
    return {
      street: compactStreet[1]?.trim(),
      exterior_number: compactStreet[2]?.trim(),
    };
  }
  return {};
}

function parseStreetAndExteriorFromStreetLine(value: string): CanonicalAddress {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.*?)(?:\s+|#)([0-9]+[A-Z0-9-]*)$/i);
  if (!match) return { street: normalized };
  return {
    street: match[1]?.trim(),
    exterior_number: match[2]?.trim(),
  };
}

export function mergeDocumentAddressIntoContextPropertyData(input: {
  context: Record<string, unknown> | null | undefined;
  documentFields: Record<string, unknown>;
}): MergeDocumentAddressResult {
  const baseContext = asRecord(input.context) ?? {};
  const basePropertyData = asRecord(baseContext.property_data) ?? {};
  const nextContext: Record<string, unknown> = {
    ...baseContext,
    property_data: { ...basePropertyData },
  };
  const nextPropertyData = nextContext.property_data as Record<string, unknown>;
  const existingAddress = asRecord(nextPropertyData.address) ?? {};
  const nextAddress: Record<string, unknown> = { ...existingAddress };
  const adopted: CanonicalAddress = {};

  const documentFields = input.documentFields;
  const legalAddresses = Array.isArray(documentFields.legal_addresses)
    ? documentFields.legal_addresses
        .map((entry) => cleanAddressString(entry))
        .filter((entry): entry is string => entry != null)
    : [];
  const legalAddressSource = cleanAddressString(documentFields.legal_addresses_source);

  const legalSourceIsBoleta = legalAddressSource?.toLowerCase().includes("boleta") === true;
  const preferredLegalAddresses = legalSourceIsBoleta
    ? legalAddresses
    : legalAddresses;
  let parsedFromLegal: CanonicalAddress = {};
  for (const candidate of preferredLegalAddresses) {
    const parsedCandidate = parseStreetAndExteriorFromLegalAddress(candidate);
    if (cleanAddressString(parsedCandidate.street) || cleanAddressString(parsedCandidate.exterior_number)) {
      parsedFromLegal = parsedCandidate;
      break;
    }
  }
  const legalStreet = cleanAddressString(parsedFromLegal.street);
  const legalExterior = cleanAddressString(parsedFromLegal.exterior_number);
  const parsedLegalStreetNumberComplete = Boolean(legalStreet && legalExterior);

  const addressFromDocuments = asRecord(documentFields.address) ?? {};
  const documentAddressSource = cleanAddressString(
    firstAddressString(addressFromDocuments, ["source", "extraction_source"])
  );
  const documentAddressSourceIsBoleta =
    documentAddressSource?.toLowerCase().includes("boleta") === true;
  const canAdoptSupplementalAddressFields =
    !legalSourceIsBoleta || documentAddressSourceIsBoleta;
  const canAdoptStreetNumberFromDocumentAddress =
    !legalSourceIsBoleta || documentAddressSourceIsBoleta || parsedLegalStreetNumberComplete;
  const parsedFromAddressStreet = cleanAddressString(addressFromDocuments.street)
    ? parseStreetAndExteriorFromStreetLine(String(addressFromDocuments.street))
    : {};
  const documentStreet = cleanAddressString(parsedFromAddressStreet.street);
  const documentExterior =
    cleanAddressString(parsedFromAddressStreet.exterior_number) ??
    firstAddressString(addressFromDocuments, ["exterior_number", "numero_exterior", "number"]);
  const addressConflicts = Array.isArray(nextPropertyData.address_conflicts)
    ? [...nextPropertyData.address_conflicts]
    : [];
  // Dedup contra conflictos ya persistidos: re-ejecutar la consolidación con los
  // mismos insumos NO debe re-disparar "conflicto nuevo" (idempotencia).
  const existingConflictKeys = new Set(
    addressConflicts.map((conflict) =>
      addressConflictDedupeKey(conflict as Record<string, unknown>)
    )
  );
  const newConflicts: AddressConflict[] = [];
  const recordConflict = (conflict: Omit<AddressConflict, "detected_at">) => {
    const key = addressConflictDedupeKey(conflict);
    if (existingConflictKeys.has(key)) return;
    existingConflictKeys.add(key);
    const full: AddressConflict = {
      ...conflict,
      detected_at: new Date().toISOString(),
    };
    addressConflicts.push(full);
    newConflicts.push(full);
  };

  if (
    legalSourceIsBoleta &&
    legalStreet &&
    documentStreet &&
    legalStreet.toLowerCase() !== documentStreet.toLowerCase()
  ) {
    recordConflict({
      field: "street",
      existing: legalStreet,
      incoming: documentStreet,
      existing_source: legalAddressSource ?? null,
      incoming_source: documentAddressSource ?? null,
    });
  }
  if (legalSourceIsBoleta && legalExterior && documentExterior && legalExterior !== documentExterior) {
    recordConflict({
      field: "exterior_number",
      existing: legalExterior,
      incoming: documentExterior,
      existing_source: legalAddressSource ?? null,
      incoming_source: documentAddressSource ?? null,
    });
  }

  const incoming: CanonicalAddress = {
    street:
      legalStreet ??
      (canAdoptStreetNumberFromDocumentAddress
        ? documentStreet ?? firstAddressString(addressFromDocuments, ["street", "full", "formatted"])
        : null) ??
      undefined,
    exterior_number:
      legalExterior ??
      (canAdoptStreetNumberFromDocumentAddress ? documentExterior : null) ??
      undefined,
    neighborhood: canAdoptSupplementalAddressFields
      ? firstAddressString(addressFromDocuments, ["neighborhood", "colonia"]) ?? undefined
      : undefined,
    municipality:
      canAdoptSupplementalAddressFields
        ? firstAddressString(addressFromDocuments, ["municipality", "municipio", "city"]) ??
          undefined
        : undefined,
    state: canAdoptSupplementalAddressFields
      ? firstAddressString(addressFromDocuments, ["state", "estado"]) ?? undefined
      : undefined,
    postal_code: canAdoptSupplementalAddressFields
      ? firstAddressString(addressFromDocuments, ["postal_code", "zip_code", "cp"]) ?? undefined
      : undefined,
    country: canAdoptSupplementalAddressFields
      ? firstAddressString(addressFromDocuments, ["country", "pais"]) ?? undefined
      : undefined,
    source:
      (legalSourceIsBoleta && !parsedLegalStreetNumberComplete && !documentAddressSourceIsBoleta
        ? documentAddressSource
        : legalAddressSource) ??
      firstAddressString(addressFromDocuments, ["source", "extraction_source"]) ??
      undefined,
  };

  const existingSource =
    cleanAddressString(existingAddress.source) ??
    cleanAddressString(nextPropertyData.address_source);
  const incomingSource = cleanAddressString(incoming.source);
  const shouldPreferIncoming =
    incomingSource != null &&
    addressSourceScore(incomingSource) >= addressSourceScore(existingSource);
  const incomingIsDeedSource = incomingSource?.toLowerCase().includes("escritura") === true;
  const canonicalExterior = cleanAddressString(nextAddress.exterior_number);
  const incomingExterior = cleanAddressString(incoming.exterior_number);
  let changed = false;
  const fields: Array<keyof CanonicalAddress> = [
    "street",
    "exterior_number",
    "neighborhood",
    "municipality",
    "state",
    "postal_code",
    "country",
  ];
  for (const field of fields) {
    const incomingValue = cleanAddressString(incoming[field]);
    if (!incomingValue) continue;
    const blockDeedOverwriteOnExteriorConflict =
      incomingIsDeedSource &&
      (field === "street" || field === "exterior_number") &&
      canonicalExterior != null &&
      incomingExterior != null &&
      canonicalExterior !== incomingExterior;
    if (blockDeedOverwriteOnExteriorConflict) {
      recordConflict({
        field,
        existing: canonicalExterior,
        incoming: incomingExterior,
        existing_source: existingSource ?? null,
        incoming_source: incomingSource ?? null,
      });
      continue;
    }
    const existingValue = cleanAddressString(nextAddress[field]);
    const shouldSet = shouldPreferIncoming || !existingValue;
    if (!shouldSet) {
      if (existingValue && existingValue !== incomingValue) {
        recordConflict({
          field,
          existing: existingValue,
          incoming: incomingValue,
          existing_source: existingSource ?? null,
          incoming_source: incomingSource ?? null,
        });
      }
      continue;
    }
    if (existingValue === incomingValue) continue;
    nextAddress[field] = incomingValue;
    adopted[field] = incomingValue;
    changed = true;
  }

  if (incomingSource) {
    const existingAddressSource = cleanAddressString(nextAddress.source);
    const shouldSetSource =
      existingAddressSource == null ||
      addressSourceScore(incomingSource) >= addressSourceScore(existingAddressSource);
    if (shouldSetSource && existingAddressSource !== incomingSource) {
      nextAddress.source = incomingSource;
      nextPropertyData.address_source = incomingSource;
      adopted.source = incomingSource;
      changed = true;
    }
  }

  // Un conflicto NUEVO es un cambio material (hay que persistirlo y auditarlo).
  // Conflictos ya presentes NO re-disparan `changed` en corridas repetidas.
  if (newConflicts.length > 0) {
    changed = true;
  }

  if (changed) {
    nextPropertyData.address = nextAddress;
    // Backfill for legacy readers that still expect top-level address fields.
    nextPropertyData.street = nextAddress.street;
    nextPropertyData.exterior_number = nextAddress.exterior_number;
    nextPropertyData.postal_code = nextAddress.postal_code;
    nextContext.address = nextAddress;
    nextContext.street = nextAddress.street;
    nextContext.exterior_number = nextAddress.exterior_number;
    nextContext.postal_code = nextAddress.postal_code;
    // Preserva la unión de conflictos (previos + nuevos) cuando persistimos.
    if (addressConflicts.length > 0) {
      nextPropertyData.address_conflicts = addressConflicts;
    }
  }

  return { context: nextContext, changed, adopted, newConflicts };
}

function remediationAttemptsFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, number> {
  const raw = context?.extraction_remediation_attempts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function predialQualityRemediationAttemptsFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, number> {
  const raw = context?.predial_quality_remediation_attempts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function deterministicDocumentIdsFromBlocks(
  blocks: PropertyAdvanceGateBlock[]
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.remediation.owner !== "deterministic") continue;
    for (const id of block.remediation.document_ids ?? []) ids.add(id);
  }
  return [...ids];
}

function isPropertyOptioningDocumentsReviewPoint(opCase: OperationalCase) {
  return (
    opCase.case_type === "property_optioning" &&
    opCase.current_step === "documents_received" &&
    opCase.status === "waiting_internal"
  );
}

function isPropertyOptioningComparablesReviewPoint(opCase: OperationalCase) {
  return (
    opCase.case_type === "property_optioning" &&
    opCase.current_step === "comparables_in_progress" &&
    (opCase.status === "active" ||
      opCase.status === "waiting_internal" ||
      opCase.status === "paused")
  );
}

function predialImplausibleBlock(gate: ReturnType<typeof evaluatePropertyAdvanceGate>) {
  return gate.blocks.find(
    (block) => block.reason === "predial_area_construida_implausible"
  );
}

type ComparableToolCallRow = {
  id: string;
  tool_name: string;
  status: string;
  arguments_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  created_at: string;
};

function asComparableToolCallRows(rows: unknown[]): ComparableToolCallRow[] {
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      id: String(row.id ?? ""),
      tool_name: String(row.tool_name ?? ""),
      status: String(row.status ?? ""),
      arguments_json: asRecord(row.arguments_json),
      result_json: asRecord(row.result_json),
      created_at: String(row.created_at ?? ""),
    }))
    .filter((row) => row.id.length > 0 && row.tool_name.length > 0);
}

async function listComparableToolCallsForCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string
): Promise<ComparableToolCallRow[]> {
  const [argsResult, metaResult] = await Promise.all([
    db
      .from("tool_calls")
      .select("id,tool_name,status,arguments_json,result_json,created_at")
      .contains("arguments_json", { case_id: caseId })
      .in("tool_name", [
        "easybroker_search_listings",
        "easybroker_search_closed_deals",
        "bigquery_lookup_local_comparables",
        "get_avaclick_valuation",
      ])
      .order("created_at", { ascending: true })
      .limit(100),
    db
      .from("tool_calls")
      .select("id,tool_name,status,arguments_json,result_json,created_at")
      .eq("metadata_jsonb->>case_id", caseId)
      .in("tool_name", [
        "easybroker_search_listings",
        "easybroker_search_closed_deals",
        "bigquery_lookup_local_comparables",
        "get_avaclick_valuation",
      ])
      .order("created_at", { ascending: true })
      .limit(100),
  ]);

  const merged = new Map<string, ComparableToolCallRow>();
  for (const row of asComparableToolCallRows((argsResult.data ?? []) as unknown[])) {
    merged.set(row.id, row);
  }
  for (const row of asComparableToolCallRows((metaResult.data ?? []) as unknown[])) {
    merged.set(row.id, row);
  }

  return [...merged.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
}

function comparablesDecisionText(params: {
  opCase: OperationalCase;
  comparablesAnalysis: Record<string, unknown>;
}): string {
  const formatMxn = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString("es-MX", {
          style: "currency",
          currency: "MXN",
          maximumFractionDigits: 0,
        })
      : null;
  const usableCountIn = (key: "active_listings" | "historical_references" | "internal_inventory") => {
    const rows = params.comparablesAnalysis[key];
    if (!Array.isArray(rows)) return 0;
    return rows.filter(
      (row) =>
        row &&
        typeof row === "object" &&
        (row as Record<string, unknown>).usable_as_comparable === true
    ).length;
  };
  const context = asRecord(params.opCase.context_jsonb) ?? {};
  const propertyTitle =
    (typeof context.property_title === "string" && context.property_title.trim()) ||
    (typeof context.title === "string" && context.title.trim()) ||
    "la propiedad";
  const dataQuality = asRecord(params.comparablesAnalysis.data_quality) ?? {};
  const usableCount =
    typeof dataQuality.usable_count === "number" ? dataQuality.usable_count : 0;
  const activeUsable = usableCountIn("active_listings");
  const historicalUsable = usableCountIn("historical_references");
  const internalUsable = usableCountIn("internal_inventory");
  const warningLines = Array.isArray(dataQuality.warnings)
    ? dataQuality.warnings
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, 3)
    : [];
  const valuation = asRecord(params.comparablesAnalysis.external_valuation) ?? {};
  const saleAverage =
    typeof valuation.sale_average_mxn === "number"
      ? formatMxn(valuation.sale_average_mxn)
      : null;
  const saleMin =
    typeof valuation.sale_min_mxn === "number" ? formatMxn(valuation.sale_min_mxn) : null;
  const saleMax =
    typeof valuation.sale_max_mxn === "number" ? formatMxn(valuation.sale_max_mxn) : null;
  const avaclickPdf =
    typeof valuation.pdf_url === "string" && /^https?:\/\//i.test(valuation.pdf_url)
      ? valuation.pdf_url
      : null;

  return [
    `No encontre comparables usables suficientes en mercado para ${propertyTitle}.`,
    `Comparables usables actuales: ${usableCount}.`,
    "",
    "Lectura por fuente:",
    `- EasyBroker activas/publicadas: ${activeUsable} comparable(s) usable(s).`,
    `- EasyBroker cerradas/historico: ${historicalUsable} comparable(s) usable(s).`,
    `- Ungga / BigQuery: ${internalUsable} comparable(s) usable(s).`,
    saleAverage
      ? `- Avaclick (opinion digital): ${saleMin && saleMax ? `${saleMin}-${saleMax}` : "Rango N/D"}; promedio ~${saleAverage}.`
      : "- Avaclick: sin referencia util en este intento.",
    avaclickPdf ? `- PDF Avaclick: ${avaclickPdf}` : null,
    "",
    warningLines.length > 0 ? "Alertas relevantes:" : null,
    ...warningLines.map((warning) => `- ${warning}`),
    "",
    "Para continuar, elige una opcion dentro del flujo:",
    usableCount > 0
      ? `1) Avanzar con los comparables actuales (muestra limitada: ${usableCount}).`
      : "1) Avanzar con los comparables actuales (no disponible: no hay comparables usables).",
    saleAverage
      ? "2) Avanzar usando Avaclick como base principal."
      : "2) Avanzar usando Avaclick como base principal (no disponible en este momento).",
    "3) Ampliar busqueda (rango amplio o colonias adyacentes).",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

async function applyPropertyOptioningComparablesPostAgentInvariants(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase;
  source: string;
}): Promise<ApplyPropertyOptioningPostAgentInvariantsResult> {
  const { db, source } = params;
  let workingCase = params.opCase;
  const recentEvents = await getRecentOperationalCaseEvents(db, workingCase.id, 40);
  const context = asRecord(workingCase.context_jsonb) ?? {};
  let comparablesAnalysis = asRecord(context.comparables_analysis);
  let remediated = false;

  if (!comparablesAnalysis) {
    const toolCalls = await listComparableToolCallsForCase(db, workingCase.id);
    if (toolCalls.length > 0) {
      const propertyData = asRecord(context.property_data) ?? context;
      const analysis = buildComparablesAnalysisFromToolCalls(
        toolCalls.map((call) => ({
          tool_name: call.tool_name,
          status: call.status,
          arguments_json: call.arguments_json,
          result_json: call.result_json,
          created_at: call.created_at,
        })),
        {
          subject_area_m2: resolveSubjectAreaM2FromPropertyData(propertyData),
        }
      );
      const artifactErrors = validateComparablesAnalysisArtifact(analysis);
      if (artifactErrors.length === 0) {
        const updated = await updateOperationalCase(
          db,
          workingCase.id,
          workingCase.version,
          {
            context: {
              ...(workingCase.context_jsonb ?? {}),
              comparables_analysis: analysis,
            },
          }
        );
        if (updated) {
          workingCase = updated;
          comparablesAnalysis = asRecord(updated.context_jsonb?.comparables_analysis);
          remediated = true;
          await insertOperationalCaseEvent(db, {
            caseId: workingCase.id,
            eventType: "state_changed",
            actor: "system",
            stepKey: workingCase.current_step ?? undefined,
            payload: {
              kind: "comparables_analysis_auto_persisted",
              source,
            },
          });
        }
      }
    }
  }

  if (!comparablesAnalysis) {
    return { case: workingCase, action: remediated ? "remediated_comparables" : "no_action" };
  }

  if (comparablesHasDefensibleSample(comparablesAnalysis)) {
    if (workingCase.current_step === "comparables_in_progress") {
      const advanceResult = await tryAdvanceComparablesAfterPersist({
        db,
        opCase: workingCase,
        userId: workingCase.user_id,
        source,
        notifyUser: notifyUserRespectingActiveInternalChannel,
      });
      if (advanceResult.case) {
        workingCase = advanceResult.case;
      }
      if (advanceResult.advanced) {
        return { case: workingCase, action: "advanced_to_price_proposal" };
      }
      if (advanceResult.skipReason) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "comparables_advance_skipped",
            source,
            reason: advanceResult.skipReason,
          },
        });
      }
    } else if (workingCase.current_step === "price_proposal_pending") {
      const hasPricePreparedEvent = recentEvents.some((event) => {
        const payload = asRecord(event.payload_jsonb);
        return payload?.kind === "price_proposal_prepared";
      });
      const pricingProposal = asRecord(workingCase.context_jsonb?.pricing_proposal);
      if (pricingProposal) {
        const ensureApprovalResult = await tryAdvanceComparablesAfterPersist({
          db,
          opCase: workingCase,
          userId: workingCase.user_id,
          source: `${source}_ensure_price_approval`,
          notifyUser: notifyUserRespectingActiveInternalChannel,
        });
        if (ensureApprovalResult.case) {
          workingCase = ensureApprovalResult.case;
        }
      }
      if (!hasPricePreparedEvent && pricingProposal) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: "price_proposal_pending",
          payload: {
            kind: "price_proposal_prepared",
            source: `${source}_backfill`,
            current_step: "price_proposal_pending",
            pricing_proposal_basis:
              typeof pricingProposal.basis === "string" ? pricingProposal.basis : null,
            subject_area_m2:
              typeof pricingProposal.subject_area_m2 === "number"
                ? pricingProposal.subject_area_m2
                : null,
          },
        });
      }
      return { case: workingCase, action: "advanced_to_price_proposal" };
    }
    return { case: workingCase, action: remediated ? "remediated_comparables" : "no_action" };
  }

  const dataQuality = asRecord(comparablesAnalysis.data_quality) ?? {};
  const searchValidity =
    typeof dataQuality.search_validity === "string"
      ? dataQuality.search_validity
      : "valid";
  if (searchValidity === "invalid_filters") {
    return { case: workingCase, action: remediated ? "remediated_comparables" : "no_action" };
  }

  const alreadyNotified = recentEvents.some((event) => {
    const payload = asRecord(event.payload_jsonb);
    return payload?.kind === "comparables_search_expansion_decision_requested";
  });
  if (alreadyNotified && workingCase.status === "waiting_internal") {
    return { case: workingCase, action: remediated ? "remediated_comparables" : "no_action" };
  }

  const delivery = await deliverInternalCaseFollowUp({
    db,
    userId: workingCase.user_id,
    caseId: workingCase.id,
    text: comparablesDecisionText({ opCase: workingCase, comparablesAnalysis }),
    kind: "comparables_search_expansion_decision",
    data: { source },
  });

  await insertOperationalCaseEvent(db, {
    caseId: workingCase.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: workingCase.current_step ?? undefined,
    payload: {
      kind: "comparables_search_expansion_decision_requested",
      source,
      active_internal_channel: delivery.activeChannel,
      notify_delivered: delivery.notifyDelivered,
      web_chat_mirrored: delivery.webChatMirrored,
    },
  });

  const updated = await advisedInvariantCaseUpdate(db, workingCase, workingCase.version, {
    status: "waiting_internal",
    currentStep: "comparables_in_progress",
    nextActionAt: null,
  });

  return {
    case: updated ?? workingCase,
    action: "requested_comparables_decision",
  };
}

function operationLabel(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) {
    return operationLabel(value[0]);
  }
  if (typeof value !== "string") return "pendiente";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "pendiente";
  if (normalized === "sale" || normalized === "venta") return "Venta";
  if (normalized === "rent" || normalized === "renta") return "Renta";
  return value.trim();
}

/** Labels legibles para slugs de fuente de titularidad / tipo documental. */
const OWNERSHIP_SOURCE_DISPLAY_LABELS: Record<string, string> = {
  boleta_registral: "Boleta registral",
  escritura: "Escritura",
  escritura_descripcion: "Escritura",
  escritura_primera_hoja: "Escritura (primera hoja)",
  escritura_ultima_hoja: "Escritura (última hoja)",
  predial: "Predial",
  documentos_compartidos: "Documentos compartidos",
  ine: "Identificación oficial",
  comprobante_domicilio: "Comprobante de domicilio",
};

/**
 * Convierte slugs técnicos (`boleta_registral`) a copy humano para mensajes
 * de revisión. Si ya viene en lenguaje natural, se deja igual.
 */
export function ownershipSourceDisplayLabel(
  source: string | null | undefined
): string {
  if (typeof source !== "string") return "";
  const trimmed = source.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  if (OWNERSHIP_SOURCE_DISPLAY_LABELS[normalized]) {
    return OWNERSHIP_SOURCE_DISPLAY_LABELS[normalized]!;
  }
  if (!normalized.includes("_")) return trimmed;
  const humanized = normalized.replace(/_/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

export function propertyDataReviewTextFromContext(params: {
  opCase: OperationalCase;
  documentFields: Record<string, unknown>;
}) {
  const context = params.opCase.context_jsonb ?? {};
  const propertyData =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  const merged = { ...context, ...propertyData, ...params.documentFields };
  const value = (key: string) => {
    const raw = merged[key];
    if (Array.isArray(raw)) return raw.filter(Boolean).join("; ");
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      return String(record.full ?? record.formatted ?? record.street ?? "").trim();
    }
    return raw == null ? "" : String(raw).trim();
  };
  const parkingSpaces = resolveParkingSpacesForDisplay(merged);
  const additionalProvided = [
    ["Número de plantas o pisos", value("floors")],
    ["Número de recámaras", value("bedrooms")],
    ["Número de baños completos", value("bathrooms")],
    ["Número de medios baños", value("half_bathrooms")],
    [
      "Número de cajones de estacionamiento",
      parkingSpaces != null ? String(parkingSpaces) : "",
    ],
    [
      "Cocina integral",
      typeof merged.integral_kitchen === "boolean"
        ? merged.integral_kitchen
          ? "Sí"
          : "No"
        : "",
    ],
  ]
    .filter(([, provided]) => provided !== "" && provided != null)
    .map(([label, provided]) => `- ${label}: ${String(provided).trim()}`);
  return [
    `Revisión de datos extraídos para el caso ${params.opCase.id}:`,
    "",
    "Datos iniciales confirmados:",
    `- Título / propiedad: ${String(context.property_title ?? context.title ?? "pendiente")}`,
    `- Zona / colonia: ${String(context.property_zone ?? "pendiente")}`,
    `- Operación: ${operationLabel(context.operation_type)}`,
    `- Tipo de propiedad: ${String(context.property_type ?? "pendiente")}`,
    "",
    "Datos encontrados en documentos:",
    `- Dueño/titular: ${value("owner_names") || "pendiente"}`,
    value("owner_names_source")
      ? `- Fuente de titularidad: ${ownershipSourceDisplayLabel(
          value("owner_names_source")
        )}`
      : null,
    value("owner_consistency_note")
      ? `- Verificación de titularidad: ${value("owner_consistency_note")}`
      : null,
    value("owner_consistency_warning")
      ? `- Advertencia de titularidad: ${value("owner_consistency_warning")}`
      : null,
    `- Dirección legal: ${
      value("legal_addresses") ||
      value("legal_address") ||
      value("property_address") ||
      value("address") ||
      "pendiente"
    }`,
    `- Superficie terreno: ${value("area_total_m2") || "pendiente"} m²`,
    `- Superficie construcción: ${value("area_construida_m2") || "pendiente"} m²`,
    value("land_context")
      ? `- Contexto del terreno: ${value("land_context")}`
      : null,
    "",
    "Datos adicionales provistos:",
    ...(additionalProvided.length > 0
      ? additionalProvided
      : ["- Sin datos adicionales confirmados aún."]),
    "",
    "Faltantes o dudas:",
    "- Ninguno mínimo detectado.",
    "",
    "Confirma si es correcto o indícame correcciones puntuales.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function applyPropertyOptioningPostAgentInvariants(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase | null;
  source: string;
}): Promise<ApplyPropertyOptioningPostAgentInvariantsResult> {
  const { db, opCase, source } = params;
  if (!opCase) return { case: null, action: "not_applicable" };

  if (
    opCase.case_type === "property_optioning" &&
    opCase.current_step === "contract_pending"
  ) {
    try {
      const ask = await ensureContractCommercialDataAsk({
        db,
        opCase,
        source,
      });
      if (ask.asked) {
        return {
          case: ask.case,
          action: "requested_contract_data_review",
        };
      }
      return { case: ask.case, action: "no_action" };
    } catch (askError) {
      console.warn(
        "[post-agent-invariants] ensure contract commercial ask failed:",
        askError
      );
      return { case: opCase, action: "no_action" };
    }
  }

  if (isPropertyOptioningComparablesReviewPoint(opCase)) {
    return applyPropertyOptioningComparablesPostAgentInvariants({
      db,
      opCase,
      source,
    });
  }

  if (!isPropertyOptioningDocumentsReviewPoint(opCase)) {
    return { case: opCase, action: "not_applicable" };
  }

  let workingCase: OperationalCase = opCase;
  let workingDocuments = await listOperationalCaseDocuments(db, {
    caseId: workingCase.id,
    statuses: ["received"],
  });
  const recentEvents = await getRecentOperationalCaseEvents(db, workingCase.id, 30);
  const consolidateDocumentContext = async () => {
    const documentFields = documentExtractionMinimumsContext(workingDocuments);
    const mergedSurfaces = mergeDocumentSurfacesIntoContextPropertyData({
      context: workingCase.context_jsonb,
      documentFields,
    });
    const mergedAddress = mergeDocumentAddressIntoContextPropertyData({
      context: mergedSurfaces.context,
      documentFields,
    });
    const mergedLegalIdentity = mergeDocumentLegalIdentityIntoContextPropertyData({
      context: mergedAddress.context,
      documentFields,
    });
    if (
      mergedSurfaces.changed ||
      mergedAddress.changed ||
      mergedLegalIdentity.changed
    ) {
      const mergedContext = mergedLegalIdentity.context;
      const persisted = await updateOperationalCase(
        db,
        workingCase.id,
        workingCase.version,
        { context: mergedContext }
      );
      workingCase = persisted ?? { ...workingCase, context_jsonb: mergedContext };
      if (mergedSurfaces.changed) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "document_surfaces_consolidated_to_property_data",
            source,
            adopted: mergedSurfaces.adopted,
          },
        });
      }
      // Evento de consolidación SOLO si se adoptó un campo de dirección visible.
      // Evita "Dirección consolidada" genérico cuando el único delta fue metadata
      // (source) o un conflicto sin adopción de calle/número.
      if (mergedAddress.changed && addressAdoptedHasVisibleField(mergedAddress.adopted)) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "document_address_consolidated_to_property_data",
            source,
            adopted: mergedAddress.adopted,
          },
        });
      }
      // Evento dedicado para conflictos NUEVOS de dirección: hace visible la
      // discrepancia real (calle/número entre fuentes) sin reusar el label de
      // consolidación. No se emite para conflictos ya registrados (idempotente).
      if (mergedAddress.newConflicts.length > 0) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "document_address_conflict_detected",
            source,
            conflicts: mergedAddress.newConflicts,
          },
        });
      }
      if (mergedLegalIdentity.changed) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "document_legal_identity_consolidated_to_property_data",
            source,
            adopted: mergedLegalIdentity.adopted,
          },
        });
      }
    }
    return documentFields;
  };

  // Fuente única de verdad: gate de avance a comparables (WS1/WS2). La
  // corroboración de titularidad NO bloquea aquí; es gate de contract_pending.
  let documentFields = await consolidateDocumentContext();
  let gate = evaluatePropertyAdvanceGate({
    documents: workingDocuments,
    context: workingCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  let implausibleBlock = predialImplausibleBlock(gate);
  if (implausibleBlock) {
    const implausibleDocumentId = implausibleBlock.remediation.document_ids?.[0] ?? null;
    const qualityAttempts = predialQualityRemediationAttemptsFromContext(
      workingCase.context_jsonb
    );
    const attemptsUsed = implausibleDocumentId ? qualityAttempts[implausibleDocumentId] ?? 0 : 0;
    const canRetryQuality =
      implausibleDocumentId != null &&
      attemptsUsed < MAX_PREDIAL_QUALITY_REMEDIATION_ATTEMPTS;
    if (canRetryQuality && implausibleDocumentId) {
      qualityAttempts[implausibleDocumentId] = attemptsUsed + 1;
      try {
        await runDocumentFieldExtraction(db, {
          userId: workingCase.user_id,
          documentId: implausibleDocumentId,
          force: true,
        });
      } catch {
        // El fallo cuenta como intento para evitar bucle indefinido.
      }
      const persisted = await updateOperationalCase(
        db,
        workingCase.id,
        workingCase.version,
        {
          context: {
            ...(workingCase.context_jsonb ?? {}),
            predial_quality_remediation_attempts: qualityAttempts,
          },
        }
      );
      workingCase = persisted ?? workingCase;
      workingDocuments = await listOperationalCaseDocuments(db, {
        caseId: workingCase.id,
        statuses: ["received"],
      });
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: workingCase.current_step ?? undefined,
        payload: {
          kind: "predial_area_quality_remediation_attempted",
          source,
          document_id: implausibleDocumentId,
          attempts_used: qualityAttempts[implausibleDocumentId],
          max_attempts: MAX_PREDIAL_QUALITY_REMEDIATION_ATTEMPTS,
        },
      });
      documentFields = await consolidateDocumentContext();
      gate = evaluatePropertyAdvanceGate({
        documents: workingDocuments,
        context: workingCase.context_jsonb,
        targetTransition: "comparables_in_progress",
      });
      implausibleBlock = predialImplausibleBlock(gate);
    }
    if (implausibleBlock) {
      const alreadyRequested = recentEvents.some((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          event.event_type === "human_decision" &&
          payload?.kind === "predial_area_quality_review_requested"
        );
      });
      if (!alreadyRequested) {
        const observed = implausibleBlock.remediation.observed_value_m2;
        const suggested = implausibleBlock.remediation.suggested_value_m2;
        const qualityText = [
          "Detecte una posible inconsistencia en la superficie construida del predial.",
          observed != null
            ? `Valor leido: ${observed} m².`
            : "No pude confirmar el valor leido en m².",
          suggested != null
            ? `Posible correccion sugerida: ${suggested} m².`
            : null,
          "Confirma el dato correcto para continuar a comparables.",
        ]
          .filter((line): line is string => line != null)
          .join("\n");
        const delivery = await deliverInternalCaseFollowUp({
          db,
          userId: workingCase.user_id,
          caseId: workingCase.id,
          text: qualityText,
          kind: "property_data_quality_review",
          data: {
            source,
            observed_value_m2: observed ?? null,
            suggested_value_m2: suggested ?? null,
          },
          urgency: "high",
        });
        const notifyResult = {
          delivered: delivery.notifyDelivered,
          activeChannel: delivery.activeChannel,
          webChatMirrored: delivery.webChatMirrored,
        };
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "human_decision",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "predial_area_quality_review_requested",
            source,
            notify_delivered: notifyResult.delivered,
            observed_value_m2: observed ?? null,
            suggested_value_m2: suggested ?? null,
          },
        });
      }
      const updated = await advisedInvariantCaseUpdate(db, workingCase, workingCase.version, {
        status: "waiting_internal",
        currentStep: "documents_received",
        nextActionAt: null,
      });
      return {
        case: updated ?? workingCase,
        action: "requested_property_data_quality_review",
      };
    }
  }
  let deterministicIds = deterministicDocumentIdsFromBlocks(gate.blocks);

  // --- Auto-remediación determinística + circuit breaker (WS3) ------------
  // El bloqueo por extracción ya no es terminal: el código intenta extraer él
  // mismo (texto PDF + Vision) los documentos pendientes que aún tengan
  // presupuesto, re-evalúa una vez, y solo escala a humano tras agotar N
  // intentos. Nunca deja el caso en limbo silencioso.
  if (deterministicIds.length > 0) {
    const attempts = remediationAttemptsFromContext(workingCase.context_jsonb);
    const remediable = deterministicIds.filter(
      (id) => (attempts[id] ?? 0) < MAX_EXTRACTION_REMEDIATION_ATTEMPTS
    );
    if (remediable.length > 0) {
      for (const documentId of remediable) {
        attempts[documentId] = (attempts[documentId] ?? 0) + 1;
        try {
          await runDocumentFieldExtraction(db, {
            userId: workingCase.user_id,
            documentId,
            force: true,
          });
        } catch {
          // El fallo cuenta como intento; el breaker escalará si persiste.
        }
      }
      const persisted = await updateOperationalCase(
        db,
        workingCase.id,
        workingCase.version,
        {
          context: {
            ...(workingCase.context_jsonb ?? {}),
            extraction_remediation_attempts: attempts,
          },
        }
      );
      workingCase = persisted ?? workingCase;
      workingDocuments = await listOperationalCaseDocuments(db, {
        caseId: workingCase.id,
        statuses: ["received"],
      });
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: workingCase.current_step ?? undefined,
        payload: {
          kind: "extraction_auto_remediation_attempted",
          source,
          document_ids: remediable,
          attempts,
        },
      });
      gate = evaluatePropertyAdvanceGate({
        documents: workingDocuments,
        context: workingCase.context_jsonb,
        targetTransition: "comparables_in_progress",
      });
      deterministicIds = deterministicDocumentIdsFromBlocks(gate.blocks);
    }

    if (deterministicIds.length > 0) {
      const attemptsNow = remediationAttemptsFromContext(workingCase.context_jsonb);
      const allExhausted = deterministicIds.every(
        (id) => (attemptsNow[id] ?? 0) >= MAX_EXTRACTION_REMEDIATION_ATTEMPTS
      );
      if (allExhausted) {
        const alreadyEscalated = recentEvents.some((event) => {
          const payload = event.payload_jsonb as Record<string, unknown> | null;
          return (
            event.event_type === "escalated" &&
            payload?.kind === "extraction_escalated_to_human"
          );
        });
        if (!alreadyEscalated) {
          const escalationText = [
            "No pude leer automáticamente algunos documentos del caso tras varios intentos.",
            "",
            `Caso: ${String(
              workingCase.context_jsonb?.property_title ??
                workingCase.context_jsonb?.title ??
                workingCase.case_type
            )}`,
            "Revisa los documentos en el caso y, si están ilegibles, pide al dueño que los reenvíe con mejor calidad.",
          ].join("\n");
          const delivery = await deliverInternalCaseFollowUp({
            db,
            userId: workingCase.user_id,
            caseId: workingCase.id,
            text: escalationText,
            kind: "document_extraction_failed",
            data: {
              title: "No pude leer documentos del caso",
              source,
              exhausted_document_ids: deterministicIds,
            },
            urgency: "high",
          });
          const notifyResult = {
            delivered: delivery.notifyDelivered,
            activeChannel: delivery.activeChannel,
            webChatMirrored: delivery.webChatMirrored,
          };
          await insertOperationalCaseEvent(db, {
            caseId: workingCase.id,
            eventType: "escalated",
            actor: "system",
            stepKey: workingCase.current_step ?? undefined,
            payload: {
              kind: "extraction_escalated_to_human",
              source,
              document_ids: deterministicIds,
              max_attempts: MAX_EXTRACTION_REMEDIATION_ATTEMPTS,
              notify_delivered: notifyResult.delivered,
            },
          });
        }
        const escalated = await advisedInvariantCaseUpdate(
          db,
          workingCase,
          workingCase.version,
          {
            status: "waiting_internal",
            currentStep: "documents_received",
            nextActionAt: null,
          }
        );
        return {
          case: escalated ?? workingCase,
          action: "escalated_extraction_to_human",
        };
      }

      // Aún con presupuesto: diferir y reintentar en el próximo tick. No es
      // terminal-silencioso porque el cron (caso real) reprograma el tick y el
      // laboratorio expone el reintento manual con el contador de intentos.
      const blockReason = gate.blocks[0]?.reason ?? "extraction_pending";
      const alreadyDeferred = recentEvents.some((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          event.event_type === "state_changed" &&
          payload?.kind === "property_data_review_deferred_pending_extraction" &&
          payload?.reason === blockReason
        );
      });
      if (!alreadyDeferred) {
        await insertOperationalCaseEvent(db, {
          caseId: workingCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: workingCase.current_step ?? undefined,
          payload: {
            kind: "property_data_review_deferred_pending_extraction",
            source,
            reason: blockReason,
            pending_document_ids: deterministicIds,
          },
        });
      }
      return { case: workingCase, action: "deferred_pending_extraction" };
    }
  }

  // Recalcular tras la posible remediación determinística.
  documentFields = await consolidateDocumentContext();
  const minimums = evaluatePropertyDataMinimumsForReview(
    workingCase.context_jsonb,
    documentFields
  );

  if (!minimums.ok) {
    const requestTarget = operationalCaseDocumentRequestTargetFromContext(
      workingCase.context_jsonb
    );
    const asksPurpose =
      requestTarget === "internal_user"
        ? "characteristics_pending_internal"
        : "characteristics_pending";
    const characteristicsAsks = recentEvents.filter((event) => {
      const payload = event.payload_jsonb;
      return (
        event.event_type === "reminder_sent" &&
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).purpose === asksPurpose
      );
    });
    const lastAskAt =
      characteristicsAsks.length > 0
        ? characteristicsAsks[characteristicsAsks.length - 1].created_at ?? null
        : null;

    // A fresh owner reply after the last ask means we must respond, not stay
    // silent: re-ask only the fields that are still missing. Without a new
    // reply we keep waiting (avoids re-asking on every cron tick).
    const ownerRepliedSinceLastAsk =
      lastAskAt != null &&
      recentEvents.some((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        const isOwnerReply =
          event.event_type === "external_response" ||
          (event.event_type === "state_changed" &&
            payload?.kind === "owner_characteristics_merged");
        return (
          isOwnerReply &&
          typeof event.created_at === "string" &&
          event.created_at > lastAskAt
        );
      });

    if (lastAskAt != null && !ownerRepliedSinceLastAsk) {
      return { case: workingCase, action: "no_action" };
    }

    const isReAsk = lastAskAt != null && ownerRepliedSinceLastAsk;

    const text = buildPropertyDataMinimumsSummaryMessage({
      context: workingCase.context_jsonb,
      supplement: documentFields,
      missing: minimums.missing,
    });
    if (requestTarget === "internal_user") {
      const delivery = await deliverInternalCaseFollowUp({
        db,
        userId: workingCase.user_id,
        caseId: workingCase.id,
        text,
        kind: "property_data_minimums_missing",
        data: {
          source,
          missing: minimums.missing,
          property_type: minimums.propertyType,
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "reminder_sent",
        actor: "system",
        stepKey: workingCase.current_step ?? undefined,
        payload: {
          source,
          channel: "notify_user",
          purpose: "characteristics_pending_internal",
          audience: "internal_user",
          active_internal_channel: delivery.activeChannel,
          notify_delivered: delivery.notifyDelivered,
          web_chat_mirrored: delivery.webChatMirrored,
          reask: isReAsk,
          missing: minimums.missing,
          document_fields_used: documentFields,
          text_preview: text.slice(0, 200),
        },
      });
      const updated = await advisedInvariantCaseUpdate(
        db,
        workingCase,
        workingCase.version,
        {
          status: "waiting_internal",
          currentStep: "documents_received",
          nextActionAt: null,
        }
      );
      return {
        case: updated ?? workingCase,
        action: isReAsk
          ? "asked_missing_characteristics_again_internal"
          : "asked_missing_characteristics_internal",
      };
    }

    const chatId =
      workingCase.external_contact_jsonb?.channel === "telegram" &&
      typeof workingCase.external_contact_jsonb.chat_id === "number"
        ? workingCase.external_contact_jsonb.chat_id
        : null;
    if (!chatId) {
      await insertOperationalCaseEvent(db, {
        caseId: workingCase.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: workingCase.current_step ?? undefined,
        payload: {
          kind: "property_data_minimums_missing",
          source,
          property_type: minimums.propertyType,
          missing: minimums.missing,
          document_fields_used: documentFields,
          reason: "no_telegram_external_contact",
        },
      });
      return { case: workingCase, action: "no_action" };
    }

    await sendTelegramMessage(chatId, text);
    await insertOperationalCaseEvent(db, {
      caseId: workingCase.id,
      eventType: "reminder_sent",
      actor: "system",
      stepKey: workingCase.current_step ?? undefined,
      payload: {
        source,
        channel: "telegram",
        chat_id: chatId,
        purpose: "characteristics_pending",
        reask: isReAsk,
        missing: minimums.missing,
        document_fields_used: documentFields,
        text_preview: text.slice(0, 200),
      },
    });
    const updated = await advisedInvariantCaseUpdate(db, workingCase, workingCase.version, {
      status: "waiting_external",
      currentStep: "documents_received",
      nextActionAt: null,
    });
    return {
      case: updated ?? workingCase,
      action: isReAsk
        ? "asked_missing_characteristics_again"
        : "asked_missing_characteristics",
    };
  }

  const alreadyRequested = recentEvents.some((event) => {
    const payload = event.payload_jsonb;
    return (
      payload &&
      typeof payload === "object" &&
      ((payload as Record<string, unknown>).kind === "property_data_review_requested" ||
        (payload as Record<string, unknown>).kind === "property_data_review")
    );
  });
  if (alreadyRequested) return { case: workingCase, action: "no_action" };

  const reviewText = propertyDataReviewTextFromContext({
    opCase: workingCase,
    documentFields,
  });
  const delivery = await deliverInternalCaseFollowUp({
    db,
    userId: workingCase.user_id,
    caseId: workingCase.id,
    text: reviewText,
    kind: "property_data_review",
    data: {
      title: "Revisión de datos de propiedad",
      source,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: workingCase.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: workingCase.current_step ?? undefined,
    payload: {
      kind: "property_data_review_requested",
      source,
      active_internal_channel: delivery.activeChannel,
      notify_delivered: delivery.notifyDelivered,
      web_chat_mirrored: delivery.webChatMirrored,
      document_fields_used: documentFields,
    },
  });
  const updated = await advisedInvariantCaseUpdate(db, workingCase, workingCase.version, {
    status: "waiting_internal",
    currentStep: "property_data_review",
    nextActionAt: null,
  });
  return {
    case: updated ?? workingCase,
    action: "requested_property_data_review",
  };
}

