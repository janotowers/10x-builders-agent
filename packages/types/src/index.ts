export type Channel = "web" | "telegram" | "cron";

export type ToolRisk = "low" | "medium" | "high";

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

/**
 * Configuración del Heartbeat (V2). Por ahora reservado: el agente lo lee
 * pero no lo usa — el ciclo Heartbeat aún no está cableado.
 */
export interface BusinessBrainHeartbeat {
  enabled?: boolean;
  /** Cron expr (5 campos) o intervalo en minutos. */
  cron_expr?: string;
  /** Markdown plano con el checklist por-tenant que el Heartbeat ejecutará. */
  checklist_md?: string;
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
  identity?: BusinessBrainIdentity;
  bigquery?: BusinessBrainBigQuery;
  heartbeat?: BusinessBrainHeartbeat;
  /** Bolsa libre para slots futuros (`context`, `operating_rules`, etc.). */
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

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface AgentMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  structured_payload?: Record<string, unknown>;
  created_at: string;
}

export interface ToolCall {
  id: string;
  session_id: string;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  status: "pending_confirmation" | "approved" | "rejected" | "executed" | "failed";
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string;
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

export interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
  /** LangGraph checkpoint thread ID needed to resume the interrupted graph. */
  checkpointThreadId: string;
}
