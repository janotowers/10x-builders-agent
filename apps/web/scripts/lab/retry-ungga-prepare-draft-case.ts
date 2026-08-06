/**
 * Lab/ops: reclaim a stuck Ungga create_draft (no GU-ID) and re-run prepare_draft.
 *
 * Use when the ledger row is unknown_outcome/failed and the destination has no
 * artifact — e.g. login/nav timeout, or unknown_outcome_from_prior_operation.
 *
 * Usage:
 *   RECOVERY_CASE_ID=<uuid> npx tsx --env-file=.env.local scripts/lab/retry-ungga-prepare-draft-case.ts
 */
import {
  createServerClient,
  finishPublicationOperation,
  getOperationalCase,
  listPublicationOperationsForCase,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
} from "@agents/db";
import { ensureAgentToolDepsWired } from "../../src/lib/agent/wire-tool-deps";
import {
  buildPublicationContextPatch,
  publicationFromContext,
} from "../../src/lib/operational-cases/publication-workflow";
import { requestPublicationProgress } from "../../src/lib/operational-cases/publication-runner";
import { createPublicationRunnerOwnedAgentTick } from "../../src/lib/operational-cases/run-settings-test-case-tick";
import { resolveRecoveryCaseContext } from "./recovery-env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  console.log("wiring agent deps...");
  ensureAgentToolDepsWired();
  const db = createServerClient();
  const { caseId, userId } = await resolveRecoveryCaseContext(db, {});

  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) throw new Error(`case not found: ${caseId}`);

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  let publication = publicationFromContext(context);
  const ungga = publication.destinations.ungga;
  const hasArtifact = Boolean(
    ungga.artifact.listing_id || ungga.artifact.ungga_property_id
  );
  if (hasArtifact) {
    throw new Error(
      `Ungga already has artifact ${ungga.artifact.ungga_property_id ?? ungga.artifact.listing_id}. Use retry-ungga-publish-case.ts instead.`
    );
  }

  console.log(
    "BEFORE",
    JSON.stringify(
      {
        status: opCase.status,
        current_step: opCase.current_step,
        ungga_phase: ungga.phase,
        ungga_error: ungga.last_error,
      },
      null,
      2
    )
  );

  const ops = await listPublicationOperationsForCase(db, caseId, 20);
  const createOps = ops.filter(
    (row) =>
      row.destination === "ungga" &&
      row.operation_type === "create_draft" &&
      (row.status === "unknown_outcome" || row.status === "failed")
  );
  for (const op of createOps) {
    console.log("marking ledger failed for reclaim", op.id, op.operation_key, op.status);
    await finishPublicationOperation(db, {
      operationId: op.id,
      status: "failed",
      errorText: op.error_text ?? "manual_prepare_draft_reclaim",
      result: {
        ...(isRecord(op.result_jsonb) ? op.result_jsonb : {}),
        manual_reclaim: "retry_ungga_prepare_draft_case",
      },
    });
  }

  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId,
    caseId,
    kind: "publication_review_required",
    status: "actioned",
  }).catch(() => null);

  const nowIso = new Date().toISOString();
  publication = {
    ...publication,
    destinations: {
      ...publication.destinations,
      ungga: {
        ...ungga,
        phase: "draft_pending",
        last_error: null,
        review_reason: null,
        preflight: null,
        operation_key: null,
        updated_at: nowIso,
      },
    },
  };
  const patch = buildPublicationContextPatch(publication);
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "active",
    currentStep: opCase.current_step ?? "package_ready",
    nextActionAt: nowIso,
    context: {
      ...context,
      ...patch,
      package_ready_machine_work_in_flight: false,
      publication_runner_pending_action: null,
    },
  });
  if (!updated) throw new Error("version_conflict updating case");

  console.log("requestPublicationProgress forceRetry prepare_draft...");
  const progress = await requestPublicationProgress(
    db,
    caseId,
    "manual_recovery_ungga_prepare_draft",
    {
      forceRetryFailedOperation: true,
      runAgentTick: createPublicationRunnerOwnedAgentTick(
        db,
        userId,
        "manual_recovery_ungga_prepare_draft"
      ),
    }
  );

  console.log(
    "PROGRESS",
    JSON.stringify(
      {
        ok: progress.ok,
        status: progress.status,
        message: progress.message,
        actions_run: progress.actions_run,
        next_action: progress.next_action,
      },
      null,
      2
    )
  );

  const final = await getOperationalCase(db, caseId);
  const finalPub = publicationFromContext(
    isRecord(final?.context_jsonb) ? final!.context_jsonb : {}
  );
  console.log(
    "FINAL",
    JSON.stringify(
      {
        status: final?.status,
        current_step: final?.current_step,
        ungga_phase: finalPub.destinations.ungga.phase,
        ungga_error: finalPub.destinations.ungga.last_error,
        ungga_id: finalPub.destinations.ungga.artifact.ungga_property_id,
      },
      null,
      2
    )
  );

  if (!progress.ok && progress.status !== "already_processing") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
