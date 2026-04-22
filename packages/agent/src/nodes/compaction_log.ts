import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

const DEFAULT_LOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "logs",
  "compaction.log"
);

function resolveLogFilePath(): string | null {
  const raw = process.env.COMPACTION_LOG_FILE?.trim();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off") {
    return null;
  }
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return DEFAULT_LOG_PATH;
}

/** True cuando se quiere el modo detallado (snapshot completo, full previews). */
export function isVerboseLog(): boolean {
  const raw = process.env.COMPACTION_LOG_VERBOSE?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Corta una sola línea, preservando saltos pero sin llenar el log. */
function toSingleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Recorta una cadena a `max` chars y añade indicador `…(+N chars)`. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/** Vista previa corta y legible (una línea). */
export function previewOneLine(s: string, max: number): string {
  return truncate(toSingleLine(s), max);
}

/** Preserva la estructura del texto (para SUMMARY) y solo trunca. */
export function previewMultiline(s: string, max: number): string {
  return truncate(s, max);
}

export function resolvePreviewChars(): number {
  const raw = process.env.COMPACTION_LOG_PREVIEW_CHARS?.trim();
  if (!raw) return 80;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20_000) : 80;
}

/** Chars del SUMMARY en el log (el campo `SUMMARY (first N chars)`). */
export function resolveSummaryPreviewChars(): number {
  const raw = process.env.COMPACTION_LOG_SUMMARY_CHARS?.trim();
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50_000) : 500;
}

/** Chars del transcript enviado al LLM cuando VERBOSE=1. */
export function resolveTranscriptPreviewChars(): number {
  const raw = process.env.COMPACTION_LOG_TRANSCRIPT_PREVIEW_CHARS?.trim();
  if (!raw) return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000) : 3000;
}

function shortRole(m: BaseMessage): string {
  if (m instanceof SystemMessage) return "System";
  if (m instanceof HumanMessage) return "Human";
  if (m instanceof AIMessage) return "AI";
  if (m instanceof ToolMessage) return "Tool";
  return m.getType();
}

function bodyString(m: BaseMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text: unknown }).text ?? "");
        }
        return JSON.stringify(p);
      })
      .join(" ");
  }
  if (c == null) return "";
  return JSON.stringify(c);
}

/**
 * Breakdown legible estilo:
 *   [0] System id=ab12cd34 "[CONTEXTO COMPACTADO] — previous conversation compacted"
 *   [1] Human  id=ab12cd34 "hola"
 *   [2] AI     id=ab12cd34 (2 tool_calls)
 *   [3] Tool   id=ab12cd34 call=call_abc "[tool result cleared]"
 */
export function formatMessageBreakdown(messages: BaseMessage[]): string {
  const preview = resolvePreviewChars();
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = m.id ? String(m.id).slice(0, 8) : "--------";
    const role = shortRole(m).padEnd(6, " ");
    let head = `  [${i}] ${role} id=${id}`;
    if (m instanceof ToolMessage) {
      head += ` call=${m.tool_call_id}`;
    }
    if (m instanceof AIMessage && m.tool_calls?.length) {
      head += ` (${m.tool_calls.length} tool_call${m.tool_calls.length === 1 ? "" : "s"})`;
    }
    const body = bodyString(m);
    if (body.length > 0) {
      lines.push(`${head} "${previewOneLine(body, preview)}"`);
    } else {
      lines.push(head);
    }
  }
  return lines.join("\n");
}

/** Snapshot denso (VERBOSE): mantiene formato del antiguo para depurar. */
export function formatMessagesSnapshot(
  messages: BaseMessage[],
  label: string
): string {
  const lines: string[] = [
    `--- snapshot: ${label} (count=${messages.length}) ---`,
  ];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = m.id ? String(m.id).slice(0, 8) : "(no-id)";
    let extra = "";
    if (m instanceof ToolMessage) {
      extra = ` tool_call_id=${m.tool_call_id}`;
    }
    if (m instanceof AIMessage && m.tool_calls?.length) {
      extra += ` tool_calls=${m.tool_calls.length}`;
    }
    const body = bodyString(m);
    lines.push(
      `  #${i} ${m.getType()} id=${id} len=${body.length}${extra} preview=${JSON.stringify(previewOneLine(body, 400))}`
    );
  }
  return lines.join("\n");
}

/**
 * Escribe un bloque en el archivo de log (append). El bloque ya debe venir
 * con su cabecera humana (`[ISO] session=...` + título). Esta función sólo
 * se asegura de separar bloques con una línea en blanco y tolerar errores
 * de I/O silenciosamente.
 *
 * Ruta del archivo:
 * - Por defecto: `packages/agent/logs/compaction.log` (relativo al paquete).
 * - `COMPACTION_LOG_FILE=/ruta/absoluta/o/relativa.log` — relativa a `process.cwd()`.
 * - `COMPACTION_LOG_FILE=off|false|0` — desactiva el archivo.
 *
 * Variables de entorno:
 * - `COMPACTION_LOG_VERBOSE=1|true|on` — activa snapshots detallados.
 * - `COMPACTION_LOG_PREVIEW_CHARS` (default 80) — preview por mensaje.
 * - `COMPACTION_LOG_SUMMARY_CHARS` (default 500) — chars del SUMMARY.
 * - `COMPACTION_LOG_TRANSCRIPT_PREVIEW_CHARS` (default 3000, sólo VERBOSE).
 */
/**
 * Separador visual al inicio de cada bloque. Facilita distinguir a ojo cada
 * ejecución del nodo de compaction en `compaction.log`. Se emite una sola
 * línea de 80 chars con `═`.
 */
const BLOCK_SEPARATOR = "═".repeat(80);

export async function writeCompactionLogBlock(body: string): Promise<void> {
  const filePath = resolveLogFilePath();
  if (!filePath) return;

  const block = `\n${BLOCK_SEPARATOR}\n${body.trimEnd()}\n`;

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, block, "utf8");
  } catch (e) {
    console.warn("[compaction_log] append failed:", e);
  }
}

/** Cabecera estándar: `[ISO] session=<uuid>`. */
export function buildLogHeader(sessionId: string): string {
  return `[${new Date().toISOString()}] session=${sessionId}`;
}
