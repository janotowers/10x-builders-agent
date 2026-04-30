import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
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
   * Absolute path to the workspace root used to resolve skill references.
   * Defaults to `defaultSkillsRoot()` when omitted; tests can override.
   */
  skillsRoot?: string;
}
