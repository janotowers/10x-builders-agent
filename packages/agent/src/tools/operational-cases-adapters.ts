/**
 * LangChain adapters para las tools del subsistema de casos operacionales:
 *   - operational_case_update_intake
 *   - operational_case_update_state
 *   - operational_case_add_event
 *   - notify_user
 *
 * Estas tools sólo son visibles cuando hay un caso activo (canal
 * `case_runner` o cuando el agente lo invoca desde un turno web/Telegram
 * con `case_id` en contexto). El agente las usa para mover el estado del
 * caso y avisar al humano interno.
 */
import { tool } from "@langchain/core/tools";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import {
  updateToolCallStatus,
  createOperationalCaseDocument,
  createOperationalCase,
  findExtractedOperationalCaseDocumentByHash,
  getOperationalCaseDocument,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOperationalCaseTypeForUser,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCaseDocumentExtraction,
  updateOperationalCase,
} from "@agents/db";
import {
  buildComparablesAnalysisFromToolCalls,
  comparablesHasDefensibleSample,
  normalizeComparablesAnalysisForInsufficientN4Test,
  validateComparablesAnalysisArtifact,
} from "../operational-cases/comparables-analysis";
import type {
  OperationalCaseActivationPolicy,
  OperationalCaseDocument,
  OperationalCaseExternalContact,
  OperationalCaseFlowStep,
  OperationalCaseIntakeField,
} from "@agents/types";
import type { ToolContext } from "./tool-context";
import { createTrackedToolCall } from "./tool-call-audit";

const STATUS_VALUES = [
  "active",
  "waiting_internal",
  "waiting_external",
  "paused",
  "completed",
  "failed",
] as const;

const ACTOR_VALUES = ["system", "agent", "user", "external"] as const;
const EVENT_TYPE_VALUES = [
  "step_completed",
  "reminder_sent",
  "escalated",
  "human_decision",
  "external_response",
  "error",
] as const;

type PersistedToolCallRow = {
  tool_name: string;
  status: string;
  arguments_json?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  created_at?: string | null;
};

function normalizeExternalContactPatch(
  value: Record<string, unknown> | undefined
): OperationalCaseExternalContact | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  return value as OperationalCaseExternalContact;
}

function mergeExternalContactPatch(
  existing: unknown,
  patch: Record<string, unknown> | undefined
): OperationalCaseExternalContact | undefined {
  const normalizedPatch = normalizeExternalContactPatch(patch);
  if (!normalizedPatch) return undefined;
  const existingContact =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...existingContact,
    ...normalizedPatch,
  } as OperationalCaseExternalContact;
}

function contextString(
  context: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = context?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePropertyDataValue(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim()
    : "";
}

function propertyDataRecord(context: Record<string, unknown>) {
  const value = context.property_data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstMeaningfulValue(...values: unknown[]) {
  return values.find((value) => hasMeaningfulValue(value));
}

function hasMeaningfulValue(
  value: unknown,
  options?: { allowZero?: boolean }
): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && (options?.allowZero ? value >= 0 : value > 0);
  }
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulValue(item, options));
  }
  if (typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulValue(item, options));
  }
  return false;
}

function valueAtPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, source);
}

function hasAnyPath(
  source: Record<string, unknown>,
  paths: string[],
  options?: { allowZero?: boolean }
): boolean {
  return paths.some((path) =>
    hasMeaningfulValue(valueAtPath(source, path), options)
  );
}

type PropertyDataRequirement = {
  key: string;
  label: string;
  paths: string[];
  question: string;
  allowZero?: boolean;
};

type PropertyDataMinimumsResult = {
  ok: boolean;
  propertyType: string;
  missing: Array<Pick<PropertyDataRequirement, "key" | "label" | "question">>;
};

function displayValue(value: unknown): string | null {
  if (!hasMeaningfulValue(value, { allowZero: true })) return null;
  if (Array.isArray(value)) {
    const values = value.map((item) => displayValue(item)).filter(Boolean);
    return values.length > 0 ? values.join("; ") : null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      displayValue(record.full) ??
      displayValue(record.formatted) ??
      displayValue(record.street) ??
      null
    );
  }
  return String(value).trim();
}

const COMMON_PROPERTY_DATA_REQUIREMENTS: PropertyDataRequirement[] = [
  {
    key: "owner_names",
    label: "Nombre(s) de dueño",
    paths: ["owner_names", "owner_name", "owners", "owner.name"],
    question: "Nombre(s) de dueño o titulares de la propiedad.",
  },
  {
    key: "property_address",
    label: "Dirección de la propiedad",
    paths: [
      "address.full",
      "address.street",
      "legal_address",
      "legal_addresses",
      "property_address",
      "location.address",
    ],
    question: "Dirección completa de la propiedad.",
  },
  {
    key: "area_total_m2",
    label: "Superficie / metros cuadrados",
    paths: [
      "area_total_m2",
      "area_m2",
      "surface_m2",
      "superficie_m2",
      "land_area_m2",
      "lot_area_m2",
    ],
    question: "Superficie o metraje total en metros cuadrados.",
  },
];

const PROPERTY_TYPE_REQUIREMENTS: Record<string, PropertyDataRequirement[]> = {
  casa: [
    {
      key: "area_construida_m2",
      label: "Metros cuadrados de construcción",
      paths: ["area_construida_m2", "construction_area_m2", "built_area_m2"],
      question: "Metros cuadrados de construcción.",
    },
    {
      key: "floors",
      label: "Número de plantas/pisos",
      paths: ["floors", "floor_count", "levels", "stories"],
      question: "Número de plantas o pisos.",
    },
    {
      key: "bedrooms",
      label: "Recámaras",
      paths: ["bedrooms", "recamaras", "habitaciones"],
      question: "Número de recámaras.",
    },
    {
      key: "bathrooms",
      label: "Baños completos",
      paths: ["bathrooms", "full_bathrooms", "banos_completos"],
      question: "Número de baños completos.",
    },
    {
      key: "half_bathrooms",
      label: "Medios baños",
      paths: ["half_bathrooms", "half_baths", "medios_banos"],
      question: "Número de medios baños.",
      allowZero: true,
    },
    {
      key: "integral_kitchen",
      label: "Cocina integral",
      paths: ["integral_kitchen", "has_integral_kitchen", "cocina_integral"],
      question: "Si tiene cocina integral (sí/no).",
    },
  ],
  departamento: [
    {
      key: "bedrooms",
      label: "Recámaras",
      paths: ["bedrooms", "recamaras", "habitaciones"],
      question: "Número de recámaras.",
    },
    {
      key: "bathrooms",
      label: "Baños completos",
      paths: ["bathrooms", "full_bathrooms", "banos_completos"],
      question: "Número de baños completos.",
    },
    {
      key: "half_bathrooms",
      label: "Medios baños",
      paths: ["half_bathrooms", "half_baths", "medios_banos"],
      question: "Número de medios baños.",
      allowZero: true,
    },
    {
      key: "parking_spots",
      label: "Cajones de estacionamiento",
      paths: ["parking_spots", "parking", "parking_spaces", "cajones"],
      question: "Número de cajones de estacionamiento.",
      allowZero: true,
    },
    {
      key: "floor_number",
      label: "Piso del departamento",
      paths: ["floor_number", "apartment_floor", "piso"],
      question: "En qué piso está el departamento.",
    },
    {
      key: "has_elevator",
      label: "Elevador",
      paths: ["has_elevator", "elevator", "elevador"],
      question: "Si el edificio tiene elevador (sí/no).",
    },
    {
      key: "amenities",
      label: "Amenidades",
      paths: ["amenities", "amenidades"],
      question: "Amenidades del edificio, si tiene.",
    },
  ],
  terreno: [
    {
      key: "land_context",
      label: "Coto / condominio / parque industrial",
      paths: [
        "land_context",
        "is_in_gated_community",
        "in_gated_community",
        "gated_community",
        "coto",
        "condominio",
        "industrial_park",
        "in_industrial_park",
      ],
      question:
        "Si el terreno está en coto/condominio/parque industrial o es independiente.",
    },
  ],
  bodega: [
    {
      key: "warehouse_area_m2",
      label: "Metros cuadrados de bodega",
      paths: ["warehouse_area_m2", "bodega_area_m2", "area_total_m2"],
      question: "Metros cuadrados de la bodega/nave.",
    },
    {
      key: "warehouse_height_m",
      label: "Altura",
      paths: ["warehouse_height_m", "height_m", "altura_m"],
      question: "Altura de la bodega/nave.",
    },
    {
      key: "office_area_m2",
      label: "Espacio de oficinas",
      paths: ["office_area_m2", "office_space_m2", "has_office_space"],
      question: "Metros cuadrados de oficinas, o confirmar si no aplica.",
    },
    {
      key: "bathrooms",
      label: "Baños",
      paths: ["bathrooms", "full_bathrooms", "banos"],
      question: "Número de baños.",
    },
    {
      key: "parking_spots",
      label: "Cajones de estacionamiento",
      paths: ["parking_spots", "parking", "parking_spaces", "cajones"],
      question: "Número de cajones/estacionamientos.",
      allowZero: true,
    },
    {
      key: "kva",
      label: "KVA",
      paths: ["kva", "power_kva", "electric_capacity_kva"],
      question: "Capacidad eléctrica en KVA.",
    },
    {
      key: "has_transformer",
      label: "Transformador",
      paths: ["has_transformer", "transformer", "transformador"],
      question: "Si tiene transformador (sí/no).",
    },
  ],
};

PROPERTY_TYPE_REQUIREMENTS["nave industrial"] = PROPERTY_TYPE_REQUIREMENTS.bodega;
PROPERTY_TYPE_REQUIREMENTS["nave"] = PROPERTY_TYPE_REQUIREMENTS.bodega;

function propertyTypeRequirementKey(value: unknown) {
  const normalized = normalizePropertyDataValue(value);
  if (/\b(casa|residencia)\b/.test(normalized)) return "casa";
  if (/\b(departamento|depto|apartment)\b/.test(normalized)) return "departamento";
  if (/\b(terreno|lote|land)\b/.test(normalized)) return "terreno";
  if (/\b(bodega|nave industrial|nave)\b/.test(normalized)) return "bodega";
  return normalized;
}

export function evaluatePropertyDataMinimumsForReview(
  context: Record<string, unknown> | null | undefined,
  supplement: Record<string, unknown> = {}
): PropertyDataMinimumsResult {
  const safeContext = context ?? {};
  const propertyData = propertyDataRecord(safeContext);
  const merged = { ...safeContext, ...propertyData, ...supplement };
  const propertyType =
    propertyTypeRequirementKey(
      propertyData.property_type ?? safeContext.property_type
    ) || "desconocido";
  const requirements = [
    ...COMMON_PROPERTY_DATA_REQUIREMENTS,
    ...(PROPERTY_TYPE_REQUIREMENTS[propertyType] ?? []),
  ];
  const missing = requirements
    .filter(
      (requirement) =>
        !hasAnyPath(merged, requirement.paths, {
          allowZero: requirement.allowZero,
        })
    )
    .map(({ key, label, question }) => ({ key, label, question }));
  return { ok: missing.length === 0, propertyType, missing };
}

export function buildPropertyDataMinimumsSummaryMessage(params: {
  context: Record<string, unknown> | null | undefined;
  supplement?: Record<string, unknown>;
  missing: Array<Pick<PropertyDataRequirement, "key" | "label" | "question">>;
}) {
  const safeContext = params.context ?? {};
  const propertyData = propertyDataRecord(safeContext);
  const merged = { ...safeContext, ...propertyData, ...(params.supplement ?? {}) };
  const knownLines = [
    displayValue(safeContext.property_title)
      ? `- Título / propiedad: ${displayValue(safeContext.property_title)}`
      : null,
    displayValue(safeContext.property_zone)
      ? `- Zona / colonia: ${displayValue(safeContext.property_zone)}`
      : null,
    displayValue(safeContext.operation_type)
      ? `- Operación: ${displayValue(safeContext.operation_type)}`
      : null,
    displayValue(safeContext.property_type ?? propertyData.property_type)
      ? `- Tipo de propiedad: ${displayValue(
          safeContext.property_type ?? propertyData.property_type
        )}`
      : null,
    displayValue(merged.owner_names)
      ? `- Dueño/titular: ${displayValue(merged.owner_names)}`
      : null,
    displayValue(merged.legal_addresses ?? merged.legal_address ?? merged.property_address ?? merged.address)
      ? `- Dirección encontrada: ${displayValue(
          merged.legal_addresses ??
            merged.legal_address ??
            merged.property_address ??
            merged.address
        )}`
      : null,
    displayValue(merged.area_total_m2)
      ? `- Superficie encontrada: ${displayValue(merged.area_total_m2)} m²`
      : null,
  ].filter((line): line is string => Boolean(line));
  const missingLines = params.missing.map(
    (item, index) => `${index + 1}. ${item.question}`
  );

  return [
    "Ya tengo estos datos del caso:",
    "",
    ...(knownLines.length > 0 ? knownLines : ["- Sin datos consolidados todavía."]),
    "",
    "Para completar los datos mínimos antes de la revisión, por favor confirma:",
    "",
    ...missingLines,
  ].join("\n");
}

function isPropertyDocumentForMinimums(document: OperationalCaseDocument) {
  const normalized = normalizePropertyDataValue(
    [
      document.kind,
      document.display_name,
      document.original_name,
      document.extraction_jsonb?.document_kind,
    ]
      .filter(Boolean)
      .join(" ")
  );
  return (
    /escritura|descripcion|descriptiva|testimonio|(?:^|[^a-z])esc(?:[^a-z]|$)|desdeesc|predial|boleta|registral|folio real/.test(
      normalized
    )
  );
}

export function documentExtractionMinimumsContext(
  documents: OperationalCaseDocument[]
): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  const ownerNames: unknown[] = [];
  const legalAddresses: unknown[] = [];

  for (const document of documents) {
    if (
      document.status === "superseded" ||
      !["ok", "low_confidence"].includes(document.extraction_status)
    ) {
      continue;
    }
    const extraction = document.extraction_jsonb ?? {};
    if (!hasMeaningfulValue(extraction)) continue;
    const propertyDocument = isPropertyDocumentForMinimums(document);

    if (propertyDocument && !hasMeaningfulValue(extracted.area_total_m2)) {
      const area = firstMeaningfulValue(
        extraction.area_total_m2,
        extraction.area_m2,
        extraction.surface_m2,
        extraction.superficie_m2
      );
      if (area != null) extracted.area_total_m2 = area;
    }
    if (propertyDocument && !hasMeaningfulValue(extracted.area_construida_m2)) {
      const builtArea = firstMeaningfulValue(
        extraction.area_construida_m2,
        extraction.construction_area_m2,
        extraction.built_area_m2
      );
      if (builtArea != null) extracted.area_construida_m2 = builtArea;
    }

    if (Array.isArray(extraction.owner_names)) {
      ownerNames.push(...extraction.owner_names);
    } else if (hasMeaningfulValue(extraction.owner_name)) {
      ownerNames.push(extraction.owner_name);
    }

    if (propertyDocument && isRecord(extraction.address)) {
      extracted.address = {
        ...(isRecord(extracted.address) ? extracted.address : {}),
        ...extraction.address,
      };
      const addressText = firstMeaningfulValue(
        extraction.address.full,
        extraction.address.formatted,
        extraction.address.street
      );
      if (addressText) legalAddresses.push(addressText);
    }
    if (propertyDocument) {
      for (const value of [
        extraction.legal_address,
        extraction.property_address,
        extraction.address_text,
      extraction.property_description,
      ]) {
        if (hasMeaningfulValue(value)) legalAddresses.push(value);
      }
    }
  }

  const uniqueOwners = [...new Set(ownerNames.map(String).map((value) => value.trim()))]
    .filter(Boolean);
  const uniqueAddresses = [
    ...new Set(legalAddresses.map(String).map((value) => value.trim())),
  ].filter(Boolean);
  if (uniqueOwners.length > 0) extracted.owner_names = uniqueOwners;
  if (uniqueAddresses.length > 0) extracted.legal_addresses = uniqueAddresses;
  return extracted;
}

function sanitizeExtractedReviewDetails(text: string) {
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/^\s*datos extra[ií]dos(?: de documentos)?:\s*/gim, "")
    .split("\n")
    .filter((line) => {
      const normalized = normalizePropertyDataValue(line);
      return !/^[-•]?\s*(tipo|operacion|operación|zona)\s*:/.test(normalized);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

export function canonicalizePropertyDataReviewText(
  opCase: Awaited<ReturnType<typeof getOperationalCase>> | null,
  text: string
) {
  if (!opCase) return text;
  const context = opCase.context_jsonb ?? {};
  const title = contextString(context, "property_title");
  const zone = contextString(context, "property_zone");
  const operation = contextString(context, "operation_type");
  const propertyType = contextString(context, "property_type");
  if (!title && !zone && !operation && !propertyType) return text;

  const cleaned = text.replace(/\*\*/g, "").trim();
  const extractedStart = cleaned.search(/Direcci[oó]n Legal:|Datos extra[ií]dos/i);
  const extractedDetails =
    extractedStart >= 0
      ? sanitizeExtractedReviewDetails(cleaned.slice(extractedStart))
      : sanitizeExtractedReviewDetails(cleaned);

  return [
    `Revisión de datos extraídos para el caso ${opCase.id}:`,
    "",
    "Datos confirmados por intake:",
    title ? `- Título / propiedad: ${title}` : null,
    zone ? `- Zona / colonia: ${zone}` : null,
    operation ? `- Operación: ${operation}` : null,
    propertyType ? `- Tipo de propiedad: ${propertyType}` : null,
    "",
    "Datos encontrados en documentos:",
    extractedDetails ||
      "- No se incluyeron datos documentales específicos en el mensaje del agente.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const VISION_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const PDF_TEXT_EXTRACTION_MODEL = "openai/gpt-4o-mini";
const DOCUMENT_EXTRACTION_JSON_SHAPE =
  '{"document_kind":string,"property_description":string|null,"address":object|null,"area_total_m2":number|null,"area_construida_m2":number|null,"owner_names":string[],"folio_real":string|null,"predial_account":string|null,"confidence":"high"|"medium"|"low","warnings":string[]}';
const PROPERTY_AREA_EXTRACTION_GUIDANCE =
  "En escrituras mexicanas, area_total_m2 debe capturar la superficie total/privativa del inmueble cuando aparezca como 'superficie total de X metros cuadrados', 'superficie privativa', 'area privativa' o 'superficie del terreno'. No uses medidas de linderos/colindancias como area_total_m2. area_construida_m2 solo debe llenarse cuando el texto diga construccion/superficie construida.";
const requireFromHere = createRequire(import.meta.url);
const requireFromCwd = createRequire(`${process.cwd()}/__pdf-resolver.js`);
let pdfWorkerConfigured = false;

/**
 * Resuelve la ruta del worker de pdfjs-dist y la registra vía
 * `PDFParse.setWorker`. Construimos los specs de forma dinámica (joins en
 * arreglo) para que Turbopack/webpack no los analicen estáticamente y
 * traten de bundlear el .mjs (lo cual rompe el resolver en runtime). Como
 * `pdf-parse` se marca como `serverExternalPackages`, pdf.js suele encontrar
 * el worker por sí mismo (adyacente a `pdf.mjs`); esta función es defensa en
 * profundidad para entornos donde la resolución por defecto falla.
 */
function ensurePdfWorkerConfigured() {
  if (pdfWorkerConfigured) return;
  pdfWorkerConfigured = true;
  const pkg = ["pdfjs-dist"].join("");
  const specs = [
    [pkg, "legacy", "build", "pdf.worker.mjs"].join("/"),
    [pkg, "build", "pdf.worker.mjs"].join("/"),
  ];
  const candidates: string[] = [];
  for (const resolver of [requireFromHere, requireFromCwd]) {
    for (const spec of specs) {
      try {
        candidates.push(resolver.resolve(spec));
      } catch {
        // resolver no puede; continuamos con el siguiente intento
      }
    }
  }
  for (const candidate of candidates) {
    try {
      PDFParse.setWorker(pathToFileURL(candidate).toString());
      return;
    } catch {
      // intentamos con el siguiente candidato
    }
  }
}

function parseModelJson(content: string, documentKind: string): Record<string, unknown> {
  try {
    return JSON.parse(content.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    return {
      document_kind: documentKind,
      confidence: "low",
      raw_text: content,
      warnings: ["El modelo no devolvió JSON parseable."],
    };
  }
}

function parseLocalizedNumber(value: string) {
  const normalized = value.replace(/\s+/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

const SPANISH_SMALL_NUMBERS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  dieciséis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintidós: 22,
  veintitres: 23,
  veintitrés: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintiséis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
};

function parseSpanishNumberBelow200(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter((word) => word !== "y")
    .filter(Boolean);
  let total = 0;
  for (const word of words) {
    const number = SPANISH_SMALL_NUMBERS[word];
    if (typeof number !== "number") return null;
    total += number;
  }
  return total > 0 ? total : null;
}

function spanishNumberWordsBeforePunto(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const selected: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (word === "y" || SPANISH_SMALL_NUMBERS[word] !== undefined) {
      selected.unshift(word);
      continue;
    }
    if (selected.length > 0) break;
  }
  return selected.join(" ");
}

function spanishNumberWordsAfterPunto(value: string) {
  const words = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const selected: string[] = [];
  for (const word of words) {
    if (word === "y" || SPANISH_SMALL_NUMBERS[word] !== undefined) {
      selected.push(word);
      continue;
    }
    if (selected.length > 0) break;
  }
  return selected.join(" ");
}

function parseSpanishDecimalSurface(value: string) {
  const match = value.match(/\bpunto\b/i);
  if (!match || match.index === undefined) return null;
  const integerText = spanishNumberWordsBeforePunto(value.slice(0, match.index));
  const decimalText = spanishNumberWordsAfterPunto(
    value.slice(match.index + match[0].length)
  );
  const integer = parseSpanishNumberBelow200(integerText);
  const decimal = parseSpanishNumberBelow200(decimalText);
  if (integer === null || decimal === null) return null;
  return Number(`${integer}.${String(decimal).padStart(2, "0")}`);
}

function normalizeOcrDigits(value: string) {
  return value
    .replace(/(?<=\b)[iíl|](?=\d)/gi, "1")
    .replace(/(?<=\d)[iíl|](?=\d|\b)/gi, "1")
    .replace(/(?<=\d)[oO](?=\d|\b)/g, "0")
    .replace(/(?<=\d)[sS](?=\d|\b)/g, "5");
}

export function extractSurfaceTotalM2FromTextForTest(text: string) {
  const normalized = normalizeOcrDigits(text.replace(/\s+/g, " "));
  const numberPattern = "([0-9]{1,5}(?:\\s*[.,]\\s*[0-9]{1,3})?)";
  const patterns = [
    new RegExp(
      `(?:superficie|area|área)\\s+(?:total|privativa|del\\s+terreno|de\\s+terreno|de\\s+la\\s+unidad|del\\s+inmueble)[^0-9]{0,140}${numberPattern}[^\\n]{0,160}(?:m2|m²|metros?\\s+cuadrados?)`,
      "i"
    ),
    new RegExp(
      `cuenta\\s+con\\s+una\\s+(?:superficie|area|área)\\s+total\\s+de[^0-9]{0,140}${numberPattern}[^\\n]{0,160}(?:m2|m²|metros?\\s+cuadrados?)`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const parsed = match?.[1] ? parseLocalizedNumber(match[1]) : null;
    if (parsed && parsed > 5 && parsed < 100000) return parsed;
  }
  const surfaceWindow = normalized.match(
    /(?:superficie|area|área)\s+(?:total|privativa|del\s+terreno|de\s+terreno|de\s+la\s+unidad|del\s+inmueble)[\s\S]{0,260}(?:m2|m²|metros?\s+cuadrados?)/i
  )?.[0];
  const spelledSurface = surfaceWindow ? parseSpanishDecimalSurface(surfaceWindow) : null;
  if (spelledSurface && spelledSurface > 5 && spelledSurface < 100000) {
    return spelledSurface;
  }
  return null;
}

function enrichExtractionFromText(
  extraction: Record<string, unknown>,
  documentKind: string,
  text: string
) {
  const enriched: Record<string, unknown> = {
    ...extraction,
    document_kind: documentKind,
  };
  if (typeof enriched.area_total_m2 !== "number") {
    const areaTotalM2 = extractSurfaceTotalM2FromTextForTest(text);
    if (areaTotalM2 !== null) {
      enriched.area_total_m2 = areaTotalM2;
      enriched.area_total_m2_source = "pdf_text_surface_phrase";
    }
  }
  return enriched;
}

function isPropertyDeedKind(value: unknown) {
  return typeof value === "string" && value.toLowerCase().includes("escritura");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function needsPdfVisionSupplement(input: {
  documentKind: string;
  extraction: Record<string, unknown>;
}) {
  if (!isPropertyDeedKind(input.documentKind)) return false;
  return typeof input.extraction.area_total_m2 !== "number";
}

function mergeDocumentExtractions(
  primary: Record<string, unknown>,
  supplement: Record<string, unknown>,
  extractionSource: string
) {
  const merged: Record<string, unknown> = { ...primary };
  for (const key of [
    "area_total_m2",
    "area_construida_m2",
    "property_description",
    "folio_real",
    "predial_account",
    "area_total_m2_source",
  ] as const) {
    const primaryValue = merged[key];
    const supplementValue = supplement[key];
    if (
      (primaryValue == null || primaryValue === "") &&
      supplementValue != null &&
      supplementValue !== ""
    ) {
      merged[key] = supplementValue;
    }
  }
  const primaryOwners = Array.isArray(merged.owner_names) ? merged.owner_names : [];
  const supplementOwners = Array.isArray(supplement.owner_names)
    ? supplement.owner_names
    : [];
  if (primaryOwners.length === 0 && supplementOwners.length > 0) {
    merged.owner_names = supplementOwners;
  }
  if (isRecord(supplement.address)) {
    merged.address = {
      ...(isRecord(merged.address) ? merged.address : {}),
      ...supplement.address,
    };
  }
  const warnings = [
    ...(Array.isArray(merged.warnings) ? merged.warnings : []),
    ...(Array.isArray(supplement.warnings) ? supplement.warnings : []),
  ].filter((item, index, items) => items.indexOf(item) === index);
  if (warnings.length > 0) merged.warnings = warnings;
  merged.extraction_source = extractionSource;
  return merged;
}

async function renderPdfFirstPageDataUrl(parser: PDFParse) {
  const screenshot = await parser.getScreenshot({
    first: 1,
    desiredWidth: 1800,
    imageDataUrl: true,
    imageBuffer: false,
  });
  return screenshot.pages[0]?.dataUrl ?? null;
}

function extractionStatusFor(extraction: Record<string, unknown>) {
  const confidence =
    typeof extraction.confidence === "string" ? extraction.confidence : "low";
  return confidence === "high" || confidence === "medium" ? "ok" : "low_confidence";
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
          PROPERTY_AREA_EXTRACTION_GUIDANCE,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Documento tipo ${input.documentKind}. Extrae sólo lo visible con este shape: ` +
              `${DOCUMENT_EXTRACTION_JSON_SHAPE}. ${PROPERTY_AREA_EXTRACTION_GUIDANCE} No inventes datos; usa null cuando no esté visible.`,
          },
          { type: "image_url", image_url: { url: input.dataUrl } },
        ],
      },
    ],
  });
  return parseModelJson(content, input.documentKind);
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
  return enrichExtractionFromText(
    parseModelJson(content, input.documentKind),
    input.documentKind,
    input.text
  );
}

async function extractPdfDocumentFields(input: {
  apiKey: string;
  documentKind: string;
  bytes: Buffer;
}) {
  ensurePdfWorkerConfigured();
  const parser = new PDFParse({ data: Uint8Array.from(input.bytes) });
  try {
    const textResult = await parser.getText({
      first: 5,
      pageJoiner: "\n\n--- page_number of total_number ---\n\n",
    });
    const normalizedText = textResult.text.replace(/\s+/g, " ").trim();
    if (normalizedText.length >= 120) {
      const textExtraction = await extractDocumentFieldsFromText({
        apiKey: input.apiKey,
        documentKind: input.documentKind,
        text: textResult.text,
      });
      if (
        needsPdfVisionSupplement({
          documentKind: input.documentKind,
          extraction: textExtraction,
        })
      ) {
        const dataUrl = await renderPdfFirstPageDataUrl(parser);
        if (dataUrl) {
          const visionExtraction = enrichExtractionFromText(
            await extractDocumentFieldsFromImage({
              apiKey: input.apiKey,
              documentKind: input.documentKind,
              dataUrl,
            }),
            input.documentKind,
            textResult.text
          );
          const warnings = [
            ...(Array.isArray(textExtraction.warnings) ? textExtraction.warnings : []),
            "La capa de texto del PDF no trajo superficie; se complementó con visión sobre la primera página.",
          ];
          return {
            model: VISION_EXTRACTION_MODEL,
            extraction: {
              ...mergeDocumentExtractions(
                textExtraction,
                visionExtraction,
                "pdf_text_plus_vision"
              ),
              warnings,
            },
          };
        }
      }
      return {
        model: PDF_TEXT_EXTRACTION_MODEL,
        extraction: {
          ...textExtraction,
          extraction_source: "pdf_text",
        },
      };
    }

    const dataUrl = await renderPdfFirstPageDataUrl(parser);
    if (dataUrl) {
      const imageExtraction = await extractDocumentFieldsFromImage({
        apiKey: input.apiKey,
        documentKind: input.documentKind,
        dataUrl,
      });
      const warnings = Array.isArray(imageExtraction.warnings)
        ? imageExtraction.warnings
        : [];
      return {
        model: VISION_EXTRACTION_MODEL,
        extraction: {
          ...imageExtraction,
          extraction_source: "pdf_rendered_first_page",
          warnings: [
            ...warnings,
            "PDF sin texto suficiente; se renderizó la primera página como imagen.",
          ],
        },
      };
    }
    return {
      model: PDF_TEXT_EXTRACTION_MODEL,
      extraction: {
        document_kind: input.documentKind,
        confidence: "low",
        extraction_source: "pdf_unreadable",
        warnings: [
          "No se pudo extraer texto suficiente ni renderizar la primera página del PDF.",
        ],
      },
    };
  } catch (err) {
    return {
      model: PDF_TEXT_EXTRACTION_MODEL,
      extraction: {
        document_kind: input.documentKind,
        confidence: "low",
        extraction_source: "pdf_failed",
        warnings: [
          `No se pudo procesar el PDF: ${err instanceof Error ? err.message : String(err)}`,
        ],
      },
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function shouldUseCachedExtraction(input: {
  force?: boolean;
  contentType: string;
  extractionStatus: string;
  extraction: Record<string, unknown>;
}) {
  if (input.force) return false;
  if (Object.keys(input.extraction ?? {}).length === 0) return false;
  if (
    input.contentType === "application/pdf" &&
    isPropertyDeedKind(input.extraction.document_kind) &&
    typeof input.extraction.area_total_m2 !== "number"
  ) {
    return false;
  }
  if (input.extractionStatus === "ok") return true;
  if (input.extractionStatus !== "low_confidence") return false;
  if (input.contentType === "application/pdf") {
    return (
      input.extraction.extraction_source === "pdf_text_plus_vision" ||
      input.extraction.extraction_source === "pdf_rendered_first_page"
    );
  }
  return true;
}

export type NotifyUserFn = (
  db: ToolContext["db"],
  userId: string,
  payload: { text: string; kind?: string; data?: Record<string, unknown> },
  urgency?: "low" | "normal" | "high"
) => Promise<{
  delivered: Array<{ channel: string; ok: boolean; reason?: string }>;
  attempted: Array<{ channel: string; ok: boolean; reason?: string }>;
}>;

interface NotifyDeps {
  notifyUser: NotifyUserFn;
}

export function missingRequiredIntakeFields(
  intakeSchema: readonly OperationalCaseIntakeField[] | undefined,
  context: Record<string, unknown>
) {
  const requiredFields = intakeSchema?.filter((field) => field?.required) ?? [];
  return requiredFields
    .filter((field) => {
      const value = context[field.name];
      return (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      );
    })
    .map((field) => ({ name: field.name, label: field.label }));
}

export function buildOperationalCaseCreateContext(params: {
  context: Record<string, unknown>;
  missing: Array<{ name: string; label: string }>;
  allowIncompleteIntake?: boolean;
  e2eControlled?: boolean;
  channel?: string;
}) {
  const incomplete = params.missing.length > 0;
  return {
    created_from: "agent_conversation",
    ...(params.context ?? {}),
    ...(params.e2eControlled
      ? {
          e2e_controlled: true,
          e2e_control_source: params.channel ?? "telegram",
          e2e_control_status: incomplete ? "intake" : "ready_for_manual_tick",
          e2e_control_started_at: new Date().toISOString(),
        }
      : {}),
    ...(params.allowIncompleteIntake && incomplete
      ? {
          intake_status: "incomplete",
          missing_required: params.missing,
        }
      : {
          intake_status: "complete",
          missing_required: [],
        }),
  };
}

function firstOperationalStep(flow: readonly OperationalCaseFlowStep[] | undefined) {
  return flow?.find((step) => step.step_key && step.step_key !== "intake")
    ?.step_key;
}

export function operationalCaseIntakeSuccessStep(params: {
  activationPolicy?: OperationalCaseActivationPolicy | null;
  flow?: readonly OperationalCaseFlowStep[] | null;
}) {
  return (
    params.activationPolicy?.safe_test?.success_step?.trim() ||
    firstOperationalStep(params.flow ?? undefined) ||
    "awaiting_documents"
  );
}

export function blockedAwaitingDocumentsTransitionReason(params: {
  currentStep: string | null | undefined;
  nextStep: string | null | undefined;
  recentEventTypes?: string[];
}): string | null {
  if (params.currentStep !== "awaiting_documents") return null;
  if (!params.nextStep || params.nextStep === "awaiting_documents") return null;
  if (
    params.nextStep === "documents_received" &&
    params.recentEventTypes?.includes("external_response")
  ) {
    return null;
  }
  return "awaiting_documents_requires_external_response";
}

const PROPERTY_OPTIONING_STEP_ORDER = [
  "intake",
  "awaiting_documents",
  "documents_received",
  "property_data_review",
  "comparables_in_progress",
  "price_proposal_pending",
  "contract_pending",
  "photos_scheduled",
  "publication_pending",
] as const;

function propertyOptioningStepRank(step: string | null | undefined) {
  if (!step) return null;
  const index = PROPERTY_OPTIONING_STEP_ORDER.indexOf(
    step as (typeof PROPERTY_OPTIONING_STEP_ORDER)[number]
  );
  return index === -1 ? null : index;
}

export function blockedPropertyOptioningStepRegressionReason(params: {
  caseType: string | null | undefined;
  currentStep: string | null | undefined;
  nextStep: string | null | undefined;
}): string | null {
  if (params.caseType !== "property_optioning" || !params.nextStep) return null;
  const currentRank = propertyOptioningStepRank(params.currentStep);
  const nextRank = propertyOptioningStepRank(params.nextStep);
  if (currentRank == null || nextRank == null) return null;
  if (nextRank < currentRank) return "property_optioning_step_regression_blocked";
  return null;
}

function sanitizeIntakePatch(
  intakeSchema: readonly OperationalCaseIntakeField[] | undefined,
  patch: Record<string, unknown>
) {
  const allowed = new Set((intakeSchema ?? []).map((field) => field.name));
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.has(key))
  );
}

export function buildOperationalCaseIntakeUpdateContext(params: {
  existingContext: Record<string, unknown>;
  intakePatch: Record<string, unknown>;
  intakeSchema?: readonly OperationalCaseIntakeField[];
  e2eControlled?: boolean;
  channel?: string;
}) {
  const sanitizedPatch = sanitizeIntakePatch(
    params.intakeSchema,
    params.intakePatch
  );
  const mergedContext = {
    ...params.existingContext,
    ...sanitizedPatch,
  };
  const missing = missingRequiredIntakeFields(
    params.intakeSchema,
    mergedContext
  );
  const complete = missing.length === 0;
  return {
    context: {
      ...mergedContext,
      intake_status: complete ? "complete" : "incomplete",
      missing_required: missing,
      ...(params.e2eControlled || mergedContext.e2e_controlled === true
        ? {
            e2e_controlled: true,
            e2e_control_source:
              typeof mergedContext.e2e_control_source === "string"
                ? mergedContext.e2e_control_source
                : (params.channel ?? "telegram"),
            e2e_control_status: complete ? "ready_for_manual_tick" : "intake",
          }
        : {}),
    },
    intakePatch: sanitizedPatch,
    missing,
    complete,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addOperationalCaseTools(
  ctx: ToolContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  deps: NotifyDeps
): void {
  if (!ctx.caseId && toolEnabled("operational_case_create", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_type: string;
          context: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          next_action_at?: string;
          due_at?: string;
          allow_incomplete_intake?: boolean;
          e2e_controlled?: boolean;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_create",
            input as unknown as Record<string, unknown>,
            false);

          if (ctx.caseId) {
            const out = {
              ok: false,
              error: "case_already_in_scope",
              case_id: ctx.caseId,
              hint:
                "Ya hay un caso operacional activo en contexto. Continúa ese caso con operational_case_update_intake/update_state; no crees otro caso.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const caseType = await getOperationalCaseTypeForUser(
            ctx.db,
            ctx.userId,
            input.case_type
          );
          if (!caseType) {
            const out = {
              ok: false,
              error: "case_type_not_found_or_forbidden",
              hint: "The case_type slug is not visible to this user. Check the operational_case_types catalog.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (caseType.status === "archived") {
            const out = {
              ok: false,
              error: "case_type_archived",
              hint: "This case_type is archived; ask the user to pick another or unarchive it from settings.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
            | OperationalCaseIntakeField[]
            | undefined;
          const missing = missingRequiredIntakeFields(
            intakeSchema,
            input.context ?? {}
          );
          if (missing.length > 0 && !input.allow_incomplete_intake) {
            const out = {
              ok: false,
              error: "missing_required_intake_fields",
              missing,
              hint: "Ask the user for these fields conversationally before retrying, or pass allow_incomplete_intake=true to persist a draft intake case.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const externalContact = (input.external_contact ?? undefined) as
            | OperationalCaseExternalContact
            | undefined;

          const incompleteDraft =
            missing.length > 0 && input.allow_incomplete_intake === true;
          const created = await createOperationalCase(ctx.db, {
            userId: ctx.userId,
            caseTypeId: caseType.id,
            caseType: caseType.case_type,
            status: incompleteDraft ? "waiting_internal" : "active",
            currentStep: "intake",
            externalContact,
            nextActionAt:
              input.next_action_at ??
              (input.e2e_controlled ? null : new Date().toISOString()),
            dueAt: input.due_at ?? null,
            // Marcamos created_from para distinguir en /operational-cases
            // los casos creados por el flujo conversacional (chat/telegram)
            // de los creados desde el formulario web ("Poner en operación").
            // El web formula explícitamente `created_from='web_operational_cases_ui'`;
            // aquí marcamos `agent_conversation`. NO sobreescribimos si el
            // caller ya proveyó un valor (defensa por si en el futuro alguien
            // llama esta tool desde otro contexto y quiere su propio tag).
            context: buildOperationalCaseCreateContext({
              context: input.context ?? {},
              missing,
              allowIncompleteIntake: input.allow_incomplete_intake,
              e2eControlled: input.e2e_controlled,
              channel: ctx.channel,
            }),
          });

          await insertOperationalCaseEvent(ctx.db, {
            caseId: created.id,
            eventType: "step_completed",
            actor: "agent",
            payload: {
              kind: "case_created",
              source: "agent_conversation",
              case_type: created.case_type,
              current_step: created.current_step,
              intake_status: created.context_jsonb.intake_status ?? null,
              missing_required: created.context_jsonb.missing_required ?? [],
            },
          });

          const out = {
            ok: true,
            case_id: created.id,
            case_type: created.case_type,
            version: created.version,
            status: created.status,
            current_step: created.current_step,
            next_action_at: created.next_action_at,
            intake_status: created.context_jsonb.intake_status ?? "complete",
            missing_required: created.context_jsonb.missing_required ?? [],
            hint: incompleteDraft
              ? "Draft intake case created. Continue the conversation to collect missing_required before advancing operational steps."
              : "Case created at current_step='intake'. Inform the inmobiliario via notify_user; do NOT message the external contact yet — that is the responsibility of the next operational step.",
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_create",
          description:
            "Creates a new operational case for the calling user from a known case_type. Validates required fields against intake_schema_jsonb. Starts at current_step='intake'.",
          schema: z.object({
            case_type: z.string().min(1),
            context: z.record(z.string(), z.any()),
            external_contact: z.record(z.string(), z.any()).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
            allow_incomplete_intake: z.boolean().optional(),
            e2e_controlled: z.boolean().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_update_intake", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          intake_patch: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          next_action_at?: string;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(
            ctx,
            "operational_case_update_intake",
            input as unknown as Record<string, unknown>,
            false
          );

          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.version !== input.expected_version) {
            const out = {
              ok: false,
              error: "version_mismatch",
              actual_version: opCase.version,
              expected_version: input.expected_version,
              hint: "Re-read the case and retry with the new version.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.current_step !== "intake") {
            const out = {
              ok: false,
              error: "case_not_in_intake",
              current_step: opCase.current_step,
              hint: "Use operational_case_update_intake only while current_step='intake'.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const caseType = await getOperationalCaseTypeById(
            ctx.db,
            opCase.case_type_id
          );
          if (!caseType || (caseType.user_id && caseType.user_id !== ctx.userId)) {
            const out = { ok: false, error: "case_type_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
            | OperationalCaseIntakeField[]
            | undefined;
          const intakeUpdate = buildOperationalCaseIntakeUpdateContext({
            existingContext:
              opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                ? (opCase.context_jsonb as Record<string, unknown>)
                : {},
            intakePatch: input.intake_patch ?? {},
            intakeSchema,
            e2eControlled: opCase.context_jsonb?.e2e_controlled === true,
            channel: ctx.channel,
          });
          const successStep = operationalCaseIntakeSuccessStep({
            activationPolicy: caseType.activation_policy_jsonb,
            flow: caseType.operational_flow_jsonb,
          });
          const nextStep = intakeUpdate.complete ? successStep : "intake";
          const nextActionAt = intakeUpdate.complete
            ? opCase.context_jsonb?.e2e_controlled === true
              ? null
              : (input.next_action_at ?? new Date().toISOString())
            : null;
          const updated = await updateOperationalCase(
            ctx.db,
            opCase.id,
            opCase.version,
            {
              status: "active",
              currentStep: nextStep,
              nextActionAt,
              context: intakeUpdate.context,
              externalContact: mergeExternalContactPatch(
                opCase.external_contact_jsonb,
                input.external_contact
              ),
            }
          );
          if (!updated) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              source: "operational_case_update_intake",
              from: {
                status: opCase.status,
                current_step: opCase.current_step,
                version: opCase.version,
                intake_status: opCase.context_jsonb?.intake_status ?? null,
              },
              to: {
                status: updated.status,
                current_step: updated.current_step,
                version: updated.version,
                intake_status: intakeUpdate.complete ? "complete" : "incomplete",
              },
              missing_required: intakeUpdate.missing,
              updated_fields: Object.keys(intakeUpdate.intakePatch),
              ...(input.note ? { reason: input.note } : {}),
            },
          });

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            status: updated.status,
            current_step: updated.current_step,
            intake_status: intakeUpdate.complete ? "complete" : "incomplete",
            missing_required: intakeUpdate.missing,
            ready_for_manual_tick: intakeUpdate.complete,
            ...(intakeUpdate.complete
              ? {
                  user_reply_hint:
                    "Confirma brevemente que la propiedad quedó registrada en el caso. No uses «opcional» ni «opcionada». No menciones documentos ni adjuntos; el siguiente paso operativo los solicita.",
                }
              : {}),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_update_intake",
          description:
            "Updates intake fields for an active operational case, validates required intake_schema fields, and when complete moves the case to the first operational step for the next case tick.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            intake_patch: z.record(z.string(), z.any()),
            external_contact: z.record(z.string(), z.any()).optional(),
            next_action_at: z.string().optional(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_update_state", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          status?: (typeof STATUS_VALUES)[number];
          current_step?: string;
          next_action_at?: string;
          due_at?: string;
          context_patch?: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_update_state",
            input as unknown as Record<string, unknown>,
            false);

          let expectedVersion = input.expected_version;
          let opCaseBefore: Awaited<ReturnType<typeof getOperationalCase>> = null;
          let updated: Awaited<ReturnType<typeof updateOperationalCase>> = null;

          for (let attempt = 0; attempt < 5; attempt++) {
            const opCase = await getOperationalCase(ctx.db, input.case_id);
            if (!opCase) {
              const out = { ok: false, error: "case_not_found" };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (opCase.user_id !== ctx.userId) {
              const out = { ok: false, error: "case_belongs_to_another_user" };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (opCase.version !== expectedVersion) {
              if (attempt < 4) {
                expectedVersion = opCase.version;
                continue;
              }
              const out = {
                ok: false,
                error: "version_mismatch",
                actual_version: opCase.version,
                expected_version: input.expected_version,
                hint: "Re-read the case and retry with the new version.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }

            opCaseBefore = opCase;
            let contextPatch =
              input.context_patch && Object.keys(input.context_patch).length > 0
                ? { ...input.context_patch }
                : undefined;
            if (contextPatch && "comparables_analysis" in contextPatch) {
              const patchErrors = validateComparablesAnalysisArtifact(
                contextPatch.comparables_analysis
              );
              if (patchErrors.length > 0) {
                const { comparables_analysis: _omit, ...rest } = contextPatch;
                contextPatch =
                  Object.keys(rest).length > 0 ? rest : undefined;
              }
            }
            const mergedContext =
              contextPatch && Object.keys(contextPatch).length > 0
                ? {
                    ...(opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                      ? (opCase.context_jsonb as Record<string, unknown>)
                      : {}),
                    ...contextPatch,
                  }
                : undefined;
            const nextContext =
              mergedContext ??
              (opCase.context_jsonb && typeof opCase.context_jsonb === "object"
                ? (opCase.context_jsonb as Record<string, unknown>)
                : {});
            const regressionReason =
              blockedPropertyOptioningStepRegressionReason({
                caseType: opCase.case_type,
                currentStep: opCase.current_step,
                nextStep: input.current_step,
              });
            if (regressionReason) {
              const out = {
                ok: false,
                error: regressionReason,
                current_step: opCase.current_step,
                requested_step: input.current_step,
                hint:
                  "No retrocedas current_step en property_optioning. Continúa desde el hito actual o pide intervención humana si necesitas reabrir un paso anterior.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }
            if (
              opCase.current_step === "awaiting_documents" &&
              input.current_step &&
              input.current_step !== "awaiting_documents"
            ) {
              const recentEvents = await getRecentOperationalCaseEvents(
                ctx.db,
                opCase.id,
                30
              );
              const blockedReason = blockedAwaitingDocumentsTransitionReason({
                currentStep: opCase.current_step,
                nextStep: input.current_step,
                recentEventTypes: recentEvents.map((event) => event.event_type),
              });
              if (blockedReason) {
                const out = {
                  ok: false,
                  error: blockedReason,
                  current_step: opCase.current_step,
                  requested_step: input.current_step,
                  hint:
                    "Desde awaiting_documents primero solicita documentos y espera un external_response. No avances a pasos posteriores sin evidencia de respuesta/documentos.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            const comparablesAnalysis = nextContext.comparables_analysis;
            if (comparablesAnalysis != null) {
              const artifactErrors =
                validateComparablesAnalysisArtifact(comparablesAnalysis);
              if (artifactErrors.length > 0) {
                const out = {
                  ok: false,
                  error: "invalid_comparables_analysis",
                  errors: artifactErrors,
                  hint:
                    "Usa operational_case_persist_comparables_analysis para construir el artefacto desde los resultados de búsqueda del turno.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            if (
              input.current_step === "price_proposal_pending" &&
              opCase.current_step === "comparables_in_progress" &&
              !comparablesHasDefensibleSample(comparablesAnalysis)
            ) {
              const out = {
                ok: false,
                error: "comparables_sample_not_defensible",
                hint:
                  "No avances a price_proposal_pending hasta persistir comparables_analysis con data_quality.usable_count > 0. Si todas las fuentes tienen 0 usables, deja current_step=comparables_in_progress y status=waiting_internal con notify_user.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", out);
              return JSON.stringify(out);
            }

            updated = await updateOperationalCase(
              ctx.db,
              opCase.id,
              opCase.version,
              {
                status: input.status,
                currentStep: input.current_step,
                nextActionAt: input.next_action_at,
                dueAt: input.due_at,
                context: mergedContext,
                externalContact: mergeExternalContactPatch(
                  opCase.external_contact_jsonb,
                  input.external_contact
                ),
              }
            );
            if (updated) break;
          }

          if (!updated || !opCaseBefore) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCaseBefore.id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              from: {
                status: opCaseBefore.status,
                current_step: opCaseBefore.current_step,
                version: opCaseBefore.version,
              },
              to: {
                status: updated.status,
                current_step: updated.current_step,
                version: updated.version,
              },
              ...(input.note ? { reason: input.note } : {}),
            },
          });

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            status: updated.status,
            current_step: updated.current_step,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_update_state",
          description:
            "Updates the active operational case (status/current_step/next_action_at/...). Optimistic-locked by version.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            status: z.enum(STATUS_VALUES).optional(),
            current_step: z.string().min(1).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
            context_patch: z.record(z.string(), z.any()).optional(),
            external_contact: z.record(z.string(), z.any()).optional(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_persist_comparables_analysis", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          note?: string;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_persist_comparables_analysis",
            input as unknown as Record<string, unknown>,
            false);

          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.version !== input.expected_version) {
            const out = {
              ok: false,
              error: "version_mismatch",
              actual_version: opCase.version,
              expected_version: input.expected_version,
              hint: "Re-read the case and retry with the new version.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (!ctx.turnId) {
            const out = {
              ok: false,
              error: "turn_id_required",
              hint: "Esta tool construye comparables desde las búsquedas ejecutadas en el mismo turno.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const { data, error } = await ctx.db
            .from("tool_calls")
            .select("tool_name,status,arguments_json,result_json,created_at")
            .eq("turn_id", ctx.turnId)
            .in("tool_name", [
              "easybroker_search_listings",
              "easybroker_search_closed_deals",
              "bigquery_lookup_local_comparables",
            ])
            .order("created_at", { ascending: true });
          if (error) {
            const out = {
              ok: false,
              error: "tool_calls_lookup_failed",
              hint: error.message,
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const context =
            opCase.context_jsonb && typeof opCase.context_jsonb === "object"
              ? (opCase.context_jsonb as Record<string, unknown>)
              : {};
          let analysis: Record<string, unknown> = buildComparablesAnalysisFromToolCalls(
            ((data ?? []) as PersistedToolCallRow[]).map((call) => ({
              tool_name: call.tool_name,
              status: call.status,
              arguments_json: call.arguments_json ?? null,
              result_json: call.result_json ?? null,
              created_at: call.created_at ?? null,
            }))
          );
          analysis = normalizeComparablesAnalysisForInsufficientN4Test(
            analysis,
            context
          );
          const artifactErrors = validateComparablesAnalysisArtifact(analysis);
          if (artifactErrors.length > 0) {
            const out = {
              ok: false,
              error: "invalid_comparables_analysis",
              errors: artifactErrors,
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const updated = await updateOperationalCase(
            ctx.db,
            opCase.id,
            opCase.version,
            {
              context: {
                ...context,
                comparables_analysis: analysis,
              },
            }
          );
          if (!updated) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const analysisDataQuality = isRecord(analysis.data_quality)
            ? analysis.data_quality
            : {};
          const usableCount =
            typeof analysisDataQuality.usable_count === "number"
              ? analysisDataQuality.usable_count
              : 0;

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "step_completed",
            actor: "agent",
            payload: {
              kind: "comparables_analysis_persisted",
              source: "operational_case_persist_comparables_analysis",
              usable_count: usableCount,
              ...(input.note ? { note: input.note } : {}),
            },
          });

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            defensible_sample: comparablesHasDefensibleSample(analysis),
            usable_count: usableCount,
            stats: analysis.stats,
            data_quality: analysisDataQuality,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_persist_comparables_analysis",
          description:
            "Builds and persists context_jsonb.comparables_analysis deterministically from this turn's EasyBroker and BigQuery search tool results. Use after running all comparable search tools; do not hand-write comparables_analysis via operational_case_update_state.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_add_event", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          event_type: (typeof EVENT_TYPE_VALUES)[number];
          actor: (typeof ACTOR_VALUES)[number];
          payload?: Record<string, unknown>;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_add_event",
            input as unknown as Record<string, unknown>,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const ev = await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: input.event_type,
            actor: input.actor,
            payload: input.payload ?? {},
          });
          const out = { ok: true, event_id: ev.id };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_add_event",
          description: "Appends an event to the active operational case timeline.",
          schema: z.object({
            case_id: z.string().min(1),
            event_type: z.enum(EVENT_TYPE_VALUES),
            actor: z.enum(ACTOR_VALUES),
            payload: z.record(z.string(), z.any()).optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_register_document", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          kind: string;
          storage_path: string;
          storage_bucket?: string;
          display_name?: string;
          original_name?: string;
          content_type?: string;
          file_size_bytes?: number;
          sha256?: string;
          source?: "external_telegram" | "advisor_web" | "advisor_telegram" | "settings_test" | "unknown";
          blocking?: boolean;
          metadata?: Record<string, unknown>;
        }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_register_document",
            input as unknown as Record<string, unknown>,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const document = await createOperationalCaseDocument(ctx.db, {
            caseId: opCase.id,
            userId: opCase.user_id,
            kind: input.kind,
            displayName: input.display_name ?? null,
            storageBucket: input.storage_bucket,
            storagePath: input.storage_path,
            originalName: input.original_name ?? null,
            contentType: input.content_type ?? null,
            fileSizeBytes: input.file_size_bytes ?? null,
            sha256: input.sha256 ?? null,
            source: input.source ?? "unknown",
            sourceMetadata: input.metadata ?? {},
            blocking: input.blocking ?? input.kind === "escritura_descripcion",
          });
          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "external_response",
            actor: input.source?.startsWith("advisor") ? "user" : "external",
            payload: {
              kind: "document_registered",
              document_id: document.id,
              document_kind: document.kind,
              source: document.source,
            },
          });
          const out = {
            ok: true,
            document_id: document.id,
            kind: document.kind,
            blocking: document.blocking,
            extraction_status: document.extraction_status,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_register_document",
          description:
            "Registers a document already stored in Supabase Storage as evidence for an operational case.",
          schema: z.object({
            case_id: z.string().min(1),
            kind: z.string().min(1),
            storage_path: z.string().min(1),
            storage_bucket: z.string().min(1).optional(),
            display_name: z.string().optional(),
            original_name: z.string().optional(),
            content_type: z.string().optional(),
            file_size_bytes: z.number().int().nonnegative().optional(),
            sha256: z.string().optional(),
            source: z
              .enum(["external_telegram", "advisor_web", "advisor_telegram", "settings_test", "unknown"])
              .optional(),
            blocking: z.boolean().optional(),
            metadata: z.record(z.string(), z.any()).optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_list_documents", ctx)) {
    tools.push(
      tool(
        async (input: { case_id: string }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_list_documents",
            input,
            false);
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const documents = await listOperationalCaseDocuments(ctx.db, {
            caseId: opCase.id,
            statuses: ["received"],
          });
          const out = {
            ok: true,
            documents: documents.map((doc) => ({
              id: doc.id,
              kind: doc.kind,
              display_name: doc.display_name,
              original_name: doc.original_name,
              content_type: doc.content_type,
              file_size_bytes: doc.file_size_bytes,
              blocking: doc.blocking,
              source: doc.source,
              extraction_status: doc.extraction_status,
              extraction: doc.extraction_jsonb,
              created_at: doc.created_at,
            })),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_list_documents",
          description:
            "Lists received documents attached to an operational case, including cached extraction metadata.",
          schema: z.object({
            case_id: z.string().min(1),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_extract_document_fields", ctx)) {
    tools.push(
      tool(
        async (input: { document_id: string; force?: boolean }) => {
          const record = await createTrackedToolCall(ctx, "operational_case_extract_document_fields",
            input,
            false);
          const document = await getOperationalCaseDocument(ctx.db, input.document_id);
          if (!document || document.user_id !== ctx.userId) {
            const out = { ok: false, error: "document_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const contentType = document.content_type ?? "";
          if (
            shouldUseCachedExtraction({
              force: input.force,
              contentType,
              extractionStatus: document.extraction_status,
              extraction: document.extraction_jsonb ?? {},
            })
          ) {
            const out = {
              ok: true,
              cached: true,
              document_id: document.id,
              extraction_status: document.extraction_status,
              extraction: document.extraction_jsonb,
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          }
          if (!input.force && document.sha256) {
            const previous = await findExtractedOperationalCaseDocumentByHash(ctx.db, {
              caseId: document.case_id,
              kind: document.kind,
              sha256: document.sha256,
              excludeDocumentId: document.id,
            });
            if (
              previous &&
              shouldUseCachedExtraction({
                contentType,
                extractionStatus: previous.extraction_status,
                extraction: previous.extraction_jsonb ?? {},
              })
            ) {
              const updated = await updateOperationalCaseDocumentExtraction(ctx.db, {
                documentId: document.id,
                status: previous.extraction_status,
                model: previous.extraction_model,
                extraction: {
                  ...previous.extraction_jsonb,
                  reused_from_document_id: previous.id,
                },
              });
              const out = {
                ok: true,
                cached: true,
                reused_from_document_id: previous.id,
                document_id: document.id,
                extraction_status: updated.extraction_status,
                extraction: updated.extraction_jsonb,
              };
              await updateToolCallStatus(ctx.db, record.id, "executed", out);
              return JSON.stringify(out);
            }
          }
          const { data: blob, error: downloadError } = await ctx.db.storage
            .from(document.storage_bucket)
            .download(document.storage_path);
          if (downloadError || !blob) {
            const out = {
              ok: false,
              error: downloadError?.message ?? "storage_download_failed",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const bytes = Buffer.from(await blob.arrayBuffer());
          const apiKey = process.env.OPENROUTER_API_KEY;
          if (!apiKey) {
            const out = { ok: false, error: "missing_openrouter_api_key" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          let extractionResult: {
            model: string;
            extraction: Record<string, unknown>;
          };
          try {
            if (contentType === "application/pdf") {
              extractionResult = await extractPdfDocumentFields({
                apiKey,
                documentKind: document.kind,
                bytes,
              });
            } else if (contentType.startsWith("image/")) {
              const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
              extractionResult = {
                model: VISION_EXTRACTION_MODEL,
                extraction: {
                  ...(await extractDocumentFieldsFromImage({
                    apiKey,
                    documentKind: document.kind,
                    dataUrl,
                  })),
                  extraction_source: "image",
                },
              };
            } else {
              extractionResult = {
                model: VISION_EXTRACTION_MODEL,
                extraction: {
                  document_kind: document.kind,
                  confidence: "low",
                  extraction_source: "unsupported_content_type",
                  warnings: [
                    `Tipo de archivo no soportado para extracción: ${contentType || "sin content-type"}.`,
                  ],
                },
              };
            }
          } catch (err) {
            const out = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const updated = await updateOperationalCaseDocumentExtraction(ctx.db, {
            documentId: document.id,
            status: extractionStatusFor(extractionResult.extraction),
            model: extractionResult.model,
            extraction: extractionResult.extraction,
          });
          const out = {
            ok: true,
            cached: false,
            document_id: document.id,
            extraction_status: updated.extraction_status,
            extraction: updated.extraction_jsonb,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_extract_document_fields",
          description:
            "Runs cached multimodal extraction for a case document image and stores the extracted JSON on operational_case_documents.",
          schema: z.object({
            document_id: z.string().uuid(),
            force: z.boolean().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("notify_user", ctx)) {
    tools.push(
      tool(
        async (input: {
          text: string;
          kind?: string;
          urgency?: "low" | "normal" | "high";
          case_id?: string;
        }) => {
          const caseId = input.case_id ?? ctx.caseId ?? undefined;
          const record = await createTrackedToolCall(ctx, "notify_user",
            input as unknown as Record<string, unknown>,
            false);
          try {
            const opCase =
              input.kind === "property_data_review" && caseId
                ? await getOperationalCase(ctx.db, caseId)
                : null;
            if (input.kind === "property_data_review" && opCase) {
              const documents = await listOperationalCaseDocuments(ctx.db, {
                caseId: opCase.id,
                statuses: ["received"],
              });
              const documentMinimumsContext =
                documentExtractionMinimumsContext(documents);
              const minimums = evaluatePropertyDataMinimumsForReview(
                opCase.context_jsonb,
                documentMinimumsContext
              );
              if (!minimums.ok) {
                const suggestedExternalMessage =
                  buildPropertyDataMinimumsSummaryMessage({
                    context: opCase.context_jsonb,
                    supplement: documentMinimumsContext,
                    missing: minimums.missing,
                  });
                const out = {
                  ok: false,
                  error: "property_data_minimums_missing",
                  property_type: minimums.propertyType,
                  missing: minimums.missing,
                  document_fields_used: documentMinimumsContext,
                  suggested_external_message: suggestedExternalMessage,
                  hint:
                    "Antes de crear property_data_review, envía suggested_external_message al contacto externo con telegram_send_message_to_contact(purpose='characteristics_pending') y deja el caso en waiting_external/documents_received.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", out);
                return JSON.stringify(out);
              }
            }
            const notificationText =
              input.kind === "property_data_review"
                ? canonicalizePropertyDataReviewText(opCase, input.text)
                : input.text;
            const result = await deps.notifyUser(
              ctx.db,
              ctx.userId,
              {
                text: notificationText,
                kind: input.kind,
                data: {
                  ...(caseId ? { case_id: caseId } : {}),
                  ...(input.kind === "price_approval"
                    ? {
                        artifact_key: "pricing_proposal",
                        actions: ["approve", "adjust", "reject"],
                      }
                    : {}),
                },
              },
              input.urgency ?? "normal"
            );
            const out = {
              ok: result.delivered.length > 0,
              attempted: result.attempted,
              delivered: result.delivered,
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          } catch (e) {
            const out = {
              ok: false,
              error: (e as Error).message ?? String(e),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "notify_user",
          description:
            "Notifies the inmobiliario via their preferred channel (web/telegram).",
          schema: z.object({
            text: z.string().min(1),
            kind: z.string().min(1).optional(),
            urgency: z.enum(["low", "normal", "high"]).optional(),
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }
}

function toolEnabled(toolId: string, ctx: ToolContext): boolean {
  if (
    ctx.activeSkillAllowedTools &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId)
  ) {
    return false;
  }
  // user_tool_settings opt-in/out: si NO está en la lista, default ON.
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (setting && setting.enabled === false) return false;
  return true;
}
