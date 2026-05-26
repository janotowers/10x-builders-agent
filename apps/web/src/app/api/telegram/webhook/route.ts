import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import {
  CASE_DOCUMENTS_BUCKET,
  createServerClient,
  createOperationalCaseDocument,
  decryptToken,
  getPendingToolCall,
  getGoogleCalendarAccessToken,
  associateExternalResponseWithCase,
  findOperationalCaseByExternalChatId,
  getOperationalCase,
  listInternalUserNotifications,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import {
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramMessage,
  withTypingHeartbeat,
} from "@/lib/telegram/send-message";
import { maybeCatchUpFlush, fireAndForgetFlush } from "@/lib/memory/trigger";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { parsePriceApprovalDecision } from "@/lib/business-decisions/price-approval";
import { businessDecisionHandler } from "@/lib/business-decisions/registry";
import {
  isSettingsTestCase,
  runSettingsTestCaseAgentTick,
} from "@/lib/operational-cases/run-settings-test-case-tick";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

function safePathSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

function extensionFromPath(filePath: string, fallback = "bin") {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

function inferDocumentKind(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/descripcion|descriptiva|metraje|superficie|escritura/.test(normalized)) {
    return "escritura_descripcion";
  }
  if (/predial/.test(normalized)) return "predial";
  if (/\bine\b|identificacion|identidad/.test(normalized)) return "ine";
  if (/comprobante|domicilio/.test(normalized)) return "comprobante_domicilio";
  if (/boleta|registral|folio real/.test(normalized)) return "boleta_registral";
  return "unknown";
}

function bestTelegramMedia(message: NonNullable<TelegramUpdate["message"]>) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id,
      originalName: message.document.file_name ?? "telegram-document",
      contentType: message.document.mime_type ?? "application/octet-stream",
      fileSize: message.document.file_size ?? null,
      fallbackExtension: "bin",
    };
  }
  if (message.photo?.length) {
    const photo = [...message.photo].sort(
      (a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height)
    )[0];
    return {
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
      originalName: "telegram-photo.jpg",
      contentType: "image/jpeg",
      fileSize: photo.file_size ?? null,
      fallbackExtension: "jpg",
    };
  }
  return null;
}

function parseBotCommand(messageText: string): {
  command: string;
  args: string;
} {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    }
  );
}

async function resumeAgentFromCallback(
  db: ReturnType<typeof createServerClient>,
  toolCallId: string,
  action: "approve" | "reject"
) {
  const toolCall = await getPendingToolCall(db, toolCallId);
  if (!toolCall) return { ok: false, message: "Esta confirmación ya fue procesada o expiró. Envía el comando de nuevo si aún la necesitas." };
  const { data: session } = await db
    .from("agent_sessions")
    .select("id, user_id")
    .eq("id", toolCall.session_id)
    .single();
  if (!session) return { ok: false, message: "Session not found" };

  const userId = session.user_id as string;
  const { data: profile } = await db
    .from("profiles")
    .select(
      "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
    )
    .eq("id", userId)
    .single();
  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: skillSettings } = await db
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  const githubIntegration = integrations?.find(
    (i: Record<string, unknown>) =>
      i.provider === "github" && i.status === "active"
  );
  let githubToken: string | undefined;
  if (githubIntegration?.encrypted_tokens) {
    try {
      githubToken = decryptToken(githubIntegration.encrypted_tokens as string);
    } catch (e) {
      console.error("Failed to decrypt GitHub token:", e);
    }
  }
  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;

  const { data: pendingMsg } = await db
    .from("agent_messages")
    .select("structured_payload")
    .eq("session_id", toolCall.session_id)
    .not("structured_payload", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);
  const spEntry = pendingMsg?.find(
    (m) =>
      (m.structured_payload as Record<string, unknown>)?.type ===
      "pending_confirmation"
  );
  const storedCheckpointThreadId = (
    spEntry?.structured_payload as {
      pendingConfirmation?: { checkpointThreadId?: string };
    }
  )?.pendingConfirmation?.checkpointThreadId;

  const result = await runAgent({
    resumeDecision: action,
    checkpointThreadId: storedCheckpointThreadId,
    turnId: (toolCall.turn_id as string | null) ?? undefined,
    userId,
    sessionId: session.id as string,
    systemPrompt:
      (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
    db,
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })),
    enabledSkills: (skillSettings ?? []).map((s: Record<string, unknown>) => ({
      id: s.id as string,
      user_id: s.user_id as string,
      skill_id: s.skill_id as string,
      enabled: s.enabled as boolean,
      config_json: (s.config_json as Record<string, unknown>) ?? {},
    })),
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })),
    githubToken,
    userTimezone: (profile?.timezone as string) ?? undefined,
    userName: (profile?.name as string | null) ?? null,
    userEmail: (profile?.email as string | null) ?? null,
    userPhone: (profile?.phone as string | null) ?? null,
    businessBrain:
      (profile?.business_brain as Record<string, unknown> | null) ?? {},
    isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
    channel: "telegram",
    googleCalendarAccessToken,
  });

  return {
    ok: true,
    message: result.pendingConfirmation ? null : result.response,
    pendingConfirmation: result.pendingConfirmation,
  };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureAgentToolDepsWired();
  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, targetId] = cb.data.split(":");

    if (!targetId) {
      await answerCallbackQuery(cb.id, "Datos inválidos");
      return NextResponse.json({ ok: true });
    }

    // Resolve user from telegram
    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("user_id")
      .eq("telegram_user_id", cb.from.id)
      .single();

    if (!telegramAccount) {
      await answerCallbackQuery(cb.id, "Cuenta no vinculada");
      return NextResponse.json({ ok: true });
    }

    const userId = telegramAccount.user_id as string;
    if (action === "price_approve" || action === "price_reject") {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId,
        notificationId: targetId,
        text: action === "price_approve" ? "APROBAR PRECIO" : "RECHAZAR PRECIO",
      });
      await answerCallbackQuery(
        cb.id,
        result.ok
          ? action === "price_approve"
            ? "Precio aprobado"
            : "Precio rechazado"
          : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procese tu decision de precio."
            : "No pude procesar la decision de precio.")
      );
      return NextResponse.json({
        ok: true,
        routed: "price_approval",
        notification_id: targetId,
      });
    }

    if (action === "price_adjust") {
      await answerCallbackQuery(cb.id, "Envia el ajuste para aprobar");
      await sendTelegramMessage(
        cb.message.chat.id,
        "Claro. Respondeme con los montos para ajustar y aprobar, por ejemplo:\nAJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000"
      );
      return NextResponse.json({
        ok: true,
        routed: "price_adjust_guidance",
        notification_id: targetId,
      });
    }

    if (action === "approve") {
      await answerCallbackQuery(cb.id, "✅ Aprobado");
      await sendTelegramMessage(cb.message.chat.id, "Acción aprobada. Procesando...");
      const result = await withTypingHeartbeat(cb.message.chat.id, () =>
        resumeAgentFromCallback(db, targetId, "approve")
      );
      if (result.pendingConfirmation) {
        const pc = result.pendingConfirmation;
        await sendTelegramMessage(cb.message.chat.id, pc.message, {
          inline_keyboard: [
            [
              {
                text: "✅ Aprobar",
                callback_data: `approve:${pc.toolCallId}`,
              },
              {
                text: "❌ Cancelar",
                callback_data: `reject:${pc.toolCallId}`,
              },
            ],
          ],
        });
      } else {
        await sendTelegramMessage(cb.message.chat.id, result.message ?? "Hecho.");
      }
    } else if (action === "reject") {
      await answerCallbackQuery(cb.id, "❌ Cancelado");
      await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
      const result = await resumeAgentFromCallback(db, targetId, "reject");
      if (result.message) {
        await sendTelegramMessage(cb.message.chat.id, result.message);
      }
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? "").trim();
  const { command, args } = parseBotCommand(text);

  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(
        chatId,
        "Código inválido o expirado. Genera uno nuevo desde la web."
      );
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(
      chatId,
      "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo."
    );
    return NextResponse.json({ ok: true });
  }

  // ── Operational case external responder ────────────────────────────
  // Si este chat_id es el contacto externo de un caso esperando respuesta
  // (waiting_external), no es un usuario de Gu OS sino, p.ej., el dueño de
  // una propiedad. Asociamos su mensaje al caso y disparamos procesamiento
  // en el siguiente tick del cron — sin pasar por el flujo /link.
  try {
    const matchedCase = await findOperationalCaseByExternalChatId(
      db,
      "telegram",
      chatId
    );
    if (matchedCase) {
      const media = bestTelegramMedia(message);
      let documentPayload:
        | {
            document_id: string;
            kind: string;
            storage_bucket: string;
            storage_path: string;
            original_name: string;
            content_type: string;
            sha256: string;
          }
        | null = null;
      if (media) {
        const fileInfo = await getTelegramFile(media.fileId);
        const bytes = Buffer.from(await downloadTelegramFile(fileInfo.file_path!));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const kind = inferDocumentKind(text);
        const extension = extensionFromPath(fileInfo.file_path!, media.fallbackExtension);
        const storagePath = `${matchedCase.user_id}/${matchedCase.id}/${randomUUID()}-${safePathSegment(
          media.originalName.replace(/\.[^.]+$/, "")
        )}.${extension}`;
        const { error: uploadError } = await db.storage
          .from(CASE_DOCUMENTS_BUCKET)
          .upload(storagePath, bytes, {
            contentType: media.contentType,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        const doc = await createOperationalCaseDocument(db, {
          caseId: matchedCase.id,
          userId: matchedCase.user_id,
          kind,
          displayName: kind === "unknown" ? null : kind,
          storagePath,
          originalName: media.originalName,
          contentType: media.contentType,
          fileSizeBytes: media.fileSize ?? bytes.byteLength,
          sha256,
          source: "external_telegram",
          sourceMetadata: {
            message_id: message.message_id,
            from: message.from,
            telegram_file_id: media.fileId,
            telegram_file_unique_id: media.uniqueId,
            caption: text || null,
          },
          blocking: kind === "escritura_descripcion",
        });
        documentPayload = {
          document_id: doc.id,
          kind: doc.kind,
          storage_bucket: doc.storage_bucket,
          storage_path: doc.storage_path,
          original_name: media.originalName,
          content_type: media.contentType,
          sha256,
        };
      }
      await associateExternalResponseWithCase(db, {
        caseId: matchedCase.id,
        channel: "telegram",
        chatId,
        payload: {
          message_id: message.message_id,
          from: message.from,
          text,
          ...(documentPayload ? { documents: [documentPayload] } : {}),
          received_at: new Date().toISOString(),
        },
      });
      const refreshedCase = await getOperationalCase(db, matchedCase.id);
      const cannedAck = media
        ? "Recibí el archivo, gracias. Lo registro en el caso y lo paso al asesor para revisar el siguiente paso."
        : "Recibí tu mensaje, gracias. Lo paso al asesor y te confirmamos el siguiente paso pronto.";
      if (refreshedCase && isSettingsTestCase(refreshedCase)) {
        try {
          await runSettingsTestCaseAgentTick(db, refreshedCase, refreshedCase.user_id, {
            source: "telegram_webhook_settings_test",
          });
          await sendTelegramMessage(
            chatId,
            `${cannedAck}\n\n(Caso de prueba: actualiza «Preparación operativa» en Ajustes para ver property_data y el paso del caso.)`
          );
        } catch (tickError) {
          console.error(
            "[telegram-webhook] settings test case tick failed:",
            tickError
          );
          await sendTelegramMessage(chatId, cannedAck);
        }
      } else {
        // Acuse de recibo cortés al externo. El procesamiento real lo hace el
        // próximo tick del cron (≤ 1 minuto típicamente).
        await sendTelegramMessage(chatId, cannedAck);
      }
      return NextResponse.json({ ok: true, routed: "operational_case", case_id: matchedCase.id });
    }
  } catch (err) {
    console.error("[telegram-webhook] external case routing failed:", err);
    // Continuamos al flujo normal: si era un usuario, no lo bloqueamos por
    // un fallo aquí.
  }

  // Resolve user from telegram_user_id
  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  const parsedPriceDecision = parsePriceApprovalDecision(text);
  if (parsedPriceDecision.intent !== "unclear") {
    const pendingPriceApprovals = await listInternalUserNotifications(db, userId, {
      statuses: ["unread"],
      limit: 10,
    });
    const pendingPriceApproval = pendingPriceApprovals.find(
      (notification) => notification.kind === "price_approval"
    );
    if (pendingPriceApproval) {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId,
        notificationId: pendingPriceApproval.id,
        text,
      });
      await sendTelegramMessage(
        chatId,
        result.message ??
          (result.ok
            ? "Listo, procese tu decision de precio."
            : "No pude procesar la decision de precio.")
      );
      return NextResponse.json({
        ok: true,
        routed: "price_approval",
        notification_id: pendingPriceApproval.id,
      });
    }
  }

  // Get or create session
  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
    .then((r) => r.data);

  if (!session) {
    const { data } = await db
      .from("agent_sessions")
      .insert({
        user_id: userId,
        channel: "telegram",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();
    session = data;
  }

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  // Load profile, tools, integrations
  const { data: profile } = await db
    .from("profiles")
    .select(
      "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
    )
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: skillSettings } = await db
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  // Decrypt GitHub token if available
  const githubIntegration = integrations?.find(
    (i: Record<string, unknown>) =>
      i.provider === "github" && i.status === "active"
  );
  let githubToken: string | undefined;
  if (githubIntegration?.encrypted_tokens) {
    try {
      githubToken = decryptToken(
        githubIntegration.encrypted_tokens as string
      );
    } catch (e) {
      console.error("Failed to decrypt GitHub token:", e);
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;

  // Catch-up de memoria larga ANTES de runAgent. Ver comentario equivalente
  // en `apps/web/src/app/api/chat/route.ts`. En callbacks (resume HITL) NO
  // se ejecuta — ese branch sale mucho antes.
  await maybeCatchUpFlush({
    db,
    userId,
    sessionId: session.id,
    channel: "telegram",
  });

  try {
    const result = await withTypingHeartbeat(chatId, () =>
      runAgent({
        message: text,
        userId,
        sessionId: session.id,
        systemPrompt:
          profile?.agent_system_prompt ?? "Eres un asistente útil.",
        db,
        enabledTools: (toolSettings ?? []).map(
          (t: Record<string, unknown>) => ({
            id: t.id as string,
            user_id: t.user_id as string,
            tool_id: t.tool_id as string,
            enabled: t.enabled as boolean,
            config_json: (t.config_json as Record<string, unknown>) ?? {},
          })
        ),
        enabledSkills: (skillSettings ?? []).map(
          (s: Record<string, unknown>) => ({
            id: s.id as string,
            user_id: s.user_id as string,
            skill_id: s.skill_id as string,
            enabled: s.enabled as boolean,
            config_json: (s.config_json as Record<string, unknown>) ?? {},
          })
        ),
        integrations: (integrations ?? []).map(
          (i: Record<string, unknown>) => ({
            id: i.id as string,
            user_id: i.user_id as string,
            provider: i.provider as string,
            scopes: (i.scopes as string[]) ?? [],
            status: i.status as "active" | "revoked" | "expired",
            created_at: i.created_at as string,
          })
        ),
        githubToken,
        userTimezone: profile?.timezone as string | undefined,
        userName: (profile?.name as string | null) ?? null,
        userEmail: (profile?.email as string | null) ?? null,
        userPhone: (profile?.phone as string | null) ?? null,
        businessBrain:
          (profile?.business_brain as Record<string, unknown> | null) ?? {},
        isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
        channel: "telegram",
        googleCalendarAccessToken,
      })
    );

    if (result.pendingConfirmation) {
      const pc = result.pendingConfirmation;
      await sendTelegramMessage(chatId, pc.message, {
        inline_keyboard: [
          [
            {
              text: "✅ Aprobar",
              callback_data: `approve:${pc.toolCallId}`,
            },
            {
              text: "❌ Cancelar",
              callback_data: `reject:${pc.toolCallId}`,
            },
          ],
        ],
      });
    } else {
      await sendTelegramMessage(chatId, result.response);
      // Flush POST fire-and-forget: solo si el turno cerró limpio.
      // Callbacks (resume HITL) no entran aquí — ese branch retorna antes.
      fireAndForgetFlush({
        db,
        userId,
        sessionId: session.id,
        memoryFlushPending: result.memoryFlushPending,
      });
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(
      chatId,
      "Hubo un error procesando tu mensaje. Intenta de nuevo."
    );
  }

  return NextResponse.json({ ok: true });
}
