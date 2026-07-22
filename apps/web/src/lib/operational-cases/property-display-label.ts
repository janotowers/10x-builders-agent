/**
 * Etiqueta natural y consistente de la propiedad para mensajes al asesor
 * (documentos, fotos, recordatorios). Sin ID de caso en el texto.
 *
 * Jerarquía: dirección corta → property_title → "tu propiedad".
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function propertyDataFromContext(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!isRecord(context)) return {};
  return isRecord(context.property_data) ? context.property_data : {};
}

/** Dirección corta legible (calle + número, opcional colonia/municipio). */
export function resolveShortPropertyAddress(
  context: Record<string, unknown> | null | undefined
): string {
  const propertyData = propertyDataFromContext(context);
  const street = cleanString(propertyData.street);
  const exterior = cleanString(propertyData.exterior_number);
  const neighborhood = cleanString(propertyData.neighborhood);
  const municipality = cleanString(propertyData.municipality);
  const legalAddress =
    cleanString(propertyData.legal_address) ||
    (Array.isArray(propertyData.legal_addresses)
      ? cleanString(propertyData.legal_addresses[0])
      : "");
  const shortAddress = [street, exterior].filter(Boolean).join(" ");
  if (shortAddress && neighborhood) return `${shortAddress}, ${neighborhood}`;
  if (shortAddress && municipality) return `${shortAddress}, ${municipality}`;
  if (shortAddress) return shortAddress;
  if (legalAddress) return legalAddress;
  // Fallback: address / legal_address en raíz o property_data.
  for (const key of ["address", "legal_address"] as const) {
    const fromData = cleanString(propertyData[key]);
    if (fromData) return fromData;
    const fromRoot = isRecord(context) ? cleanString(context[key]) : "";
    if (fromRoot) return fromRoot;
  }
  return "";
}

/**
 * Etiqueta para copy conversacional / recordatorios.
 * Prioriza dirección corta sobre títulos genéricos ("Casa").
 */
export function resolvePropertyDisplayLabel(
  context: Record<string, unknown> | null | undefined,
  options?: { fallback?: string }
): string {
  const fallback = options?.fallback?.trim() || "tu propiedad";
  const shortAddress = resolveShortPropertyAddress(context);
  if (shortAddress) return shortAddress;

  const propertyData = propertyDataFromContext(context);
  const titleFromData = cleanString(propertyData.property_title);
  if (titleFromData) return titleFromData;
  const titleFromRoot = isRecord(context)
    ? cleanString(context.property_title)
    : "";
  if (titleFromRoot) return titleFromRoot;

  return fallback;
}
