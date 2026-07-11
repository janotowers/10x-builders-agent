import {
  claimUnreadInternalNotification,
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
} from "@agents/types";
import {
  applyPublicationEvent,
  buildPublicationContextPatch,
  isEasybrokerEffectivelyPublished,
  publicationFromContext,
} from "@/lib/operational-cases/publication-workflow";
import { requestPublicationProgress } from "@/lib/operational-cases/publication-runner";

type PublishDestinationIntent = "approve" | "reject" | "skip" | "unclear";

type ParsedDestinationDecision = {
  intent: PublishDestinationIntent;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function destinationFromNotificationKind(kind: string):
  | "easybroker"
  | "ungga"
  | "manual"
  | null {
  if (kind === "easybroker_publish_approval") return "easybroker";
  if (kind === "ungga_publish_approval") return "ungga";
  if (kind === "manual_publish_package_approval") return "manual";
  return null;
}

/**
 * True when EasyBroker already left a usable listing artifact on the case.
 * Prefer publication.phase === "published" when available; legacy contexts that
 * only have listing_id still count as "created" for sequencing Ungga.
 */
export function isEasybrokerPublishedInContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isRecord(context)) return false;
  const publication = publicationFromContext(context);
  if (isEasybrokerEffectivelyPublished(publication)) return true;
  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker) ? published.easybroker : null;
  if (!easybroker) return false;
  if (easybroker.status === "published" || easybroker.remote_status === "published") {
    return true;
  }
  // Legacy: listing exists (draft or published). Sequencing still treats this
  // as EasyBroker-resolved for Ungga approval after media.
  return (
    typeof easybroker.listing_id === "string" ||
    easybroker.ok === true
  );
}

/** True only when EasyBroker remote status is actually published. */
export function isEasybrokerPubliclyPublishedInContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isRecord(context)) return false;
  return isEasybrokerEffectivelyPublished(publicationFromContext(context));
}

/**
 * Destinos cuya aprobación humana aún no debe pedirse (ni bloquear el lab)
 * porque EasyBroker no terminó (publicado / omitido / rechazado).
 */
export function prematurePublishDestinationNotificationKinds(
  context: Record<string, unknown> | null | undefined
): string[] {
  if (!isRecord(context)) return [];
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const easybrokerDecision =
    typeof approvals.easybroker === "string" ? approvals.easybroker : null;
  const easybrokerResolved =
    isEasybrokerPublishedInContext(context) ||
    easybrokerDecision === "skipped" ||
    easybrokerDecision === "rejected";
  if (easybrokerResolved) return [];
  return ["ungga_publish_approval"];
}

/**
 * Cierra pendientes de destino pedidos antes de tiempo (p. ej. Ungga antes de
 * publicar EasyBroker). No toca decisiones ya tomadas en publish_approvals.
 */
export async function dismissPrematurePublishDestinationApprovals(
  db: DbClient,
  params: { userId: string; caseId: string; context?: Record<string, unknown> | null }
): Promise<number> {
  const context =
    params.context ??
    (await getOperationalCase(db, params.caseId))?.context_jsonb ??
    null;
  const kinds = prematurePublishDestinationNotificationKinds(
    isRecord(context) ? context : null
  );
  let dismissed = 0;
  for (const kind of kinds) {
    dismissed += await resolveUnreadInternalNotificationsByKindForCaseWithReminders(
      db,
      {
        userId: params.userId,
        caseId: params.caseId,
        kind,
        status: "dismissed",
      }
    );
  }
  return dismissed;
}

function buildManualPublishPackage(context: Record<string, unknown>) {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const approved = isRecord(context.listing_description_approved)
    ? context.listing_description_approved
    : {};
  const pricing = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
  const rawPhotos = Array.isArray(context.raw_photos)
    ? context.raw_photos.filter((item): item is string => typeof item === "string")
    : [];
  return {
    headline:
      (typeof approved.headline === "string" && approved.headline.trim()) ||
      (typeof propertyData.property_title === "string" && propertyData.property_title.trim()) ||
      "Ficha de propiedad",
    description:
      (typeof approved.description === "string" && approved.description.trim()) ||
      (typeof context.listing_description_md === "string"
        ? context.listing_description_md.trim()
        : ""),
    price:
      (typeof pricing.salida === "number" && Number.isFinite(pricing.salida)
        ? pricing.salida
        : typeof pricing.ideal === "number" && Number.isFinite(pricing.ideal)
          ? pricing.ideal
          : typeof pricing.target_price === "number" &&
              Number.isFinite(pricing.target_price)
            ? pricing.target_price
        : typeof propertyData.target_price === "number" &&
            Number.isFinite(propertyData.target_price)
          ? propertyData.target_price
          : 0) ?? 0,
    currency:
      (typeof pricing.currency === "string" && pricing.currency.trim()) ||
      (typeof propertyData.currency === "string" && propertyData.currency.trim()) ||
      "MXN",
    address_summary:
      (typeof propertyData.legal_address === "string" && propertyData.legal_address.trim()) ||
      (typeof propertyData.address === "string" && propertyData.address.trim()) ||
      "",
    image_paths: rawPhotos,
    generated_at: new Date().toISOString(),
    source: "manual_publish_package_approval",
  };
}

export function parsePublishDestinationApprovalDecision(
  text: string
): ParsedDestinationDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  // Skip before approve: "No publicar en X" must not match "publicar en".
  if (
    /^(omitir|skip|saltar|no\s+publicar|no\s+usar)\b/.test(normalized)
  ) {
    return { intent: "skip", reason: text.trim() };
  }
  if (
    /^(aprobar|aprobado|apruebo|ok|va|si|sí|confirmo|publicar(\s+en)?)\b/.test(
      normalized
    )
  ) {
    return { intent: "approve" };
  }
  if (/^(rechazar|rechazo|cancelar|no|detener|deten)\b/.test(normalized)) {
    return { intent: "reject", reason: text.trim() };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Usa los botones Publicar / No publicar / Detener y revisar, o responde APROBAR, OMITIR o RECHAZAR.",
  };
}

function shouldRunPublishDestinationAgentTick(opCase: {
  context_jsonb?: Record<string, unknown> | null;
}): boolean {
  return (
    isControlledE2EOperationalCase(opCase) || isSettingsOperationalTestCase(opCase)
  );
}

async function triggerControlledE2EAgentTick(
  db: DbClient,
  updated: NonNullable<Awaited<ReturnType<typeof updateOperationalCase>>>,
  source: string
) {
  const { runSettingsTestCaseAgentTick } = await import(
    "@/lib/operational-cases/run-settings-test-case-tick"
  );
  // Prefer serialized publication runner; it may delegate to the agent tick.
  await requestPublicationProgress(db, updated.id, source, {
    runAgentTick: async (opCase, action) => {
      const tick = await runSettingsTestCaseAgentTick(db, opCase, opCase.user_id, {
        source: `${source}:${action.type}`,
      });
      return (
        tick.publication_execution ?? {
          status: "not_executed",
          error: "publication_execution_result_missing",
        }
      );
    },
  });
}

/**
 * Dispara el tick E2E diferido tras aprobación/omisión de destino (Telegram
 * envía primero el ack y luego avanza publicación / siguiente destino).
 */
export async function runDeferredPublishDestinationControlledE2ETick(
  db: DbClient,
  caseId: string,
  source: string
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  await triggerControlledE2EAgentTick(db, opCase, source);
}

export async function handlePublishDestinationApprovalDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    /**
     * Telegram: diferir el tick para enviar primero "Destino X aprobado"
     * y luego continuar (publicar / pedir Ungga).
     */
    deferControlledE2ETick?: boolean;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  const destination = destinationFromNotificationKind(notification.kind);
  if (!destination) {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no corresponde a aprobación por destino.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no está ligado a un caso.",
    };
  }
  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  const parsed = parsePublishDestinationApprovalDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const publication = publicationFromContext(context);
  const nextState =
    parsed.intent === "approve"
      ? "approved"
      : parsed.intent === "skip"
        ? "skipped"
        : "rejected";

  // Idempotency: if destination already decided the same way, no-op.
  if (destination !== "manual") {
    const existingApproval =
      publication.destinations[
        destination as "easybroker" | "ungga"
      ]?.approval;
    if (existingApproval === nextState) {
      return {
        ok: true,
        status: "already_applied",
        message: `Destino ${destination} ya estaba ${nextState}.`,
        destination,
        case_id: opCase.id,
        deferredControlledE2ETick: null,
      };
    }
  }

  // Atomic claim of unread notification — duplicate callbacks return already_applied.
  const claimed = await claimUnreadInternalNotification(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  if (!claimed) {
    return {
      ok: true,
      status: "already_applied",
      message: `Destino ${destination} ya estaba procesado.`,
      destination,
      case_id: opCase.id,
      deferredControlledE2ETick: null,
    };
  }
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  }).catch(() => null);

  const nowIso = new Date().toISOString();
  let nextPublication = publication;
  if (destination === "easybroker" || destination === "ungga") {
    nextPublication = applyPublicationEvent(publication, {
      type: "approval_decided",
      destination,
      approval: nextState,
      at: nowIso,
    });
  }
  const publicationPatch = buildPublicationContextPatch(nextPublication);
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: parsed.intent === "reject" ? "waiting_internal" : "active",
    currentStep: opCase.current_step ?? "package_ready",
    nextActionAt: parsed.intent === "reject" ? null : new Date().toISOString(),
    context: {
      ...context,
      ...publicationPatch,
      publish_approvals: {
        ...approvals,
        ...(publicationPatch.publish_approvals as Record<string, unknown>),
        [destination]: nextState,
      },
      ...(destination === "manual" && nextState === "approved"
        ? { manual_publish_package: buildManualPublishPackage(context) }
        : {}),
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "package_ready",
    payload: {
      kind: "publish_destination_decision",
      destination,
      decision: nextState,
      decided_at: nowIso,
      reason: parsed.reason ?? null,
      ...(destination === "manual" && nextState === "approved"
        ? { manual_publish_package_delivered: true }
        : {}),
    },
  });
  if (destination === "manual" && nextState === "approved") {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "user",
      stepKey: "package_ready",
      payload: {
        kind: "manual_publish_package_delivered",
        destination: "manual",
      },
    });
  }

  // Patrón gated transition: approve/skip desbloquean el flujo (publicar o
  // pedir el siguiente destino). reject deja waiting_internal a propósito.
  const shouldContinueFlow = nextState === "approved" || nextState === "skipped";
  const runAgentTick =
    shouldContinueFlow && shouldRunPublishDestinationAgentTick(opCase);
  const tickSource = `publish_destination_${destination}_${nextState}`;
  const deferTick = runAgentTick && params.deferControlledE2ETick === true;
  if (runAgentTick && !deferTick) {
    void triggerControlledE2EAgentTick(db, updated, tickSource).catch((tickError) => {
      console.error("[publish-destination-approval] e2e tick failed:", tickError);
    });
  }

  return {
    ok: true,
    status: nextState,
    message:
      nextState === "approved"
        ? `Destino ${destination} aprobado.`
        : nextState === "skipped"
          ? `Destino ${destination} marcado como omitido.`
          : `Destino ${destination} rechazado; el caso queda en revisión interna.`,
    destination,
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick ? { source: tickSource } : null,
  };
}
