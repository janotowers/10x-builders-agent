/**
 * Value normalization for legacy source documents.
 *
 * Every function here answers the same question: the source stores this thing
 * in more than one representation - what is the single normalized value, and
 * what is the raw form worth keeping as provenance?
 *
 * The rule throughout is **null over a guess**. A value we cannot confidently
 * normalize becomes null, and the caller decides what that means. Inventing a
 * plausible value is how a shadow-stage read turns into a wrong business
 * decision two Slices later.
 */

/** Firestore `Timestamp`, its serialized form, `Date`, epoch ms, or ISO text. */
export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number") {
    // Epoch seconds and epoch milliseconds are both in the wild; anything below
    // ~1e11 could not be milliseconds in any plausible year, so it is seconds.
    if (!Number.isFinite(value)) return null;
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // `2026-09-04 18:30:00` (the appointment `date` shape) is not ISO-8601 but
    // parses consistently once the space becomes a `T`.
    const isoish = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)
      ? trimmed.replace(" ", "T")
      : trimmed;
    const parsed = Date.parse(isoish);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.toDate === "function") {
      try {
        const date = (candidate.toDate as () => Date)();
        return date instanceof Date && !Number.isNaN(date.getTime())
          ? date.toISOString()
          : null;
      } catch {
        return null;
      }
    }
    const seconds =
      typeof candidate._seconds === "number"
        ? candidate._seconds
        : typeof candidate.seconds === "number"
          ? candidate.seconds
          : null;
    if (seconds !== null) {
      const date = new Date(seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

export interface NormalizedReference {
  /** The bare document id, e.g. a Firebase uid. */
  id: string | null;
  /** The representation as stored, kept for provenance only. */
  raw: string | null;
}

/**
 * Normalizes the several ways this source points at another document:
 *
 *   * a driver `DocumentReference` (`{ id, path }`) - the current form;
 *   * a text path such as `users/abc123` - part of the imported inventory;
 *   * a bare id - what the deal-scoped property snapshots carry.
 *
 * Anything else yields `{ id: null }`, which callers treat as "ownership could
 * not be established" rather than as a match.
 */
export function normalizeReference(value: unknown): NormalizedReference {
  if (value === null || value === undefined) return { id: null, raw: null };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { id: null, raw: null };
    if (trimmed.includes("/")) {
      const segments = trimmed.split("/").filter(Boolean);
      const last = segments[segments.length - 1] ?? null;
      return { id: last || null, raw: trimmed };
    }
    return { id: trimmed, raw: trimmed };
  }
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const path = typeof candidate.path === "string" ? candidate.path : null;
    const id = typeof candidate.id === "string" ? candidate.id : null;
    if (id) return { id, raw: path ?? id };
    if (path) {
      const segments = path.split("/").filter(Boolean);
      return { id: segments[segments.length - 1] ?? null, raw: path };
    }
  }
  return { id: null, raw: null };
}

export function normalizeString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // Legacy price displays carry separators and currency marks.
    const cleaned = value.replace(/[^0-9.-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

/**
 * Conversation items store the body as a string, and on some items as a
 * single-element array. Both flatten to one string; anything else is null.
 */
export function normalizeMessageBody(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => entry !== null);
    if (parts.length === 0) return null;
    return parts.join("\n");
  }
  return null;
}

/** Seconds between two ISO instants, or null when either is unknown. */
export function ageSecondsBetween(
  readAt: string,
  sourceUpdatedAt: string | null
): number | null {
  if (!sourceUpdatedAt) return null;
  const read = Date.parse(readAt);
  const updated = Date.parse(sourceUpdatedAt);
  if (Number.isNaN(read) || Number.isNaN(updated)) return null;
  return Math.round((read - updated) / 1000);
}
