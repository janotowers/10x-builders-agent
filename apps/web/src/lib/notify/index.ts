/**
 * notify(userId, payload, urgency)
 *
 * Capa unificada para mandar al humano interno (el inmobiliario) avisos
 * proactivos del agente: recordatorios, aprobaciones pendientes, escalaciones.
 *
 * Lee `user_notification_preferences.channels_priority_jsonb` (default
 * `["web", "telegram"]`) y registra siempre una notificación web persistente:
 *
 *   - `web`: se almacena en `internal_user_notifications` como inbox/action item.
 *   - `telegram`: usa `getTelegramChatId(db, userId)` y manda con
 *     `sendTelegramMessage`.
 *
 * Urgencia:
 *   - `low` / `normal`: registra web y manda por un canal push habilitado.
 *   - `high`: registra web y manda por todos los canales habilitados.
 *
 * Devuelve un resumen de qué canales se intentaron y el resultado de cada
 * uno, para que el caller persista el evento `reminder_sent` o `escalated`
 * en `operational_case_events`.
 */
import {
  createInternalUserNotification,
  createServerClient,
  getInternalUserNotification,
  getOperationalCase,
  getPendingToolCall,
  getTelegramChatId,
  setInternalUserNotificationStatus,
  updateInternalUserNotificationChannels,
  upsertActiveInternalUserNotification,
} from "@agents/db";
import {
  sendTelegramAgentMessage,
  sendTelegramDocument,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import {
  autoStatusOnCreateForNotificationKind,
  defaultDueAtForNotificationKind,
  internalNotificationKindConfig,
} from "@/lib/internal-notifications/registry";
import { defaultDueAtForEngagement } from "@/lib/engagement-policies/registry";
import type { NotificationChannel } from "@agents/types";
import {
  buildCaseDocumentDownloadUrl,
  caseDocumentDownloadPath,
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  defaultDownloadLabel,
  downloadGeneratedCaseDocumentForUser,
  generatedCaseDocumentBindingForNotifyKind,
  normalizeNotifyTextReplacingSignedUrls,
  parseGeneratedDocumentFromContext,
  resolveGeneratedDocumentOutputPathFromCase,
  resolveGeneratedDocumentDeliveryUrl,
  dedupeConcatenatedSiteOriginInUrl,
  replaceCaseDocumentDownloadUrlsForExternalAudience,
  rewriteCaseDocumentDownloadLinksInText,
} from "@/lib/operational-cases/generated-case-document";
import { buildExternalCaseDocumentDownloadUrl } from "@/lib/operational-cases/case-document-download-token";
import { resolvePendingToolCallId } from "@/lib/notify/pending-tool-call-id";
import { buildContractDataReviewTelegramMarkup } from "@/lib/notify/contract-data-review-telegram-markup";
import {
  CONTRACT_REVIEW_BUTTONS_ONLY_FOLLOWUP_TEXT,
  CONTRACT_REVIEW_FALLBACK_ATTACH_CAPTION,
  CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES,
  contractReviewTelegramDeliveryPlan,
  prepareContractReviewDocumentCaption,
  shouldAttachContractDraftAfterTextFallback,
  type ContractReviewTelegramDeliveryPlan,
} from "@/lib/notify/contract-review-telegram-delivery";
import {
  buildHitlApprovalTelegramMarkup,
  resolveHitlDetailUrlForTelegram,
} from "@/lib/notify/hitl-telegram-markup";

export type NotifyUrgency = "low" | "normal" | "high";

const DEFAULT_PRIORITY: NotificationChannel[] = ["web", "telegram"];
const CONTRACT_CALLBACK_EMAIL = "contract_email";
const CONTRACT_CALLBACK_UPLOAD = "contract_upload";

function publishDestinationLabel(kind: string | undefined) {
  if (kind === "easybroker_publish_approval") return "EasyBroker";
  if (kind === "ungga_publish_approval") return "Ungga";
  return "destino";
}

/** Botones HITL de contrato solo cuando hay borrador real para revisar. */
function contractReviewOffersHitlActions(payload: NotifyPayload): boolean {
  if (payload.kind === "contract_template_missing") return false;
  const text = (payload.text ?? "").toLowerCase();
  if (
    /falta la plantilla|plantilla docx|no está configurada|sin plantilla|not_configured/i.test(
      text
    )
  ) {
    return false;
  }
  if (
    /\/documents\/contract_draft\/download|\/api\/public\/operational-cases\/documents\/download|descargar borrador del contrato/i.test(
      payload.text ?? ""
    )
  ) {
    return true;
  }
  return payload.data?.contract_draft_ready === true;
}

export interface NotifyPayload {
  text: string;
  /** Etiqueta corta para logs y UI futura (ej. "case_reminder"). */
  kind?: string;
  /** Datos estructurados adicionales (ej. case_id) para auditoría / UI. */
  data?: Record<string, unknown>;
}

export interface NotifyChannelResult {
  channel: NotificationChannel;
  ok: boolean;
  status?: "stored" | "delivered" | "not_configured" | "failed";
  reason?: string;
}

export interface NotifyResult {
  attempted: NotifyChannelResult[];
  delivered: NotifyChannelResult[];
}

export interface NotifyOptions {
  pushChannels?: NotificationChannel[];
}

async function loadPriority(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<{
  channels: NotificationChannel[];
  engagementOverrides: Record<string, unknown> | null;
}> {
  const { data, error } = await db
    .from("user_notification_preferences")
    .select("channels_priority_jsonb, engagement_policy_overrides_jsonb")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) {
    return { channels: DEFAULT_PRIORITY, engagementOverrides: null };
  }
  const raw = (data as { channels_priority_jsonb?: unknown })
    .channels_priority_jsonb;
  if (!Array.isArray(raw)) {
    return { channels: DEFAULT_PRIORITY, engagementOverrides: null };
  }
  const cleaned = raw
    .filter((v): v is string => typeof v === "string")
    .filter((v): v is NotificationChannel =>
      ["web", "telegram", "email", "whatsapp"].includes(v)
    );
  const engagementOverrides =
    (data as { engagement_policy_overrides_jsonb?: unknown })
      .engagement_policy_overrides_jsonb &&
    typeof (data as { engagement_policy_overrides_jsonb?: unknown })
      .engagement_policy_overrides_jsonb === "object"
      ? ((data as { engagement_policy_overrides_jsonb?: unknown })
          .engagement_policy_overrides_jsonb as Record<string, unknown>)
      : null;
  return {
    channels: cleaned.length > 0 ? cleaned : DEFAULT_PRIORITY,
    engagementOverrides,
  };
}

async function deliverTelegram(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload
): Promise<NotifyChannelResult> {
  const chatId = await getTelegramChatId(db, userId);
  if (!chatId) {
    return {
      channel: "telegram",
      ok: false,
      status: "not_configured",
      reason: "no_telegram_account_linked",
    };
  }
  const notificationId =
    typeof payload.data?.notification_id === "string"
      ? payload.data.notification_id
      : "";
  const reminderSourceNotificationId =
    typeof payload.data?.source_notification_id === "string"
      ? payload.data.source_notification_id
      : "";
  let actionKind = payload.kind;
  let actionNotificationId = notificationId;
  // Reminders and escalations carry a `source_notification_id` pointing at the
  // original actionable notification. Resolve the original kind so the reminder
  // keeps the SAME primary action (e.g. a HITL reminder must still let the user
  // approve/reject), instead of degrading into a passive text-only nudge.
  let sourceNotificationMetadata: Record<string, unknown> | null = null;
  if (reminderSourceNotificationId) {
    actionNotificationId = reminderSourceNotificationId;
    const sourceNotification = await getInternalUserNotification(
      db,
      reminderSourceNotificationId
    );
    if (sourceNotification?.user_id === userId) {
      actionKind = sourceNotification.kind;
      sourceNotificationMetadata =
        sourceNotification.metadata_jsonb &&
        typeof sourceNotification.metadata_jsonb === "object"
          ? (sourceNotification.metadata_jsonb as Record<string, unknown>)
          : null;
    }
  }
  let replyMarkup:
    | {
        inline_keyboard: Array<
          Array<
            | { text: string; callback_data: string }
            | { text: string; url: string }
          >
        >;
      }
    | undefined;
  if (actionKind === "tool_confirmation_pending") {
    // Resolve the underlying tool_call id from the payload (direct path) or the
    // source notification metadata (reminder/escalation path).
    const pendingToolCallId = resolvePendingToolCallId(
      payload.data,
      sourceNotificationMetadata
    );
    // Only attach approve/reject buttons if the tool call is STILL awaiting
    // confirmation. `getPendingToolCall` returns null once it has been
    // executed/rejected, which prevents stale actions on an already-resolved
    // approval.
    if (pendingToolCallId) {
      const stillPending = await getPendingToolCall(db, pendingToolCallId);
      if (stillPending) {
        const detailUrl =
          typeof payload.data?.action_url === "string"
            ? payload.data.action_url
            : null;
        replyMarkup = buildHitlApprovalTelegramMarkup({
          toolCallId: pendingToolCallId,
          detailUrl: resolveHitlDetailUrlForTelegram(detailUrl),
        });
      }
    }
  } else if (actionKind === "price_approval" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Aprobar precio",
            callback_data: `price_approve:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Ajustar y aprobar",
            callback_data: `price_adjust:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (actionKind === "listing_description_review" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Aprobar descripción",
            callback_data: `ld_approve:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Pedir cambios",
            callback_data: `ld_changes:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (
    (actionKind === "easybroker_publish_approval" ||
      actionKind === "ungga_publish_approval") &&
    actionNotificationId
  ) {
    const destination = publishDestinationLabel(actionKind);
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: `Publicar en ${destination}`,
            callback_data: `pub_approve:${actionNotificationId}`,
          },
        ],
        [
          {
            text: `No publicar en ${destination}`,
            callback_data: `pub_skip:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Detener y revisar",
            callback_data: `pub_reject:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (
    actionKind === "publication_review_required" &&
    actionNotificationId
  ) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Aprobar y continuar",
            callback_data: `pubrev_approve:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Detener y revisar",
            callback_data: `pubrev_stop:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (
    actionKind === "contract_review" &&
    actionNotificationId &&
    contractReviewOffersHitlActions(payload)
  ) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Enviar por email",
            callback_data: `${CONTRACT_CALLBACK_EMAIL}:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Subir contrato corregido y enviar",
            callback_data: `${CONTRACT_CALLBACK_UPLOAD}:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (actionKind === "contract_data_review" && actionNotificationId) {
    const missingFields = Array.isArray(
      sourceNotificationMetadata?.missing_fields
    )
      ? sourceNotificationMetadata.missing_fields
      : Array.isArray(payload.data?.missing_fields)
        ? payload.data.missing_fields
        : [];
    replyMarkup = buildContractDataReviewTelegramMarkup(
      actionNotificationId,
      missingFields
    );
  } else if (actionKind === "property_data_review" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Confirmar datos",
            callback_data: `property_data_confirm:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Enviar corrección",
            callback_data: `property_data_correct:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (actionKind === "titularidad_review" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Aprobar titularidad",
            callback_data: `titularidad_approve:${actionNotificationId}`,
          },
        ],
      ],
    };
  }
  const text = truncateTelegramText(payload.text);

  if (actionKind === "contract_review") {
    return deliverContractReviewTelegram({
      db,
      userId,
      chatId,
      payload,
      text,
      replyMarkup,
    });
  }

  let lastError: string | undefined;
  let attemptedReplyMarkup = replyMarkup;
  let delivered = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendTelegramAgentMessage(chatId, text, attemptedReplyMarkup, {
        throwOnError: true,
      });
      delivered = true;
      break;
    } catch (e) {
      lastError = (e as Error).message ?? String(e);
      // Telegram rejects the full send when a button callback_data is invalid.
      // Retry once without buttons so the user still gets the message text/link.
      if (attemptedReplyMarkup && /BUTTON_DATA_INVALID/i.test(lastError)) {
        attemptedReplyMarkup = undefined;
      }
    }
  }
  if (!delivered) {
    return {
      channel: "telegram",
      ok: false,
      status: "failed",
      reason: lastError ?? "send_failed",
    };
  }

  return { channel: "telegram", ok: true, status: "delivered" };
}

type TelegramReplyMarkup = {
  inline_keyboard: Array<
    Array<
      | { text: string; callback_data: string }
      | { text: string; url: string }
    >
  >;
};

async function sendTelegramTextWithOptionalButtons(
  chatId: number,
  text: string,
  replyMarkup: TelegramReplyMarkup | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  let attemptedReplyMarkup = replyMarkup;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendTelegramAgentMessage(chatId, text, attemptedReplyMarkup, {
        throwOnError: true,
      });
      return { ok: true };
    } catch (e) {
      lastError = (e as Error).message ?? String(e);
      if (attemptedReplyMarkup && /BUTTON_DATA_INVALID/i.test(lastError)) {
        attemptedReplyMarkup = undefined;
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastError ?? "send_failed" };
}

async function loadContractReviewTelegramDocument(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  payload: NotifyPayload;
}): Promise<{
  filename: string;
  bytes: Buffer;
} | null> {
  const caseId =
    typeof params.payload.data?.case_id === "string"
      ? params.payload.data.case_id.trim()
      : "";
  if (!caseId) return null;

  const downloaded = await downloadGeneratedCaseDocumentForUser({
    db: params.db,
    userId: params.userId,
    caseId,
    binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  });
  if (!("data" in downloaded) || !downloaded.data) return null;

  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength > CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES) {
    console.warn(
      `[notify] contract_review telegram document skipped: soft_cap bytes=${bytes.byteLength}`
    );
    return null;
  }
  return { filename: downloaded.filename, bytes };
}

async function deliverContractReviewTelegram(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  chatId: number;
  payload: NotifyPayload;
  text: string;
  replyMarkup: TelegramReplyMarkup | undefined;
}): Promise<NotifyChannelResult> {
  const document = await loadContractReviewTelegramDocument({
    db: params.db,
    userId: params.userId,
    payload: params.payload,
  });
  const prepared = prepareContractReviewDocumentCaption(params.text);
  let plan: ContractReviewTelegramDeliveryPlan = contractReviewTelegramDeliveryPlan({
    hasBytes: Boolean(document),
    byteLength: document?.bytes.byteLength,
    originalTextLength: params.text.length,
    captionFitsWithoutTruncation: prepared.fitsWithoutTruncation,
  });

  if (!document) {
    console.warn("[notify] contract_review telegram: missing_bytes; using text path");
  } else if (!prepared.fitsWithoutTruncation) {
    console.warn(
      "[notify] contract_review telegram: caption_too_long; using text path"
    );
  }

  if (plan === "document_with_actions" && document) {
    const docResult = await sendContractReviewDocumentAttempt({
      chatId: params.chatId,
      document,
      caption: prepared.caption,
      replyMarkup: params.replyMarkup,
    });
    if (docResult.status === "delivered_with_actions") {
      return { channel: "telegram", ok: true, status: "delivered" };
    }
    if (docResult.status === "delivered_document_only") {
      const buttonsFollowUp = await sendTelegramTextWithOptionalButtons(
        params.chatId,
        CONTRACT_REVIEW_BUTTONS_ONLY_FOLLOWUP_TEXT,
        params.replyMarkup
      );
      if (buttonsFollowUp.ok) {
        return { channel: "telegram", ok: true, status: "delivered" };
      }
      console.warn(
        "[notify] contract_review telegram: buttons follow-up failed after document; falling back to full text",
        buttonsFollowUp.error
      );
      // Document already in chat — do not attach again after the text fallback.
      plan = "text_only";
    } else {
      console.warn(
        "[notify] contract_review telegram: sendDocument_failed; falling back to text",
        docResult.error
      );
      plan = "text_with_actions_then_attach";
    }
  }

  const textResult = await sendTelegramTextWithOptionalButtons(
    params.chatId,
    params.text,
    params.replyMarkup
  );
  if (!textResult.ok) {
    return {
      channel: "telegram",
      ok: false,
      status: "failed",
      reason: textResult.error,
    };
  }

  if (
    document &&
    shouldAttachContractDraftAfterTextFallback(plan)
  ) {
    try {
      await sendTelegramDocument(
        params.chatId,
        {
          filename: document.filename,
          bytes: document.bytes,
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          caption: CONTRACT_REVIEW_FALLBACK_ATTACH_CAPTION,
        },
        { throwOnError: true }
      );
    } catch (error) {
      console.warn(
        "[notify] contract_review telegram: attach_best_effort_failed",
        error
      );
    }
  }

  return { channel: "telegram", ok: true, status: "delivered" };
}

async function sendContractReviewDocumentAttempt(params: {
  chatId: number;
  document: { filename: string; bytes: Buffer };
  caption: string;
  replyMarkup: TelegramReplyMarkup | undefined;
}): Promise<
  | { status: "delivered_with_actions" }
  | { status: "delivered_document_only" }
  | { status: "failed"; error: string }
> {
  try {
    await sendTelegramDocument(
      params.chatId,
      {
        filename: params.document.filename,
        bytes: params.document.bytes,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        caption: params.caption,
        replyMarkup: params.replyMarkup,
      },
      { throwOnError: true }
    );
    return { status: "delivered_with_actions" };
  } catch (e) {
    const error = (e as Error).message ?? String(e);
    if (params.replyMarkup && /BUTTON_DATA_INVALID/i.test(error)) {
      try {
        await sendTelegramDocument(
          params.chatId,
          {
            filename: params.document.filename,
            bytes: params.document.bytes,
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            caption: params.caption,
          },
          { throwOnError: true }
        );
        return { status: "delivered_document_only" };
      } catch (retryError) {
        return {
          status: "failed",
          error: (retryError as Error).message ?? String(retryError),
        };
      }
    }
    return { status: "failed", error };
  }
}

const DELIVERERS: Record<
  NotificationChannel,
  (
    db: ReturnType<typeof createServerClient>,
    userId: string,
    payload: NotifyPayload
  ) => Promise<NotifyChannelResult>
> = {
  web: async () => ({ channel: "web", ok: true, status: "stored" }),
  telegram: deliverTelegram,
  // Stubs para canales futuros. Cuando se implementen, swap.
  email: async () => ({
    channel: "email",
    ok: false,
    status: "not_configured",
    reason: "not_implemented",
  }),
  whatsapp: async () => ({
    channel: "whatsapp",
    ok: false,
    status: "not_configured",
    reason: "not_implemented",
  }),
};

function notificationTitle(payload: NotifyPayload) {
  if (typeof payload.data?.title === "string" && payload.data.title.trim()) {
    return payload.data.title.trim();
  }
  if (payload.kind) return internalNotificationKindConfig(payload.kind).label;
  return "Notificacion de Gu";
}

function notificationActionUrl(payload: NotifyPayload) {
  const explicitActionUrl = payload.data?.action_url;
  if (typeof explicitActionUrl === "string" && explicitActionUrl.trim()) {
    return explicitActionUrl.trim();
  }
  if (payload.kind === "integration_reconnect") {
    return "/settings?view=integrations&section=credentials";
  }
  const caseId = payload.data?.case_id;
  if (typeof caseId !== "string" || !caseId.trim()) return null;
  const binding = generatedCaseDocumentBindingForNotifyKind(payload.kind);
  if (binding) {
    return caseDocumentDownloadPath(caseId.trim(), binding.documentKey);
  }
  return `/operational-cases?case=${encodeURIComponent(caseId.trim())}`;
}

async function enrichGeneratedDocumentNotifyPayload(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload
): Promise<NotifyPayload> {
  const binding = generatedCaseDocumentBindingForNotifyKind(payload.kind);
  if (!binding) return payload;

  const caseId =
    typeof payload.data?.case_id === "string" ? payload.data.case_id.trim() : "";
  if (!caseId) return payload;

  const opCase = await getOperationalCase(db, caseId);
  const draft =
    opCase && opCase.user_id === userId
      ? ((await resolveGeneratedDocumentOutputPathFromCase(db, {
          caseId,
          context: (opCase.context_jsonb ?? {}) as Record<string, unknown>,
          binding,
        })) ??
        parseGeneratedDocumentFromContext(opCase.context_jsonb, binding))
      : null;

  let text = normalizeNotifyTextReplacingSignedUrls({
    text: payload.text,
    caseId,
    storagePath: draft?.output_path ?? null,
    binding,
  });

  const downloadPathSegment = `/documents/${binding.documentKey}/download`;
  text = dedupeConcatenatedSiteOriginInUrl(
    rewriteCaseDocumentDownloadLinksInText({ text, caseId, binding })
  );

  const externalUrl =
    draft?.output_path && opCase
      ? buildExternalCaseDocumentDownloadUrl({
          caseId,
          userId: opCase.user_id,
          documentKey: binding.documentKey,
          outputPath: draft.output_path,
        })
      : null;
  if (externalUrl) {
    text = replaceCaseDocumentDownloadUrlsForExternalAudience({
      text,
      caseId,
      binding,
      externalUrl,
    });
  }

  const deliveryUrl =
    externalUrl ??
    (await resolveGeneratedDocumentDeliveryUrl(db, {
      caseId,
      context: (opCase?.context_jsonb ?? {}) as Record<string, unknown>,
      binding,
      forExternalAudience: true,
    })) ??
    buildCaseDocumentDownloadUrl(caseId, binding);

  if (draft?.output_path && !text.includes(downloadPathSegment) && !text.includes("/api/public/operational-cases/documents/download")) {
    const label = defaultDownloadLabel(
      draft.output_path,
      binding.defaultDownloadLabel
    );
    const link =
      deliveryUrl.startsWith("http") || deliveryUrl.startsWith("/api/public/")
        ? deliveryUrl
        : await resolveGeneratedDocumentDeliveryUrl(db, {
            caseId,
            context: opCase!.context_jsonb as Record<string, unknown>,
            binding,
            forExternalAudience: true,
          }) ?? deliveryUrl;
    text = `${text.trim()}\n\n${label}: ${link}`;
  }

  return { ...payload, text, data: { ...payload.data, contract_draft_ready: Boolean(draft?.output_path) } };
}

function notificationDueAt(
  payload: NotifyPayload,
  engagementOverrides?: Record<string, unknown> | null
) {
  const dueAt = payload.data?.due_at;
  if (typeof dueAt === "string" && dueAt.trim()) return dueAt;
  const config = internalNotificationKindConfig(payload.kind);
  return (
    defaultDueAtForEngagement(
      {
        audience: "internal_user",
        intent: config.intent ?? "reminder",
        kind: config.kind,
      },
      Date.now(),
      engagementOverrides
    ) ?? defaultDueAtForNotificationKind(payload.kind)
  );
}

function shouldReuseActiveNotification(payload: NotifyPayload, caseId: string | null) {
  if (!caseId || !payload.kind) return false;
  return [
    "contract_pending",
    "contract_revision_upload",
    "contract_data_review",
    "contract_review",
    "missing_requirements",
    "price_approval",
    "listing_description_review",
    "property_data_review",
    "tool_confirmation_pending",
    "easybroker_publish_approval",
    "ungga_publish_approval",
    "manual_publish_package_approval",
    "publication_review_required",
    // Corrective re-close after premature summary must upsert, not insert
    // (unique active index on user/case/kind).
    "listing_published_summary",
  ].includes(payload.kind);
}

function channelMap(results: NotifyChannelResult[]) {
  return Object.fromEntries(
    results.map((result) => [
      result.channel,
      {
        ok: result.ok,
        status: result.status ?? (result.ok ? "delivered" : "failed"),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    ])
  );
}

export async function notify(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload,
  urgency: NotifyUrgency = "normal",
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  const effectivePayload = await enrichGeneratedDocumentNotifyPayload(
    db,
    userId,
    payload
  );
  const preference = await loadPriority(db, userId);
  const priority = preference.channels;

  const attempted: NotifyChannelResult[] = [];
  const delivered: NotifyChannelResult[] = [];
  const webResult: NotifyChannelResult = {
    channel: "web",
    ok: true,
    status: "stored",
  };
  attempted.push(webResult);
  delivered.push(webResult);
  const caseId =
    typeof effectivePayload.data?.case_id === "string"
      ? effectivePayload.data.case_id
      : null;
  const notificationInput = {
    userId,
    caseId,
    kind: effectivePayload.kind ?? "general",
    title: notificationTitle(effectivePayload),
    body: effectivePayload.text,
    priority: urgency,
    actionUrl: notificationActionUrl(effectivePayload),
    dueAt: notificationDueAt(effectivePayload, preference.engagementOverrides),
    deliveredChannels: channelMap([webResult]),
    metadata: effectivePayload.data ?? {},
  };
  const notification = shouldReuseActiveNotification(effectivePayload, caseId)
    ? await upsertActiveInternalUserNotification(db, notificationInput)
    : await createInternalUserNotification(db, notificationInput);

  for (const channel of priority) {
    if (channel === "web") continue;
    if (
      Array.isArray(options.pushChannels) &&
      !options.pushChannels.includes(channel)
    ) {
      continue;
    }
    const result = await DELIVERERS[channel](db, userId, {
      ...effectivePayload,
      data: {
        ...(effectivePayload.data ?? {}),
        notification_id: notification.id,
      },
    });
    attempted.push(result);
    if (result.ok) {
      delivered.push(result);
      if (urgency !== "high") break;
    }
  }

  await updateInternalUserNotificationChannels(
    db,
    notification.id,
    channelMap(attempted)
  );

  const autoStatus = autoStatusOnCreateForNotificationKind(effectivePayload.kind);
  if (autoStatus) {
    await setInternalUserNotificationStatus(db, {
      id: notification.id,
      userId,
      status: autoStatus,
    });
  }

  return { attempted, delivered };
}
