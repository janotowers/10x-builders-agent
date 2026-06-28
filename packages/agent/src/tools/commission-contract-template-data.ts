import { subjectAreaFromCaseContext } from "../operational-cases/comparables-advance";

/**
 * Placeholders canónicos de la plantilla DOCX de contrato de comisión.
 */
export const COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS = [
  "owner_name",
  "owner_email",
  "property_address",
  "property_type",
  "area_m2",
  "salida_price",
  "salida_price_formatted",
  "salida_price_words",
  "minimum_price",
  "commission_pct",
  "exclusive",
  "duration_months",
] as const;

export type CommissionContractPlaceholderKey =
  (typeof COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = cleanString(source[key]);
    if (value) return value;
  }
  return "";
}

const ADDRESS_TOP_LEVEL_FIELD_SOURCES: Array<[string, readonly string[]]> = [
  ["street", ["street", "street_name", "calle"]],
  ["exterior_number", ["exterior_number", "numero_exterior", "number"]],
  ["neighborhood", ["neighborhood", "colonia"]],
  ["municipality", ["municipality", "municipio", "city", "ciudad"]],
  ["state", ["state", "estado"]],
  ["postal_code", ["postal_code", "zip_code", "cp"]],
];

function addressRecordFromPropertyData(
  propertyData: Record<string, unknown>
): Record<string, unknown> {
  const nested = propertyData.address;
  if (typeof nested === "string") {
    return { formatted: nested };
  }
  const address = isRecord(nested) ? { ...nested } : {};
  for (const [targetField, sourceFields] of ADDRESS_TOP_LEVEL_FIELD_SOURCES) {
    if (cleanString(address[targetField])) continue;
    const value = firstString(propertyData, sourceFields);
    if (value) address[targetField] = value;
  }
  return address;
}

function streetLineFromAddress(address: Record<string, unknown>): string {
  const formatted = cleanString(address.formatted) ?? cleanString(address.full);
  if (formatted) return formatted;

  const street = firstString(address, ["street", "street_name", "calle"]);
  const exterior = firstString(address, ["exterior_number", "numero_exterior", "number"]);
  if (street && exterior) return `${street} ${exterior}`;
  return street || exterior;
}

/** Dirección legible desde property_data.address (string u objeto). */
export function readablePropertyAddress(
  propertyData: Record<string, unknown>
): string {
  const address = addressRecordFromPropertyData(propertyData);
  if (typeof propertyData.address === "string") {
    return propertyData.address.trim();
  }

  const parts = [
    streetLineFromAddress(address),
    firstString(address, ["neighborhood", "colonia"]),
    firstString(address, ["municipality", "municipio", "city", "ciudad"]),
    firstString(address, ["state", "estado"]),
    firstString(address, ["postal_code", "zip_code", "cp"]),
  ].filter((part) => part.length > 0);

  return parts.join(", ");
}

function templateScalar(value: unknown): string | number | boolean {
  if (value == null) return "";
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return String(value);
}

function firstValue(...values: unknown[]) {
  return values.find((value) => value != null && value !== "");
}

function looksLikeEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const cleaned = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
}

function resolveOwnerEmail(input: {
  caseContext: Record<string, unknown>;
  propertyData: Record<string, unknown>;
  contact: Record<string, unknown>;
}): string {
  const candidates = [
    input.contact.email,
    input.caseContext.owner_email,
    input.propertyData.owner_email,
    input.propertyData.email,
    input.contact.identifier,
    input.caseContext.email,
  ];
  for (const candidate of candidates) {
    if (looksLikeEmail(candidate)) return candidate.trim();
  }
  return "";
}

/** Área contractual alineada con comparables/precio (construcción preferida; terreno si no hay). */
export function contractAreaM2FromCase(input: {
  case_context?: Record<string, unknown>;
  property_data?: Record<string, unknown>;
  pricing_proposal?: Record<string, unknown>;
}): number | "" {
  const caseContext = input.case_context ?? {};
  const propertyData = input.property_data ?? {};
  const pricing = input.pricing_proposal ?? {};

  const approvedSubjectArea = positiveNumberOrNull(pricing.subject_area_m2);
  if (approvedSubjectArea != null) return approvedSubjectArea;

  const subject = subjectAreaFromCaseContext({
    ...caseContext,
    property_data: propertyData,
  });
  return subject.area ?? "";
}

export function formatContractSalidaPrice(value: unknown): string {
  const amount = positiveNumberOrNull(value);
  if (amount == null) return "";
  return Math.round(amount).toLocaleString("es-MX");
}

const UNITS = [
  "",
  "UN",
  "DOS",
  "TRES",
  "CUATRO",
  "CINCO",
  "SEIS",
  "SIETE",
  "OCHO",
  "NUEVE",
];
const TEENS = [
  "DIEZ",
  "ONCE",
  "DOCE",
  "TRECE",
  "CATORCE",
  "QUINCE",
  "DIECISEIS",
  "DIECISIETE",
  "DIECIOCHO",
  "DIECINUEVE",
];
const TENS = [
  "",
  "",
  "VEINTE",
  "TREINTA",
  "CUARENTA",
  "CINCUENTA",
  "SESENTA",
  "SETENTA",
  "OCHENTA",
  "NOVENTA",
];
const HUNDREDS = [
  "",
  "CIENTO",
  "DOSCIENTOS",
  "TRESCIENTOS",
  "CUATROCIENTOS",
  "QUINIENTOS",
  "SEISCIENTOS",
  "SETECIENTOS",
  "OCHOCIENTOS",
  "NOVECIENTOS",
];

function joinSpanishParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

function convertUnder100(value: number): string {
  if (value === 0) return "";
  if (value < 10) return UNITS[value];
  if (value < 20) return TEENS[value - 10];
  if (value === 20) return "VEINTE";
  if (value < 30) {
    if (value === 21) return "VEINTIUNO";
    if (value === 22) return "VEINTIDOS";
    if (value === 23) return "VEINTITRES";
    if (value === 26) return "VEINTISEIS";
    return `VEINTI${UNITS[value - 20]}`;
  }
  const tens = Math.floor(value / 10);
  const units = value % 10;
  if (units === 0) return TENS[tens];
  return `${TENS[tens]} Y ${UNITS[units]}`;
}

function convertUnder1000(value: number): string {
  if (value === 0) return "";
  if (value === 100) return "CIEN";
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const hundredPart =
    hundreds > 0 ? (hundreds === 1 && rest === 0 ? "CIEN" : HUNDREDS[hundreds]) : "";
  return joinSpanishParts([hundredPart, convertUnder100(rest)]);
}

function convertScaled(value: number, singular: string, plural: string): string {
  if (value === 0) return "";
  if (value === 1) return singular;
  return `${convertUnder1000(value)} ${plural}`;
}

/** Monto entero en pesos M.N. para cláusulas legales (mayúsculas, sin centavos). */
export function amountToSpanishLegalWords(value: unknown): string {
  const amount = positiveNumberOrNull(value);
  if (amount == null) return "";
  const pesos = Math.round(amount);
  if (pesos === 0) return "CERO";

  const billions = Math.floor(pesos / 1_000_000_000);
  const millions = Math.floor((pesos % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((pesos % 1_000_000) / 1_000);
  const remainder = pesos % 1_000;

  const parts = [
    convertScaled(billions, "UN MIL MILLONES", "MIL MILLONES"),
    convertScaled(millions, "UN MILLON", "MILLONES"),
    thousands === 1 ? "MIL" : convertScaled(thousands, "MIL", "MIL"),
    convertUnder1000(remainder),
  ];

  return joinSpanishParts(parts);
}

/**
 * Rellena los placeholders del contrato desde el contexto del caso.
 * Fuente de verdad compartida con generate_document_from_template (el modelo
 * puede omitir `data`; estos valores no se inventan).
 */
export function deriveCommissionContractTemplateData(input: {
  case_context?: Record<string, unknown>;
  property_data?: Record<string, unknown>;
  pricing_proposal?: Record<string, unknown>;
  commission_terms?: Record<string, unknown>;
  external_contact?: Record<string, unknown>;
}): Record<CommissionContractPlaceholderKey, string | number | boolean> {
  const caseContext = input.case_context ?? {};
  const propertyData = input.property_data ?? {};
  const pricing = input.pricing_proposal ?? {};
  const commission = input.commission_terms ?? {};
  const contact = input.external_contact ?? {};

  const ownerName =
    (typeof contact.display_name === "string" && contact.display_name.trim()) ||
    (typeof contact.name === "string" && contact.name.trim()) ||
    (typeof caseContext.owner_name === "string" && caseContext.owner_name.trim()) ||
    (typeof caseContext.lead_name === "string" && caseContext.lead_name.trim()) ||
    (typeof caseContext.contact_name === "string" && caseContext.contact_name.trim()) ||
    "";

  const salida =
    pricing.salida ?? pricing.salida_price ?? pricing.list_price ?? "";

  return {
    owner_name: ownerName,
    owner_email: resolveOwnerEmail({ caseContext, propertyData, contact }),
    property_address: readablePropertyAddress(propertyData),
    property_type: templateScalar(
      propertyData.property_type ?? propertyData.type ?? ""
    ) as string,
    area_m2: templateScalar(
      contractAreaM2FromCase({
        case_context: caseContext,
        property_data: propertyData,
        pricing_proposal: pricing,
      })
    ) as string | number,
    salida_price: templateScalar(salida) as string | number,
    salida_price_formatted: formatContractSalidaPrice(salida),
    salida_price_words: amountToSpanishLegalWords(salida),
    minimum_price: templateScalar(
      firstValue(
        pricing.minimo,
        pricing.minimum_price,
        pricing.minimo_price,
        pricing.min_price
      ) ?? ""
    ) as string | number,
    commission_pct: templateScalar(
      firstValue(
        commission.commission_pct,
        commission.commission_percent,
        commission.pct
      ) ?? ""
    ) as string | number,
    exclusive: templateScalar(commission.exclusive ?? "") as string | boolean,
    duration_months: templateScalar(
      firstValue(commission.duration_months, commission.months) ?? ""
    ) as string | number,
  };
}
