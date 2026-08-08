/**
 * Work dispatcher (flexible-workflows plan, Slice 2.3; Technical Plan §8/§20).
 *
 * Implementa el `WorkDispatcher` de §20 sobre un store inyectado (mismo
 * patrón que `load.ts`): este paquete no depende de la base de datos; el
 * caller (apps/web) enlaza las queries de @agents/db a un service client y
 * las pasa aquí. Eso preserva la regla de paridad (convención 7): producción,
 * lab y selftests ejecutan exactamente este objeto.
 *
 * Responsabilidades del tick (§8.2): recover stale claims → instanciar
 * templates del estado actual (idempotente) → propagar readiness → claim y
 * despacho en batch acotado por prioridad → verificación mínima → completion.
 *
 * Avance del caso (§8.4): la finalización de trabajo NUNCA escribe
 * `current_step`; cuando el predicate se satisface, el dispatcher invoca el
 * callback `advanceCase` — el ÚNICO call site — que el caller cablea al
 * wrapper advised (evaluator-autorizado) de apps/web.
 *
 * Contención de claims perdidos (2.3-6): el loop de renovación corre mientras
 * el ejecutor trabaja. Una pérdida confirmada (`attempt_not_running`) aborta
 * de inmediato; errores transitorios consecutivos abortan cuando su ventana
 * combinada cubre un lease TTL completo (`ceil(leaseMs / renewIntervalMs)`
 * fallos ⇒ el lease entero transcurrió sin una renovación exitosa, así que el
 * claim es irrecuperablemente incierto). El umbral se deriva del TTL y del
 * intervalo — no es una constante heredada de QM.
 *
 * Terminología: nunca "heartbeat" para vitalidad de claims (regla 4).
 * `origin` jamás participa en decisiones de despacho (finding 17).
 */
import { z } from "zod";
import type {
  WorkItem,
  WorkItemAttempt,
  WorkItemStatus,
  WorkItemTemplateSpec,
  WorkflowGraph,
  WorkflowGraphWorkTemplate,
} from "@agents/types";

// ============================================================
// Contratos del store (estructurales; los implementa @agents/db)
// ============================================================

export interface ClaimedWork {
  item: WorkItem;
  attempt: WorkItemAttempt;
}

export interface StoreCompleteAttemptInput {
  userId: string;
  attemptId: string;
  outcome: "succeeded" | "failed";
  resultJsonb?: Record<string, unknown>;
  errorJsonb?: Record<string, unknown>;
  evidenceJsonb?: Record<string, unknown>;
  itemStatusOnSuccess?: "done" | "review";
  retryNotBefore?: string;
}

export type StoreCompleteAttemptResult =
  | { ok: true; item: WorkItem; itemStatus: WorkItemStatus }
  | { ok: false; reason: string };

export interface WorkPlaneStore {
  createWorkItemsFromTemplates(input: {
    userId: string;
    caseId: string;
    workflowDefinitionVersion: number;
    templates: WorkItemTemplateSpec[];
    onEnterState?: string;
  }): Promise<{ created: WorkItem[]; existing: WorkItem[] }>;
  propagateReadiness(params: {
    userId: string;
    caseId?: string;
  }): Promise<{ readyIds: string[] }>;
  claimNextReady(input: {
    userId: string;
    runnerRef: string;
    /** String fijo o resolver por item (el candidato se conoce en el loop). */
    executorKind: string | ((item: WorkItem) => string);
    leaseMs: number;
    caseId?: string;
  }): Promise<ClaimedWork | null>;
  reportLiveness(input: {
    userId: string;
    attemptId: string;
    renewLeaseMs?: number;
  }): Promise<{ ok: boolean; renewed: boolean; reason?: string }>;
  recoverStaleClaims(params: {
    userId: string;
  }): Promise<Array<{ attemptId: string; workItemId: string; outcome: string }>>;
  completeAttempt(
    input: StoreCompleteAttemptInput
  ): Promise<StoreCompleteAttemptResult>;
  blockItem(params: {
    userId: string;
    itemId: string;
    reason: string;
  }): Promise<unknown>;
  listWorkItemsForCase(userId: string, caseId: string): Promise<WorkItem[]>;
}

// ============================================================
// Ejecutores (§20 ExecutorAdapter; adapters concretos en Slice 2.4)
// ============================================================

export interface ExecutorReport {
  outcome: "succeeded" | "failed";
  /** El reporte es un claim, no verdad (regla 5); la verificación decide. */
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  /** true ⇒ el item queda en `review` (modo human) en vez de `done`. */
  requiresHumanReview?: boolean;
}

export interface ExecutorContext {
  userId: string;
  work: ClaimedWork;
  /**
   * Señal de cancelación (2.3-6): se dispara cuando el dispatcher confirma la
   * pérdida del claim o agota la ventana de renovaciones. Ejecutores largos
   * deben observarla y abortar su trabajo.
   */
  signal: AbortSignal;
  /** Progreso explícito del ejecutor (last_progress_at es señal opcional §10). */
  reportProgress: () => Promise<void>;
}

export interface ExecutorAdapter {
  readonly executionMode: string;
  execute(ctx: ExecutorContext): Promise<ExecutorReport>;
}

// ============================================================
// Verificación mínima Phase 2 (output contract)
// ============================================================

const minimalOutputContractSchema = z
  .object({ required_keys: z.array(z.string()).optional() })
  .passthrough();

export interface OutputContractVerdict {
  ok: boolean;
  missingKeys: string[];
}

/**
 * Phase 2: chequeo mínimo del output contract — llaves requeridas presentes y
 * no nulas en el resultado reportado. Contrato vacío pasa. Los contratos
 * completos (VerificationRunner + evidencia) llegan en Fase 3.
 */
export function verifyOutputContract(
  contract: Record<string, unknown>,
  result: Record<string, unknown> | undefined
): OutputContractVerdict {
  const parsed = minimalOutputContractSchema.safeParse(contract ?? {});
  const requiredKeys = parsed.success ? parsed.data.required_keys ?? [] : [];
  if (requiredKeys.length === 0) return { ok: true, missingKeys: [] };
  const missing = requiredKeys.filter(
    (key) => result?.[key] === undefined || result?.[key] === null
  );
  return { ok: missing.length === 0, missingKeys: missing };
}

// ============================================================
// Templates → specs (finding 18: objetivo + guardrails + exit criteria)
// ============================================================

export function templateSpecsForState(
  graph: WorkflowGraph,
  state: string
): WorkItemTemplateSpec[] {
  return (graph.work_templates ?? [])
    .filter((t: WorkflowGraphWorkTemplate) => t.on_enter_state === state)
    .map((t) => ({
      work_type: t.work_type,
      required_capability: t.required_capability ?? t.work_type,
      depends_on: t.depends_on,
      verification_contract: t.verification_contract,
    }));
}

// ============================================================
// Advancement predicate (§8.4)
// ============================================================

export interface AdvancementDecision {
  satisfied: boolean;
  toState: string | null;
  reason:
    | "advance"
    | "no_templates_for_state"
    | "work_incomplete"
    | "no_runtime_transition"
    | "ambiguous_transitions";
}

/**
 * El caso puede avanzar desde `state` cuando cada template declarado
 * `on_enter_state=state` tiene su item en `done`, y existe exactamente UNA
 * transición saliente autorizada para proposer `runtime`. La ambigüedad no se
 * resuelve adivinando: se reporta y un humano/el modelo decide.
 */
export function evaluateAdvancement(
  graph: WorkflowGraph,
  state: string,
  caseItems: WorkItem[]
): AdvancementDecision {
  const templates = (graph.work_templates ?? []).filter(
    (t) => t.on_enter_state === state
  );
  if (templates.length === 0) {
    return { satisfied: false, toState: null, reason: "no_templates_for_state" };
  }
  const stateItems = caseItems.filter(
    (item) => item.idempotency_key?.startsWith(`${state}:`) ?? false
  );
  const allDone = templates.every((template) =>
    stateItems.some(
      (item) => item.work_type === template.work_type && item.status === "done"
    )
  );
  if (!allDone) {
    return { satisfied: false, toState: null, reason: "work_incomplete" };
  }
  const runtimeTransitions = (graph.transitions ?? []).filter(
    (t) => t.from === state && t.authorized_proposers.includes("runtime")
  );
  if (runtimeTransitions.length === 0) {
    return { satisfied: false, toState: null, reason: "no_runtime_transition" };
  }
  if (runtimeTransitions.length > 1) {
    return { satisfied: false, toState: null, reason: "ambiguous_transitions" };
  }
  return { satisfied: true, toState: runtimeTransitions[0].to, reason: "advance" };
}

// ============================================================
// Dispatcher
// ============================================================

export interface DispatchableCase {
  caseId: string;
  currentState: string;
  workflowDefinitionVersion: number;
  graph: WorkflowGraph;
}

export interface WorkPlaneTickInput {
  userId: string;
  runnerRef: string;
  /** Casos v2 del tenant con su grafo pinned ya resuelto. */
  cases: DispatchableCase[];
  leaseMs?: number;
  /** Batch acotado por tick (§8.2). */
  maxItems?: number;
  /**
   * ÚNICO call site de avance de caso desde el plano de trabajo (§8.4).
   * El caller lo cablea al wrapper advised (evaluator-autorizado); devuelve
   * true si el avance se aplicó.
   */
  advanceCase: (params: {
    userId: string;
    caseId: string;
    fromState: string;
    toState: string;
  }) => Promise<boolean>;
}

export interface WorkPlaneTickResult {
  recovered: number;
  instantiated: number;
  readied: number;
  processed: Array<{
    workItemId: string;
    workType: string;
    /** Null when the item hangs from a work_run (Phase 5 dual root). */
    caseId: string | null;
    outcome: "done" | "review" | "retry" | "blocked" | "completion_rejected";
  }>;
  advanced: Array<{ caseId: string; fromState: string; toState: string }>;
  errors: Array<{ scope: string; message: string }>;
}

export interface WorkDispatcherDeps {
  store: WorkPlaneStore;
  /** Resolución capability → adapter; null ⇒ blocked (no adivinar ejecutores). */
  resolveExecutor: (item: WorkItem) => ExecutorAdapter | null;
  /**
   * Enforcement de scopes del worker profile EN LA SELECCIÓN (Slice 3.4-5;
   * §9): se evalúa después de resolver el adapter y ANTES de ejecutar. Deny
   * ⇒ attempt fallido + item blocked con `blocked_reason` explícito — nunca
   * se "recorta el prompt" como sustituto de permiso.
   */
  enforceScopes?: (
    item: WorkItem,
    adapter: ExecutorAdapter
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Intervalo de renovación; default leaseMs/3 (3 oportunidades por lease). */
  renewIntervalMs?: (leaseMs: number) => number;
  /** Backoff para reintentos tras fallo; default 60s lineal por attempt. */
  retryBackoffMs?: (attemptCount: number) => number;
}

const DEFAULT_LEASE_MS = 5 * 60_000; // paridad con el lease de 5 min del cron v1
const DEFAULT_MAX_ITEMS = 10;

export function createWorkDispatcher(deps: WorkDispatcherDeps) {
  const renewIntervalFor =
    deps.renewIntervalMs ?? ((leaseMs: number) => Math.max(1_000, Math.floor(leaseMs / 3)));
  const retryBackoffFor =
    deps.retryBackoffMs ?? ((attemptCount: number) => attemptCount * 60_000);

  /**
   * Ejecuta el adapter con renovación de lease concurrente y containment
   * 2.3-6. Devuelve el reporte del ejecutor o `null` si el claim se perdió
   * (en cuyo caso NO debe intentarse completion: fail closed).
   */
  async function executeWithLiveness(
    userId: string,
    work: ClaimedWork,
    adapter: ExecutorAdapter,
    leaseMs: number
  ): Promise<ExecutorReport | null> {
    const abort = new AbortController();
    const intervalMs = renewIntervalFor(leaseMs);
    // Umbral derivado (no constante mágica): tantos fallos transitorios
    // consecutivos como renovaciones caben en un lease TTL ⇒ el lease entero
    // pasó sin renovación exitosa ⇒ el claim ya no es confiable.
    const maxConsecutiveTransientFailures = Math.max(
      1,
      Math.ceil(leaseMs / intervalMs)
    );

    let claimLost = false;
    let consecutiveFailures = 0;
    let renewTimer: ReturnType<typeof setInterval> | null = null;

    const stopRenewals = () => {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    };

    renewTimer = setInterval(() => {
      void (async () => {
        try {
          const result = await deps.store.reportLiveness({
            userId,
            attemptId: work.attempt.id,
            renewLeaseMs: leaseMs,
          });
          if (result.ok) {
            consecutiveFailures = 0;
            return;
          }
          // Pérdida confirmada (attempt ya no corre): cancelar de inmediato.
          claimLost = true;
          stopRenewals();
          abort.abort(new Error("work-plane claim lost"));
        } catch {
          consecutiveFailures += 1;
          if (consecutiveFailures >= maxConsecutiveTransientFailures) {
            claimLost = true;
            stopRenewals();
            abort.abort(new Error("work-plane lease renewal window exhausted"));
          }
        }
      })();
    }, intervalMs);

    try {
      const report = await adapter.execute({
        userId,
        work,
        signal: abort.signal,
        reportProgress: async () => {
          await deps.store.reportLiveness({
            userId,
            attemptId: work.attempt.id,
          });
        },
      });
      return claimLost ? null : report;
    } finally {
      stopRenewals();
    }
  }

  async function processClaimed(
    userId: string,
    work: ClaimedWork,
    leaseMs: number,
    result: WorkPlaneTickResult
  ): Promise<void> {
    const adapter = deps.resolveExecutor(work.item);
    if (!adapter) {
      // Gap de configuración, no fallo del ejecutor: cerrar el attempt y
      // bloquear explícito (nada desaparece en silencio — §8.5).
      await deps.store.completeAttempt({
        userId,
        attemptId: work.attempt.id,
        outcome: "failed",
        errorJsonb: { reason: "no_executor_for_capability" },
      });
      await deps.store.blockItem({
        userId,
        itemId: work.item.id,
        reason: `no_executor_for_capability:${work.item.required_capability}`,
      });
      result.processed.push({
        workItemId: work.item.id,
        workType: work.item.work_type,
        caseId: work.item.case_id,
        outcome: "blocked",
      });
      return;
    }

    if (deps.enforceScopes) {
      let scopeVerdict: { ok: true } | { ok: false; reason: string };
      try {
        scopeVerdict = await deps.enforceScopes(work.item, adapter);
      } catch (error) {
        scopeVerdict = {
          ok: false,
          reason: `scope_enforcement_error:${(error as Error)?.message ?? "unknown"}`,
        };
      }
      if (!scopeVerdict.ok) {
        await deps.store.completeAttempt({
          userId,
          attemptId: work.attempt.id,
          outcome: "failed",
          errorJsonb: { reason: "scope_enforcement_denied", detail: scopeVerdict.reason },
        });
        await deps.store.blockItem({
          userId,
          itemId: work.item.id,
          reason: scopeVerdict.reason,
        });
        result.processed.push({
          workItemId: work.item.id,
          workType: work.item.work_type,
          caseId: work.item.case_id,
          outcome: "blocked",
        });
        return;
      }
    }

    let report: ExecutorReport | null = null;
    try {
      report = await executeWithLiveness(userId, work, adapter, leaseMs);
    } catch (error) {
      report = {
        outcome: "failed",
        error: { message: (error as Error)?.message ?? "executor_threw" },
      };
    }

    if (report === null) {
      // Claim perdido durante la ejecución: fail closed — recovery ya es (o
      // será) el dueño de la historia; una completion aquí sería tardía.
      result.processed.push({
        workItemId: work.item.id,
        workType: work.item.work_type,
        caseId: work.item.case_id,
        outcome: "completion_rejected",
      });
      return;
    }

    if (report.outcome === "succeeded") {
      const verdict = verifyOutputContract(
        work.item.output_contract_jsonb,
        report.result
      );
      if (!verdict.ok) {
        report = {
          outcome: "failed",
          error: {
            reason: "output_contract_violation",
            missing_keys: verdict.missingKeys,
          },
        };
      }
    }

    if (report.outcome === "succeeded") {
      const completion = await deps.store.completeAttempt({
        userId,
        attemptId: work.attempt.id,
        outcome: "succeeded",
        resultJsonb: report.result,
        evidenceJsonb: report.evidence,
        itemStatusOnSuccess: report.requiresHumanReview ? "review" : "done",
      });
      result.processed.push({
        workItemId: work.item.id,
        workType: work.item.work_type,
        caseId: work.item.case_id,
        outcome: completion.ok
          ? completion.itemStatus === "done"
            ? "done"
            : "review"
          : "completion_rejected",
      });
      return;
    }

    const completion = await deps.store.completeAttempt({
      userId,
      attemptId: work.attempt.id,
      outcome: "failed",
      errorJsonb: report.error,
      retryNotBefore: new Date(
        Date.now() + retryBackoffFor(work.item.attempt_count)
      ).toISOString(),
    });
    result.processed.push({
      workItemId: work.item.id,
      workType: work.item.work_type,
      caseId: work.item.case_id,
      outcome: completion.ok
        ? completion.itemStatus === "blocked"
          ? "blocked"
          : "retry"
        : "completion_rejected",
    });
  }

  async function runTick(input: WorkPlaneTickInput): Promise<WorkPlaneTickResult> {
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
    const result: WorkPlaneTickResult = {
      recovered: 0,
      instantiated: 0,
      readied: 0,
      processed: [],
      advanced: [],
      errors: [],
    };
    const casesById = new Map(input.cases.map((c) => [c.caseId, c]));

    // 1. Recovery de claims stale (visible, nunca silencioso).
    try {
      const recovered = await deps.store.recoverStaleClaims({
        userId: input.userId,
      });
      result.recovered = recovered.length;
    } catch (error) {
      result.errors.push({
        scope: "recover_stale_claims",
        message: (error as Error)?.message ?? "unknown",
      });
    }

    // 2. Instanciación idempotente de templates del estado actual.
    for (const dispatchable of input.cases) {
      try {
        const specs = templateSpecsForState(
          dispatchable.graph,
          dispatchable.currentState
        );
        if (specs.length === 0) continue;
        const { created } = await deps.store.createWorkItemsFromTemplates({
          userId: input.userId,
          caseId: dispatchable.caseId,
          workflowDefinitionVersion: dispatchable.workflowDefinitionVersion,
          templates: specs,
          onEnterState: dispatchable.currentState,
        });
        result.instantiated += created.length;
      } catch (error) {
        result.errors.push({
          scope: `instantiate:${dispatchable.caseId}`,
          message: (error as Error)?.message ?? "unknown",
        });
      }
    }

    // 3. Readiness derivado de dependencias.
    try {
      const readiness = await deps.store.propagateReadiness({
        userId: input.userId,
      });
      result.readied = readiness.readyIds.length;
    } catch (error) {
      result.errors.push({
        scope: "propagate_readiness",
        message: (error as Error)?.message ?? "unknown",
      });
    }

    /**
     * Evalúa el advancement predicate del caso y, si se satisface, avanza vía
     * el callback `advanceCase` (único camino de avance §8.4), instancia los
     * templates del nuevo estado y re-propaga readiness. Devuelve true si el
     * avance se aplicó. Compartido por el sweep 3.5 y el paso 5 del claim
     * loop (finding 20: un caso cuyo último item se completó FUERA del claim
     * loop — p.ej. aprobación del operador review→done entre ticks — debe
     * poder avanzar aunque este tick no reclame ningún item suyo).
     */
    async function advanceIfSatisfied(
      dispatchable: DispatchableCase,
      scope: string
    ): Promise<boolean> {
      try {
        const caseItems = await deps.store.listWorkItemsForCase(
          input.userId,
          dispatchable.caseId
        );
        const decision = evaluateAdvancement(
          dispatchable.graph,
          dispatchable.currentState,
          caseItems
        );
        if (!decision.satisfied || !decision.toState) return false;
        const applied = await input.advanceCase({
          userId: input.userId,
          caseId: dispatchable.caseId,
          fromState: dispatchable.currentState,
          toState: decision.toState,
        });
        if (!applied) return false;
        result.advanced.push({
          caseId: dispatchable.caseId,
          fromState: dispatchable.currentState,
          toState: decision.toState,
        });
        // Instanciar de inmediato los templates del nuevo estado para que
        // el siguiente propagate/claim del mismo tick pueda continuarlos.
        const nextSpecs = templateSpecsForState(
          dispatchable.graph,
          decision.toState
        );
        if (nextSpecs.length > 0) {
          const { created } = await deps.store.createWorkItemsFromTemplates({
            userId: input.userId,
            caseId: dispatchable.caseId,
            workflowDefinitionVersion: dispatchable.workflowDefinitionVersion,
            templates: nextSpecs,
            onEnterState: decision.toState,
          });
          result.instantiated += created.length;
          await deps.store.propagateReadiness({
            userId: input.userId,
            caseId: dispatchable.caseId,
          });
        }
        dispatchable.currentState = decision.toState;
        return true;
      } catch (error) {
        result.errors.push({
          scope: `${scope}:${dispatchable.caseId}`,
          message: (error as Error)?.message ?? "unknown",
        });
        return false;
      }
    }

    // 3.5. Sweep de advancement (finding 20): atiende avances pendientes que
    // se volvieron legales entre ticks sin nuevos claims (aprobaciones del
    // operador, recovery). Idempotente y barato; el predicate decide.
    for (const dispatchable of input.cases) {
      await advanceIfSatisfied(dispatchable, "advance_sweep");
    }

    // 4. Claim → ejecutar → verificar → completar (batch acotado, prioridad).
    for (let i = 0; i < maxItems; i++) {
      let claimed: ClaimedWork | null = null;
      try {
        claimed = await deps.store.claimNextReady({
          userId: input.userId,
          runnerRef: input.runnerRef,
          executorKind: (item) =>
            deps.resolveExecutor(item)?.executionMode ?? "unresolved",
          leaseMs,
        });
      } catch (error) {
        result.errors.push({
          scope: "claim_next_ready",
          message: (error as Error)?.message ?? "unknown",
        });
        break;
      }
      if (!claimed) break;

      await processClaimed(input.userId, claimed, leaseMs, result);

      // Re-propagar readiness del caso/run: una completion puede desbloquear a
      // sus dependientes dentro del mismo tick (drena cadenas §8.3).
      // Phase 5: items under work_run tienen case_id null — propagar sin filtro.
      try {
        await deps.store.propagateReadiness({
          userId: input.userId,
          caseId: claimed.item.case_id ?? undefined,
        });
      } catch (error) {
        result.errors.push({
          scope: `propagate_after_completion:${claimed.item.case_id ?? claimed.item.work_run_id}`,
          message: (error as Error)?.message ?? "unknown",
        });
      }

      // 5. Advancement predicate (§8.4) tras cada completion del caso.
      // Items con raíz durable no avanzan operational_cases.
      if (!claimed.item.case_id) continue;
      const dispatchable = casesById.get(claimed.item.case_id);
      if (!dispatchable) continue;
      await advanceIfSatisfied(dispatchable, "advance");
    }

    return result;
  }

  return {
    runTick,
    // Passthroughs del contrato §20 (mismo objeto en producción y lab).
    propagateReadiness: deps.store.propagateReadiness,
    claimNextReady: deps.store.claimNextReady,
    reportLiveness: deps.store.reportLiveness,
    recoverStaleClaims: deps.store.recoverStaleClaims,
  };
}

export type WorkDispatcher = ReturnType<typeof createWorkDispatcher>;
