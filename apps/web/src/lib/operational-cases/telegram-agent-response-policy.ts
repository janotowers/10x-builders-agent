export function shouldSendTelegramAgentResponse(params: {
  response: string | null | undefined;
  toolCalls: string[] | null | undefined;
  hasConversationalCase: boolean;
}): boolean {
  const response = typeof params.response === "string" ? params.response.trim() : "";
  if (!response) return false;

  if (!params.hasConversationalCase) return true;

  const normalizedToolCalls = new Set(
    (params.toolCalls ?? [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  );

  // En turnos operacionales, notify_user ya envía el texto final al asesor.
  // Evita duplicar otro mensaje conversacional de cierre en Telegram.
  if (normalizedToolCalls.has("notify_user")) return false;

  return true;
}
