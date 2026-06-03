import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOperationalCaseTypeById,
} from "@agents/db";
import type {
  OperationalCase,
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

type Db = ReturnType<typeof createServerClient>;

export type SettingsTestCaseApiResponse = {
  ok: true;
  case: OperationalCase;
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
  const fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  const playthroughAnchorAt = settingsTestPlaythroughAnchorAt(
    fresh.context_jsonb
  );
  const e2eStartEvents = await listSettingsTestE2EStartEvents(
    db,
    fresh.id,
    playthroughAnchorAt
  );
  const labEventsSince =
    playthroughAnchorAt ??
    (e2eStartEvents.length > 0 ? e2eStartEvents[0]!.created_at : null);
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
  return {
    ok: true,
    case: fresh,
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
