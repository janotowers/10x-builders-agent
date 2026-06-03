import {
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
  type OperationalCase,
  type OperationalCaseExternalContact,
} from "@agents/types";
import type { DbClient } from "@agents/db";
import { updateOperationalCase } from "@agents/db";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSettingsOperationalTestCase(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!context) return false;
  return (
    context.created_from === "case_type_settings_test" &&
    (context.test_mode === true || context.test_mode === "true")
  );
}

export function telegramChatIdFromCase(
  opCase: OperationalCase,
  context: Record<string, unknown>
): number | null {
  const external = isRecord(opCase.external_contact_jsonb)
    ? opCase.external_contact_jsonb
    : {};
  const fromExternal = external.chat_id;
  if (typeof fromExternal === "number" && Number.isFinite(fromExternal) && fromExternal > 0) {
    return fromExternal;
  }
  const fromContext = context.telegram_chat_id ?? context.external_chat_id;
  if (typeof fromContext === "number" && Number.isFinite(fromContext) && fromContext > 0) {
    return fromContext;
  }
  if (typeof fromContext === "string" && fromContext.trim()) {
    const parsed = Number(fromContext);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function shouldSimulateSettingsTestTelegram(params: {
  chatId: number;
  toolCallSource?: string;
}): boolean {
  if (params.toolCallSource !== "skill_test" && params.toolCallSource !== "step_test") {
    return false;
  }
  if (params.chatId === SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID) return true;
  return !Number.isFinite(params.chatId) || params.chatId <= 0;
}

/** Chat id que el agente debe usar en N3/N4: real del caso o sentinel de laboratorio. */
export function settingsTestTelegramChatIdForAgent(
  opCase: OperationalCase,
  context: Record<string, unknown>
): number {
  return (
    telegramChatIdFromCase(opCase, context) ?? SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID
  );
}

export async function ensureSettingsTestExternalContact(
  db: DbClient,
  opCase: OperationalCase
): Promise<OperationalCase> {
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  if (!isSettingsOperationalTestCase(context)) return opCase;

  const chatId = settingsTestTelegramChatIdForAgent(opCase, context);
  const existing = isRecord(opCase.external_contact_jsonb)
    ? opCase.external_contact_jsonb
    : {};
  const displayName =
    (typeof existing.display_name === "string" && existing.display_name.trim()) ||
    (typeof context.owner_name === "string" && context.owner_name.trim()) ||
    (typeof context.lead_name === "string" && context.lead_name.trim()) ||
    "Contacto de prueba";

  if (
    existing.channel === "telegram" &&
    existing.chat_id === chatId &&
    existing.display_name === displayName
  ) {
    return opCase;
  }

  const externalContact: OperationalCaseExternalContact = {
    channel: "telegram",
    chat_id: chatId,
    display_name: displayName,
  };

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    externalContact,
  });
  return updated ?? opCase;
}
