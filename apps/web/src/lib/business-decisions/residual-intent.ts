/**
 * Residual-intent preservation (flexible-workflows plan, Slice 0.1).
 *
 * When a pending-decision gate claims a turn, the deterministic parser only
 * consumes the decision segment (prefix/pattern + structured values). Any
 * remaining text carries intent the gate did NOT act on. These helpers turn
 * that remainder into an explicit `ResidualIntent` so the composed response
 * can acknowledge it ("No actué sobre: …") instead of silently dropping it.
 *
 * Pure functions only — parsers compute raw remainders, the router builds the
 * `ResidualIntent`, and the channel adapters render the acknowledgment line.
 */

export type ResidualIntentReason = "unparsed_remainder" | "unmatched_intent";

export type ResidualIntent = {
  /** Cleaned, human-readable text the gate did not act on. */
  text: string;
  reason: ResidualIntentReason;
};

// Connectors/punctuation that merely join the decision segment to the rest
// ("aprobar precio y agenda…" → the "y" is glue, not intent).
const LEADING_FILLER =
  /^(?:[\s,;.:¡!¿?·\-–—]+|(?:y|e|adem[aá]s|tambi[eé]n)(?=[\s,;.:]|$))+/i;
const TRAILING_FILLER = /[\s,;.:¡!¿?·\-–—]+$/;

/**
 * Normalizes an unconsumed remainder: strips joining connectors/punctuation
 * and returns "" when nothing meaningful (letters/digits) remains.
 */
export function cleanResidualRemainder(remainder: string): string {
  const cleaned = remainder
    .replace(LEADING_FILLER, "")
    .replace(TRAILING_FILLER, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";
  return cleaned;
}

/**
 * Builds a `ResidualIntent` from a parser remainder. Empty/filler-only
 * remainders yield `null` (single-intent turn: nothing was lost).
 */
export function residualFromRemainder(
  remainder: string | null | undefined,
  reason: ResidualIntentReason = "unparsed_remainder"
): ResidualIntent | null {
  if (!remainder) return null;
  const text = cleanResidualRemainder(remainder);
  return text ? { text, reason } : null;
}

/**
 * Removes consumed spans from `text` (decision keywords, structured values)
 * and returns the concatenated leftover. Spans may arrive unordered.
 */
export function removeConsumedSegments(
  text: string,
  segments: Array<{ index: number; length: number }>
): string {
  if (segments.length === 0) return text;
  const sorted = [...segments].sort((a, b) => a.index - b.index);
  let result = "";
  let cursor = 0;
  for (const segment of sorted) {
    if (segment.index > cursor) {
      result += `${text.slice(cursor, segment.index)} `;
    }
    cursor = Math.max(cursor, segment.index + segment.length);
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Fixed-format acknowledgment line appended by the channel adapters
 * (web chat + Telegram) when a handled turn reports residual intent.
 */
export function appendResidualAcknowledgment(
  message: string,
  residual: ResidualIntent | null | undefined
): string {
  if (!residual || !residual.text.trim()) return message;
  return `${message}\n\nNo actué sobre: “${residual.text}”`;
}
