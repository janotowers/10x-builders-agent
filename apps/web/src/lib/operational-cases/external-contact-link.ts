/**
 * Vinculación de contacto externo (dueño/propietario) a un caso operativo vía
 * deep link de Telegram, para casos Real.
 *
 * Flujo:
 *  1. El asesor elige «externo» y el caso aún no tiene contacto verificado.
 *  2. `beginExternalContactLink` genera un token y deja el caso en
 *     `external_contact_setup_status = "pending"`.
 *  3. El asesor reenvía el deep link `t.me/<bot>?start=ec_<token>` al contacto.
 *  4. El contacto abre el enlace → el webhook (`/start ec_<token>`) llama a
 *     `verifyExternalContactLink`, que cablea su `chat_id` en el caso, lo marca
 *     verificado y deja `document_request_target = external_contact`.
 *  5. El pipeline existente (cron/agente + "external responder") solicita los
 *     documentos al contacto y procesa sus respuestas.
 *
 * No envía mensajes: sólo toca DB y compone texto. El envío vive en los
 * adapters de canal (webhook de Telegram / chat web).
 */
import { randomBytes } from "node:crypto";
import {
  createExternalContactLinkToken,
  getExternalContactLinkTokenByToken,
  getOperationalCase,
  insertOperationalCaseEvent,
  markExternalContactLinkTokenUsed,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { recordStepBranchSelected } from "./step-branch-selected";

export const EXTERNAL_CONTACT_LINK_PREFIX = "ec_";
export const EXTERNAL_CONTACT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function caseContext(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb && typeof opCase.context_jsonb === "object"
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

export function generateExternalContactLinkTokenValue(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Extrae el token de un payload de `/start` (p. ej. "ec_ab12…"). Devuelve `null`
 * si no es un payload de contacto externo válido.
 */
export function parseExternalContactLinkPayload(
  args: string | null | undefined
): string | null {
  if (!args) return null;
  const trimmed = args.trim();
  if (!trimmed.startsWith(EXTERNAL_CONTACT_LINK_PREFIX)) return null;
  const token = trimmed.slice(EXTERNAL_CONTACT_LINK_PREFIX.length).trim();
  return /^[a-f0-9]{8,}$/i.test(token) ? token : null;
}

/**
 * Genera el token de vinculación y deja el caso en setup pendiente. No avanza el
 * estado operativo: el caso sigue donde estaba hasta que el contacto se vincule.
 */
export async function beginExternalContactLink(
  db: DbClient,
  opCase: OperationalCase
): Promise<{ updatedCase: OperationalCase; token: string }> {
  const token = generateExternalContactLinkTokenValue();
  const expiresAt = new Date(Date.now() + EXTERNAL_CONTACT_LINK_TTL_MS).toISOString();
  await createExternalContactLinkToken(db, {
    caseId: opCase.id,
    userId: opCase.user_id,
    token,
    expiresAt,
  });
  const now = new Date().toISOString();
  const updatedCase =
    (await updateOperationalCase(db, opCase.id, opCase.version, {
      context: {
        ...caseContext(opCase),
        external_contact_setup_status: "pending",
        external_contact_setup_requested_at: now,
      },
    })) ?? opCase;
  return { updatedCase, token };
}

let cachedBotUsername: string | null = null;

/**
 * Resuelve el @username del bot para construir el deep link. Prefiere
 * `TELEGRAM_BOT_USERNAME`; si falta, consulta `getMe` una vez y cachea.
 */
export async function getTelegramBotUsername(): Promise<string | null> {
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "").trim();
  if (fromEnv) return fromEnv;
  if (cachedBotUsername) return cachedBotUsername;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      result?: { username?: unknown };
    };
    const username = data?.result?.username;
    if (typeof username === "string" && username.trim()) {
      cachedBotUsername = username.trim();
      return cachedBotUsername;
    }
  } catch (error) {
    console.warn("[external-contact-link] getMe failed:", error);
  }
  return null;
}

export async function buildExternalContactDeepLink(
  token: string
): Promise<string | null> {
  const username = await getTelegramBotUsername();
  if (!username) return null;
  return `https://t.me/${username}?start=${EXTERNAL_CONTACT_LINK_PREFIX}${token}`;
}

/**
 * Mensaje para el asesor cuando eligió «externo» sin contacto verificado:
 * incluye el deep link a reenviar, o un fallback honesto si no se pudo generar.
 */
export function buildExternalContactSetupMessage(params: {
  deepLink: string | null;
}): string {
  if (params.deepLink) {
    return [
      "Para solicitar los documentos al dueño/contacto, primero necesito vincularlo al caso.",
      "",
      "Reenvíale este enlace; al abrirlo quedará vinculado y le pediré los documentos directamente:",
      "",
      params.deepLink,
      "",
      "En cuanto se vincule te aviso. Si prefieres aportarlos tú, responde «interno».",
    ].join("\n");
  }
  return [
    "Para solicitar los documentos al dueño/contacto necesito vincularlo primero, pero no pude generar el enlace en este momento.",
    "Intenta de nuevo en unos segundos, o responde «interno» para aportarlos tú.",
  ].join("\n");
}

export interface ExternalContactLinkVerification {
  ok: boolean;
  reason?: "invalid" | "used" | "expired" | "case_missing";
  caseId?: string;
  advisorUserId?: string;
  propertyTitle?: string | null;
}

/**
 * Verifica un token de contacto externo y, si es válido, cablea el `chat_id` del
 * contacto en el caso, lo marca verificado y fija `document_request_target =
 * external_contact`, dejando el caso listo para que el pipeline solicite los
 * documentos al contacto.
 */
export async function verifyExternalContactLink(
  db: DbClient,
  params: { token: string; chatId: number; displayName: string | null }
): Promise<ExternalContactLinkVerification> {
  const record = await getExternalContactLinkTokenByToken(db, params.token);
  if (!record) return { ok: false, reason: "invalid" };
  if (record.used) return { ok: false, reason: "used" };
  if (new Date(record.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  const opCase = await getOperationalCase(db, record.case_id);
  if (!opCase) return { ok: false, reason: "case_missing" };

  const context = caseContext(opCase);
  const existingExternal =
    (opCase.external_contact_jsonb as Record<string, unknown> | null) ?? {};
  const existingDisplayName =
    typeof existingExternal.display_name === "string" &&
    existingExternal.display_name.trim()
      ? existingExternal.display_name.trim()
      : null;
  const now = new Date().toISOString();
  await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "active",
    nextActionAt: now,
    externalContact: {
      ...existingExternal,
      channel: "telegram",
      chat_id: params.chatId,
      display_name:
        params.displayName?.trim() || existingDisplayName || "Contacto externo",
    },
    context: {
      ...context,
      external_contact_status: "verified",
      external_contact_setup_status: "verified",
      document_request_target: "external_contact",
      document_request_target_decided_at: now,
      document_request_target_decided_by: "user",
    },
  });

  await markExternalContactLinkTokenUsed(db, {
    id: record.id,
    verifiedChatId: params.chatId,
  });

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "external_contact_verified",
      source: "telegram_external_contact_link",
      chat_id: params.chatId,
      token_id: record.id,
    },
  });

  const previousTarget =
    typeof context.document_request_target === "string"
      ? context.document_request_target
      : null;
  await recordStepBranchSelected({
    db,
    caseId: opCase.id,
    stepKey: opCase.current_step,
    branchValue: "external_contact",
    decidedBy: "user",
    previousValue:
      previousTarget === "internal_user" || previousTarget === "external_contact"
        ? previousTarget
        : null,
  });

  return {
    ok: true,
    caseId: opCase.id,
    advisorUserId: opCase.user_id,
    propertyTitle:
      typeof context.property_title === "string" ? context.property_title : null,
  };
}
