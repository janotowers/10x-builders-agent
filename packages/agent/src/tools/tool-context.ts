import type { DbClient } from "@agents/db";
import type {
  AgentRuntimeInput,
  Channel,
  ToolApprovalPolicy,
  ToolCallSource,
  UserToolSetting,
  UserIntegration,
  UserSkillSetting,
} from "@agents/types";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  /** Correlates all tool audit rows for the current user request. */
  turnId?: string;
  enabledTools: UserToolSetting[];
  enabledSkills?: UserSkillSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  lastUserMessage?: string;
  /** IANA timezone from profile (e.g. America/Mexico_City). */
  userTimezone?: string;
  googleCalendarAccessToken?: string;
  /**
   * Set by `runAgent` (V1-B+) when the pre-graph skill selector picks an
   * active skill: the resolved skill's `allowed_tools` list. When defined
   * and non-empty, `isToolAvailable()` *intersects* the existing rules
   * with this allowlist (a tool is available only if it would otherwise
   * be available AND its id is in this list).
   *
   * When `undefined` (the common case — no skill active, or `none` was
   * returned by the selector), tool filtering falls through to today's
   * rules unchanged.
   */
  activeSkillAllowedTools?: readonly string[];
  /**
   * Slug of the currently-active skill (if any). Used by
   * `read_skill_reference` to scope its reads to the right
   * `skills/global/<slug>/references/` directory. `undefined` when no
   * skill is active for the turn.
   */
  activeSkillName?: string;
  /**
   * Ordered skill slugs that can provide references for the active turn.
   * Usually `ResolvedSkill.composedFrom`: included skills first, root last.
   * `read_skill_reference` searches the active root first, then these
   * composed skills, so specialized references can override shared ones.
   */
  activeSkillReferenceNames?: readonly string[];
  /**
   * Tenant organization id resolved from Business Brain for the active turn.
   * Used by tenant-aware tools (currently BigQuery) to enforce parameterized
   * tenant filters instead of letting the model inline this value in SQL.
   */
  tenantOrganizationId?: string;
  /** Optional BigQuery project resolved from Business Brain warehouse binding. */
  bigQueryProjectId?: string;
  /** Optional BigQuery location resolved from Business Brain warehouse binding. */
  bigQueryLocation?: string;
  /** Active operational case id when the turn is bound to a case. */
  caseId?: string | null;
  /** Current operational step when the turn is bound to a case. */
  operationalStepKey?: string | null;
  /** Provenance label stored on tool_calls.metadata_jsonb.source. */
  toolCallSource?: ToolCallSource;
  /**
   * Absolute path to the workspace root used to resolve skill references.
   * Defaults to `defaultSkillsRoot()` when omitted; tests can override.
   */
  skillsRoot?: string;
  /** Session channel ("web", "telegram", "cron", "heartbeat"). */
  channel: Channel;
  /** Optional per-tool/per-operation approval policy for automated turns. */
  toolApprovalPolicy?: ToolApprovalPolicy;
  /** Trusted, turn-scoped attachment evidence. Never contains storage paths. */
  runtimeInput?: AgentRuntimeInput;
  /**
   * Envíos Telegram ya realizados en este proceso (mismo turno).
   * Se marca al enviar (no al crear la fila de auditoría) para no bloquear
   * la primera llamada cuando hay hermanas `pending_confirmation` en paralelo.
   */
  telegramSendDedupKeys?: Set<string>;
  /**
   * Renders de documento ya iniciados o completados en este turno (misma
   * plantilla/formato/caso). Evita doble DOCX cuando el modelo repite la tool.
   */
  generateDocumentDedupKeys?: Set<string>;
  /** Promesas de render en curso por clave de dedup (mismo turno, llamadas paralelas). */
  generateDocumentInFlight?: Map<string, Promise<Record<string, unknown>>>;
  /** Resolvers del líder por clave (registrados de forma síncrona antes de cualquier await). */
  generateDocumentDeferredByKey?: Map<
    string,
    {
      promise: Promise<Record<string, unknown>>;
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: unknown) => void;
    }
  >;
}
