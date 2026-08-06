import type { ToolApprovalPolicy } from "@agents/types";
import {
  resolvePublicationRolloutMode,
  type PublicationRolloutMode,
} from "@/lib/operational-cases/publication-rollout";
import {
  SETTINGS_TEST_AUTO_EXECUTE_TOOLS,
  SETTINGS_TEST_PUBLISH_AUTO_EXECUTE_TOOLS,
} from "@/lib/operational-cases/settings-test-tool-policy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type PublicationPendingAction = {
  type: string;
  destination: "easybroker" | "ungga";
};

/** Tools write de publicación que requieren aprobación de negocio + runner. */
export const PUBLICATION_WRITE_TOOLS = [
  "easybroker_create_listing",
  "easybroker_upload_images",
  "easybroker_publish_listing",
  "ungga_publish_listing",
] as const;

const TOOL_TO_DESTINATION: Record<
  (typeof PUBLICATION_WRITE_TOOLS)[number],
  "easybroker" | "ungga"
> = {
  easybroker_create_listing: "easybroker",
  easybroker_upload_images: "easybroker",
  easybroker_publish_listing: "easybroker",
  ungga_publish_listing: "ungga",
};

const TOOL_TO_OPERATION: Record<
  (typeof PUBLICATION_WRITE_TOOLS)[number],
  "create_draft" | "process_media" | "publish"
> = {
  easybroker_create_listing: "create_draft",
  easybroker_upload_images: "process_media",
  easybroker_publish_listing: "publish",
  ungga_publish_listing: "create_draft",
};

export function parsePublicationPendingAction(
  value: unknown
): PublicationPendingAction | null {
  if (!isRecord(value)) return null;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const destination =
    value.destination === "easybroker" || value.destination === "ungga"
      ? value.destination
      : null;
  if (!type || !destination) return null;
  return { type, destination };
}

export function publishApprovalsFromContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  return isRecord(context.publish_approvals) ? context.publish_approvals : {};
}

export function listingDescriptionIsApproved(
  context: Record<string, unknown>
): boolean {
  const approved = context.listing_description_approved;
  if (!isRecord(approved)) return false;
  return (
    typeof approved.description === "string" &&
    approved.description.trim().length > 0
  );
}

function publicationFeatureIsEnabled(context: Record<string, unknown>): boolean {
  if (context.publication_workflow_v1 === false) return false;
  const publication = isRecord(context.publication) ? context.publication : {};
  return publication.feature_enabled !== false;
}

/**
 * A pending runner action alone is never enough: destination must already be
 * business-approved and the action type must match the tool.
 */
export function isAuthorizedPublicationWriteTool(params: {
  toolId: string;
  context: Record<string, unknown>;
  publicationMode?: PublicationRolloutMode;
}): boolean {
  const toolId = params.toolId as (typeof PUBLICATION_WRITE_TOOLS)[number];
  if (!(toolId in TOOL_TO_DESTINATION)) return false;

  const mode =
    params.publicationMode ?? resolvePublicationRolloutMode(params.context);
  if (mode !== "active") return false;
  if (!publicationFeatureIsEnabled(params.context)) return false;
  if (!listingDescriptionIsApproved(params.context)) return false;
  if (params.context.package_ready_machine_work_in_flight !== true) return false;

  const destination = TOOL_TO_DESTINATION[toolId];
  const approvals = publishApprovalsFromContext(params.context);
  if (approvals[destination] !== "approved") return false;

  const pending = parsePublicationPendingAction(
    params.context.publication_runner_pending_action
  );
  if (!pending) return false;
  if (pending.destination !== destination) return false;

  const expectedOp = TOOL_TO_OPERATION[toolId];
  if (toolId === "ungga_publish_listing") {
    return (
      pending.destination === "ungga" &&
      (pending.type === "create_draft" ||
        pending.type === "publish" ||
        pending.type === "process_media")
    );
  }
  return pending.type === expectedOp;
}

/** Watermark may run only when EasyBroker media processing is scheduled. */
export function isAuthorizedImageWatermark(
  context: Record<string, unknown>,
  publicationMode?: PublicationRolloutMode
): boolean {
  const mode = publicationMode ?? resolvePublicationRolloutMode(context);
  if (mode !== "active") return false;
  if (!publicationFeatureIsEnabled(context)) return false;
  if (!listingDescriptionIsApproved(context)) return false;
  if (context.package_ready_machine_work_in_flight !== true) return false;
  const approvals = publishApprovalsFromContext(context);
  if (approvals.easybroker !== "approved") return false;
  const pending = parsePublicationPendingAction(
    context.publication_runner_pending_action
  );
  return (
    pending?.destination === "easybroker" && pending.type === "process_media"
  );
}

export function authorizedPublicationAutoExecuteToolIds(
  context: Record<string, unknown>,
  publicationMode?: PublicationRolloutMode
): string[] {
  const mode = publicationMode ?? resolvePublicationRolloutMode(context);
  const allowed: string[] = [];
  for (const toolId of PUBLICATION_WRITE_TOOLS) {
    if (
      isAuthorizedPublicationWriteTool({
        toolId,
        context,
        publicationMode: mode,
      })
    ) {
      allowed.push(toolId);
    }
  }
  if (isAuthorizedImageWatermark(context, mode)) {
    allowed.push("image_watermark");
  }
  return allowed;
}

/**
 * True when the tick may auto-execute at least one publication write tool.
 * Destination-scoped: EasyBroker approval alone does not unlock Ungga tools.
 */
export function shouldAutoExecuteApprovedPublishToolsFromContext(
  context: Record<string, unknown>,
  opts?: { caseType?: string | null; currentStep?: string | null }
): boolean {
  if (opts?.caseType && opts.caseType !== "property_optioning") return false;
  if (opts?.currentStep && opts.currentStep !== "package_ready") return false;
  return authorizedPublicationAutoExecuteToolIds(context).length > 0;
}

/**
 * Stale runner pending actions must not unlock auto-execute. Clear when the
 * destination is not approved or machine work is no longer in flight.
 */
export function shouldClearStalePublicationRunnerPendingAction(
  context: Record<string, unknown>
): boolean {
  const pending = parsePublicationPendingAction(
    context.publication_runner_pending_action
  );
  if (!pending) return false;
  const approvals = publishApprovalsFromContext(context);
  if (approvals[pending.destination] !== "approved") return true;
  if (context.package_ready_machine_work_in_flight !== true) return true;
  return false;
}

export type ControlledE2EPublicationContextPatch = {
  e2e_controlled?: true;
  publication_mode?: "active";
  publication_workflow_v1?: true;
  publication?: Record<string, unknown>;
  e2e_control_source?: string;
  e2e_control_status?: string;
  e2e_control_started_at?: string;
  e2e_control_case_type?: string;
};

function publicationModeValue(value: unknown): "off" | "shadow" | "active" | null {
  return value === "off" || value === "shadow" || value === "active"
    ? value
    : null;
}

/**
 * Activa publicación en property_optioning cuando el caso aún no tiene modo
 * explícito (el default del runner es off y deja el flujo colgado tras aprobar
 * la descripción). Respeta `off`/`shadow`/`active` ya puestos en el caso.
 */
export function propertyOptioningPublicationEnablementPatch(params: {
  caseType: string | null | undefined;
  context?: Record<string, unknown> | null;
}): ControlledE2EPublicationContextPatch | null {
  if (params.caseType !== "property_optioning") return null;
  const context = isRecord(params.context) ? params.context : {};
  const publication = isRecord(context.publication) ? context.publication : {};
  const explicitMode =
    publicationModeValue(context.publication_mode) ??
    publicationModeValue(publication.mode);
  // active/shadow are intentional product choices. "off" before listing
  // approval is also respected; after approval, recover from default "off"
  // persisted by reconcile (which used to materialize the rollout default).
  if (explicitMode === "active" || explicitMode === "shadow") return null;
  if (explicitMode === "off" && !listingDescriptionIsApproved(context)) {
    return null;
  }

  return {
    publication_mode: "active",
    publication_workflow_v1: true,
    publication: {
      ...publication,
      feature_enabled: true,
      mode: "active",
    },
  };
}

/**
 * Controlled property_optioning lab cases must run publication with mode=active.
 * Control markers remain reusable for other case types during E2E adoption.
 */
export function controlledE2EPublicationContextPatch(params: {
  caseType: string;
  e2eControlled: boolean;
  context?: Record<string, unknown> | null;
  channel?: string;
  includeControlMarkers?: boolean;
}): ControlledE2EPublicationContextPatch | null {
  if (!params.e2eControlled) return null;
  const context = isRecord(params.context) ? params.context : {};
  const publication = isRecord(context.publication) ? context.publication : {};
  const needsMode =
    params.caseType === "property_optioning" &&
    context.publication_mode !== "active";
  const needsWorkflow =
    params.caseType === "property_optioning" &&
    context.publication_workflow_v1 !== true;
  const needsFeature =
    params.caseType === "property_optioning" &&
    (publication.feature_enabled !== true || publication.mode !== "active");
  const needsMarkers =
    params.includeControlMarkers === true && context.e2e_controlled !== true;
  if (!needsMode && !needsWorkflow && !needsFeature && !needsMarkers) return null;

  const patch: ControlledE2EPublicationContextPatch = {};
  if (needsMode) patch.publication_mode = "active";
  if (needsWorkflow) patch.publication_workflow_v1 = true;
  if (needsFeature) {
    patch.publication = {
      ...publication,
      feature_enabled: true,
      mode: "active",
    };
  }
  if (needsMarkers) {
    patch.e2e_controlled = true;
    patch.e2e_control_source = params.channel ?? "settings_agent_test";
    patch.e2e_control_case_type = params.caseType;
    patch.e2e_control_status =
      typeof context.e2e_control_status === "string"
        ? context.e2e_control_status
        : "ready_for_manual_tick";
    patch.e2e_control_started_at =
      typeof context.e2e_control_started_at === "string"
        ? context.e2e_control_started_at
        : new Date().toISOString();
  }
  return patch;
}

/**
 * E2E tick / resume policy: deny publication writes by default; auto-execute
 * only tools authorized by mode + destination approval + runner pending action.
 */
export function buildPublicationAwareE2EToolApprovalPolicy(params: {
  context: Record<string, unknown>;
  documentRequestTarget?: "internal_user" | "external_contact" | null;
  autoExecuteContractDraftGeneration?: boolean;
  /** When true, deny unauthorized publish tools instead of leaving them HITL. */
  denyUnauthorizedPublishTools?: boolean;
  extraAutoExecuteToolIds?: Iterable<string>;
}): ToolApprovalPolicy {
  const policy: ToolApprovalPolicy = {};
  for (const toolId of SETTINGS_TEST_AUTO_EXECUTE_TOOLS) {
    policy[toolId] = "auto_execute";
  }
  if (params.extraAutoExecuteToolIds) {
    for (const toolId of params.extraAutoExecuteToolIds) {
      policy[toolId] = "auto_execute";
    }
  }
  if (params.documentRequestTarget === "internal_user") {
    policy.telegram_send_message_to_contact = "deny";
  }
  if (params.autoExecuteContractDraftGeneration) {
    policy.generate_document_from_template = "auto_execute";
  }

  const denyUnauthorized = params.denyUnauthorizedPublishTools !== false;
  if (denyUnauthorized) {
    for (const toolId of SETTINGS_TEST_PUBLISH_AUTO_EXECUTE_TOOLS) {
      policy[toolId] = "deny";
    }
  }

  for (const toolId of authorizedPublicationAutoExecuteToolIds(params.context)) {
    policy[toolId] = "auto_execute";
  }

  return policy;
}
