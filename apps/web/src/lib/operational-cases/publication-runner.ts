/**
 * Ejecutor serializado de publicación.
 * Todos los disparadores (Telegram, web, lab, auto-follow-up) pasan por aquí.
 */

import {
  claimPublicationOperation,
  finishPublicationOperation,
  getOperationalCase,
  getProfile,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listPublicationOperationsForCase,
  markCaseProcessing,
  markPublicationOperationRunning,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import {
  canCompleteListingPublishedSummaryFromContext,
  formatListingPublishedSummaryNotifyText,
  formatPublishDestinationApprovalNotifyText,
} from "@agents/agent";
import { notify } from "@/lib/notify";
import {
  canSafelyForceRetryProcessMedia,
  canSafelyForceRetryUnggaPublish,
} from "@/lib/operational-cases/publication-media-recovery";
import {
  canFinalizePublicationClosure,
  shouldIdleFallbackSetWaitingInternal,
  shouldSendCorrectiveListingPublishedSummary,
} from "@/lib/operational-cases/publication-closure-recovery";
import {
  formatPublicationReviewNotifyText,
  looksLikePublicationCredentialAuthFailure,
  looksLikeUnggaPrepareDraftCommissionFailure,
  looksLikeUnggaPrepareDraftFailure,
  looksLikeUnggaPrepareDraftMediaFailure,
  resolveUnggaPrepareDraftFailureCause,
  runPublicationPreflight,
  type PreflightResult,
} from "@/lib/operational-cases/publication-preflight";
import {
  applyPublicationEvent,
  areAllPublicationDestinationsResolved,
  buildPublicationContextPatch,
  nextPublicationAction,
  publicationFromContext,
  reconcilePublicationWithArtifacts,
  type PublicationDestination,
  type PublicationMachineAction,
  type PublicationState,
} from "@/lib/operational-cases/publication-workflow";
import {
  buildPhotoManifestFromRawPhotos,
  imagePathsForUpload,
  imageTitlesFromManifest,
  parsePhotoManifest,
  publicImageUrlsFromManifest,
} from "@/lib/operational-cases/photo-manifest";
import { resolveRequireWatermark } from "@/lib/operational-cases/watermark-requirement";
import {
  canUseUnggaCliEvidence,
  compareEasyBrokerSnapshot,
  fetchEasyBrokerListingSnapshot,
  fetchUnggaListingSnapshot,
  isUnggaApiCredentialsMissingError,
  unggaMediaCountSatisfied,
  unggaSnapshotFromCliEvidence,
  type EasyBrokerListingSnapshot,
  type UnggaListingSnapshot,
} from "@/lib/operational-cases/publication-remote-snapshot";
import { resolvePublicationRolloutMode } from "@/lib/operational-cases/publication-rollout";
import { reconcilePublicationCaseRecord } from "@/lib/operational-cases/publication-reconcile";

export type PublicationProgressResult = {
  ok: boolean;
  status:
    | "already_processing"
    | "idle"
    | "progressed"
    | "waiting_hitl"
    | "waiting_remote"
    | "failed"
    | "case_not_found";
  actions_run: string[];
  next_action?: PublicationMachineAction;
  publication?: PublicationState;
  preflight?: PreflightResult;
  message?: string;
};

const MAX_MACHINE_STEPS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type PublicationExecutionResult = {
  status:
    | "succeeded"
    | "failed"
    | "unknown_outcome"
    | "pending_hitl"
    | "not_executed";
  result?: Record<string, unknown>;
  error?: string;
};

function isUnknownExternalFailure(message: string): boolean {
  return /\b(timeout|timed out|killed|kill signal|sigterm|sigkill|aborted|econnreset|socket hang up)\b/i.test(
    message
  );
}

function stringResult(
  result: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = result?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Infer CLI diagnostic step from error text (not ledger operation_key). */
export function inferUnggaPrepareCliStep(
  errorText: string | null | undefined,
  resultLastStep?: string | null
): string {
  if (typeof resultLastStep === "string" && resultLastStep.trim()) {
    const step = resultLastStep.trim();
    // Reject ledger-style keys if they leaked into last_step.
    if (!/^create_draft:|^publish:|^process_media:/i.test(step)) {
      return step;
    }
  }
  const error = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (!error) return "prepare_draft";
  if (
    error.includes("ungga_media_source_unreachable") ||
    error.includes("media_preflight")
  ) {
    return "media_preflight";
  }
  if (
    error.includes("media incomplete") ||
    error.includes("image download") ||
    error.includes("media_upload")
  ) {
    return "media_upload";
  }
  if (error.includes("commission") || error.includes("comisi")) {
    return "verify_commission";
  }
  return "prepare_draft";
}

/**
 * Apply process_media tool result without wiping a verified remote poll.
 * Always records media_submitted; also media_verified when the tool already
 * confirmed remote_count matches expected.
 */
export function applyProcessMediaPublicationEvents(
  publication: PublicationState,
  destination: PublicationDestination,
  result: Record<string, unknown>
): PublicationState {
  const expectedCount =
    typeof result.count === "number" && result.count > 0
      ? result.count
      : publication.destinations[destination].media.expected_count;
  let next = applyPublicationEvent(publication, {
    type: "media_submitted",
    destination,
    expected_count: expectedCount,
  });
  const remoteCount =
    typeof result.remote_count === "number" ? result.remote_count : null;
  if (
    result.images_status === "verified" &&
    typeof remoteCount === "number" &&
    remoteCount > 0 &&
    (expectedCount <= 0 || remoteCount === expectedCount)
  ) {
    next = applyPublicationEvent(next, {
      type: "media_verified",
      destination,
      remote_count: remoteCount,
    });
  }
  return next;
}

function expectedEasyBrokerCriticalFields(
  context: Record<string, unknown>
): Record<string, unknown> {
  const approved = isRecord(context.listing_description_approved)
    ? context.listing_description_approved
    : {};
  const property = isRecord(context.property_data) ? context.property_data : {};
  return {
    title:
      stringResult(approved, ["headline", "title"]) ??
      stringResult(property, ["property_title", "title"]),
    description:
      stringResult(approved, ["description"]) ??
      (typeof context.listing_description_md === "string"
        ? context.listing_description_md
        : null),
  };
}

async function persistPublication(
  db: DbClient,
  opCase: OperationalCase,
  publication: PublicationState,
  extraContext?: Record<string, unknown>
): Promise<OperationalCase | null> {
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  return updateOperationalCase(db, opCase.id, opCase.version, {
    context: buildPublicationPersistenceContext(
      context,
      publication,
      extraContext
    ),
  });
}

/**
 * Persist runner ownership (in_flight + pending_action) before external tools.
 * Retries once after reload on version conflict. Never run tools without a
 * successful persist.
 */
export async function persistPublicationRunnerGate(
  db: DbClient,
  opCase: OperationalCase,
  publication: PublicationState,
  action: PublicationMachineAction
): Promise<
  | { ok: true; opCase: OperationalCase }
  | { ok: false; opCase: OperationalCase; error: string }
> {
  const gateExtra = {
    package_ready_machine_work_in_flight: true,
    publication_runner_pending_action: action,
  };
  let current = opCase;
  let persisted = await persistPublication(db, current, publication, gateExtra);
  if (persisted) {
    return { ok: true, opCase: persisted };
  }
  const reloaded = await getOperationalCase(db, opCase.id);
  if (!reloaded) {
    return {
      ok: false,
      opCase: current,
      error: "publication_pending_action_persist_failed",
    };
  }
  current = reloaded;
  persisted = await persistPublication(db, current, publication, gateExtra);
  if (persisted) {
    return { ok: true, opCase: persisted };
  }
  return {
    ok: false,
    opCase: current,
    error: "publication_pending_action_persist_failed",
  };
}

export function buildPublicationPersistenceContext(
  context: Record<string, unknown>,
  publication: PublicationState,
  extraContext?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...context,
    ...buildPublicationContextPatch(publication),
    package_ready_machine_work_in_flight: false,
    ...(extraContext ?? {}),
  };
}

async function ensurePublicationSeeded(
  db: DbClient,
  opCase: OperationalCase
): Promise<{ opCase: OperationalCase; publication: PublicationState }> {
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = reconcilePublicationWithArtifacts(
    publicationFromContext(context),
    context
  );
  const needsSeed =
    !isRecord(context.publication) || context.publication.version !== 1;
  const photoManifest = buildPhotoManifestFromRawPhotos(
    context.raw_photos,
    parsePhotoManifest(context.photo_manifest)
  );
  if (needsSeed || photoManifest.length > 0) {
    for (const destination of ["easybroker", "ungga"] as const) {
      const media = publication.destinations[destination].media;
      publication.destinations[destination] = {
        ...publication.destinations[destination],
        media: {
          ...media,
          required: photoManifest.length > 0 || media.required,
          expected_count:
            media.expected_count > 0
              ? media.expected_count
              : photoManifest.length,
        },
      };
    }
  }
  const before = JSON.stringify(context.publication ?? null);
  const after = JSON.stringify(publication);
  if (needsSeed || before !== after) {
    const updated = await persistPublication(db, opCase, publication, {
      ...(needsSeed || !Array.isArray(context.photo_manifest)
        ? { photo_manifest: photoManifest }
        : {}),
    });
    if (updated) {
      return { opCase: updated, publication };
    }
  }
  return { opCase, publication };
}

async function requestDestinationApproval(
  db: DbClient,
  opCase: OperationalCase,
  destination: PublicationDestination
): Promise<"waiting_hitl" | "progressed"> {
  const kind =
    destination === "easybroker"
      ? "easybroker_publish_approval"
      : "ungga_publish_approval";
  const label = destination === "easybroker" ? "EasyBroker" : "Ungga";
  const { data: existing } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", opCase.user_id)
    .eq("case_id", opCase.id)
    .eq("kind", kind)
    .eq("status", "unread")
    .limit(1);
  if ((existing ?? []).length > 0) {
    return "waiting_hitl";
  }
  await notify(
    db,
    opCase.user_id,
    {
      text: formatPublishDestinationApprovalNotifyText({
        destination: label,
      }),
      kind,
      data: { case_id: opCase.id, destination },
    },
    "normal"
  );
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: "package_ready",
    payload: {
      kind: "publish_destination_approval_requested",
      destination,
      source: "publication_runner",
    },
  });
  return "waiting_hitl";
}

async function requestConditionalReview(
  db: DbClient,
  opCase: OperationalCase,
  destination: PublicationDestination,
  result: PreflightResult
): Promise<"waiting_hitl"> {
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const publication = publicationFromContext(context);
  const dest = publication.destinations[destination];
  const publishedBucket = isRecord(context.published)
    ? context.published[destination]
    : null;
  const alreadyPublished =
    dest.phase === "published" ||
    (isRecord(publishedBucket) &&
      (publishedBucket.remote_status === "published" ||
        publishedBucket.status === "published" ||
        publishedBucket.ok === true));
  // Never open a "review before publish" HITL after the destination is already live.
  if (alreadyPublished) {
    return "waiting_hitl";
  }
  const { data: existing } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", opCase.user_id)
    .eq("case_id", opCase.id)
    .eq("kind", "publication_review_required")
    .eq("status", "unread")
    .eq("metadata_jsonb->>destination", destination)
    .limit(1);
  if ((existing ?? []).length > 0) {
    return "waiting_hitl";
  }
  const lastErrorText =
    typeof dest.last_error === "string" ? dest.last_error : null;
  const credentialFailure =
    looksLikePublicationCredentialAuthFailure(lastErrorText);
  const hasDraftArtifact = Boolean(
    dest.artifact.listing_id || dest.artifact.ungga_property_id
  );
  // Classify from the CLI/error text — never use ledger operation_key
  // (create_draft:ungga:new) as last_step.step; that broke prepare_draft_failure
  // metadata and showed the wrong Telegram CTA.
  const cliStep = inferUnggaPrepareCliStep(lastErrorText);
  const prepareDraftExtras = {
    last_step: lastErrorText
      ? { step: cliStep, error: lastErrorText }
      : null,
  };
  const commissionPrepareFailure =
    destination === "ungga" &&
    !hasDraftArtifact &&
    looksLikeUnggaPrepareDraftCommissionFailure(
      lastErrorText,
      prepareDraftExtras
    );
  const mediaPrepareFailure =
    destination === "ungga" &&
    !hasDraftArtifact &&
    looksLikeUnggaPrepareDraftMediaFailure(lastErrorText, prepareDraftExtras);
  const prepareDraftFailure =
    destination === "ungga" &&
    !hasDraftArtifact &&
    (commissionPrepareFailure ||
      mediaPrepareFailure ||
      looksLikeUnggaPrepareDraftFailure(lastErrorText, prepareDraftExtras));
  const lastStep = lastErrorText
    ? {
        step: cliStep,
        ok: false as const,
        error: lastErrorText,
      }
    : null;
  const commissionMatch = lastErrorText?.match(
    /expected\s+(\d+(?:\.\d+)?)%/i
  );
  const commissionActualMatch = lastErrorText?.match(
    /got\s+(null|\d+(?:\.\d+)?)/i
  );
  await notify(
    db,
    opCase.user_id,
    {
      text: formatPublicationReviewNotifyText(destination, result, {
        last_step: lastStep,
        expected_image_count: dest.media.expected_count,
        uploaded_image_count: dest.media.remote_count,
        has_draft_artifact: hasDraftArtifact,
        ungga_property_id: dest.artifact.ungga_property_id ?? null,
        credential_failure: credentialFailure,
        prepare_draft_failure: prepareDraftFailure,
        commission_expected: commissionMatch
          ? Number(commissionMatch[1])
          : null,
        commission_actual:
          commissionActualMatch && commissionActualMatch[1] !== "null"
            ? Number(commissionActualMatch[1])
            : null,
        commission_verify: commissionPrepareFailure
          ? {
              error: lastErrorText,
              stage: "verify_commission",
            }
          : prepareDraftFailure
            ? {
                error: lastErrorText,
                stage: "prepare_draft",
              }
            : null,
      }),
      kind: "publication_review_required",
      data: {
        case_id: opCase.id,
        destination,
        issues: result.issues,
        summary: result.summary,
        expected_image_count: dest.media.expected_count,
        uploaded_image_count: dest.media.remote_count,
        ungga_property_id: dest.artifact.ungga_property_id ?? null,
        last_error: dest.last_error,
        credential_failure: credentialFailure,
        prepare_draft_failure: prepareDraftFailure,
        safe_retry_prepare: prepareDraftFailure,
      },
    },
    "high"
  );
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: "package_ready",
    payload: {
      kind: "publication_review_required",
      destination,
      summary: result.summary,
      issue_codes: result.issues.map((i) => i.code),
      credential_failure: credentialFailure,
      prepare_draft_failure: prepareDraftFailure,
    },
  });
  return "waiting_hitl";
}

/**
 * Solicita avance de publicación. Serializa con markCaseProcessing.
 * Las acciones de tools externas (create/upload/publish) se delegan al
 * tick de agente controlado cuando aún no hay adapters de servicio locales;
 * el runner garantiza orden, fases e idempotencia de estado.
 */
export async function requestPublicationProgress(
  db: DbClient,
  caseId: string,
  source: string,
  options?: {
    /** When true, only seed/reconcile state and compute next action. */
    dryCompute?: boolean;
    /**
     * Explicit recovery only: re-claim a ledger operation known to have
     * failed before any external tool executed.
     */
    forceRetryFailedOperation?: boolean;
    /**
     * Caller already holds the case processing lease (e.g. settings E2E run
     * route). Skip markCaseProcessing so we don't no-op as already_processing.
     */
    skipLock?: boolean;
    /** Delegate machine tool work to an agent tick callback. */
    runAgentTick?: (
      opCase: OperationalCase,
      action: PublicationMachineAction
    ) => Promise<PublicationExecutionResult>;
    fetchEasyBrokerSnapshot?: typeof fetchEasyBrokerListingSnapshot;
    fetchUnggaSnapshot?: typeof fetchUnggaListingSnapshot;
  }
): Promise<PublicationProgressResult> {
  let loaded = await getOperationalCase(db, caseId);
  if (!loaded) {
    return { ok: false, status: "case_not_found", actions_run: [] };
  }

  const context = isRecord(loaded.context_jsonb) ? loaded.context_jsonb : {};
  const profile = await getProfile(db, loaded.user_id).catch(() => null);
  const rolloutMode = resolvePublicationRolloutMode(
    context,
    isRecord(profile?.business_brain) ? profile.business_brain : null
  );
  if (
    rolloutMode === "off" ||
    context.publication_workflow_v1 === false ||
    publicationFromContext(context).feature_enabled === false
  ) {
    return {
      ok: true,
      status: "idle",
      actions_run: [],
      message: "publication_workflow_off",
    };
  }
  if (typeof context.publication_reconciled_at !== "string") {
    await reconcilePublicationCaseRecord(db, loaded, {
      publicationMode: rolloutMode,
      featureEnabled: true,
      verifyRemote: true,
      dedupePendingNotifications: true,
    });
    loaded = (await getOperationalCase(db, caseId)) ?? loaded;
  }

  if (options?.skipLock) {
    // Caller already holds the lease (often 1 min from settings run). Extend
    // it so Ungga CLI (2–3 min) does not expire mid-flight and allow a second tick.
    const extended = await updateOperationalCase(
      db,
      loaded.id,
      loaded.version,
      {
        nextActionAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }
    ).catch(() => null);
    if (extended) loaded = extended;
  } else {
    const locked = await markCaseProcessing(db, loaded.id, loaded.version, 5);
    if (!locked) {
      return {
        ok: true,
        status: "already_processing",
        actions_run: [],
        message: `skipped_by_${source}`,
      };
    }
  }

  // Reload after lock bump (or after caller-held lease)
  let opCase = (await getOperationalCase(db, caseId)) ?? loaded;
  const seeded = await ensurePublicationSeeded(db, opCase);
  opCase = seeded.opCase;
  let publication = seeded.publication;
  const actionsRun: string[] = [];
  const fetchEasyBroker =
    options?.fetchEasyBrokerSnapshot ?? fetchEasyBrokerListingSnapshot;
  const fetchUngga = options?.fetchUnggaSnapshot ?? fetchUnggaListingSnapshot;

  if (options?.dryCompute || rolloutMode === "shadow") {
    const next = nextPublicationAction(publication);
    let shadowPreflight: PreflightResult | undefined;
    if ("destination" in next) {
      const destination = publication.destinations[next.destination];
      const contextNow = isRecord(opCase.context_jsonb)
        ? opCase.context_jsonb
        : {};
      let remote: Parameters<typeof runPublicationPreflight>[0]["remote"];
      try {
        if (next.destination === "easybroker" && destination.artifact.listing_id) {
          const snapshot = await fetchEasyBroker(db, {
            userId: opCase.user_id,
            listingId: destination.artifact.listing_id,
            internalId: opCase.id,
          });
          remote = snapshot
            ? {
                listing_id: snapshot.listing_id,
                status: snapshot.status,
                image_count: snapshot.image_count,
                images_ready:
                  snapshot.image_count >= destination.media.expected_count,
                fields: snapshot.fields,
              }
            : undefined;
        } else if (
          next.destination === "ungga" &&
          destination.artifact.ungga_property_id
        ) {
          const snapshot = await fetchUngga(db, {
            userId: opCase.user_id,
            unggaPropertyId: destination.artifact.ungga_property_id,
          });
          remote = snapshot
            ? {
                ungga_property_id: snapshot.ungga_property_id,
                status: snapshot.status,
                image_count: snapshot.image_count,
              }
            : undefined;
        }
      } catch {
        // Shadow reports the normal preflight with unavailable remote evidence.
      }
      shadowPreflight = runPublicationPreflight({
        destination: next.destination,
        publication,
        context: contextNow,
        photoManifest: parsePhotoManifest(contextNow.photo_manifest),
        remote,
        options: {
          requireWatermark: (
            await resolveRequireWatermark({
              db,
              userId: opCase.user_id,
              context: contextNow,
            })
          ).requireWatermark,
          contractRequired: true,
        },
      });
    }
    await updateOperationalCase(db, opCase.id, opCase.version, {
      context: {
        ...(isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {}),
        ...buildPublicationContextPatch(publication),
        package_ready_machine_work_in_flight: false,
      },
      nextActionAt: null,
    });
    return {
      ok: true,
      status: next.type === "idle" ? "idle" : "progressed",
      actions_run: actionsRun,
      next_action: next,
      publication,
      preflight: shadowPreflight,
      message: rolloutMode === "shadow" ? "publication_shadow_no_side_effects" : undefined,
    };
  }

  for (let step = 0; step < MAX_MACHINE_STEPS; step += 1) {
    const action = nextPublicationAction(publication);
    if (action.type === "idle") {
      const fresh = await getOperationalCase(db, caseId);
      if (fresh) {
        const mergedContext = {
          ...(isRecord(fresh.context_jsonb) ? fresh.context_jsonb : {}),
          ...buildPublicationContextPatch(publication),
          package_ready_machine_work_in_flight: false,
        };
        const hasInFlightLedger = (
          await listPublicationOperationsForCase(db, fresh.id, 50)
        ).some(
          (row) => row.status === "claimed" || row.status === "running"
        );
        const machineWorkInFlight =
          mergedContext.package_ready_machine_work_in_flight === true;
        const recentEventsForGate = await getRecentOperationalCaseEvents(
          db,
          fresh.id,
          30
        );
        const shouldFinalize = canFinalizePublicationClosure({
          idleReason: action.reason,
          allDestinationsResolved:
            areAllPublicationDestinationsResolved(publication),
          machineWorkInFlight,
          hasInFlightLedgerOperation: hasInFlightLedger,
          completionOk: canCompleteListingPublishedSummaryFromContext(
            mergedContext,
            recentEventsForGate,
            {
              machineWorkInFlight,
              hasInFlightLedgerOperation: hasInFlightLedger,
            }
          ).ok,
          currentStep: fresh.current_step,
        }).ok;

        if (shouldFinalize) {
          const recentEvents = recentEventsForGate;
          const alreadySent = recentEvents.some((event) => {
            const payload = isRecord(event.payload_jsonb)
              ? event.payload_jsonb
              : null;
            return (
              payload?.kind === "listing_published_summary_sent" ||
              payload?.kind === "listing_published_summary_resent"
            );
          });
          const sendCorrective =
            alreadySent &&
            shouldSendCorrectiveListingPublishedSummary(recentEvents);
          const closed = await updateOperationalCase(
            db,
            fresh.id,
            fresh.version,
            {
              context: mergedContext,
              status: "completed",
              currentStep: "published",
              nextActionAt: null,
            }
          );
          if (closed && (!alreadySent || sendCorrective)) {
            try {
              const summaryText = formatListingPublishedSummaryNotifyText(closed);
              const result = await notify(db, closed.user_id, {
                text: summaryText,
                kind: "listing_published_summary",
                data: {
                  case_id: closed.id,
                  ...(sendCorrective ? { corrective: true } : {}),
                },
              });
              if (result.delivered.length > 0) {
                await insertOperationalCaseEvent(db, {
                  caseId: closed.id,
                  eventType: "step_completed",
                  actor: "system",
                  stepKey: "published",
                  payload: {
                    kind: sendCorrective
                      ? "listing_published_summary_resent"
                      : "listing_published_summary_sent",
                  },
                });
              }
            } catch {
              // Closure must not fail if Telegram delivery fails.
            }
          }
          return {
            ok: true,
            status: "idle",
            actions_run: actionsRun,
            next_action: action,
            publication,
            message: "publication_finalized",
          };
        }

        if (
          shouldIdleFallbackSetWaitingInternal({
            status: fresh.status,
            currentStep: fresh.current_step,
          })
        ) {
          await updateOperationalCase(db, fresh.id, fresh.version, {
            context: mergedContext,
            status: "waiting_internal",
            nextActionAt: null,
          });
        }
      }
      return {
        ok: true,
        status: "idle",
        actions_run: actionsRun,
        next_action: action,
        publication,
      };
    }

    if (
      "destination" in action &&
      action.destination === "ungga"
    ) {
      const easybroker = publication.destinations.easybroker;
      const explicitlySkipped =
        easybroker.approval === "skipped" ||
        easybroker.approval === "rejected";
      if (!explicitlySkipped) {
        try {
          const easybrokerRemote = await fetchEasyBroker(db, {
            userId: opCase.user_id,
            listingId: easybroker.artifact.listing_id,
            internalId: opCase.id,
          });
          if (easybrokerRemote?.status !== "published") {
            const resumeAt = new Date(Date.now() + 30_000).toISOString();
            await updateOperationalCase(db, opCase.id, opCase.version, {
              status: "active",
              nextActionAt: resumeAt,
              context: {
                ...(isRecord(opCase.context_jsonb)
                  ? opCase.context_jsonb
                  : {}),
                ...buildPublicationContextPatch(publication),
                package_ready_machine_work_in_flight: false,
              },
            });
            return {
              ok: true,
              status: "waiting_remote",
              actions_run: actionsRun,
              next_action: action,
              publication,
              message:
                "ungga_waiting_for_easybroker_remote_published_or_explicit_skip",
            };
          }
        } catch (error) {
          return {
            ok: false,
            status: "failed",
            actions_run: actionsRun,
            next_action: action,
            publication,
            message:
              error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    actionsRun.push(`${action.type}:${"destination" in action ? action.destination : ""}`);

    if (action.type === "request_approval") {
      await requestDestinationApproval(db, opCase, action.destination);
      const fresh = await getOperationalCase(db, caseId);
      if (fresh) {
        await updateOperationalCase(db, fresh.id, fresh.version, {
          status: "waiting_internal",
          context: {
            ...(isRecord(fresh.context_jsonb) ? fresh.context_jsonb : {}),
            ...buildPublicationContextPatch(publication),
            package_ready_machine_work_in_flight: false,
          },
          nextActionAt: null,
        });
      }
      return {
        ok: true,
        status: "waiting_hitl",
        actions_run: actionsRun,
        next_action: action,
        publication,
      };
    }

    if (action.type === "request_review") {
      const contextNow = isRecord(opCase.context_jsonb)
        ? opCase.context_jsonb
        : {};
      const preflight = runPublicationPreflight({
        destination: action.destination,
        publication,
        context: contextNow,
        photoManifest: parsePhotoManifest(contextNow.photo_manifest),
      });
      publication = applyPublicationEvent(publication, {
        type: "preflight_result",
        destination: action.destination,
        status: "review_required",
        reason: preflight.summary,
      });
      const persisted = await persistPublication(db, opCase, publication);
      if (persisted) opCase = persisted;
      await requestConditionalReview(
        db,
        opCase,
        action.destination,
        preflight
      );
      return {
        ok: true,
        status: "waiting_hitl",
        actions_run: actionsRun,
        next_action: action,
        publication,
      };
    }

    if (action.type === "validate") {
      const contextNow = isRecord(opCase.context_jsonb)
        ? opCase.context_jsonb
        : {};
      const dest = publication.destinations[action.destination];
      let remote:
        | EasyBrokerListingSnapshot
        | UnggaListingSnapshot
        | null = null;
      try {
        if (action.destination === "ungga") {
          const easybroker = publication.destinations.easybroker;
          const explicitlySkipped =
            easybroker.approval === "skipped" ||
            easybroker.approval === "rejected";
          if (!explicitlySkipped) {
            const easybrokerRemote = await fetchEasyBroker(db, {
              userId: opCase.user_id,
              listingId: easybroker.artifact.listing_id,
              internalId: opCase.id,
            });
            if (easybrokerRemote?.status !== "published") {
              throw new Error(
                "ungga_blocked_until_easybroker_remotely_published"
              );
            }
          }
        }
        remote =
          action.destination === "easybroker"
            ? await fetchEasyBroker(db, {
                userId: opCase.user_id,
                listingId: dest.artifact.listing_id,
                internalId: opCase.id,
              })
            : dest.artifact.ungga_property_id
              ? await fetchUngga(db, {
                  userId: opCase.user_id,
                  unggaPropertyId: dest.artifact.ungga_property_id,
                })
              : null;
        if (
          action.destination === "easybroker" &&
          remote &&
          "listing_id" in remote
        ) {
          const manifest = parsePhotoManifest(contextNow.photo_manifest);
          const mismatches = compareEasyBrokerSnapshot({
            snapshot: remote,
            expectedInternalId: opCase.id,
            expectedImageCount: dest.media.required
              ? dest.media.expected_count
              : null,
            expectedImageTitles: dest.media.required
              ? imageTitlesFromManifest(
                  manifest,
                  imagePathsForUpload(manifest, true)
                )
              : undefined,
            expectedFields: expectedEasyBrokerCriticalFields(contextNow),
          });
          if (mismatches.length > 0) {
            throw new Error(
              `easybroker_remote_mismatch:${mismatches.join(",")}`
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          action.destination === "ungga" &&
          isUnggaApiCredentialsMissingError(error) &&
          canUseUnggaCliEvidence({
            unggaPropertyId: dest.artifact.ungga_property_id,
            mediaRequired: dest.media.required,
            mediaVerified: dest.media.verified,
          }) &&
          dest.artifact.ungga_property_id
        ) {
          // CLI-only accounts: GU-ID + verified media from prepare_draft is enough.
          remote = unggaSnapshotFromCliEvidence({
            unggaPropertyId: dest.artifact.ungga_property_id,
            draftUrl: dest.artifact.draft_url,
            publishedUrl: dest.artifact.published_url,
            remoteStatus: dest.artifact.remote_status,
            imageCount: dest.media.remote_count,
          });
        } else {
          publication = applyPublicationEvent(publication, {
            type: "preflight_result",
            destination: action.destination,
            status: "review_required",
            reason: `remote_verification_failed:${message}`,
          });
          const persisted = await persistPublication(db, opCase, publication);
          if (persisted) opCase = persisted;
          await requestConditionalReview(db, opCase, action.destination, {
            status: "blocked",
            issues: [
              {
                code: "remote_verification_failed",
                field: "remote",
                severity: "critical",
                message: `No se pudo verificar el destino remoto: ${message}`,
              },
            ],
            summary: "No se pudo verificar el estado remoto.",
          });
          return {
            ok: false,
            status: "waiting_hitl",
            actions_run: actionsRun,
            next_action: action,
            publication,
            message,
          };
        }
      }
      const watermarkGate = await resolveRequireWatermark({
        db,
        userId: opCase.user_id,
        context: contextNow,
      });
      let preflightContext = contextNow;
      if (
        watermarkGate.configured !== null &&
        contextNow.watermark_configured !== watermarkGate.configured
      ) {
        const stamped = await updateOperationalCase(db, opCase.id, opCase.version, {
          context: {
            ...contextNow,
            watermark_configured: watermarkGate.configured,
          },
        });
        if (stamped) {
          opCase = stamped;
          preflightContext = isRecord(stamped.context_jsonb)
            ? (stamped.context_jsonb as Record<string, unknown>)
            : {
                ...contextNow,
                watermark_configured: watermarkGate.configured,
              };
        } else {
          preflightContext = {
            ...contextNow,
            watermark_configured: watermarkGate.configured,
          };
        }
      }
      const preflight = runPublicationPreflight({
        destination: action.destination,
        publication,
        context: preflightContext,
        photoManifest: parsePhotoManifest(preflightContext.photo_manifest),
        remote:
          action.destination === "easybroker"
            ? {
                listing_id:
                  remote && "listing_id" in remote
                    ? remote.listing_id
                    : dest.artifact.listing_id,
                status: remote?.status ?? null,
                image_count:
                  remote && "image_count" in remote ? remote.image_count : null,
                images_ready:
                  remote &&
                  "image_count" in remote &&
                  typeof remote.image_count === "number"
                    ? remote.image_count >= dest.media.expected_count
                    : false,
                fields: remote && "fields" in remote ? remote.fields : undefined,
              }
            : {
                ungga_property_id:
                  remote && "ungga_property_id" in remote
                    ? remote.ungga_property_id
                    : null,
                status: remote?.status ?? null,
                image_count:
                  remote && "image_count" in remote ? remote.image_count : null,
              },
        options: {
          requireWatermark: watermarkGate.requireWatermark,
          contractRequired: true,
        },
      });
      publication = applyPublicationEvent(publication, {
        type: "preflight_result",
        destination: action.destination,
        status: preflight.status,
        reason: preflight.summary,
      });
      const persisted = await persistPublication(db, opCase, publication);
      if (persisted) opCase = persisted;

      if (preflight.status === "waiting") {
        const resumeAt = new Date(Date.now() + 30_000).toISOString();
        await updateOperationalCase(db, opCase.id, opCase.version, {
          nextActionAt: resumeAt,
          status: "active",
          context: {
            ...(isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {}),
            ...buildPublicationContextPatch(publication),
            package_ready_machine_work_in_flight: false,
          },
        });
        return {
          ok: true,
          status: "waiting_remote",
          actions_run: actionsRun,
          next_action: action,
          publication,
          message: preflight.summary,
        };
      }
      if (preflight.status === "review_required" || preflight.status === "blocked") {
        await requestConditionalReview(
          db,
          opCase,
          action.destination,
          preflight
        );
        return {
          ok: true,
          status: "waiting_hitl",
          actions_run: actionsRun,
          next_action: action,
          publication,
        };
      }
      continue;
    }

    if (action.type === "wait_remote_media") {
      const contextNow = isRecord(opCase.context_jsonb)
        ? opCase.context_jsonb
        : {};
      const dest = publication.destinations[action.destination];
      let remoteCount: number | null = null;
      let titlesMatch = true;
      try {
        if (action.destination === "easybroker") {
          const snapshot = await fetchEasyBroker(db, {
            userId: opCase.user_id,
            listingId: dest.artifact.listing_id,
            internalId: opCase.id,
          });
          if (!snapshot) throw new Error("easybroker_listing_not_found");
          remoteCount = snapshot.image_count;
          const manifest = parsePhotoManifest(contextNow.photo_manifest);
          const mismatches = compareEasyBrokerSnapshot({
            snapshot,
            expectedInternalId: opCase.id,
            expectedImageCount: dest.media.expected_count,
            expectedImageTitles: imageTitlesFromManifest(
              manifest,
              imagePathsForUpload(manifest, true)
            ),
          });
          titlesMatch = !mismatches.includes("image_titles_mismatch");
          if (mismatches.includes("internal_id_mismatch")) {
            throw new Error("easybroker_internal_id_mismatch");
          }
        } else if (dest.artifact.ungga_property_id) {
          try {
            const snapshot = await fetchUngga(db, {
              userId: opCase.user_id,
              unggaPropertyId: dest.artifact.ungga_property_id,
            });
            remoteCount = snapshot?.image_count ?? null;
          } catch (error) {
            if (
              isUnggaApiCredentialsMissingError(error) &&
              typeof dest.media.remote_count === "number"
            ) {
              remoteCount = dest.media.remote_count;
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publication = applyPublicationEvent(publication, {
          type: "media_failed",
          destination: action.destination,
          error: `remote_verification_failed:${message}`,
        });
        const persisted = await persistPublication(db, opCase, publication);
        if (persisted) opCase = persisted;
        await requestConditionalReview(db, opCase, action.destination, {
          status: "blocked",
          issues: [
            {
              code: "remote_media_verification_failed",
              field: "remote.images",
              severity: "critical",
              message: `No se pudo verificar imágenes remotas: ${message}`,
            },
          ],
          summary: "La verificación remota de imágenes requiere revisión.",
        });
        return {
          ok: false,
          status: "waiting_hitl",
          actions_run: actionsRun,
          next_action: action,
          publication,
          message,
        };
      }
      const expected = dest.media.expected_count;
      const countReady =
        typeof remoteCount === "number" &&
        remoteCount > 0 &&
        (action.destination === "ungga"
          ? unggaMediaCountSatisfied(remoteCount, expected)
          : expected <= 0 || remoteCount === expected);

      if (
        dest.media.submitted &&
        countReady &&
        titlesMatch &&
        typeof remoteCount === "number"
      ) {
        publication = applyPublicationEvent(publication, {
          type: "media_verified",
          destination: action.destination,
          remote_count: remoteCount,
        });
        const persisted = await persistPublication(db, opCase, publication);
        if (persisted) opCase = persisted;
        continue;
      }

      publication = {
        ...publication,
        destinations: {
          ...publication.destinations,
          [action.destination]: {
            ...dest,
            media: {
              ...dest.media,
              remote_count: remoteCount,
              last_checked_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          },
        },
      };
      const resumeAt = new Date(Date.now() + 20_000).toISOString();
      await updateOperationalCase(db, opCase.id, opCase.version, {
        nextActionAt: resumeAt,
        status: "active",
        context: {
          ...contextNow,
          ...buildPublicationContextPatch(publication),
          package_ready_machine_work_in_flight: false,
        },
      });
      return {
        ok: true,
        status: "waiting_remote",
        actions_run: actionsRun,
        next_action: action,
        publication,
        message: "waiting_for_remote_media",
      };
    }

    if (
      action.type === "create_draft" ||
      action.type === "process_media" ||
      action.type === "publish"
    ) {
      if (!options?.runAgentTick) {
        return {
          ok: false,
          status: "failed",
          actions_run: actionsRun,
          next_action: action,
          publication,
          message: "publication_executor_missing",
        };
      }
      const operationKey = `${action.type}:${action.destination}:${
        publication.destinations[action.destination].artifact.listing_id ??
        publication.destinations[action.destination].artifact.ungga_property_id ??
        "new"
      }`;
      let claim = await claimPublicationOperation(db, {
        caseId: opCase.id,
        destination: action.destination,
        operationKey,
        operationType: action.type,
        request: { source, action },
      }, {
        forceRetry: options.forceRetryFailedOperation === true,
      }).catch(() => null);

      // Auto-heal: process_media failed before EasyBroker side effects (e.g. watermark gate).
      if (
        claim?.status === "failed_terminal" &&
        action.type === "process_media" &&
        options.forceRetryFailedOperation !== true
      ) {
        const uploadToolCalls = await listEasyBrokerUploadToolCallsForCase(
          db,
          opCase.id
        );
        const safe = canSafelyForceRetryProcessMedia({
          operation: {
            status: claim.operation.status,
            operation_type: claim.operation.operation_type,
            error_text: claim.operation.error_text,
          },
          uploadToolCalls,
        });
        if (safe) {
          claim = await claimPublicationOperation(
            db,
            {
              caseId: opCase.id,
              destination: action.destination,
              operationKey,
              operationType: action.type,
              request: {
                source,
                action,
                auto_force_retry: "pre_remote_process_media",
              },
            },
            { forceRetry: true }
          ).catch(() => null);
        }
      }

      // Auto-heal: Ungga publish failed before CLI side effects (*_not_called).
      if (
        claim?.status === "failed_terminal" &&
        action.type === "publish" &&
        action.destination === "ungga" &&
        options.forceRetryFailedOperation !== true
      ) {
        const safe = canSafelyForceRetryUnggaPublish({
          operation: {
            status: claim.operation.status,
            operation_type: claim.operation.operation_type,
            error_text: claim.operation.error_text,
          },
        });
        if (safe) {
          claim = await claimPublicationOperation(
            db,
            {
              caseId: opCase.id,
              destination: action.destination,
              operationKey,
              operationType: action.type,
              request: {
                source,
                action,
                auto_force_retry: "pre_side_effect_ungga_publish",
              },
            },
            { forceRetry: true }
          ).catch(() => null);
        }
      }

      // Auto-heal: create_draft failed before any remote artifact (safe retry).
      // Without this, lab «Revisar avance» after «Reintentar preparación» hits
      // failed_terminal because the tick does not pass forceRetryFailedOperation.
      if (
        claim?.status === "failed_terminal" &&
        action.type === "create_draft" &&
        options.forceRetryFailedOperation !== true
      ) {
        const dest = publication.destinations[action.destination];
        const hasArtifact = Boolean(
          dest.artifact.listing_id || dest.artifact.ungga_property_id
        );
        if (!hasArtifact) {
          claim = await claimPublicationOperation(
            db,
            {
              caseId: opCase.id,
              destination: action.destination,
              operationKey,
              operationType: action.type,
              request: {
                source,
                action,
                auto_force_retry: "pre_artifact_create_draft",
              },
            },
            { forceRetry: true }
          ).catch(() => null);
        }
      }

      if (claim?.status === "reuse") {
        const result = isRecord(claim.operation.result_jsonb)
          ? claim.operation.result_jsonb
          : {};
        if (action.type === "create_draft") {
          publication = applyPublicationEvent(publication, {
            type: "draft_created",
            destination: action.destination,
            artifact: {
              listing_id: stringResult(result, ["listing_id", "public_id"]),
              public_id: stringResult(result, ["public_id"]),
              ungga_property_id: stringResult(result, [
                "ungga_property_id",
                "property_id",
                "id",
              ]),
              draft_url: stringResult(result, ["draft_url"]),
              remote_status: stringResult(result, [
                "easybroker_status",
                "status",
              ]),
            },
          });
        } else if (action.type === "process_media") {
          publication = applyProcessMediaPublicationEvents(
            publication,
            action.destination,
            result
          );
        } else {
          publication = applyPublicationEvent(publication, {
            type: "publish_succeeded",
            destination: action.destination,
            artifact: {
              published_url: stringResult(result, [
                "published_url",
                "public_url",
                "url",
              ]),
              remote_status: "published",
            },
          });
        }
        const persisted = await persistPublication(db, opCase, publication);
        if (persisted) opCase = persisted;
        continue;
      }
      if (claim?.status === "unknown_outcome") {
        publication = applyPublicationEvent(publication, {
          type: "draft_failed",
          destination: action.destination,
          error: "unknown_outcome_from_prior_operation",
          unknown: true,
        });
        await persistPublication(db, opCase, publication);
        return {
          ok: false,
          status: "failed",
          actions_run: actionsRun,
          publication,
          message: "unknown_outcome_requires_review",
        };
      }
      if (claim?.status === "in_flight") {
        // Stale lease from a killed deferred tick (common after Telegram
        // «Reintentar preparación» in next dev). Safe only when no remote
        // artifact exists yet for create_draft.
        const dest = publication.destinations[action.destination];
        const hasArtifact = Boolean(
          dest.artifact.listing_id || dest.artifact.ungga_property_id
        );
        const claimedAtMs = Date.parse(
          String(claim.operation.claimed_at ?? claim.operation.updated_at ?? "")
        );
        const staleMs = Number.isFinite(claimedAtMs)
          ? Date.now() - claimedAtMs
          : 0;
        const canReclaimStaleCreate =
          action.type === "create_draft" &&
          !hasArtifact &&
          staleMs >= 2 * 60_000;
        if (canReclaimStaleCreate) {
          await finishPublicationOperation(db, {
            operationId: claim.operation.id,
            status: "failed",
            errorText: "stale_in_flight_reclaimed",
            result: { auto_reclaim: "stale_create_draft" },
          }).catch(() => null);
          claim = await claimPublicationOperation(
            db,
            {
              caseId: opCase.id,
              destination: action.destination,
              operationKey,
              operationType: action.type,
              request: {
                source,
                action,
                auto_force_retry: "stale_in_flight_create_draft",
              },
            },
            { forceRetry: true }
          ).catch(() => null);
        } else {
          return {
            ok: true,
            status: "already_processing",
            actions_run: actionsRun,
            publication,
          };
        }
      }
      if (claim?.status === "failed_terminal") {
        return {
          ok: false,
          status: "failed",
          actions_run: actionsRun,
          publication,
          message: claim.operation.error_text ?? "prior_operation_failed",
        };
      }
      if (!claim || claim.status !== "claimed") {
        return {
          ok: false,
          status: "failed",
          actions_run: actionsRun,
          publication,
          message: "publication_operation_claim_failed",
        };
      }
      await markPublicationOperationRunning(db, claim.operation.id);

      if (action.type === "create_draft") {
        publication = applyPublicationEvent(publication, {
          type: "draft_started",
          destination: action.destination,
          operation_key: operationKey,
        });
      } else if (action.type === "publish") {
        publication = applyPublicationEvent(publication, {
          type: "publish_started",
          destination: action.destination,
          operation_key: operationKey,
        });
      }

      const gatePersist = await persistPublicationRunnerGate(
        db,
        opCase,
        publication,
        action
      );
      opCase = gatePersist.opCase;
      if (!gatePersist.ok) {
        const errorText = gatePersist.error;
        await finishPublicationOperation(db, {
          operationId: claim.operation.id,
          status: "failed",
          result: {},
          errorText,
        });
        publication = applyPublicationEvent(
          publication,
          action.type === "publish"
            ? {
                type: "publish_failed",
                destination: action.destination,
                error: errorText,
                unknown: false,
              }
            : action.type === "process_media"
              ? {
                  type: "media_failed",
                  destination: action.destination,
                  error: errorText,
                }
              : {
                  type: "draft_failed",
                  destination: action.destination,
                  error: errorText,
                  unknown: false,
                }
        );
        const failed = await persistPublication(db, opCase, publication, {
          package_ready_machine_work_in_flight: false,
          publication_runner_pending_action: null,
        });
        if (failed) opCase = failed;
        await insertOperationalCaseEvent(db, {
          caseId: opCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: "package_ready",
          payload: {
            kind: "publication_operation_failed",
            destination: action.destination,
            operation_type: action.type,
            error: errorText,
            unknown_outcome: false,
            source,
          },
        });
        return {
          ok: false,
          status: "failed",
          actions_run: actionsRun,
          next_action: action,
          publication,
          message: errorText,
        };
      }

      let execution: PublicationExecutionResult;
      try {
        execution = await options.runAgentTick(opCase, action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        execution = {
          status: isUnknownExternalFailure(message)
            ? "unknown_outcome"
            : "failed",
          error: message,
        };
      }
      const afterExecution = await getOperationalCase(db, caseId);
      if (afterExecution) {
        opCase = afterExecution;
        publication = publicationFromContext(
          isRecord(afterExecution.context_jsonb)
            ? afterExecution.context_jsonb
            : {}
        );
      }
      const result = execution.result ?? {};
      let errorText =
        execution.error ??
        (execution.status === "pending_hitl"
          ? "technical_hitl_pending_no_external_execution"
          : execution.status === "not_executed"
            ? "expected_publication_tool_not_executed"
            : "publication_operation_failed");

      if (execution.status === "pending_hitl") {
        // Keep runner ownership; human must confirm the technical tool call.
        // Do not mark the ledger/destination as failed — that blocks retries.
        const waiting = await persistPublication(db, opCase, publication, {
          package_ready_machine_work_in_flight: true,
          publication_runner_pending_action: action,
        });
        if (waiting) opCase = waiting;
        await insertOperationalCaseEvent(db, {
          caseId: opCase.id,
          eventType: "state_changed",
          actor: "system",
          stepKey: "package_ready",
          payload: {
            kind: "publication_technical_hitl_pending",
            destination: action.destination,
            operation_type: action.type,
            error: errorText,
            source,
          },
        });
        return {
          ok: true,
          status: "waiting_hitl",
          actions_run: actionsRun,
          next_action: action,
          publication,
          message: errorText,
        };
      }

      if (execution.status === "succeeded" && action.type === "publish") {
        try {
          const destination = publication.destinations[action.destination];
          if (action.destination === "easybroker") {
            const snapshot = await fetchEasyBroker(db, {
              userId: opCase.user_id,
              listingId:
                destination.artifact.listing_id ??
                stringResult(result, ["listing_id", "public_id"]),
              internalId: opCase.id,
            });
            const contextNow = isRecord(opCase.context_jsonb)
              ? opCase.context_jsonb
              : {};
            const manifest = parsePhotoManifest(contextNow.photo_manifest);
            const mismatches = snapshot
              ? compareEasyBrokerSnapshot({
                  snapshot,
                  expectedInternalId: opCase.id,
                  expectedImageCount: destination.media.required
                    ? destination.media.expected_count
                    : null,
                  expectedImageTitles: destination.media.required
                    ? imageTitlesFromManifest(
                        manifest,
                        imagePathsForUpload(manifest, true)
                      )
                    : undefined,
                  expectedFields:
                    expectedEasyBrokerCriticalFields(contextNow),
                })
              : ["listing_missing"];
            if (
              !snapshot ||
              snapshot.status !== "published" ||
              mismatches.length > 0
            ) {
              execution = {
                status: "unknown_outcome",
                result,
                error: `easybroker_post_publish_not_confirmed:${mismatches.join(",")}`,
              };
            } else {
              result.remote_status = snapshot.status;
              result.published_url =
                stringResult(snapshot.raw, ["public_url", "url"]) ??
                stringResult(result, ["published_url", "public_url", "url"]);
            }
          } else {
            const propertyId =
              destination.artifact.ungga_property_id ??
              stringResult(result, ["ungga_property_id", "property_id", "id"]);
            let snapshot: UnggaListingSnapshot | null = null;
            try {
              snapshot = propertyId
                ? await fetchUngga(db, {
                    userId: opCase.user_id,
                    unggaPropertyId: propertyId,
                  })
                : null;
            } catch (error) {
              if (
                isUnggaApiCredentialsMissingError(error) &&
                propertyId &&
                (stringResult(result, [
                  "published_url",
                  "public_url",
                  "url",
                ]) ||
                  result.ok === true)
              ) {
                snapshot = unggaSnapshotFromCliEvidence({
                  unggaPropertyId: propertyId,
                  publishedUrl: stringResult(result, [
                    "published_url",
                    "public_url",
                    "url",
                  ]),
                  draftUrl: stringResult(result, ["draft_url"]),
                  remoteStatus: "published",
                  imageCount: destination.media.remote_count,
                });
              } else {
                throw error;
              }
            }
            if (!snapshot || snapshot.status !== "published") {
              execution = {
                status: "unknown_outcome",
                result,
                error: "ungga_post_publish_not_confirmed",
              };
            } else {
              result.remote_status = snapshot.status;
              result.published_url =
                snapshot.published_url ??
                stringResult(result, ["published_url", "public_url", "url"]);
            }
          }
        } catch (error) {
          execution = {
            status: "unknown_outcome",
            result,
            error:
              error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (execution.error) errorText = execution.error;

      if (execution.status === "succeeded") {
        await finishPublicationOperation(db, {
          operationId: claim.operation.id,
          status: "succeeded",
          result,
        });
        if (action.type === "create_draft") {
          publication = applyPublicationEvent(publication, {
            type: "draft_created",
            destination: action.destination,
            artifact: {
              listing_id: stringResult(result, ["listing_id", "public_id"]),
              public_id: stringResult(result, ["public_id"]),
              ungga_property_id: stringResult(result, [
                "ungga_property_id",
                "property_id",
                "id",
              ]),
              draft_url: stringResult(result, ["draft_url"]),
              published_url: stringResult(result, [
                "published_url",
                "public_url",
                "url",
              ]),
              remote_status: stringResult(result, [
                "easybroker_status",
                "remote_status",
                "status",
              ]),
              image_count:
                typeof result.image_count === "number"
                  ? result.image_count
                  : typeof result.uploaded_image_count === "number"
                    ? result.uploaded_image_count
                    : null,
              images_uploaded: result.images_submitted === true,
              images_status:
                result.images_verified === true
                  ? "verified"
                  : result.images_submitted === true
                    ? "submitted"
                    : null,
            },
          });
          if (action.destination === "ungga") {
            const expectedCount =
              typeof result.expected_image_count === "number" &&
              result.expected_image_count > 0
                ? result.expected_image_count
                : publication.destinations.ungga.media.expected_count;
            const uploadedCount =
              typeof result.uploaded_image_count === "number"
                ? result.uploaded_image_count
                : typeof result.image_count === "number"
                  ? result.image_count
                  : null;
            const mediaVerified =
              result.images_verified === true ||
              (typeof expectedCount === "number" &&
                expectedCount > 0 &&
                unggaMediaCountSatisfied(uploadedCount, expectedCount));
            const mediaSubmitted =
              result.images_submitted === true || mediaVerified;
            if (mediaSubmitted && typeof expectedCount === "number" && expectedCount > 0) {
              publication = applyPublicationEvent(publication, {
                type: "media_submitted",
                destination: "ungga",
                expected_count: expectedCount,
              });
              if (mediaVerified && typeof uploadedCount === "number") {
                publication = applyPublicationEvent(publication, {
                  type: "media_verified",
                  destination: "ungga",
                  remote_count: uploadedCount,
                });
              }
            } else if (
              publication.destinations.ungga.media.required &&
              publication.destinations.ungga.media.expected_count > 0
            ) {
              // Keep Ungga out of process_media dead-end: without verified
              // media evidence, force review instead of inventing a media tool.
              publication = applyPublicationEvent(publication, {
                type: "preflight_result",
                destination: "ungga",
                status: "review_required",
                reason: "ungga_media_not_verified_after_prepare_draft",
              });
            }
          }
        } else if (action.type === "process_media") {
          publication = applyProcessMediaPublicationEvents(
            publication,
            action.destination,
            result
          );
        } else {
          publication = applyPublicationEvent(publication, {
            type: "publish_succeeded",
            destination: action.destination,
            artifact: {
              published_url: stringResult(result, [
                "published_url",
                "public_url",
                "url",
              ]),
              remote_status: "published",
            },
          });
        }
        const completed = await persistPublication(db, opCase, publication, {
          package_ready_machine_work_in_flight: false,
          publication_runner_pending_action: null,
        });
        if (completed) opCase = completed;
        continue;
      }

      const unknown =
        execution.status === "unknown_outcome" ||
        (action.destination === "ungga" && isUnknownExternalFailure(errorText));
      await finishPublicationOperation(db, {
        operationId: claim.operation.id,
        status: unknown ? "unknown_outcome" : "failed",
        result,
        errorText,
      });
      publication = applyPublicationEvent(
        publication,
        action.type === "publish"
          ? {
              type: "publish_failed",
              destination: action.destination,
              error: errorText,
              unknown,
            }
          : action.type === "process_media"
            ? {
                type: "media_failed",
                destination: action.destination,
                error: errorText,
              }
            : {
                type: "draft_failed",
                destination: action.destination,
                error: errorText,
                unknown,
              }
      );
      const failed = await persistPublication(db, opCase, publication, {
        package_ready_machine_work_in_flight: false,
        publication_runner_pending_action: null,
      });
      if (failed) opCase = failed;
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "package_ready",
        payload: {
          kind: "publication_operation_failed",
          destination: action.destination,
          operation_type: action.type,
          error: errorText,
          unknown_outcome: unknown,
          source,
        },
      });
      if (unknown) {
        await requestConditionalReview(db, opCase, action.destination, {
          status: "blocked",
          issues: [
            {
              code: "unknown_external_outcome",
              field: "publication.phase",
              severity: "critical",
              message:
                "La operación externa terminó por timeout/kill o no pudo verificarse; no se reintentará automáticamente.",
            },
          ],
          summary: "Resultado externo desconocido; revisión obligatoria.",
        });
      } else if (looksLikePublicationCredentialAuthFailure(errorText)) {
        // Surface Settings remediation immediately (don't wait for a later tick
        // to discover phase=failed → request_review via generic preflight).
        await requestConditionalReview(db, opCase, action.destination, {
          status: "blocked",
          issues: [
            {
              code: "credential_auth_failure",
              field: "account_tool_secrets",
              severity: "critical",
              message:
                "La API key / credencial del destino no es válida. Actualízala en Ajustes → Cuentas externas.",
            },
          ],
          summary: "Credencial inválida; actualiza la conexión en Ajustes.",
        });
      } else if (
        action.destination === "ungga" &&
        action.type === "create_draft"
      ) {
        const resultLastStep =
          typeof result.last_step === "object" &&
          result.last_step &&
          typeof (result.last_step as { step?: unknown }).step === "string"
            ? String((result.last_step as { step: string }).step)
            : null;
        const cliStep = inferUnggaPrepareCliStep(errorText, resultLastStep);
        const prepareExtras = {
          last_step: {
            step: cliStep,
            error: errorText,
          },
          commission_verify:
            result.commission_verify &&
            typeof result.commission_verify === "object"
              ? (result.commission_verify as {
                  error?: string | null;
                  persisted?: boolean;
                })
              : null,
          commission_verified:
            typeof result.commission_verified === "boolean"
              ? result.commission_verified
              : undefined,
        };
        const expectedCount =
          typeof result.expected_image_count === "number"
            ? result.expected_image_count
            : publication.destinations.ungga.media.expected_count;
        const uploadedCount =
          typeof result.uploaded_image_count === "number"
            ? result.uploaded_image_count
            : typeof result.image_count === "number"
              ? result.image_count
              : null;

        // Project media counts so HITL does not show "observadas ?"
        if (
          typeof expectedCount === "number" ||
          typeof uploadedCount === "number"
        ) {
          const destNow = publication.destinations.ungga;
          publication = {
            ...publication,
            destinations: {
              ...publication.destinations,
              ungga: {
                ...destNow,
                media: {
                  ...destNow.media,
                  expected_count:
                    typeof expectedCount === "number" && expectedCount > 0
                      ? expectedCount
                      : destNow.media.expected_count,
                  remote_count:
                    typeof uploadedCount === "number"
                      ? uploadedCount
                      : destNow.media.remote_count,
                },
                updated_at: new Date().toISOString(),
              },
            },
          };
          const projected = await persistPublication(db, opCase, publication);
          if (projected) opCase = projected;
        }

        const mediaPrepareFailure = looksLikeUnggaPrepareDraftMediaFailure(
          errorText,
          prepareExtras
        );
        const destAfterFail = publication.destinations.ungga;
        const autoRetriesUsed =
          typeof destAfterFail.prepare_auto_retries_used === "number"
            ? destAfterFail.prepare_auto_retries_used
            : 0;
        if (mediaPrepareFailure && autoRetriesUsed < 1) {
          publication = {
            ...publication,
            destinations: {
              ...publication.destinations,
              ungga: {
                ...destAfterFail,
                phase: "draft_pending",
                operation_key: null,
                review_reason: null,
                prepare_auto_retries_used: autoRetriesUsed + 1,
                last_error: errorText,
                updated_at: new Date().toISOString(),
              },
            },
          };
          const resumeAt = new Date(Date.now() + 20_000).toISOString();
          const contextNow = isRecord(opCase.context_jsonb)
            ? opCase.context_jsonb
            : {};
          const scheduled = await updateOperationalCase(
            db,
            opCase.id,
            opCase.version,
            {
              status: "active",
              nextActionAt: resumeAt,
              context: {
                ...contextNow,
                ...buildPublicationContextPatch(publication),
                package_ready_machine_work_in_flight: false,
                publication_runner_pending_action: null,
              },
            }
          );
          if (scheduled) opCase = scheduled;
          await insertOperationalCaseEvent(db, {
            caseId: opCase.id,
            eventType: "state_changed",
            actor: "system",
            stepKey: "package_ready",
            payload: {
              kind: "ungga_prepare_draft_auto_retry",
              destination: "ungga",
              cause: errorText,
              attempt: autoRetriesUsed + 1,
              resume_at: resumeAt,
            },
          });
          return {
            ok: true,
            status: "waiting_remote",
            actions_run: actionsRun,
            next_action: { type: "create_draft", destination: "ungga" },
            publication,
            message: "ungga_prepare_draft_media_auto_retry",
          };
        }

        if (
          looksLikeUnggaPrepareDraftCommissionFailure(errorText, prepareExtras)
        ) {
          await requestConditionalReview(db, opCase, action.destination, {
            status: "review_required",
            issues: [
              {
                code: "ungga_prepare_draft_commission_failed",
                field: "commission_pct",
                severity: "critical",
                message:
                  "No se pudo capturar/verificar la comisión pactada antes de guardar el borrador en Ungga.",
              },
            ],
            summary:
              "No se pudo publicar en Ungga (comisión); puedes reintentar de forma segura.",
          });
        } else if (mediaPrepareFailure) {
          await requestConditionalReview(db, opCase, action.destination, {
            status: "review_required",
            issues: [
              {
                code: "ungga_prepare_draft_media_failed",
                field: "media",
                severity: "critical",
                message:
                  "No se pudieron cargar las fotos del anuncio en Ungga antes de guardar el borrador.",
              },
            ],
            summary:
              "No se pudieron cargar las fotos en Ungga; puedes reintentar la publicación de forma segura.",
          });
        } else if (
          looksLikeUnggaPrepareDraftFailure(errorText, prepareExtras)
        ) {
          const cause = resolveUnggaPrepareDraftFailureCause(
            errorText,
            prepareExtras
          );
          await requestConditionalReview(db, opCase, action.destination, {
            status: "review_required",
            issues: [
              {
                code:
                  cause === "media"
                    ? "ungga_prepare_draft_media_failed"
                    : "ungga_prepare_draft_failed",
                field: cause === "media" ? "media" : "prepare_draft",
                severity: "critical",
                message:
                  cause === "media"
                    ? "No se pudieron cargar las fotos del anuncio en Ungga antes de guardar el borrador."
                    : "No se pudo completar el borrador en Ungga antes de guardarlo.",
              },
            ],
            summary:
              cause === "media"
                ? "No se pudieron cargar las fotos en Ungga; puedes reintentar la publicación de forma segura."
                : "No se pudo completar el borrador en Ungga; puedes reintentar la publicación de forma segura.",
          });
        }
      }
      return {
        ok: false,
        status: "failed",
        actions_run: actionsRun,
        next_action: action,
        publication,
        message: errorText,
      };
    }
  }

  return {
    ok: true,
    status: "progressed",
    actions_run: actionsRun,
    publication,
    message: "max_machine_steps_reached",
  };
}

/** Helpers for agent ticks / adapters to update publication after tools. */
export async function recordPublicationDraftCreated(
  db: DbClient,
  caseId: string,
  destination: PublicationDestination,
  artifact: Record<string, unknown>
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = publicationFromContext(context);
  publication = applyPublicationEvent(publication, {
    type: "draft_created",
    destination,
    artifact: {
      listing_id:
        typeof artifact.listing_id === "string" ? artifact.listing_id : null,
      public_id:
        typeof artifact.public_id === "string" ? artifact.public_id : null,
      ungga_property_id:
        typeof artifact.ungga_property_id === "string"
          ? artifact.ungga_property_id
          : null,
      draft_url:
        typeof artifact.draft_url === "string" ? artifact.draft_url : null,
      published_url:
        typeof artifact.published_url === "string" ||
        typeof artifact.public_url === "string" ||
        typeof artifact.url === "string"
          ? String(
              artifact.published_url ?? artifact.public_url ?? artifact.url
            )
          : null,
      agent_url:
        typeof artifact.agent_url === "string" ? artifact.agent_url : null,
      remote_status:
        typeof artifact.status === "string" ? artifact.status : "not_published",
    },
  });
  await persistPublication(db, opCase, publication);
}

export async function recordPublicationMediaSubmitted(
  db: DbClient,
  caseId: string,
  destination: PublicationDestination,
  expectedCount: number
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = publicationFromContext(context);
  publication = applyPublicationEvent(publication, {
    type: "media_submitted",
    destination,
    expected_count: expectedCount,
  });
  await persistPublication(db, opCase, publication);
}

export async function recordPublicationPublished(
  db: DbClient,
  caseId: string,
  destination: PublicationDestination,
  artifact?: Record<string, unknown>
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = publicationFromContext(context);
  publication = applyPublicationEvent(publication, {
    type: "publish_succeeded",
    destination,
    artifact: artifact
      ? {
          published_url:
            typeof artifact.published_url === "string"
              ? artifact.published_url
              : typeof artifact.public_url === "string"
                ? artifact.public_url
                : null,
          remote_status: "published",
        }
      : undefined,
  });
  await persistPublication(db, opCase, publication);
}

async function listEasyBrokerUploadToolCallsForCase(
  db: DbClient,
  caseId: string
): Promise<
  Array<{
    tool_name: string;
    status?: string | null;
    result_json?: Record<string, unknown> | null;
  }>
> {
  const { data, error } = await db
    .from("tool_calls")
    .select("tool_name,status,result_json,arguments_json,created_at")
    .eq("tool_name", "easybroker_upload_images")
    .contains("arguments_json", { case_id: caseId })
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !Array.isArray(data)) return [];
  return data.map((row) => ({
    tool_name: String(row.tool_name ?? "easybroker_upload_images"),
    status: typeof row.status === "string" ? row.status : null,
    result_json: isRecord(row.result_json) ? row.result_json : null,
  }));
}

export function buildPublicationAgentHint(
  action: PublicationMachineAction,
  context: Record<string, unknown>
): string {
  if (action.type === "idle") {
    return "No hay trabajo de publicación pendiente.";
  }
  const destination =
    "destination" in action ? action.destination : "easybroker";
  const manifest = parsePhotoManifest(context.photo_manifest);
  const paths = imagePathsForUpload(manifest, true);
  const titles = imageTitlesFromManifest(manifest, paths);
  const urls = publicImageUrlsFromManifest(manifest);

  if (action.type === "create_draft" && destination === "easybroker") {
    return [
      "PUBLICATION RUNNER: crea el listing EasyBroker.",
      "Llama easybroker_create_listing(case_id) UNA vez.",
      "No inventes custom_fields ni image_titles.",
      "No pidas Ungga ni publiques todavía.",
    ].join(" ");
  }
  if (action.type === "process_media" && destination === "easybroker") {
    const watermarkConfigured = context.watermark_configured;
    const watermarkHint =
      watermarkConfigured === false
        ? "No hay watermark de marca: el adapter sube fotos originales."
        : "Si hay logo de marca, el adapter aplica watermark solo; no inventes upload_path.";
    return [
      "PUBLICATION RUNNER: sube fotos a EasyBroker.",
      watermarkHint,
      "Llama easybroker_upload_images({ case_id, listing_id }) UNA vez.",
      "No construyas images/upload_path; el adapter deriva pares desde photo_manifest.",
      paths.length
        ? `Referencia de identidad (source_path): ${JSON.stringify(paths)}.`
        : "Deriva identidad desde photo_manifest/raw_photos.",
      titles.some(Boolean)
        ? `Títulos del manifest (solo referencia): ${JSON.stringify(titles)}.`
        : "No inventes image_titles.",
      "No pidas Ungga en este tick.",
    ].join(" ");
  }
  if (action.type === "create_draft" && destination === "ungga") {
    return [
      "PUBLICATION RUNNER: prepara borrador Ungga.",
      "OBLIGATORIO: llama ungga_publish_listing({ action: \"prepare_draft\", case_id }) UNA vez en ESTE turno.",
      "Pasa SOLO action + case_id. NO pases image_urls, title ni price; el adapter los deriva del caso.",
      "NO uses publish_draft.",
      "NO narres fallos previos de media/formulario sin haber ejecutado la tool ahora.",
      urls.length
        ? `El caso ya tiene ${urls.length} public_url en photo_manifest (el adapter las usa).`
        : "Si faltan public_url en photo_manifest, el adapter fallará con hint claro.",
      "Omite strings vacíos.",
    ].join(" ");
  }
  if (action.type === "publish" && destination === "ungga") {
    return [
      "PUBLICATION RUNNER: publica borrador Ungga ya validado.",
      "Llama ungga_publish_listing(action=publish_draft, case_id) con ungga_property_id del contexto.",
      "No re-crees el draft.",
    ].join(" ");
  }
  if (action.type === "publish" && destination === "easybroker") {
    return [
      "PUBLICATION RUNNER: publica EasyBroker (status published).",
      "Llama easybroker_publish_listing(case_id, listing_id) UNA vez.",
      "No re-crees el listing ni re-subas fotos.",
    ].join(" ");
  }
  return `PUBLICATION RUNNER action=${action.type} destination=${destination}`;
}
