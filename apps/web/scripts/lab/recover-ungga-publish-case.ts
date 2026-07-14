/**
 * Lab/ops: reopen a prematurely closed publication case preserving CLI GU-ID.
 *
 * Usage:
 *   RECOVERY_CASE_ID=<uuid> npx tsx --env-file=.env.local scripts/lab/recover-ungga-publish-case.ts
 *
 * Optional: RECOVERY_USER_ID (defaults to case owner).
 * Optional: RECOVERY_REASON (defaults to premature_completion_without_ungga_url).
 */
import { createServerClient, getOperationalCase } from "@agents/db";
import { reopenPrematurelyClosedPublicationCase } from "../../src/lib/operational-cases/publication-closure-recovery";
import { resolveRecoveryCaseContext } from "./recovery-env";

async function main() {
  const db = createServerClient();
  const { caseId, userId } = await resolveRecoveryCaseContext(db, {});
  const reason =
    process.env.RECOVERY_REASON?.trim() ||
    "premature_completion_without_ungga_url";

  console.log("reopening", caseId, "reason=", reason);
  const reopen = await reopenPrematurelyClosedPublicationCase(db, {
    caseId,
    userId,
    reason,
  });
  console.log("REOPEN", JSON.stringify(reopen, null, 2));

  const after = await getOperationalCase(db, caseId);
  const ctx = (after?.context_jsonb as Record<string, unknown>) || {};
  const publication = (ctx.publication as Record<string, unknown>) || {};
  const destinations = (publication.destinations as Record<string, unknown>) || {};
  const ungga = (destinations.ungga as Record<string, unknown>) || {};
  const published = (ctx.published as Record<string, unknown>) || {};
  const unggaPublished = (published.ungga as Record<string, unknown>) || {};
  console.log(
    "AFTER_REOPEN",
    JSON.stringify(
      {
        status: after?.status,
        current_step: after?.current_step,
        version: after?.version,
        next_action_at: after?.next_action_at,
        ungga_phase: ungga.phase,
        ungga_error: ungga.last_error,
        ungga_id: unggaPublished.ungga_property_id,
        draft_url: unggaPublished.draft_url,
        published_url: unggaPublished.published_url,
      },
      null,
      2
    )
  );

  if (!reopen.ok && reopen.status !== "already_reopened") {
    process.exitCode = 1;
  } else {
    console.log(
      "Next: RECOVERY_CASE_ID=" +
        caseId +
        " npx tsx --env-file=.env.local scripts/lab/retry-ungga-publish-case.ts"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
