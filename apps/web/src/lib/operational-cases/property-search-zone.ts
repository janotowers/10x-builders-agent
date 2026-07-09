/**
 * Zona y filtros compartidos entre recipes N1 (contexto plano) y skills (property_data).
 * Patrón: PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT
 */

const ZONE_ROOT_KEYS = [
  "property_zone",
  "zona",
  "colonia",
  "neighborhood",
  "city_area",
  "property_address",
  "address",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Zona efectiva para búsquedas (prioriza intake / caso de prueba en raíz del contexto). */
export function resolveEffectiveSearchZone(
  context: Record<string, unknown>
): string | null {
  for (const key of ZONE_ROOT_KEYS) {
    const value = context[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  for (const key of ZONE_ROOT_KEYS) {
    const value = propertyData[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const address = isRecord(propertyData.address) ? propertyData.address : {};
  return firstNonEmptyString(
    address.neighborhood,
    address.colonia,
    address.city,
    address.street
  );
}

/** Contexto plano para recipes N1/N2 (raíz + campos útiles de property_data). */
export function mergeContextForToolRecipes(
  context: Record<string, unknown>
): Record<string, unknown> {
  const propertyData = isRecord(context.property_data)
    ? (context.property_data as Record<string, unknown>)
    : {};
  const zone = resolveEffectiveSearchZone(context);
  const merged: Record<string, unknown> = {
    ...propertyData,
    ...context,
  };
  if (zone) {
    merged.property_zone = merged.property_zone ?? zone;
    merged.zona = merged.zona ?? zone;
  }
  return merged;
}

/** Alinea property_data para skills de comparables (neighborhood = zona del caso). */
export function mergePropertyDataForComparables(
  context: Record<string, unknown>,
  patch?: Record<string, unknown>
): Record<string, unknown> {
  const base = isRecord(context.property_data)
    ? (context.property_data as Record<string, unknown>)
    : {};
  const zone = resolveEffectiveSearchZone(context);
  const patchPd = patch && isRecord(patch.property_data)
    ? (patch.property_data as Record<string, unknown>)
    : {};
  const baseAddress = isRecord(base.address) ? base.address : {};
  const patchAddress = isRecord(patchPd.address) ? patchPd.address : {};

  const address: Record<string, unknown> = {
    ...baseAddress,
    ...patchAddress,
  };
  if (zone) {
    address.neighborhood = firstNonEmptyString(
      patchAddress.neighborhood,
      baseAddress.neighborhood,
      zone
    );
  }

  return {
    ...base,
    ...patchPd,
    operation: patchPd.operation ?? base.operation ?? context.operation_type ?? "rent",
    property_type:
      patchPd.property_type ?? base.property_type ?? "departamento",
    area_total_m2: patchPd.area_total_m2 ?? base.area_total_m2,
    bedrooms: patchPd.bedrooms ?? base.bedrooms ?? context.bedrooms,
    bathrooms: patchPd.bathrooms ?? base.bathrooms ?? context.bathrooms,
    parking_spots:
      patchPd.parking_spots ?? base.parking_spots ?? context.parking_spaces,
    address,
    search_zone: zone ?? patchPd.search_zone ?? base.search_zone,
  };
}

/** Defaults de piloto solo si el caso no trae zona ni property_data útil. */
export function settingsTestPropertyDataSeed(
  context?: Record<string, unknown>
): Record<string, unknown> {
  const zone =
    context != null ? resolveEffectiveSearchZone(context) : null;
  const fallbackZone = "Colomos Providencia, Zapopan, Jalisco";
  const effectiveZone = zone ?? fallbackZone;
  return mergePropertyDataForComparables(
    context ?? {},
    {
      property_data: {
        operation: "rent",
        property_type: "departamento",
        area_total_m2: 116.93,
        area_construida_m2: 116.93,
        bedrooms: 3,
        bathrooms: 2,
        parking_spots: 1,
        address: {
          street: "Privada del Tulipán",
          exterior_number: "1501",
          neighborhood: effectiveZone,
          city: "Zapopan",
          state: "Jalisco",
          country: "MX",
          postal_code: "45050",
        },
        search_zone: effectiveZone,
      },
    }
  );
}
