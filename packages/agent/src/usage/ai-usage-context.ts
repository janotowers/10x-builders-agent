/**
 * Ambient attribution context for AI usage metering (Slice 0.4).
 *
 * Channel entry points (web chat, Telegram webhook, crons, Gu OS Heartbeat)
 * bind a tenant-scoped context once; `runAgent` enriches it with
 * turn/session/case ids. Every downstream model call — graph nodes, skill
 * selector, compaction, tool adapters, web classifiers — reads the ambient
 * context instead of threading attribution parameters through every call.
 *
 * Implemented with AsyncLocalStorage; `bindAiUsageContext` uses `enterWith`
 * so existing entry points do not need to wrap their whole body in a callback.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AiUsageContext } from "@agents/types";
import type { DbClient } from "@agents/db";

export interface AiUsageContextStore {
  context: AiUsageContext;
  /** Service-role client the meter persists with (best effort). */
  db: DbClient | null;
}

const storage = new AsyncLocalStorage<AiUsageContextStore>();

/** Binds the context for the remainder of the current async execution. */
export function bindAiUsageContext(
  context: AiUsageContext,
  db: DbClient | null
): void {
  storage.enterWith({ context, db });
}

/** Runs `fn` with the given context (callback style, for tests/workers). */
export function runWithAiUsageContext<T>(
  context: AiUsageContext,
  db: DbClient | null,
  fn: () => T
): T {
  return storage.run({ context, db }, fn);
}

/** Merges fields into the bound context (e.g. turnId once known). */
export function enrichAiUsageContext(partial: Partial<AiUsageContext>): void {
  const store = storage.getStore();
  if (!store) return;
  store.context = { ...store.context, ...partial };
}

export function currentAiUsageContext(): AiUsageContextStore | null {
  return storage.getStore() ?? null;
}
