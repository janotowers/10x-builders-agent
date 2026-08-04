import type { OperationalCase } from "@agents/types";
import type { SettingsTestPendingAction } from "@/lib/operational-cases/settings-test-pending-actions";
import {
  OPERATIONAL_CASE_STATUS_LABELS,
  operationalCaseDisplayTitle,
} from "@/lib/operational-cases/instance-list-ui";
import { type OperationalStepLabelMap } from "@/lib/operational-cases/operational-step-labels";

export {
  buildOperationalStepLabelMap,
  type OperationalStepLabelMap,
} from "@/lib/operational-cases/operational-step-labels";

export type SettingsTestCleanupTarget = "notifications" | "tool_calls" | "all";

export type SettingsTestActionKindCounts = {
  notifications: number;
  toolConfirmations: number;
  total: number;
};

export function countSettingsTestActionsByKind(
  actions: SettingsTestPendingAction[]
): SettingsTestActionKindCounts {
  let notifications = 0;
  let toolConfirmations = 0;
  for (const action of actions) {
    if (action.kind === "internal_notification") notifications += 1;
    else toolConfirmations += 1;
  }
  return {
    notifications,
    toolConfirmations,
    total: notifications + toolConfirmations,
  };
}

export function formatSettingsTestHistorySummary(
  counts: SettingsTestActionKindCounts
): string {
  if (counts.total === 0) return "Historial del caso (0)";
  if (counts.notifications === 0) {
    return `Historial del caso (${counts.total} — ${counts.toolConfirmations} aprobaciones del agente)`;
  }
  if (counts.toolConfirmations === 0) {
    return `Historial del caso (${counts.total} — ${counts.notifications} notificaciones)`;
  }
  return `Historial del caso (${counts.total} — ${counts.notifications} notif. + ${counts.toolConfirmations} aprobaciones)`;
}

export function formatSettingsTestCleanupResult(params: {
  deleted_notifications?: number;
  rejected_tool_calls?: number;
  deleted?: number;
}): string {
  const deletedNotifications = params.deleted_notifications ?? params.deleted ?? 0;
  const rejectedToolCalls = params.rejected_tool_calls ?? 0;
  if (deletedNotifications === 0 && rejectedToolCalls === 0) {
    return "No había registros que limpiar para esa opción.";
  }
  const parts: string[] = [];
  if (deletedNotifications > 0) {
    parts.push(
      `${deletedNotifications} notificación${deletedNotifications === 1 ? "" : "es"}`
    );
  }
  if (rejectedToolCalls > 0) {
    parts.push(
      `${rejectedToolCalls} aprobación${rejectedToolCalls === 1 ? "" : "es"} del agente (marcadas como rechazadas)`
    );
  }
  return `Se limpiaron ${parts.join(" y ")} de este caso de prueba.`;
}

export function formatLabTransitionSummary(transitionCount: number): string {
  if (transitionCount <= 0) {
    return "Aún no hay transiciones con agente en este recorrido E2E.";
  }
  return `${transitionCount} transición${transitionCount === 1 ? "" : "es"} completada${transitionCount === 1 ? "" : "s"} en este recorrido · Próxima: ${transitionCount + 1}`;
}

export function formatLabTransitionBadge(transitionCount: number): string {
  if (transitionCount <= 0) return "Próxima transición 1";
  return `${transitionCount} completada${transitionCount === 1 ? "" : "s"} · Próxima ${transitionCount + 1}`;
}

export function formatLastE2ETransitionOutcome(params: {
  transitionNumber: number;
  step_before: string | null;
  step_after: string | null;
  status_before: string | null;
  status_after: string | null;
  step_advanced: boolean;
  pending_confirmation: boolean;
  stepLabels?: OperationalStepLabelMap;
}): { title: string; lines: string[]; tone: "ready" | "attention" | "pending" } {
  const label = (key: string | null) => {
    if (!key) return "sin paso";
    const mapped = params.stepLabels?.[key];
    return mapped && mapped !== key ? `${mapped} (${key})` : key;
  };
  const title = `Transición ${params.transitionNumber} completada`;
  const lines: string[] = [
    `Paso: ${label(params.step_before)} → ${label(params.step_after)}${
      params.step_advanced ? "" : " (sin avance de paso)"
    }`,
  ];
  if (params.status_before || params.status_after) {
    lines.push(
      `Estado: ${params.status_before ?? "—"} → ${params.status_after ?? "—"}`
    );
  }
  if (params.pending_confirmation) {
    lines.push("Pendiente de aprobación humana antes de la siguiente transición.");
  } else if (!params.step_advanced) {
    lines.push(
      "El caso siguió en el mismo paso operativo. Resuelve HITL, Telegram o datos externos y ejecuta otra transición."
    );
  } else {
    lines.push("El caso avanzó al siguiente paso operativo.");
  }
  const tone: "ready" | "attention" | "pending" = params.pending_confirmation
    ? "attention"
    : params.step_advanced
      ? "ready"
      : "pending";
  return { title, lines, tone };
}

export function needsE2EPlaythroughRestartBanner(params: {
  currentStep: string | null | undefined;
  playthroughAnchorAt: string | null;
}): boolean {
  if (params.playthroughAnchorAt) return false;
  const step = params.currentStep?.trim();
  if (!step || step === "intake") return false;
  return true;
}

export function cleanupTargetLabel(
  target: SettingsTestCleanupTarget,
  counts: SettingsTestActionKindCounts
): string {
  if (target === "notifications") {
    return `Solo notificaciones (${counts.notifications})`;
  }
  if (target === "tool_calls") {
    return `Solo aprobaciones del agente (${counts.toolConfirmations})`;
  }
  return `Todo el historial (${counts.total})`;
}

function truncatePreviewText(value: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function stringToolArg(
  args: Record<string, unknown>,
  key: string
): string | null {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

const LAB_TOOL_ARG_LABELS: Record<string, string> = {
  status: "Estado",
  current_step: "Etapa operativa",
  note: "Motivo",
  reason: "Motivo",
  purpose: "Propósito",
  text: "Texto",
  chat_id: "Chat",
};

export function formatOperationalStepArgValue(
  stepKey: string,
  stepLabels?: OperationalStepLabelMap
): string {
  const label = stepLabels?.[stepKey]?.trim();
  if (label && label !== stepKey) {
    return `${label} (${stepKey})`;
  }
  return stepKey;
}

function labToolArgLabel(key: string): string {
  return LAB_TOOL_ARG_LABELS[key] ?? key;
}

function formatToolArgDisplayValue(
  key: string,
  value: string,
  opts?: { operationalStepLabels?: OperationalStepLabelMap }
): string {
  if (key === "current_step") {
    return formatOperationalStepArgValue(value, opts?.operationalStepLabels);
  }
  return truncatePreviewText(value, key === "text" ? 100 : 80);
}

/** Una línea legible de args para items tool_confirmation en el laboratorio. */
export function formatLabToolArgsPreviewLine(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  opts?: { operationalStepLabels?: OperationalStepLabelMap }
): string | null {
  if (!args || typeof args !== "object") return null;

  const parts: string[] = [];

  if (toolName === "operational_case_update_state") {
    const status = stringToolArg(args, "status");
    const step = stringToolArg(args, "current_step");
    const note = stringToolArg(args, "note");
    if (status) parts.push(`Estado: ${status}`);
    if (step) {
      parts.push(
        `Etapa operativa: ${formatOperationalStepArgValue(step, opts?.operationalStepLabels)}`
      );
    }
    if (note) parts.push(`Motivo: ${truncatePreviewText(note)}`);
    if (parts.length === 0 && typeof args.expected_version === "number") {
      parts.push(`Versión esperada: ${args.expected_version}`);
    }
  } else if (toolName === "telegram_send_message_to_contact") {
    const purpose = stringToolArg(args, "purpose");
    const text = stringToolArg(args, "text");
    const chatId = args.chat_id;
    if (purpose) parts.push(`Propósito: ${purpose}`);
    if (typeof chatId === "number") parts.push(`Chat: ${chatId}`);
    else if (typeof chatId === "string" && chatId.trim()) {
      parts.push(`Chat: ${chatId.trim()}`);
    }
    if (text) parts.push(`Texto: ${truncatePreviewText(text, 100)}`);
  } else {
    for (const key of [
      "reason",
      "note",
      "purpose",
      "current_step",
      "status",
      "text",
    ] as const) {
      const value = stringToolArg(args, key);
      if (value) {
        parts.push(
          `${labToolArgLabel(key)}: ${formatToolArgDisplayValue(key, value, opts)}`
        );
      }
    }
  }

  if (parts.length === 0) {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === "case_id" || key === "expected_version") continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      summary[key] = value;
    }
    const keys = Object.keys(summary);
    if (keys.length === 0) return null;
    return truncatePreviewText(
      keys
        .slice(0, 4)
        .map((key) => {
          const raw = String(summary[key]);
          const display =
            key === "current_step"
              ? formatOperationalStepArgValue(raw, opts?.operationalStepLabels)
              : raw;
          return `${labToolArgLabel(key)}: ${display}`;
        })
        .join(" · "),
      160
    );
  }

  return parts.join(" · ");
}

const CONVERSATIONAL_CASE_STEP_FALLBACK_LABELS: OperationalStepLabelMap = {
  intake: "Intake conversacional",
  awaiting_documents: "Solicitar documentos",
  documents_received: "Procesar documentos",
  property_data_review: "Revisión de datos de la propiedad",
};

function observedCasePropertyHeadline(opCase: OperationalCase): string {
  const title = operationalCaseDisplayTitle(opCase);
  const context = opCase.context_jsonb ?? {};
  const zone =
    (typeof context.property_zone === "string" && context.property_zone.trim()) ||
    (typeof context.zone === "string" && context.zone.trim()) ||
    (typeof context.zona === "string" && context.zona.trim()) ||
    null;
  if (!zone) return title;
  if (title.toLowerCase().includes(zone.toLowerCase())) return title;
  return `${title} · ${zone}`;
}

export function isObservationalLabCaseReadOnly(
  opCase: Pick<OperationalCase, "status"> | null | undefined
): boolean {
  return opCase?.status === "completed" || opCase?.status === "failed";
}

/**
 * Casos conversacionales seleccionables en el lab E2E.
 * Incluye cerrados (completed/failed) para auditoría en solo lectura;
 * los activos van primero.
 */
export function listObservableConversationalCases(
  cases: OperationalCase[]
): OperationalCase[] {
  return cases
    .filter(
      (opCase) => opCase.context_jsonb?.created_from === "agent_conversation"
    )
    .sort((a, b) => {
      const rank = (status: OperationalCase["status"]) =>
        isObservationalLabCaseReadOnly({ status }) ? 1 : 0;
      const rankDiff = rank(a.status) - rank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
}

export function partitionObservableConversationalCases(
  cases: OperationalCase[]
): {
  active: OperationalCase[];
  closedReadOnly: OperationalCase[];
} {
  const active: OperationalCase[] = [];
  const closedReadOnly: OperationalCase[] = [];
  for (const opCase of listObservableConversationalCases(cases)) {
    if (isObservationalLabCaseReadOnly(opCase)) closedReadOnly.push(opCase);
    else active.push(opCase);
  }
  return { active, closedReadOnly };
}

export function observedConversationalCaseModeTag(opCase: OperationalCase): string {
  if (opCase.context_jsonb?.e2e_controlled !== true) {
    return isObservationalLabCaseReadOnly(opCase) ? "[Real cerrado]" : "[Real]";
  }
  if (opCase.status === "completed") return "[E2E cerrado]";
  if (opCase.status === "failed") return "[E2E fallido]";
  if (opCase.status === "paused") {
    return opCase.context_jsonb?.e2e_control_status === "abandoned"
      ? "[E2E abandonado]"
      : "[E2E pausado]";
  }
  return "[E2E activo]";
}

function resolveObservedCaseStepLabel(params: {
  opCase: OperationalCase;
  operationalStepLabels?: OperationalStepLabelMap;
  currentStepProgressLabel?: string | null;
}): string {
  const stepKey = params.opCase.current_step;
  if (!stepKey) return "sin paso";
  const mergedLabels: OperationalStepLabelMap = {
    ...CONVERSATIONAL_CASE_STEP_FALLBACK_LABELS,
    ...params.operationalStepLabels,
  };
  if (mergedLabels[stepKey]?.trim()) {
    return formatOperationalStepArgValue(stepKey, mergedLabels);
  }
  if (params.currentStepProgressLabel?.trim()) {
    return params.currentStepProgressLabel.trim();
  }
  return stepKey;
}

export function buildObservedConversationalCaseLabel(params: {
  opCase: OperationalCase;
  operationalStepLabels?: OperationalStepLabelMap;
  currentStepProgressLabel?: string | null;
  formatDateTime: (value: string | null | undefined) => string;
}): string {
  const modeTag = observedConversationalCaseModeTag(params.opCase);
  const headline = observedCasePropertyHeadline(params.opCase);
  const step = resolveObservedCaseStepLabel(params);
  const status =
    OPERATIONAL_CASE_STATUS_LABELS[params.opCase.status] ??
    params.opCase.status;
  const updated = params.formatDateTime(params.opCase.updated_at);
  return `${modeTag} ${headline} · ${step} · ${status} · ${params.opCase.id} · ${updated}`;
}
