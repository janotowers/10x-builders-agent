/**
 * Pass v2 del cron de casos operacionales (Slice 2.3-2/2.3-3/2.3-4).
 *
 * Corre DESPUÉS del loop v1 y solo para tenants con `work_plane_v2`
 * habilitado. Los dos caminos coexisten sin estado mutable compartido: este
 * módulo solo toca las tablas del work plane y avanza casos a través del
 * wrapper advised (evaluator-autorizado) — nunca escribe `current_step`
 * directamente (§8.4; call site único dentro del dispatcher).
 */
import {
  claimNextReady as dbClaimNextReady,
  completeAttempt as dbCompleteAttempt,
  createWorkItemsFromTemplates as dbCreateWorkItemsFromTemplates,
  blockItem as dbBlockItem,
  listWorkItemsForCase as dbListWorkItemsForCase,
  propagateReadiness as dbPropagateReadiness,
  recoverStaleClaims as dbRecoverStaleClaims,
  reportLiveness as dbReportLiveness,
  getOperationalCase,
  getPublishedDefinition,
  getWorkItemById,
  listPinnedActiveOperationalCases,
  listWorkerProfilesForUser,
  listWorkPlaneV2Tenants,
  listDurableWorkTenants,
  listActiveWorkRunsForUser,
  listWorkItemsForRun,
  getDurableTask,
  updateDurableTask,
  updateWorkRun,
  upsertActiveInternalUserNotification,
  type DbClient,
} from "@agents/db";
import {
  createWorkDispatcher,
  createWorkflowDefinitionLoader,
  type DispatchableCase,
  type WorkPlaneStore,
  type WorkPlaneTickResult,
} from "@agents/workflows";
import type { WorkerProfile, WorkflowGraph } from "@agents/types";
import { createAdvisedCaseUpdate } from "./advised-case-update";
import {
  createWorkPlaneExecutorResolver,
  createWorkerScopeEnforcement,
} from "./work-plane-executors";

const advisedWorkPlaneCaseUpdate = createAdvisedCaseUpdate(
  "work_plane_dispatcher",
  "runtime"
);

/**
 * Notificación de caso cuando un item queda `blocked` (Phase 2 exit check:
 * max-attempts → blocked + notification). Cubre ambos caminos de bloqueo:
 * completion fallida que agota intentos y recovery de claims stale. El fallo
 * de la notificación jamás rompe el pass.
 */
async function notifyBlockedWorkItem(
  db: DbClient,
  userId: string,
  workItemId: string
): Promise<void> {
  try {
    const item = await getWorkItemById(db, userId, workItemId);
    if (!item || item.status !== "blocked") return;
    const body =
      item.blocked_reason === "max_attempts_exhausted"
        ? `«${item.work_type}» agotó sus intentos (${item.attempt_count}/${item.max_attempts}) y quedó bloqueado; requiere intervención del operador.`
        : `«${item.work_type}» quedó bloqueado: ${item.blocked_reason ?? "razón desconocida"}.`;
    await upsertActiveInternalUserNotification(db, {
      userId,
      caseId: item.case_id,
      kind: "work_item_blocked",
      title: `Trabajo bloqueado: ${item.work_type}`,
      body,
      metadata: { work_item_id: item.id, blocked_reason: item.blocked_reason },
    });
  } catch (error) {
    console.warn(
      `[work-plane] failed to notify blocked work item ${workItemId}:`,
      error
    );
  }
}

function bindStore(db: DbClient): WorkPlaneStore {
  return {
    createWorkItemsFromTemplates: (input) =>
      dbCreateWorkItemsFromTemplates(db, input),
    propagateReadiness: (params) => dbPropagateReadiness(db, params),
    claimNextReady: (input) => dbClaimNextReady(db, input),
    reportLiveness: (input) => dbReportLiveness(db, input),
    recoverStaleClaims: async (params) => {
      const recovered = await dbRecoverStaleClaims(db, params);
      for (const claim of recovered) {
        if (claim.outcome === "blocked") {
          await notifyBlockedWorkItem(db, params.userId, claim.workItemId);
        }
      }
      return recovered;
    },
    completeAttempt: (input) => dbCompleteAttempt(db, input),
    blockItem: (params) => dbBlockItem(db, params),
    listWorkItemsForCase: (userId, caseId) =>
      dbListWorkItemsForCase(db, userId, caseId),
  };
}

export interface WorkPlaneCronTenantResult {
  userId: string;
  cases: number;
  durableRuns: number;
  tick: WorkPlaneTickResult;
}

export interface WorkPlaneCronSummary {
  enabledTenants: number;
  tenants: WorkPlaneCronTenantResult[];
  errors: Array<{ userId: string; message: string }>;
}

/**
 * Un pass por invocación del cron: por tenant habilitado, resuelve los casos
 * pinneados con templates en su grafo y corre un tick acotado del dispatcher.
 * Cualquier error por tenant se reporta sin romper el resto del pass (ni el
 * response del cron v1).
 */
export async function runWorkPlaneCronPass(
  db: DbClient,
  opts: {
    leaseMs?: number;
    maxItemsPerTenant?: number;
    /** Identidad del runner (el soak 2.6 corre dos passes concurrentes). */
    runnerRef?: string;
    /** Backoff de reintentos; el soak lo baja a 0 para drenar rápido. */
    retryBackoffMs?: (attemptCount: number) => number;
    /** Scope diagnóstico/E2E; omitidos en cron para procesar todo lo habilitado. */
    onlyUserId?: string;
    onlyCaseId?: string;
  } = {}
): Promise<WorkPlaneCronSummary> {
  const summary: WorkPlaneCronSummary = {
    enabledTenants: 0,
    tenants: [],
    errors: [],
  };

  let tenants: string[] = [];
  try {
    const caseTenants = await listWorkPlaneV2Tenants(db);
    let durableTenants: string[] = [];
    try {
      durableTenants = await listDurableWorkTenants(db);
    } catch {
      // Despliegue entre 00073 y 00074: no interrumpir el plano de casos.
    }
    tenants = [...new Set([...caseTenants, ...durableTenants])];
    if (opts.onlyUserId) {
      tenants = tenants.filter((userId) => userId === opts.onlyUserId);
    }
  } catch (error) {
    summary.errors.push({
      userId: "*",
      message: (error as Error)?.message ?? "failed to list tenants",
    });
    return summary;
  }
  summary.enabledTenants = tenants.length;
  if (tenants.length === 0) return summary;

  // Las definiciones publicadas son inmutables; cache por pass.
  const loadDefinition = createWorkflowDefinitionLoader((id, version) =>
    getPublishedDefinition(db, id, version)
  );

  // Snapshot capability → execution_mode por tenant (perfil = fuente de
  // verdad del mecanismo; la resolución del dispatcher es síncrona). Un
  // fallo de carga deja el mapa vacío: los items sin convención humana
  // bloquean explícito en vez de adivinar ejecutor.
  const executionModes = new Map<
    string,
    Map<string, WorkerProfile["execution_mode"]>
  >();
  for (const userId of tenants) {
    const byCapability = new Map<string, WorkerProfile["execution_mode"]>();
    try {
      for (const profile of await listWorkerProfilesForUser(db, userId)) {
        for (const capability of profile.capabilities) {
          // Preferencia tenant > global cuando dos perfiles declaran la
          // misma capability (mismo criterio que resolveWorkerProfileForCapability).
          if (!byCapability.has(capability) || profile.user_id !== null) {
            byCapability.set(capability, profile.execution_mode);
          }
        }
      }
    } catch (error) {
      summary.errors.push({
        userId,
        message: `worker_profiles snapshot failed: ${(error as Error)?.message ?? "unknown"}`,
      });
    }
    executionModes.set(userId, byCapability);
  }

  const dispatcher = createWorkDispatcher({
    store: bindStore(db),
    resolveExecutor: createWorkPlaneExecutorResolver(db, {
      executionModeFor: (userId, capability) =>
        executionModes.get(userId)?.get(capability) ?? null,
    }),
    // 3.4-5: scopes del worker profile se hacen valer en la selección.
    enforceScopes: createWorkerScopeEnforcement(db),
    retryBackoffMs: opts.retryBackoffMs,
  });
  const runnerRef =
    opts.runnerRef ?? `ops-cron-work-plane:${Date.now()}`;

  for (const userId of tenants) {
    try {
      const allPinnedCases = await listPinnedActiveOperationalCases(db, userId);
      const pinnedCases = opts.onlyCaseId
        ? allPinnedCases.filter((opCase) => opCase.id === opts.onlyCaseId)
        : allPinnedCases;
      const dispatchables: DispatchableCase[] = [];
      for (const opCase of pinnedCases) {
        if (
          !opCase.workflow_definition_id ||
          !opCase.workflow_definition_version ||
          !opCase.current_step
        ) {
          continue;
        }
        const definition = await loadDefinition(
          opCase.workflow_definition_id,
          opCase.workflow_definition_version
        );
        if (!definition) continue;
        const graph = definition.graph_jsonb as WorkflowGraph;
        if (!graph.work_templates || graph.work_templates.length === 0) {
          continue;
        }
        dispatchables.push({
          caseId: opCase.id,
          currentState: opCase.current_step,
          workflowDefinitionVersion: opCase.workflow_definition_version,
          graph,
        });
      }

      // El tick corre aunque no haya dispatchables: recovery y readiness
      // deben atender items residuales (running/ready) de pasadas previas.
      const tick = await dispatcher.runTick({
        userId,
        runnerRef,
        cases: dispatchables,
        leaseMs: opts.leaseMs,
        maxItems: opts.maxItemsPerTenant,
        advanceCase: async (params) => {
          const fresh = await getOperationalCase(db, params.caseId);
          if (!fresh || fresh.user_id !== params.userId) return false;
          if (fresh.current_step !== params.fromState) return false;
          const updated = await advisedWorkPlaneCaseUpdate(
            db,
            fresh,
            fresh.version,
            { currentStep: params.toState }
          );
          return Boolean(updated);
        },
      });
      for (const processed of tick.processed) {
        if (processed.outcome === "blocked") {
          await notifyBlockedWorkItem(db, userId, processed.workItemId);
        }
      }
      const activeRuns = await listActiveWorkRunsForUser(db, userId);
      for (const run of activeRuns) {
        const items = await listWorkItemsForRun(db, userId, run.id);
        if (items.length === 0) continue;
        if (run.status === "pending") {
          await updateWorkRun(db, {
            userId,
            workRunId: run.id,
            status: "running",
            startedAt: run.started_at ?? new Date().toISOString(),
          });
        }
        if (!items.every((item) => item.status === "done")) continue;
        const resultJsonb = {
          work_run_id: run.id,
          completed_at: new Date().toISOString(),
          outputs: Object.fromEntries(
            items.map((item) => [item.work_type, item.result_jsonb ?? {}])
          ),
        };
        await updateWorkRun(db, {
          userId,
          workRunId: run.id,
          status: "succeeded",
          result: resultJsonb,
          finishedAt: new Date().toISOString(),
        });
        const task = await getDurableTask(db, userId, run.durable_task_id);
        if (task) {
          await updateDurableTask(db, {
            userId,
            taskId: task.id,
            expectedVersion: task.version,
            status: task.schedule_ref ? "active" : "completed",
            result: resultJsonb,
          });
        }
      }
      summary.tenants.push({
        userId,
        cases: dispatchables.length,
        durableRuns: activeRuns.length,
        tick,
      });
    } catch (error) {
      summary.errors.push({
        userId,
        message: (error as Error)?.message ?? "unknown",
      });
    }
  }

  return summary;
}
