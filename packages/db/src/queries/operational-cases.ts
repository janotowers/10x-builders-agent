/**
 * Queries para el subsistema de Casos operacionales.
 * Ver docs/operational-cases/architecture.md.
 *
 * Patrones:
 *   - Locking: la versión persiste en la columna `version`. Toda escritura
 *     desde el agente debe pasar por updateOperationalCase(...) que verifica
 *     y aumenta version. Si choca, retorna null para que el caller reintente.
 *   - Eventos append-only: insertOperationalCaseEvent NUNCA actualiza ni
 *     borra; los triggers en SQL lo refuerzan.
 */
import type { DbClient } from "../client";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseEventActor,
  OperationalCaseEventType,
  OperationalCaseExternalContact,
  OperationalCaseActivationPolicy,
  OperationalCaseFlowStep,
  OperationalCaseIntakeField,
  OperationalCaseReminderPolicy,
  OperationalCaseStatus,
  OperationalCaseType,
  OperationalCaseTypeStatus,
  OperationalCaseTypeVisibility,
} from "@agents/types";

// ============================================================
// Catálogo: operational_case_types
// ============================================================

export async function listOperationalCaseTypes(
  db: DbClient
): Promise<OperationalCaseType[]> {
  const { data, error } = await db
    .from("operational_case_types")
    .select("*")
    .order("display_name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as OperationalCaseType[];
}

export async function listOperationalCaseTypesForUser(
  db: DbClient,
  userId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<OperationalCaseType[]> {
  let query = db
    .from("operational_case_types")
    .select("*")
    .or(`visibility.eq.global,user_id.eq.${userId}`)
    .order("display_name", { ascending: true });

  if (!opts.includeArchived) query = query.neq("status", "archived");

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as OperationalCaseType[];
}

/**
 * Lookup por id (UUID). Es la fuente de verdad: no es ambigua aunque dos
 * cuentas tengan el mismo slug en privado.
 */
export async function getOperationalCaseTypeById(
  db: DbClient,
  caseTypeId: string
): Promise<OperationalCaseType | null> {
  const { data, error } = await db
    .from("operational_case_types")
    .select("*")
    .eq("id", caseTypeId)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseType | null) ?? null;
}

export async function getGlobalOperationalCaseTypeBySlug(
  db: DbClient,
  caseType: string
): Promise<OperationalCaseType | null> {
  const { data, error } = await db
    .from("operational_case_types")
    .select("*")
    .eq("case_type", caseType)
    .is("user_id", null)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseType | null) ?? null;
}

/**
 * Lookup por slug, considerando ownership. Si el usuario tiene un caso de uso
 * privado con ese slug, gana sobre el global. Devuelve null si no hay match
 * visible para el usuario.
 */
export async function getOperationalCaseTypeForUser(
  db: DbClient,
  userId: string,
  caseType: string
): Promise<OperationalCaseType | null> {
  const { data, error } = await db
    .from("operational_case_types")
    .select("*")
    .eq("case_type", caseType)
    .or(`user_id.eq.${userId},user_id.is.null`);
  if (error) throw error;
  const rows = (data ?? []) as OperationalCaseType[];
  if (rows.length === 0) return null;
  return rows.find((row) => row.user_id === userId) ?? rows[0];
}

export interface UpsertOperationalCaseTypeInput {
  userId: string;
  caseType: string;
  displayName: string;
  defaultSkillSlug: string;
  description?: string | null;
  status?: OperationalCaseTypeStatus;
  visibility?: Exclude<OperationalCaseTypeVisibility, "global">;
  intakeSchema?: OperationalCaseIntakeField[];
  reminderPolicy?: OperationalCaseReminderPolicy;
  operationalFlow?: OperationalCaseFlowStep[];
  activationPolicy?: OperationalCaseActivationPolicy;
}

export async function upsertOperationalCaseTypeForUser(
  db: DbClient,
  input: UpsertOperationalCaseTypeInput
): Promise<OperationalCaseType> {
  const { data: existing, error: existingError } = await db
    .from("operational_case_types")
    .select("*")
    .eq("case_type", input.caseType)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (existingError) throw existingError;

  const now = new Date().toISOString();
  const payload = {
    user_id: input.userId,
    case_type: input.caseType,
    display_name: input.displayName,
    default_skill_slug: input.defaultSkillSlug,
    default_reminder_policy_jsonb: input.reminderPolicy ?? {},
    description: input.description ?? null,
    visibility: input.visibility ?? "private",
    status: input.status ?? "draft",
    intake_schema_jsonb: input.intakeSchema ?? [],
    operational_flow_jsonb: input.operationalFlow ?? [],
    activation_policy_jsonb: input.activationPolicy ?? {},
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await db
      .from("operational_case_types")
      .update(payload)
      .eq("id", (existing as OperationalCaseType).id)
      .select("*")
      .single();
    if (error) throw error;
    return data as OperationalCaseType;
  }

  const { data, error } = await db
    .from("operational_case_types")
    .insert({ ...payload, created_at: now })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseType;
}

// ============================================================
// Instancias: operational_cases
// ============================================================

export interface CreateOperationalCaseInput {
  userId: string;
  caseTypeId: string;
  /** Slug denormalizado, requerido por la columna cache `case_type`. */
  caseType: string;
  status?: OperationalCaseStatus;
  currentStep?: string | null;
  assignedToUserId?: string | null;
  externalContact?: OperationalCaseExternalContact;
  nextActionAt?: string | null;
  dueAt?: string | null;
  context?: Record<string, unknown>;
}

export async function createOperationalCase(
  db: DbClient,
  input: CreateOperationalCaseInput
): Promise<OperationalCase> {
  const { data, error } = await db
    .from("operational_cases")
    .insert({
      user_id: input.userId,
      case_type_id: input.caseTypeId,
      case_type: input.caseType,
      status: input.status ?? "active",
      current_step: input.currentStep ?? null,
      assigned_to_user_id: input.assignedToUserId ?? input.userId,
      external_contact_jsonb: input.externalContact ?? {},
      next_action_at: input.nextActionAt ?? new Date().toISOString(),
      due_at: input.dueAt ?? null,
      context_jsonb: input.context ?? {},
      version: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCase;
}

export async function getOperationalCase(
  db: DbClient,
  caseId: string
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCase | null) ?? null;
}

export async function listOperationalCasesForUser(
  db: DbClient,
  userId: string,
  opts: { statuses?: OperationalCaseStatus[]; limit?: number } = {}
): Promise<OperationalCase[]> {
  const statuses = opts.statuses ?? [
    "active",
    "waiting_external",
    "paused",
  ];
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .in("status", statuses)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OperationalCase[];
}

/**
 * Devuelve casos vencidos (next_action_at <= now()) en estados procesables.
 * Llamado por el cron `/api/cron/operational-cases` con service_role.
 *
 * Nota: el "lock" real lo hace markCaseProcessing más abajo, en una
 * actualización condicional `where status = ... and version = ...`.
 */
export async function getDueOperationalCases(
  db: DbClient,
  opts: { limit?: number } = {}
): Promise<OperationalCase[]> {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .in("status", ["active", "waiting_external"])
    .not("next_action_at", "is", null)
    .lte("next_action_at", now)
    .order("next_action_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OperationalCase[];
}

/**
 * Lock optimista: bumpea version y deja next_action_at en el futuro lejano
 * para que otros workers no lo levanten mientras se procesa. Devuelve true
 * si el lock se tomó (la versión coincidía); false si otro worker se
 * adelantó.
 *
 * Convención: cuando el lock se toma, next_action_at se mueve a +5 minutos
 * para que sea un "lease". Si el procesamiento crashea sin liberar, el caso
 * volverá a aparecer como vencido en 5 min.
 */
export async function markCaseProcessing(
  db: DbClient,
  caseId: string,
  expectedVersion: number,
  leaseMinutes = 5
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + leaseMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("operational_cases")
    .update({
      next_action_at: leaseUntil,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", caseId)
    .eq("version", expectedVersion)
    .select("id");
  if (error) {
    console.error("markCaseProcessing error:", error);
    return false;
  }
  return Array.isArray(data) && data.length === 1;
}

export interface UpdateOperationalCaseInput {
  status?: OperationalCaseStatus;
  currentStep?: string | null;
  externalContact?: OperationalCaseExternalContact;
  nextActionAt?: string | null;
  dueAt?: string | null;
  context?: Record<string, unknown>;
  assignedToUserId?: string | null;
}

/**
 * Actualiza el caso comprobando version (optimistic locking). Devuelve la fila
 * actualizada con la nueva version, o null si la versión esperada no coincide.
 *
 * Caller debe leer el caso, hacer su decisión basada en esa version, y pasar
 * `expectedVersion` para garantizar que nadie escribió encima en el ínterin.
 */
export async function updateOperationalCase(
  db: DbClient,
  caseId: string,
  expectedVersion: number,
  patch: UpdateOperationalCaseInput
): Promise<OperationalCase | null> {
  const update: Record<string, unknown> = {
    version: expectedVersion + 1,
    updated_at: new Date().toISOString(),
  };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.currentStep !== undefined) update.current_step = patch.currentStep;
  if (patch.externalContact !== undefined) {
    update.external_contact_jsonb = patch.externalContact;
  }
  if (patch.nextActionAt !== undefined) {
    update.next_action_at = patch.nextActionAt;
  }
  if (patch.dueAt !== undefined) update.due_at = patch.dueAt;
  if (patch.context !== undefined) update.context_jsonb = patch.context;
  if (patch.assignedToUserId !== undefined) {
    update.assigned_to_user_id = patch.assignedToUserId;
  }

  const { data, error } = await db
    .from("operational_cases")
    .update(update)
    .eq("id", caseId)
    .eq("version", expectedVersion)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCase | null) ?? null;
}

// ============================================================
// Eventos: operational_case_events (append-only)
// ============================================================

export interface InsertOperationalCaseEventInput {
  caseId: string;
  eventType: OperationalCaseEventType;
  actor: OperationalCaseEventActor;
  payload?: Record<string, unknown>;
}

export async function insertOperationalCaseEvent(
  db: DbClient,
  input: InsertOperationalCaseEventInput
): Promise<OperationalCaseEvent> {
  const { data, error } = await db
    .from("operational_case_events")
    .insert({
      case_id: input.caseId,
      event_type: input.eventType,
      actor: input.actor,
      payload_jsonb: input.payload ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseEvent;
}

export async function getRecentOperationalCaseEvents(
  db: DbClient,
  caseId: string,
  limit = 50
): Promise<OperationalCaseEvent[]> {
  const { data, error } = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw error;
  return ((data ?? []) as OperationalCaseEvent[]).reverse();
}

// ============================================================
// Helpers de policy / reminders
// ============================================================

/**
 * Resuelve el reminder policy efectivo para un caso, combinando:
 *   1. Default del case_type (operational_case_types).
 *   2. Override por usuario (user_notification_preferences.by_case_type).
 *   3. Override por instancia (user_notification_preferences.by_case_id).
 */
export function resolveReminderPolicy(
  caseTypeDefault: OperationalCaseReminderPolicy,
  userOverrides: {
    by_case_type?: Record<string, OperationalCaseReminderPolicy>;
    by_case_id?: Record<string, OperationalCaseReminderPolicy>;
  } | null,
  caseType: string,
  caseId: string
): OperationalCaseReminderPolicy {
  const byType = userOverrides?.by_case_type?.[caseType] ?? {};
  const byId = userOverrides?.by_case_id?.[caseId] ?? {};
  return {
    remind_after_h:
      byId.remind_after_h ??
      byType.remind_after_h ??
      caseTypeDefault.remind_after_h,
    escalate_after_h:
      byId.escalate_after_h ??
      byType.escalate_after_h ??
      caseTypeDefault.escalate_after_h,
  };
}

/**
 * Encuentra un caso en `waiting_external` por `chat_id` del contacto externo.
 * Busca cross-user (no por user_id) porque el dueño/lead típicamente NO es un
 * usuario de Gu OS — solo lo conocemos por su chat_id en el canal.
 *
 * Si hay múltiples (no debería, pero por defensa), devuelve el más reciente.
 */
export async function findOperationalCaseByExternalChatId(
  db: DbClient,
  channel: "telegram",
  chatId: number
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("status", "waiting_external")
    .eq("external_contact_jsonb->>channel", channel)
    .eq("external_contact_jsonb->>chat_id", String(chatId))
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("findOperationalCaseByExternalChatId error:", error);
    return null;
  }
  return (data as OperationalCase | null) ?? null;
}

/**
 * Asocia una respuesta entrante de un canal externo (típicamente Telegram)
 * con un caso pendiente. Inserta un evento `external_response` y mueve
 * `next_action_at = now()` para que el cron lo procese en el siguiente tick
 * (o inmediatamente si el caller dispara processing).
 *
 * Si no se provee `caseId`, lo busca por `(channel, chatId)` con
 * `findOperationalCaseByExternalChatId`.
 *
 * Devuelve el `case_id` despertado, o null si no hay match.
 */
export async function associateExternalResponseWithCase(
  db: DbClient,
  params: {
    /** Si se conoce el caso, pásalo para evitar la búsqueda. */
    caseId?: string;
    channel: "telegram";
    chatId: number;
    payload: Record<string, unknown>;
  }
): Promise<string | null> {
  let opCase: OperationalCase | null = null;
  if (params.caseId) {
    opCase = await getOperationalCase(db, params.caseId);
  } else {
    opCase = await findOperationalCaseByExternalChatId(
      db,
      params.channel,
      params.chatId
    );
  }
  if (!opCase) return null;

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "external_response",
    actor: "external",
    payload: params.payload,
  });

  await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: new Date().toISOString(),
  });

  return opCase.id;
}
