import type { AgentMessage } from "@agents/types";

/**
 * Sanitizes the conversation history that the **model sees** (not what's stored
 * in DB) when the active skill is `company-data`.
 *
 * Why this exists
 * ---------------
 * BigQuery turns are sensitive to imitation. If a previous assistant turn
 * answered a single-month question with multiple bundled months (e.g.
 * "Total de leads en abril: 510 | Total de leads en marzo: 282" because of an
 * earlier bug), the model tends to copy that pattern in the current turn even
 * when the system prompt explicitly forbids it: the in-context example is a
 * stronger learning signal than the appended rule.
 *
 * This module removes that demonstration from the model's input only when:
 *
 * - the previous user message clearly named ONE month, and
 * - the assistant reply mentioned 2+ DIFFERENT months alongside leads/metric
 *   language.
 *
 * Tightly scoped on purpose: legitimate multi-month answers (e.g. "compárame
 * abril vs marzo") are NOT sanitized because the previous user message would
 * itself contain both months.
 *
 * The DB row remains unchanged; only the in-flight `BaseMessage[]` shown to
 * the LLM is rewritten.
 */

const MONTHS_PATTERN =
  /(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/gi;

const METRIC_HINT_RE =
  /(total\s+de\s+leads|leads\s+creados|\|\s*leads|\bleads?\b)/i;

const BIGQUERY_FAILURE_HINT_RE =
  /(no\s+pude\s+completar\s+la\s+consulta|no\s+pude\s+obtener|bigquery|start_date|end_date|validation_error|param(etro|etros)|missing named query parameter)/i;

const HAS_NUMERIC_METRIC_RE =
  /(\d+[\d.,]*\s+leads?|en\s+\w+\s+tuvieron\s+\d+|tuvimos\s+\d+)/i;

function uniqueMonths(text: string): Set<string> {
  const set = new Set<string>();
  const matches = text.match(MONTHS_PATTERN);
  if (!matches) return set;
  for (const raw of matches) {
    let m = raw.toLowerCase();
    if (m === "setiembre") m = "septiembre";
    set.add(m);
  }
  return set;
}

/**
 * For each assistant message, look at the **immediately preceding** user
 * message and decide whether the assistant content is "contaminated" — i.e.
 * answers more months than were asked, in a leads/metric context. If so, we
 * replace the content with a short placeholder so the model cannot imitate
 * the bundled multi-month pattern.
 *
 * Returns a new array; input is not mutated.
 */
export function sanitizeCompanyDataHistory(
  messages: readonly AgentMessage[]
): AgentMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== "assistant") return { ...msg };

    let prevUser: AgentMessage | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = messages[j];
      if (candidate?.role === "user") {
        prevUser = candidate;
        break;
      }
    }
    if (!prevUser) return { ...msg };

    const assistantContent = msg.content;
    const userMonths = uniqueMonths(prevUser.content);
    const assistantMonths = uniqueMonths(assistantContent);

    if (isFailedBigQueryAssistantReply(assistantContent)) {
      return {
        ...msg,
        content:
          "[respuesta historica descartada — este turno fallo por ejecucion/parametros de BigQuery. Ignora este ejemplo y no respondas metricas sin una consulta BigQuery exitosa en el turno actual.]",
      };
    }

    if (userMonths.size !== 1) return { ...msg };
    if (assistantMonths.size < 2) return { ...msg };
    if (!METRIC_HINT_RE.test(assistantContent)) return { ...msg };

    const askedMonth = [...userMonths][0];
    const extras = [...assistantMonths]
      .filter((m) => m !== askedMonth)
      .join(", ");
    return {
      ...msg,
      content: `[respuesta histórica descartada — el usuario preguntó por ${askedMonth} pero la respuesta mezcló además ${extras}. Ignora este turno como ejemplo de formato; no copies el patrón de devolver varios meses.]`,
    };
  });
}

function isFailedBigQueryAssistantReply(content: string): boolean {
  if (!BIGQUERY_FAILURE_HINT_RE.test(content)) return false;
  if (HAS_NUMERIC_METRIC_RE.test(content)) return true;
  return /\b(leads?|consulta|sql)\b/i.test(content);
}
