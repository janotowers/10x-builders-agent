/**
 * Queries del plano de trabajo (flexible-workflows plan, Slice 2.2;
 * Technical Plan §7/§8/§10).
 *
 * Patrones:
 *   - Claims viven en work_item_attempts, nunca en work_items: un item puede
 *     ser procesado por varios ejecutores a lo largo de reintentos.
 *   - Claim = insert de attempt + CAS sobre el padre (status/version). La
 *     unicidad (work_item_id, attempt_number) es el primer árbitro entre dos
 *     claimers; el CAS con version es el segundo. Nunca hay doble claim
 *     silencioso: todo queda en work_item_events.
 *   - Liveness ≠ renovación de lease: una actualización de vitalidad puede
 *     tener éxito sin renovar; la renovación emite su propio evento
 *     `claim_renewed` (Technical Plan §10 — nunca colapsar ambas).
 *   - Readiness es derivada: todo→ready se hace con un solo UPDATE guardado
 *     por status (sin bump de version — es estado derivado, no escritura
 *     competida; el CAS de claim verifica version+status por su cuenta).
 *   - Terminología: nunca "heartbeat" para vitalidad de claims (regla 4).
 *   - Dispatch/readiness/claim jamás hacen branch sobre `origin` (finding 17).
 */
import type { DbClient } from "../client";
import type {
  WorkItem,
  WorkItemAttempt,
  WorkItemEvent,
  WorkItemEventActor,
  WorkItemEventType,
  WorkItemOrigin,
  WorkItemStatus,
  WorkItemTemplateSpec,
} from "@agents/types";

const UNIQUE_VIOLATION = "23505";

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================
// Eventos: work_item_events (append-only)
// ============================================================

export interface InsertWorkItemEventInput {
  workItemId: string;
  userId: string;
  attemptId?: string | null;
  eventType: WorkItemEventType;
  actor?: WorkItemEventActor;
  payload?: Record<string, unknown>;
}

export async function insertWorkItemEvent(
  db: DbClient,
  input: InsertWorkItemEventInput
): Promise<WorkItemEvent> {
  const { data, error } = await db
    .from("work_item_events")
    .insert({
      work_item_id: input.workItemId,
      user_id: input.userId,
      attempt_id: input.attemptId ?? null,
      event_type: input.eventType,
      actor: input.actor ?? "system",
      payload_jsonb: input.payload ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as WorkItemEvent;
}

export async function listWorkItemEvents(
  db: DbClient,
  userId: string,
  workItemId: string,
  limit = 50
): Promise<WorkItemEvent[]> {
  const { data, error } = await db
    .from("work_item_events")
    .select("*")
    .eq("user_id", userId)
    .eq("work_item_id", workItemId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as WorkItemEvent[];
}

// ============================================================
// Lecturas
// ============================================================

export async function getWorkItemById(
  db: DbClient,
  userId: string,
  workItemId: string
): Promise<WorkItem | null> {
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("user_id", userId)
    .eq("id", workItemId)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkItem | null) ?? null;
}

export async function listWorkItemsForCase(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<WorkItem[]> {
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WorkItem[];
}

export async function listWorkItemsForUser(
  db: DbClient,
  userId: string,
  opts: { statuses?: WorkItemStatus[]; origin?: string; limit?: number } = {}
): Promise<WorkItem[]> {
  // Operator board (/operations/work): most recently touched first, same
  // temporal cue as Trabajo durable (updated_at desc). Dispatch/claim still
  // uses priority + created_at in claimNextReady — not this list.
  let query = db
    .from("work_items")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(opts.limit ?? 200, 500)));
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  if (opts.origin) {
    query = query.eq("origin", opts.origin);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as WorkItem[];
}

export async function getWorkItemAttemptById(
  db: DbClient,
  userId: string,
  attemptId: string
): Promise<WorkItemAttempt | null> {
  const { data, error } = await db
    .from("work_item_attempts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", attemptId)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkItemAttempt | null) ?? null;
}

/** Attempts de un work item (más reciente primero). */
export async function listWorkItemAttempts(
  db: DbClient,
  userId: string,
  workItemId: string
): Promise<WorkItemAttempt[]> {
  const { data, error } = await db
    .from("work_item_attempts")
    .select("*")
    .eq("user_id", userId)
    .eq("work_item_id", workItemId)
    .order("attempt_number", { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkItemAttempt[];
}

// ============================================================
// Instanciación desde templates (idempotente por keys)
// ============================================================

export interface CreateWorkItemsFromTemplatesInput {
  userId: string;
  caseId: string;
  workflowDefinitionVersion: number;
  templates: WorkItemTemplateSpec[];
  /**
   * Estado del caso cuya entrada dispara la instanciación; forma parte de la
   * idempotency key por defecto (`<estado>:<work_type>`) para que reentradas
   * al mismo estado no dupliquen items.
   */
  onEnterState?: string;
  /** Procedencia (finding 17). Default: definition_template. */
  origin?: WorkItemOrigin;
}

export interface CreateWorkItemsFromTemplatesResult {
  created: WorkItem[];
  /** Items que ya existían con la misma idempotency key (reentrada). */
  existing: WorkItem[];
}

function templateIdempotencyKey(
  template: WorkItemTemplateSpec,
  onEnterState?: string
): string {
  if (template.idempotency_key && template.idempotency_key.trim()) {
    return template.idempotency_key.trim();
  }
  return onEnterState
    ? `${onEnterState}:${template.work_type}`
    : template.work_type;
}

/**
 * Crea items desde templates de la definición (o del impact engine en Fase 3).
 * Idempotente: la unicidad parcial (case_id, idempotency_key) es el árbitro
 * final; una colisión 23505 se resuelve releyendo la fila existente.
 * Las dependencias declaradas por `depends_on` (work_types hermanos del mismo
 * batch) se resuelven a ids y se insertan como aristas finish_to_start.
 */
export async function createWorkItemsFromTemplates(
  db: DbClient,
  input: CreateWorkItemsFromTemplatesInput
): Promise<CreateWorkItemsFromTemplatesResult> {
  const created: WorkItem[] = [];
  const existing: WorkItem[] = [];
  const byWorkType = new Map<string, WorkItem>();
  const origin: WorkItemOrigin = input.origin ?? "definition_template";

  for (const template of input.templates) {
    const key = templateIdempotencyKey(template, input.onEnterState);

    const { data: prior, error: priorError } = await db
      .from("work_items")
      .select("*")
      .eq("user_id", input.userId)
      .eq("case_id", input.caseId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (priorError) throw priorError;
    if (prior) {
      const row = prior as WorkItem;
      existing.push(row);
      byWorkType.set(row.work_type, row);
      continue;
    }

    const { data, error } = await db
      .from("work_items")
      .insert({
        case_id: input.caseId,
        work_run_id: null,
        user_id: input.userId,
        workflow_definition_version: input.workflowDefinitionVersion,
        work_type: template.work_type,
        origin,
        status: "todo",
        priority: template.priority ?? 100,
        required_capability: template.required_capability,
        not_before: template.not_before ?? null,
        due_at: template.due_at ?? null,
        max_attempts: template.max_attempts ?? 3,
        input_contract_jsonb: template.input_contract ?? {},
        output_contract_jsonb: template.output_contract ?? {},
        verification_contract_jsonb: template.verification_contract ?? {},
        idempotency_key: key,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        // Carrera con otra instanciación: la fila ya existe; releer.
        const { data: raced, error: racedError } = await db
          .from("work_items")
          .select("*")
          .eq("user_id", input.userId)
          .eq("case_id", input.caseId)
          .eq("idempotency_key", key)
          .maybeSingle();
        if (racedError) throw racedError;
        if (raced) {
          const row = raced as WorkItem;
          existing.push(row);
          byWorkType.set(row.work_type, row);
        }
        continue;
      }
      throw error;
    }

    const row = data as WorkItem;
    created.push(row);
    byWorkType.set(row.work_type, row);

    await insertWorkItemEvent(db, {
      workItemId: row.id,
      userId: input.userId,
      eventType: "created",
      payload: {
        origin,
        work_type: row.work_type,
        on_enter_state: input.onEnterState ?? null,
        idempotency_key: key,
      },
    });
  }

  // Aristas de dependencia (solo entre miembros del batch, por work_type).
  for (const template of input.templates) {
    const dependents = template.depends_on ?? [];
    if (dependents.length === 0) continue;
    const item = byWorkType.get(template.work_type);
    if (!item) continue;
    for (const dependsOnWorkType of dependents) {
      const target = byWorkType.get(dependsOnWorkType);
      if (!target) {
        throw new Error(
          `work-item template "${template.work_type}" depends on unknown sibling "${dependsOnWorkType}"`
        );
      }
      const { error } = await db.from("work_item_dependencies").insert({
        work_item_id: item.id,
        depends_on_id: target.id,
        user_id: input.userId,
      });
      if (error && error.code !== UNIQUE_VIOLATION) throw error;
    }
  }

  return { created, existing };
}

// ============================================================
// Readiness (§8.1): derivado de dependencias, nunca a mano
// ============================================================

export interface PropagateReadinessResult {
  readyIds: string[];
}

/**
 * todo → ready cuando todas las dependencias están done y not_before pasó.
 * El cómputo lee el conjunto acotado (tenant/caso) y aplica UN update
 * condicionado por status; dos ticks concurrentes son idempotentes.
 */
export async function propagateReadiness(
  db: DbClient,
  params: { userId: string; caseId?: string }
): Promise<PropagateReadinessResult> {
  let todoQuery = db
    .from("work_items")
    .select("*")
    .eq("user_id", params.userId)
    .eq("status", "todo");
  if (params.caseId) todoQuery = todoQuery.eq("case_id", params.caseId);
  const { data: todoData, error: todoError } = await todoQuery;
  if (todoError) throw todoError;
  const todoItems = (todoData ?? []) as WorkItem[];
  if (todoItems.length === 0) return { readyIds: [] };

  const todoIds = todoItems.map((item) => item.id);
  const { data: depData, error: depError } = await db
    .from("work_item_dependencies")
    .select("*")
    .eq("user_id", params.userId)
    .in("work_item_id", todoIds);
  if (depError) throw depError;
  const deps = (depData ?? []) as Array<{
    work_item_id: string;
    depends_on_id: string;
  }>;

  const dependencyIds = [...new Set(deps.map((d) => d.depends_on_id))];
  const doneIds = new Set<string>();
  if (dependencyIds.length > 0) {
    const { data: depItems, error: depItemsError } = await db
      .from("work_items")
      .select("*")
      .eq("user_id", params.userId)
      .in("id", dependencyIds);
    if (depItemsError) throw depItemsError;
    for (const row of (depItems ?? []) as WorkItem[]) {
      if (row.status === "done") doneIds.add(row.id);
    }
  }

  const now = nowIso();
  const depsByItem = new Map<string, string[]>();
  for (const dep of deps) {
    const list = depsByItem.get(dep.work_item_id) ?? [];
    list.push(dep.depends_on_id);
    depsByItem.set(dep.work_item_id, list);
  }

  const readyIds = todoItems
    .filter((item) => {
      if (item.not_before && item.not_before > now) return false;
      const itemDeps = depsByItem.get(item.id) ?? [];
      return itemDeps.every((depId) => doneIds.has(depId));
    })
    .map((item) => item.id);

  if (readyIds.length === 0) return { readyIds: [] };

  const { data: updated, error: updateError } = await db
    .from("work_items")
    .update({ status: "ready", updated_at: now })
    .eq("user_id", params.userId)
    .eq("status", "todo")
    .in("id", readyIds)
    .select("id");
  if (updateError) throw updateError;

  const confirmedIds = ((updated ?? []) as Array<{ id: string }>).map(
    (row) => row.id
  );
  for (const id of confirmedIds) {
    await insertWorkItemEvent(db, {
      workItemId: id,
      userId: params.userId,
      eventType: "ready",
    });
  }
  return { readyIds: confirmedIds };
}

// ============================================================
// Claim (§10): insert de attempt + CAS sobre el padre
// ============================================================

export interface ClaimNextReadyInput {
  userId: string;
  /** Identidad del runner (correlación en eventos y attempt.executor_ref). */
  runnerRef: string;
  /**
   * Modo de ejecución estampado en el attempt. Acepta un resolver por item
   * porque el candidato concreto solo se conoce dentro del loop de claim
   * (el dispatcher resuelve capability → adapter por item).
   */
  executorKind: string | ((item: WorkItem) => string);
  leaseMs: number;
  caseId?: string;
  workerProfileId?: string | null;
}

export interface ClaimedWork {
  item: WorkItem;
  attempt: WorkItemAttempt;
}

export async function claimNextReady(
  db: DbClient,
  input: ClaimNextReadyInput
): Promise<ClaimedWork | null> {
  const now = nowIso();
  let readyQuery = db
    .from("work_items")
    .select("*")
    .eq("user_id", input.userId)
    .eq("status", "ready")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(20);
  if (input.caseId) readyQuery = readyQuery.eq("case_id", input.caseId);
  const { data, error } = await readyQuery;
  if (error) throw error;

  const candidates = ((data ?? []) as WorkItem[]).filter(
    (item) => !item.not_before || item.not_before <= now
  );

  for (const item of candidates) {
    const attemptNumber = item.attempt_count + 1;
    const claimExpiresAt = new Date(Date.now() + input.leaseMs).toISOString();
    const executorKind =
      typeof input.executorKind === "function"
        ? input.executorKind(item)
        : input.executorKind;

    // Árbitro 1: unicidad (work_item_id, attempt_number). Si otro claimer ya
    // insertó este attempt_number, perdimos este item — probar el siguiente.
    const { data: attemptData, error: attemptError } = await db
      .from("work_item_attempts")
      .insert({
        work_item_id: item.id,
        user_id: input.userId,
        attempt_number: attemptNumber,
        executor_kind: executorKind,
        executor_ref: input.runnerRef,
        worker_profile_id: input.workerProfileId ?? null,
        status: "running",
        claimed_at: nowIso(),
        claim_expires_at: claimExpiresAt,
      })
      .select("*")
      .single();
    if (attemptError) {
      if (attemptError.code === UNIQUE_VIOLATION) continue;
      throw attemptError;
    }
    const attempt = attemptData as WorkItemAttempt;

    // Árbitro 2: CAS sobre el padre (status + version).
    const { data: casData, error: casError } = await db
      .from("work_items")
      .update({
        status: "running",
        current_attempt_id: attempt.id,
        attempt_count: attemptNumber,
        version: item.version + 1,
        updated_at: nowIso(),
      })
      .eq("id", item.id)
      .eq("version", item.version)
      .eq("status", "ready")
      .select("*");
    if (casError) throw casError;
    const casRows = (casData ?? []) as WorkItem[];

    if (casRows.length !== 1) {
      // Perdimos el CAS: cancelar el attempt huérfano de forma visible.
      await db
        .from("work_item_attempts")
        .update({
          status: "cancelled",
          completed_at: nowIso(),
          error_jsonb: { reason: "claim_cas_lost" },
        })
        .eq("id", attempt.id)
        .eq("status", "running")
        .select("id");
      continue;
    }

    await insertWorkItemEvent(db, {
      workItemId: item.id,
      userId: input.userId,
      attemptId: attempt.id,
      eventType: "claimed",
      payload: {
        attempt_number: attemptNumber,
        executor_kind: executorKind,
        executor_ref: input.runnerRef,
        claim_expires_at: claimExpiresAt,
      },
    });

    return { item: casRows[0], attempt };
  }

  return null;
}

// ============================================================
// Liveness y renovación de lease (§10: son cosas distintas)
// ============================================================

export interface ReportLivenessInput {
  userId: string;
  attemptId: string;
  /** Si se provee, además de la vitalidad se extiende el lease. */
  renewLeaseMs?: number;
}

export interface ReportLivenessResult {
  ok: boolean;
  renewed: boolean;
  reason?: "attempt_not_running";
}

export async function reportLiveness(
  db: DbClient,
  input: ReportLivenessInput
): Promise<ReportLivenessResult> {
  const now = nowIso();
  const patch: Record<string, unknown> = { last_liveness_at: now };
  const renewing =
    typeof input.renewLeaseMs === "number" && input.renewLeaseMs > 0;
  const newExpiry = renewing
    ? new Date(Date.now() + (input.renewLeaseMs as number)).toISOString()
    : null;
  if (renewing) patch.claim_expires_at = newExpiry;

  const { data, error } = await db
    .from("work_item_attempts")
    .update(patch)
    .eq("id", input.attemptId)
    .eq("user_id", input.userId)
    .eq("status", "running")
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as WorkItemAttempt[];
  if (rows.length !== 1) {
    // El attempt ya no corre (expiró, se canceló o completó): el ejecutor
    // debe tratarlo como pérdida del claim (containment 2.3-6).
    return { ok: false, renewed: false, reason: "attempt_not_running" };
  }
  const attempt = rows[0];

  await insertWorkItemEvent(db, {
    workItemId: attempt.work_item_id,
    userId: input.userId,
    attemptId: attempt.id,
    eventType: "liveness_updated",
    payload: { last_liveness_at: now },
  });
  if (renewing) {
    await insertWorkItemEvent(db, {
      workItemId: attempt.work_item_id,
      userId: input.userId,
      attemptId: attempt.id,
      eventType: "claim_renewed",
      payload: { claim_expires_at: newExpiry },
    });
  }
  return { ok: true, renewed: renewing };
}

// ============================================================
// Stale-claim recovery (§10)
// ============================================================

export interface RecoveredClaim {
  attemptId: string;
  workItemId: string;
  /** ready = reclamable de nuevo; blocked = agotó max_attempts. */
  outcome: "ready" | "blocked";
}

/**
 * Attempts `running` con lease vencido → `claim_expired`; el padre vuelve a
 * `ready` (sin incrementar nada: el incremento ocurrió al claim) o pasa a
 * `blocked` si el claim expirado consumió el último intento permitido.
 */
export async function recoverStaleClaims(
  db: DbClient,
  params: { userId: string }
): Promise<RecoveredClaim[]> {
  const now = nowIso();
  const { data, error } = await db
    .from("work_item_attempts")
    .select("*")
    .eq("user_id", params.userId)
    .eq("status", "running")
    .lt("claim_expires_at", now);
  if (error) throw error;
  const staleAttempts = (data ?? []) as WorkItemAttempt[];
  const recovered: RecoveredClaim[] = [];

  for (const attempt of staleAttempts) {
    // Guard contra completions concurrentes: solo si sigue running.
    const { data: flipData, error: flipError } = await db
      .from("work_item_attempts")
      .update({ status: "claim_expired", completed_at: nowIso() })
      .eq("id", attempt.id)
      .eq("status", "running")
      .select("id");
    if (flipError) throw flipError;
    if (((flipData ?? []) as Array<{ id: string }>).length !== 1) continue;

    const item = await getWorkItemById(db, params.userId, attempt.work_item_id);
    if (!item || item.current_attempt_id !== attempt.id) {
      // El item ya fue reasignado/avanzado; el attempt expirado queda como
      // historia y no toca al padre.
      await insertWorkItemEvent(db, {
        workItemId: attempt.work_item_id,
        userId: params.userId,
        attemptId: attempt.id,
        eventType: "claim_expired",
        payload: { parent_touched: false },
      });
      continue;
    }

    const exhausted = item.attempt_count >= item.max_attempts;
    const patch: Record<string, unknown> = exhausted
      ? {
          status: "blocked",
          blocked_reason: "max_attempts_exhausted",
          current_attempt_id: null,
          version: item.version + 1,
          updated_at: nowIso(),
        }
      : {
          status: "ready",
          current_attempt_id: null,
          version: item.version + 1,
          updated_at: nowIso(),
        };
    const { data: parentData, error: parentError } = await db
      .from("work_items")
      .update(patch)
      .eq("id", item.id)
      .eq("version", item.version)
      .eq("status", "running")
      .select("id");
    if (parentError) throw parentError;
    if (((parentData ?? []) as Array<{ id: string }>).length !== 1) continue;

    await insertWorkItemEvent(db, {
      workItemId: item.id,
      userId: params.userId,
      attemptId: attempt.id,
      eventType: "claim_expired",
      payload: {
        attempt_number: attempt.attempt_number,
        claim_expires_at: attempt.claim_expires_at,
        outcome: exhausted ? "blocked" : "ready",
      },
    });
    if (exhausted) {
      await insertWorkItemEvent(db, {
        workItemId: item.id,
        userId: params.userId,
        attemptId: attempt.id,
        eventType: "blocked",
        payload: { blocked_reason: "max_attempts_exhausted" },
      });
    }
    recovered.push({
      attemptId: attempt.id,
      workItemId: item.id,
      outcome: exhausted ? "blocked" : "ready",
    });
  }

  return recovered;
}

// ============================================================
// Completion (fail closed cuando el claim ya no es válido — 2.3-6)
// ============================================================

export interface CompleteAttemptInput {
  userId: string;
  attemptId: string;
  outcome: "succeeded" | "failed";
  resultJsonb?: Record<string, unknown>;
  errorJsonb?: Record<string, unknown>;
  evidenceJsonb?: Record<string, unknown>;
  /**
   * Destino del item en éxito. El dispatcher decide: 'done' cuando la
   * verificación (Phase 2: zod del output contract) ya pasó; 'review' cuando
   * un humano debe revisar. Default: 'review'.
   */
  itemStatusOnSuccess?: "done" | "review";
  /** Backoff opcional para el reintento tras un fallo (not_before). */
  retryNotBefore?: string;
}

export type CompleteAttemptResult =
  | { ok: true; item: WorkItem; itemStatus: WorkItemStatus }
  | {
      ok: false;
      reason:
        | "attempt_not_found"
        | "attempt_not_running"
        | "lease_expired"
        | "claim_lost"
        | "item_version_conflict";
    };

export async function completeAttempt(
  db: DbClient,
  input: CompleteAttemptInput
): Promise<CompleteAttemptResult> {
  const attempt = await getWorkItemAttemptById(
    db,
    input.userId,
    input.attemptId
  );
  if (!attempt) return { ok: false, reason: "attempt_not_found" };
  if (attempt.status !== "running") {
    return { ok: false, reason: "attempt_not_running" };
  }
  const now = nowIso();
  if (attempt.claim_expires_at < now) {
    // Fail closed: el lease venció; recovery pudo (o va a) reasignar.
    return { ok: false, reason: "lease_expired" };
  }

  const item = await getWorkItemById(db, input.userId, attempt.work_item_id);
  if (!item || item.current_attempt_id !== attempt.id) {
    // Completion tardía tras reasignación: rechazar (2.3-6).
    return { ok: false, reason: "claim_lost" };
  }

  // Cerrar el attempt (guardado por status para carreras con recovery).
  const attemptPatch: Record<string, unknown> = {
    status: input.outcome,
    completed_at: now,
  };
  if (input.errorJsonb !== undefined) attemptPatch.error_jsonb = input.errorJsonb;
  if (input.evidenceJsonb !== undefined) {
    attemptPatch.evidence_jsonb = input.evidenceJsonb;
  }
  const { data: closedData, error: closeError } = await db
    .from("work_item_attempts")
    .update(attemptPatch)
    .eq("id", attempt.id)
    .eq("status", "running")
    .select("id");
  if (closeError) throw closeError;
  if (((closedData ?? []) as Array<{ id: string }>).length !== 1) {
    return { ok: false, reason: "attempt_not_running" };
  }

  if (input.outcome === "succeeded") {
    const target: WorkItemStatus = input.itemStatusOnSuccess ?? "review";
    const { data: doneData, error: doneError } = await db
      .from("work_items")
      .update({
        status: target,
        result_jsonb: input.resultJsonb ?? null,
        version: item.version + 1,
        updated_at: nowIso(),
      })
      .eq("id", item.id)
      .eq("version", item.version)
      .eq("status", "running")
      .select("*");
    if (doneError) throw doneError;
    const rows = (doneData ?? []) as WorkItem[];
    if (rows.length !== 1) return { ok: false, reason: "item_version_conflict" };

    await insertWorkItemEvent(db, {
      workItemId: item.id,
      userId: input.userId,
      attemptId: attempt.id,
      eventType: target === "done" ? "done" : "verified",
      payload:
        target === "done"
          ? { attempt_number: attempt.attempt_number }
          : {
              attempt_number: attempt.attempt_number,
              pending: "human_review",
            },
    });
    return { ok: true, item: rows[0], itemStatus: target };
  }

  // Fallo: reintento (ready + backoff opcional) o blocked al agotar intentos.
  const exhausted = item.attempt_count >= item.max_attempts;
  const failPatch: Record<string, unknown> = exhausted
    ? {
        status: "blocked",
        blocked_reason: "max_attempts_exhausted",
        current_attempt_id: null,
        version: item.version + 1,
        updated_at: nowIso(),
      }
    : {
        status: "ready",
        current_attempt_id: null,
        not_before: input.retryNotBefore ?? null,
        version: item.version + 1,
        updated_at: nowIso(),
      };
  const { data: failData, error: failError } = await db
    .from("work_items")
    .update(failPatch)
    .eq("id", item.id)
    .eq("version", item.version)
    .eq("status", "running")
    .select("*");
  if (failError) throw failError;
  const failRows = (failData ?? []) as WorkItem[];
  if (failRows.length !== 1) return { ok: false, reason: "item_version_conflict" };

  await insertWorkItemEvent(db, {
    workItemId: item.id,
    userId: input.userId,
    attemptId: attempt.id,
    eventType: "attempt_failed",
    payload: {
      attempt_number: attempt.attempt_number,
      error: input.errorJsonb ?? null,
      outcome: exhausted ? "blocked" : "retry",
    },
  });
  if (exhausted) {
    await insertWorkItemEvent(db, {
      workItemId: item.id,
      userId: input.userId,
      attemptId: attempt.id,
      eventType: "blocked",
      payload: { blocked_reason: "max_attempts_exhausted" },
    });
  }
  return { ok: true, item: failRows[0], itemStatus: failRows[0].status };
}

// ============================================================
// Acciones del operador (Slice 2.5: transiciones manuales explicadas)
// ============================================================

/**
 * El operador aprueba un item en `review` → `done` (evento `done`, actor
 * `user`). Única transición manual legal desde review en Phase 2.
 */
export async function approveReviewedItem(
  db: DbClient,
  params: {
    userId: string;
    itemId: string;
    /**
     * Evidencia de cómo se resolvió la revisión. Cuando falta, es la acción
     * manual genérica del tablero. Decisiones de dominio (p. ej. aprobar
     * precio) deben pasar su vínculo para no dejar una transición huérfana.
     */
    resolution?: {
      source: string;
      decision?: string;
      rationale?: string | null;
      relatedEventKind?: string;
    };
  }
): Promise<WorkItem | null> {
  const item = await getWorkItemById(db, params.userId, params.itemId);
  if (!item || item.status !== "review") return null;
  const resolvedAt = nowIso();
  const resolution = {
    source: params.resolution?.source ?? "operator_review_approval",
    decision: params.resolution?.decision ?? "approved",
    rationale: params.resolution?.rationale ?? null,
    related_event_kind: params.resolution?.relatedEventKind ?? null,
    resolved_at: resolvedAt,
    resolved_by: params.userId,
  };
  const { data, error } = await db
    .from("work_items")
    .update({
      status: "done",
      result_jsonb: {
        ...(item.result_jsonb ?? {}),
        review_resolution: resolution,
      },
      version: item.version + 1,
      updated_at: resolvedAt,
    })
    .eq("id", item.id)
    .eq("version", item.version)
    .eq("status", "review")
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as WorkItem[];
  if (rows.length !== 1) return null;
  await insertWorkItemEvent(db, {
    workItemId: item.id,
    userId: params.userId,
    eventType: "done",
    actor: "user",
    payload: { source: resolution.source, review_resolution: resolution },
  });
  return rows[0];
}

/**
 * El operador reencola un item `blocked` → `ready` (evento `ready`, actor
 * `user`). Resetea `blocked_reason`; NO toca `attempt_count` — si el bloqueo
 * fue por max_attempts, el operador está otorgando explícitamente una nueva
 * ventana y el historial de intentos queda íntegro (se amplía max_attempts
 * hasta attempt_count+1 para que el próximo claim sea legal).
 */
export async function retryBlockedItem(
  db: DbClient,
  params: { userId: string; itemId: string }
): Promise<WorkItem | null> {
  const item = await getWorkItemById(db, params.userId, params.itemId);
  if (!item || item.status !== "blocked") return null;
  const { data, error } = await db
    .from("work_items")
    .update({
      status: "ready",
      blocked_reason: null,
      max_attempts: Math.max(item.max_attempts, item.attempt_count + 1),
      version: item.version + 1,
      updated_at: nowIso(),
    })
    .eq("id", item.id)
    .eq("version", item.version)
    .eq("status", "blocked")
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as WorkItem[];
  if (rows.length !== 1) return null;
  await insertWorkItemEvent(db, {
    workItemId: item.id,
    userId: params.userId,
    eventType: "ready",
    actor: "user",
    payload: { source: "operator_retry_blocked" },
  });
  return rows[0];
}

// ============================================================
// Lecturas para la vista del operador (Slice 2.5)
// ============================================================

export interface CaseWorkSummary {
  caseId: string;
  total: number;
  blocked: number;
  /** Conteos por estado del work plane (para Control operativo → Trabajo durable). */
  byStatus: Partial<Record<WorkItemStatus, number>>;
}

/** Chip de resumen para la superficie del broker: n items + indicador blocked. */
export async function summarizeCaseWork(
  db: DbClient,
  userId: string,
  caseIds: string[]
): Promise<Map<string, CaseWorkSummary>> {
  const result = new Map<string, CaseWorkSummary>();
  if (caseIds.length === 0) return result;
  const { data, error } = await db
    .from("work_items")
    .select("case_id, status")
    .eq("user_id", userId)
    .in("case_id", caseIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ case_id: string; status: string }>) {
    const entry = result.get(row.case_id) ?? {
      caseId: row.case_id,
      total: 0,
      blocked: 0,
      byStatus: {},
    };
    entry.total += 1;
    const status = row.status as WorkItemStatus;
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
    if (status === "blocked") entry.blocked += 1;
    result.set(row.case_id, entry);
  }
  return result;
}

/** Attempts vigentes para las cues de liveness de la vista del operador. */
export async function listRunningAttemptsForUser(
  db: DbClient,
  userId: string
): Promise<WorkItemAttempt[]> {
  const { data, error } = await db
    .from("work_item_attempts")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "running");
  if (error) throw error;
  return (data ?? []) as WorkItemAttempt[];
}

// ============================================================
// Rollup de reintentos (Slice 2.3-5, cierra el TODO de 0.4-4)
// ============================================================

export interface WorkPlaneRetrySummary {
  totalItems: number;
  itemsWithRetries: number;
  blockedByMaxAttempts: number;
  attemptsByStatus: Record<string, number>;
}

/**
 * Contadores de reintentos del plano de trabajo para el dashboard 0.4.
 * Tenancy: userId requerido, o adminWide explícito (patrón 0.4-1; el caller
 * de la página ya verifica `is_ungga_admin`).
 */
export async function summarizeWorkPlaneRetries(
  db: DbClient,
  params: { userId: string } | { adminWide: true }
): Promise<WorkPlaneRetrySummary> {
  let itemsQuery = db
    .from("work_items")
    .select("id, attempt_count, status, blocked_reason");
  let attemptsQuery = db.from("work_item_attempts").select("id, status");
  if ("userId" in params) {
    itemsQuery = itemsQuery.eq("user_id", params.userId);
    attemptsQuery = attemptsQuery.eq("user_id", params.userId);
  }
  const [itemsRes, attemptsRes] = await Promise.all([itemsQuery, attemptsQuery]);
  if (itemsRes.error) throw itemsRes.error;
  if (attemptsRes.error) throw attemptsRes.error;

  const items = (itemsRes.data ?? []) as Array<{
    attempt_count: number;
    status: string;
    blocked_reason: string | null;
  }>;
  const attempts = (attemptsRes.data ?? []) as Array<{ status: string }>;

  const attemptsByStatus: Record<string, number> = {};
  for (const attempt of attempts) {
    attemptsByStatus[attempt.status] =
      (attemptsByStatus[attempt.status] ?? 0) + 1;
  }
  return {
    totalItems: items.length,
    itemsWithRetries: items.filter((i) => i.attempt_count > 1).length,
    blockedByMaxAttempts: items.filter(
      (i) => i.status === "blocked" && i.blocked_reason === "max_attempts_exhausted"
    ).length,
    attemptsByStatus,
  };
}

// ============================================================
// Bloqueo explícito
// ============================================================

export async function blockItem(
  db: DbClient,
  params: { userId: string; itemId: string; reason: string }
): Promise<WorkItem | null> {
  const item = await getWorkItemById(db, params.userId, params.itemId);
  if (!item) return null;
  const { data, error } = await db
    .from("work_items")
    .update({
      status: "blocked",
      blocked_reason: params.reason,
      version: item.version + 1,
      updated_at: nowIso(),
    })
    .eq("id", item.id)
    .eq("version", item.version)
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as WorkItem[];
  if (rows.length !== 1) return null;
  await insertWorkItemEvent(db, {
    workItemId: item.id,
    userId: params.userId,
    eventType: "blocked",
    payload: { blocked_reason: params.reason },
  });
  return rows[0];
}
