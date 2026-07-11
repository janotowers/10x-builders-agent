export type PublicationRolloutMode = "off" | "shadow" | "active";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mode(value: unknown): PublicationRolloutMode | null {
  return value === "off" || value === "shadow" || value === "active"
    ? value
    : null;
}

/**
 * Case configuration always wins over account configuration. Missing config is
 * deliberately off: publication side effects require an explicit rollout mode.
 */
export function resolvePublicationRolloutMode(
  context: Record<string, unknown>,
  accountBusinessBrain?: Record<string, unknown> | null
): PublicationRolloutMode {
  const publication = isRecord(context.publication) ? context.publication : {};
  const accountPublication = isRecord(accountBusinessBrain?.publication)
    ? accountBusinessBrain.publication
    : {};
  return (
    mode(context.publication_mode) ??
    mode(publication.mode) ??
    mode(accountBusinessBrain?.publication_mode) ??
    mode(accountPublication.mode) ??
    "off"
  );
}
