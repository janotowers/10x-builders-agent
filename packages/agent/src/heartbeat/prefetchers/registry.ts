/**
 * Heartbeat prefetcher registry + runner.
 *
 * Builds the deterministic side of a Heartbeat tick:
 *   1. Walks the resolved heartbeat-native skills, collects their declared
 *      `heartbeat_signals`, and groups them by `kind`.
 *   2. For each kind that has a registered prefetcher AND is available for
 *      the current user (e.g. integration connected, scope granted), runs
 *      it once with the maximum applicable lookahead window.
 *   3. Persists the result as a `tool_calls` row marked
 *      `executor_kind=deterministic`, mirroring the shape of the equivalent
 *      LLM tool. The chat panel renders these alongside agent-issued tool
 *      calls and badges them as "Determinístico".
 *   4. Returns a prompt block + an optional fallback response builder so the
 *      route can keep its current "Pulso OK" sanitisation flow.
 */
import type { ResolvedSkill, HeartbeatSignalKind, HeartbeatSkillSignal } from "../../skills/types";
import type { HeartbeatChecklistItem } from "../checklist";
import type {
  HeartbeatPrefetcher,
  HeartbeatPrefetchEnv,
  HeartbeatPrefetchSignal,
  HeartbeatPrefetchOutput,
} from "./types";
import { calendarEventsPrefetcher } from "./calendar-events";
import { calendarTasksPrefetcher } from "./calendar-tasks";
import { recordDeterministicToolCall } from "@agents/db";

const DEFAULT_PREFETCHERS: readonly HeartbeatPrefetcher[] = [
  calendarEventsPrefetcher,
  calendarTasksPrefetcher,
];

const PREFETCHER_BY_KIND: ReadonlyMap<HeartbeatSignalKind, HeartbeatPrefetcher> =
  new Map(DEFAULT_PREFETCHERS.map((p) => [p.kind, p] as const));

export interface HeartbeatPrefetchRunResult {
  /** Prompt block to inject before the checklist. Empty when no signals fired. */
  promptBlock: string;
  /**
   * Deterministic fallback response — used by the route when the LLM
   * collapses to "Pulso OK" despite the prefetchers returning real signals.
   * Empty string when no signals fired.
   */
  fallbackResponse: string;
  /** Persisted tool_call row ids for traceability in `heartbeat_runs.payload`. */
  persistedToolCallIds: string[];
  /** Skipped kinds with reason (for warnings/log). */
  skipped: Array<{ kind: HeartbeatSignalKind; reason: string }>;
  /** Whether at least one prefetcher emitted at least one signal. */
  hasSignals: boolean;
}

interface KindBucket {
  kind: HeartbeatSignalKind;
  reminderWindowMinutes: number;
  triggeringItems: HeartbeatChecklistItem[];
  contributingSkills: ResolvedSkill[];
  signals: HeartbeatSkillSignal[];
}

function bucketSignalsByKind(
  skills: readonly ResolvedSkill[],
  items: readonly HeartbeatChecklistItem[]
): Map<HeartbeatSignalKind, KindBucket> {
  const buckets = new Map<HeartbeatSignalKind, KindBucket>();
  const itemWindowMax = items.reduce<number | null>((acc, item) => {
    if (typeof item.reminderWindowMinutes !== "number") return acc;
    if (acc === null) return item.reminderWindowMinutes;
    return Math.max(acc, item.reminderWindowMinutes);
  }, null);

  for (const skill of skills) {
    if (skill.heartbeatMode !== "native") continue;
    for (const signal of skill.heartbeatSignals) {
      const existing = buckets.get(signal.kind);
      const baseWindow = signal.reminderWindowMinutes;
      const effectiveWindow = Math.max(
        baseWindow,
        itemWindowMax ?? baseWindow
      );
      if (existing) {
        existing.signals.push(signal);
        existing.contributingSkills.push(skill);
        existing.reminderWindowMinutes = Math.max(
          existing.reminderWindowMinutes,
          effectiveWindow
        );
      } else {
        buckets.set(signal.kind, {
          kind: signal.kind,
          reminderWindowMinutes: effectiveWindow,
          triggeringItems: items.filter((it) =>
            sourceMatchesKind(signal.kind, it)
          ),
          contributingSkills: [skill],
          signals: [signal],
        });
      }
    }
  }
  return buckets;
}

function sourceMatchesKind(
  kind: HeartbeatSignalKind,
  item: HeartbeatChecklistItem
): boolean {
  if (kind === "calendar_events") return item.sources.includes("calendar");
  if (kind === "calendar_tasks")
    return item.sources.includes("calendar_tasks");
  return false;
}

function formatPromptBullet(
  kind: HeartbeatSignalKind,
  signal: HeartbeatPrefetchSignal
): string {
  const detailParts = Object.entries(signal.details)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  const prefix = kind === "calendar_tasks" ? "task" : "event";
  return `- [${prefix}] ${signal.title} | ${detailParts.join(" | ")}`;
}

function buildPromptBlock(outputs: HeartbeatPrefetchOutput[]): string {
  const lines: string[] = [];
  let emittedHeader = false;
  for (const output of outputs) {
    if (output.signals.length === 0) continue;
    if (!emittedHeader) {
      lines.push("[DETERMINISTIC HEARTBEAT SIGNALS]");
      lines.push(
        "These items already crossed their reminder threshold. They were read deterministically from the user's data sources before this prompt. Do not answer Pulso OK while this block is non-empty; explain the action they imply."
      );
      emittedHeader = true;
    }
    for (const signal of output.signals) {
      const kind =
        output.toolName === "calendar_list_tasks"
          ? "calendar_tasks"
          : "calendar_events";
      lines.push(formatPromptBullet(kind as HeartbeatSignalKind, signal));
    }
  }
  return lines.join("\n");
}

function buildFallbackResponse(
  outputs: HeartbeatPrefetchOutput[],
  userLanguage: string
): string {
  const collected: Array<{
    kind: "event" | "task";
    title: string;
    when: string;
  }> = [];
  for (const output of outputs) {
    const kind = output.toolName === "calendar_list_tasks" ? "task" : "event";
    for (const signal of output.signals) {
      collected.push({
        kind,
        title: signal.title,
        when: signal.whenDisplay,
      });
    }
  }
  if (collected.length === 0) return "";

  const spanish = !userLanguage.toLowerCase().startsWith("en");
  const lines: string[] = spanish ? ["### Pulso"] : ["### Pulse"];
  for (const c of collected) {
    if (c.kind === "event") {
      lines.push(
        spanish
          ? `**Señal:** "${c.title}" comienza ${c.when}.`
          : `**Signal:** "${c.title}" starts ${c.when}.`
      );
    } else {
      lines.push(
        spanish
          ? `**Señal:** la tarea "${c.title}" vence ${c.when}.`
          : `**Signal:** task "${c.title}" is due ${c.when}.`
      );
    }
    lines.push(
      spanish
        ? "**Por qué importa ahora:** está dentro de la ventana de recordatorio configurada."
        : "**Why it matters now:** it is inside the configured reminder window."
    );
    lines.push(
      spanish
        ? "**Acción recomendada:** revisa si necesitas preparar algo o cerrar el pendiente antes del momento."
        : "**Recommended action:** check whether you need anything prepared or to close the pending item before the deadline."
    );
  }
  return lines.join("\n");
}

export async function runHeartbeatPrefetchers(args: {
  env: HeartbeatPrefetchEnv;
  skills: readonly ResolvedSkill[];
  items: readonly HeartbeatChecklistItem[];
}): Promise<HeartbeatPrefetchRunResult> {
  const buckets = bucketSignalsByKind(args.skills, args.items);
  const outputs: HeartbeatPrefetchOutput[] = [];
  const persistedToolCallIds: string[] = [];
  const skipped: Array<{ kind: HeartbeatSignalKind; reason: string }> = [];

  for (const bucket of buckets.values()) {
    const prefetcher = PREFETCHER_BY_KIND.get(bucket.kind);
    if (!prefetcher) {
      skipped.push({ kind: bucket.kind, reason: "no prefetcher registered" });
      continue;
    }
    if (!prefetcher.isAvailable(args.env)) {
      skipped.push({
        kind: bucket.kind,
        reason: "integration unavailable for user",
      });
      continue;
    }
    let output: HeartbeatPrefetchOutput;
    try {
      output = await prefetcher.run(args.env, {
        reminderWindowMinutes: bucket.reminderWindowMinutes,
        triggeringItems: bucket.triggeringItems,
        contributingSkills: bucket.contributingSkills,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ kind: bucket.kind, reason: `run failed: ${message}` });
      try {
        const failed = await recordDeterministicToolCall(args.env.db, {
          sessionId: args.env.sessionId,
          turnId: args.env.turnId,
          toolName: prefetcher.toolName,
          args: {
            reminder_window_minutes: bucket.reminderWindowMinutes,
          },
          status: "failed",
          result: { error: message },
        });
        persistedToolCallIds.push(failed.id);
      } catch {
        // Persistence is best-effort; the run should not fail because we
        // could not write the row.
      }
      continue;
    }

    try {
      const persisted = await recordDeterministicToolCall(args.env.db, {
        sessionId: args.env.sessionId,
        turnId: args.env.turnId,
        toolName: output.toolName,
        args: output.arguments,
        status: output.status,
        result: output.result,
      });
      persistedToolCallIds.push(persisted.id);
    } catch {
      // Surfacing this as a warning is enough; we still want to return the
      // prompt block so the LLM gets the signal.
    }
    outputs.push(output);
  }

  const promptBlock = buildPromptBlock(outputs);
  const fallbackResponse = buildFallbackResponse(outputs, args.env.userLanguage);
  const hasSignals = outputs.some((o) => o.signals.length > 0);

  return {
    promptBlock,
    fallbackResponse,
    persistedToolCallIds,
    skipped,
    hasSignals,
  };
}

export { calendarEventsPrefetcher, calendarTasksPrefetcher };
export type {
  HeartbeatPrefetcher,
  HeartbeatPrefetchEnv,
  HeartbeatPrefetchInput,
  HeartbeatPrefetchOutput,
  HeartbeatPrefetchSignal,
} from "./types";
