/**
 * Heuristics for the `lead-follow-up-draft` skill router/guard.
 *
 * Goal: decide whether the current turn carries a lead identifier the
 * agent can use to ground a personalized follow-up draft. We only
 * trust an identifier when it shows up in the CURRENT user message or
 * when the user is replying to the assistant's most recent question
 * that explicitly asked for one. We never accept a name that floats
 * in from older turns of the conversation, because that is exactly
 * the failure mode that makes the agent reuse stale data.
 */
import type { AgentMessage } from "@agents/types";

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const LEAD_ID_RE = /\b(?:lead[_-]?id\s*[:=]?\s*)([a-z0-9]{8,})\b/i;

const SHORT_IDENTIFIER_REPLY_RE =
  /^(?:(?:su|el|la)\s+)?(?:nombre|telefono|tel[eé]fono|celular|email|correo|lead\s*id)\b|^(?:se\s+llama|tel[eé]fono|email|correo)\b/i;
const EXPLICIT_NAME_IN_TURN_RE =
  /\b(?:nombre\s+(?:del\s+lead\s+)?es|se\s+llama|lead(?:\s+(?:es|se\s+llama|llamad[oa]))?|prospect[oa](?:\s+(?:es|se\s+llama|llamad[oa]))?|cliente\s+potencial(?:\s+(?:es|se\s+llama|llamad[oa]))?)\s+[a-záéíóúüñ]+(?:\s+[a-záéíóúüñ]+){0,5}\b/i;

const ASKED_FOR_ID_TOKEN_RE =
  /(nombre|tel[eé]fono|celular|email|correo|lead[_\s-]?id)/i;
const ASKED_FOR_ID_VERB_RE =
  /(proporci[oó]n|comp[aá]rt|d[ií]me|d[ií]game|cu[aá]l es|necesito|pas[aá]me|env[ií]ame|qu[eé] dato)/i;

export interface TurnHasLeadIdentifierInput {
  readonly message: string | undefined | null;
  readonly priorMessages: readonly AgentMessage[];
}

export function turnHasLeadIdentifier(
  input: TurnHasLeadIdentifierInput
): boolean {
  const text = (input.message ?? "").trim();
  if (!text) return false;

  if (EMAIL_RE.test(text)) return true;
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length >= 8) return true;
  if (LEAD_ID_RE.test(text)) return true;
  if (EXPLICIT_NAME_IN_TURN_RE.test(text)) return true;

  if (text.length > 200) return false;
  if (!SHORT_IDENTIFIER_REPLY_RE.test(text)) return false;

  for (let i = input.priorMessages.length - 1; i >= 0; i--) {
    const msg = input.priorMessages[i];
    if (msg.role === "assistant") {
      const norm = msg.content.toLowerCase();
      if (ASKED_FOR_ID_TOKEN_RE.test(norm) && ASKED_FOR_ID_VERB_RE.test(norm)) {
        return true;
      }
      return false;
    }
    if (msg.role === "user") return false;
  }
  return false;
}
