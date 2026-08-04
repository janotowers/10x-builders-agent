import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  ToolCall,
} from "@agents/types";
import { formatOperationalCaseEventSummary } from "@/lib/operational-cases/operational-case-event-display";
import { settingsTestPlaythroughAnchorAt } from "@/lib/operational-cases/settings-test-pending-actions";
import { filterActivitySincePlaythroughAnchor } from "@/lib/operational-cases/settings-test-e2e-transitions";

/**
 * Propósitos de `reminder_sent` que representan actividad documental legítima
 * del paso `awaiting_documents` (checklist post-intake, ruteo interno/externo,
 * solicitud inicial). Viven en `payload.purpose`, NO en `payload.kind` (que es
 * `"reminder_sent"`). Fuente única para atribución por paso y para conservar el
 * evento en el resumen E2E aunque ocurra antes de la primera transición manual.
 */
const DOCUMENT_FLOW_REMINDER_PURPOSES: ReadonlySet<string> = new Set([
  "documents_checklist_post_intake",
  "internal_upload_instructions",
  "external_documents_routed",
  "initial_request",
]);

export type FlowProgressEvidenceItem =
  | {
      kind: "event";
      id: string;
      created_at: string;
      summary: string;
      event_type: string;
      event_kind?: string;
      event_result?: string;
      event_source?: string;
      event_step_key?: string;
      event_purpose?: string;
    }
  | {
      kind: "tool";
      id: string;
      created_at: string;
      tool_name: string;
      status: string;
      summary: string;
      failure_detail?: string;
      arguments_json?: unknown;
      result_json?: unknown;
    };

export type SettingsTestFlowProgressStep = {
  step_key: string;
  step_label: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  /** Compatibilidad con resumen numérico existente. */
  evidence: string[];
  evidenceItems: FlowProgressEvidenceItem[];
};

/** @deprecated Use filterActivitySincePlaythroughAnchor */
export function filterActivitySinceCycleReset<T extends { created_at: string }>(
  items: T[],
  anchorAt: string | null
): T[] {
  return filterActivitySincePlaythroughAnchor(items, anchorAt);
}

function resolveToolCallStepKeyFromArgs(call: ToolCall): string | null {
  const args = call.arguments_json ?? {};
  for (const key of ["current_step", "step_key", "step"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolveToolCallStepKeyFromMetadata(call: ToolCall): string | null {
  const value = call.metadata_jsonb?.operational_step_key;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function collectStepToolIds(step: OperationalCaseFlowStep): Set<string> {
  const stepToolIds = new Set<string>();
  for (const tool of step.step_tools ?? []) stepToolIds.add(tool.tool_id);
  for (const skill of step.step_skills ?? []) {
    for (const tool of skill.skill_tools ?? []) stepToolIds.add(tool.tool_id);
  }
  return stepToolIds;
}

function buildToolToStepKeysMap(
  flow: OperationalCaseFlowStep[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const step of flow) {
    for (const toolId of collectStepToolIds(step)) {
      const list = map.get(toolId) ?? [];
      if (!list.includes(step.step_key)) list.push(step.step_key);
      map.set(toolId, list);
    }
  }
  return map;
}

/**
 * Resolves which flow step a tool_call belongs to.
 * Priority: metadata → args → unique flow mapping.
 * Multi-step tools without explicit step are not guessed (audit-only).
 */
export function resolveToolCallFlowStepKey(
  call: ToolCall,
  flow: OperationalCaseFlowStep[]
): string | null {
  const fromMetadata = resolveToolCallStepKeyFromMetadata(call);
  if (fromMetadata) return fromMetadata;

  const fromArgs = resolveToolCallStepKeyFromArgs(call);
  if (fromArgs) return fromArgs;

  const candidates = buildToolToStepKeysMap(flow).get(call.tool_name) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  return null;
}

export function toolCallStatusLabel(status: string): string {
  switch (status) {
    case "executed":
      return "Ejecutada";
    case "pending_confirmation":
      return "Pendiente de confirmación";
    case "failed":
      return "Fallida";
    case "rejected":
      return "Rechazada";
    default:
      return status;
  }
}

/**
 * Preflight contractual esperado: la fila auditada queda `failed`, pero
 * `result_json` marca `blocked` + `commission_contract_missing_required_data`.
 */
/**
 * Forma mínima de una tool call para el display de avance. Acepta `status`
 * como string y `result_json` nullable porque los ítems de actividad del panel
 * llegan así (no siempre como `ToolCall` estricto). Solo se comparan valores.
 */
type ToolCallDisplayInput = {
  tool_name: string;
  status: string;
  result_json?: Record<string, unknown> | null;
};

export function isCommissionContractDataBlockedCall(
  call: ToolCallDisplayInput
): boolean {
  if (call.tool_name !== "generate_document_from_template") return false;
  if (call.status !== "failed") return false;
  const result =
    call.result_json && typeof call.result_json === "object"
      ? (call.result_json as Record<string, unknown>)
      : null;
  if (!result) return false;
  return (
    result.status === "blocked" &&
    result.error === "commission_contract_missing_required_data"
  );
}

export function toolCallDisplayStatusLabel(
  call: ToolCallDisplayInput
): string {
  if (isCommissionContractDataBlockedCall(call)) {
    return "Bloqueada — requiere datos contractuales";
  }
  return toolCallStatusLabel(call.status);
}

function normalizeToolCallFailureText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeEvidencePayload(
  value: unknown,
  depth = 0
): unknown {
  if (value == null) return value;
  if (depth > 4) return "[depth_limit]";
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 20).map((item) => sanitizeEvidencePayload(item, depth + 1));
    if (value.length > 20) {
      sliced.push(`[+${value.length - 20} more items]`);
    }
    return sliced;
  }
  if (typeof value === "string") {
    return value.length > 1200 ? `${value.slice(0, 1200)}… [truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).slice(0, 40);
  const next: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    next[key] = sanitizeEvidencePayload(item, depth + 1);
  }
  if (Object.keys(record).length > 40) {
    next.__truncated_keys = Object.keys(record).length - 40;
  }
  return next;
}

function isExpectedNotifyUserGuardError(errorText: string | null) {
  if (!errorText) return false;
  return [
    "property_data_minimums_missing",
    "predial_extraction_incomplete",
    "predial_data_quality_review_required",
    "comparables_retry_required_before_notify",
    "owner_corroboration_extraction_incomplete",
    "price_approval_already_notified",
    "price_approval_prose_summary_blocked",
    "comparables_summary_after_price_approval_blocked",
  ].includes(errorText);
}

export function toolCallFailureDetail(
  call: Pick<ToolCall, "tool_name" | "status" | "result_json">
): string | null {
  if (call.status !== "failed") return null;
  const result = call.result_json as Record<string, unknown> | undefined;
  if (isCommissionContractDataBlockedCall(call)) {
    const missing = Array.isArray(result?.missing_required_fields)
      ? result.missing_required_fields.filter(
          (field): field is string =>
            typeof field === "string" && field.trim().length > 0
        )
      : [];
    if (missing.length > 0) return `Faltan: ${missing.join(", ")}`;
    return (
      normalizeToolCallFailureText(result?.message) ??
      "Faltan datos contractuales para generar el borrador"
    );
  }
  const errorText = normalizeToolCallFailureText(result?.error);
  if (isExpectedNotifyUserGuardError(errorText)) {
    if (errorText === "price_approval_already_notified") {
      return "Omitida: aprobación de precio ya enviada por el sistema";
    }
    return `Bloqueada por política (${errorText})`;
  }
  if (errorText === "case_not_in_intake") {
    return "Anomalía de flujo: intento de actualizar intake fuera del paso intake";
  }
  if (errorText && errorText !== "[object Object]") return errorText;
  return (
    normalizeToolCallFailureText(result?.message) ??
    normalizeToolCallFailureText(result?.hint) ??
    errorText
  );
}

function summarizeEventForStep(event: OperationalCaseEvent): string {
  return formatOperationalCaseEventSummary(event);
}

function parseEventMeta(event: OperationalCaseEvent) {
  const payload = (event.payload_jsonb ?? {}) as Record<string, unknown>;
  return {
    kind: typeof payload.kind === "string" ? payload.kind : undefined,
    result: typeof payload.result === "string" ? payload.result : undefined,
    source: typeof payload.source === "string" ? payload.source : undefined,
    stepKey: authoritativeEventStepKey(payload) ?? undefined,
    purpose: typeof payload.purpose === "string" ? payload.purpose : undefined,
  };
}

/**
 * Paso autoritativo del evento, escrito en `payload_jsonb.step_key` por el
 * emisor. Es la única fuente de verdad para la atribución a un paso. Cuando
 * está presente, la atribución es exclusiva (el evento pertenece solo a ese
 * paso). Los eventos históricos sin este campo caen al fallback heurístico.
 */
function authoritativeEventStepKey(
  payload: Record<string, unknown> | null
): string | null {
  const value = payload?.step_key;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stepKeysFromEventPayload(
  payload: Record<string, unknown> | null
): string[] {
  if (!payload) return [];
  const keys: string[] = [];
  // `step_key` se maneja de forma autoritativa antes de llegar aquí; este
  // fallback solo cubre eventos históricos vía `current_step`/`step`/`to`/`from`.
  for (const key of ["current_step", "step"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) keys.push(value.trim());
  }
  for (const nested of ["to", "from"] as const) {
    const block = payload[nested];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const step = (block as Record<string, unknown>).current_step;
    if (typeof step === "string" && step.trim()) keys.push(step.trim());
  }
  return keys;
}

export function eventBelongsToStep(
  event: OperationalCaseEvent,
  stepKey: string,
  stepIndex: number
): boolean {
  const payload = event.payload_jsonb as Record<string, unknown> | null;

  // Fuente única de verdad: si el emisor escribió un `step_key` autoritativo,
  // la atribución es exclusiva a ese paso y no se aplica heurística alguna.
  const authoritative = authoritativeEventStepKey(payload);
  if (authoritative) return authoritative === stepKey;

  // Fallback temporal para eventos históricos sin `step_key` autoritativo.
  const keys = stepKeysFromEventPayload(payload);
  if (keys.includes(stepKey)) return true;

  if (
    stepIndex === 0 &&
    (payload?.kind === "controlled_test_started" ||
      payload?.kind === "case_created" ||
      payload?.kind === "intake_fields_requested")
  ) {
    return true;
  }

  // Los documentos registrados (interno/externo) no llevan `current_step` en su
  // payload; se recaban durante "Solicitar documentos". Sin esta atribución, el
  // panel no muestra actividad documental en ese paso (quedaba "Sin actividad").
  const payloadKind = typeof payload?.kind === "string" ? payload.kind : null;
  if (
    stepKey === "price_proposal_pending" &&
    (payloadKind === "price_proposal_prepared" ||
      payloadKind === "price_approval_requested" ||
      payloadKind === "price_approved" ||
      payloadKind === "price_adjusted_and_approved" ||
      payloadKind === "price_rejected" ||
      (payloadKind === "comparables_analysis_completed" &&
        keys.includes("price_proposal_pending")))
  ) {
    return true;
  }
  if (
    stepKey === "awaiting_documents" &&
    event.event_type === "external_response" &&
    payloadKind === "document_registered"
  ) {
    return true;
  }
  if (
    stepKey === "awaiting_documents" &&
    event.event_type === "human_decision" &&
    payloadKind === "step_branch_selected"
  ) {
    return true;
  }
  if (
    stepKey === "awaiting_documents" &&
    event.event_type === "reminder_sent" &&
    typeof payload?.purpose === "string" &&
    DOCUMENT_FLOW_REMINDER_PURPOSES.has(payload.purpose)
  ) {
    return true;
  }

  return false;
}

function toolCallBelongsToStep(
  call: ToolCall,
  stepKey: string,
  stepToolIds: Set<string>,
  flow: OperationalCaseFlowStep[],
  currentStep: string | null | undefined
): boolean {
  const resolved = resolveToolCallFlowStepKey(call, flow);
  if (resolved === stepKey) return true;
  if (!resolved && stepToolIds.has(call.tool_name)) {
    return currentStep === stepKey;
  }
  return false;
}

function summarizeToolEvidenceItem(call: ToolCall, stepKey: string): string {
  if (
    stepKey === "contract_pending" &&
    call.tool_name === "generate_document_from_template"
  ) {
    if (isCommissionContractDataBlockedCall(call)) {
      return "Preflight de contrato bloqueado — requiere datos contractuales";
    }
    if (call.status === "executed") return "Borrador de contrato generado";
    if (call.status === "pending_confirmation")
      return "Generando borrador interno (pendiente)";
  }
  return `${call.tool_name} · ${toolCallDisplayStatusLabel(call)}`;
}

function stableToolArgsKey(call: ToolCall): string {
  try {
    return JSON.stringify(call.arguments_json ?? {});
  } catch {
    return "";
  }
}

function toolAuditDedupeKey(call: ToolCall): string {
  return [
    call.turn_id ?? call.session_id,
    call.tool_name,
    stableToolArgsKey(call),
  ].join("::");
}

function removeApprovalAuditDuplicates(toolCalls: ToolCall[]): ToolCall[] {
  const executedOwnedAuditKeys = new Set(
    toolCalls
      .filter((call) => call.status === "executed" && !call.requires_confirmation)
      .map(toolAuditDedupeKey)
  );
  return toolCalls.filter((call) => {
    if (!call.requires_confirmation) return true;
    if (call.status !== "executed" && call.status !== "approved") return true;
    return !executedOwnedAuditKeys.has(toolAuditDedupeKey(call));
  });
}

export function buildSettingsTestFlowProgress(params: {
  opCase: OperationalCase;
  events: OperationalCaseEvent[];
  flow: OperationalCaseFlowStep[];
  toolCalls?: ToolCall[];
  playthroughAnchorAt?: string | null;
}): SettingsTestFlowProgressStep[] {
  const playthroughAnchorAt =
    params.playthroughAnchorAt ??
    settingsTestPlaythroughAnchorAt(params.opCase.context_jsonb);
  const events = filterActivitySincePlaythroughAnchor(
    params.events,
    playthroughAnchorAt
  );
  const toolCalls = filterActivitySincePlaythroughAnchor(
    params.toolCalls ?? [],
    playthroughAnchorAt
  );
  const dedupedToolCalls = removeApprovalAuditDuplicates(toolCalls);
  const currentStep = params.opCase.current_step;

  return params.flow.map((step, index) => {
    const stepToolIds = collectStepToolIds(step);

    const stepEvents = events.filter((event) =>
      eventBelongsToStep(event, step.step_key, index)
    );
    const stepTools = dedupedToolCalls.filter((call) =>
      toolCallBelongsToStep(
        call,
        step.step_key,
        stepToolIds,
        params.flow,
        currentStep
      )
    );

    const evidenceItems: FlowProgressEvidenceItem[] = [
      ...stepEvents.map((event) => {
        const meta = parseEventMeta(event);
        return {
          kind: "event" as const,
          id: event.id,
          created_at: event.created_at,
          event_type: event.event_type,
          summary: summarizeEventForStep(event),
          event_kind: meta.kind,
          event_result: meta.result,
          event_source: meta.source,
          event_step_key: meta.stepKey,
          event_purpose: meta.purpose,
        };
      }),
      ...stepTools.map((call) => ({
        kind: "tool" as const,
        id: call.id,
        created_at: call.created_at,
        tool_name: call.tool_name,
        status: call.status,
        summary: summarizeToolEvidenceItem(call, step.step_key),
        failure_detail: toolCallFailureDetail(call) ?? undefined,
        arguments_json: sanitizeEvidencePayload(call.arguments_json ?? null),
        result_json: sanitizeEvidencePayload(call.result_json ?? null),
      })),
    ].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
        a.id.localeCompare(b.id)
    );

    const evidence = [
      ...stepEvents.map((event) => `event:${event.event_type}`),
      ...stepTools.map((call) => `tool:${call.tool_name}:${call.status}`),
    ];

    const status: SettingsTestFlowProgressStep["status"] =
      currentStep === step.step_key
        ? "in_progress"
        : evidence.length > 0
          ? "completed"
          : "pending";

    return {
      step_key: step.step_key,
      step_label: step.step_label,
      status,
      evidence,
      evidenceItems,
    };
  });
}

function isE2EEvent(item: FlowProgressEvidenceItem): boolean {
  if (item.kind !== "event") return true;
  // Cualquier evento con paso autoritativo es actividad legítima del recorrido
  // operativo y no debe filtrarse del resumen E2E (p. ej. Paso 4 "Preparar
  // precio" y entrada al Paso 5 "Preparar contrato").
  if (item.event_step_key) return true;
  if (
    item.event_kind === "case_created" ||
    item.event_kind === "intake_fields_requested"
  ) {
    return true;
  }
  if (item.event_kind === "controlled_test_e2e_started") return true;
  if (item.event_type === "external_response") return true;
  if (item.event_kind === "documents_batch_completed") return true;
  if (isDocumentRequestReminderEvidence(item)) return true;
  if (isDocumentRequestTargetInferredEvidence(item)) return true;
  if (isStepBranchSelectedEvidence(item)) return true;
  if (
    item.event_result === "e2e_tick_completed" ||
    item.event_result === "e2e_pending_hitl"
  ) {
    return true;
  }
  if (
    item.event_source === "settings_test_case_tick" ||
    item.event_source === "case_type_settings" ||
    item.event_source === "telegram_webhook_settings_test" ||
    item.event_source === "deterministic_conversational_intake" ||
    item.event_source === "telegram_webhook_deterministic_intake" ||
    item.event_source === "operational_case_update_intake"
  ) {
    return true;
  }
  return false;
}

type FlowProgressLike = {
  step_key: string;
  step_label: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  evidence: string[];
  evidenceItems?: FlowProgressEvidenceItem[];
};

function isDocumentRequestReminderEvidence(item: FlowProgressEvidenceItem): boolean {
  if (item.kind !== "event") return false;
  if (item.event_type !== "reminder_sent") return false;
  // El subtipo del recordatorio vive en `payload.purpose` (proyectado como
  // `event_purpose`), no en `event_kind` (que es `"reminder_sent"`).
  return (
    typeof item.event_purpose === "string" &&
    DOCUMENT_FLOW_REMINDER_PURPOSES.has(item.event_purpose)
  );
}

/**
 * Inferencia determinística de ruta interna cuando el asesor sube documentos
 * antes de elegir interno/externo. Es actividad documental legítima del paso
 * y debe conservarse en el resumen E2E aunque ocurra antes del primer tick.
 */
function isDocumentRequestTargetInferredEvidence(
  item: FlowProgressEvidenceItem
): boolean {
  return item.kind === "event" && item.event_kind === "document_request_target_inferred";
}

/** Rama documental elegida (Fase E / PATTERN_STEP_BRANCH_DECISION). */
function isStepBranchSelectedEvidence(item: FlowProgressEvidenceItem): boolean {
  return item.kind === "event" && item.event_kind === "step_branch_selected";
}

export function flowProgressForE2ESummary<T extends FlowProgressLike>(
  flowProgress: T[],
  options?: { e2eStartedAt?: string | null }
): T[] {
  const startedAt = options?.e2eStartedAt
    ? new Date(options.e2eStartedAt).getTime()
    : null;
  return flowProgress.map((step) => {
    const evidenceItems = (step.evidenceItems ?? []).filter((item) => {
      const createdAtMs = new Date(item.created_at).getTime();
      const isDocumentEvidence =
        item.kind === "event" &&
        (item.event_kind === "document_registered" ||
          item.event_kind === "documents_batch_completed");
      const preTransitionConversationalIntake =
        item.kind === "event" &&
        (item.event_kind === "case_created" ||
          item.event_kind === "intake_fields_requested" ||
          item.event_source === "operational_case_update_intake" ||
          isDocumentEvidence ||
          isDocumentRequestReminderEvidence(item) ||
          isDocumentRequestTargetInferredEvidence(item) ||
          isStepBranchSelectedEvidence(item));
      if (
        startedAt &&
        Number.isFinite(createdAtMs) &&
        createdAtMs < startedAt &&
        !preTransitionConversationalIntake
      ) {
        return false;
      }
      if (item.kind === "event" && item.event_kind === "controlled_test_started") {
        return false;
      }
      if (item.kind === "event" && item.event_result === "safe_readiness_passed") {
        return false;
      }
      return isE2EEvent(item);
    });
    const evidence = evidenceItems.map((item) =>
      item.kind === "tool"
        ? `tool:${item.tool_name}:${item.status}`
        : `event:${item.event_type}`
    );
    const status: FlowProgressLike["status"] =
      step.status === "in_progress"
        ? "in_progress"
        : evidence.length > 0
          ? "completed"
          : "pending";
    return {
      ...step,
      evidenceItems,
      evidence,
      status,
    } as T;
  });
}

