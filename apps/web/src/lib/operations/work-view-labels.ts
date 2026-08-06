/**
 * Mapeo puro estado/etiqueta para la vista de trabajo del operador (Slice
 * 2.5). Vocabulario de liveness EXACTO del Technical Plan §10 — la palabra
 * "heartbeat" está reservada para el Gu OS Heartbeat (proactividad) y NUNCA
 * se usa para claims de ejecución (regla 4; el UI selftest lo verifica).
 */
import type { WorkItem, WorkItemAttempt, WorkItemStatus } from "@agents/types";

export type WorkViewColumn = {
  status: WorkItemStatus;
  label: string;
  /** Etiqueta corta para cabeceras de columna estrechas (5 en fila). */
  shortLabel?: string;
};

/**
 * Camino feliz del tablero (izquierda → derecha). Bloqueado NO va aquí:
 * es una excepción que reencola a `ready`, no una etapa del flujo.
 */
export const WORK_VIEW_FLOW_COLUMNS: WorkViewColumn[] = [
  { status: "todo", label: "Por hacer" },
  {
    status: "ready",
    label: "Listo para ejecutar",
    shortLabel: "Listo",
  },
  { status: "running", label: "En ejecución" },
  { status: "review", label: "En revisión" },
  { status: "done", label: "Terminado" },
];

/** Bandeja de excepción (fuera de la secuencia del camino feliz). */
export const WORK_VIEW_BLOCKED_COLUMN: WorkViewColumn = {
  status: "blocked",
  label: "Bloqueado",
};

/**
 * Todas las columnas del vocabulario de la vista (flujo + excepción).
 * El orden histórico del plan mantiene `blocked` entre running y review
 * para etiquetas/status; el layout del tablero usa FLOW + BLOCKED aparte.
 */
export const WORK_VIEW_COLUMNS: WorkViewColumn[] = [
  { status: "todo", label: "Por hacer" },
  {
    status: "ready",
    label: "Listo para ejecutar",
    shortLabel: "Listo",
  },
  { status: "running", label: "En ejecución" },
  WORK_VIEW_BLOCKED_COLUMN,
  { status: "review", label: "En revisión" },
  { status: "done", label: "Terminado" },
];

export function workItemStatusLabel(status: WorkItemStatus): string {
  const column = WORK_VIEW_COLUMNS.find((c) => c.status === status);
  if (column) return column.label;
  return status === "cancelled" ? "Cancelado" : status;
}

export type WorkReviewActionPresentation =
  | {
      kind: "domain_decision";
      guidance: string;
    }
  | {
      kind: "manual_close";
      label: string;
      title: string;
    };

/**
 * Algunas revisiones son proyecciones de una decisión de negocio que vive en
 * el caso. No deben ofrecer un botón genérico que parezca aprobar esa decisión.
 */
export function workReviewActionPresentation(
  workType: string
): WorkReviewActionPresentation {
  if (workType === "verify_valuation") {
    return {
      kind: "domain_decision",
      guidance:
        "Se resuelve al aprobar o ajustar la propuesta de precio en el caso.",
    };
  }
  return {
    kind: "manual_close",
    label: "Aceptar resultado y cerrar",
    title:
      "Marca únicamente esta unidad como terminada; no aprueba otras decisiones del caso.",
  };
}

export function executorKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "main_agent":
      return "Agente principal";
    case "deterministic_service":
      return "Servicio determinista";
    case "registered_specialized_worker":
    // Alias histórico: attempts previos al rename de taxonomía (2026-08-06).
    case "specialized_agent":
      return "Ejecutor especializado";
    case "ephemeral_subagent":
      return "Subagente temporal";
    case "ephemeral_worker":
      return "Ejecutor temporal";
    case "durable_worker":
      return "Ejecutor durable";
    case "external_service":
      return "Servicio externo";
    case "human":
      return "Humano";
    case "unresolved":
      return "Sin ejecutor";
    default:
      return kind && kind.trim() ? kind : "—";
  }
}

export function retryStateLabel(item: Pick<WorkItem, "attempt_count" | "max_attempts">): string {
  return `Intento ${item.attempt_count}/${item.max_attempts}`;
}

/**
 * Nombre legible del work type. Regla: humanizar sin ocultar — la UI muestra
 * este label como principal y el slug como secundario (el slug identifica sin
 * ambigüedad en eventos/soporte y no debe desaparecer). Diccionario para los
 * tipos conocidos; fallback: humanización genérica del slug.
 */
const WORK_TYPE_LABELS: Record<string, string> = {
  verify_valuation: "Verificación de valuación",
  extraction_consolidation: "Consolidación de extracciones",
  publication_reconciliation: "Reconciliación de publicación",
  work_plane_synthetic_echo: "Eco de prueba (sintético)",
  work_plane_synthetic_branch_a: "Rama A de prueba (sintético)",
  work_plane_synthetic_branch_b: "Rama B de prueba (sintético)",
  work_plane_synthetic_fan_in: "Convergencia de ramas (sintético)",
  work_plane_synthetic_approval: "Aprobación de prueba (sintético)",
  work_plane_synthetic_unregistered: "Tipo no registrado (fixture de fallo)",
};

export function workTypeLabel(workType: string): string {
  const known = WORK_TYPE_LABELS[workType];
  if (known) return known;
  const humanized = workType.replace(/[_-]+/g, " ").trim();
  if (!humanized) return workType;
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * Motivo de bloqueo legible. Los códigos conocidos se traducen; texto libre
 * (p. ej. el mensaje de un error de ejecutor) se muestra tal cual.
 */
export function blockedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Razón desconocida";
  if (reason === "max_attempts_exhausted") {
    return "Se agotaron los intentos permitidos";
  }
  if (reason.startsWith("no_executor_for_capability:")) {
    const capability = reason.slice("no_executor_for_capability:".length);
    return `Sin ejecutor para la capacidad «${capability || "desconocida"}»`;
  }
  return reason;
}

export function verificationStateLabel(
  item: Pick<WorkItem, "status" | "verification_contract_jsonb" | "output_contract_jsonb">
): string {
  if (item.status === "done") return "Verificado";
  if (item.status === "review") return "Pendiente de revisión humana";
  const hasContract =
    Object.keys(item.verification_contract_jsonb ?? {}).length > 0 ||
    Object.keys(item.output_contract_jsonb ?? {}).length > 0;
  return hasContract ? "Contrato declarado" : "Sin contrato (mínimo Phase 2)";
}

/**
 * Cue de liveness con el vocabulario §10: Executor active · Last liveness
 * update · Claim expires · Execution appears stalled · Claim expired · Work
 * reassigned.
 */
export function livenessCue(
  attempt: Pick<
    WorkItemAttempt,
    "status" | "claim_expires_at" | "last_liveness_at"
  > | null,
  now: Date = new Date()
): string {
  if (!attempt) return "";
  if (attempt.status === "claim_expired") {
    return "Claim expirado · Trabajo reasignado";
  }
  if (attempt.status !== "running") return "";
  const nowIso = now.toISOString();
  const expired = attempt.claim_expires_at < nowIso;
  if (expired) {
    return "La ejecución parece estancada · Claim expirado";
  }
  const liveness = attempt.last_liveness_at
    ? `Última actualización de vitalidad: ${formatShortTime(attempt.last_liveness_at)}`
    : "Sin actualización de vitalidad todavía";
  return `Ejecutor activo · ${liveness} · El claim expira: ${formatShortTime(attempt.claim_expires_at)}`;
}

function formatShortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Chip de la superficie del broker: solo n items + indicador de bloqueo. */
export function caseWorkChipLabel(summary: {
  total: number;
  blocked: number;
}): string {
  if (summary.total === 0) return "";
  const base = summary.total === 1 ? "1 trabajo" : `${summary.total} trabajos`;
  return summary.blocked > 0 ? `${base} · ${summary.blocked} bloqueado(s)` : base;
}

/**
 * Orden del tablero de Unidades de trabajo: updated_at desc en todas las
 * columnas (misma señal temporal que Trabajo durable). El despacho
 * (claimNextReady) sigue usando priority + created_at aparte.
 */
export function sortWorkItemsForBoardView<
  T extends { updated_at: string; id: string },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const byUpdated = b.updated_at.localeCompare(a.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return b.id.localeCompare(a.id);
  });
}
