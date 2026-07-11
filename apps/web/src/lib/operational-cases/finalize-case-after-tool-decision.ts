import {
  countPendingToolCallsForCase,
  getOperationalCase,
  rejectSiblingPendingToolCallsForCase,
  rejectSupersededPendingToolCallsForCase,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
} from "@agents/types";
import { dismissPrematurePublishDestinationApprovals } from "@/lib/business-decisions/publish-destination-approval";
import { packageReadyBlocksUnggaApprovalNotify } from "@/lib/operational-cases/package-ready-auto-continue";

const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";

const PUBLISH_CREATE_TOOLS = new Set([
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toolCallCaseId(toolCall: {
  arguments_json?: unknown;
  metadata_jsonb?: unknown;
}): string | null {
  const args = toolCall.arguments_json;
  if (isRecord(args) && typeof args.case_id === "string" && args.case_id.trim()) {
    return args.case_id.trim();
  }
  const metadata = toolCall.metadata_jsonb;
  if (
    isRecord(metadata) &&
    typeof metadata.case_id === "string" &&
    metadata.case_id.trim()
  ) {
    return metadata.case_id.trim();
  }
  return null;
}

async function clearE2EPendingConfirmationFlags(
  db: DbClient,
  params: { caseId: string; userId: string }
): Promise<void> {
  const opCase = await getOperationalCase(db, params.caseId);
  if (!opCase || opCase.user_id !== params.userId) return;
  if (
    !["active", "waiting_internal", "waiting_external"].includes(opCase.status)
  ) {
    return;
  }

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const settingsTest = isSettingsOperationalTestCase(opCase);
  const controlledE2E = isControlledE2EOperationalCase(opCase);
  const patch: Record<string, unknown> = {};

  if (settingsTest) {
    patch.controlled_test_e2e_pending_confirmation = false;
    if (
      context.controlled_test_status === "e2e_pending_hitl" ||
      context.controlled_test_e2e_pending_confirmation === true
    ) {
      patch.controlled_test_status = "e2e_tick_completed";
    }
  }
  if (controlledE2E) {
    patch.e2e_control_pending_confirmation = false;
    if (
      context.e2e_control_status === "pending_hitl" ||
      context.e2e_control_pending_confirmation === true
    ) {
      patch.e2e_control_status = "manual_tick_completed";
    }
  }

  await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: new Date().toISOString(),
    ...(Object.keys(patch).length > 0 ? { context: { ...context, ...patch } } : {}),
  });
}

/**
 * Si hay varios unread de ungga_publish_approval (spam de ticks), deja el más
 * antiguo y descarta el resto para no bloquear el lab con duplicados.
 */
export async function dismissDuplicateUnggaPublishApprovals(
  db: DbClient,
  params: { userId: string; caseId: string }
): Promise<number> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id, created_at")
    .eq("user_id", params.userId)
    .eq("case_id", params.caseId)
    .eq("kind", "ungga_publish_approval")
    .eq("status", "unread")
    .order("created_at", { ascending: true });
  if (error || !Array.isArray(data) || data.length <= 1) return 0;
  const duplicates = data.slice(1);
  let dismissed = 0;
  for (const row of duplicates) {
    if (typeof row.id !== "string") continue;
    const { error: updateError } = await db
      .from("internal_user_notifications")
      .update({
        status: "dismissed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "unread");
    if (!updateError) dismissed += 1;
  }
  return dismissed;
}

/**
 * Tras aprobar/rechazar un HITL técnico ligado a un caso:
 * - en reject: cierra siblings del mismo tool
 * - si ya no hay pending: limpia tool_confirmation_pending + flags E2E
 * - si el tool era de publicación EasyBroker: descarta Ungga prematuro
 */
export async function finalizeCaseAfterToolDecision(
  db: DbClient,
  params: {
    toolCall: {
      id?: string;
      tool_name?: string;
      arguments_json?: unknown;
      metadata_jsonb?: unknown;
    };
    userId: string;
    decision: "approve" | "reject";
  }
): Promise<{
  caseId: string | null;
  pendingRemaining: number;
  siblingsRejected: number;
  prematureDestinationsDismissed: number;
}> {
  const caseId = toolCallCaseId(params.toolCall);
  if (!caseId) {
    return {
      caseId: null,
      pendingRemaining: 0,
      siblingsRejected: 0,
      prematureDestinationsDismissed: 0,
    };
  }

  let siblingsRejected = 0;
  if (params.decision === "reject" && typeof params.toolCall.tool_name === "string") {
    siblingsRejected = await rejectSiblingPendingToolCallsForCase(db, {
      caseId,
      toolName: params.toolCall.tool_name,
      excludeToolCallId:
        typeof params.toolCall.id === "string" ? params.toolCall.id : null,
      reason: "sibling_rejected_with_user_cancel",
    });
  }

  let prematureDestinationsDismissed = 0;
  if (
    params.decision === "reject" &&
    typeof params.toolCall.tool_name === "string" &&
    PUBLISH_CREATE_TOOLS.has(params.toolCall.tool_name)
  ) {
    prematureDestinationsDismissed =
      await dismissPrematurePublishDestinationApprovals(db, {
        userId: params.userId,
        caseId,
      });
  }

  const pendingRemaining = await countPendingToolCallsForCase(db, caseId);
  if (pendingRemaining > 0) {
    return {
      caseId,
      pendingRemaining,
      siblingsRejected,
      prematureDestinationsDismissed,
    };
  }

  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId,
    kind: TOOL_CONFIRMATION_PENDING_KIND,
    status: "actioned",
  });

  await clearE2EPendingConfirmationFlags(db, {
    caseId,
    userId: params.userId,
  });

  return {
    caseId,
    pendingRemaining: 0,
    siblingsRejected,
    prematureDestinationsDismissed,
  };
}

/**
 * Autocuración al refrescar el laboratorio: cierra HITL técnicos superados y
 * pendientes de destino prematuros, y limpia flags E2E stale.
 */
export async function healStalePublishFlowBlockers(
  db: DbClient,
  params: { caseId: string; userId: string }
): Promise<{
  supersededRejected: number;
  prematureDestinationsDismissed: number;
  duplicateUnggaDismissed: number;
  e2eFlagsCleared: boolean;
}> {
  const opCase = await getOperationalCase(db, params.caseId);
  if (!opCase || opCase.user_id !== params.userId) {
    return {
      supersededRejected: 0,
      prematureDestinationsDismissed: 0,
      duplicateUnggaDismissed: 0,
      e2eFlagsCleared: false,
    };
  }

  const supersededRejected = await rejectSupersededPendingToolCallsForCase(
    db,
    params.caseId
  );
  const prematureDestinationsDismissed =
    await dismissPrematurePublishDestinationApprovals(db, {
      userId: params.userId,
      caseId: params.caseId,
      context: opCase.context_jsonb,
    });
  // Si EasyBroker aún no tiene fotos (o el upload falló), no dejar pendientes
  // de Ungga que se crearon por spam de ticks.
  let unggaBlockedDismissed = 0;
  if (packageReadyBlocksUnggaApprovalNotify(opCase.context_jsonb)) {
    unggaBlockedDismissed =
      await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
        userId: params.userId,
        caseId: params.caseId,
        kind: "ungga_publish_approval",
        status: "dismissed",
      });
  }
  const duplicateUnggaDismissed =
    unggaBlockedDismissed > 0
      ? unggaBlockedDismissed
      : await dismissDuplicateUnggaPublishApprovals(db, params);

  const pendingRemaining = await countPendingToolCallsForCase(db, params.caseId);
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const staleE2EFlags =
    pendingRemaining === 0 &&
    (context.e2e_control_pending_confirmation === true ||
      context.e2e_control_status === "pending_hitl" ||
      context.controlled_test_e2e_pending_confirmation === true ||
      context.controlled_test_status === "e2e_pending_hitl");

  if (staleE2EFlags) {
    await clearE2EPendingConfirmationFlags(db, params);
  } else if (pendingRemaining === 0 && supersededRejected > 0) {
    await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
      userId: params.userId,
      caseId: params.caseId,
      kind: TOOL_CONFIRMATION_PENDING_KIND,
      status: "actioned",
    });
  }

  return {
    supersededRejected,
    prematureDestinationsDismissed,
    duplicateUnggaDismissed,
    e2eFlagsCleared: staleE2EFlags,
  };
}
