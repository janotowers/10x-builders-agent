/**
 * Comparación de envíos Telegram al contacto externo (mismo turno).
 * Módulo sin dependencias de Node: usable en UI (client) y en el agente.
 */

export function normalizeTelegramSendText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/u, "");
}

function normalizedTelegramPrefix(text: unknown, maxLen = 200) {
  const normalized = normalizeTelegramSendText(text);
  return normalized.slice(0, maxLen);
}

export function telegramSendInputsMatch(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  if (
    String(left.chat_id ?? "") !== String(right.chat_id ?? "") ||
    String(left.case_id ?? "") !== String(right.case_id ?? "") ||
    String(left.purpose ?? "") !== String(right.purpose ?? "")
  ) {
    return false;
  }

  const leftNorm = normalizeTelegramSendText(left.text);
  const rightNorm = normalizeTelegramSendText(right.text);
  if (leftNorm === rightNorm) return true;

  const leftPrefix = normalizedTelegramPrefix(left.text);
  const rightPrefix = normalizedTelegramPrefix(right.text);
  if (
    leftPrefix.length >= 40 &&
    rightPrefix.length >= 40 &&
    leftPrefix === rightPrefix
  ) {
    return true;
  }

  return false;
}
