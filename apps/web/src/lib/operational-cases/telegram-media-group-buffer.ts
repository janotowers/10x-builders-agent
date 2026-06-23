/**
 * Buffer de consolidación de álbumes de Telegram (`media_group_id`).
 *
 * Telegram entrega cada elemento de un álbum como un update/webhook separado;
 * el caption (si lo hay) viaja sólo en el PRIMER elemento. Sin consolidación,
 * subir 6 archivos en bloque genera 6 acuses y carreras de orden con el texto.
 *
 * Estrategia: cada archivo se ingiere de inmediato (nunca se pierde) y se
 * registra aquí; tras una ventana corta de inactividad (debounce) se ejecuta UN
 * solo `onFlush` con todos los archivos del grupo. Si algún elemento traía un
 * caption de cierre ("listo"), `markReady` se propaga al flush.
 *
 * Estado en memoria de proceso: válido para el dev server (proceso Node
 * persistente). En entornos serverless multi-instancia este buffer no
 * sobrevive entre invocaciones; en ese caso cada archivo haría su propio flush
 * (degradación aceptable). Documentado a propósito.
 */

export interface MediaGroupBufferedFile {
  originalName: string | null | undefined;
  kind: string | null | undefined;
}

export interface MediaGroupFlushPayload {
  chatId: number;
  caseId: string;
  files: MediaGroupBufferedFile[];
  markReady: boolean;
}

interface MediaGroupState {
  chatId: number;
  caseId: string;
  files: MediaGroupBufferedFile[];
  markReady: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onFlush: (payload: MediaGroupFlushPayload) => Promise<void>;
}

const DEFAULT_WINDOW_MS = 2500;

const buffers = new Map<string, MediaGroupState>();

function bufferKey(chatId: number, mediaGroupId: string): string {
  return `${chatId}:${mediaGroupId}`;
}

/**
 * Registra un archivo ya ingerido en el buffer de su álbum y (re)agenda el
 * flush consolidado. Devuelve `true` siempre que el archivo quedó bufferizado
 * (el caller NO debe enviar acuse individual en ese caso).
 */
export function bufferMediaGroupFile(params: {
  chatId: number;
  mediaGroupId: string;
  caseId: string;
  file: MediaGroupBufferedFile;
  markReady: boolean;
  onFlush: (payload: MediaGroupFlushPayload) => Promise<void>;
  windowMs?: number;
}): void {
  const key = bufferKey(params.chatId, params.mediaGroupId);
  let state = buffers.get(key);
  if (!state) {
    state = {
      chatId: params.chatId,
      caseId: params.caseId,
      files: [],
      markReady: false,
      timer: null,
      onFlush: params.onFlush,
    };
    buffers.set(key, state);
  }
  state.caseId = params.caseId;
  state.files.push(params.file);
  if (params.markReady) state.markReady = true;
  // Conserva el flush más reciente (todos comparten el mismo contexto de envío).
  state.onFlush = params.onFlush;

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    buffers.delete(key);
    const payload: MediaGroupFlushPayload = {
      chatId: state!.chatId,
      caseId: state!.caseId,
      files: state!.files,
      markReady: state!.markReady,
    };
    void Promise.resolve(state!.onFlush(payload)).catch((error) => {
      console.error("[telegram-media-group-buffer] flush failed:", error);
    });
  }, params.windowMs ?? DEFAULT_WINDOW_MS);
}

/** Sólo para tests: limpia el estado global del buffer. */
export function __resetMediaGroupBufferForTests(): void {
  for (const state of buffers.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  buffers.clear();
}
