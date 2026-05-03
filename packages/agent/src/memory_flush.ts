import type { DbClient } from "@agents/db";
import {
  getFlushState,
  updateFlushWatermark,
  saveMemory,
  type MemoryType,
} from "@agents/db";
import { createCompactionModel } from "./model";
import { generateEmbedding } from "./embeddings";
import { logMemoryFlush, logMemorySkip } from "./nodes/memory_log";

/**
 * `flushSessionMemory` — extracción post-sesión de hechos duraderos.
 *
 * Corre FUERA del grafo (se llama desde los endpoints de Web/Telegram tras
 * `runAgent`) porque:
 * - El flush no debe bloquear la respuesta al usuario.
 * - El grafo gestiona un solo turno; el flush es trans-turnos por diseño.
 *
 * Idempotencia: se apoya en el watermark (`last_flushed_at` /
 * `last_flushed_message_id` en `agent_sessions`). Solo avanza el watermark
 * cuando el pipeline completo tiene éxito — si falla el parseo del JSON o
 * la llamada a Haiku, el siguiente disparo reintenta los mismos mensajes.
 *
 * Deduplicación: `saveMemory` hace `ON CONFLICT (user_id, content_hash) DO
 * NOTHING`, así que dos turnos que extraigan el mismo hecho solo producen UN
 * renglón en `memories`.
 *
 * Ver `docs/memory/long_term_memory_plan.md` (sección "Pipeline
 * flushSessionMemory") para el diagrama completo.
 */

const FLUSH_MIN_NEW_MESSAGES_DEFAULT = 3;
const FLUSH_MAX_MESSAGES = 200;
// Cap más estricto cuando NO hay watermark previo (primera extracción en una
// sesión). Evita que una sesión con meses de historial dispare una extracción
// de 200 mensajes en la que Haiku alucina/sobregeneraliza. Para catch-ups
// posteriores (watermark != null) usamos FLUSH_MAX_MESSAGES normal.
const FLUSH_MAX_MESSAGES_COLD_START = 50;
const MESSAGE_CONTENT_TRUNCATE = 2000;

function resolveMinNewMessages(): number {
  const raw = process.env.MEMORY_FLUSH_MIN_NEW_MESSAGES?.trim();
  if (!raw) return FLUSH_MIN_NEW_MESSAGES_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FLUSH_MIN_NEW_MESSAGES_DEFAULT;
  return Math.floor(n);
}

export type FlushReason = "shift" | "count" | "idle" | "catchup";

export interface FlushInput {
  db: DbClient;
  userId: string;
  sessionId: string;
  reason: FlushReason;
}

export interface FlushResult {
  extracted: number;
  skipped: boolean;
  reason: string;
  /** `true` si el watermark avanzó (lista vacía también cuenta como éxito). */
  watermarkAdvanced: boolean;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
}

export const EXTRACTION_SYSTEM_PROMPT = `Eres un extractor de memoria a largo plazo para un agente personal. Recibes un transcript de uno o varios turnos (user / assistant / tool). Tu trabajo es identificar SOLO hechos sobre EL USUARIO que aporten contexto en conversaciones futuras y que NO estén ya cubiertos por los datos estructurados de su perfil ni por las herramientas del agente.

Clasifica cada hecho en uno de tres tipos:
- "episodic": algo concreto que hizo o le pasó al usuario, relevante a futuro (ej. "creó el repo mi-app el 20 de abril", "mudó su negocio a Guadalajara en enero").
- "semantic": preferencias, gustos, opiniones, relaciones o contexto durable del usuario (ej. "le gusta el fútbol y sigue al Atlas FC", "su hijo se llama Diego").
- "procedural": cómo el USUARIO quiere que el agente trabaje con él (ej. "prefiere respuestas en bullets y español neutro", "cuando agende reuniones, bloquee 15 min de buffer antes").

REGLAS DURAS — no las violes:
1. Solo atribuye al USUARIO cosas que el USUARIO dijo o pidió directamente. Si la afirmación viene de un mensaje [assistant] o [tool], NO la extraigas (esas reflejan al agente o a un sistema externo, no al usuario).
2. NO EXTRAIGAS datos de identidad/config PROPIOS del usuario que ya viven en el perfil del usuario o en el system prompt: su nombre, apellido, email propio, teléfono propio, timezone, idioma, formato de fecha, moneda. El agente ya los recibe cada turno. (Email y teléfono de TERCEROS sí se pueden extraer — ver Regla 3).
3. NO EXTRAIGAS listas de recursos externos que el agente consulta con herramientas: NO extraigas los calendarios que tiene en Google, NO extraigas la lista de sus repos de GitHub, NO extraigas archivos, eventos concretos, issues ni PRs. Esas listas cambian y el agente las re-obtiene cuando las necesita. EXCEPCIÓN: sí puedes extraer como "semantic" datos de contacto ESTABLES de TERCEROS que el usuario comparte deliberadamente (ej. "el email de mi contador es juan@ejemplo.com", "el WhatsApp de mi hermana es +52 33 XXX"). No extraigas contactos mencionados de pasada sin intención de recordar.
4. NO EXTRAIGAS comportamiento del AGENTE: "usa bash", "llama a la tool X", "busca en Wikipedia", "responde corto" — eso es el system prompt del agente, no una preferencia del usuario. Solo cuenta si el propio usuario expresó la preferencia ("quiero que me respondas corto").
5. NO EXTRAIGAS DATOS TRANSACCIONALES DE NEGOCIO sobre TERCEROS DEL FLUJO DE TRABAJO del usuario que aparezcan como input a una tarea. Específicamente:
   - Nombres, teléfonos, emails o IDs de leads, prospectos, clientes, asistentes a citas o contrapartes de un deal.
   - Direcciones, precios, IDs o atributos de propiedades, inventario, catálogo o eventos de negocio.
   - Contenido de mensajes que el usuario está componiendo o pidiendo redactar (WhatsApps, emails, drafts, briefs).
   - Estados de pipeline (etapas, fechas de seguimiento, montos por cerrar, status de un lead).
   Estas entidades viven en sistemas externos (CRM, BigQuery, calendario) y el agente las consulta con tools cuando las necesita. Guardarlas en memoria larga las congela en el tiempo y contamina futuros turnos. La EXCEPCIÓN sigue siendo Regla 3: contactos personales estables (familia, amistades, médico, contador) que el usuario comparte deliberadamente como contexto, no como input a una tarea operativa. Test rápido: si la frase tiene la forma "el lead/cliente/propiedad X tiene Y" o "el nombre/teléfono/correo del lead/cliente es Z", NO la extraigas.
6. NO EXTRAIGAS INPUTS DE TAREA. Si el [assistant] inmediato anterior le pidió al usuario un dato concreto (nombre, teléfono, email, fecha, dirección, monto, hora) y el [user] solo respondió con ese valor, ese intercambio es un PARÁMETRO DE UN TURNO, no un hecho durable sobre el usuario. NO lo extraigas, ni siquiera si la frase del usuario está bien formada ("su nombre es X", "el teléfono es 521…", "es para el viernes a las 3pm").
7. NO EXTRAIGAS saludos, agradecimientos, quejas, frases de relleno, ni nada temporal del turno actual ("ahora estoy probando", "hoy me falló X").
8. NO sobregeneralices desde un solo dato. Si el usuario mencionó UN equipo, el hecho es "sigue al equipo X", no "prefiere equipos del país Y".
9. Sé CONSERVADOR. Si dudas, NO lo incluyas. Devolver [] es una respuesta válida y preferible a inventar.

EJEMPLOS (dominio inmobiliario / asistente personal):

SÍ extraer:
- [user] "Soy asesor inmobiliario en Mazatlán, llevo 8 años" → {"type":"semantic","content":"Es asesor inmobiliario en Mazatlán con 8 años de experiencia"}
- [user] "Siempre prefiero responder en tono amigable y firmar 'Saludos, Juan'" → {"type":"procedural","content":"Prefiere tono amigable y firma 'Saludos, Juan' en sus mensajes"}
- [user] "El WhatsApp de mi contadora Lucía es +52 33 1234 5678" → {"type":"semantic","content":"Su contadora se llama Lucía, WhatsApp +52 33 1234 5678"}

NO extraer (Regla 5 — datos transaccionales del CRM):
- [user] "Ayúdame a escribir un WhatsApp para el lead Julieta Evelia, tel 521…" → []
- [user] "La propiedad de Reforma 123 está en venta a 4.5M" → []
- [user] "El cliente Pedro pidió cita el viernes" → []

NO extraer (Regla 6 — inputs de tarea):
- [assistant] "¿Cuál es el nombre del lead?" + [user] "El nombre es Julieta Evelia" → []
- [assistant] "¿Su teléfono?" + [user] "5216688255676" → []

FORMATO:
- Cada hecho en 1 frase corta en español, máximo 180 caracteres, en presente o pasado.
- Salida OBLIGATORIA: un array JSON válido y NADA más (sin texto, sin code fences). Ejemplo:
[{"type":"semantic","content":"Le gusta el fútbol y sigue al Atlas FC"},{"type":"procedural","content":"Prefiere respuestas cortas en bullets"}]
- Si no hay NADA digno de recordar según las reglas de arriba, devuelve exactamente [].`;

/** Extrae JSON del texto devuelto por el modelo. Haiku ocasionalmente envuelve
 *  la respuesta en ```json ... ```; tolerante a ese caso. Si no hay match,
 *  devuelve null para que el caller decida (no avanzar watermark). */
export function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  // Quitar code fences si los hay.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenceMatch ? fenceMatch[1] : trimmed).trim();
  if (!candidate.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateExtracted(items: unknown[]): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = obj.type;
    const content = obj.content;
    if (
      (type === "episodic" || type === "semantic" || type === "procedural") &&
      typeof content === "string" &&
      content.trim().length > 0 &&
      content.trim().length <= 500
    ) {
      out.push({ type, content: content.trim() });
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * Helper expuesto SOLO para tests/diagnóstico: corre la pipeline de
 * extracción (system prompt + user prompt + parse + validate) sobre un
 * transcript ya serializado. NO toca la DB, NO genera embeddings, NO
 * actualiza watermark. Útil para selftests live (gated por env var) y
 * para evaluar el efecto del prompt en un transcript sintético.
 */
export async function extractMemoriesFromTranscript(
  transcript: string,
  options?: { reason?: FlushReason }
): Promise<{
  rawText: string;
  parsed: unknown[] | null;
  items: ExtractedMemory[];
}> {
  const reason = options?.reason ?? "catchup";
  const userPrompt = `TRANSCRIPT (reason=${reason}):\n\n${transcript}\n\n--- FIN ---\n\nDevuelve el array JSON.`;
  const model = createCompactionModel();
  const response = await model.invoke([
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  const raw = (response as { content: unknown }).content;
  const rawText =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((p) =>
              p && typeof p === "object" && "text" in p
                ? String((p as { text: unknown }).text ?? "")
                : ""
            )
            .join("")
        : String(raw ?? "");
  const parsed = extractJsonArray(rawText);
  const items = parsed ? validateExtracted(parsed) : [];
  return { rawText, parsed, items };
}

export async function flushSessionMemory(
  input: FlushInput
): Promise<FlushResult> {
  const { db, userId, sessionId, reason } = input;
  const minNewMessages = resolveMinNewMessages();

  const state = await getFlushState(db, sessionId);
  if (!state) {
    void logMemorySkip({
      sessionId,
      userId,
      reason: "session_not_found",
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: "session_not_found",
      watermarkAdvanced: false,
    };
  }

  // Sesiones de cron no pasan por memoria. Doble safety net además de la
  // guarda en el caller (cron/scheduled-tasks/route.ts).
  if (state.channel === "cron") {
    void logMemorySkip({
      sessionId,
      userId,
      reason: "cron_channel",
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: "cron_channel",
      watermarkAdvanced: false,
    };
  }

  // Cargar mensajes. Dos modos:
  //   - Con watermark previo: cargamos todo lo nuevo en orden cronológico
  //     (hasta FLUSH_MAX_MESSAGES, que es el límite de seguridad si el caller
  //     quedó muy rezagado).
  //   - Sin watermark (primera extracción): solo los FLUSH_MAX_MESSAGES_COLD_START
  //     mensajes MÁS RECIENTES. Para eso ordenamos desc y luego invertimos al
  //     final para entregarlos a Haiku en orden cronológico.
  const isColdStart = !state.lastFlushedAt;
  let query = db
    .from("agent_messages")
    .select("id, role, content, created_at")
    .eq("session_id", sessionId);
  if (isColdStart) {
    query = query
      .order("created_at", { ascending: false })
      .limit(FLUSH_MAX_MESSAGES_COLD_START);
  } else {
    query = query
      .order("created_at", { ascending: true })
      .limit(FLUSH_MAX_MESSAGES)
      .gt("created_at", state.lastFlushedAt as string);
  }
  const { data: messagesData, error: messagesErr } = await query;
  if (messagesErr) throw messagesErr;
  let messages = (messagesData ?? []) as Array<{
    id: string;
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    created_at: string;
  }>;
  if (isColdStart) {
    messages = messages.slice().reverse();
  }

  if (messages.length < minNewMessages) {
    void logMemorySkip({
      sessionId,
      userId,
      reason: `below_min(${messages.length}<${minNewMessages})`,
      note: `cold_start=${isColdStart}`,
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: `below_min(${messages.length}<${minNewMessages})`,
      watermarkAdvanced: false,
    };
  }

  // Serializar transcript (truncando cada mensaje para evitar que un solo
  // tool output monstruoso consuma todo el contexto del extractor).
  const transcript = messages
    .map((m) => {
      const body = truncate(m.content ?? "", MESSAGE_CONTENT_TRUNCATE);
      return `[${m.role}] ${body}`;
    })
    .join("\n\n");

  const userPrompt = `TRANSCRIPT (reason=${reason}):\n\n${transcript}\n\n--- FIN ---\n\nDevuelve el array JSON.`;

  // Llamar Haiku. Si falla, NO avanzamos watermark: el siguiente disparo
  // reintenta los mismos mensajes.
  let rawText: string;
  const haikuStart = Date.now();
  try {
    const model = createCompactionModel();
    const response = await model.invoke([
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);
    const raw = (response as { content: unknown }).content;
    rawText =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((p) =>
                p && typeof p === "object" && "text" in p
                  ? String((p as { text: unknown }).text ?? "")
                  : ""
              )
              .join("")
          : String(raw ?? "");
  } catch (err) {
    console.error("[memory_flush] Haiku invocation failed:", err);
    void logMemorySkip({
      sessionId,
      userId,
      reason: "haiku_error",
      note: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: "haiku_error",
      watermarkAdvanced: false,
    };
  }
  const haikuLatency = Date.now() - haikuStart;

  const parsedArray = extractJsonArray(rawText);
  if (parsedArray === null) {
    console.warn(
      "[memory_flush] parse failed, preview:",
      rawText.slice(0, 300)
    );
    void logMemorySkip({
      sessionId,
      userId,
      reason: "parse_error",
      note: rawText.slice(0, 300),
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: "parse_error",
      watermarkAdvanced: false,
    };
  }

  const items = validateExtracted(parsedArray);
  const droppedItems = parsedArray.length - items.length;

  // Guardar con embeddings. Errores individuales NO abortan el lote:
  // conservamos lo que sí salió y al final avanzamos el watermark igual
  // (el hash evita duplicados en el próximo disparo que vuelva a extraer
  // lo mismo). Si FALLAN todos los embeddings, consideramos pérdida de
  // señal y NO avanzamos.
  let savedCount = 0;
  let embeddingFailures = 0;
  const saveItems: Array<{ type: string; content: string; inserted: boolean }> = [];
  for (const item of items) {
    try {
      const embedding = await generateEmbedding(item.content);
      const inserted = await saveMemory(db, {
        userId,
        type: item.type,
        content: item.content,
        embedding,
      });
      if (inserted) savedCount += 1;
      saveItems.push({ type: item.type, content: item.content, inserted });
    } catch (err) {
      embeddingFailures += 1;
      saveItems.push({ type: item.type, content: item.content, inserted: false });
      console.error("[memory_flush] save item failed:", err);
    }
  }
  const dedupedCount = items.length - savedCount - embeddingFailures;

  if (items.length > 0 && embeddingFailures === items.length) {
    void logMemoryFlush({
      sessionId,
      userId,
      reason,
      coldStart: isColdStart,
      load: {
        loaded: messages.length,
        cap: isColdStart ? FLUSH_MAX_MESSAGES_COLD_START : FLUSH_MAX_MESSAGES,
        since: state.lastFlushedAt,
      },
      haiku: {
        latencyMs: haikuLatency,
        rawPreview: rawText.slice(0, 300),
        transcriptChars: transcript.length,
        transcriptSample: transcript,
      },
      parse: { validItems: items.length, droppedItems },
      save: {
        saved: savedCount,
        deduped: dedupedCount,
        embeddingFailures,
        items: saveItems,
      },
      watermark: {
        advanced: false,
        lastFlushedAt: state.lastFlushedAt,
        lastFlushedMessageId: state.lastFlushedMessageId,
      },
      outcome: {
        extracted: 0,
        skipped: true,
        finalReason: "all_embeddings_failed",
      },
    }).catch(() => {});
    return {
      extracted: 0,
      skipped: true,
      reason: "all_embeddings_failed",
      watermarkAdvanced: false,
    };
  }

  // Avanzar watermark al último mensaje cargado. Esto incluye el caso de
  // lista vacía válida (el modelo dijo `[]` legítimamente) — no queremos
  // volver a procesar ese tramo.
  const lastMessage = messages[messages.length - 1];
  let watermarkAdvanced = true;
  let finalReason: string = reason;
  try {
    await updateFlushWatermark(db, sessionId, {
      lastFlushedAt: lastMessage.created_at,
      lastFlushedMessageId: lastMessage.id,
    });
  } catch (err) {
    console.error("[memory_flush] watermark update failed:", err);
    watermarkAdvanced = false;
    finalReason = "watermark_error";
  }

  void logMemoryFlush({
    sessionId,
    userId,
    reason,
    coldStart: isColdStart,
    load: {
      loaded: messages.length,
      cap: isColdStart ? FLUSH_MAX_MESSAGES_COLD_START : FLUSH_MAX_MESSAGES,
      since: state.lastFlushedAt,
    },
    haiku: {
      latencyMs: haikuLatency,
      rawPreview: rawText.slice(0, 300),
      transcriptChars: transcript.length,
      transcriptSample: transcript,
    },
    parse: { validItems: items.length, droppedItems },
    save: {
      saved: savedCount,
      deduped: dedupedCount,
      embeddingFailures,
      items: saveItems,
    },
    watermark: {
      advanced: watermarkAdvanced,
      lastFlushedAt: watermarkAdvanced ? lastMessage.created_at : state.lastFlushedAt,
      lastFlushedMessageId: watermarkAdvanced ? lastMessage.id : state.lastFlushedMessageId,
    },
    outcome: {
      extracted: savedCount,
      skipped: !watermarkAdvanced,
      finalReason,
    },
  }).catch(() => {});

  if (!watermarkAdvanced) {
    return {
      extracted: savedCount,
      skipped: false,
      reason: "watermark_error",
      watermarkAdvanced: false,
    };
  }

  return {
    extracted: savedCount,
    skipped: false,
    reason,
    watermarkAdvanced: true,
  };
}
