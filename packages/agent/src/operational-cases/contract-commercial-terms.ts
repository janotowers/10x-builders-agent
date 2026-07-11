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

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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
    if (candidate && looksLikeEmail(candidate)) return candidate;
  }
  return null;
}

function formatKnownValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return String(value ?? "");
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
      question: "Correo electrónico del propietario.",
      kind: "email",
    });
  }

  if (terms.collaboration.enabled == null) {
    missing.push({
      key: "collaboration_enabled",
      label: "Compartir comisión",
      question:
        "¿Se compartirá comisión con otro asesor o inmobiliaria?",
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
        "¿Quieres especificar cuánto se comparte? (opcional)",
      kind: "choice",
      optional: true,
      choices: [
        {
          value: "percentage_of_total_commission",
          label: "Porcentaje de la comisión total",
        },
        {
          value: "percentage_of_sale_price",
          label: "Porcentaje del precio de venta/renta",
        },
        { value: "fixed_amount", label: "Monto fijo" },
        { value: "negotiable", label: "A convenir" },
        { value: "not_specified", label: "No especificar por ahora" },
      ],
    });
  } else if (
    terms.collaboration.enabled === true &&
    terms.collaboration.compensation.mode !== "not_specified"
  ) {
    known.push({
      key: "compensation_mode",
      label: "Detalle de comisión compartida",
      value: terms.collaboration.compensation.mode,
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
            ? "Monto fijo compartido con el colaborador."
            : "Porcentaje compartido con el colaborador.",
        kind: "number",
        optional: true,
      });
    } else if (terms.collaboration.compensation.value != null) {
      known.push({
        key: "compensation_value",
        label: "Valor de comisión compartida",
        value: formatKnownValue(terms.collaboration.compensation.value),
      });
    }
  }

  if (terms.commission_pct == null) {
    missing.push({
      key: "commission_pct",
      label: "Comisión total",
      question:
        "Porcentaje total de comisión pactado con el propietario.",
      kind: "number",
    });
  } else {
    known.push({
      key: "commission_pct",
      label: "Comisión total",
      value: `${terms.commission_pct}%`,
    });
  }

  if (terms.exclusive == null) {
    missing.push({
      key: "exclusive",
      label: "Exclusividad",
      question: "¿La captación es exclusiva?",
      kind: "boolean",
    });
  } else {
    known.push({
      key: "exclusive",
      label: "Exclusividad",
      value: formatKnownValue(terms.exclusive),
    });
  }

  if (terms.duration_months == null) {
    missing.push({
      key: "duration_months",
      label: "Duración del encargo",
      question: "Duración del encargo en meses.",
      kind: "number",
    });
  } else {
    known.push({
      key: "duration_months",
      label: "Duración del encargo",
      value: `${terms.duration_months} meses`,
    });
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

export function buildContractCommercialMinimumsSummaryMessage(
  result: ContractCommercialMinimumsResult
): string {
  const knownLines =
    result.known.length > 0
      ? result.known.map((item) => `- ${item.label}: ${item.value}`)
      : ["- Sin datos contractuales consolidados todavía."];
  const required = result.missing.filter((item) => item.optional !== true);
  const optional = result.missing.filter((item) => item.optional === true);
  const requiredLines = required.map(
    (item, index) => `${index + 1}. ${item.question}`
  );
  const optionalLines = optional.map((item) => `- ${item.question}`);

  const parts = [
    "Para preparar el contrato y la publicación, confirma:",
    "",
    "Datos conocidos:",
    ...knownLines,
  ];
  if (requiredLines.length > 0) {
    parts.push("", "Faltantes:", "", ...requiredLines);
  }
  if (optionalLines.length > 0) {
    parts.push("", "Opcional:", ...optionalLines);
  }
  if (requiredLines.length === 0 && optionalLines.length === 0) {
    parts.push("", "No hay faltantes obligatorios.");
  }
  return parts.join("\n");
}

/**
 * Proyección de borde hacia EasyBroker.
 * Nunca muta el canónico; omite detalles incompatibles con warning.
 */
export function mapCollaborationToEasyBroker(terms: CommissionTerms): {
  share_commission?: boolean;
  shared_commission_percentage?: number | null;
  collaboration_notes?: string;
  warnings: Array<{ code: string; message: string; actual?: unknown }>;
} {
  const warnings: Array<{ code: string; message: string; actual?: unknown }> =
    [];
  if (terms.collaboration.enabled == null) {
    return { warnings };
  }

  const out: {
    share_commission?: boolean;
    shared_commission_percentage?: number | null;
    collaboration_notes?: string;
    warnings: Array<{ code: string; message: string; actual?: unknown }>;
  } = {
    share_commission: terms.collaboration.enabled,
    warnings,
  };

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
 * Extensible: hoy solo propaga exclusividad/notas cuando el destino las acepte.
 * No inventa campos que Ungga no soporte.
 */
export function mapCollaborationToUngga(terms: CommissionTerms): {
  exclusive?: boolean;
  collaboration_enabled?: boolean;
  collaboration_notes?: string | null;
  warnings: Array<{ code: string; message: string; actual?: unknown }>;
} {
  const warnings: Array<{ code: string; message: string; actual?: unknown }> =
    [];
  const out: {
    exclusive?: boolean;
    collaboration_enabled?: boolean;
    collaboration_notes?: string | null;
    warnings: Array<{ code: string; message: string; actual?: unknown }>;
  } = { warnings };

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
  if (emailMatch && looksLikeEmail(emailMatch[0]) && missingKeys.has("owner_email")) {
    patch.owner_email = emailMatch[0].trim();
  }

  const lower = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

  if (missingKeys.has("collaboration_enabled")) {
    if (
      /\bno\s+(se\s+)?comparte|\bno\s+compart|\bsin\s+compartir|\bno\b/.test(
        lower
      ) &&
      /comision|compart/.test(lower)
    ) {
      patch.collaboration_enabled = false;
    } else if (
      /\bsi\b|\bsí\b|\bcomparte|\bcompartir\b/.test(lower) &&
      /comision|compart/.test(lower)
    ) {
      patch.collaboration_enabled = true;
    } else if (/^no$/i.test(trimmed) || /^si$/i.test(trimmed) || /^sí$/i.test(trimmed)) {
      // Ambiguous single-word answers when multiple booleans missing — leave unset
      // unless collaboration is the only boolean missing.
      const booleanMissing = missing.filter((item) => item.kind === "boolean");
      if (booleanMissing.length === 1 && booleanMissing[0]?.key === "collaboration_enabled") {
        patch.collaboration_enabled = /^si$|^sí$/i.test(trimmed);
      }
    }
  }

  if (missingKeys.has("exclusive")) {
    if (/exclusiv/.test(lower)) {
      if (/\bno\s+exclusiv/.test(lower)) patch.exclusive = false;
      else if (/\bexclusiv/.test(lower)) patch.exclusive = true;
    }
  }

  const commissionPctMatch = trimmed.match(
    /(?:comisi[oó]n(?:\s+total)?|commission(?:\s+pct)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%?/i
  );
  if (commissionPctMatch && missingKeys.has("commission_pct")) {
    patch.commission_pct = numberOrNull(commissionPctMatch[1]);
  } else if (missingKeys.has("commission_pct")) {
    const barePct = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*%?$/);
    if (barePct && missing.filter((m) => m.kind === "number" && m.optional !== true).length === 1) {
      patch.commission_pct = numberOrNull(barePct[1]);
    }
  }

  const durationMatch = trimmed.match(
    /(?:duraci[oó]n|meses?|duration)\s*[:=]?\s*(\d+)/i
  );
  if (durationMatch && missingKeys.has("duration_months")) {
    patch.duration_months = numberOrNull(durationMatch[1]);
  }

  if (missingKeys.has("compensation_mode")) {
    if (/no especificar|por ahora|omitir detalle/i.test(trimmed)) {
      patch.compensation_mode = "not_specified";
    } else if (/negociable|a convenir/i.test(trimmed)) {
      patch.compensation_mode = "negotiable";
    } else if (/precio|venta|renta/i.test(trimmed) && /%|porcentaje/i.test(trimmed)) {
      patch.compensation_mode = "percentage_of_sale_price";
    } else if (/monto fijo|cantidad fija|fijo/i.test(trimmed)) {
      patch.compensation_mode = "fixed_amount";
    } else if (/comisi[oó]n total|de la comisi[oó]n/i.test(trimmed)) {
      patch.compensation_mode = "percentage_of_total_commission";
    }
  }

  const sharedValueMatch = trimmed.match(
    /(?:compartid[oa]|colaborador|shared)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );
  if (sharedValueMatch && missingKeys.has("compensation_value")) {
    patch.compensation_value = numberOrNull(sharedValueMatch[1], {
      allowZero: true,
    });
  }

  if (Object.keys(patch).length === 0) {
    return {
      intent: "unclear",
      patch: {},
      reason:
        "No pude interpretar los datos. Responde con los faltantes listados (correo, sí/no, porcentajes o meses).",
    };
  }

  return { intent: "provide_data", patch };
}
