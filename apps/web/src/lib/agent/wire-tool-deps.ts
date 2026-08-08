/**
 * Wires the dependencies that `packages/agent/src/tools/adapters.ts`
 * cannot import directly (they live in `apps/web` because they touch
 * Next.js / fetch that targets local routes).
 *
 * Idempotent: safe to call from every route handler that invokes runAgent.
 * The first call sets the deps; subsequent calls overwrite with the same
 * values (or with newer implementations during a hot reload in dev).
 */
import { setBuildLangChainToolsDeps } from "@agents/agent";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import type { NotifyResult } from "@/lib/notify";
import type { DbClient } from "@agents/db";
import { notifyUserRespectingActiveInternalChannel } from "@/lib/operational-cases/deliver-internal-case-follow-up";
import { executeGmailSendTool } from "@/lib/gmail/tool-executor";

let wired = false;

export function ensureAgentToolDepsWired(): void {
  if (wired) return;
  wired = true;
  setBuildLangChainToolsDeps({
    notifyUser: async (
      db: DbClient,
      userId: string,
      payload: { text: string; kind?: string; data?: Record<string, unknown> },
      urgency?: "low" | "normal" | "high"
    ): Promise<NotifyResult> => {
      // Paridad Web ↔ Telegram: follow-ups de caso van al canal activo.
      return notifyUserRespectingActiveInternalChannel(
        db,
        userId,
        payload,
        urgency ?? "normal"
      );
    },
    sendTelegramMessage: async (chatId: number, text: string) => {
      await sendTelegramMessage(chatId, text, undefined, { throwOnError: true });
    },
    sendGmailMessage: async (params) =>
      executeGmailSendTool({
        db: params.db,
        userId: params.userId,
        to: params.to,
        subject: params.subject,
        body: params.body,
        documents: params.documents,
      }),
  });
}
