import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Log estructurado para la memoria de largo plazo. Análogo a
 * `compaction_log.ts` pero específico para los tres componentes del
 * sistema:
 *   - `memory_injection_node` → EVENT=INJECT
 *   - `trigger.ts` (maybeCatchUpFlush / fireAndForgetFlush) → EVENT=TRIGGER
 *   - `memory_flush.ts` → EVENT=FLUSH / EVENT=SKIP
 *
 * Objetivo: permitir auditar a ojo humano si los mecanismos se están
 * disparando correctamente (thresholds, señales, reasons). I/O es append
 * asíncrono con fallback silencioso, coste despreciable.
 *
 * Config (env vars):
 *   - MEMORY_LOG_FILE          ruta o `off|0|false` para desactivar.
 *                              Default: packages/agent/logs/memory.log
 *   - MEMORY_LOG_VERBOSE       `1|true|on` → incluye previews largos
 *                              (transcript enviado a Haiku, respuesta cruda,
 *                              memory block completo). Default: off.
 *   - MEMORY_LOG_PREVIEW_CHARS  corte de previews cortos. Default 120.
 *   - MEMORY_LOG_TRANSCRIPT_CHARS corte del transcript en VERBOSE. Default 3000.
 */

const DEFAULT_LOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "logs",
  "memory.log"
);

function resolveLogFilePath(): string | null {
  const raw = process.env.MEMORY_LOG_FILE?.trim();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off") {
    return null;
  }
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return DEFAULT_LOG_PATH;
}

export function isVerboseMemoryLog(): boolean {
  const raw = process.env.MEMORY_LOG_VERBOSE?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function resolvePreviewChars(): number {
  const raw = process.env.MEMORY_LOG_PREVIEW_CHARS?.trim();
  if (!raw) return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20_000) : 120;
}

function resolveTranscriptChars(): number {
  const raw = process.env.MEMORY_LOG_TRANSCRIPT_CHARS?.trim();
  if (!raw) return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000) : 3000;
}

function toSingleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

export function previewOneLine(s: string, max?: number): string {
  return truncate(toSingleLine(s), max ?? resolvePreviewChars());
}

export function previewMultiline(s: string, max?: number): string {
  return truncate(s, max ?? resolveTranscriptChars());
}

const BLOCK_SEPARATOR = "═".repeat(80);

async function writeBlock(body: string): Promise<void> {
  const filePath = resolveLogFilePath();
  if (!filePath) return;
  const block = `\n${BLOCK_SEPARATOR}\n${body.trimEnd()}\n`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, block, "utf8");
  } catch (e) {
    console.warn("[memory_log] append failed:", e);
  }
}

function header(event: string, sessionId: string, extra?: string): string {
  const base = `[${new Date().toISOString()}] EVENT=${event} session=${sessionId}`;
  return extra ? `${base} ${extra}` : base;
}

// ============================================================
// EVENT=INJECT — una corrida de memory_injection_node
// ============================================================

export interface InjectLogInput {
  sessionId: string;
  userId: string;
  /** Input del usuario en este turno. Null si no había HumanMessage. */
  userInput: string | null;
  /** `"skipped_cron" | "skipped_resume" | "skipped_no_input" | "ok"`. */
  outcome: "ok" | "skipped_cron" | "skipped_resume" | "skipped_no_input" | "embedding_failed";
  embedding?: {
    model: string;
    dim: number;
    latencyMs: number;
  };
  topicShift?: {
    hasPrevEmbedding: boolean;
    cosine: number | null;
    threshold: number;
    shift: boolean;
  };
  retrieval?: {
    topK: number;
    threshold: number;
    returned: number;
    latencyMs: number;
    matches: Array<{
      type: string;
      content: string;
      similarity: number;
      retrievalCount: number;
    }>;
  };
  injection?: {
    rewrittenSystemMessage: boolean;
    blockChars: number;
    firstSystemIdx: number;
    /** Sólo si VERBOSE=1 y rewritten=true. */
    memoryBlock?: string;
  };
  memoryFlushPending: boolean;
}

export async function logMemoryInject(input: InjectLogInput): Promise<void> {
  const verbose = isVerboseMemoryLog();
  const lines: string[] = [header("INJECT", input.sessionId, `userId=${input.userId}`)];

  if (input.userInput !== null) {
    lines.push(`USER_INPUT (${input.userInput.length} chars): "${previewOneLine(input.userInput)}"`);
  } else {
    lines.push(`USER_INPUT: <none>`);
  }

  lines.push(`OUTCOME: ${input.outcome} memoryFlushPending=${input.memoryFlushPending}`);

  if (input.outcome !== "ok" && input.outcome !== "embedding_failed") {
    await writeBlock(lines.join("\n"));
    return;
  }

  if (input.embedding) {
    lines.push(
      `EMBEDDING: dim=${input.embedding.dim} model=${input.embedding.model} latency_ms=${input.embedding.latencyMs}`
    );
  }

  if (input.topicShift) {
    const cos = input.topicShift.cosine;
    const cosStr = cos === null ? "n/a (first turn)" : cos.toFixed(3);
    lines.push(
      `TOPIC_SHIFT: prev_embedding=${input.topicShift.hasPrevEmbedding ? "present" : "absent"} cosine=${cosStr} threshold=${input.topicShift.threshold.toFixed(3)} shift=${input.topicShift.shift ? "TRUE" : "false"}`
    );
  }

  if (input.retrieval) {
    lines.push(
      `RETRIEVAL: top_k=${input.retrieval.topK} threshold=${input.retrieval.threshold.toFixed(3)} returned=${input.retrieval.returned} latency_ms=${input.retrieval.latencyMs}`
    );
    for (const m of input.retrieval.matches) {
      lines.push(
        `  - [${m.type} sim=${m.similarity.toFixed(3)} rc=${m.retrievalCount}] "${previewOneLine(m.content)}"`
      );
    }
  }

  if (input.injection) {
    lines.push(
      `INJECTION: system_message_rewritten=${input.injection.rewrittenSystemMessage ? "TRUE" : "false"} block_chars=${input.injection.blockChars} first_system_idx=${input.injection.firstSystemIdx}`
    );
    if (verbose && input.injection.memoryBlock) {
      lines.push(`MEMORY_BLOCK:\n${previewMultiline(input.injection.memoryBlock)}`);
    }
  }

  await writeBlock(lines.join("\n"));
}

// ============================================================
// EVENT=TRIGGER — evaluación de disparo (PRE o POST)
// ============================================================

export interface TriggerLogInput {
  sessionId: string;
  phase: "PRE" | "POST";
  /** PRE: resultado de catch-up; POST: resultado de fire-and-forget. */
  decision: "fire" | "skip" | "sibling_flush";
  reason: string;
  signals?: {
    memoryFlushPending?: boolean;
    unflushedCount?: number;
    idleMin?: number | null;
    sinceLastFlushMin?: number | null;
  };
  thresholds?: {
    catchupIdleMin?: number;
    backstopIdleMin?: number;
    backstopMaxUnflushed?: number;
  };
  sibling?: {
    found: boolean;
    siblingSessionId?: string;
    siblingChannel?: string;
  };
}

export async function logMemoryTrigger(input: TriggerLogInput): Promise<void> {
  const lines: string[] = [header("TRIGGER", input.sessionId, `phase=${input.phase}`)];
  lines.push(`DECISION: ${input.decision} reason=${input.reason}`);

  if (input.signals) {
    const parts: string[] = [];
    if (input.signals.memoryFlushPending !== undefined)
      parts.push(`memoryFlushPending=${input.signals.memoryFlushPending}`);
    if (input.signals.unflushedCount !== undefined)
      parts.push(`unflushedCount=${input.signals.unflushedCount}`);
    if (input.signals.idleMin !== undefined) {
      const v = input.signals.idleMin;
      parts.push(`idleMin=${v === null ? "n/a" : (Number.isFinite(v) ? v.toFixed(2) : "inf")}`);
    }
    if (input.signals.sinceLastFlushMin !== undefined) {
      const v = input.signals.sinceLastFlushMin;
      parts.push(
        `sinceLastFlushMin=${v === null ? "n/a" : Number.isFinite(v) ? v.toFixed(2) : "inf"}`
      );
    }
    if (parts.length > 0) lines.push(`SIGNALS: ${parts.join(" ")}`);
  }

  if (input.thresholds) {
    const parts: string[] = [];
    if (input.thresholds.catchupIdleMin !== undefined)
      parts.push(`catchup_idle_min=${input.thresholds.catchupIdleMin}`);
    if (input.thresholds.backstopIdleMin !== undefined)
      parts.push(`backstop_idle_min=${input.thresholds.backstopIdleMin}`);
    if (input.thresholds.backstopMaxUnflushed !== undefined)
      parts.push(`backstop_max_unflushed=${input.thresholds.backstopMaxUnflushed}`);
    if (parts.length > 0) lines.push(`THRESHOLDS: ${parts.join(" ")}`);
  }

  if (input.sibling) {
    if (input.sibling.found) {
      lines.push(
        `SIBLING: found=true sibling_session=${input.sibling.siblingSessionId} channel=${input.sibling.siblingChannel}`
      );
    } else {
      lines.push(`SIBLING: found=false`);
    }
  }

  await writeBlock(lines.join("\n"));
}

// ============================================================
// EVENT=FLUSH — corrida completa de flushSessionMemory
// EVENT=SKIP  — early return de flushSessionMemory
// ============================================================

export interface FlushLogInput {
  sessionId: string;
  userId: string;
  reason: string;
  coldStart: boolean;
  load: {
    loaded: number;
    cap: number;
    since: string | null;
  };
  haiku?: {
    latencyMs: number;
    rawPreview: string;
    transcriptChars: number;
    transcriptSample?: string;
  };
  parse?: {
    validItems: number;
    droppedItems: number;
  };
  save?: {
    saved: number;
    deduped: number;
    embeddingFailures: number;
    items: Array<{ type: string; content: string; inserted: boolean }>;
  };
  watermark?: {
    advanced: boolean;
    lastFlushedAt: string | null;
    lastFlushedMessageId: string | null;
  };
  outcome: {
    extracted: number;
    skipped: boolean;
    finalReason: string;
  };
}

export async function logMemoryFlush(input: FlushLogInput): Promise<void> {
  const verbose = isVerboseMemoryLog();
  const lines: string[] = [
    header(
      "FLUSH",
      input.sessionId,
      `reason=${input.reason} cold_start=${input.coldStart} userId=${input.userId}`
    ),
  ];
  lines.push(
    `LOAD: loaded=${input.load.loaded} cap=${input.load.cap} since=${input.load.since ?? "null"}`
  );

  if (input.haiku) {
    lines.push(
      `HAIKU: latency_ms=${input.haiku.latencyMs} transcript_chars=${input.haiku.transcriptChars}`
    );
    lines.push(`HAIKU_RAW (${input.haiku.rawPreview.length} chars): ${previewOneLine(input.haiku.rawPreview)}`);
    if (verbose && input.haiku.transcriptSample) {
      lines.push(`TRANSCRIPT_SAMPLE:\n${previewMultiline(input.haiku.transcriptSample)}`);
    }
  }

  if (input.parse) {
    lines.push(
      `PARSED: valid_items=${input.parse.validItems} dropped=${input.parse.droppedItems}`
    );
  }

  if (input.save) {
    lines.push(
      `SAVE: saved=${input.save.saved} deduped=${input.save.deduped} embedding_failures=${input.save.embeddingFailures}`
    );
    for (const it of input.save.items) {
      lines.push(
        `  - [${it.type}] "${previewOneLine(it.content)}" → ${it.inserted ? "INSERTED" : "DEDUPED"}`
      );
    }
  }

  if (input.watermark) {
    lines.push(
      `WATERMARK: advanced=${input.watermark.advanced} last_flushed_at=${input.watermark.lastFlushedAt ?? "null"} last_flushed_message_id=${input.watermark.lastFlushedMessageId ?? "null"}`
    );
  }

  lines.push(
    `OUTCOME: extracted=${input.outcome.extracted} skipped=${input.outcome.skipped} reason=${input.outcome.finalReason}`
  );

  await writeBlock(lines.join("\n"));
}

export interface SkipLogInput {
  sessionId: string;
  userId: string;
  reason: string;
  note?: string;
}

export async function logMemorySkip(input: SkipLogInput): Promise<void> {
  const lines: string[] = [
    header("SKIP", input.sessionId, `userId=${input.userId}`),
    `REASON: ${input.reason}`,
  ];
  if (input.note) lines.push(`NOTE: ${input.note}`);
  await writeBlock(lines.join("\n"));
}
