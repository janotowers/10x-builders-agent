/**
 * Queries de raíces durable (Phase 5 / Slice 5.1; Technical Plan §7.0).
 *
 * Caso = verdad comercial; durable_task = ejecución/resultado. work_items
 * cuelgan de case_id XOR work_run_id. Toda query exige `userId` (regla 3).
 * Capacidad estándar: el cron descubre tenants por work_runs activos.
 */
import type { DbClient } from "../client";
import type {
  DurableTask,
  DurableTaskInput,
  DurableTaskStatus,
  WorkItem,
  WorkItemStatus,
  WorkItemOrigin,
  WorkItemTemplateSpec,
  WorkRun,
  WorkRunStatus,
} from "@agents/types";
import { insertWorkItemEvent } from "./work-items";

const UNIQUE_VIOLATION = "23505";

/**
 * Valida el XOR de raíz de un work_item: exactamente uno de caseId /
 * workRunId debe ser non-null (y no vacío). Pure helper — usable en
 * selftests sin DB.
 */
export function assertWorkItemRootXor(params: {
  caseId: string | null | undefined;
  workRunId: string | null | undefined;
}): void {
  const hasCase =
    typeof params.caseId === "string" && params.caseId.trim() !== "";
  const hasRun =
    typeof params.workRunId === "string" && params.workRunId.trim() !== "";
  if (hasCase === hasRun) {
    throw new Error(
      `work_items root XOR violated: exactly one of case_id or work_run_id must be set (case_id=${String(params.caseId)}, work_run_id=${String(params.workRunId)})`
    );
  }
}

// ============================================================
// durable_tasks
// ============================================================

export interface CreateDurableTaskInput {
  userId: string;
  title: string;
  objective: string;
  status?: DurableTaskStatus;
  retentionPolicy?: Record<string, unknown>;
  inputContract?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  acceptanceCriteria?: unknown[];
  workTemplates?: unknown[];
  resultContract?: Record<string, unknown>;
  scheduleRef?: string | null;
  provenance?: Record<string, unknown>;
}

export async function createDurableTask(
  db: DbClient,
  input: CreateDurableTaskInput
): Promise<DurableTask> {
  const { data, error } = await db
    .from("durable_tasks")
    .insert({
      user_id: input.userId,
      title: input.title,
      objective: input.objective,
      status: input.status ?? "draft",
      retention_policy_jsonb: input.retentionPolicy ?? {},
      input_contract_jsonb: input.inputContract ?? {},
      spec_jsonb: input.spec ?? {},
      acceptance_criteria_jsonb: input.acceptanceCriteria ?? [],
      work_templates_jsonb: input.workTemplates ?? [],
      result_contract_jsonb: input.resultContract ?? {},
      schedule_ref: input.scheduleRef ?? null,
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as DurableTask;
}

export async function updateDurableTask(
  db: DbClient,
  input: {
    userId: string;
    taskId: string;
    expectedVersion: number;
    status?: DurableTaskStatus;
    result?: Record<string, unknown> | null;
    scheduleRef?: string | null;
  }
): Promise<DurableTask | null> {
  const patch: Record<string, unknown> = {
    version: input.expectedVersion + 1,
  };
  if (input.status !== undefined) patch.status = input.status;
  if (input.result !== undefined) patch.result_jsonb = input.result;
  if (input.scheduleRef !== undefined) patch.schedule_ref = input.scheduleRef;
  let query = db
    .from("durable_tasks")
    .update(patch)
    .eq("user_id", input.userId)
    .eq("id", input.taskId);
  query = query.eq("version", input.expectedVersion);
  const { data, error } = await query.select("*");
  if (error) throw error;
  const rows = (data ?? []) as DurableTask[];
  return rows.length === 1 ? rows[0] : null;
}

export async function getDurableTask(
  db: DbClient,
  userId: string,
  taskId: string
): Promise<DurableTask | null> {
  const { data, error } = await db
    .from("durable_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw error;
  return (data as DurableTask | null) ?? null;
}

export async function listDurableTasksForUser(
  db: DbClient,
  userId: string,
  opts: { statuses?: DurableTaskStatus[]; limit?: number } = {}
): Promise<DurableTask[]> {
  let query = db
    .from("durable_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  if (opts.limit != null) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DurableTask[];
}

// ============================================================
// work_runs
// ============================================================

export interface CreateWorkRunInput {
  userId: string;
  durableTaskId: string;
  status?: WorkRunStatus;
  startedAt?: string | null;
  input?: Record<string, unknown>;
  retentionExpiresAt?: string | null;
  scheduledTaskId?: string | null;
}

export async function createWorkRun(
  db: DbClient,
  input: CreateWorkRunInput
): Promise<WorkRun> {
  const { data, error } = await db
    .from("work_runs")
    .insert({
      user_id: input.userId,
      durable_task_id: input.durableTaskId,
      status: input.status ?? "pending",
      started_at: input.startedAt ?? null,
      input_jsonb: input.input ?? {},
      retention_expires_at: input.retentionExpiresAt ?? null,
      scheduled_task_id: input.scheduledTaskId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as WorkRun;
}

export async function updateWorkRun(
  db: DbClient,
  input: {
    userId: string;
    workRunId: string;
    status: WorkRunStatus;
    resultRef?: string | null;
    result?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<WorkRun | null> {
  const patch: Record<string, unknown> = { status: input.status };
  if (input.resultRef !== undefined) patch.result_ref = input.resultRef;
  if (input.result !== undefined) patch.result_jsonb = input.result;
  if (input.error !== undefined) patch.error_jsonb = input.error;
  if (input.startedAt !== undefined) patch.started_at = input.startedAt;
  if (input.finishedAt !== undefined) patch.finished_at = input.finishedAt;
  const { data, error } = await db
    .from("work_runs")
    .update(patch)
    .eq("user_id", input.userId)
    .eq("id", input.workRunId)
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as WorkRun[];
  return rows.length === 1 ? rows[0] : null;
}

export async function listActiveWorkRunsForUser(
  db: DbClient,
  userId: string
): Promise<WorkRun[]> {
  const { data, error } = await db
    .from("work_runs")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WorkRun[];
}

/** Tenants con ejecución durable pendiente; el cron los procesa sin flag. */
export async function listDurableWorkTenants(db: DbClient): Promise<string[]> {
  const { data, error } = await db
    .from("work_runs")
    .select("user_id")
    .in("status", ["pending", "running"]);
  if (error) throw error;
  return [
    ...new Set(
      (data ?? [])
        .map((row: { user_id?: unknown }) => row.user_id)
        .filter((value): value is string => typeof value === "string")
    ),
  ];
}

export async function listWorkItemsForRun(
  db: DbClient,
  userId: string,
  workRunId: string
): Promise<WorkItem[]> {
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("user_id", userId)
    .eq("work_run_id", workRunId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WorkItem[];
}

export interface WorkRunWorkSummary {
  workRunId: string;
  total: number;
  blocked: number;
  byStatus: Partial<Record<WorkItemStatus, number>>;
}

export async function summarizeWorkRuns(
  db: DbClient,
  userId: string,
  workRunIds: string[]
): Promise<Map<string, WorkRunWorkSummary>> {
  const result = new Map<string, WorkRunWorkSummary>();
  if (workRunIds.length === 0) return result;
  const { data, error } = await db
    .from("work_items")
    .select("work_run_id, status")
    .eq("user_id", userId)
    .in("work_run_id", workRunIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{
    work_run_id: string;
    status: WorkItemStatus;
  }>) {
    const entry = result.get(row.work_run_id) ?? {
      workRunId: row.work_run_id,
      total: 0,
      blocked: 0,
      byStatus: {},
    };
    entry.total += 1;
    entry.byStatus[row.status] = (entry.byStatus[row.status] ?? 0) + 1;
    if (row.status === "blocked") entry.blocked += 1;
    result.set(row.work_run_id, entry);
  }
  return result;
}

export async function createDurableTaskInput(
  db: DbClient,
  input: {
    userId: string;
    durableTaskId: string;
    workRunId?: string | null;
    inputKey: string;
    displayName: string;
    value?: unknown;
    storageBucket?: string | null;
    storagePath?: string | null;
    contentType?: string | null;
    fileSizeBytes?: number | null;
    expiresAt?: string | null;
  }
): Promise<DurableTaskInput> {
  const { data, error } = await db
    .from("durable_task_inputs")
    .insert({
      user_id: input.userId,
      durable_task_id: input.durableTaskId,
      work_run_id: input.workRunId ?? null,
      input_key: input.inputKey,
      display_name: input.displayName,
      value_jsonb: input.value ?? null,
      storage_bucket: input.storageBucket ?? null,
      storage_path: input.storagePath ?? null,
      content_type: input.contentType ?? null,
      file_size_bytes: input.fileSizeBytes ?? null,
      expires_at: input.expiresAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as DurableTaskInput;
}

export async function listDurableTaskInputs(
  db: DbClient,
  userId: string,
  durableTaskId: string,
  workRunId?: string
): Promise<DurableTaskInput[]> {
  let query = db
    .from("durable_task_inputs")
    .select("*")
    .eq("user_id", userId)
    .eq("durable_task_id", durableTaskId)
    .order("created_at", { ascending: true });
  if (workRunId) query = query.eq("work_run_id", workRunId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DurableTaskInput[];
}

export async function getWorkRun(
  db: DbClient,
  userId: string,
  workRunId: string
): Promise<WorkRun | null> {
  const { data, error } = await db
    .from("work_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("id", workRunId)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkRun | null) ?? null;
}

export async function listWorkRunsForTask(
  db: DbClient,
  userId: string,
  durableTaskId: string,
  opts: { limit?: number } = {}
): Promise<WorkRun[]> {
  let query = db
    .from("work_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("durable_task_id", durableTaskId)
    .order("created_at", { ascending: false });
  if (opts.limit != null) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as WorkRun[];
}

// ============================================================
// work_items under a work_run (case_id null)
// ============================================================

export interface CreateWorkItemsForWorkRunInput {
  userId: string;
  workRunId: string;
  workflowDefinitionVersion: number;
  templates: WorkItemTemplateSpec[];
  /** Prefijo de idempotency key por defecto (`<prefix>:<work_type>`). */
  onEnterState?: string;
  origin?: WorkItemOrigin;
}

export interface CreateWorkItemsForWorkRunResult {
  created: WorkItem[];
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
 * Instancia work_items colgando de un work_run (case_id = null).
 * Idempotente por (work_run_id, idempotency_key) — mismo patrón que
 * createWorkItemsFromTemplates para casos.
 */
export async function createWorkItemsForWorkRun(
  db: DbClient,
  input: CreateWorkItemsForWorkRunInput
): Promise<CreateWorkItemsForWorkRunResult> {
  assertWorkItemRootXor({ caseId: null, workRunId: input.workRunId });

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
      .eq("work_run_id", input.workRunId)
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
        case_id: null,
        work_run_id: input.workRunId,
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
        const { data: raced, error: racedError } = await db
          .from("work_items")
          .select("*")
          .eq("user_id", input.userId)
          .eq("work_run_id", input.workRunId)
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
        work_run_id: input.workRunId,
        on_enter_state: input.onEnterState ?? null,
        idempotency_key: key,
      },
    });
  }

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
