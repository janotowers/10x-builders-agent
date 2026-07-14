import { getOperationalCase } from "@agents/db";
import type { createServerClient } from "@agents/db";

type DbClient = ReturnType<typeof createServerClient>;

/**
 * Lab/ops recovery scripts must target an explicit case — never ship with
 * hardcoded production or E2E IDs in repo.
 */
export async function resolveRecoveryCaseContext(
  db: DbClient,
  params: { caseIdEnv?: string; userIdEnv?: string }
): Promise<{ caseId: string; userId: string }> {
  const caseId = (params.caseIdEnv ?? process.env.RECOVERY_CASE_ID ?? "").trim();
  if (!caseId) {
    throw new Error(
      "RECOVERY_CASE_ID is required. Example: RECOVERY_CASE_ID=<uuid> npx tsx --env-file=.env.local scripts/lab/recover-ungga-publish-case.ts"
    );
  }

  const explicitUserId = (params.userIdEnv ?? process.env.RECOVERY_USER_ID ?? "").trim();
  if (explicitUserId) {
    return { caseId, userId: explicitUserId };
  }

  const opCase = await getOperationalCase(db, caseId);
  if (!opCase?.user_id) {
    throw new Error(
      `Case ${caseId} not found. Set RECOVERY_USER_ID if using a service-role client without case read access.`
    );
  }
  return { caseId, userId: opCase.user_id };
}
