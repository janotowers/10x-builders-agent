/**
 * Vista de impacto del operador (Slice 3.5-1).
 *
 * A partir de un cambio de entrada (hecho corregido o asset reemplazado)
 * muestra, por caso pineado: los cambios recientes con valores viejo/nuevo y
 * su fuente, los artefactos afectados (stale/invalid), las aprobaciones
 * suspendidas, el trabajo de reparación creado por el motor, y — explícito a
 * propósito — los artefactos NO afectados (la garantía anti sobre-invalidación
 * se audita viéndolos quedarse en "Vigente").
 *
 * Override humano: un artefacto stale puede volver a `current` SOLO con
 * rationale obligatorio; queda evento `impact_override` en el stream del
 * caso. Mismo gate interino de operador que /operations/work
 * (profiles.is_ungga_admin).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createServerClient,
  getCaseArtifactById,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listCaseApprovalsForCase,
  listCaseArtifactsForCase,
  listCaseFacts,
  listPinnedActiveOperationalCases,
  listWorkItemsForCase,
  updateCaseArtifactStatus,
} from "@agents/db";
import type {
  CaseApproval,
  CaseArtifact,
  CaseFact,
  OperationalCase,
  OperationalCaseEvent,
  WorkItem,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { OperationsControlTabs } from "@/app/operations/operations-control-tabs";
import {
  artifactTypeLabel,
  changedInputLabel,
  impactStatusLabel,
  overInvalidationRatio,
  overInvalidationRatioLabel,
} from "@/lib/operations/impact-view-labels";
import { workTypeLabel } from "@/lib/operations/work-view-labels";

export const dynamic = "force-dynamic";

async function requireOperator(): Promise<
  { user: { id: string } } | { denied: true; flagValue: string }
> {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await auth
    .from("profiles")
    .select("is_ungga_admin")
    .eq("id", user.id)
    .single();
  if (profile?.is_ungga_admin !== true) {
    return { denied: true, flagValue: String(profile?.is_ungga_admin ?? "null") };
  }
  return { user };
}

/**
 * Override humano (3.5-1): stale/invalid → current con rationale OBLIGATORIO.
 * El motor jamás hace esto solo; por eso el evento registra quién y por qué.
 */
async function overrideArtifactAction(formData: FormData) {
  "use server";
  const gate = await requireOperator();
  if ("denied" in gate) redirect("/operations/impact");
  const artifactId = String(formData.get("artifact_id") ?? "").trim();
  const rationale = String(formData.get("rationale") ?? "").trim();
  if (!artifactId) redirect("/operations/impact");
  if (!rationale) {
    redirect(`/operations/impact?error=rationale&artifact=${artifactId}`);
  }
  const db = createServerClient();
  const artifact = await getCaseArtifactById(db, gate.user.id, artifactId);
  if (artifact && (artifact.status === "stale" || artifact.status === "invalid")) {
    const updated = await updateCaseArtifactStatus(db, {
      userId: gate.user.id,
      artifactId: artifact.id,
      status: "current",
      expectedVersion: artifact.version,
    });
    if (updated) {
      await insertOperationalCaseEvent(db, {
        caseId: artifact.case_id,
        eventType: "state_changed",
        actor: "user",
        payload: {
          kind: "impact_override",
          artifact_id: artifact.id,
          artifact_type: artifact.artifact_type,
          prior_status: artifact.status,
          rationale,
        },
      });
    }
  }
  revalidatePath("/operations/impact");
  redirect("/operations/impact");
}

type ImpactEventPayload = {
  kind?: string;
  artifact_id?: string;
  artifact_type?: string;
  approval_kind?: string;
  changed_input?: string;
  rationale?: string;
};

interface FactChangeRow {
  factKey: string;
  current: CaseFact | null;
  prior: CaseFact | null;
}

interface CaseImpactSection {
  opCase: OperationalCase;
  affected: CaseArtifact[];
  unaffected: CaseArtifact[];
  suspendedApprovals: CaseApproval[];
  repairItems: WorkItem[];
  impactEvents: OperationalCaseEvent[];
  factChanges: FactChangeRow[];
}

function caseTitle(opCase: OperationalCase): string {
  const ctx = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const candidate =
    (typeof ctx.property_title === "string" && ctx.property_title.trim()) ||
    (typeof ctx.title === "string" && ctx.title.trim()) ||
    (typeof ctx.nickname === "string" && ctx.nickname.trim());
  return candidate || `${opCase.case_type} · ${opCase.id.slice(0, 8)}…`;
}

const FACT_SOURCE_LABELS: Record<string, string> = {
  user: "el broker",
  external_contact: "un contacto externo",
  derived: "derivado por el sistema",
  system: "el sistema",
};

function factValueLabel(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function impactEventLabel(payload: ImpactEventPayload): string {
  const input = payload.changed_input
    ? changedInputLabel(payload.changed_input)
    : "una entrada";
  if (payload.kind === "impact_invalidation") {
    return `${input} cambió → ${artifactTypeLabel(payload.artifact_type ?? "")} quedó desactualizado`;
  }
  if (payload.kind === "impact_approval_suspended") {
    return `${input} cambió → aprobación "${payload.approval_kind ?? ""}" en pausa`;
  }
  if (payload.kind === "impact_override") {
    return `Override del operador: ${artifactTypeLabel(payload.artifact_type ?? "")} vuelve a vigente — "${payload.rationale ?? ""}"`;
  }
  return payload.kind ?? "evento de impacto";
}

async function loadCaseSection(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  opCase: OperationalCase
): Promise<CaseImpactSection> {
  const [artifacts, approvals, workItems, events] = await Promise.all([
    listCaseArtifactsForCase(db, userId, opCase.id),
    listCaseApprovalsForCase(db, userId, opCase.id),
    listWorkItemsForCase(db, userId, opCase.id),
    getRecentOperationalCaseEvents(db, opCase.id, 100),
  ]);

  const impactEvents = events
    .filter((event) => {
      const kind = (event.payload_jsonb as ImpactEventPayload | null)?.kind;
      return typeof kind === "string" && kind.startsWith("impact_");
    })
    .reverse(); // más reciente primero

  // Valores viejo/nuevo con fuente: para cada fact key que aparece como
  // changed_input en los eventos recientes, las últimas dos filas del
  // historial append-only (vigente + reemplazada).
  const changedFactKeys = [
    ...new Set(
      impactEvents
        .map((e) => (e.payload_jsonb as ImpactEventPayload).changed_input)
        .filter(
          (input): input is string =>
            typeof input === "string" &&
            !input.startsWith("artifact:") &&
            !input.startsWith("account_asset:")
        )
    ),
  ].slice(0, 8);
  const factChanges: FactChangeRow[] = [];
  for (const factKey of changedFactKeys) {
    const history = await listCaseFacts(db, userId, opCase.id, {
      factKey,
      includeSuperseded: true,
      limit: 2,
    });
    factChanges.push({
      factKey,
      current: history[0] ?? null,
      prior: history[1] ?? null,
    });
  }

  return {
    opCase,
    affected: artifacts.filter(
      (a) => a.status === "stale" || a.status === "invalid"
    ),
    unaffected: artifacts.filter((a) => a.status === "current"),
    suspendedApprovals: approvals.filter((a) => a.decision === "suspended"),
    repairItems: workItems.filter((item) => item.origin === "impact_repair"),
    impactEvents: impactEvents.slice(0, 10),
    factChanges,
  };
}

export default async function ImpactViewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; artifact?: string }>;
}) {
  const sp = await searchParams;
  const gate = await requireOperator();
  if ("denied" in gate) {
    return (
      <AppShell
        title="Control operativo"
        description="Vista del operador: qué invalidó cada cambio de datos y qué quedó intacto."
      >
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Sin acceso de operador</p>
          <p className="mt-2">
            Esta vista requiere <code>profiles.is_ungga_admin = true</code> como
            rol de operador interino. Ahora mismo el flag está en{" "}
            <code>{gate.flagValue}</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  const db = createServerClient();

  // Tolerante a entornos donde la migración 00070 aún no se aplica.
  let sections: CaseImpactSection[] = [];
  let unavailable = false;
  try {
    const pinned = await listPinnedActiveOperationalCases(db, gate.user.id);
    sections = await Promise.all(
      pinned.map((opCase) => loadCaseSection(db, gate.user.id, opCase))
    );
  } catch {
    unavailable = true;
  }

  const withActivity = sections.filter(
    (s) =>
      s.affected.length > 0 ||
      s.suspendedApprovals.length > 0 ||
      s.repairItems.length > 0 ||
      s.impactEvents.length > 0
  );
  const quietCount = sections.length - withActivity.length;

  // Métrica de exit check Phase 3: sobre-invalidación medida sobre TODO el
  // trabajo de reparación visible (canceladas / creadas).
  const allRepair = sections.flatMap((s) => s.repairItems);
  const ratio = overInvalidationRatio(allRepair);

  return (
    <AppShell
      title="Control operativo"
      description="Cambios y reparaciones: qué invalidó cada cambio de datos, qué quedó intacto y qué reparación se creó."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OperationsControlTabs active="impact" />
        <p className="mb-4 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          Sobre-invalidación: {overInvalidationRatioLabel(ratio)}
        </p>
      </div>

      {sp.error === "rationale" ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          El override requiere un rationale: explica por qué el artefacto sigue
          siendo válido a pesar del cambio.
        </div>
      ) : null}

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El plano de impacto no está disponible en este entorno (la migración
          00070 aún no se aplica o las tablas no responden).
        </div>
      ) : withActivity.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          Sin actividad de impacto en los casos pineados
          {quietCount > 0 ? ` (${quietCount} casos sin cambios)` : ""}. Cuando un
          hecho se corrija o un recurso de la cuenta se reemplace, aquí verás qué
          artefactos quedaron desactualizados y qué reparación se creó.
        </div>
      ) : (
        <div className="space-y-6">
          {withActivity.map((section) => (
            <section
              key={section.opCase.id}
              className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                {caseTitle(section.opCase)}
              </h2>

              {section.impactEvents.length > 0 ? (
                <div className="mt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Cambios recientes
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
                    {section.impactEvents.map((event) => (
                      <li key={event.id} className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[10px] text-neutral-400">
                          {new Date(event.created_at).toLocaleString("es-MX")}
                        </span>
                        <span>
                          {impactEventLabel(
                            event.payload_jsonb as ImpactEventPayload
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {section.factChanges.length > 0 ? (
                <div className="mt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Valores viejo → nuevo
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
                    {section.factChanges.map((change) => (
                      <li key={change.factKey}>
                        <span className="font-medium">
                          {changedInputLabel(change.factKey)}:
                        </span>{" "}
                        <span className="line-through opacity-60">
                          {factValueLabel(change.prior?.value_jsonb)}
                        </span>{" "}
                        → {factValueLabel(change.current?.value_jsonb)}
                        {change.current ? (
                          <span className="text-neutral-400">
                            {" "}
                            (fuente:{" "}
                            {FACT_SOURCE_LABELS[change.current.source_kind] ??
                              change.current.source_kind}
                            )
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-red-200 bg-red-50/50 p-3 dark:border-red-900 dark:bg-red-950/40">
                  <h3 className="text-xs font-semibold text-red-800 dark:text-red-200">
                    Artefactos afectados ({section.affected.length})
                  </h3>
                  {section.affected.length === 0 ? (
                    <p className="mt-1.5 text-xs text-neutral-500">Ninguno</p>
                  ) : (
                    <ul className="mt-1.5 space-y-2 text-xs">
                      {section.affected.map((artifact) => (
                        <li
                          key={artifact.id}
                          className="rounded-lg border border-red-200 bg-white p-2 dark:border-red-900 dark:bg-neutral-900"
                        >
                          <p className="font-medium text-neutral-900 dark:text-neutral-100">
                            {artifactTypeLabel(artifact.artifact_type)}{" "}
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">
                              {impactStatusLabel(artifact.status)}
                            </span>
                          </p>
                          <form
                            action={overrideArtifactAction}
                            className="mt-1.5 flex items-center gap-1.5"
                          >
                            <input
                              type="hidden"
                              name="artifact_id"
                              value={artifact.id}
                            />
                            <input
                              type="text"
                              name="rationale"
                              placeholder="Rationale obligatorio del override…"
                              defaultValue=""
                              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] dark:border-neutral-700 dark:bg-neutral-950"
                            />
                            <button
                              type="submit"
                              className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                              title="Marca el artefacto como vigente de nuevo, bajo tu responsabilidad. El rationale queda en el historial del caso."
                            >
                              Sigue válido
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
                  <h3 className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                    No afectados ({section.unaffected.length})
                  </h3>
                  {section.unaffected.length === 0 ? (
                    <p className="mt-1.5 text-xs text-neutral-500">
                      Ningún artefacto vigente
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
                      {section.unaffected.map((artifact) => (
                        <li key={artifact.id}>
                          {artifactTypeLabel(artifact.artifact_type)}{" "}
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                            {impactStatusLabel(artifact.status)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {section.suspendedApprovals.length > 0 ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                  <h3 className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                    Aprobaciones suspendidas ({section.suspendedApprovals.length})
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
                    {section.suspendedApprovals.map((approval) => (
                      <li key={approval.id}>
                        <span className="font-medium">
                          {approval.approval_kind}
                        </span>{" "}
                        — decidida el{" "}
                        {new Date(approval.decided_at).toLocaleString("es-MX")}. La
                        re-aprobación o revocación se responde desde los pendientes
                        del broker, no aquí.
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {section.repairItems.length > 0 ? (
                <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-900 dark:bg-sky-950/40">
                  <h3 className="text-xs font-semibold text-sky-800 dark:text-sky-200">
                    Trabajo de reparación ({section.repairItems.length})
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
                    {section.repairItems.map((item) => (
                      <li key={item.id}>
                        {workTypeLabel(item.work_type)} —{" "}
                        <code className="text-[10px]">{item.status}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ))}
          {quietCount > 0 ? (
            <p className="text-center text-xs text-neutral-400">
              {quietCount} caso{quietCount === 1 ? "" : "s"} pineado
              {quietCount === 1 ? "" : "s"} sin actividad de impacto.
            </p>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
