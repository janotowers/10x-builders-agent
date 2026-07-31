/**
 * Entrega follow-ups operativos al canal interno activo del caso
 * (Web timeline vs push Telegram), manteniendo siempre el inbox.
 */
import { notify, type NotifyResult, type NotifyUrgency } from "@/lib/notify";
import { getOperationalCase, type DbClient } from "@agents/db";
import { buildListingPublishedSummaryCoverAttachment } from "./case-cover-photo";
import {
  getActiveCaseInternalChannel,
  mirrorCaseAssistantMessageToWebChat,
  type ActiveCaseInternalChannel,
} from "./mirror-case-message-to-web-chat";
import {
  buildWebHitlPresentation,
  type WebHitlAttachment,
  type WebHitlPresentation,
} from "./web-hitl-presentation";

async function webMirrorPresentation(params: {
  db: DbClient;
  caseId: string;
  kind?: string;
  text: string;
  data?: Record<string, unknown>;
  notificationId?: string | null;
}): Promise<WebHitlPresentation> {
  const presentation = buildWebHitlPresentation({
    caseId: params.caseId,
    kind: params.kind,
    text: params.text,
    data: params.data,
    notificationId: params.notificationId,
  });

  if (params.kind !== "listing_published_summary") {
    return presentation;
  }

  try {
    const opCase = await getOperationalCase(params.db, params.caseId);
    const cover = buildListingPublishedSummaryCoverAttachment({
      caseId: params.caseId,
      contextJsonb: opCase?.context_jsonb,
      text: params.text,
    });
    if (!cover) return presentation;
    const attachments: WebHitlAttachment[] = [
      ...(presentation.attachments ?? []),
      cover,
    ];
    return { ...presentation, attachments };
  } catch (error) {
    console.warn(
      "[deliver-internal-case-follow-up] listing cover attach failed:",
      error
    );
    return presentation;
  }
}

/**
 * `NotifyUserFn` con paridad de canal: si el caso se opera en Web, no empuja
 * Telegram y espeja el texto en el timeline del chat web.
 */
export async function notifyUserRespectingActiveInternalChannel(
  db: DbClient,
  userId: string,
  payload: { text: string; kind?: string; data?: Record<string, unknown> },
  urgency: NotifyUrgency = "normal"
): Promise<NotifyResult> {
  const caseId =
    typeof payload.data?.case_id === "string" && payload.data.case_id.trim()
      ? payload.data.case_id.trim()
      : null;

  if (!caseId) {
    return notify(db, userId, payload, urgency);
  }

  let activeChannel: ActiveCaseInternalChannel | null = null;
  try {
    activeChannel = await getActiveCaseInternalChannel({ db, caseId });
  } catch (channelError) {
    console.warn(
      "[deliver-internal-case-follow-up] resolve active channel failed:",
      channelError
    );
  }

  const result = await notify(
    db,
    userId,
    payload,
    urgency,
    activeChannel === "web"
      ? { pushChannels: [] }
      : activeChannel === "telegram"
        ? { pushChannels: ["telegram"] }
        : {}
  );

  // El chat web a veces responde el mismo contenido en el HTTP response;
  // skip_web_mirror evita el duplicado espejo+respuesta.
  if (
    activeChannel === "web" &&
    payload.text.trim() &&
    payload.data?.skip_web_mirror !== true
  ) {
    try {
      const mirror = await webMirrorPresentation({
        db,
        caseId,
        kind: payload.kind,
        text: payload.text,
        data: payload.data,
        notificationId: result.notificationId,
      });
      await mirrorCaseAssistantMessageToWebChat({
        db,
        userId,
        caseId,
        text: mirror.text,
        kind: payload.kind,
        notificationId: result.notificationId,
        actions: mirror.actions,
        attachments: mirror.attachments,
      });
    } catch (mirrorError) {
      console.warn(
        "[deliver-internal-case-follow-up] web chat mirror failed:",
        mirrorError
      );
    }
  }

  return result;
}

export async function deliverInternalCaseFollowUp(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  text: string;
  kind: string;
  data?: Record<string, unknown>;
  urgency?: NotifyUrgency;
}): Promise<{
  activeChannel: ActiveCaseInternalChannel | null;
  notifyDelivered: boolean;
  webChatMirrored: boolean;
}> {
  const activeChannel = await getActiveCaseInternalChannel({
    db: params.db,
    caseId: params.caseId,
  }).catch((channelError) => {
    console.warn(
      "[deliver-internal-case-follow-up] resolve active channel failed:",
      channelError
    );
    return null;
  });

  const notifyResult = await notify(
    params.db,
    params.userId,
    {
      text: params.text,
      kind: params.kind,
      data: {
        ...(params.data ?? {}),
        case_id: params.caseId,
      },
    },
    params.urgency ?? "normal",
    activeChannel === "web"
      ? { pushChannels: [] }
      : activeChannel === "telegram"
        ? { pushChannels: ["telegram"] }
        : {}
  );

  let webChatMirrored = false;
  if (activeChannel === "web" && params.data?.skip_web_mirror !== true) {
    try {
      const mirror = await webMirrorPresentation({
        db: params.db,
        caseId: params.caseId,
        kind: params.kind,
        text: params.text,
        data: params.data,
        notificationId: notifyResult.notificationId,
      });
      const result = await mirrorCaseAssistantMessageToWebChat({
        db: params.db,
        userId: params.userId,
        caseId: params.caseId,
        text: mirror.text,
        kind: params.kind,
        notificationId: notifyResult.notificationId,
        actions: mirror.actions,
        attachments: mirror.attachments,
      });
      webChatMirrored = result.mirrored;
    } catch (mirrorError) {
      console.warn(
        "[deliver-internal-case-follow-up] web chat mirror failed:",
        mirrorError
      );
    }
  }

  return {
    activeChannel,
    notifyDelivered: notifyResult.delivered.length > 0,
    webChatMirrored,
  };
}
