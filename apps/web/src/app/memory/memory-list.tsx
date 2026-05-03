"use client";

import { useEffect, useMemo, useState } from "react";

type MemoryType = "episodic" | "semantic" | "procedural";
type Status = "active" | "archived" | "all";

interface MemoryRow {
  id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
  archived_at: string | null;
}

interface Props {
  initialRows: MemoryRow[];
  initialTotal: number;
}

const TYPE_LABEL: Record<MemoryType, string> = {
  semantic: "Semántico",
  episodic: "Episódico",
  procedural: "Procedural",
};

const TYPE_COLOR: Record<MemoryType, string> = {
  semantic:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  episodic:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  procedural:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
};

const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface Confirm {
  title: string;
  body: string;
  confirmLabel: string;
  variant: "danger" | "default";
  action: () => Promise<void>;
}

export function MemoryList({ initialRows, initialTotal }: Props) {
  const [rows, setRows] = useState<MemoryRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [status, setStatus] = useState<Status>("active");
  const [type, setType] = useState<MemoryType | "">("");
  const [sortBy, setSortBy] = useState<"created_at" | "archived_at">(
    "created_at"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  );
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  async function load(opts?: { resetOffset?: boolean }): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("status", status);
      if (type) params.set("type", type);
      const effectiveSortBy =
        status === "active" && sortBy === "archived_at"
          ? "created_at"
          : sortBy;
      params.set("sort_by", effectiveSortBy);
      params.set("sort_dir", sortDir);
      if (q.trim().length > 0) params.set("q", q.trim());
      const nextOffset = opts?.resetOffset ? 0 : offset;
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(nextOffset));
      const res = await fetch(`/api/memories?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        rows: MemoryRow[];
        total: number;
      };
      setRows(data.rows);
      setTotal(data.total);
      if (opts?.resetOffset) setOffset(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Recargar cuando cambien filtros (no q en tiempo real; q se aplica al pulsar Enter o botón).
  useEffect(() => {
    void load({ resetOffset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, type, sortBy, sortDir]);

  // Recargar cuando cambia offset (paginación).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  async function archive(row: MemoryRow): Promise<void> {
    setPendingId(row.id);
    try {
      const res = await fetch(`/api/memories/${row.id}/archive`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlash("Recuerdo archivado.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  async function restore(row: MemoryRow): Promise<void> {
    setPendingId(row.id);
    try {
      const res = await fetch(`/api/memories/${row.id}/restore`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlash("Recuerdo restaurado.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  async function destroy(row: MemoryRow): Promise<void> {
    setPendingId(row.id);
    try {
      const res = await fetch(`/api/memories/${row.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlash("Recuerdo borrado definitivamente.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Aquí ves los hechos que el agente recuerda sobre ti entre sesiones.
        Puedes archivarlos (deja de inyectarlos pero los conservas) o
        borrarlos definitivamente. Esto solo te afecta a ti.
      </p>

      {/* Tabs status */}
      <div className="flex gap-2 border-b border-neutral-200 dark:border-neutral-800">
        {(["active", "archived", "all"] as Status[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStatus(s);
              if (s === "active") setSortBy("created_at");
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              status === s
                ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            }`}
          >
            {s === "active"
              ? "Activos"
              : s === "archived"
                ? "Archivados"
                : "Todos"}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType | "")}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Todos los tipos</option>
          <option value="semantic">Semántico</option>
          <option value="episodic">Episódico</option>
          <option value="procedural">Procedural</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="whitespace-nowrap">Ordenar por</span>
          <select
            value={
              status === "active" && sortBy === "archived_at"
                ? "created_at"
                : sortBy
            }
            onChange={(e) =>
              setSortBy(e.target.value as "created_at" | "archived_at")
            }
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="created_at">Fecha de creación</option>
            {(status === "archived" || status === "all") && (
              <option value="archived_at">Fecha de archivo</option>
            )}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="whitespace-nowrap">Orden</span>
          <select
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="desc">Descendente (más reciente primero)</option>
            <option value="asc">Ascendente (más antiguo primero)</option>
          </select>
        </label>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load({ resetOffset: true });
          }}
          placeholder="Buscar en el contenido…"
          className="min-w-[12rem] flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="button"
          onClick={() => void load({ resetOffset: true })}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Buscar
        </button>
        {(q || type) && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setType("");
            }}
            className="rounded-md border border-transparent px-2 py-1.5 text-xs text-neutral-600 hover:underline dark:text-neutral-400"
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Mensajes */}
      {flash && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {flash}{" "}
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="ml-2 text-xs underline"
          >
            cerrar
          </button>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-xs underline"
          >
            cerrar
          </button>
        </div>
      )}

      {/* Lista */}
      <div className="space-y-2">
        {loading && (
          <div className="text-sm text-neutral-500">Cargando…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="rounded-md border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No hay recuerdos que coincidan con los filtros.
          </div>
        )}
        {rows.map((row) => {
          const isArchived = !!row.archived_at;
          const busy = pendingId === row.id;
          return (
            <div
              key={row.id}
              className="rounded-md border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-950"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TYPE_COLOR[row.type]}`}
                >
                  {TYPE_LABEL[row.type]}
                </span>
                {isArchived && (
                  <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                    Archivado
                  </span>
                )}
                <span className="text-[11px] text-neutral-500">
                  Creado {formatDate(row.created_at)}
                </span>
                {row.archived_at && (
                  <span className="text-[11px] text-neutral-500">
                    · Archivado {formatDate(row.archived_at)}
                  </span>
                )}
                <span className="text-[11px] text-neutral-500">
                  · Recuperado {row.retrieval_count} veces
                </span>
                {row.last_retrieved_at && (
                  <span className="text-[11px] text-neutral-500">
                    · Última {formatDate(row.last_retrieved_at)}
                  </span>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">
                {row.content}
              </p>
              <div className="mt-3 flex gap-2">
                {!isArchived && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        title: "¿Archivar este recuerdo?",
                        body: row.content,
                        confirmLabel: "Archivar",
                        variant: "default",
                        action: async () => {
                          await archive(row);
                        },
                      })
                    }
                    className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Archivar
                  </button>
                )}
                {isArchived && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restore(row)}
                    className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Restaurar
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      title: "¿Borrar definitivamente?",
                      body: row.content,
                      confirmLabel: "Borrar",
                      variant: "danger",
                      action: async () => {
                        await destroy(row);
                      },
                    })
                  }
                  className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  Borrar
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Paginación */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-500">
            Página {currentPage} de {totalPages} · {total} recuerdos
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              ← Anterior
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Siguiente →
            </button>
          </div>
        </div>
      )}

      {/* Modal de confirmación */}
      {confirm && (
        <ConfirmModal
          confirm={confirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function ConfirmModal({
  confirm,
  onClose,
}: {
  confirm: Confirm;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handle(): Promise<void> {
    setBusy(true);
    try {
      await confirm.action();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{confirm.title}</h3>
        <blockquote className="mt-2 max-h-40 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          {confirm.body}
        </blockquote>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handle()}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              confirm.variant === "danger"
                ? "bg-red-600 hover:bg-red-700"
                : "bg-neutral-900 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            }`}
          >
            {busy ? "Procesando…" : confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
