/**
 * Pre-graph skill selection (V1-B).
 *
 * The selector runs **once per turn**, before the LangGraph compiles, with
 * four inputs:
 *
 *   1. The latest user message (a short greeting should yield `none`).
 *   2. The metadata-only registry filtered by the candidate set the caller
 *      derived from `user_skill_settings` (when the table exists; in V1-B
 *      we pass the full global registry).
 *   3. The channel string ("web" | "telegram" | "cron" | "heartbeat").
 *   4. Optional structured routing context derived from recent turns, so short
 *      continuations like "y en febrero?" are not classified in isolation.
 *
 * The selector returns either `{ skillId: <slug> }` or `{ skillId: 'none' }`.
 * `'none'` is the **default** — the prompt explicitly tells the side model
 * to bias toward `'none'` whenever the match is not obvious.
 *
 * The function is intentionally model-pluggable: callers may pass any object
 * with an `invoke(messages)` method (this is what `createSkillSelectorModel`
 * returns, and it is what tests stub out without touching the network).
 */
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { resolveSkill, SkillResolveError } from "./resolve";
import type {
  ResolvedSkill,
  SkillMetadata,
  SkillRegistry,
} from "./types";
import {
  formatRoutingContextForSelector,
  type SkillRoutingContext,
} from "./routing-context";

export const NO_SKILL_ID = "none" as const;

export type SkillSelection =
  | { readonly kind: "active"; readonly skillId: string; readonly resolved: ResolvedSkill }
  | { readonly kind: "none"; readonly reason: SelectionNoneReason };

export type SelectionNoneReason =
  | "empty_registry"
  | "empty_message"
  | "model_returned_none"
  | "model_invalid_output"
  | "model_unknown_skill"
  | "resolve_failed"
  | "model_call_failed"
  | "skipped_by_caller";

/**
 * Tiny structural interface for the model used by the selector. Allows
 * tests to inject a stub without depending on `ChatOpenAI`.
 */
export interface SelectorChatModel {
  invoke(messages: BaseMessage[]): Promise<{ content: unknown }>;
}

export interface SelectSkillInput {
  /** Latest user message for this turn (already trimmed). */
  readonly userMessage: string | null | undefined;
  /** Metadata-only registry of candidate skills. */
  readonly registry: SkillRegistry;
  /** Optional explicit candidate filter (subset of registry slugs). */
  readonly candidateSlugs?: readonly string[];
  /** Channel string for the current turn (informational; biases prompt). */
  readonly channel?: string;
  /** Structured continuity context derived from recent turns. */
  readonly routingContext?: SkillRoutingContext;
  /** Pluggable model. Callers in production pass `createSkillSelectorModel()`. */
  readonly model: SelectorChatModel;
  /**
   * Optional logger for selection decisions. Default: silent. Tests pass a
   * spy to assert on which path was taken.
   */
  readonly onDecision?: (
    decision:
      | { kind: "active"; skillId: string }
      | { kind: "none"; reason: SelectionNoneReason; detail?: string }
  ) => void;
}

const SYSTEM_PROMPT = [
  "You are the skill selector for an assistant. You receive (a) a list of",
  "available skills with their `name` and `description`, and (b) the latest",
  "message from the user. Pick the ONE skill whose description best matches",
  "the user's intent FOR THIS TURN, or pick `none` when no skill clearly",
  "applies.",
  "",
  "Rules:",
  "- Bias toward `none`. The agent works fine without a skill on simple",
  "  questions, greetings, format tweaks, or single-tool lookups.",
  "- Pick a skill only when the description's `Use when ...` clause clearly",
  "  matches the user's intent.",
  "- If the latest message is a short follow-up, use the structured",
  "  continuity context to resolve the omitted domain/metric/period.",
  "- When `routingContext.lastActiveSkill` is set with medium/high confidence",
  "  and the latest message is a continuation, prefer that skill unless the",
  "  latest message clearly changes topic.",
  "- Output STRICT JSON: {\"skill\": \"<name-or-none>\"} on a single line.",
  "  No prose, no code fences, no extra fields.",
  "- Always use lowercase JSON keys and string values.",
].join("\n");

/**
 * Pick a skill for the turn. Always returns; never throws — failures funnel
 * into `{ kind: 'none' }` with a `reason` so the caller can keep going.
 */
export async function selectSkillForTurn(
  input: SelectSkillInput
): Promise<SkillSelection> {
  const { registry, model, candidateSlugs, channel, userMessage, onDecision } =
    input;

  const message = (userMessage ?? "").trim();
  if (message === "") {
    const reason: SelectionNoneReason = "empty_message";
    onDecision?.({ kind: "none", reason });
    return { kind: "none", reason };
  }

  const candidates = filterCandidates(registry, candidateSlugs);
  if (candidates.length === 0) {
    const reason: SelectionNoneReason = "empty_registry";
    onDecision?.({ kind: "none", reason });
    return { kind: "none", reason };
  }

  const skillsBlock = candidates
    .map((m) => `- ${m.name}: ${oneLine(m.description)}`)
    .join("\n");
  const channelLine = channel ? `\nChannel: ${channel}` : "";
  const routingBlock = input.routingContext
    ? `\n\nRouting context (structured continuity, derived from recent turns):\n${formatRoutingContextForSelector(input.routingContext)}`
    : "";
  const userBlock = `Skills:\n${skillsBlock}${channelLine}${routingBlock}\n\nUser message:\n${oneLine(message)}`;

  let raw: string;
  try {
    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userBlock),
    ]);
    raw = stringifyContent(response.content);
  } catch (err) {
    const reason: SelectionNoneReason = "model_call_failed";
    onDecision?.({
      kind: "none",
      reason,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { kind: "none", reason };
  }

  const parsed = parseSelectorJson(raw);
  if (!parsed) {
    const reason: SelectionNoneReason = "model_invalid_output";
    onDecision?.({ kind: "none", reason, detail: raw.slice(0, 200) });
    return { kind: "none", reason };
  }

  if (parsed === NO_SKILL_ID) {
    const reason: SelectionNoneReason = "model_returned_none";
    onDecision?.({ kind: "none", reason });
    return { kind: "none", reason };
  }

  const candidateSet = new Set(candidates.map((c) => c.name));
  if (!candidateSet.has(parsed)) {
    const reason: SelectionNoneReason = "model_unknown_skill";
    onDecision?.({ kind: "none", reason, detail: parsed });
    return { kind: "none", reason };
  }

  let resolved: ResolvedSkill;
  try {
    resolved = await resolveSkill(parsed, registry);
  } catch (err) {
    const reason: SelectionNoneReason = "resolve_failed";
    onDecision?.({
      kind: "none",
      reason,
      detail:
        err instanceof SkillResolveError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    });
    return { kind: "none", reason };
  }

  onDecision?.({ kind: "active", skillId: parsed });
  return { kind: "active", skillId: parsed, resolved };
}

function filterCandidates(
  registry: SkillRegistry,
  candidateSlugs?: readonly string[]
): readonly SkillMetadata[] {
  if (!candidateSlugs) return registry.list();
  const set = new Set(candidateSlugs);
  return registry.list().filter((m) => set.has(m.name));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Parse `{"skill": "<name>"}` or `{"skill": "none"}`. Tolerates leading
 * whitespace, surrounding code fences, or trailing prose; returns `null`
 * for anything that does not yield a string `skill` field.
 */
export function parseSelectorJson(raw: string): string | null {
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = stripped.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>).skill;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  return trimmed;
}
