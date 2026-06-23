/**
 * Capa común de colección documental para casos operacionales.
 *
 * Fuente única de verdad para el "protocolo" de documentos de propiedad,
 * compartida por TODOS los canales (Telegram interno/externo, chat web, panel)
 * y por el tick del agente. Concentra:
 *
 *   - La lista canónica de documentos requeridos (`REQUIRED_PROPERTY_DOCUMENTS`).
 *   - El checklist en texto (`buildDocumentChecklistLines`) que reutilizan el
 *     prompt determinístico, el tick E2E y la skill.
 *   - El acuse de recibo por archivo (`buildDocumentReceivedAck`) con nombre del
 *     archivo y pista por tipo, idéntico para interno y externo.
 *   - La detección de texto lateral de subida (`looksLikeDocumentUploadSideText`)
 *     —captions tipo "documentos adjuntos"— para no enrutarlo como mensaje
 *     conversacional ambiguo.
 *
 * Es agnóstico de canal y NO envía mensajes ni toca la base de datos: sólo
 * compone texto y clasifica intención. La ingestión real vive en
 * `case-document-ingestion.ts` y la transición de lote en
 * `document-batch-completion.ts` (ambas re-exportadas aquí como punto único de
 * entrada documental).
 */

export {
  completeDocumentBatchForCase,
  looksLikeDocumentBatchComplete,
  type DocumentBatchCompletionResult,
  type DocumentBatchCompletionStatus,
} from "./document-batch-completion";

export interface RequiredPropertyDocument {
  /** Coincide con la salida de `inferCaseDocumentKind` cuando aplica. */
  key: string;
  /** Etiqueta legible para el checklist (sin viñeta). */
  label: string;
  /** Indispensable para avanzar a extracción. */
  blocking: boolean;
  /** Pista corta de para qué se usa; `null` si no aplica. */
  hint: string | null;
}

/**
 * Lista canónica de documentos de propiedad. El orden refleja la prioridad de
 * comunicación: primero el bloqueante, luego los ideales.
 */
export const REQUIRED_PROPERTY_DOCUMENTS: RequiredPropertyDocument[] = [
  {
    key: "escritura_descripcion",
    label:
      "Escritura: primera hoja o sección donde esté la descripción de la propiedad, y última hoja si la tienes a la mano",
    blocking: true,
    hint: "La revisaré como soporte legal de la propiedad.",
  },
  {
    key: "boleta_registral",
    label: "Boleta registral",
    blocking: false,
    hint: "La usaré como referencia principal para validar titularidad.",
  },
  {
    key: "predial",
    label: "Último recibo de predial",
    blocking: false,
    hint: "La usaré para validar superficies de terreno y construcción.",
  },
  {
    key: "ine",
    label: "Identificación oficial (anverso y reverso)",
    blocking: false,
    hint: null,
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante de domicilio (≤ 3 meses)",
    blocking: false,
    hint: "Lo usaré para corroborar domicilio y titularidad cuando aplique.",
  },
];

/** Frase breve de privacidad para los mensajes de solicitud documental. */
export const DOCUMENT_PRIVACY_LINE =
  "Solo se usan para verificar la propiedad y armar el contrato; no se comparten sin tu autorización.";

/**
 * Bullets del checklist documental. `markBlocking` añade la nota de
 * indispensable al documento bloqueante (default `true`).
 */
export function buildDocumentChecklistLines(options?: {
  markBlocking?: boolean;
}): string[] {
  const markBlocking = options?.markBlocking ?? true;
  return REQUIRED_PROPERTY_DOCUMENTS.map((doc) => {
    const suffix =
      markBlocking && doc.blocking ? " (indispensable para avanzar)" : "";
    return `• ${doc.label}${suffix}`;
  });
}

const DOCUMENT_HINT_BY_KIND: Record<string, string | null> = {
  boleta_registral: "La usaré como referencia principal para validar titularidad.",
  predial: "La usaré para validar superficies de terreno y construcción.",
  escritura_descripcion: "La revisaré como soporte legal de la propiedad.",
  escritura_primera_hoja: "La revisaré como soporte legal de la propiedad.",
  escritura_ultima_hoja: "La revisaré como soporte legal de la propiedad.",
  comprobante_domicilio:
    "Lo usaré para corroborar domicilio y titularidad cuando aplique.",
};

/** Pista por tipo de documento; `null` si no hay una específica. */
export function documentKindHint(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return DOCUMENT_HINT_BY_KIND[kind] ?? null;
}

function describeReceivedFile(originalName: string | null | undefined): string {
  const trimmed = originalName?.trim();
  return trimmed ? `el archivo «${trimmed}»` : "el archivo";
}

/**
 * Acuse de recibo de un documento, idéntico para canal interno y externo.
 * Incluye el nombre del archivo y la pista de uso por tipo cuando existe, y
 * recuerda confirmar con "listo" al terminar.
 */
export function buildDocumentReceivedAck(params: {
  originalName: string | null | undefined;
  kind: string | null | undefined;
  /** Reservado para futuras variantes de canal; hoy el copy es común. */
  channel?: "web" | "telegram";
}): string {
  const hint = documentKindHint(params.kind);
  return [
    `Recibí ${describeReceivedFile(params.originalName)}, gracias. Lo registré en el caso.`,
    hint ? ` ${hint}` : "",
    ' Cuando termines de enviar los documentos, responde "listo" para procesarlos.',
  ].join("");
}

/**
 * Acuse consolidado para un envío en bloque (álbum de Telegram / varios
 * archivos con un solo caption). Resume cuántos documentos llegaron y los
 * nombres, en un único mensaje, en vez de un acuse por archivo.
 */
export function buildMediaGroupReceivedAck(
  files: Array<{
    originalName: string | null | undefined;
    kind?: string | null | undefined;
  }>,
  options?: { expectMore?: boolean }
): string {
  const detailLines = files
    .map((file) => {
      const name = file.originalName?.trim();
      if (!name) return null;
      const hint = documentKindHint(file.kind);
      return hint ? `• «${name}» — ${hint}` : `• «${name}»`;
    })
    .filter((line): line is string => Boolean(line));
  const count = files.length;
  const noun = count === 1 ? "documento" : "documentos";
  const namesLine = detailLines.length > 0 ? detailLines.join("\n") : null;
  const verb = count === 1 ? "lo" : "los";
  const expectMore = options?.expectMore !== false;
  return [
    `Recibí ${count} ${noun} y ${verb} registré en el caso.`,
    namesLine,
    expectMore
      ? 'Cuando termines de enviar todo lo disponible, escribe «listo» para procesarlos.'
      : "Gracias por confirmar el cierre del envío. Continuaré con el procesamiento.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function normalizeSideText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta texto "lateral" que acompaña una subida de documentos (caption de un
 * envío, o un mensaje suelto tipo "documentos adjuntos", "ahí van los archivos").
 * NO debe disparar desambiguación multi-caso ni delegarse al LLM.
 *
 * Conservador a propósito: excluye "listo" (eso lo maneja
 * `looksLikeDocumentBatchComplete`) y frases largas.
 */
export function looksLikeDocumentUploadSideText(value: string): boolean {
  const text = normalizeSideText(value);
  if (!text) return false;
  if (text.length > 80) return false;

  const mentionsDocuments =
    /\b(documento|documentos|archivo|archivos|adjunto|adjuntos|anexo|anexos|escritura|predial|boleta|identificacion|ine|comprobante)\b/.test(
      text
    );
  // Raíces con `\\w*` para cubrir conjugaciones: adjunt(o/os/é/ar/ando),
  // anex(o/ar/ando), compart(o/í/imos), envi(o/é/ados), mand(o/é/ados)... El bug
  // previo usaba `\\badjunt\\b`, que NO matchea "adjunto" porque la frontera de
  // palabra final cae tras "adjunt" y la "o" la rompe.
  const looksLikeDelivery =
    /\b(?:adjunt\w*|anex\w*|compart\w*|envi(?:o|e|amos|ad\w*)|mand(?:o|e|amos|ad\w*)|aqui (?:van|estan|tienes)|ahi (?:van|te van|le van)|te (?:los |las )?(?:mando|envio|envie|paso))\b/.test(
      text
    );

  if (mentionsDocuments && looksLikeDelivery) return true;
  // Frases muy cortas e inequívocas de entrega documental.
  if (/^(documentos?|archivos?)( adjuntos?| anexos?)?$/.test(text)) return true;
  return false;
}
