/**
 * Avance E2E post-intake, compartido entre canales.
 *
 * En el laboratorio E2E, completar el intake de un caso conversacional debe
 * disparar automáticamente el primer tick operativo (solicitud de documentos).
 * Esa lógica vivía dentro del webhook de Telegram; aquí queda como núcleo
 * agnóstico de canal para que chat web y Telegram avancen igual.
 *
 * Resolución unificada de contacto externo en E2E:
 *  - Si ya existe `external_contact.chat_id`, se usa ese valor.
 *  - Si no existe (o quedó en sentinel), se intenta `context.telegram_chat_id`.
 *  - Si sigue faltando y el canal es Telegram, se usa el `chatId` del operador.
 *  - Último fallback: `SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID` (envío simulado).
 */
import {
  createServerClient,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  updateOperationalCase,
} from "@agents/db";
import { runSettingsTestCaseAgentTick } from "./run-settings-test-case-tick";
import {
  operationalCaseDocumentRequestTargetFromContext,
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
  type OperationalCase,
} from "@agents/types";
import { telegramChatIdFromCase } from "./settings-test-telegram-lab";

type DbClient = ReturnType<typeof createServerClient>;

/**
 * Garantiza que el caso E2E tenga un contacto externo Telegram resolviendo en
 * orden: external_contact -> context.telegram_chat_id -> chatId del canal ->
 * sentinel de laboratorio.
 */
export async function ensureConversationalE2ELabExternalContact(
  db: DbClient,
  opCase: OperationalCase,
  chatId?: number
): Promise<OperationalCase> {
  if (opCase.context_jsonb?.e2e_controlled !== true) return opCase;
  const requestTarget = operationalCaseDocumentRequestTargetFromContext(
    opCase.context_jsonb
  );
  if (requestTarget !== "external_contact") return opCase;
  const context =
    opCase.context_jsonb && typeof opCase.context_jsonb === "object"
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
  const resolvedChatId =
    telegramChatIdFromCase(opCase, context) ??
    (typeof chatId === "number" && Number.isFinite(chatId) && chatId > 0
      ? chatId
      : SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID);
  const external = opCase.external_contact_jsonb ?? {};
  if (
    external.channel === "telegram" &&
    String(external.chat_id ?? "") === String(resolvedChatId)
  ) {
    return opCase;
  }
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    externalContact: {
      ...external,
      channel: "telegram",
      chat_id: resolvedChatId,
      display_name:
        typeof external.display_name === "string" && external.display_name.trim()
          ? external.display_name
          : "Contacto de prueba E2E",
    },
  });
  return updated ?? opCase;
}

/**
 * Si el caso E2E acaba de quedar en `awaiting_documents` y aún no se solicitaron
 * documentos, ejecuta el primer tick operativo automáticamente. Devuelve `true`
 * sólo si efectivamente avanzó.
 */
export async function maybeRunPostIntakeConversationalE2ETick(params: {
  db: DbClient;
  opCase: OperationalCase | null;
  userId: string;
  channel: "web" | "telegram";
  /** Chat del operador (Telegram) usado como contacto externo simulado. */
  chatId?: number;
}): Promise<boolean> {
  const { db, opCase, userId, channel, chatId } = params;
  if (!opCase || opCase.context_jsonb?.e2e_controlled !== true) {
    return false;
  }
  const fresh = await getOperationalCase(db, opCase.id);
  if (
    !fresh ||
    fresh.user_id !== userId ||
    fresh.context_jsonb?.created_from !== "agent_conversation" ||
    fresh.context_jsonb?.e2e_controlled !== true ||
    fresh.status !== "active" ||
    fresh.current_step !== "awaiting_documents"
  ) {
    return false;
  }
  const events = await getRecentOperationalCaseEvents(db, fresh.id, 30);
  const alreadyRequestedDocuments = events.some((event) => {
    const payload = event.payload_jsonb;
    return (
      event.event_type === "reminder_sent" &&
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).purpose === "initial_request"
    );
  });
  if (alreadyRequestedDocuments) return false;

  const wired = await ensureConversationalE2ELabExternalContact(db, fresh, chatId);

  await runSettingsTestCaseAgentTick(db, wired, userId, {
    source:
      channel === "telegram"
        ? "telegram_webhook_conversational_e2e_post_intake"
        : "web_conversational_e2e_post_intake",
  });
  return true;
}
