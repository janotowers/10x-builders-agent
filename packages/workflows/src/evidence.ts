/**
 * Secret scrubber for evidence `detail_jsonb` (Slice 1.5 / Technical Plan
 * §13): evidence must never persist credentials. Two passes:
 *
 * 1. Key-based: any key matching the secret-name pattern is redacted.
 * 2. Value-based: any string equal to the value of a secret-named env var
 *    (redaction list seeded from `process.env` names) is redacted wherever
 *    it appears, regardless of key.
 */

const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|service[_-]?role)/i;

const REDACTED = "[redacted]";

function collectEnvSecretValues(env: NodeJS.ProcessEnv): Set<string> {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue; // short values create false positives
    if (SECRET_KEY_PATTERN.test(name)) values.add(value);
  }
  return values;
}

let cachedEnvSecrets: Set<string> | null = null;

function envSecretValues(): Set<string> {
  if (!cachedEnvSecrets) cachedEnvSecrets = collectEnvSecretValues(process.env);
  return cachedEnvSecrets;
}

/** Test hook: reset the cached env redaction list. */
export function resetEvidenceScrubberCacheForTests(): void {
  cachedEnvSecrets = null;
}

function scrubValue(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    if (secrets.has(value)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = scrubValue(inner, secrets);
      }
    }
    return out;
  }
  return value;
}

export function scrubEvidenceDetail(
  detail: Record<string, unknown> | null | undefined,
  options?: { extraSecretValues?: Iterable<string> }
): Record<string, unknown> {
  const secrets = new Set(envSecretValues());
  for (const extra of options?.extraSecretValues ?? []) {
    if (extra && extra.length >= 8) secrets.add(extra);
  }
  return scrubValue(detail ?? {}, secrets) as Record<string, unknown>;
}
