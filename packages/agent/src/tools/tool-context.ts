import type { DbClient } from "@agents/db";
import type { Channel, UserToolSetting, UserIntegration } from "@agents/types";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  /** Correlates all tool audit rows for the current user request. */
  turnId?: string;
  enabledTools: UserToolSetting[];
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
  /**
   * Absolute path to the workspace root used to resolve skill references.
   * Defaults to `defaultSkillsRoot()` when omitted; tests can override.
   */
  skillsRoot?: string;
  /** Session channel ("web", "telegram", "cron", "heartbeat"). */
  channel: Channel;
}
