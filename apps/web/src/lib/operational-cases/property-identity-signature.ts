/**
 * Firma de identidad de la propiedad (detección de cambios de identidad
 * durante intake/revisión). Las primitivas de normalización viven en
 * `@agents/workflows` (impact-hash, Slice 3.2-2): este módulo fue el seed
 * de esa generalización y ahora las importa para que la firma y el
 * input-hash del plano de impacto no puedan divergir.
 */
import { cleanText, numberOrNull, stableRounded } from "@agents/workflows";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type PropertyIdentitySnapshot = {
  property_type: string;
  operation: string;
  search_zone: string;
  neighborhood: string;
  area_total_m2: number | null;
  area_construida_m2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking_spots: number | null;
};

export function buildPropertyIdentitySnapshot(
  source: JsonRecord | null | undefined
): PropertyIdentitySnapshot {
  const ctx = source ?? {};
  const propertyData = isRecord(ctx.property_data)
    ? (ctx.property_data as JsonRecord)
    : ctx;
  const address = isRecord(propertyData.address)
    ? (propertyData.address as JsonRecord)
    : {};
  return {
    property_type: cleanText(propertyData.property_type),
    operation: cleanText(propertyData.operation),
    search_zone: cleanText(propertyData.search_zone),
    neighborhood: cleanText(
      propertyData.neighborhood ?? propertyData.fraccionamiento ?? address.neighborhood
    ),
    area_total_m2: stableRounded(numberOrNull(propertyData.area_total_m2)),
    area_construida_m2: stableRounded(
      numberOrNull(propertyData.area_construida_m2 ?? propertyData.area_built_m2)
    ),
    bedrooms: numberOrNull(propertyData.bedrooms),
    bathrooms: numberOrNull(propertyData.bathrooms),
    parking_spots: numberOrNull(propertyData.parking_spots),
  };
}

export function buildPropertyIdentitySignature(
  source: JsonRecord | null | undefined
): string {
  return JSON.stringify(buildPropertyIdentitySnapshot(source));
}
