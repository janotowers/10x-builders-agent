import { createHash } from "node:crypto";

/**
 * Canonical JSON serialization for `definition_hash`: object keys sorted
 * recursively, arrays kept in order, no whitespace. Two graphs that differ
 * only in key insertion order hash identically; any semantic change changes
 * the hash (evidence records pin to it — Technical Plan §13).
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(",");
  return `{${body}}`;
}

export function computeDefinitionHash(graph: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalizeJson(graph), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
