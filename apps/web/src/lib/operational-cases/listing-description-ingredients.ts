type JsonRecord = Record<string, unknown>;

export type ListingDescriptionIngredients = {
  propertyType: string;
  operationType: string;
  municipality: string;
  state: string;
  neighborhood: string;
  legalAddress: string;
  targetPrice: number | null;
  currency: string;
  bedrooms: number | null;
  bathrooms: number | null;
  parkingSpots: number | null;
  areaTotalM2: number | null;
  areaBuiltM2: number | null;
  rawPhotosCount: number;
  zonePointsOfInterest: string[];
  advisorHighlights: string[];
  missingIngredients: string[];
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function collectListingDescriptionIngredients(
  context: JsonRecord
): ListingDescriptionIngredients {
  const propertyData = asRecord(context.property_data);
  const address = asRecord(propertyData.address);
  const pricingProposal = asRecord(context.pricing_proposal);
  const zoneContext = asRecord(context.zone_context);
  const rawPhotosCount = Array.isArray(context.raw_photos) ? context.raw_photos.length : 0;

  const municipality = cleanText(
    propertyData.municipality || propertyData.city || address.municipality || address.city
  );
  const state = cleanText(propertyData.state || address.state);
  const neighborhood = cleanText(
    propertyData.neighborhood || propertyData.fraccionamiento || address.neighborhood
  );
  const legalAddress =
    cleanText(propertyData.legal_address) ||
    cleanStringArray(propertyData.legal_addresses)[0] ||
    cleanText(address.formatted_address) ||
    cleanText(propertyData.address);
  const targetPrice = numberOrNull(pricingProposal.target_price ?? propertyData.target_price);
  const currency =
    cleanText(pricingProposal.currency) || cleanText(propertyData.currency) || "MXN";

  const zonePointsOfInterest = [
    ...cleanStringArray(zoneContext.points_of_interest),
    ...cleanStringArray(context.zone_points_of_interest),
  ].slice(0, 12);
  const advisorHighlights = [
    ...cleanStringArray(context.listing_highlights),
    ...cleanStringArray(context.listing_advisor_notes),
  ].slice(0, 12);

  const ingredients: ListingDescriptionIngredients = {
    propertyType:
      cleanText(propertyData.property_type || context.property_type) || "propiedad",
    operationType: cleanText(propertyData.operation || context.operation_type),
    municipality,
    state,
    neighborhood,
    legalAddress,
    targetPrice,
    currency,
    bedrooms: numberOrNull(propertyData.bedrooms),
    bathrooms: numberOrNull(propertyData.bathrooms),
    parkingSpots: numberOrNull(propertyData.parking_spots),
    areaTotalM2: numberOrNull(propertyData.area_total_m2),
    areaBuiltM2:
      numberOrNull(propertyData.area_construida_m2) ??
      numberOrNull(propertyData.area_built_m2),
    rawPhotosCount,
    zonePointsOfInterest,
    advisorHighlights,
    missingIngredients: [],
  };

  const missing: string[] = [];
  if (!ingredients.operationType) missing.push("operation_type");
  if (!ingredients.municipality || !ingredients.state) missing.push("municipality_state");
  if (!ingredients.legalAddress) missing.push("legal_address");
  if (ingredients.targetPrice == null || ingredients.targetPrice <= 0) missing.push("target_price");
  if (ingredients.rawPhotosCount < 5) missing.push("raw_photos>=5");
  if (ingredients.advisorHighlights.length === 0) missing.push("advisor_highlights");

  ingredients.missingIngredients = missing;
  return ingredients;
}

export function buildListingDescriptionPrompt(
  ingredients: ListingDescriptionIngredients
): string {
  const highlights =
    ingredients.advisorHighlights.length > 0
      ? ingredients.advisorHighlights.map((item) => `- ${item}`).join("\n")
      : "- (sin highlights adicionales del asesor)";
  const pointsOfInterest =
    ingredients.zonePointsOfInterest.length > 0
      ? ingredients.zonePointsOfInterest.map((item) => `- ${item}`).join("\n")
      : "- (sin puntos de interes verificados)";
  return [
    "Redacta una descripcion inmobiliaria en espanol para LATAM (120 a 220 palabras).",
    "Debe ser atractiva pero sobria: no exageres, no inventes atributos ni promesas.",
    "Si un dato no existe en ingredientes, no lo menciones.",
    "No menciones precio, moneda, comision, mantenimiento, disponibilidad, vigencia ni estado de publicacion: son campos estructurados mutables del listing.",
    "",
    `Tipo: ${ingredients.propertyType}`,
    `Operacion: ${ingredients.operationType || "sin definir"}`,
    `Direccion legal/base: ${ingredients.legalAddress || "sin definir"}`,
    `Zona: ${ingredients.neighborhood || "sin colonia"}, ${ingredients.municipality}, ${ingredients.state}`,
    "Precio objetivo: validado por separado para readiness; no incluir en el copy.",
    `Recamaras: ${ingredients.bedrooms ?? "N/D"}`,
    `Banos: ${ingredients.bathrooms ?? "N/D"}`,
    `Estacionamientos: ${ingredients.parkingSpots ?? "N/D"}`,
    `m2 terreno: ${ingredients.areaTotalM2 ?? "N/D"}`,
    `m2 construccion: ${ingredients.areaBuiltM2 ?? "N/D"}`,
    `Fotos disponibles: ${ingredients.rawPhotosCount}`,
    "",
    "Highlights del asesor:",
    highlights,
    "",
    "Puntos de interes verificados de la zona:",
    pointsOfInterest,
    "",
    "Entrega solo el texto final de la descripcion, sin markdown ni encabezados.",
  ].join("\n");
}

export function buildListingApprovalSummary(
  ingredients: ListingDescriptionIngredients
): string {
  const coverage = `${ingredients.rawPhotosCount} foto(s)`;
  const highlights =
    ingredients.advisorHighlights.length > 0
      ? ingredients.advisorHighlights.join("; ")
      : "Sin highlights del asesor";
  return [
    `Tipo/operacion: ${ingredients.propertyType} / ${ingredients.operationType || "N/D"}`,
    `Ubicacion: ${ingredients.neighborhood || "N/D"}, ${ingredients.municipality}, ${ingredients.state}`,
    `Precio: ${ingredients.targetPrice ?? "N/D"} ${ingredients.currency}`,
    `Atributos: rec ${ingredients.bedrooms ?? "N/D"}, banos ${ingredients.bathrooms ?? "N/D"}, est ${ingredients.parkingSpots ?? "N/D"}`,
    `Superficies: terreno ${ingredients.areaTotalM2 ?? "N/D"} m2, construccion ${ingredients.areaBuiltM2 ?? "N/D"} m2`,
    `Cobertura de fotos: ${coverage}`,
    `Highlights asesor: ${highlights}`,
  ].join("\n");
}
