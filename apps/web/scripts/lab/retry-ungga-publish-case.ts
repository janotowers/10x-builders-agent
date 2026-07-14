/**
 * Lab/ops: force-retry Ungga publish on an active package_ready case (same GU-ID).
 * Run after recover-ungga-publish-case.ts when publish failed pre-side-effect.
 *
 * Usage:
 *   RECOVERY_CASE_ID=<uuid> npx tsx --env-file=.env.local scripts/lab/retry-ungga-publish-case.ts
 *
 * Optional: RECOVERY_USER_ID (defaults to case owner).
 */
import { createServerClient, getOperationalCase } from "@agents/db";
import { ensureAgentToolDepsWired } from "../../src/lib/agent/wire-tool-deps";
import { requestPublicationProgress } from "../../src/lib/operational-cases/publication-runner";
import { createPublicationRunnerOwnedAgentTick } from "../../src/lib/operational-cases/run-settings-test-case-tick";
import { resolveRecoveryCaseContext } from "./recovery-env";

async function main() {
  console.log("wiring agent deps...");
  ensureAgentToolDepsWired();
  const db = createServerClient();
  const { caseId, userId } = await resolveRecoveryCaseContext(db, {});

  const before = await getOperationalCase(db, caseId);
  console.log(
    "BEFORE",
    JSON.stringify(
      {
        status: before?.status,
        current_step: before?.current_step,
        version: before?.version,
        ungga_phase: (before?.context_jsonb as any)?.publication?.destinations?.ungga
          ?.phase,
      },
      null,
      2
    )
  );

  console.log("requestPublicationProgress forceRetry...");
  const progress = await requestPublicationProgress(
    db,
    caseId,
    "manual_recovery_ungga_publish",
    {
      forceRetryFailedOperation: true,
      runAgentTick: createPublicationRunnerOwnedAgentTick(
        db,
        userId,
        "manual_recovery_ungga_publish"
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
  const ctx = (final?.context_jsonb as any) || {};
  console.log(
    "FINAL",
    JSON.stringify(
      {
        status: final?.status,
        current_step: final?.current_step,
        ungga_phase: ctx.publication?.destinations?.ungga?.phase,
        ungga_error: ctx.publication?.destinations?.ungga?.last_error,
        ungga_published: ctx.published?.ungga,
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
