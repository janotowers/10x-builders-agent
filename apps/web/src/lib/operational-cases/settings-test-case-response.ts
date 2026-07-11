import {
  createServerClient,
  findPendingConversationBindings,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOperationalCaseTypeById,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseConversationBinding,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  ToolCall,
} from "@agents/types";
import {
  buildSettingsTestPendingActions,
  countSettingsTestE2ETransitions,
  listSettingsTestCaseEventsForLab,
  listSettingsTestE2EStartEvents,
  listSettingsTestToolCallsForCase,
  settingsTestPlaythroughAnchorAt,
  type SettingsTestPendingAction,
} from "@/lib/operational-cases/settings-test-pending-actions";
import {
  buildSettingsTestFlowProgress,
  type SettingsTestFlowProgressStep,
} from "@/lib/operational-cases/settings-test-flow-progress";
import { healStalePublishFlowBlockers } from "@/lib/operational-cases/finalize-case-after-tool-decision";
import {
  isEasybrokerImagesFailedInContext,
  packageReadyNeedsEasybrokerImageUpload,
  packageReadyNeedsUnggaApprovalNotify,
  shouldAutoFollowUpPackageReadyTick,
} from "@/lib/operational-cases/package-ready-auto-continue";
import { reconcilePublicationCaseRecord } from "@/lib/operational-cases/publication-reconcile";
import { resolvePublicationRolloutMode } from "@/lib/operational-cases/publication-rollout";

type Db = ReturnType<typeof createServerClient>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type SettingsTestCaseApiResponse = {
  ok: true;
  case: OperationalCase;
  conversationBindings?: OperationalCaseConversationBinding[];
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  pendingActions: SettingsTestPendingAction[];
  blockingActions: SettingsTestPendingAction[];
  historicalActions: SettingsTestPendingAction[];
  transitionCount: number;
  e2eStartEvents: OperationalCaseEvent[];
  flowProgress: SettingsTestFlowProgressStep[];
};

export async function effectiveFlowForCaseType(
  db: Db,
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>
): Promise<OperationalCaseFlowStep[]> {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? caseType.operational_flow_jsonb
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? globalCaseType.operational_flow_jsonb
    : [];
}

export async function buildSettingsTestCaseResponse(
  db: Db,
  opCase: OperationalCase,
  userId: string,
  flow: OperationalCaseFlowStep[] = [],
  options?: { telegramSentForToolCallId?: string | null }
): Promise<SettingsTestCaseApiResponse> {
  let fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  if (
    fresh.current_step === "package_ready" &&
    typeof fresh.context_jsonb?.publication_reconciled_at !== "string"
  ) {
    const context = isRecord(fresh.context_jsonb) ? fresh.context_jsonb : {};
    const publicationMode = resolvePublicationRolloutMode(context);
    await reconcilePublicationCaseRecord(db, fresh, {
      publicationMode,
      featureEnabled: publicationMode !== "off",
      verifyRemote: publicationMode !== "off",
    }).catch((error) => {
      console.warn("[settings-test-case-response] publication reconcile failed:", error);
    });
    fresh = (await getOperationalCase(db, fresh.id)) ?? fresh;
  }
  if (
    fresh.context_jsonb?.e2e_controlled === true ||
    fresh.context_jsonb?.test_mode === true
  ) {
    try {
      await healStalePublishFlowBlockers(db, {
        caseId: fresh.id,
        userId,
      });
      fresh = (await getOperationalCase(db, fresh.id)) ?? fresh;
    } catch (error) {
      console.warn(
        "[settings-test-case-response] healStalePublishFlowBlockers failed:",
        error
      );
    }
  }
  const playthroughAnchorAt = settingsTestPlaythroughAnchorAt(
    fresh.context_jsonb
  );
  const e2eStartEvents = await listSettingsTestE2EStartEvents(
    db,
    fresh.id,
    playthroughAnchorAt
  );
  const conversationalCase =
    fresh.context_jsonb?.created_from === "agent_conversation";
  const labEventsSince =
    playthroughAnchorAt ??
    (conversationalCase
      ? null
      : e2eStartEvents.length > 0
        ? e2eStartEvents[0]!.created_at
        : null);
  const events = await listSettingsTestCaseEventsForLab(db, fresh.id, {
    since: labEventsSince,
  });
  const toolCalls = await listSettingsTestToolCallsForCase(db, fresh.id, {
    since: labEventsSince,
    limit: 500,
  });
  const pendingResult = await buildSettingsTestPendingActions(db, {
    caseId: fresh.id,
    userId,
    toolCalls,
    events,
    telegramSentForToolCallId: options?.telegramSentForToolCallId,
  });

  // Lab is an observer: wake serialized publication runner if machine work remains.
  if (
    pendingResult.blockingActions.length === 0 &&
    fresh.current_step === "package_ready" &&
    (fresh.context_jsonb?.e2e_controlled === true ||
      fresh.context_jsonb?.test_mode === true)
  ) {
    const context = isRecord(fresh.context_jsonb) ? fresh.context_jsonb : {};
    if (context.package_ready_machine_work_in_flight !== true) {
      const needsUploadFollowUp = shouldAutoFollowUpPackageReadyTick({
        context,
        pendingConfirmation: false,
        uploadedImagesThisTurn: false,
        uploadFailedThisTurn: isEasybrokerImagesFailedInContext(context),
        autoFollowUpDepth: 0,
      });
      const needsUnggaFollowUp =
        packageReadyNeedsUnggaApprovalNotify(context) &&
        !packageReadyNeedsEasybrokerImageUpload(context) &&
        !isEasybrokerImagesFailedInContext(context) &&
        !pendingResult.pendingActions.some(
          (action) =>
            action.kind === "internal_notification" &&
            action.notification_kind === "ungga_publish_approval"
        );
      if (needsUploadFollowUp || needsUnggaFollowUp) {
        try {
          const { requestPublicationProgress } = await import(
            "@/lib/operational-cases/publication-runner"
          );
          const { runSettingsTestCaseAgentTick } = await import(
            "@/lib/operational-cases/run-settings-test-case-tick"
          );
          void requestPublicationProgress(
            db,
            fresh.id,
            "package_ready_lab_auto_continue",
            {
              runAgentTick: async (opCase, action) => {
                const tick = await runSettingsTestCaseAgentTick(db, opCase, userId, {
                  source: `package_ready_lab_auto_continue:${action.type}`,
                });
                return (
                  tick.publication_execution ?? {
                    status: "not_executed",
                    error: "publication_execution_result_missing",
                  }
                );
              },
            }
          ).catch((error) => {
            console.warn(
              "[settings-test-case-response] package_ready lab auto-continue failed:",
              error
            );
          });
        } catch (error) {
          console.warn(
            "[settings-test-case-response] package_ready lab auto-continue schedule failed:",
            error
          );
        }
      }
    }
  }

  const transitionCount = await countSettingsTestE2ETransitions(
    db,
    fresh.id,
    playthroughAnchorAt
  );
  const flowProgress = buildSettingsTestFlowProgress({
    opCase: fresh,
    events,
    flow,
    toolCalls,
    playthroughAnchorAt,
  });
  const conversationBindings =
    fresh.context_jsonb?.created_from === "agent_conversation"
      ? (
          await findPendingConversationBindings(db, {
            userId,
            channel: "telegram",
            statuses: ["awaiting_user", "clarification_needed"],
            limit: 10,
          })
        ).filter((binding) => binding.case_id === fresh.id)
      : [];
  return {
    ok: true,
    case: fresh,
    conversationBindings,
    events,
    toolCalls,
    pendingActions: pendingResult.pendingActions,
    blockingActions: pendingResult.blockingActions,
    historicalActions: pendingResult.historicalActions,
    transitionCount,
    e2eStartEvents,
    flowProgress,
  };
}
