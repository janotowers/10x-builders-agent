/**
 * Validación N3/N4 — solicitar fotos al asesor interno (photos_requested).
 * Patrón: escenario photos_requested_request_internal_photos
 */

const BLOCKED_TOOLS = [
  "telegram_send_message_to_contact",
  "calendar_list_events",
  "calendar_create_event",
  "calendar_update_event",
] as const;

export function validatePhotosRequestedInternalOutcome(params: {
  current_step: string;
  status: string;
  toolCalls: Array<{ tool_name: string; status: string }>;
  notify_user_executed: boolean;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (params.current_step !== "photos_requested") {
    errors.push("current_step debe ser photos_requested.");
  }
  if (params.status !== "waiting_internal") {
    errors.push(
      "status debe ser waiting_internal tras solicitar fotos al asesor."
    );
  }
  if (!params.notify_user_executed) {
    errors.push("notify_user debe ejecutarse para solicitar la subida de fotos.");
  }

  const blockedExecuted = BLOCKED_TOOLS.filter((toolName) =>
    params.toolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  );
  if (blockedExecuted.length > 0) {
    errors.push(
      `No deben ejecutarse tools de contacto externo/calendario en este paso; ejecutadas de más: ${blockedExecuted.join(", ")}.`
    );
  }
  return { ok: errors.length === 0, errors };
}
