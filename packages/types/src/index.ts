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

export interface BusinessBrainEffectiveSoul {
  /** Instrucción compacta y coherente usada en runtime para estilo. */
  summary?: string;
  /** Origen principal de la síntesis aplicada. */
  source?: "default" | "user" | "mixed";
  /** Advertencias no bloqueantes detectadas al armonizar campos. */
  warnings?: string[];
  /** Timestamp ISO de la última generación/aprobación. */
  generated_at?: string;
  /** Modelo usado para generar la versión efectiva, si aplica. */
  model_id?: string;
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
  /** V1 nueva: síntesis coherente para runtime de voz/tono/estilo/brevedad. */
  soul_effective?: BusinessBrainEffectiveSoul;
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

export type OperationalCaseTestRunLevel = "n3" | "n4";

export type OperationalCaseTestRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export interface OperationalCaseTestRun {
  id: string;
  user_id: string;
  case_id: string;
  case_type_id: string;
  level: OperationalCaseTestRunLevel;
  status: OperationalCaseTestRunStatus;
  step_key?: string | null;
  skill_slug?: string | null;
  scenario_id?: string | null;
  root_skill_slug?: string | null;
  turn_id?: string | null;
  request_jsonb: Record<string, unknown>;
  result_jsonb: Record<string, unknown>;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * Sentinel `chat_id` para N3/N4 del laboratorio cuando el intake no trae Telegram real.
 * El adapter no llama a la API de Telegram con este id.
 */
export const SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID = 900_000_000_001;

/** Who triggered a tool_call row (lab, prod agent, chat, etc.). */
export type ToolCallSource =
  | "chat"
  | "telegram"
  | "cron"
  | "heartbeat"
  | "case_runner"
  | "agent_e2e"
  | "step_test"
  | "skill_test";

/** Operational context persisted alongside a tool_call for observability. */
export interface ToolCallMetadata {
  case_id?: string;
  operational_step_key?: string;
  skill_slug?: string;
  source?: ToolCallSource;
  channel?: Channel;
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
  /** Case/step/skill/channel context for lab observability and prod audit. */
  metadata_jsonb?: ToolCallMetadata | null;
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
  asset_profile?: {
    /**
     * Assets persistentes de cuenta que la tool necesita para operar
     * (plantillas, watermarks, logos). El flow puede sobrescribir labels/keys.
     */
    account?: OperationalCaseRequiredAsset[];
    /**
     * Assets temporales usados sólo por la prueba individual de Settings.
     * Permite inferir UI/readiness/run-tool sin hardcodear cada caso.
     */
    test?: OperationalCaseRequiredAsset[];
  };
}

// ============================================================
// Operational cases (subsistema de casos operacionales)
// Ver docs/operational-cases/architecture.md.
// ============================================================

export type OperationalCaseStatus =
  | "active"
  | "waiting_internal"
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

export type OperationalCaseDocumentRequestTarget =
  | "internal_user"
  | "external_contact";

export type OperationalCaseExternalContactStatus =
  | "missing"
  | "pending_opt_in"
  | "verified"
  | "unreachable";

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
  /** Pin a la definición de workflow (Slice 1.1); null en casos sin definición global. */
  workflow_definition_id: string | null;
  workflow_definition_version: number | null;
  created_at: string;
  updated_at: string;
}

export type OperationalCaseConversationBindingStatus =
  | "awaiting_user"
  | "clarification_needed"
  | "resolved"
  | "expired"
  | "cancelled";

export interface OperationalCaseConversationBinding {
  id: string;
  user_id: string;
  case_id: string;
  case_type: string;
  channel: "telegram" | "web";
  chat_id: number | null;
  session_id: string | null;
  status: OperationalCaseConversationBindingStatus;
  awaiting_fields_jsonb: unknown[];
  last_agent_prompt: string | null;
  last_prompt_at: string | null;
  last_user_message_at: string | null;
  pending_message_jsonb: Record<string, unknown>;
  candidate_routes_jsonb: Array<Record<string, unknown>>;
  metadata_jsonb: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OperationalCaseE2ELabSessionStatus =
  | "active"
  | "expired"
  | "cancelled"
  | "completed";

export interface OperationalCaseE2ELabSession {
  id: string;
  user_id: string;
  case_type: string;
  case_id: string | null;
  status: OperationalCaseE2ELabSessionStatus;
  metadata_jsonb: Record<string, unknown>;
  started_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export function isSettingsOperationalTestCaseContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  return (
    context?.created_from === "case_type_settings_test" ||
    context?.test_mode === true
  );
}

export function isSettingsOperationalTestCase(opCase: {
  context_jsonb?: Record<string, unknown> | null;
}): boolean {
  return isSettingsOperationalTestCaseContext(opCase.context_jsonb);
}

export function isControlledE2EOperationalCaseContext(
  context: Record<string, unknown> | null | undefined
): boolean {
  return (
    context?.created_from === "agent_conversation" &&
    context?.e2e_controlled === true
  );
}

export function isControlledE2EOperationalCase(opCase: {
  context_jsonb?: Record<string, unknown> | null;
}): boolean {
  return isControlledE2EOperationalCaseContext(opCase.context_jsonb);
}

export function isCronSuppressedOperationalCase(opCase: {
  context_jsonb?: Record<string, unknown> | null;
}): boolean {
  return (
    isSettingsOperationalTestCase(opCase) ||
    isControlledE2EOperationalCase(opCase)
  );
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function operationalCaseDocumentRequestTargetFromContext(
  context: Record<string, unknown> | null | undefined
): OperationalCaseDocumentRequestTarget | null {
  if (!context) return null;
  const raw = context.document_request_target;
  if (raw === "internal_user" || raw === "external_contact") return raw;
  return null;
}

export function hasOperationalCaseVerifiedExternalContact(params: {
  externalContact?: OperationalCaseExternalContact | null;
  context?: Record<string, unknown> | null;
}): boolean {
  const external = params.externalContact ?? {};
  const context = params.context ?? {};
  if (
    (context.external_contact_status === "verified" ||
      context.external_contact_status === true) &&
    (external.channel || positiveNumberOrNull(external.chat_id))
  ) {
    return true;
  }
  if (positiveNumberOrNull(external.chat_id)) return true;
  if (external.channel === "whatsapp") {
    const identifier =
      typeof external.identifier === "string" ? external.identifier.trim() : "";
    if (identifier.length >= 8) return true;
  }
  return false;
}

export function resolveOperationalCaseDocumentRequestTarget(params: {
  externalContact?: OperationalCaseExternalContact | null;
  context?: Record<string, unknown> | null;
}): OperationalCaseDocumentRequestTarget {
  const explicit = operationalCaseDocumentRequestTargetFromContext(params.context);
  if (explicit) return explicit;
  return hasOperationalCaseVerifiedExternalContact(params)
    ? "external_contact"
    : "internal_user";
}

export interface OperationalCaseEvent {
  id: string;
  case_id: string;
  event_type: OperationalCaseEventType;
  actor: OperationalCaseEventActor;
  payload_jsonb: Record<string, unknown>;
  created_at: string;
}

export type OperationalCaseDocumentSource =
  | "external_telegram"
  | "advisor_web"
  | "advisor_telegram"
  | "settings_test"
  | "unknown";

export type OperationalCaseDocumentStatus =
  | "received"
  | "superseded"
  | "rejected";

export type OperationalCaseDocumentExtractionStatus =
  | "pending"
  | "ok"
  | "low_confidence"
  | "failed"
  | "not_applicable";

export interface OperationalCaseDocument {
  id: string;
  case_id: string;
  user_id: string;
  kind: string;
  display_name: string | null;
  storage_bucket: string;
  storage_path: string;
  original_name: string | null;
  content_type: string | null;
  file_size_bytes: number | null;
  sha256: string | null;
  source: OperationalCaseDocumentSource;
  source_metadata_jsonb: Record<string, unknown>;
  blocking: boolean;
  status: OperationalCaseDocumentStatus;
  extraction_status: OperationalCaseDocumentExtractionStatus;
  extraction_model: string | null;
  extraction_jsonb: Record<string, unknown>;
  extracted_at: string | null;
  created_at: string;
  updated_at: string;
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
  | "select"
  | "multi_select";

export interface OperationalCaseIntakeOption {
  value: string;
  label?: string;
}

export interface OperationalCaseIntakeField {
  name: string;
  label: string;
  type: OperationalCaseIntakeFieldType;
  required?: boolean;
  placeholder?: string;
  help_text?: string;
  options?: Array<string | OperationalCaseIntakeOption>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface OperationalCaseFlowTool {
  tool_id: string;
  tool_label?: string;
  tool_description?: string;
  required_assets?: OperationalCaseRequiredAsset[];
  /**
   * Archivos temporales/de prueba necesarios para probar una tool en Settings.
   * A diferencia de required_assets, no son configuración reusable de cuenta.
   */
  test_assets?: OperationalCaseRequiredAsset[];
  /**
   * Mapping declarativo opcional para la prueba individual de tools en
   * modo "Datos del caso". Si está presente, el backend usa este mapping
   * en vez del recipe genérico para derivar args desde `context_jsonb`.
   */
  test_inputs_mapping?: Record<string, string>;
}

export interface OperationalCaseRequiredAsset {
  asset_key: string;
  label: string;
  description?: string;
  accept?: string[];
  max_size_mb?: number;
  required?: boolean;
  /**
   * Nombre del argumento de la tool que debe recibir este asset o colección
   * al ejecutar una prueba individual (ej. input_paths, image_paths).
   */
  param?: string;
  /**
   * Mínimo/máximo de archivos permitidos para este requisito. Defaults:
   * min=1 si required !== false, max=1.
   */
  min_count?: number;
  max_count?: number;
  /** Marca explícita para UI/readiness cuando max_count no basta para inferir colección. */
  collection?: boolean;
}

export interface OperationalCaseFlowSkill {
  skill_slug: string;
  skill_label?: string;
  skill_description?: string;
  skill_tools?: OperationalCaseFlowTool[];
}

/**
 * Rama de una decisión de paso (`PATTERN_STEP_BRANCH_DECISION`).
 * Metadata **explicativa** para UI/QA: el agent graph NO la lee para ramificar.
 */
export interface OperationalCaseFlowStepDecisionBranch {
  /** Valor estable; debe coincidir con el valor persistido en contexto cuando aplique. */
  value: string;
  label: string;
  description?: string;
  /** Status típico mientras la rama está activa (informativo). */
  expected_status?: OperationalCaseStatus;
  /** Tools primarias de esta rama (subset de skill_tools / step_tools). */
  primary_tool_ids?: string[];
  /** IDs de escenarios N4 milestone que cubren esta rama. */
  scenario_ids?: string[];
}

/**
 * Decisión de rama dentro de un `step_key` (mismo artefacto, distinto
 * responsable/espera). Solo documentación + UI + enlace a escenarios.
 * Nunca leída por el agent graph para elegir tools.
 */
export interface OperationalCaseFlowStepDecision {
  /** ID estable de la decisión dentro del paso (ej. document_request_target). */
  id: string;
  label: string;
  description?: string;
  /**
   * Clave en context_jsonb donde vive el valor elegido.
   * Informativo: el runtime ya conoce esta clave en código.
   */
  context_key?: string;
  /** Cómo se decide hoy (copy para autores). */
  decided_by_hint?: string;
  branches: OperationalCaseFlowStepDecisionBranch[];
  /** Tools del hito que aplican a todas las ramas. */
  shared_tool_ids?: string[];
}

// Mapping declarativo opcional para la prueba individual de tools desde
// "Datos del caso": describe cómo derivar args de la tool a partir de
// claves del `context_jsonb` del caso de prueba. Si está presente, se usa
// en vez del recipe genérico hardcodeado por tool en el backend.
// Soporta dos formas: alias 1:1 ("tool_arg": "context_key") y derivaciones
// con marcadores simples (ej. "min_price": "{{ target_price * 0.8 }}")
// que el backend interpreta best-effort.

export interface OperationalCaseFlowStep {
  step_key: string;
  step_label: string;
  step_description?: string;
  step_skills?: OperationalCaseFlowSkill[];
  step_tools?: OperationalCaseFlowTool[];
  /**
   * Opcional. Metadata explicativa de ramas (`PATTERN_STEP_BRANCH_DECISION`).
   * No es motor de ejecución: el runtime ramifica por código + context_jsonb.
   */
  step_decision?: OperationalCaseFlowStepDecision;
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
  /**
   * SHA-256 hex del contenido vigente (Slice 3.1). La historia inmutable por
   * reemplazo vive en account_asset_versions. Null: filas previas al backfill
   * o upserts sin bytes disponibles para hashear.
   */
  content_hash: string | null;
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

export interface EngagementDeliveryWindow {
  /**
   * Days in local timezone where delivery is allowed.
   * Sunday=0 ... Saturday=6.
   */
  days_of_week?: number[];
  /** Local start time (HH:mm), inclusive. */
  start_time?: string;
  /** Local end time (HH:mm), exclusive. */
  end_time?: string;
  /**
   * Optional explicit timezone for this policy. Falls back to profile.timezone.
   */
  timezone?: string;
}

/**
 * Canonical human-involvement taxonomy (Technical Plan §3.1). Prefer this
 * umbrella over an undifferentiated “HITL” label when configuring delivery.
 */
export type HumanInvolvementKind =
  | "action_authorization"
  | "business_decision"
  | "human_contribution"
  | "exception_intervention";

export interface EngagementPolicyOverride {
  default_due_after_hours?: number;
  reminder_cooldown_hours?: number;
  max_attempts?: number;
  max_reminder_attempts?: number;
  escalate_after_hours?: number;
  escalation_priority?: "high";
  respect_working_hours?: boolean;
  delivery_window?: EngagementDeliveryWindow;
  /**
   * For human_contribution upload batches: minutes after the last file before
   * the first “confirm with listo” nudge. Hours-based cooldown still applies
   * between subsequent reminders.
   */
  nudge_after_upload_minutes?: number;
}

export interface EngagementPolicyOverrides {
  by_audience?: Partial<
    Record<
      "internal_user" | "external_prospect" | "external_owner" | "external_contact",
      EngagementPolicyOverride
    >
  >;
  /** Overrides keyed by HumanInvolvementKind (A/B/C/D). Lost to by_kind. */
  by_involvement?: Partial<Record<HumanInvolvementKind, EngagementPolicyOverride>>;
  by_kind?: Record<string, EngagementPolicyOverride>;
}

export interface UserNotificationPreferences {
  user_id: string;
  channels_priority_jsonb: NotificationChannel[];
  case_reminder_overrides_jsonb: {
    by_case_type?: Record<string, OperationalCaseReminderPolicy>;
    by_case_id?: Record<string, OperationalCaseReminderPolicy>;
  };
  engagement_policy_overrides_jsonb?: EngagementPolicyOverrides;
  created_at: string;
  updated_at: string;
}

export type InternalUserNotificationStatus =
  | "unread"
  | "read"
  | "actioned"
  | "dismissed";

export type NotificationPriority = "low" | "normal" | "high";

export interface InternalUserNotification {
  id: string;
  user_id: string;
  case_id: string | null;
  kind: string;
  title: string;
  body: string;
  status: InternalUserNotificationStatus;
  priority: NotificationPriority;
  action_url: string | null;
  due_at: string | null;
  delivered_channels_jsonb: Record<string, unknown>;
  metadata_jsonb: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  actioned_at: string | null;
  updated_at: string;
}

export type ExternalContactNotificationStatus =
  | "pending"
  | "sent"
  | "responded"
  | "failed"
  | "expired"
  | "cancelled";

export interface ExternalContactNotification {
  id: string;
  user_id: string;
  case_id: string;
  contact_jsonb: OperationalCaseExternalContact & Record<string, unknown>;
  channel: Exclude<NotificationChannel, "web">;
  recipient_identifier: string;
  message_body: string;
  status: ExternalContactNotificationStatus;
  attempt_count: number;
  max_attempts: number;
  last_sent_at: string | null;
  next_reminder_at: string | null;
  responded_at: string | null;
  metadata_jsonb: Record<string, unknown>;
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

export {
  normalizeTelegramSendText,
  telegramSendInputsMatch,
} from "./telegram-send-dedup";
export {
  generatedDocumentDedupKey,
  generatedDocumentInputsMatch,
  normalizeGeneratedDocumentArgs,
  type GeneratedDocumentDedupOptions,
} from "./generated-document-dedup";
export * from "./ai-usage";
export * from "./workflow-definitions";
export * from "./work-items";
export * from "./impact";
export * from "./durable-tasks";
export * from "./studio-qualification";
export * from "./attachments";
export * from "./organizations";
export * from "./case-relationships";
