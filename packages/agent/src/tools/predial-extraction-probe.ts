import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import { extractPredialSurfacesFromTextForTest, normalizePredialExtractionSurfacesForTest } from "./operational-cases-adapters";

const VISION_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const PDF_TEXT_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const DOCUMENT_EXTRACTION_JSON_SHAPE =
  '{"document_kind":string,"property_description":string|null,"address":object|null,"area_total_m2":number|null,"area_construida_m2":number|null,"owner_names":string[],"folio_real":string|null,"predial_account":string|null,"confidence":"high"|"medium"|"low","warnings":string[]}';
const PREDIAL_VISION_EXTRACTION_JSON_SHAPE =
  `${DOCUMENT_EXTRACTION_JSON_SHAPE.slice(0, -1)},"predial_contribuyente_row_values":string[],"sup_terr_raw":string|null,"sup_const_raw":string|null}`;
const PROPERTY_AREA_EXTRACTION_GUIDANCE =
  "En escrituras mexicanas, area_total_m2 debe capturar la superficie total/privativa del inmueble cuando aparezca como 'superficie total de X metros cuadrados', 'superficie privativa', 'area privativa' o 'superficie del terreno'. No uses medidas de linderos/colindancias como area_total_m2. area_construida_m2 debe llenarse cuando el texto diga construccion/superficie construida. En recibos prediales mexicanos (p. ej. Jalisco/Zapopan), mapea SUP. TERR o superficie de terreno a area_total_m2 y SUP. CONST o superficie construida a area_construida_m2 cuando aparezcan en tabla o renglón de valores.";
const PREDIAL_VISION_TABLE_GUIDANCE =
  " En recibos prediales, localiza la seccion DATOS DEL CONTRIBUYENTE. Copia literalmente la fila de valores bajo las columnas TIPO, SUP. TERR, SUP. CONST (y columnas vecinas visibles) en predial_contribuyente_row_values en orden izquierda a derecha (ej. [\"U\",\"138.00\",\"146.00\",\"0.00\",\"0.00\"]). Llena sup_terr_raw y sup_const_raw con el texto exacto visible bajo SUP. TERR y SUP. CONST. Importante: 146.00 significa 146 metros cuadrados, no 14.6; conserva todos los digitos antes del punto decimal.";

const DEFAULT_PREDIAL_PATH = resolve(
  process.cwd(),
  "../../../Documents/Ungga/Desarrollo de Producto/Gu Personal & Work Assistant (Open Claw inspired)/Caso para flujo de Opcionar Propiedad/CASA FUENTES OPCION/PREDIAL 2023.pdf"
);

function loadOpenRouterApiKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  const envPaths = [
    resolve(process.cwd(), "../../apps/web/.env.local"),
    resolve(process.cwd(), "../apps/web/.env.local"),
    resolve(process.cwd(), "apps/web/.env.local"),
  ];
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    const match = readFileSync(envPath, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  throw new Error("OPENROUTER_API_KEY not found in env or apps/web/.env.local");
}

function parseModelJson(content: string, documentKind: string) {
  try {
    return JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")) as Record<string, unknown>;
  } catch {
    return {
      document_kind: documentKind,
      confidence: "low",
      raw_text: content,
      warnings: ["El modelo no devolvió JSON parseable."],
    };
  }
}

async function callOpenRouterForJson(input: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_tokens: 900,
      messages: input.messages,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  const content = body.choices?.[0]?.message?.content;
  if (!res.ok || !content) {
    throw new Error(body.error?.message ?? `model_request_failed_${res.status}`);
  }
  return content;
}

async function extractDocumentFieldsFromImage(input: {
  apiKey: string;
  documentKind: string;
  dataUrl: string;
}) {
  const content = await callOpenRouterForJson({
    apiKey: input.apiKey,
    model: VISION_EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extrae datos inmobiliarios de documentos mexicanos. Devuelve exclusivamente JSON válido sin markdown. " +
          PROPERTY_AREA_EXTRACTION_GUIDANCE +
          PREDIAL_VISION_TABLE_GUIDANCE,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Documento tipo ${input.documentKind}. Extrae sólo lo visible con este shape: ` +
              `${PREDIAL_VISION_EXTRACTION_JSON_SHAPE}. ${PROPERTY_AREA_EXTRACTION_GUIDANCE}${PREDIAL_VISION_TABLE_GUIDANCE} No inventes datos; usa null cuando no esté visible.`,
          },
          { type: "image_url", image_url: { url: input.dataUrl } },
        ],
      },
    ],
  });
  return normalizePredialExtractionSurfacesForTest(
    parseModelJson(content, input.documentKind),
    input.documentKind
  );
}

async function extractDocumentFieldsFromText(input: {
  apiKey: string;
  documentKind: string;
  text: string;
}) {
  const content = await callOpenRouterForJson({
    apiKey: input.apiKey,
    model: PDF_TEXT_EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extrae datos inmobiliarios de documentos mexicanos a partir de texto OCR/PDF. Devuelve exclusivamente JSON válido sin markdown. " +
          PROPERTY_AREA_EXTRACTION_GUIDANCE,
      },
      {
        role: "user",
        content:
          `Documento tipo ${input.documentKind}. Extrae sólo datos presentes en el texto con este shape: ` +
          `${DOCUMENT_EXTRACTION_JSON_SHAPE}. ${PROPERTY_AREA_EXTRACTION_GUIDANCE} No inventes datos; usa null cuando no esté visible.\n\n` +
          input.text.slice(0, 24000),
      },
    ],
  });
  return parseModelJson(content, input.documentKind);
}

function summarizeSurfaces(label: string, extraction: Record<string, unknown>) {
  return {
    label,
    area_total_m2: extraction.area_total_m2 ?? null,
    area_construida_m2: extraction.area_construida_m2 ?? null,
    owner_names: extraction.owner_names ?? null,
    predial_account: extraction.predial_account ?? null,
    confidence: extraction.confidence ?? null,
    warnings: extraction.warnings ?? null,
  };
}

async function main() {
  const filePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PREDIAL_PATH;
  if (!existsSync(filePath)) {
    throw new Error(`Predial file not found: ${filePath}`);
  }
  const apiKey = loadOpenRouterApiKey();
  const bytes = readFileSync(filePath);
  const parser = new PDFParse({ data: Uint8Array.from(bytes) });
  try {
    const textResult = await parser.getText({
      first: 5,
      pageJoiner: "\n\n--- page_number of total_number ---\n\n",
    });
    const parserSurfaces = extractPredialSurfacesFromTextForTest(textResult.text);
    const textLlmExtraction = await extractDocumentFieldsFromText({
      apiKey,
      documentKind: "predial",
      text: textResult.text,
    });
    const screenshot = await parser.getScreenshot({
      first: 1,
      desiredWidth: 2400,
      imageDataUrl: true,
      imageBuffer: false,
    });
    const dataUrl = screenshot.pages[0]?.dataUrl;
    if (!dataUrl) {
      throw new Error("Could not render first page of predial PDF");
    }
    const visionExtraction = await extractDocumentFieldsFromImage({
      apiKey,
      documentKind: "predial",
      dataUrl,
    });

    const normalizedSnippet = textResult.text.replace(/\s+/g, " ").trim().slice(0, 1200);
    const supTerrIndex = normalizedSnippet.toLowerCase().indexOf("sup");
    const snippetAroundSup =
      supTerrIndex >= 0
        ? normalizedSnippet.slice(Math.max(0, supTerrIndex - 80), supTerrIndex + 420)
        : normalizedSnippet;

    const report = {
      file: filePath,
      pdf_text_length: textResult.text.replace(/\s+/g, " ").trim().length,
      pdf_text_snippet_around_sup: snippetAroundSup,
      deterministic_parser: parserSurfaces,
      llm_text_extraction: summarizeSurfaces("gpt-4o-mini on PDF text", textLlmExtraction),
      llm_vision_extraction: summarizeSurfaces(
        "gpt-4o-mini on rendered page 1",
        visionExtraction
      ),
      expected: { area_total_m2: 138, area_construida_m2: 146 },
      pass: {
        parser_terreno: parserSurfaces.area_total_m2 === 138,
        parser_construccion: parserSurfaces.area_construida_m2 === 146,
        text_llm_terreno: textLlmExtraction.area_total_m2 === 138,
        text_llm_construccion: textLlmExtraction.area_construida_m2 === 146,
        vision_terreno: visionExtraction.area_total_m2 === 138,
        vision_construccion: visionExtraction.area_construida_m2 === 146,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
