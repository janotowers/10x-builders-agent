import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  ToolCall,
} from "@agents/types";
import { settingsTestPlaythroughAnchorAt } from "@/lib/operational-cases/settings-test-pending-actions";
import { filterActivitySincePlaythroughAnchor } from "@/lib/operational-cases/settings-test-e2e-transitions";

export type FlowProgressEvidenceItem =
  | {
      kind: "event";
      id: string;
      created_at: string;
      summary: string;
      event_type: string;
    }
  | {
      kind: "tool";
      id: string;
      created_at: string;
      tool_name: string;
      status: string;
      summary: string;
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
  flow: OperationalCaseFlowStep[],
  _currentStep?: string | null | undefined
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

function summarizeEventForStep(event: OperationalCaseEvent): string {
  const payload = (event.payload_jsonb ?? {}) as Record<string, unknown>;
  const kind = typeof payload.kind === "string" ? payload.kind : event.event_type;
  if (kind === "controlled_test_e2e_started") return "Transición con agente iniciada";
  if (kind === "controlled_test_started") return "Prueba segura iniciada";
  if (kind === "step_test_started") return "Inicio prueba de paso";
  if (kind === "step_test_completed") return "Prueba de paso completada";
  if (kind === "skill_test_started") return "Inicio prueba de habilidad";
  if (kind === "skill_test_completed") return "Prueba de habilidad completada";
  if (event.event_type === "state_changed") return "Cambio de estado del caso";
  if (event.event_type === "human_decision") return "Decisión / acción manual";
  return kind;
}

function stepKeysFromEventPayload(
  payload: Record<string, unknown> | null
): string[] {
  if (!payload) return [];
  const keys: string[] = [];
  for (const key of ["current_step", "step", "step_key"] as const) {
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
  const keys = stepKeysFromEventPayload(payload);
  if (keys.includes(stepKey)) return true;

  if (
    stepIndex === 0 &&
    payload?.kind === "controlled_test_started"
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
  const resolved = resolveToolCallFlowStepKey(call, flow, currentStep);
  if (resolved === stepKey) return true;
  if (!resolved && stepToolIds.has(call.tool_name)) {
    return currentStep === stepKey;
  }
  return false;
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
  const currentStep = params.opCase.current_step;

  return params.flow.map((step, index) => {
    const stepToolIds = collectStepToolIds(step);

    const stepEvents = events.filter((event) =>
      eventBelongsToStep(event, step.step_key, index)
    );
    const stepTools = toolCalls.filter((call) =>
      toolCallBelongsToStep(
        call,
        step.step_key,
        stepToolIds,
        params.flow,
        currentStep
      )
    );

    const evidenceItems: FlowProgressEvidenceItem[] = [
      ...stepEvents.map((event) => ({
        kind: "event" as const,
        id: event.id,
        created_at: event.created_at,
        event_type: event.event_type,
        summary: summarizeEventForStep(event),
      })),
      ...stepTools.map((call) => ({
        kind: "tool" as const,
        id: call.id,
        created_at: call.created_at,
        tool_name: call.tool_name,
        status: call.status,
        summary: `${call.tool_name} · ${toolCallStatusLabel(call.status)}`,
      })),
    ].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
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
