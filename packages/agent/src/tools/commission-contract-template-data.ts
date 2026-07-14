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
  "commission_pct_words",
  "exclusive",
  "duration_months",
  "duration_months_words",
  "operation_type",
  "operation_contract_type",
  "contract_day",
  "contract_month",
  "contract_year",
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

function looksLikeOperationalLabPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("contacto de prueba e2e");
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

function firstStringFromArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const cleaned = cleanString(item);
    if (cleaned) return cleaned;
  }
  return null;
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

function legalAddressFromContext(
  caseContext: Record<string, unknown>,
  propertyData: Record<string, unknown>
): string {
  const legalAddressCandidates = [
    propertyData.legal_address,
    firstStringFromArray(propertyData.legal_addresses),
    caseContext.legal_address,
    firstStringFromArray(caseContext.legal_addresses),
  ];
  for (const candidate of legalAddressCandidates) {
    const cleaned = cleanString(candidate);
    if (cleaned) return cleaned;
  }
  return "";
}

function resolveContractOwnerName(input: {
  caseContext: Record<string, unknown>;
  propertyData: Record<string, unknown>;
  contact: Record<string, unknown>;
}): string {
  const ownerNamesFromDocuments = firstStringFromArray(input.propertyData.owner_names);
  const ownerNameCandidates = [
    ownerNamesFromDocuments,
    cleanString(input.propertyData.owner_name),
    firstStringFromArray(input.caseContext.owner_names),
    cleanString(input.caseContext.owner_name),
    cleanString(input.caseContext.owner_full_name),
    cleanString(input.caseContext.lead_name),
    cleanString(input.caseContext.contact_name),
  ];
  for (const candidate of ownerNameCandidates) {
    if (candidate && !looksLikeOperationalLabPlaceholder(candidate)) return candidate;
  }
  return "";
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
    input.caseContext.owner_email,
    input.propertyData.owner_email,
    input.propertyData.email,
    input.caseContext.email,
    input.contact.email,
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

const CARDINAL_WORDS_LOWER: Record<number, string> = {
  0: "cero",
  1: "uno",
  2: "dos",
  3: "tres",
  4: "cuatro",
  5: "cinco",
  6: "seis",
  7: "siete",
  8: "ocho",
  9: "nueve",
  10: "diez",
  11: "once",
  12: "doce",
  13: "trece",
  14: "catorce",
  15: "quince",
  16: "dieciséis",
  17: "diecisiete",
  18: "dieciocho",
  19: "diecinueve",
  20: "veinte",
  21: "veintiuno",
  22: "veintidós",
  23: "veintitrés",
  24: "veinticuatro",
  25: "veinticinco",
  26: "veintiséis",
  27: "veintisiete",
  28: "veintiocho",
  29: "veintinueve",
  30: "treinta",
  40: "cuarenta",
  50: "cincuenta",
  60: "sesenta",
  70: "setenta",
  80: "ochenta",
  90: "noventa",
};

function cardinalUnder100Lower(value: number): string {
  if (value in CARDINAL_WORDS_LOWER) return CARDINAL_WORDS_LOWER[value];
  if (value < 100) {
    const tens = Math.floor(value / 10) * 10;
    const units = value % 10;
    return `${CARDINAL_WORDS_LOWER[tens]} y ${CARDINAL_WORDS_LOWER[units]}`;
  }
  return String(value);
}

/** Entero no negativo en minúsculas (p. ej. duración en meses). */
export function integerToSpanishWordsLower(value: unknown): string {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replace(/,/g, "").trim())
        : null;
  if (parsed == null || !Number.isFinite(parsed) || parsed < 0) return "";
  const whole = Math.round(parsed);
  if (whole <= 100) return cardinalUnder100Lower(whole);
  // Fallback for rare large durations: reuse legal converter in lowercase.
  return amountToSpanishLegalWords(whole).toLowerCase();
}

/**
 * Porcentaje en letra para cláusulas: "cinco por ciento", "cuatro punto cinco por ciento".
 */
export function percentToSpanishWords(value: unknown): string {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replace(/,/g, "").trim())
        : null;
  if (parsed == null || !Number.isFinite(parsed) || parsed < 0) return "";

  const rounded = Math.round(parsed * 100) / 100;
  const whole = Math.trunc(rounded);
  const cents = Math.round((rounded - whole) * 100);
  const wholeWords = integerToSpanishWordsLower(whole);
  if (!wholeWords) return "";
  if (cents === 0) return `${wholeWords} por ciento`;
  const fractionWords = integerToSpanishWordsLower(cents);
  return `${wholeWords} punto ${fractionWords} por ciento`;
}

export type ContractOperationKind = "sale" | "rent";

export function resolveContractOperationKind(
  sources: Array<Record<string, unknown> | null | undefined>
): ContractOperationKind | null {
  for (const source of sources) {
    if (!source) continue;
    const raw = firstString(source, [
      "operation",
      "operation_type",
      "tipo_operacion",
      "listing_operation",
    ]);
    if (!raw) continue;
    const normalized = raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    if (
      normalized === "sale" ||
      normalized === "venta" ||
      normalized === "compraventa" ||
      normalized.includes("venta")
    ) {
      return "sale";
    }
    if (
      normalized === "rent" ||
      normalized === "renta" ||
      normalized === "alquiler" ||
      normalized === "arrendamiento" ||
      normalized.includes("renta") ||
      normalized.includes("arrend")
    ) {
      return "rent";
    }
  }
  return null;
}

export function operationTypeLabel(kind: ContractOperationKind | null): string {
  if (kind === "rent") return "renta";
  if (kind === "sale") return "venta";
  return "";
}

export function operationContractTypeLabel(
  kind: ContractOperationKind | null
): string {
  if (kind === "rent") return "arrendamiento";
  if (kind === "sale") return "compraventa";
  return "";
}

const MONTH_NAMES_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/**
 * Fecha de firma = fecha de generación del documento, en la zona del perfil.
 */
export function contractDatePartsFromTimezone(input?: {
  now?: Date;
  timezone?: string | null;
}): { contract_day: string; contract_month: string; contract_year: string } {
  const timezone =
    typeof input?.timezone === "string" && input.timezone.trim()
      ? input.timezone.trim()
      : "America/Mexico_City";
  const now = input?.now ?? new Date();
  try {
    const parts = new Intl.DateTimeFormat("es-MX", {
      timeZone: timezone,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(now);
    const day = parts.find((part) => part.type === "day")?.value ?? "";
    const monthRaw = parts.find((part) => part.type === "month")?.value ?? "";
    const year = parts.find((part) => part.type === "year")?.value ?? "";
    const monthNormalized = monthRaw
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    const month =
      MONTH_NAMES_ES.find(
        (name) =>
          name.normalize("NFD").replace(/\p{M}/gu, "") === monthNormalized
      ) ?? monthRaw.toLowerCase();
    return {
      contract_day: day,
      contract_month: month,
      contract_year: year,
    };
  } catch {
    const fallback = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(now);
    return {
      contract_day: fallback.find((part) => part.type === "day")?.value ?? "",
      contract_month: (
        fallback.find((part) => part.type === "month")?.value ?? ""
      ).toLowerCase(),
      contract_year: fallback.find((part) => part.type === "year")?.value ?? "",
    };
  }
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
  /** IANA timezone from user profile; defaults to America/Mexico_City. */
  timezone?: string | null;
  /** Override generation/signing instant (tests). */
  now?: Date;
}): Record<CommissionContractPlaceholderKey, string | number | boolean> {
  const caseContext = input.case_context ?? {};
  const propertyData = input.property_data ?? {};
  const pricing = input.pricing_proposal ?? {};
  const commission = input.commission_terms ?? {};
  const contact = input.external_contact ?? {};
  const ownerName = resolveContractOwnerName({ caseContext, propertyData, contact });
  const legalAddress = legalAddressFromContext(caseContext, propertyData);

  const salida =
    pricing.salida ?? pricing.salida_price ?? pricing.list_price ?? "";

  const commissionPct = firstValue(
    commission.commission_pct,
    commission.commission_percent,
    commission.pct
  );
  const durationMonths = firstValue(commission.duration_months, commission.months);
  const operationKind = resolveContractOperationKind([
    propertyData,
    caseContext,
    pricing,
    commission,
  ]);
  const dateParts = contractDatePartsFromTimezone({
    now: input.now,
    timezone: input.timezone,
  });

  return {
    owner_name: ownerName,
    owner_email: resolveOwnerEmail({ caseContext, propertyData, contact }),
    property_address: legalAddress || readablePropertyAddress(propertyData),
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
    commission_pct: templateScalar(commissionPct ?? "") as string | number,
    commission_pct_words: percentToSpanishWords(commissionPct),
    exclusive: templateScalar(commission.exclusive ?? "") as string | boolean,
    duration_months: templateScalar(durationMonths ?? "") as string | number,
    duration_months_words: integerToSpanishWordsLower(durationMonths),
    operation_type: operationTypeLabel(operationKind),
    operation_contract_type: operationContractTypeLabel(operationKind),
    contract_day: dateParts.contract_day,
    contract_month: dateParts.contract_month,
    contract_year: dateParts.contract_year,
  };
}
