/**
 * Placeholders canónicos de la plantilla DOCX de contrato de comisión.
 * Los cinco primeros suelen estar en la plantilla del tenant; el resto son
 * opcionales para futuras versiones del documento.
 */
export const COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS = [
  "owner_name",
  "property_address",
  "property_type",
  "area_m2",
  "salida_price",
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

/** Dirección legible desde property_data.address (string u objeto). */
export function readablePropertyAddress(
  propertyData: Record<string, unknown>
): string {
  const address = propertyData.address;
  if (typeof address === "string") return address.trim();
  if (isRecord(address)) {
    return [
      address.street,
      address.exterior_number,
      address.neighborhood,
      address.city,
      address.state,
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join(", ");
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
    property_address: readablePropertyAddress(propertyData),
    property_type: templateScalar(
      propertyData.property_type ?? propertyData.type ?? ""
    ) as string,
    area_m2: templateScalar(
      firstValue(
        propertyData.area_m2,
        propertyData.area_total_m2,
        propertyData.built_area_m2,
        propertyData.area_construida_m2,
        propertyData.area
      ) ?? ""
    ) as string | number,
    salida_price: templateScalar(salida) as string | number,
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
