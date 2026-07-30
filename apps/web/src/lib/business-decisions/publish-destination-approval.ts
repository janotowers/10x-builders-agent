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
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
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
import {
  forceRetryPublicationResetPhase,
  publicationReviewContinueGuidance,
  shouldForceRetryPublicationCreateAfterReview,
} from "@/lib/business-decisions/publication-review";

type PublishDestinationIntent = "approve" | "reject" | "skip" | "unclear";

type ParsedDestinationDecision = {
  intent: PublishDestinationIntent;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Human-facing destination label for advisor acks (not the technical id). */
export function publishDestinationDisplayName(
  destination: string | null | undefined
): string {
  if (destination === "easybroker") return "EasyBroker";
  if (destination === "ungga") return "Ungga";
  if (destination === "manual") return "paquete manual";
  return typeof destination === "string" && destination.trim()
    ? destination.trim()
    : "el destino";
}

export function formatPublishDestinationDecisionAck(params: {
  destination: string;
  decision: "approved" | "skipped" | "rejected" | string;
}): string {
  const label = publishDestinationDisplayName(params.destination);
  if (params.decision === "approved") {
    return `Publicación en ${label} aprobada. Sigo con la publicación…`;
  }
  if (params.decision === "skipped") {
    return `Publicación en ${label} omitida. Continúo con el siguiente paso…`;
  }
  if (params.decision === "rejected") {
    return `Publicación en ${label} rechazada; el caso queda en revisión interna.`;
  }
  return `Decisión de publicación en ${label} registrada.`;
}

/** Ack when the user re-taps an already-decided destination approval button. */
export function formatAlreadyAppliedDestinationAck(params: {
  destination: string;
  decision: "approved" | "skipped" | "rejected" | string;
}): string {
  const label = publishDestinationDisplayName(params.destination);
  if (params.decision === "approved") {
    return (
      `La publicación en ${label} ya estaba aprobada. ` +
      `Si falló al preparar el borrador, usa «Reintentar publicación en ${label}» ` +
      `del mensaje de revisión (no el botón «Publicar en ${label}» anterior).`
    );
  }
  return `Destino ${label} ya estaba ${params.decision}.`;
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
 * True when EasyBroker already left a usable listing artifact on the case
 * (draft or published). Use for upload sequencing, not for Ungga approval.
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
  // Legacy: listing exists (draft or published). Enough for image upload
  // sequencing, but NOT for Ungga approval — use
  // isEasybrokerResolvedForUnggaApproval instead.
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
 * Ungga approval may be requested only after EasyBroker is publicly published
 * or explicitly skipped/rejected.
 */
export function isEasybrokerResolvedForUnggaApproval(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isRecord(context)) return false;
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const easybrokerDecision =
    typeof approvals.easybroker === "string" ? approvals.easybroker : null;
  if (
    easybrokerDecision === "skipped" ||
    easybrokerDecision === "rejected"
  ) {
    return true;
  }
  return isEasybrokerPubliclyPublishedInContext(context);
}

/**
 * Destinos cuya aprobación humana aún no debe pedirse (ni bloquear el lab)
 * porque EasyBroker no terminó (publicado / omitido / rechazado).
 */
export function prematurePublishDestinationNotificationKinds(
  context: Record<string, unknown> | null | undefined
): string[] {
  if (!isRecord(context)) return [];
  if (isEasybrokerResolvedForUnggaApproval(context)) return [];
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
  // Skip before approve: "No publicar en X" / "Omitir X" must not match "publicar en".
  if (
    /^(omitir|skip|saltar|no\s+publicar|no\s+usar)\b/.test(normalized) ||
    normalized.includes("omitir easybroker") ||
    normalized.includes("omitir ungga")
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
  if (
    /^(rechazar|rechazo|cancelar|no|detener|deten|pausar)\b/.test(normalized) ||
    normalized.includes("pausar publicación") ||
    normalized.includes("pausar publicacion")
  ) {
    return { intent: "reject", reason: text.trim() };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Usa los botones Publicar / Omitir / Pausar publicación, o responde APROBAR, OMITIR o RECHAZAR.",
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
  source: string,
  options?: { forceRetryFailedOperation?: boolean }
) {
  const { createPublicationRunnerOwnedAgentTick } = await import(
    "@/lib/operational-cases/run-settings-test-case-tick"
  );
  // Prefer serialized publication runner; it may delegate to the agent tick.
  await requestPublicationProgress(db, updated.id, source, {
    forceRetryFailedOperation: options?.forceRetryFailedOperation === true,
    runAgentTick: createPublicationRunnerOwnedAgentTick(
      db,
      updated.user_id,
      source
    ),
  });
}

/**
 * Dispara el tick E2E diferido tras aprobación/omisión de destino (Telegram
 * envía primero el ack y luego avanza publicación / siguiente destino).
 */
export async function runDeferredPublishDestinationControlledE2ETick(
  db: DbClient,
  caseId: string,
  source: string,
  options?: { forceRetryFailedOperation?: boolean }
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  await triggerControlledE2EAgentTick(db, opCase, source, options);
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

  // Idempotency: if destination already decided the same way, normally no-op.
  // Exception: stale "Publicar en Ungga/EasyBroker" after a failed prepare —
  // treat re-approve as force-retry so the old Telegram button still unblocks.
  if (destination !== "manual") {
    const destKey = destination as "easybroker" | "ungga";
    const existingApproval = publication.destinations[destKey]?.approval;
    if (existingApproval === nextState) {
      const canForceRetry =
        nextState === "approved" &&
        shouldForceRetryPublicationCreateAfterReview({
          destination: destKey,
          publication,
          lastError: publication.destinations[destKey].last_error,
        });
      if (!canForceRetry) {
        return {
          ok: true,
          status: "already_applied",
          message: formatAlreadyAppliedDestinationAck({
            destination,
            decision: nextState,
          }),
          destination,
          case_id: opCase.id,
          deferredControlledE2ETick: null,
        };
      }

      await claimUnreadInternalNotification(db, {
        id: notification.id,
        userId: params.userId,
        status: "actioned",
      }).catch(() => null);
      await resolveInternalNotificationWithReminders(db, {
        id: notification.id,
        userId: params.userId,
        status: "actioned",
      }).catch(() => null);
      await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
        userId: params.userId,
        caseId: opCase.id,
        kind: "publication_review_required",
        status: "actioned",
      }).catch(() => null);

      const dest = publication.destinations[destKey];
      const resetPhase = forceRetryPublicationResetPhase({
        destination: destKey,
        publication,
        lastError: dest.last_error,
      });
      const nowIso = new Date().toISOString();
      const nextPublication = {
        ...publication,
        destinations: {
          ...publication.destinations,
          [destKey]: {
            ...dest,
            phase: resetPhase,
            last_error: null,
            review_reason: null,
            preflight: resetPhase === "publish_pending" ? "pass" : null,
            operation_key: null,
            updated_at: nowIso,
          },
        },
      };
      const publicationPatch = buildPublicationContextPatch(nextPublication);
      const updated = await advisedUpdateCase(db, opCase, opCase.version, {
        status: "active",
        currentStep: opCase.current_step ?? "package_ready",
        nextActionAt: nowIso,
        context: {
          ...context,
          ...publicationPatch,
        },
      });
      if (!updated) {
        return {
          ok: false,
          status: "version_conflict",
          message: "El caso cambió; intenta de nuevo.",
        };
      }
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "human_decision",
        actor: "user",
        stepKey: "package_ready",
        payload: {
          kind: "publish_destination_reapprove_force_retry",
          destination: destKey,
          reset_phase: resetPhase,
          decided_at: nowIso,
        },
      });

      const runAgentTick = shouldRunPublishDestinationAgentTick(opCase);
      const tickSource = `publish_destination_${destKey}_reapprove_force_retry`;
      const deferTick = runAgentTick && params.deferControlledE2ETick === true;
      if (runAgentTick && !deferTick) {
        void triggerControlledE2EAgentTick(db, updated, tickSource, {
          forceRetryFailedOperation: true,
        }).catch((tickError) => {
          console.error(
            "[publish-destination-approval] reapprove force-retry tick failed:",
            tickError
          );
        });
      }

      return {
        ok: true,
        status: "approved",
        message: publicationReviewContinueGuidance({
          destination: destKey,
          publication: nextPublication,
          forceRetry: true,
        }),
        destination,
        case_id: opCase.id,
        deferredControlledE2ETick: deferTick
          ? { source: tickSource, forceRetryFailedOperation: true }
          : null,
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

  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
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
    message: formatPublishDestinationDecisionAck({
      destination,
      decision: nextState,
    }),
    destination,
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick ? { source: tickSource } : null,
  };
}
