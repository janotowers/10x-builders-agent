/**
 * Orden estable de args para vista previa en Preparación operativa.
 * No altera valores enviados a la tool; sólo facilita comparar Smoke vs Caso de prueba.
 */

const TOP_LEVEL_KEY_ORDER = [
  "case_type",
  "case_id",
  "context",
  "external_contact",
  "expected_version",
  "status",
  "current_step",
  "context_patch",
  "text",
  "chat_id",
  "purpose",
  "kind",
  "urgency",
  "listing_id",
  "document_id",
  "dry_run",
];

function sortKeyList(keys: string[], preferred: string[]) {
  const preferredSet = new Set(preferred);
  const head = preferred.filter((key) => keys.includes(key));
  const tail = keys
    .filter((key) => !preferredSet.has(key))
    .sort((a, b) => a.localeCompare(b, "es"));
  return [...head, ...tail];
}

function sortRecordAlphabetically(
  record: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, "es"))) {
    const value = record[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? sortRecordAlphabetically(value as Record<string, unknown>)
        : value;
  }
  return out;
}

export function formatToolArgsForDisplay(
  args: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of sortKeyList(Object.keys(args), TOP_LEVEL_KEY_ORDER)) {
    const value = args[key];
    if (
      (key === "context" ||
        key === "external_contact" ||
        key === "context_patch") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = sortRecordAlphabetically(value as Record<string, unknown>);
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sortRecordAlphabetically(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function stringifyToolArgsForDisplay(
  args: Record<string, unknown> | null | undefined,
  indent = 2
): string {
  return JSON.stringify(formatToolArgsForDisplay(args), null, indent);
}
