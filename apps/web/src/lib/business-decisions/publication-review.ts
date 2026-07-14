import {
  claimUnreadInternalNotification,
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
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
  publicationFromContext,
  type PublicationDestination,
} from "@/lib/operational-cases/publication-workflow";
import { requestPublicationProgress } from "@/lib/operational-cases/publication-runner";
import { mergePhotoLabelsIntoManifest, parsePhotoManifest } from "@/lib/operational-cases/photo-manifest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ReviewIntent = "approve_continue" | "stop" | "unclear" | "relabel";

function parsePublicationReviewDecision(text: string): {
  intent: ReviewIntent;
  labels?: Array<{ source_path: string; space_label: string }>;
  reason?: string;
} {
  const normalized = text.trim().toLowerCase();
  if (
    /\b(aprobar|continuar|publicar|approve|continue)\b/.test(normalized) ||
    normalized === "aprobar y continuar"
  ) {
    return { intent: "approve_continue" };
  }
  if (
    /\b(detener|rechazar|stop|revisar)\b/.test(normalized) ||
    normalized.includes("detener y revisar")
  ) {
    return { intent: "stop" };
  }
  // Optional JSON label corrections: {"labels":[{"source_path":"...","space_label":"Cocina"}]}
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.labels)) {
      const labels = parsed.labels
        .map((item) => {
          if (!isRecord(item)) return null;
          const source_path =
            typeof item.source_path === "string" ? item.source_path : "";
          const space_label =
            typeof item.space_label === "string" ? item.space_label : "";
          if (!source_path || !space_label) return null;
          return { source_path, space_label };
        })
        .filter(
          (item): item is { source_path: string; space_label: string } =>
            Boolean(item)
        );
      if (labels.length > 0) return { intent: "relabel", labels };
    }
  } catch {
    // not JSON
  }
  return {
    intent: "unclear",
    reason:
      "No entendí. Usa «Aprobar y continuar», «Detener y revisar», o envía JSON con labels corregidas.",
  };
}

async function triggerProgress(
  db: DbClient,
  caseId: string,
  userId: string,
  source: string,
  options?: { forceRetryFailedOperation?: boolean }
) {
  const { runSettingsTestCaseAgentTick } = await import(
    "@/lib/operational-cases/run-settings-test-case-tick"
  );
  await requestPublicationProgress(db, caseId, source, {
    forceRetryFailedOperation: options?.forceRetryFailedOperation === true,
    runAgentTick: async (opCase, action) => {
      const tick = await runSettingsTestCaseAgentTick(db, opCase, userId, {
        source: `${source}:${action.type}`,
        skipLock: true,
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
 * After unknown_outcome/failed create without a known remote artifact, human
 * "approve and continue" means "I checked; safe to retry prepare_draft".
 * If a GU-ID/listing already exists, do NOT force-retry create — reconcile instead.
 */
export function shouldForceRetryPublicationCreateAfterReview(params: {
  destination: PublicationDestination;
  publication: ReturnType<typeof publicationFromContext>;
}): boolean {
  const dest = params.publication.destinations[params.destination];
  const hasArtifact = Boolean(
    dest.artifact.listing_id || dest.artifact.ungga_property_id
  );
  return (
    !hasArtifact &&
    (dest.phase === "unknown_outcome" || dest.phase === "failed")
  );
}

export function publicationReviewContinueGuidance(params: {
  destination: PublicationDestination;
  publication: ReturnType<typeof publicationFromContext>;
  forceRetry: boolean;
}): string {
  const dest = params.publication.destinations[params.destination];
  const artifactId =
    dest.artifact.ungga_property_id || dest.artifact.listing_id || null;
  if (params.forceRetry) {
    return "Reintento de create autorizado (sin artifact remoto conocido).";
  }
  if (artifactId) {
    return `Hay artifact ${artifactId}: no se recreará. Se continúa desde revisión/validación del borrador existente.`;
  }
  return "Revisión aceptada; se continúa el flujo de publicación.";
}

export async function handlePublicationReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    deferControlledE2ETick?: boolean;
  }
) {
  const notification = await getInternalUserNotification(
    db,
    params.notificationId
  );
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (notification.kind !== "publication_review_required") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es una revisión condicional de publicación.",
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

  const parsed = parsePublicationReviewDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const claimed = await claimUnreadInternalNotification(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  if (!claimed) {
    return {
      ok: true,
      status: "already_applied",
      message: "La revisión ya estaba procesada.",
      case_id: opCase.id,
      deferredControlledE2ETick: null,
    };
  }
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  }).catch(() => null);

  const meta = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  const destinationRaw =
    typeof meta.destination === "string" ? meta.destination : "easybroker";
  const destination: PublicationDestination =
    destinationRaw === "ungga" ? "ungga" : "easybroker";

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = publicationFromContext(context);
  let nextContext: Record<string, unknown> = { ...context };
  const forceRetryFailedOperation =
    parsed.intent === "approve_continue" &&
    shouldForceRetryPublicationCreateAfterReview({
      destination,
      publication,
    });

  if (parsed.intent === "relabel" && parsed.labels) {
    const manifest = mergePhotoLabelsIntoManifest(
      parsePhotoManifest(context.photo_manifest),
      parsed.labels.map((label) => ({
        ...label,
        confidence: 1,
        uncertain: false,
      }))
    );
    nextContext.photo_manifest = manifest;
    publication = applyPublicationEvent(publication, {
      type: "review_resolved",
      destination,
    });
  } else if (parsed.intent === "approve_continue") {
    if (forceRetryFailedOperation) {
      const dest = publication.destinations[destination];
      publication = {
        ...publication,
        destinations: {
          ...publication.destinations,
          [destination]: {
            ...dest,
            phase: "draft_pending",
            last_error: null,
            review_reason: null,
            preflight: null,
            operation_key: null,
            updated_at: new Date().toISOString(),
          },
        },
      };
    } else {
      publication = applyPublicationEvent(publication, {
        type: "review_resolved",
        destination,
      });
    }
  } else {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      stepKey: "package_ready",
      payload: {
        kind: "publication_review_stopped",
        destination,
      },
    });
    await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "waiting_internal",
      nextActionAt: null,
    });
    return {
      ok: true,
      status: "stopped",
      message: "Publicación detenida para revisión interna.",
      case_id: opCase.id,
      deferredControlledE2ETick: null,
    };
  }

  const patch = buildPublicationContextPatch(publication);
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "active",
    nextActionAt: new Date().toISOString(),
    context: {
      ...nextContext,
      ...patch,
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
      kind: "publication_review_resolved",
      destination,
      intent: parsed.intent,
    },
  });

  const shouldTick =
    isControlledE2EOperationalCase(opCase) ||
    isSettingsOperationalTestCase(opCase);
  const tickSource = `publication_review_${destination}_${parsed.intent}`;
  const deferTick = shouldTick && params.deferControlledE2ETick === true;
  if (shouldTick && !deferTick) {
    void triggerProgress(db, updated.id, params.userId, tickSource, {
      forceRetryFailedOperation,
    }).catch((error) => {
      console.error("[publication-review] progress failed:", error);
    });
  }

  return {
    ok: true,
    status: parsed.intent,
    message:
      parsed.intent === "relabel"
        ? "Etiquetas actualizadas; continúo la validación."
        : parsed.intent === "approve_continue"
          ? publicationReviewContinueGuidance({
              destination,
              publication,
              forceRetry: forceRetryFailedOperation,
            })
          : "Revisión aprobada; continúo la publicación.",
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick
      ? { source: tickSource, forceRetryFailedOperation }
      : null,
  };
}
