/**
 * Recovery helpers for publication cases closed prematurely (e.g. while Ungga
 * publish was still in-flight or failed with *_not_called).
 */

import {
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listPublicationOperationsForCase,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { canCompleteListingPublishedSummaryFromContext } from "@agents/agent";
import {
  buildPublicationContextPatch,
  publicationFromContext,
  type PublicationPhase,
} from "@/lib/operational-cases/publication-workflow";
import { isPreSideEffectUnggaPublishError } from "@/lib/business-decisions/publication-review";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Steps from which the runner may finalize a publication case.
 * `published` is included so a case whose step was advanced by the agent
 * before the runner's idle pass does not get stuck as
 * `waiting_internal / published` (the runner used to require `package_ready`).
 */
const FINALIZABLE_PUBLICATION_STEPS = new Set(["package_ready", "published"]);

/**
 * Pure closure gate for the publication runner's idle pass. All inputs are
 * computed by the caller (DB reads stay in the runner); keeping this pure
 * makes the invariant testable without a database.
 */
export function canFinalizePublicationClosure(params: {
  /** `nextPublicationAction(...).reason` when the machine is idle. */
  idleReason: string | null | undefined;
  allDestinationsResolved: boolean;
  machineWorkInFlight: boolean;
  hasInFlightLedgerOperation: boolean;
  /** Result of the strict `canCompleteListingPublishedSummaryFromContext` gate. */
  completionOk: boolean;
  currentStep: string | null | undefined;
}): { ok: boolean; reason?: string } {
  if (params.idleReason !== "all_destinations_resolved") {
    return { ok: false, reason: "idle_reason_not_all_destinations_resolved" };
  }
  if (!params.allDestinationsResolved) {
    return { ok: false, reason: "destinations_unresolved" };
  }
  if (params.machineWorkInFlight) {
    return { ok: false, reason: "machine_work_in_flight" };
  }
  if (params.hasInFlightLedgerOperation) {
    return { ok: false, reason: "ledger_operation_in_flight" };
  }
  if (!params.completionOk) {
    return { ok: false, reason: "completion_gate_failed" };
  }
  const step = typeof params.currentStep === "string" ? params.currentStep : "";
  if (!FINALIZABLE_PUBLICATION_STEPS.has(step)) {
    return { ok: false, reason: `step_not_finalizable:${step || "unknown"}` };
  }
  return { ok: true };
}

/**
 * The runner's idle fallback used to write `waiting_internal` unconditionally.
 * Never downgrade a case that is already closed (`completed`), and never
 * re-open a case already sitting at `published` with a passing gate — that
 * combination is owned by the finalize path.
 */
export function shouldIdleFallbackSetWaitingInternal(params: {
  status: string | null | undefined;
  currentStep: string | null | undefined;
}): boolean {
  if (params.status === "completed") return false;
  return true;
}

/**
 * Reopen a case that was marked completed/published without strict Ungga
 * evidence. Preserves the CLI GU-ID; never creates a new draft.
 */
export async function reopenPrematurelyClosedPublicationCase(
  db: DbClient,
  params: {
    caseId: string;
    userId: string;
    reason?: string;
  }
): Promise<{
  ok: boolean;
  status: string;
  message: string;
  case_id?: string;
  ungga_property_id?: string | null;
}> {
  const opCase = await getOperationalCase(db, params.caseId);
  if (!opCase || opCase.user_id !== params.userId) {
    return {
      ok: false,
      status: "case_not_found",
      message: "No encontré el caso.",
    };
  }

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const recentEvents = await getRecentOperationalCaseEvents(db, opCase.id, 40);
  const alreadyReopened = recentEvents.some((event) => {
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : null;
    return payload?.kind === "publication_closure_reopened";
  });

  const completion = canCompleteListingPublishedSummaryFromContext(
    context,
    recentEvents
  );

  const isPrematureClosure =
    (opCase.status === "completed" || opCase.current_step === "published") &&
    !completion.ok;

  if (!isPrematureClosure) {
    return {
      ok: false,
      status: "not_premature",
      message: completion.ok
        ? "El caso ya cumple el gate estricto de cierre; no se reabre."
        : "El caso no está en completed/published prematuro.",
      case_id: opCase.id,
    };
  }

  if (alreadyReopened) {
    return {
      ok: true,
      status: "already_reopened",
      message: "El caso ya fue reabierto por cierre prematuro.",
      case_id: opCase.id,
    };
  }

  let publication = publicationFromContext(context);
  const ungga = publication.destinations.ungga;
  const unggaId =
    typeof ungga.artifact.ungga_property_id === "string"
      ? ungga.artifact.ungga_property_id
      : null;

  // Keep CLI draft; reset Ungga to publish_pending when we have a GU-ID and
  // the ledger shows a pre-side-effect publish failure.
  const ops = await listPublicationOperationsForCase(db, opCase.id, 50);
  const failedPublish = ops.find(
    (row) =>
      row.destination === "ungga" &&
      row.operation_type === "publish" &&
      row.status === "failed" &&
      isPreSideEffectUnggaPublishError(row.error_text)
  );

  let nextUnggaPhase: PublicationPhase = ungga.phase;
  if (unggaId && failedPublish) {
    nextUnggaPhase = "publish_pending";
  } else if (
    ungga.phase === "published" &&
    !(
      isRecord(context.published) &&
      isRecord(context.published.ungga) &&
      typeof context.published.ungga.published_url === "string" &&
      context.published.ungga.published_url.trim()
    )
  ) {
    nextUnggaPhase = unggaId ? "publish_pending" : ungga.phase;
  } else if (ungga.phase === "failed" || ungga.phase === "unknown_outcome") {
    nextUnggaPhase = unggaId ? "publish_pending" : "review_required";
  }

  publication = {
    ...publication,
    destinations: {
      ...publication.destinations,
      ungga: {
        ...ungga,
        phase: nextUnggaPhase,
        last_error: failedPublish?.error_text ?? ungga.last_error,
        review_reason:
          nextUnggaPhase === "review_required"
            ? "reopened_after_premature_closure"
            : null,
        preflight: nextUnggaPhase === "publish_pending" ? "pass" : ungga.preflight,
        updated_at: new Date().toISOString(),
      },
    },
  };

  const published = isRecord(context.published) ? { ...context.published } : {};
  const unggaPublished = isRecord(published.ungga) ? { ...published.ungga } : {};
  // Keep ungga_property_id / draft_url; clear false "published" status.
  if (
    unggaPublished.status === "published" &&
    typeof unggaPublished.published_url !== "string"
  ) {
    unggaPublished.status = "draft";
  }

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "active",
    currentStep: "package_ready",
    nextActionAt: new Date().toISOString(),
    context: {
      ...context,
      ...buildPublicationContextPatch(publication),
      published: {
        ...published,
        ungga: unggaPublished,
      },
      package_ready_machine_work_in_flight: false,
      publication_runner_pending_action: null,
    },
  });

  if (!updated) {
    return {
      ok: false,
      status: "version_conflict",
      message: "El caso cambió; intenta de nuevo.",
      case_id: opCase.id,
    };
  }

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: "package_ready",
    payload: {
      kind: "publication_closure_reopened",
      reason: params.reason ?? "premature_completion_without_ungga_url",
      ungga_property_id: unggaId,
      previous_status: opCase.status,
      previous_step: opCase.current_step,
      next_ungga_phase: nextUnggaPhase,
      allow_corrective_summary: true,
    },
  });

  return {
    ok: true,
    status: "reopened",
    message:
      "Caso reabierto a package_ready conservando el GU-ID CLI. Listo para retry de publish.",
    case_id: opCase.id,
    ungga_property_id: unggaId,
  };
}

/**
 * After a corrective re-close, allow one resent summary even if
 * listing_published_summary_sent already exists (idempotent via
 * listing_published_summary_resent).
 */
export function shouldSendCorrectiveListingPublishedSummary(
  recentEvents: Array<{ payload_jsonb?: unknown }>
): boolean {
  let reopened = false;
  let resent = false;
  for (const event of recentEvents) {
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : null;
    if (!payload) continue;
    if (payload.kind === "publication_closure_reopened") reopened = true;
    if (payload.kind === "listing_published_summary_resent") resent = true;
  }
  return reopened && !resent;
}
