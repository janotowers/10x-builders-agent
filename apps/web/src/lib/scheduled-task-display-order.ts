/** Sort key for next run: missing/invalid dates sort last. */
function nextRunSortKey(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Lower rank = earlier in list. */
function statusRank(status: string): number {
  if (status === "running") return 0;
  if (status === "active") return 1;
  if (status === "paused") return 2;
  return 3;
}

export type ScheduledTaskDisplaySortable = {
  id: string;
  nextRunAt: string | null;
  status: string;
};

/**
 * Executable tasks first, ordered by nearest `next_run_at`; paused tasks follow
 * so stale "Fecha pasada" values do not outrank work that will actually run.
 */
export function sortScheduledTasksForDisplay<T extends ScheduledTaskDisplaySortable>(
  tasks: T[]
): T[] {
  return [...tasks].sort((a, b) => {
    const ra = statusRank(a.status);
    const rb = statusRank(b.status);
    if (ra !== rb) return ra - rb;
    const ka = nextRunSortKey(a.nextRunAt);
    const kb = nextRunSortKey(b.nextRunAt);
    if (ka !== kb) return ka - kb;
    return a.id.localeCompare(b.id);
  });
}
