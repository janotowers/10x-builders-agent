/**
 * Captures OpenRouter `usage` (incl. billed `cost`) from the raw HTTP
 * response before LangChain reshapes it.
 *
 * Why: `@langchain/openai` only copies `usage` into `response_metadata`
 * when `system_fingerprint` is present (OpenRouter often omits it). Even
 * with `__includeRawResponse: true`, production smokes showed LangChain
 * callbacks sometimes missing `usage.cost`. Intercepting `fetch` on the
 * OpenAI client config gives us the provider JSON regardless.
 *
 * Stash is keyed by generation `id` and is best-effort / short-lived.
 * Never stores prompts or completion content.
 */

/** Minimal OpenRouter usage shape (kept local to avoid circular imports). */
export interface CapturedUsagePayload {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cost?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

export interface CapturedOpenRouterUsage {
  id: string | null;
  usage: CapturedUsagePayload;
  capturedAtMs: number;
}

const MAX_STASH = 64;
const STASH_TTL_MS = 60_000;
const stashById = new Map<string, CapturedOpenRouterUsage>();
/** FIFO of recent captures for id-less fallback (tests / rare providers). */
const recentFifo: CapturedOpenRouterUsage[] = [];

function pruneStash(now = Date.now()): void {
  for (const [id, entry] of stashById) {
    if (now - entry.capturedAtMs > STASH_TTL_MS) stashById.delete(id);
  }
  while (recentFifo.length > 0) {
    const head = recentFifo[0]!;
    if (now - head.capturedAtMs <= STASH_TTL_MS) break;
    recentFifo.shift();
  }
  while (stashById.size > MAX_STASH) {
    const oldest = stashById.keys().next().value;
    if (oldest === undefined) break;
    stashById.delete(oldest);
  }
  while (recentFifo.length > MAX_STASH) recentFifo.shift();
}

export function stashOpenRouterUsage(
  id: string | null | undefined,
  usage: CapturedUsagePayload | null | undefined
): void {
  if (!usage || typeof usage !== "object") return;
  const entry: CapturedOpenRouterUsage = {
    id: typeof id === "string" && id.length > 0 ? id : null,
    usage,
    capturedAtMs: Date.now(),
  };
  pruneStash(entry.capturedAtMs);
  if (entry.id) stashById.set(entry.id, entry);
  recentFifo.push(entry);
}

/** Take (and remove) a stashed usage by OpenRouter generation id. */
export function takeStashedOpenRouterUsage(
  id: string | null | undefined
): CapturedOpenRouterUsage | null {
  pruneStash();
  if (typeof id === "string" && id.length > 0) {
    const hit = stashById.get(id) ?? null;
    if (hit) {
      stashById.delete(id);
      return hit;
    }
  }
  return null;
}

/**
 * Test helper: consume the most recent capture (FIFO pop from the end).
 * Production callbacks prefer `takeStashedOpenRouterUsage(id)`.
 */
export function takeMostRecentStashedOpenRouterUsage(): CapturedOpenRouterUsage | null {
  pruneStash();
  return recentFifo.pop() ?? null;
}

/** Test helper: clear the in-memory stash. */
export function clearOpenRouterUsageStash(): void {
  stashById.clear();
  recentFifo.length = 0;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isMeterableOpenRouterUrl(url: string): boolean {
  return (
    url.includes("openrouter.ai") &&
    (url.includes("/chat/completions") || url.includes("/embeddings"))
  );
}

/**
 * `configuration.fetch` for ChatOpenAI → OpenAI client. Clones non-stream
 * JSON responses, stashes `{id, usage}`, returns the original Response
 * untouched for LangChain.
 */
export function createOpenRouterMeteringFetch(
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    try {
      const url = requestUrl(input);
      if (!isMeterableOpenRouterUrl(url)) return response;
      if (!response.ok) return response;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) return response;
      // Await clone parse BEFORE returning so handleLLMEnd can read the
      // stash. Streaming SSE is not used by our factories today.
      const cloned = response.clone();
      const json: unknown = await cloned.json();
      if (json && typeof json === "object") {
        const body = json as {
          id?: unknown;
          usage?: CapturedUsagePayload | null;
        };
        stashOpenRouterUsage(
          typeof body.id === "string" ? body.id : null,
          body.usage ?? null
        );
      }
    } catch {
      /* best-effort: never break the model call */
    }
    return response;
  };
}

/** Shared OpenRouter client configuration for all ChatOpenAI factories. */
export function openRouterClientConfiguration(): {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  fetch: typeof fetch;
} {
  return {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://agents.local",
    },
    fetch: createOpenRouterMeteringFetch(),
  };
}
