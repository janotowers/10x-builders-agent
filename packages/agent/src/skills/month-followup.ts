import type { AgentMessage } from "@agents/types";

const MONTH_RE =
  /^(?:y\s+en\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s*[?!.]*)$/i;

/**
 * Very short user messages that only shift the calendar month ("y en marzo?")
 * after a prior quantitative business turn. The skill selector model often
 * returns `none` because it only sees this fragment — use history + this regex
 * to keep `company-data` active.
 */
export function isShortMonthPeriodFollowUp(raw: string): boolean {
  let t = raw.trim();
  if (t.length === 0 || t.length > 48) return false;
  t = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^¿+\s*/, "")
    .trim();
  return MONTH_RE.test(t);
}

export function recentMessagesSuggestCompanyData(
  messages: readonly AgentMessage[]
): boolean {
  const text = messages
    .map((m) => {
      if (m.role !== "user" && m.role !== "assistant") return "";
      return m.content;
    })
    .join("\n")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\bleads?\b/.test(text)) return true;
  if (/total\s+de\s+leads|leads\s+creados|\|\s*leads/.test(text)) return true;
  if (
    /(cuantos|cuantas|cuántos|cuántas|cuanto|cuánto)\b/.test(text) &&
    /\b(leads?|propiedades|citas|deals?|usuarios|mensajes|inmuebles)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (/\b(kpis?|metricas?|funnel|conversion|conversión)\b/.test(text)) {
    return true;
  }
  return false;
}
