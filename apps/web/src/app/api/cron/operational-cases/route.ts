/**
 * POST /api/cron/operational-cases
 *
 * Procesa casos operacionales vencidos. Llamado periódicamente (Supabase Cron
 * vía pg_cron + pg_net, o un scheduler externo).
 *
 * Pasos por tick:
 *   1. Lee casos donde next_action_at <= now() y status in (active,
 *      waiting_internal, waiting_external) — `getDueOperationalCases`.
 *   2. Para cada caso, intenta tomar el lock optimista (`markCaseProcessing`).
 *      Si otro worker se adelantó, lo salta.
 *   3. Crea/recupera una sesión persistente para el caso (canal `case_runner`).
 *   4. Invoca `runAgent` con `caseId`. El runtime hace binding directo a la
 *      skill del case_type y le inyecta el bloque [Caso operacional].
 *   5. Loguea resultado. El agente es responsable de actualizar el estado del
 *      caso e insertar eventos via tools.
 *
 * Auth: Bearer token en Authorization que coincide con `CRON_SECRET`. La
 * ruta está excluida del middleware de sesión Supabase (igual que otras
 * rutas de cron).
 *
 * Concurrencia: limitada por OPERATIONAL_CASES_CONCURRENCY (default 5) para
 * evitar quemar tokens / throttle del LLM si hay muchos casos vencidos.
 */
import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  getProfile,
  getUserToolSettings,
  getUserSkillSettings,
  getUserIntegrations,
  getGoogleCalendarAccessToken,
  getDueOperationalCases,
  getOperationalCase,
  listDueExternalContactNotifications,
  listDueInternalUserNotifications,
  insertOperationalCaseEvent,
  markExternalContactNotificationFailed,
  markExternalContactNotificationSent,
  markInternalNotificationReminderSent,
  expireExternalContactNotification,
  expireExternalContactNotificationsForCase,
  markCaseProcessing,
  updateOperationalCase,
  getOrCreateSession,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import type {
  ExternalContactNotification,
  InternalUserNotification,
  OperationalCase,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { notify } from "@/lib/notify";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import { reminderCooldownHoursForNotificationKind } from "@/lib/internal-notifications/registry";
import { reminderCooldownHoursForEngagement } from "@/lib/engagement-policies/registry";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

const DEFAULT_CONCURRENCY = 5;

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return CRON_SECRET.length > 0 && token === CRON_SECRET;
}

interface CaseProcessResult {
  case_id: string;
  status: "ok" | "skipped" | "error";
  error?: string;
}

/**
 * Construye el "mensaje" sintético que se le pasa al agente cuando lo invoca
 * el cron. No es un mensaje del usuario; es un disparador. La instrucción
 * se mantiene corta porque el bloque [Caso operacional] (que se inyecta en
 * el system prompt) ya tiene todo el contexto.
 */
function buildCaseTickMessage(opCase: OperationalCase): string {
  return [
    `Tick de procesamiento del caso operacional ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    "Lee el bloque [Caso operacional activo] del system prompt y decide la siguiente acción siguiendo la skill activa. Si necesitas comunicarte con el humano externo o interno, usa las tools correspondientes. Cuando avances un paso, actualiza el caso con la tool de update y registra el evento.",
  ].join(" ");
}

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

function shouldSendInternalReminder(notification: InternalUserNotification) {
  const lastReminder = notification.metadata_jsonb?.last_reminder_at;
  if (typeof lastReminder !== "string") return true;
  const cooldownHours = reminderCooldownHoursForNotificationKind(
    notification.kind
  );
  // TODO: make reminder cadence configurable by user, notification kind,
  // priority, working hours, and the user's timezone.
  return (
    Date.now() - new Date(lastReminder).getTime() >
    cooldownHours * 60 * 60_000
  );
}

async function processInternalNotificationReminder(
  db: ReturnType<typeof createServerClient>,
  notification: InternalUserNotification
) {
  if (!shouldSendInternalReminder(notification)) return "cooldown";
  await notify(
    db,
    notification.user_id,
    {
      text: `Recordatorio: ${notification.title}\n\n${notification.body}`,
      kind: "internal_notification_reminder",
      data: {
        case_id: notification.case_id ?? undefined,
        title: `Recordatorio: ${notification.title}`,
        source_notification_id: notification.id,
      },
    },
    notification.priority
  );
  await markInternalNotificationReminderSent(db, notification);
  if (notification.case_id) {
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source: "internal_user_notifications",
        notification_id: notification.id,
      },
    });
  }
  return "reminded";
}

async function processExternalContactReminder(
  db: ReturnType<typeof createServerClient>,
  notification: ExternalContactNotification
) {
  if (notification.case_id) {
    const opCase = await getOperationalCase(db, notification.case_id);
    if (opCase && isSettingsTestCase(opCase)) {
      await expireExternalContactNotification(db, notification.id);
      return "skipped_settings_test";
    }
  }

  if (notification.attempt_count >= notification.max_attempts) {
    await expireExternalContactNotification(db, notification.id);
    await notify(
      db,
      notification.user_id,
      {
        text:
          "Un contacto externo no respondio despues del maximo de recordatorios. " +
          `Caso: ${notification.case_id}. Canal: ${notification.channel}.`,
        kind: "external_contact_escalation",
        data: {
          case_id: notification.case_id,
          title: "Contacto externo sin respuesta",
          external_notification_id: notification.id,
        },
      },
      "high"
    );
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "escalated",
      actor: "system",
      payload: {
        source: "external_contact_notifications",
        notification_id: notification.id,
        reason: "max_attempts_reached",
      },
    });
    return "expired_escalated";
  }

  if (notification.channel !== "telegram") return "unsupported_channel";
  try {
    await sendTelegramMessage(
      Number(notification.recipient_identifier),
      truncateTelegramText(notification.message_body),
      undefined,
      { throwOnError: true }
    );
    await markExternalContactNotificationSent(
      db,
      notification,
      hoursFromNow(
        reminderCooldownHoursForEngagement({
          audience: "external_contact",
          intent: "reminder",
          channel: notification.channel,
          kind:
            typeof notification.metadata_jsonb?.kind === "string"
              ? notification.metadata_jsonb.kind
              : "external_contact_reminder",
        })
      )
    );
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source: "external_contact_notifications",
        notification_id: notification.id,
        channel: notification.channel,
        attempt: notification.attempt_count + 1,
      },
    });
    return "sent";
  } catch (error) {
    await markExternalContactNotificationFailed(
      db,
      notification.id,
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
}

async function processNotificationReminders(
  db: ReturnType<typeof createServerClient>
) {
  const [internalDue, externalDue] = await Promise.all([
    listDueInternalUserNotifications(db, { limit: 50 }),
    listDueExternalContactNotifications(db, { limit: 50 }),
  ]);
  const internalResults = [];
  for (const notification of internalDue) {
    internalResults.push(await processInternalNotificationReminder(db, notification));
  }
  const externalResults = [];
  for (const notification of externalDue) {
    externalResults.push(await processExternalContactReminder(db, notification));
  }
  return { internal: internalResults, external: externalResults };
}

async function processCase(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<CaseProcessResult> {
  const locked = await markCaseProcessing(db, opCase.id, opCase.version);
  if (!locked) {
    return { case_id: opCase.id, status: "skipped" };
  }

  try {
    const profile = await getProfile(db, opCase.user_id);
    const toolSettings = await getUserToolSettings(db, opCase.user_id);
    const skillSettings = await getUserSkillSettings(db, opCase.user_id);
    const integrations = await getUserIntegrations(db, opCase.user_id);

    const githubIntegration = integrations.find(
      (i) => i.provider === "github"
    );
    let githubToken: string | undefined;
    if (githubIntegration) {
      const raw = (githubIntegration as unknown as {
        encrypted_tokens?: string;
      }).encrypted_tokens;
      if (raw) {
        try {
          githubToken = decryptToken(raw);
        } catch {
          // No GitHub token available
        }
      }
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, opCase.user_id)) ?? undefined;

    // Una sesión persistente por caso (canal case_runner). Como
    // getOrCreateSession busca por (user_id, channel) y devuelve la activa,
    // si quisiéramos una sesión por caso necesitaríamos cambiar la query.
    // Por ahora compartimos sesión `case_runner` por usuario y diferenciamos
    // por turn_id; basta para auditoría inicial. Cuando haya volumen, se
    // particiona por case_id (ver TODO en architecture.md sección 10).
    const session = await getOrCreateSession(db, opCase.user_id, "case_runner");

    const result = await runAgent({
      message: buildCaseTickMessage(opCase),
      userId: opCase.user_id,
      sessionId: session.id,
      systemPrompt: profile.agent_system_prompt,
      db,
      enabledTools: toolSettings,
      enabledSkills: skillSettings,
      integrations,
      githubToken,
      userTimezone: profile.timezone,
      userName: profile.name,
      userEmail: profile.email,
      userPhone: profile.phone,
      businessBrain: profile.business_brain ?? {},
      isUnggaAdmin: profile.is_ungga_admin ?? false,
      channel: "case_runner",
      googleCalendarAccessToken,
      // No autoApproveTools por defecto: las decisiones de juicio comercial
      // (precio, contrato, publicación) deben pasar por HITL aunque las
      // dispare el cron. Si el agente llega a un tool con `risk: high` que
      // requiere confirmación, el HITL queda pendiente y se notifica al
      // usuario; la próxima interacción humana lo resuelve.
      autoApproveTools: false,
      caseId: opCase.id,
    });

    console.log(
      `[ops-case-cron] case ${opCase.id} processed: response_len=${result.response?.length ?? 0} pending_confirmation=${result.pendingConfirmation ? "yes" : "no"}`
    );

    // Si el agente NO actualizó next_action_at (no movió el caso), lo
    // empujamos a +5min para que no martillemos esto cada minuto. El agente
    // bien escrito lo hace solo, pero esto es defensivo.
    const fresh = await getOperationalCase(db, opCase.id);
    if (fresh) {
      const isStillStuckAtLease =
        fresh.status === opCase.status &&
        fresh.current_step === opCase.current_step;
      if (isStillStuckAtLease) {
        await updateOperationalCase(db, fresh.id, fresh.version, {
          nextActionAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
    }

    return { case_id: opCase.id, status: "ok" };
  } catch (e) {
    const errMsg = (e as Error)?.message ?? "Unknown error";
    console.error(`[ops-case-cron] case ${opCase.id} failed:`, errMsg);
    try {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "error",
        actor: "system",
        payload: { error: errMsg.slice(0, 2000), source: "cron" },
      });
      // Defensivo: pateamos next_action_at +10 min para no martillear con
      // un caso que falla en cada tick.
      const fresh = await getOperationalCase(db, opCase.id);
      if (fresh) {
        await updateOperationalCase(db, fresh.id, fresh.version, {
          nextActionAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
    } catch (logErr) {
      console.error("[ops-case-cron] failed to record error event:", logErr);
    }
    return { case_id: opCase.id, status: "error", error: errMsg };
  }
}

async function processWithConcurrency(
  db: ReturnType<typeof createServerClient>,
  cases: OperationalCase[],
  concurrency: number
): Promise<CaseProcessResult[]> {
  const results: CaseProcessResult[] = [];
  const queue = [...cases];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const r = await processCase(db, next);
      results.push(r);
    }
  });
  await Promise.all(workers);
  return results;
}

function isSettingsTestCase(opCase: OperationalCase): boolean {
  return (
    opCase.context_jsonb?.created_from === "case_type_settings_test" ||
    opCase.context_jsonb?.test_mode === true
  );
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureAgentToolDepsWired();
  const db = createServerClient();

  let notificationReminderResults: Awaited<
    ReturnType<typeof processNotificationReminders>
  > = { internal: [], external: [] };
  try {
    notificationReminderResults = await processNotificationReminders(db);
  } catch (e) {
    console.error("[ops-case-cron] notification reminders failed:", e);
  }

  let dueCases: OperationalCase[] = [];
  try {
    dueCases = await getDueOperationalCases(db, { limit: 100 });
  } catch (e) {
    console.error("[ops-case-cron] getDueOperationalCases failed:", e);
    return NextResponse.json(
      { error: "Failed to read operational cases" },
      { status: 500 }
    );
  }

  const settingsTestCases = dueCases.filter(isSettingsTestCase);
  if (settingsTestCases.length > 0) {
    for (const opCase of settingsTestCases) {
      try {
        await expireExternalContactNotificationsForCase(db, opCase.id);
        await updateOperationalCase(db, opCase.id, opCase.version, {
          status: "paused",
          nextActionAt: null,
          context: {
            ...(opCase.context_jsonb ?? {}),
            controlled_test_status: "paused_by_cron_guard",
            controlled_test_note:
              "El cron no continua casos de prueba creados desde Settings.",
          },
        });
      } catch (error) {
        console.warn(
          `[ops-case-cron] failed to pause settings test case ${opCase.id}:`,
          error
        );
      }
    }
  }

  dueCases = dueCases.filter((opCase) => !isSettingsTestCase(opCase));

  if (dueCases.length === 0) {
    return NextResponse.json({
      processed: 0,
      results: [],
      skipped_settings_test_cases: settingsTestCases.length,
      notification_reminders: notificationReminderResults,
    });
  }

  const concurrencyEnv = process.env.OPERATIONAL_CASES_CONCURRENCY?.trim();
  const concurrency =
    concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
      ? Math.max(1, Math.min(20, Math.floor(Number(concurrencyEnv))))
      : DEFAULT_CONCURRENCY;

  const results = await processWithConcurrency(db, dueCases, concurrency);

  console.log(
    `[ops-case-cron] processed ${results.length}/${dueCases.length} cases (concurrency=${concurrency}):`,
    results.map((r) => `${r.case_id}=${r.status}`).join(", ")
  );

  return NextResponse.json({
    processed: results.length,
    results,
    skipped_settings_test_cases: settingsTestCases.length,
    notification_reminders: notificationReminderResults,
  });
}
