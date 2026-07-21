/**
 * Modelo canónico y neutral de condiciones comerciales del contrato.
 * Independiente de EasyBroker/Ungga; los adapters mapean al borde.
 */

export type CollaborationCompensationMode =
  | "not_specified"
  | "percentage_of_total_commission"
  | "percentage_of_sale_price"
  | "fixed_amount"
  | "negotiable";

export type CollaborationCompensation = {
  mode: CollaborationCompensationMode;
  value: number | null;
  currency: string | null;
};

export type CollaborationTerms = {
  enabled: boolean | null;
  compensation: CollaborationCompensation;
  notes: string | null;
};

export type CommissionTermsConfirmation = {
  status: "pending" | "confirmed";
  confirmed_at: string | null;
  confirmed_by: string | null;
};

export type CommissionTerms = {
  commission_pct: number | null;
  exclusive: boolean | null;
  duration_months: number | null;
  collaboration: CollaborationTerms;
  confirmation: CommissionTermsConfirmation;
};

export type ContractCommercialMissingField = {
  key: string;
  label: string;
  question: string;
  kind: "email" | "boolean" | "number" | "text" | "choice";
  optional?: boolean;
  choices?: Array<{ value: string; label: string }>;
};

export type ContractCommercialMinimumsResult = {
  ok: boolean;
  terms: CommissionTerms;
  owner_email: string | null;
  known: Array<{ key: string; label: string; value: string }>;
  missing: ContractCommercialMissingField[];
};

export type ContractCommercialPatch = {
  owner_email?: string;
  commission_pct?: number | null;
  exclusive?: boolean | null;
  duration_months?: number | null;
  collaboration_enabled?: boolean | null;
  compensation_mode?: CollaborationCompensationMode | null;
  compensation_value?: number | null;
  compensation_currency?: string | null;
  collaboration_notes?: string | null;
  confirm?: boolean;
  confirmed_by?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeEmailCandidate(value: string): string {
  return value.trim().replace(/[.,;:!?)\]}>]+$/g, "");
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailCandidate(value));
}

const SPANISH_INTEGER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

const SPANISH_INTEGER_TOKEN =
  "\\d+(?:[.,]\\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce";

function numberTokenOrNull(
  value: string | undefined,
  options?: { allowZero?: boolean }
): number | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (normalized in SPANISH_INTEGER_WORDS) {
    return SPANISH_INTEGER_WORDS[normalized];
  }
  return numberOrNull(value, options);
}

export const COLLABORATION_COMPENSATION_MODE_LABELS: Record<
  CollaborationCompensationMode,
  string
> = {
  percentage_of_total_commission: "Porcentaje de la comisión total",
  percentage_of_sale_price: "Porcentaje del precio de venta/renta",
  fixed_amount: "Monto fijo",
  negotiable: "A convenir",
  not_specified: "No especificado",
};

export function formatCollaborationCompensationMode(
  mode: CollaborationCompensationMode
): string {
  return COLLABORATION_COMPENSATION_MODE_LABELS[mode] ?? mode;
}

export function collaborationCompensationModeChoices(): Array<{
  value: CollaborationCompensationMode;
  label: string;
}> {
  return [
    {
      value: "percentage_of_total_commission",
      label: COLLABORATION_COMPENSATION_MODE_LABELS.percentage_of_total_commission,
    },
    {
      value: "percentage_of_sale_price",
      label: COLLABORATION_COMPENSATION_MODE_LABELS.percentage_of_sale_price,
    },
    {
      value: "fixed_amount",
      label: COLLABORATION_COMPENSATION_MODE_LABELS.fixed_amount,
    },
    {
      value: "negotiable",
      label: COLLABORATION_COMPENSATION_MODE_LABELS.negotiable,
    },
    {
      value: "not_specified",
      label: "No especificar por ahora",
    },
  ];
}

function numberOrNull(value: unknown, options?: { allowZero?: boolean }): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!options?.allowZero && value <= 0) return null;
    if (options?.allowZero && value < 0) return null;
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (!Number.isFinite(parsed)) return null;
    if (!options?.allowZero && parsed <= 0) return null;
    if (options?.allowZero && parsed < 0) return null;
    return parsed;
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    if (["si", "sí", "true", "1", "yes"].includes(normalized)) return true;
    if (["no", "false", "0"].includes(normalized)) return false;
  }
  return null;
}

function compensationModeOrNull(value: unknown): CollaborationCompensationMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === "not_specified" ||
    normalized === "percentage_of_total_commission" ||
    normalized === "percentage_of_sale_price" ||
    normalized === "fixed_amount" ||
    normalized === "negotiable"
  ) {
    return normalized;
  }
  return null;
}

export function emptyCollaborationTerms(): CollaborationTerms {
  return {
    enabled: null,
    compensation: {
      mode: "not_specified",
      value: null,
      currency: null,
    },
    notes: null,
  };
}

export function emptyCommissionTerms(): CommissionTerms {
  return {
    commission_pct: null,
    exclusive: null,
    duration_months: null,
    collaboration: emptyCollaborationTerms(),
    confirmation: {
      status: "pending",
      confirmed_at: null,
      confirmed_by: null,
    },
  };
}

export function parseCommissionTerms(value: unknown): CommissionTerms {
  const base = emptyCommissionTerms();
  if (!isRecord(value)) return base;

  const collaborationRaw = isRecord(value.collaboration)
    ? value.collaboration
    : {};
  const compensationRaw = isRecord(collaborationRaw.compensation)
    ? collaborationRaw.compensation
    : {};
  const confirmationRaw = isRecord(value.confirmation) ? value.confirmation : {};

  const enabled =
    booleanOrNull(collaborationRaw.enabled) ??
    booleanOrNull(value.share_commission);

  let compensation: CollaborationCompensation = {
    mode:
      compensationModeOrNull(compensationRaw.mode) ??
      (enabled === true ? "not_specified" : "not_specified"),
    value: numberOrNull(compensationRaw.value, { allowZero: true }),
    currency: cleanString(compensationRaw.currency),
  };

  // Legacy flat fields
  const legacyPct = numberOrNull(
    value.shared_commission_percentage ?? collaborationRaw.shared_percentage,
    { allowZero: true }
  );
  if (legacyPct != null && compensation.value == null) {
    compensation = {
      mode: "percentage_of_total_commission",
      value: legacyPct,
      currency: null,
    };
  }
  const legacyNotes = cleanString(
    value.collaboration_notes ?? collaborationRaw.notes
  );

  const terms: CommissionTerms = {
    commission_pct: numberOrNull(
      value.commission_pct ?? value.commission_percent ?? value.pct
    ),
    exclusive: booleanOrNull(value.exclusive),
    duration_months: numberOrNull(
      value.duration_months ?? value.months,
      { allowZero: false }
    ),
    collaboration: {
      enabled,
      compensation:
        enabled === false
          ? { mode: "not_specified", value: null, currency: null }
          : compensation,
      notes: enabled === false ? null : legacyNotes,
    },
    confirmation: {
      status:
        confirmationRaw.status === "confirmed" ? "confirmed" : "pending",
      confirmed_at: cleanString(confirmationRaw.confirmed_at),
      confirmed_by: cleanString(confirmationRaw.confirmed_by),
    },
  };
  return terms;
}

export function applyCommissionTermsPatch(
  current: CommissionTerms,
  patch: ContractCommercialPatch
): CommissionTerms {
  let next: CommissionTerms = {
    ...current,
    collaboration: {
      ...current.collaboration,
      compensation: { ...current.collaboration.compensation },
    },
    confirmation: { ...current.confirmation },
  };

  if ("commission_pct" in patch) {
    next.commission_pct =
      patch.commission_pct === null
        ? null
        : numberOrNull(patch.commission_pct);
  }
  if ("exclusive" in patch) {
    next.exclusive =
      patch.exclusive === null ? null : booleanOrNull(patch.exclusive);
  }
  if ("duration_months" in patch) {
    next.duration_months =
      patch.duration_months === null
        ? null
        : numberOrNull(patch.duration_months);
  }

  if ("collaboration_enabled" in patch) {
    const enabled =
      patch.collaboration_enabled === null
        ? null
        : booleanOrNull(patch.collaboration_enabled);
    next.collaboration.enabled = enabled;
    if (enabled === false) {
      next.collaboration.compensation = {
        mode: "not_specified",
        value: null,
        currency: null,
      };
      next.collaboration.notes = null;
    } else if (enabled === true) {
      if (next.collaboration.compensation.mode == null) {
        next.collaboration.compensation.mode = "not_specified";
      }
    }
  }

  if (
    next.collaboration.enabled === true &&
    "compensation_mode" in patch &&
    patch.compensation_mode != null
  ) {
    const mode = compensationModeOrNull(patch.compensation_mode);
    if (mode) {
      next.collaboration.compensation.mode = mode;
      if (
        mode === "not_specified" ||
        mode === "negotiable"
      ) {
        next.collaboration.compensation.value = null;
        if (mode === "not_specified") {
          next.collaboration.compensation.currency = null;
        }
      }
    }
  }

  if (
    next.collaboration.enabled === true &&
    "compensation_value" in patch
  ) {
    next.collaboration.compensation.value =
      patch.compensation_value === null
        ? null
        : numberOrNull(patch.compensation_value, { allowZero: true });
  }

  if (
    next.collaboration.enabled === true &&
    "compensation_currency" in patch
  ) {
    next.collaboration.compensation.currency =
      patch.compensation_currency === null
        ? null
        : cleanString(patch.compensation_currency);
  }

  if (
    next.collaboration.enabled === true &&
    "collaboration_notes" in patch
  ) {
    next.collaboration.notes =
      patch.collaboration_notes === null
        ? null
        : cleanString(patch.collaboration_notes);
  }

  if (patch.confirm === true) {
    next.confirmation = {
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmed_by: cleanString(patch.confirmed_by),
    };
  }

  return next;
}

export function resolveOwnerEmailFromSources(params: {
  context?: Record<string, unknown> | null;
  propertyData?: Record<string, unknown> | null;
  externalContact?: Record<string, unknown> | null;
}): string | null {
  const context = params.context ?? {};
  const propertyData = params.propertyData ?? {};
  const contact = params.externalContact ?? {};
  const candidates = [
    cleanString(context.owner_email),
    cleanString(propertyData.owner_email),
    cleanString(propertyData.email),
    cleanString(context.email),
    cleanString(contact.email),
  ];
  for (const candidate of candidates) {
    if (candidate && looksLikeEmail(candidate)) {
      return normalizeEmailCandidate(candidate);
    }
  }
  return null;
}

function formatKnownValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (compensationModeOrNull(value)) {
      return formatCollaborationCompensationMode(
        value as CollaborationCompensationMode
      );
    }
    return value;
  }
  return String(value ?? "");
}

function formatSharedCompensationKnownValue(terms: CommissionTerms): string {
  const mode = terms.collaboration.compensation.mode;
  const value = terms.collaboration.compensation.value;
  const currency = terms.collaboration.compensation.currency;
  const modeLabel = formatCollaborationCompensationMode(mode);
  if (value == null) return modeLabel;
  if (mode === "fixed_amount") {
    return currency
      ? `${currency} ${value} (${modeLabel})`
      : `${value} (${modeLabel})`;
  }
  if (
    mode === "percentage_of_total_commission" ||
    mode === "percentage_of_sale_price"
  ) {
    return `${value}% (${modeLabel})`;
  }
  return modeLabel;
}

/**
 * Evaluador dinámico: solo reporta faltantes reales.
 * Detalles de compensación son opcionales cuando enabled=true.
 */
export function evaluateContractCommercialMinimums(params: {
  context?: Record<string, unknown> | null;
  propertyData?: Record<string, unknown> | null;
  externalContact?: Record<string, unknown> | null;
  accountDefaults?: Partial<CommissionTerms> | null;
  requireConfirmation?: boolean;
}): ContractCommercialMinimumsResult {
  const context = params.context ?? {};
  const propertyData =
    params.propertyData ??
    (isRecord(context.property_data) ? context.property_data : {});
  const externalContact = params.externalContact ?? {};

  let terms = parseCommissionTerms(context.commission_terms);
  const defaults = params.accountDefaults
    ? parseCommissionTerms(params.accountDefaults)
    : null;

  // Defaults fill only nulls; never invent user confirmation.
  if (defaults) {
    if (terms.commission_pct == null && defaults.commission_pct != null) {
      terms = { ...terms, commission_pct: defaults.commission_pct };
    }
    if (terms.exclusive == null && defaults.exclusive != null) {
      terms = { ...terms, exclusive: defaults.exclusive };
    }
    if (terms.duration_months == null && defaults.duration_months != null) {
      terms = { ...terms, duration_months: defaults.duration_months };
    }
    if (
      terms.collaboration.enabled == null &&
      defaults.collaboration.enabled != null
    ) {
      terms = applyCommissionTermsPatch(terms, {
        collaboration_enabled: defaults.collaboration.enabled,
      });
    }
  }

  const ownerEmail = resolveOwnerEmailFromSources({
    context,
    propertyData,
    externalContact,
  });

  const known: ContractCommercialMinimumsResult["known"] = [];
  const missing: ContractCommercialMissingField[] = [];

  if (ownerEmail) {
    known.push({
      key: "owner_email",
      label: "Correo del propietario",
      value: ownerEmail,
    });
  } else {
    missing.push({
      key: "owner_email",
      label: "Correo del propietario",
      question:
        "Correo electrónico del propietario/contacto del inmueble.",
      kind: "email",
    });
  }

  if (terms.duration_months == null) {
    missing.push({
      key: "duration_months",
      label: "Duración del encargo",
      question: "Duración del encargo (en meses).",
      kind: "number",
    });
  } else {
    known.push({
      key: "duration_months",
      label: "Duración del encargo",
      value: `${terms.duration_months} meses`,
    });
  }

  if (terms.exclusive == null) {
    missing.push({
      key: "exclusive",
      label: "Exclusividad",
      question:
        "Indica si la captación es con exclusiva o sin exclusiva.",
      kind: "boolean",
    });
  } else {
    known.push({
      key: "exclusive",
      label: "Exclusividad",
      value: formatKnownValue(terms.exclusive),
    });
  }

  if (terms.commission_pct == null) {
    missing.push({
      key: "commission_pct",
      label: "Comisión cobrada al propietario",
      question:
        "¿Cuál es la comisión pactada con el propietario del inmueble? (Porcentaje del precio, p. ej. 4% o 5%).",
      kind: "number",
    });
  } else {
    known.push({
      key: "commission_pct",
      label: "Comisión cobrada al propietario",
      value: `${terms.commission_pct}%`,
    });
  }

  if (terms.collaboration.enabled == null) {
    missing.push({
      key: "collaboration_enabled",
      label: "Compartir comisión",
      question:
        "Indica si la comisión se compartirá o no con otro asesor o inmobiliaria. Si sí, opcionalmente cuánto del total (p. ej. 50%).",
      kind: "boolean",
    });
  } else {
    known.push({
      key: "collaboration_enabled",
      label: "Compartir comisión",
      value: formatKnownValue(terms.collaboration.enabled),
    });
  }

  // Optional compensation detail — only offered when enabled=true and still not_specified.
  // Never blocks ok; presented as optional choice if caller wants progressive capture.
  if (
    terms.collaboration.enabled === true &&
    terms.collaboration.compensation.mode === "not_specified"
  ) {
    missing.push({
      key: "compensation_mode",
      label: "Detalle de comisión compartida",
      question:
        "Si se comparte, opcionalmente ¿cuánto del total de la comisión? (p. ej. 50%).",
      kind: "choice",
      optional: true,
      choices: collaborationCompensationModeChoices(),
    });
  } else if (
    terms.collaboration.enabled === true &&
    terms.collaboration.compensation.mode !== "not_specified"
  ) {
    known.push({
      key: "compensation_detail",
      label: "Comisión compartida",
      value: formatSharedCompensationKnownValue(terms),
    });
    if (
      (terms.collaboration.compensation.mode ===
        "percentage_of_total_commission" ||
        terms.collaboration.compensation.mode === "percentage_of_sale_price" ||
        terms.collaboration.compensation.mode === "fixed_amount") &&
      terms.collaboration.compensation.value == null
    ) {
      missing.push({
        key: "compensation_value",
        label: "Valor de comisión compartida",
        question:
          terms.collaboration.compensation.mode === "fixed_amount"
            ? "Monto fijo compartido con el colaborador (opcional)."
            : "¿Qué porcentaje de la comisión total se compartirá? (Por ejemplo, 50%).",
        kind: "number",
        optional: true,
      });
    }
  }

  const requiredMissing = missing.filter((item) => item.optional !== true);
  const requireConfirmation = params.requireConfirmation !== false;
  const confirmationOk =
    !requireConfirmation || terms.confirmation.status === "confirmed";

  return {
    ok: requiredMissing.length === 0 && confirmationOk,
    terms,
    owner_email: ownerEmail,
    known,
    missing,
  };
}

export type ContractCommercialSummaryMode = "initial" | "partial";

export function buildContractCommercialMinimumsSummaryMessage(
  result: ContractCommercialMinimumsResult,
  options?: { mode?: ContractCommercialSummaryMode }
): string {
  const mode = options?.mode === "partial" ? "partial" : "initial";
  const required = result.missing.filter((item) => item.optional !== true);
  const optional = result.missing.filter((item) => item.optional === true);
  const requiredLines = required.map(
    (item, index) => `${index + 1}. ${item.question}`
  );
  const optionalLines = optional.map((item) => `- ${item.question}`);
  const knownLines = result.known.map(
    (item) => `- ${item.label}: ${item.value}`
  );

  const parts: string[] = [];
  if (mode === "partial") {
    parts.push(
      "Gracias. Con lo que enviaste aún falta completar el contrato."
    );
  } else {
    parts.push("Para preparar el contrato de comisión, necesito lo siguiente:");
  }

  if (knownLines.length > 0) {
    parts.push("", "Datos ya registrados:", ...knownLines);
  }

  if (requiredLines.length > 0) {
    parts.push(
      "",
      knownLines.length > 0 || mode === "partial" ? "Aún necesito:" : "",
      ...requiredLines
    );
  }

  if (optionalLines.length > 0) {
    parts.push("", "En caso afirmativo (opcional):", ...optionalLines);
  }

  if (requiredLines.length === 0 && optionalLines.length === 0) {
    parts.push("", "No hay faltantes obligatorios.");
  } else if (mode === "partial") {
    parts.push("", "Puedes responder solo los pendientes.");
  } else if (requiredLines.length > 1) {
    parts.push(
      "",
      "Puedes responder todo en un solo mensaje.",
      "Ejemplo: propietario@email.com, 6 meses, Sin exclusiva, Comisión 4%, Sí se comparte, 50%."
    );
  }

  return parts
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n")
    .trim();
}

/**
 * Chat-first echo after commercial data capture — no buttons.
 * Lets the advisor spot exclusivity/commission mistakes before the draft runs.
 */
export function buildContractCommercialCaptureAckMessage(params: {
  ownerEmail?: string | null;
  terms: CommissionTerms;
}): string {
  const terms = params.terms;
  const lines: string[] = ["Datos contractuales registrados:"];
  if (params.ownerEmail) {
    lines.push(`- Correo: ${params.ownerEmail}`);
  }
  if (terms.duration_months != null) {
    lines.push(`- Duración del encargo: ${terms.duration_months} meses`);
  }
  if (terms.exclusive != null) {
    lines.push(
      `- Exclusividad: ${terms.exclusive ? "Con exclusiva" : "Sin exclusiva"}`
    );
  }
  if (terms.commission_pct != null) {
    lines.push(`- Comisión pactada: ${terms.commission_pct}%`);
  }
  if (terms.collaboration.enabled != null) {
    if (terms.collaboration.enabled) {
      const share =
        terms.collaboration.compensation.value != null
          ? ` (compartida ${terms.collaboration.compensation.value}% de la comisión total)`
          : "";
      lines.push(`- Compartir comisión: Sí${share}`);
    } else {
      lines.push("- Compartir comisión: No");
    }
  }
  lines.push("", "Generaré el borrador del contrato.");
  return lines.join("\n");
}

/** Owner commission % → EasyBroker operations[].commission (percentage). */
export function mapOwnerCommissionToEasyBroker(terms: CommissionTerms): {
  commission?: { type: "percentage"; value: number };
  warnings: Array<{ code: string; message: string; actual?: unknown }>;
} {
  const warnings: Array<{ code: string; message: string; actual?: unknown }> =
    [];
  if (terms.commission_pct == null) return { warnings };
  const value = Number(terms.commission_pct);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    warnings.push({
      code: "destination_commission_mapping_unsupported",
      message:
        "commission_pct canónico no es un porcentaje usable en EasyBroker; se omite operations[].commission.",
      actual: terms.commission_pct,
    });
    return { warnings };
  }
  return {
    commission: { type: "percentage", value },
    warnings,
  };
}

/**
 * Proyección de borde hacia EasyBroker.
 * Nunca muta el canónico; omite detalles incompatibles con warning.
 * - commission_pct → operations[].commission { type: percentage, value }
 * - collaboration → share_commission + shared_commission_percentage (solo 50|null)
 */
export function mapCollaborationToEasyBroker(terms: CommissionTerms): {
  commission?: { type: "percentage"; value: number };
  share_commission?: boolean;
  shared_commission_percentage?: number | null;
  collaboration_notes?: string;
  warnings: Array<{ code: string; message: string; actual?: unknown }>;
} {
  const owner = mapOwnerCommissionToEasyBroker(terms);
  const warnings = [...owner.warnings];

  const out: {
    commission?: { type: "percentage"; value: number };
    share_commission?: boolean;
    shared_commission_percentage?: number | null;
    collaboration_notes?: string;
    warnings: Array<{ code: string; message: string; actual?: unknown }>;
  } = {
    warnings,
    ...(owner.commission ? { commission: owner.commission } : {}),
  };

  if (terms.collaboration.enabled == null) {
    return out;
  }

  out.share_commission = terms.collaboration.enabled;

  if (terms.collaboration.enabled === false) {
    out.shared_commission_percentage = null;
    return out;
  }

  const { mode, value } = terms.collaboration.compensation;
  if (
    mode === "percentage_of_total_commission" &&
    value === 50
  ) {
    out.shared_commission_percentage = 50;
  } else if (
    mode === "percentage_of_total_commission" &&
    value != null &&
    value !== 50
  ) {
    warnings.push({
      code: "destination_commission_mapping_unsupported",
      message:
        "El porcentaje compartido canónico no es representable en EasyBroker; se envía solo share_commission=true.",
      actual: value,
    });
  } else if (
    mode === "percentage_of_sale_price" ||
    mode === "fixed_amount"
  ) {
    warnings.push({
      code: "destination_commission_mapping_unsupported",
      message:
        "El detalle de compensación canónico no mapea a shared_commission_percentage de EasyBroker; se envía solo share_commission=true.",
      actual: { mode, value },
    });
  }

  if (terms.collaboration.notes) {
    out.collaboration_notes = terms.collaboration.notes;
  }

  return out;
}

/**
 * Proyección de borde hacia Ungga.
 * - commission_pct → Comisión (%) en modal Operación (CLI)
 * - exclusividad / collaboration.enabled cuando el destino los acepte
 * - el % opcional al colaborador no se mapea (Ungga no lo expone)
 */
export function mapCollaborationToUngga(terms: CommissionTerms): {
  exclusive?: boolean;
  collaboration_enabled?: boolean;
  collaboration_notes?: string | null;
  commission_pct?: number;
  warnings: Array<{ code: string; message: string; actual?: unknown }>;
} {
  const warnings: Array<{ code: string; message: string; actual?: unknown }> =
    [];
  const out: {
    exclusive?: boolean;
    collaboration_enabled?: boolean;
    collaboration_notes?: string | null;
    commission_pct?: number;
    warnings: Array<{ code: string; message: string; actual?: unknown }>;
  } = { warnings };

  if (terms.commission_pct != null) {
    const value = Number(terms.commission_pct);
    if (Number.isFinite(value) && value > 0 && value <= 100) {
      out.commission_pct = value;
    } else {
      warnings.push({
        code: "destination_commission_mapping_unsupported",
        message:
          "commission_pct canónico no es un porcentaje usable en Ungga; se omite Comisión (%).",
        actual: terms.commission_pct,
      });
    }
  }

  if (terms.exclusive != null) {
    out.exclusive = terms.exclusive;
  }
  if (terms.collaboration.enabled != null) {
    out.collaboration_enabled = terms.collaboration.enabled;
  }
  if (
    terms.collaboration.enabled === true &&
    terms.collaboration.compensation.mode !== "not_specified" &&
    terms.collaboration.compensation.mode !== "negotiable"
  ) {
    warnings.push({
      code: "destination_commission_mapping_unsupported",
      message:
        "Ungga no expone un campo estable para el detalle de comisión compartida; se conserva solo el indicador canónico en el caso.",
      actual: terms.collaboration.compensation,
    });
  }
  if (terms.collaboration.notes) {
    out.collaboration_notes = terms.collaboration.notes;
  }
  return out;
}

export type BooleanPolarity = "explicit_true" | "explicit_false" | "unknown";

function normalizeSpanishReplyText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Polarity guardian for exclusivity. Prefer explicit_false / explicit_true only;
 * never treat a bare "exclusiva" inside a negation as affirmative.
 * Aligns with copy: "con exclusiva o sin exclusiva".
 */
export function classifyExclusivePolarity(text: string): BooleanPolarity {
  const lower = normalizeSpanishReplyText(text);
  if (!lower || !/exclusiv/.test(lower)) return "unknown";

  // Negations first (order matters).
  if (
    /\bsin\s+exclusiv/.test(lower) ||
    /\bno\s+(?:(?:es|sera|seria|queda|quedara|va\s+a\s+ser)\s+)?(?:en\s+)?exclusiv/.test(
      lower
    ) ||
    /\bno\s+exclusiv/.test(lower) ||
    /\bcaptacion\s+no\s+(?:es\s+)?(?:en\s+)?exclusiv/.test(lower) ||
    /\bno,?\s+la\s+captacion\s+no\s+es\s+(?:en\s+)?exclusiv/.test(lower)
  ) {
    return "explicit_false";
  }

  if (
    /\bcon\s+exclusiv/.test(lower) ||
    /\bes\s+(?:en\s+)?exclusiv/.test(lower) ||
    /\b(?:si|sí)\b.{0,30}exclusiv/.test(lower) ||
    /\bexclusiv.{0,20}\b(?:si|sí)\b/.test(lower) ||
    /^exclusiv/.test(lower) ||
    /(?:^|[.,;:])\s*exclusiv/.test(lower)
  ) {
    return "explicit_true";
  }

  // Mentions "exclusiv*" without clear polarity — do not guess.
  return "unknown";
}

/**
 * Polarity guardian for commission sharing. Same contract as exclusive:
 * only return explicit_* when the Spanish cue is unambiguous.
 */
export function classifyCollaborationPolarity(text: string): BooleanPolarity {
  const lower = normalizeSpanishReplyText(text);
  if (!lower) return "unknown";

  if (
    (/\bno\s+(se\s+)?comparte|\bno\s+compart|\bsin\s+compartir/.test(lower) &&
      /comision|compart/.test(lower)) ||
    /^no$/.test(lower)
  ) {
    // Bare "no" only counts when caller already scoped to this field alone.
    if (/^no$/.test(lower)) return "unknown";
    return "explicit_false";
  }

  if (
    /(\bsi\b|\bsí\b).{0,40}(comision|compart)|(\bcomparte|\bcompartir\b).{0,40}(comision|si\b)/.test(
      lower
    ) ||
    (/\bsi\b|\bsí\b|\bcomparte|\bcompartir\b/.test(lower) &&
      /comision|compart/.test(lower))
  ) {
    return "explicit_true";
  }

  return "unknown";
}

export function parseContractCommercialReply(
  text: string,
  missing: ContractCommercialMissingField[]
): { intent: "provide_data" | "unclear"; patch: ContractCommercialPatch; reason?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      intent: "unclear",
      patch: {},
      reason: "Escribe los datos faltantes para continuar.",
    };
  }

  const patch: ContractCommercialPatch = {};
  const missingKeys = new Set(missing.map((item) => item.key));

  const emailMatch = trimmed.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (emailMatch && missingKeys.has("owner_email")) {
    const email = normalizeEmailCandidate(emailMatch[0]);
    if (looksLikeEmail(email)) {
      patch.owner_email = email;
    }
  }

  const lower = normalizeSpanishReplyText(trimmed);

  if (missingKeys.has("collaboration_enabled")) {
    const polarity = classifyCollaborationPolarity(trimmed);
    if (polarity === "explicit_false") {
      patch.collaboration_enabled = false;
    } else if (polarity === "explicit_true") {
      patch.collaboration_enabled = true;
    } else if (/^no$/i.test(trimmed) || /^si$/i.test(trimmed) || /^sí$/i.test(trimmed)) {
      const booleanMissing = missing.filter((item) => item.kind === "boolean");
      if (booleanMissing.length === 1 && booleanMissing[0]?.key === "collaboration_enabled") {
        patch.collaboration_enabled = /^si$|^sí$/i.test(trimmed);
      }
    }
  }

  if (missingKeys.has("exclusive")) {
    const polarity = classifyExclusivePolarity(trimmed);
    if (polarity === "explicit_false") {
      patch.exclusive = false;
    } else if (polarity === "explicit_true") {
      patch.exclusive = true;
    } else if (/^no$/i.test(trimmed) || /^si$/i.test(trimmed) || /^sí$/i.test(trimmed)) {
      const booleanMissing = missing.filter((item) => item.kind === "boolean");
      if (booleanMissing.length === 1 && booleanMissing[0]?.key === "exclusive") {
        patch.exclusive = /^si$|^sí$/i.test(trimmed);
      }
    }
  }

  // Shared compensation before total commission to avoid misrouting "50% de la comisión".
  // Also accept when this reply enables collaboration (progressive capture in one message).
  const canCaptureSharedDetail =
    missingKeys.has("compensation_value") ||
    missingKeys.has("compensation_mode") ||
    patch.collaboration_enabled === true;
  const sharedPctOfTotalMatch = trimmed.match(
    /(\d+(?:[.,]\d+)?)\s*%?\s*(?:del?\s+(?:total\s+de\s+)?(?:la\s+)?comisi[oó]n(?:\s+total)?)/i
  );
  const sharedExplicitMatch = trimmed.match(
    /(?:se\s+comparte(?:\s+el)?|compart(?:e|ida?|ir)|colaborador)\s*(?:el\s+)?(\d+(?:[.,]\d+)?)\s*%?/i
  );
  const sharedValueRaw =
    sharedExplicitMatch?.[1] ??
    (/\bcompart|\bcolabor/.test(lower) ? sharedPctOfTotalMatch?.[1] : undefined);
  if (sharedValueRaw != null && canCaptureSharedDetail) {
    const sharedValue = numberOrNull(sharedValueRaw, { allowZero: true });
    if (sharedValue != null) {
      if (
        missingKeys.has("compensation_value") ||
        patch.collaboration_enabled === true
      ) {
        patch.compensation_value = sharedValue;
      }
      if (
        (missingKeys.has("compensation_mode") ||
          patch.collaboration_enabled === true) &&
        patch.compensation_mode == null &&
        (/de la comisi|del total|comisi[oó]n total/i.test(trimmed) ||
          sharedPctOfTotalMatch != null)
      ) {
        patch.compensation_mode = "percentage_of_total_commission";
      }
    }
  }

  if (missingKeys.has("commission_pct")) {
    const commissionPctMatch = trimmed.match(
      /(?:comisi[oó]n\s+total(?:\s+[^=:\d%]{0,40})?|comisi[oó]n(?:\s+total)?\s+pactada(?:\s+con\s+el\s+propietario)?|comisi[oó]n\s+cobrada(?:\s+al\s+propietario)?|commission(?:\s+(?:pct|total))?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%?/i
    );
    const ownerPctMatch = trimmed.match(
      /(\d+(?:[.,]\d+)?)\s*%\s*(?:cobrad[oa]\s+al\s+propietario|pactad[oa]\s+con\s+el\s+propietario)/i
    );
    const candidate = commissionPctMatch?.[1] ?? ownerPctMatch?.[1];
    if (candidate) {
      const looksShared =
        /comisi[oó]n\s+compart|compart(?:e|ida?).{0,20}\d|(\d+(?:[.,]\d+)?)\s*%?\s*(?:del?\s+(?:total\s+de\s+)?(?:la\s+)?comisi[oó]n)/i.test(
          trimmed
        ) &&
        !/comisi[oó]n\s+total|comisi[oó]n\s+pactada|comisi[oó]n\s+cobrada|cobrad[oa]\s+al\s+propietario/i.test(
          trimmed
        );
      if (!looksShared) {
        patch.commission_pct = numberOrNull(candidate);
      }
    } else {
      const barePct = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*%?$/);
      if (
        barePct &&
        missing.filter((m) => m.kind === "number" && m.optional !== true).length === 1
      ) {
        patch.commission_pct = numberOrNull(barePct[1]);
      }
    }
  }

  if (missingKeys.has("duration_months")) {
    const durationMatch =
      trimmed.match(
        new RegExp(
          `(?:duraci[oó]n|duration)\\s*[:=]?\\s*(${SPANISH_INTEGER_TOKEN})(?:\\s*meses?)?`,
          "i"
        )
      ) ??
      trimmed.match(
        new RegExp(`\\b(${SPANISH_INTEGER_TOKEN})\\s*meses?\\b`, "i")
      );
    if (durationMatch) {
      patch.duration_months = numberTokenOrNull(durationMatch[1]);
    }
  }

  if (
    (missingKeys.has("compensation_mode") ||
      patch.collaboration_enabled === true) &&
    patch.compensation_mode == null
  ) {
    if (/no especificar|por ahora|omitir detalle/i.test(trimmed)) {
      patch.compensation_mode = "not_specified";
    } else if (/negociable|a convenir/i.test(trimmed)) {
      patch.compensation_mode = "negotiable";
    } else if (/precio|venta|renta/i.test(trimmed) && /%|porcentaje/i.test(trimmed)) {
      patch.compensation_mode = "percentage_of_sale_price";
    } else if (/monto fijo|cantidad fija|fijo/i.test(trimmed)) {
      patch.compensation_mode = "fixed_amount";
    } else if (
      patch.compensation_value != null ||
      (/comisi[oó]n total|de la comisi[oó]n|se comparte|compart/i.test(trimmed) &&
        /\d+(?:[.,]\d+)?\s*%?/.test(trimmed) &&
        /compart/i.test(trimmed))
    ) {
      patch.compensation_mode = "percentage_of_total_commission";
    }
  }

  if (
    Object.keys(patch).length === 0 ||
    Object.values(patch).every((value) => value === undefined)
  ) {
    return {
      intent: "unclear",
      patch: {},
      reason:
        "No pude interpretar los datos. Responde con los faltantes listados (correo, sí/no, porcentajes o meses).",
    };
  }

  return { intent: "provide_data", patch };
}
