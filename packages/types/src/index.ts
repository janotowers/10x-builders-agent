export type Channel = "web" | "telegram" | "cron" | "heartbeat" | "case_runner";

export type ToolRisk = "low" | "medium" | "high";

export type ToolApprovalMode = "auto_execute" | "request_approval" | "deny";

/**
 * Per-automation approval policy. Keys can be either a tool id
 * (`calendar_list_events`) or a tool operation key
 * (`manage_scheduled_tasks:list`).
 */
export type ToolApprovalPolicy = Record<string, ToolApprovalMode>;

export interface Profile {
  id: string;
  name: string;
  timezone: string;
  language: string;
  agent_name: string;
  agent_system_prompt: string;
  onboarding_completed: boolean;
  /** Canonical email del usuario. Inyectado al SystemMessage cuando existe;
   *  el prompt de extracción de memoria larga lo excluye explícitamente
   *  para que no se duplique en `memories`. Nullable: puede no estar fijado. */
  email: string | null;
  /** Canonical teléfono del usuario. Misma política que `email`. */
  phone: string | null;
  /** Ruta privada en Supabase Storage para el avatar del usuario. */
  avatar_path?: string | null;
  /** URL opcional/cacheada para superficies que usen assets públicos o firmados. */
  avatar_url?: string | null;
  /**
   * V1-C-α: contenedor por-tenant del agente (JSONB en Supabase). Lo lee
   * `runAgent` y lo materializa en el bloque `[Contexto de tenant]` cuando
   * la skill activa requiere contexto multi-tenant. Forma libre por slot
   * para que evolucione sin migración: ver `BusinessBrain` para el shape
   * esperado en V1-C; las versiones futuras pueden añadir slots adicionales
   * sin romper este contrato.
   */
  business_brain: BusinessBrain;
  /**
   * V1-C-α: TRUE si el usuario es staff interno de Ungga (visibilidad
   * cross-tenant en BigQuery). Cambia el modo del bloque
   * `[Contexto de tenant]` de OBLIGATORIO → ADMIN UNGGA.
   */
  is_ungga_admin: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Identidad del tenant: a qué inmobiliaria representa este perfil. En V1
 * un `profile` = un usuario operador, así que la identidad es de su
 * organización principal.
 */
export interface BusinessBrainIdentity {
  /** ID de la organización en BigQuery (`firestore_users.organization_id`). */
  organization_id?: string;
  /** Nombre legible (e.g. "Inmobiliaria Garios"). Usado en mensajes al usuario. */
  org_name?: string;
  /** ISO 3166-1 alfa-2 (MX, US, ES…). Informativo; el patrón canónico de
   *  match mensajes↔leads es country-agnostic, así que esto NO se usa para
   *  ramificar SQL — solo para presentar al humano. */
  country?: string;
}

/** Configuración de BigQuery por tenant. Compartida en V1 (un solo
 *  proyecto GCP `ungga-full`); el shape se mantiene per-profile para que
 *  V1-D pueda overridear por inmobiliaria sin migrar. */
export interface BusinessBrainBigQuery {
  project_id?: string;
  /** Multi-region o región específica donde están los datasets. Se pasa a
   *  la API REST de BigQuery (`location`). */
  location?: string;
  /** Datasets que el agente tiene permitido consultar. `undefined` significa
   *  "sin restricción adicional"; un array vacío bloquea todo. */
  dataset_allowlist?: string[];
}

export interface BusinessBrainAgentIdentity {
  /** Nombre visible del agente. En transición puede duplicar `profiles.agent_name`. */
  name?: string;
  /** Rol corto que el usuario espera del agente. */
  role?: string;
  /** Firma visual opcional para futuras superficies de UI. */
  emoji?: string;
  /** Ruta privada en Supabase Storage para el avatar del colaborador IA. */
  avatar_path?: string;
  /** URL opcional/cacheada para superficies que usen assets públicos o firmados. */
  avatar_url?: string;
  /** Descripción breve de quién es el agente para este perfil. */
  short_description?: string;
}

export interface BusinessBrainSoul {
  /** Voz general del agente: directa, cálida, ejecutiva, etc. */
  voice?: string;
  /** Tono emocional o nivel de formalidad. */
  tone?: string;
  /** Preferencias de estilo: bullets, ejemplos, español mexicano, etc. */
  style?: string;
  /** Preferencia de longitud: breve, detallada, solo cuando haga falta, etc. */
  brevity?: string;
}

export interface BusinessBrainBusinessContext {
  /** Tipo de cuenta/negocio: inmobiliaria, personal, mixto, etc. */
  kind?: string;
  /** Mercados principales, e.g. ["MX-CDMX"]. */
  markets?: string[];
  /** Notas libres compactas sobre el negocio o contexto de trabajo. */
  notes?: string;
}

export interface BusinessBrainOperatingPreferences {
  /** Preferencias editables; no pueden sobrescribir reglas duras del sistema. */
  text?: string;
}

export interface BusinessBrainWarehouseSource
  extends BusinessBrainIdentity,
    BusinessBrainBigQuery {
  provider?: "bigquery";
}

export interface BusinessBrainDataSources {
  warehouse?: BusinessBrainWarehouseSource;
}

/**
 * Configuración del Heartbeat (V2). Por ahora reservado: el agente lo lee
 * pero no lo usa — el ciclo Heartbeat aún no está cableado.
 */
export interface BusinessBrainHeartbeat {
  enabled?: boolean;
  /** Cron expr (5 campos) o intervalo en minutos. */
  cron_expr?: string;
  /** Intervalo simple en minutos para V1-D/V2. */
  interval_minutes?: number;
  /** Markdown plano con el checklist por-tenant que el Heartbeat ejecutará. */
  checklist_md?: string;
  /** Nombre usado en el roadmap/UI; alias compatible de `checklist_md`. */
  checklist_markdown?: string;
  /** Template/propuesta usada como base del checklist activo, si aplica. */
  checklist_template_id?: string;
  /** Metadata opcional de generación/validación del checklist. */
  checklist_metadata?: {
    generated_from?: string;
    generated_at?: string;
    validation_warnings?: string[];
    detected_skills?: string[];
  };
  /** Marca de última corrida de heartbeat por perfil. */
  last_run_at?: string;
}

/**
 * Contenedor del Business Brain. Todos los slots son opcionales para que
 * un perfil recién creado (o uno que no haya configurado nada en
 * Settings) sea válido con `{}`. El consumidor debe trabajar a la
 * defensiva con `?.` y comprobar antes de usar.
 *
 * El JSONB en Supabase puede tener slots futuros que TypeScript no
 * conoce; mantenemos `[k: string]: unknown` para no perder compat
 * cuando V1-D añada `context`, `operating_rules`, etc.
 */
export interface BusinessBrain {
  /** V1 nueva: identidad del agente, separada de la identidad del negocio. */
  agent_identity?: BusinessBrainAgentIdentity;
  /** V1 nueva: persona, tono, voz y estilo. */
  soul?: BusinessBrainSoul;
  /** V1 nueva: contexto de negocio/trabajo, no reglas operativas duras. */
  business_context?: BusinessBrainBusinessContext;
  /** V1 nueva: preferencias compatibles con seguridad/tools/HITL/tenant. */
  operating_preferences?: BusinessBrainOperatingPreferences;
  /** V1 nueva: fuentes de datos por cuenta. */
  data_sources?: BusinessBrainDataSources;
  /** Legacy V1-C-α: identidad del tenant. Preferir `data_sources.warehouse`. */
  identity?: BusinessBrainIdentity;
  /** Legacy V1-C-α: config BigQuery. Preferir `data_sources.warehouse`. */
  bigquery?: BusinessBrainBigQuery;
  heartbeat?: BusinessBrainHeartbeat;
  /** Bolsa libre para slots futuros (`brand`, `review`, etc.). */
  [k: string]: unknown;
}

export interface UserIntegration {
  id: string;
  user_id: string;
  provider: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  created_at: string;
}

export interface UserToolSetting {
  id: string;
  user_id: string;
  tool_id: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
}

export interface UserSkillSetting {
  id: string;
  user_id: string;
  skill_id: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  user_id: string;
  channel: Channel;
  status: "active" | "closed";
  budget_tokens_used: number;
  budget_tokens_limit: number;
  created_at: string;
  updated_at: string;
}

export interface HeartbeatRun {
  id: string;
  user_id: string;
  session_id?: string | null;
  started_at: string;
  finished_at?: string | null;
  status: "running" | "completed" | "error";
  payload: Record<string, unknown>;
  error?: string | null;
}

export interface HeartbeatChecklistTemplateRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  markdown: string;
  status: "draft" | "validated";
  validation_warnings: string[];
  detected_skills: string[];
  source_template_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  session_id: string;
  turn_id?: string | null;
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  structured_payload?: Record<string, unknown>;
  created_at: string;
}

export interface ToolCall {
  id: string;
  session_id: string;
  turn_id?: string | null;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  status: "pending_confirmation" | "approved" | "rejected" | "executed" | "failed";
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string;
  /**
   * `agent` (default) — issued by the LLM during a turn.
   * `deterministic` — system-issued read (e.g. a Heartbeat prefetcher) that
   *   ran outside the LLM loop but should be visible to the user as part of
   *   the turn's tool history.
   */
  executor_kind?: "agent" | "deterministic";
}

export interface AppliedSkill {
  id: string;
  role: "primary" | "included";
}

export interface AppliedMemory {
  source: "short_term" | "long_term";
  /** Long-term memory type when it comes from persisted memories. */
  type?: "episodic" | "semantic" | "procedural";
  content: string;
  count?: number;
  previews?: Array<{
    role: MessageRole;
    content: string;
    created_at?: string;
  }>;
}

export interface TelegramAccount {
  id: string;
  user_id: string;
  telegram_user_id: number;
  chat_id: number;
  linked_at: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  requires_integration?: string;
  parameters_schema: Record<string, unknown>;
}

// ============================================================
// Operational cases (subsistema de casos operacionales)
// Ver docs/operational-cases/architecture.md.
// ============================================================

export type OperationalCaseStatus =
  | "active"
  | "waiting_external"
  | "paused"
  | "completed"
  | "failed";

export type OperationalCaseEventType =
  | "step_completed"
  | "reminder_sent"
  | "escalated"
  | "human_decision"
  | "external_response"
  | "state_changed"
  | "error";

export type OperationalCaseEventActor = "system" | "agent" | "user" | "external";

export interface OperationalCaseExternalContact {
  channel?: "telegram" | "whatsapp" | "email";
  chat_id?: number;
  display_name?: string;
  identifier?: string;
}

export interface OperationalCase {
  id: string;
  user_id: string;
  case_type_id: string;
  /** Slug denormalizado del caso de uso. La fuente de verdad es `case_type_id`. */
  case_type: string;
  status: OperationalCaseStatus;
  current_step: string | null;
  assigned_to_user_id: string | null;
  external_contact_jsonb: OperationalCaseExternalContact;
  next_action_at: string | null;
  due_at: string | null;
  context_jsonb: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OperationalCaseEvent {
  id: string;
  case_id: string;
  event_type: OperationalCaseEventType;
  actor: OperationalCaseEventActor;
  payload_jsonb: Record<string, unknown>;
  created_at: string;
}

export interface OperationalCaseReminderPolicy {
  /** Horas tras las cuales mandar recordatorio si seguimos en `waiting_external`. */
  remind_after_h?: number[];
  /** Horas para escalar al humano interno (no al externo). */
  escalate_after_h?: number;
}

export type OperationalCaseTypeVisibility = "global" | "private" | "shared";

export type OperationalCaseTypeStatus = "draft" | "active" | "archived";

export type OperationalCaseIntakeFieldType =
  | "text"
  | "textarea"
  | "number"
  | "select";

export interface OperationalCaseIntakeField {
  name: string;
  label: string;
  type: OperationalCaseIntakeFieldType;
  required?: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
}

export interface OperationalCaseFlowTool {
  tool_id: string;
  tool_label?: string;
  tool_description?: string;
  required_assets?: OperationalCaseRequiredAsset[];
}

export interface OperationalCaseRequiredAsset {
  asset_key: string;
  label: string;
  description?: string;
  accept?: string[];
  max_size_mb?: number;
  required?: boolean;
}

export interface OperationalCaseFlowSkill {
  skill_slug: string;
  skill_label?: string;
  skill_description?: string;
  skill_tools?: OperationalCaseFlowTool[];
}

export interface OperationalCaseFlowStep {
  step_key: string;
  step_label: string;
  step_description?: string;
  step_skills?: OperationalCaseFlowSkill[];
  step_tools?: OperationalCaseFlowTool[];
}

export interface OperationalCaseSafeTestPolicy {
  description?: string;
  run_button_label?: string;
  synthetic_data_copy?: string;
  success_copy?: string;
  timeline_note?: string;
  next_action?: string;
  start_step?: string;
  success_step?: string;
}

export interface OperationalCaseActivationChecksPolicy {
  skill_valid_copy?: string;
  readiness_ready_copy?: string;
  readiness_blocked_copy?: string;
  safe_test_success_copy?: string;
  conversational_safe_copy?: string;
  real_operation_complete_copy?: string;
  real_operation_pending_copy?: string;
  real_operation_requires_no_stubs?: boolean;
}

export interface OperationalCaseActivationPolicy {
  safe_test?: OperationalCaseSafeTestPolicy;
  activation_checks?: OperationalCaseActivationChecksPolicy;
}

export interface OperationalCaseType {
  id: string;
  case_type: string;
  user_id?: string | null;
  display_name: string;
  default_skill_slug: string;
  default_reminder_policy_jsonb: OperationalCaseReminderPolicy;
  visibility?: OperationalCaseTypeVisibility;
  status?: OperationalCaseTypeStatus;
  intake_schema_jsonb?: OperationalCaseIntakeField[];
  operational_flow_jsonb?: OperationalCaseFlowStep[];
  activation_policy_jsonb?: OperationalCaseActivationPolicy;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Account skills (V1 Opción B)
// ============================================================

export type AccountSkillStatus = "draft" | "active" | "archived";

export interface AccountSkillMetadata {
  name?: string;
  description?: string;
  scope?: "business" | "personal" | "shared";
  allowed_tools?: string[];
  includes?: string[];
  requires_tenant_context?: boolean;
  memory_extraction?: "default" | "ephemeral" | "skip";
  [k: string]: unknown;
}

export interface AccountSkill {
  id: string;
  user_id: string;
  slug: string;
  body_md: string;
  metadata_jsonb: AccountSkillMetadata;
  status: AccountSkillStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Global tool requests
// ============================================================

export type GlobalToolRequestKind =
  | "incorporate_to_catalog"
  | "enable_account_config"
  | "provide_tenant_asset";

export type GlobalToolRequestStatus =
  | "requested"
  | "in_review"
  | "in_progress"
  | "shipped"
  | "rejected";

export interface GlobalToolRequest {
  id: string;
  user_id: string;
  case_type_id: string | null;
  tool_id: string;
  request_kind: GlobalToolRequestKind;
  business_context: string | null;
  status: GlobalToolRequestStatus;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Account assets
// ============================================================

export interface AccountAsset {
  id: string;
  user_id: string;
  asset_key: string;
  display_name: string;
  description: string | null;
  storage_bucket: string;
  storage_path: string;
  content_type: string | null;
  file_size_bytes: number | null;
  source_tool_id: string | null;
  case_type_id: string | null;
  metadata_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Account tool secrets (Phase 2: per-account credenciales para tools)
// Ver migración 00024_account_tool_secrets.sql y
// packages/db/src/queries/account-tool-secrets.ts.
// ============================================================

/**
 * Estado de la conexión por cuenta a un proveedor externo (EasyBroker,
 * Ungga, etc.).
 *
 *  - `pending_test`: credencial guardada, todavía no se valida contra la API.
 *  - `active`: la última validación fue exitosa.
 *  - `invalid`: la última validación falló; revisar `last_error`.
 *  - `disconnected`: el usuario desconectó explícitamente.
 */
export type AccountToolSecretStatus =
  | "pending_test"
  | "active"
  | "invalid"
  | "disconnected";

/**
 * Vista pública (no sensible) de una credencial por cuenta. Es lo que se
 * devuelve a la UI; los secretos cifrados nunca salen del server.
 */
export interface AccountToolSecretPublic {
  id: string;
  user_id: string;
  provider: string;
  config_jsonb: Record<string, unknown>;
  status: AccountToolSecretStatus;
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// User notification preferences
// ============================================================

export type NotificationChannel = "web" | "telegram" | "email" | "whatsapp";

export interface UserNotificationPreferences {
  user_id: string;
  channels_priority_jsonb: NotificationChannel[];
  case_reminder_overrides_jsonb: {
    by_case_type?: Record<string, OperationalCaseReminderPolicy>;
    by_case_id?: Record<string, OperationalCaseReminderPolicy>;
  };
  created_at: string;
  updated_at: string;
}

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
  /** Stable id that correlates all messages/tool calls for this user request. */
  turnId?: string | null;
  /** Skills from the repo playbook system that were loaded for this turn. */
  appliedSkills?: AppliedSkill[];
  /** Memory context actually loaded for this turn. */
  memoryUsed?: AppliedMemory[];
  /** LangGraph checkpoint thread ID needed to resume the interrupted graph. */
  checkpointThreadId: string;
}
