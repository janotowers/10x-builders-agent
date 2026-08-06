/**
 * Vocabulario y clasificación del tablero "Trabajo durable"
 * (/operations/overview). Columnas = situación operativa del caso/tarea,
 * no estados del work plane (esos viven en Unidades de trabajo).
 *
 * Sin drag-and-drop: las columnas son proyección; la verdad la mueven
 * runtime, HITL e inbox — no el operador arrastrando tarjetas.
 */

export type DurableWorkColumnId =
  | "needs_attention"
  | "in_progress"
  | "waiting_external"
  | "blocked"
  | "paused"
  | "done";

export interface DurableWorkColumn {
  id: DurableWorkColumnId;
  label: string;
  shortLabel: string;
  description: string;
}

/**
 * Camino operativo (fila principal). blocked/paused NO van aquí: son
 * bandejas de excepción arriba del tablero (solo si tienen casos).
 */
export const DURABLE_WORK_FLOW_COLUMNS: DurableWorkColumn[] = [
  {
    id: "needs_attention",
    label: "Requiere tu atención",
    shortLabel: "Atención",
    description: "Decisiones, aportaciones o revisión humana pendientes.",
  },
  {
    id: "in_progress",
    label: "En marcha",
    shortLabel: "En marcha",
    description: "El sistema avanza sin esperar una acción tuya inmediata.",
  },
  {
    id: "waiting_external",
    label: "Esperando a terceros",
    shortLabel: "Externos",
    description: "Dueño, contacto externo u otro tercero.",
  },
  {
    id: "done",
    label: "Finalizado",
    shortLabel: "Finalizado",
    description: "Casos completados o fallidos.",
  },
];

/** Excepción urgente: work items bloqueados (no incluye pausados). */
export const DURABLE_WORK_BLOCKED_COLUMN: DurableWorkColumn = {
  id: "blocked",
  label: "Bloqueado",
  shortLabel: "Bloqueado",
  description:
    "Excepción · unidades de trabajo internas bloqueadas (no es etapa del flujo).",
};

/** Parada deliberada: menos urgente que Bloqueado; bandeja aparte. */
export const DURABLE_WORK_PAUSED_COLUMN: DurableWorkColumn = {
  id: "paused",
  label: "Pausado",
  shortLabel: "Pausado",
  description:
    "Detenido a propósito (operador, lab o preflight). No es fallo de ejecución.",
};

export interface DurableWorkClassifyInput {
  status: string;
  /** Conteos de work items del caso (opcional). */
  work?: {
    blocked?: number;
    byStatus?: Partial<Record<string, number>>;
  } | null;
}

/**
 * Prioridad: bloqueado (work) → pausado → atención → externos → en marcha →
 * finalizado. Un caso paused con work blocked sigue en blocked (más urgente).
 */
export function classifyDurableWorkColumn(
  input: DurableWorkClassifyInput
): DurableWorkColumnId {
  const status = input.status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return "done";
  }
  if ((input.work?.blocked ?? 0) > 0) {
    return "blocked";
  }
  if (status === "paused") {
    return "paused";
  }
  const review = input.work?.byStatus?.review ?? 0;
  if (status === "waiting_internal" || review > 0) {
    return "needs_attention";
  }
  if (status === "waiting_external") {
    return "waiting_external";
  }
  return "in_progress";
}

/** Fecha/hora corta para chips de tarjeta (es-MX). */
export function formatDurableDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Fecha/hora completa para el panel de detalle. */
export function formatDurableDateTimeFull(
  iso: string | null | undefined
): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function durableCaseStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "Activo",
    waiting_internal: "Esperando interno",
    waiting_external: "Esperando externo",
    paused: "Pausado",
    completed: "Completado",
    failed: "Fallido",
    cancelled: "Cancelado",
  };
  return labels[status] ?? status;
}

export type DurableDetailDateRow = {
  label: string;
  value: string;
  /** ISO para ordenar cronológicamente en la UI. */
  at: string;
};

/**
 * Fechas del detalle del caso, ordenadas cronológicamente (más antigua → más
 * reciente) para pintarlas en un solo renglón.
 * - Omite `next_action_at` / `due_at` nulos.
 * - `due_at` = "Fecha límite" (no "Vence"); "(vencida)" si ya pasó.
 * - En paused/completed/failed no mostramos límite vencido (ruido histórico).
 */
export function durableCaseDetailDateRows(input: {
  status: string;
  createdAt: string;
  updatedAt: string;
  nextActionAt?: string | null;
  dueAt?: string | null;
  nowMs?: number;
}): DurableDetailDateRow[] {
  const now = input.nowMs ?? Date.now();
  const rows: DurableDetailDateRow[] = [
    {
      label: "Creado",
      value: formatDurableDateTimeFull(input.createdAt),
      at: input.createdAt,
    },
    {
      label: "Actualizado",
      value: formatDurableDateTimeFull(input.updatedAt),
      at: input.updatedAt,
    },
  ];

  if (input.nextActionAt) {
    rows.push({
      label: "Próx. revisión",
      value: formatDurableDateTimeFull(input.nextActionAt),
      at: input.nextActionAt,
    });
  }

  if (input.dueAt) {
    const dueMs = new Date(input.dueAt).getTime();
    const past = Number.isFinite(dueMs) && dueMs < now;
    const terminalOrPaused =
      input.status === "paused" ||
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "cancelled";
    if (past && terminalOrPaused) {
      // Límite viejo en caso ya detenido: no aporta.
    } else if (past) {
      rows.push({
        label: "Fecha límite (vencida)",
        value: formatDurableDateTimeFull(input.dueAt),
        at: input.dueAt,
      });
    } else {
      rows.push({
        label: "Fecha límite",
        value: formatDurableDateTimeFull(input.dueAt),
        at: input.dueAt,
      });
    }
  }

  return rows.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  );
}
