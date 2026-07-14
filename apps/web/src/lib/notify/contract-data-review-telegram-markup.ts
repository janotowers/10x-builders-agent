/**
 * Markup seguro de Telegram para contract_data_review.
 *
 * Solo adjunta Sí/No cuando queda exactamente un obligatorio booleano;
 * con varios faltantes el asesor responde en texto libre (sin ambigüedad).
 */

export type ContractDataReviewMissingFieldLike = {
  key?: unknown;
  kind?: unknown;
  optional?: unknown;
  label?: unknown;
  question?: unknown;
};

export type ContractDataReviewTelegramMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeContractDataReviewMissingFields(
  raw: unknown
): Array<{
  key: string;
  kind: string;
  optional?: boolean;
  label?: string;
  question?: string;
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ContractDataReviewMissingFieldLike =>
        isRecord(item) && typeof item.key === "string" && item.key.trim().length > 0
    )
    .map((item) => ({
      key: String(item.key).trim(),
      kind: typeof item.kind === "string" ? item.kind : "text",
      optional: item.optional === true,
      label: typeof item.label === "string" ? item.label : undefined,
      question: typeof item.question === "string" ? item.question : undefined,
    }));
}

export function resolveSingleRequiredBooleanField(
  missingFields: unknown
): { key: string; label?: string; question?: string } | null {
  const normalized = normalizeContractDataReviewMissingFields(missingFields);
  const required = normalized.filter((field) => field.optional !== true);
  const booleanRequired = required.filter((field) => field.kind === "boolean");
  if (required.length !== 1 || booleanRequired.length !== 1) return null;
  return {
    key: booleanRequired[0].key,
    label: booleanRequired[0].label,
    question: booleanRequired[0].question,
  };
}

export function contractDataReviewBooleanButtonLabels(fieldKey: string): {
  yes: string;
  no: string;
} {
  if (fieldKey === "collaboration_enabled") {
    return { yes: "Sí, compartir", no: "No compartir" };
  }
  if (fieldKey === "exclusive") {
    return { yes: "Sí, exclusivo", no: "No, sin exclusiva" };
  }
  return { yes: "Sí", no: "No" };
}

/**
 * Construye el teclado inline solo cuando el único faltante obligatorio es
 * un booleano (no ambiguo). En cualquier otro caso retorna undefined.
 */
export function buildContractDataReviewTelegramMarkup(
  notificationId: string,
  missingFields: unknown
): ContractDataReviewTelegramMarkup | undefined {
  const id = notificationId.trim();
  if (!id) return undefined;
  const singleBoolean = resolveSingleRequiredBooleanField(missingFields);
  if (!singleBoolean) return undefined;
  const labels = contractDataReviewBooleanButtonLabels(singleBoolean.key);
  return {
    inline_keyboard: [
      [
        {
          text: labels.yes,
          callback_data: `cdr_yes:${id}`,
        },
        {
          text: labels.no,
          callback_data: `cdr_no:${id}`,
        },
      ],
    ],
  };
}
