"use client";

import { useMemo, useState } from "react";
import type {
  GlobalToolRequest,
  GlobalToolRequestKind,
  GlobalToolRequestStatus,
} from "@agents/types";

const STATUS_VALUES: GlobalToolRequestStatus[] = [
  "requested",
  "in_review",
  "in_progress",
  "shipped",
  "rejected",
];

function statusLabel(status: GlobalToolRequestStatus) {
  if (status === "requested") return "Solicitada";
  if (status === "in_review") return "En revisión";
  if (status === "in_progress") return "En desarrollo";
  if (status === "shipped") return "Resuelta";
  if (status === "rejected") return "Rechazada";
  return status;
}

function kindLabel(kind: GlobalToolRequestKind) {
  if (kind === "incorporate_to_catalog") return "Incorporar al producto";
  if (kind === "enable_account_config") return "Habilitar configuración";
  if (kind === "provide_tenant_asset") return "Configurar recurso";
  return kind;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ToolRequestsClient({
  initialRequests,
  embedded = false,
}: {
  initialRequests: GlobalToolRequest[];
  embedded?: boolean;
}) {
  const [requests, setRequests] = useState(initialRequests);
  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleRequests = useMemo(() => {
    if (statusFilter === "all") return requests;
    return requests.filter((request) =>
      ["requested", "in_review", "in_progress"].includes(request.status)
    );
  }, [requests, statusFilter]);

  async function updateRequest(
    request: GlobalToolRequest,
    patch: { status?: GlobalToolRequestStatus; admin_notes?: string | null }
  ) {
    setSavingId(request.id);
    setError(null);
    try {
      const res = await fetch("/api/global-tool-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: request.id,
          status: patch.status ?? request.status,
          admin_notes: patch.admin_notes ?? request.admin_notes ?? "",
        }),
      });
      const data = (await res.json()) as
        | { ok: true; request: GlobalToolRequest }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "request_update_failed");
        return;
      }
      setRequests((prev) =>
        prev.map((item) => (item.id === data.request.id ? data.request : item))
      );
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {!embedded ? (
          <div>
            <h1 className="text-lg font-semibold">
              Solicitudes de herramientas y capacidades
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Backlog creado desde Preparación operativa cuando una tool está en
              stub, requiere un recurso de cuenta o necesita prioridad de producto.
            </p>
          </div>
        ) : null}
        <div className={`flex gap-2 text-xs ${embedded ? "ml-auto" : ""}`}>
          <button
            type="button"
            onClick={() => setStatusFilter("open")}
            className={`rounded border px-3 py-1.5 font-semibold ${
              statusFilter === "open"
                ? "border-violet-700 bg-violet-700 text-white"
                : "border-neutral-300 hover:bg-neutral-50"
            }`}
          >
            Abiertas
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={`rounded border px-3 py-1.5 font-semibold ${
              statusFilter === "all"
                ? "border-violet-700 bg-violet-700 text-white"
                : "border-neutral-300 hover:bg-neutral-50"
            }`}
          >
            Todas
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </p>
      ) : null}

      {visibleRequests.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-500">
          No hay solicitudes para este filtro.
        </div>
      ) : (
        <ul className="space-y-3">
          {visibleRequests.map((request) => (
            <li
              key={request.id}
              className="rounded-xl border border-neutral-200 bg-white p-4 text-sm shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-xs text-violet-700">
                    {request.tool_id}
                  </div>
                  <div className="mt-1 font-semibold">
                    {kindLabel(request.request_kind)}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    Creada: {formatDateTime(request.created_at)}
                    {request.case_type_id
                      ? ` · case_type_id: ${request.case_type_id}`
                      : ""}
                  </div>
                </div>
                <span className="rounded bg-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-700">
                  {statusLabel(request.status)}
                </span>
              </div>

              {request.business_context ? (
                <p className="mt-3 rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                  {request.business_context}
                </p>
              ) : null}

              <div className="mt-3 grid gap-2 md:grid-cols-[180px_1fr_auto]">
                <label className="text-xs">
                  <span className="font-semibold text-neutral-600">Estado</span>
                  <select
                    value={request.status}
                    onChange={(event) =>
                      updateRequest(request, {
                        status: event.target.value as GlobalToolRequestStatus,
                      })
                    }
                    disabled={savingId === request.id}
                    className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-xs"
                  >
                    {STATUS_VALUES.map((status) => (
                      <option key={status} value={status}>
                        {statusLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  <span className="font-semibold text-neutral-600">
                    Notas internas
                  </span>
                  <textarea
                    defaultValue={request.admin_notes ?? ""}
                    onBlur={(event) =>
                      updateRequest(request, {
                        admin_notes: event.currentTarget.value,
                      })
                    }
                    disabled={savingId === request.id}
                    className="mt-1 min-h-16 w-full rounded border border-neutral-300 px-2 py-1.5 text-xs"
                    placeholder="Prioridad, responsable, decisión o contexto técnico."
                  />
                </label>
                <div className="flex items-end text-xs text-neutral-500">
                  {savingId === request.id ? "Guardando..." : "Auto-guarda al salir"}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
