/**
 * Validación N3/N4 — proponer horarios de fotos (photos_scheduled).
 * Patrón: escenario photos_scheduled_propose_slots
 */

const CALENDAR_PUBLISH_TOOLS = [
  "calendar_create_event",
  "calendar_update_event",
] as const;

export function validatePhotosScheduledProposeSlotsOutcome(params: {
  current_step: string;
  status: string;
  toolCalls: Array<{ tool_name: string; status: string }>;
  reminder_sent_event?: boolean;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (params.current_step !== "photos_scheduled") {
    errors.push("current_step debe ser photos_scheduled.");
  }
  if (params.status !== "waiting_external") {
    errors.push(
      "status debe ser waiting_external tras proponer horarios al contacto."
    );
  }
  const listExecuted = params.toolCalls.some(
    (call) =>
      call.tool_name === "calendar_list_events" &&
      (call.status === "executed" || call.status === "pending_confirmation")
  );
  if (!listExecuted) {
    errors.push("calendar_list_events debe ejecutarse para revisar disponibilidad.");
  }
  const telegramExecuted = params.toolCalls.some(
    (call) =>
      call.tool_name === "telegram_send_message_to_contact" &&
      (call.status === "executed" || call.status === "pending_confirmation")
  );
  if (!telegramExecuted) {
    errors.push(
      "telegram_send_message_to_contact debe ejecutarse para proponer horarios."
    );
  }
  const calendarTooEarly = CALENDAR_PUBLISH_TOOLS.filter((toolName) =>
    params.toolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  );
  if (calendarTooEarly.length > 0) {
    errors.push(
      `No debe crear ni actualizar evento de calendario antes de confirmación del dueño; ejecutadas de más: ${calendarTooEarly.join(", ")}.`
    );
  }
  if (params.reminder_sent_event === false) {
    errors.push("debe existir evento reminder_sent (purpose=propose_photo_slots).");
  }
  return { ok: errors.length === 0, errors };
}
