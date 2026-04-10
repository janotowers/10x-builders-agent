import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  updateToolCallStatus,
  getPendingToolCall,
  getGoogleCalendarAccessToken,
  getProfile,
} from "@agents/db";
import {
  runAgent,
  githubApi,
  buildEventResource,
  executeCalendarCreateEvent,
  executeCalendarPatchEvent,
  executeCalendarDeleteEvent,
} from "@agents/agent";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, body);
  }
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

async function executeApprovedToolCall(
  db: ReturnType<typeof createServerClient>,
  toolCallId: string,
  userId: string
) {
  const toolCall = await getPendingToolCall(db, toolCallId);
  if (!toolCall) return { ok: false, message: "Tool call not found" };

  await updateToolCallStatus(db, toolCallId, "approved");

  const args = toolCall.arguments_json;
  const toolName = toolCall.tool_name;

  if (toolName === "github_create_issue" || toolName === "github_create_repo") {
    const { data: integration } = await db
      .from("user_integrations")
      .select("encrypted_tokens")
      .eq("user_id", userId)
      .eq("provider", "github")
      .eq("status", "active")
      .single();

    if (!integration?.encrypted_tokens) {
      await updateToolCallStatus(db, toolCallId, "failed", {
        error: "GitHub not connected",
      });
      return { ok: false, message: "GitHub no está conectado." };
    }

    const token = decryptToken(integration.encrypted_tokens as string);

    if (toolName === "github_create_issue") {
      const { status, data } = await githubApi(
        token,
        "POST",
        `/repos/${args.owner}/${args.repo}/issues`,
        { title: args.title, body: args.body ?? "" }
      );
      if (status >= 400) {
        const err = { error: "GitHub API error", status, details: data };
        await updateToolCallStatus(db, toolCallId, "failed", err);
        return { ok: false, message: `Error de GitHub (${status})` };
      }
      const created = data as Record<string, unknown>;
      const result = {
        message: "Issue creado",
        issue_url: created.html_url,
        number: created.number,
      };
      await updateToolCallStatus(db, toolCallId, "executed", result);
      return { ok: true, message: `Issue creado: ${created.html_url}` };
    }

    const isPrivate = !!(args.private ?? args.isPrivate);
    const { status, data } = await githubApi(token, "POST", "/user/repos", {
      name: args.name,
      description: args.description ?? "",
      private: isPrivate,
    });
    if (status >= 400) {
      const err = { error: "GitHub API error", status, details: data };
      await updateToolCallStatus(db, toolCallId, "failed", err);
      return { ok: false, message: `Error de GitHub (${status})` };
    }
    const created = data as Record<string, unknown>;
    const result = {
      message: "Repositorio creado",
      html_url: created.html_url,
      full_name: created.full_name,
    };
    await updateToolCallStatus(db, toolCallId, "executed", result);
    return {
      ok: true,
      message: `Repositorio creado: ${created.html_url}`,
    };
  }

  if (
    toolName === "calendar_create_event" ||
    toolName === "calendar_update_event" ||
    toolName === "calendar_delete_event"
  ) {
    const accessToken = await getGoogleCalendarAccessToken(db, userId);
    if (!accessToken) {
      await updateToolCallStatus(db, toolCallId, "failed", {
        error: "Google Calendar not connected",
      });
      return { ok: false, message: "Google Calendar no está conectado." };
    }
    const profile = await getProfile(db, userId);
    const tz = profile.timezone ?? "UTC";
    const calId = String(args.calendar_id ?? "primary");

    if (toolName === "calendar_create_event") {
      const body = buildEventResource({
        summary: String(args.summary ?? ""),
        start_datetime: String(args.start_datetime),
        end_datetime: String(args.end_datetime),
        timezone: tz,
        description: String(args.description ?? ""),
      });
      const { status, data } = await executeCalendarCreateEvent(
        accessToken,
        calId,
        body
      );
      if (status >= 400) {
        const err = { error: "Calendar API error", status, details: data };
        await updateToolCallStatus(db, toolCallId, "failed", err);
        return { ok: false, message: `Error de Calendar (${status})` };
      }
      const created = data as Record<string, unknown>;
      const result = {
        message: "Evento creado",
        htmlLink: created.htmlLink,
        id: created.id,
      };
      await updateToolCallStatus(db, toolCallId, "executed", result);
      return {
        ok: true,
        message: `Evento creado: ${created.htmlLink ?? ""}`,
      };
    }

    if (toolName === "calendar_update_event") {
      const patch: Record<string, unknown> = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.description !== undefined) patch.description = args.description;
      if (args.start_datetime && args.end_datetime) {
        patch.start = {
          dateTime: String(args.start_datetime),
          timeZone: tz,
        };
        patch.end = {
          dateTime: String(args.end_datetime),
          timeZone: tz,
        };
      }
      const { status, data } = await executeCalendarPatchEvent(
        accessToken,
        calId,
        String(args.event_id),
        patch
      );
      if (status >= 400) {
        const err = { error: "Calendar API error", status, details: data };
        await updateToolCallStatus(db, toolCallId, "failed", err);
        return { ok: false, message: `Error de Calendar (${status})` };
      }
      const updated = data as Record<string, unknown>;
      const result = {
        message: "Evento actualizado",
        htmlLink: updated.htmlLink,
        id: updated.id,
      };
      await updateToolCallStatus(db, toolCallId, "executed", result);
      return { ok: true, message: "Evento actualizado." };
    }

    const { status, data } = await executeCalendarDeleteEvent(
      accessToken,
      calId,
      String(args.event_id)
    );
    if (status >= 400 && status !== 204) {
      const err = { error: "Calendar API error", status, details: data };
      await updateToolCallStatus(db, toolCallId, "failed", err);
      return { ok: false, message: `Error de Calendar (${status})` };
    }
    const result = { message: "Evento eliminado" };
    await updateToolCallStatus(db, toolCallId, "executed", result);
    return { ok: true, message: "Evento eliminado." };
  }

  await updateToolCallStatus(db, toolCallId, "failed", {
    error: `Unknown tool: ${toolName}`,
  });
  return { ok: false, message: "Herramienta no reconocida." };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, toolCallId] = cb.data.split(":");

    if (!toolCallId) {
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

    if (action === "approve") {
      const result = await executeApprovedToolCall(
        db,
        toolCallId,
        telegramAccount.user_id
      );
      await answerCallbackQuery(
        cb.id,
        result.ok ? "Aprobado" : "Error"
      );
      await sendTelegramMessage(cb.message.chat.id, result.message);
    } else if (action === "reject") {
      await updateToolCallStatus(db, toolCallId, "rejected");
      await answerCallbackQuery(cb.id, "Rechazado");
      await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
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
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
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

  try {
    const result = await runAgent({
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
      googleCalendarAccessToken,
    });

    if (result.pendingConfirmation) {
      const pc = result.pendingConfirmation;
      await sendTelegramMessage(chatId, pc.message, {
        inline_keyboard: [
          [
            {
              text: "Aprobar",
              callback_data: `approve:${pc.toolCallId}`,
            },
            {
              text: "Cancelar",
              callback_data: `reject:${pc.toolCallId}`,
            },
          ],
        ],
      });
    } else {
      await sendTelegramMessage(chatId, result.response);
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
