/**
 * Heartbeat prefetcher framework.
 *
 * A prefetcher turns a structured `heartbeat_signal` declared by a
 * heartbeat-native skill into a deterministic, server-side read that runs
 * BEFORE the LLM is invoked. The result is:
 *
 *   1. Persisted as a `tool_calls` row marked `executor_kind=deterministic`,
 *      so the chat panel can show it next to LLM-issued tool calls (with a
 *      "Determinístico" badge).
 *   2. Summarised into a prompt block injected into the heartbeat prompt so
 *      the LLM cannot ignore the signal.
 *   3. Optionally surfaced via a deterministic fallback message when the LLM
 *      collapses to "Pulso OK" despite a real signal.
 *
 * Design notes:
 *   - The registry is keyed by `kind`, not skill slug. Multiple skills can
 *     share the same prefetcher (e.g. a future briefing skill may also want
 *     `calendar_events`).
 *   - Prefetchers only run when:
 *       a) at least one selected skill is `heartbeat: native`, AND
 *       b) that skill declared a signal of the prefetcher's kind in
 *          `heartbeat_signals`.
 *   - The prefetcher is responsible for picking the actual lookahead window:
 *     it receives the maximum of (per-item override, skill default).
 */
import type { HeartbeatSignalKind, ResolvedSkill } from "../../skills/types";
import type { DbClient } from "@agents/db";
import type { UserIntegration } from "@agents/types";
import type { HeartbeatChecklistItem } from "../checklist";

export interface HeartbeatPrefetchEnv {
  db: DbClient;
  sessionId: string;
  turnId: string | null;
  timezone: string;
  now: Date;
  userLanguage: string;
  integrations: readonly UserIntegration[];
  googleCalendarAccessToken?: string;
}

/**
 * Inputs a prefetcher receives when its kind has been selected for the run.
 */
export interface HeartbeatPrefetchInput {
  /** The maximum applicable window across all checklist items + skill default. */
  reminderWindowMinutes: number;
  /** Subset of checklist items that triggered this prefetcher (informational). */
  triggeringItems: readonly HeartbeatChecklistItem[];
  /** Skills whose signals contributed this kind (informational). */
  contributingSkills: readonly ResolvedSkill[];
}

/**
 * A short, prompt-ready signal a prefetcher emitted (one bullet per item).
 * Used to build the deterministic prompt block and the optional fallback
 * response if the LLM ignores the signal.
 */
export interface HeartbeatPrefetchSignal {
  /** Stable id for UI keying. */
  id: string;
  /** Short title shown to the user (e.g. event/task summary). */
  title: string;
  /** Localised time/duration (e.g. "starts in 31 minutes"). */
  whenDisplay: string;
  /** Minutes remaining until the deadline (for sorting/threshold copy). */
  minutesAhead: number;
  /** Free-form key/value pairs joined into the prompt bullet. */
  details: Record<string, string | number | undefined>;
}

export interface HeartbeatPrefetchOutput {
  toolName: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  status: "executed" | "failed";
  signals: HeartbeatPrefetchSignal[];
  /** Optional human-readable headline (used in fallback responses). */
  fallbackHeadline?: string;
}

export interface HeartbeatPrefetcher {
  readonly kind: HeartbeatSignalKind;
  /** Tool name to use for the persisted `tool_calls` row. */
  readonly toolName: string;
  /**
   * Returns false when the integration is missing or the prefetcher cannot
   * meaningfully run for this user (e.g. no Google Calendar token).
   */
  isAvailable(env: HeartbeatPrefetchEnv): boolean;
  run(
    env: HeartbeatPrefetchEnv,
    input: HeartbeatPrefetchInput
  ): Promise<HeartbeatPrefetchOutput>;
}
