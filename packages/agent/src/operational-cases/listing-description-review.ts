export type ListingDescriptionDraftLike = Record<string, unknown>;

type ListingDescriptionReviewFormatOptions = {
  maxDescriptionLength?: number;
  currentContext?: Record<string, unknown> | null;
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function stringArrayFromValue(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}

const MISSING_INGREDIENT_LABELS: Record<string, string> = {
  municipality: "municipio",
  state: "estado",
  neighborhood: "colonia o zona",
  municipality_state: "municipio y estado",
  area_built_m2: "superficie construida",
  area_total_m2: "superficie total",
  legal_address: "dirección legal",
  target_price: "precio objetivo",
  listing_price: "precio de publicación",
  currency: "moneda",
  bedrooms: "número de recámaras",
  bathrooms: "número de baños",
  parking_spots: "estacionamiento",
  property_type: "tipo de propiedad",
  operation_type: "tipo de operación",
  "bathroom photos": "fotos de baños",
  "parking photos": "fotos del estacionamiento",
  raw_photos: "fotos del inmueble",
  "raw_photos>=5": "al menos 5 fotos del inmueble",
  photo_analysis: "análisis visual de fotos",
  zone_context: "contexto verificado de la zona",
  advisor_highlights: "puntos clave del asesor",
};

function humanizeMissingIngredient(value: string): string {
  const normalized = value.trim();
  const key = normalized.toLowerCase();
  if (MISSING_INGREDIENT_LABELS[key]) return MISSING_INGREDIENT_LABELS[key];

  const withoutPrefixes = normalized
    .replace(/^property_data[._]/i, "")
    .replace(/^pricing_proposal[._]/i, "")
    .replace(/^photo_analysis[._]/i, "");
  const fallback = withoutPrefixes
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return fallback || normalized;
}

function addIfPresent(target: Set<string>, key: string, value: unknown) {
  if (cleanText(value) || positiveNumber(value) != null) {
    target.add(key);
  }
}

function flattenPropertyContextForIngredients(
  context: Record<string, unknown>
): Record<string, unknown> {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const address = isRecord(propertyData.address) ? propertyData.address : {};
  const rootAddress = isRecord(context.address) ? context.address : {};
  return {
    ...propertyData,
    ...context,
    address: { ...address, ...rootAddress },
  };
}

function derivePresentIngredientKeys(context?: Record<string, unknown> | null) {
  const present = new Set<string>();
  if (!context) return present;
  const propertyData = flattenPropertyContextForIngredients(context);
  const address = isRecord(propertyData.address) ? propertyData.address : {};
  const copyIngredients = isRecord(context.listing_copy_ingredients)
    ? context.listing_copy_ingredients
    : {};

  addIfPresent(
    present,
    "municipality",
    propertyData.municipality ?? propertyData.city ?? address.municipality ?? address.city
  );
  addIfPresent(present, "state", propertyData.state ?? address.state);
  addIfPresent(
    present,
    "neighborhood",
    propertyData.neighborhood ?? propertyData.fraccionamiento ?? address.neighborhood
  );
  addIfPresent(
    present,
    "legal_address",
    propertyData.legal_address ?? address.formatted_address ?? propertyData.address
  );
  addIfPresent(
    present,
    "area_built_m2",
    propertyData.area_built_m2 ??
      propertyData.built_area_m2 ??
      propertyData.built_area ??
      propertyData.construction_m2 ??
      propertyData.construction_area_m2 ??
      propertyData.construction_size ??
      propertyData.superficie_construida ??
      propertyData.area_construida_m2
  );
  addIfPresent(
    present,
    "area_total_m2",
    propertyData.area_total_m2 ??
      propertyData.land_m2 ??
      propertyData.lot_size ??
      propertyData.lot_size_m2 ??
      propertyData.superficie_total
  );

  for (const key of [
    "municipality",
    "state",
    "neighborhood",
    "legal_address",
    "area_built_m2",
    "area_total_m2",
  ]) {
    addIfPresent(present, key, copyIngredients[key]);
  }

  if (present.has("municipality") && present.has("state")) {
    present.add("municipality_state");
  }
  return present;
}

function missingIngredientKey(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.includes("municipality_state")) return "municipality_state";
  if (normalized.includes("municipality") || normalized === "municipio") {
    return "municipality";
  }
  if (normalized === "estado" || normalized.includes("state")) return "state";
  if (
    normalized.includes("neighborhood") ||
    normalized.includes("colonia") ||
    normalized.includes("zona")
  ) {
    return "neighborhood";
  }
  if (normalized.includes("area_built_m2") || normalized.includes("superficie construida")) {
    return "area_built_m2";
  }
  if (normalized.includes("area_total_m2") || normalized.includes("superficie total")) {
    return "area_total_m2";
  }
  if (normalized.includes("legal_address") || normalized.includes("direccion legal")) {
    return "legal_address";
  }
  return null;
}

function ingredientIsContradictedByContext(
  ingredient: string,
  presentIngredients: Set<string>
) {
  const key = missingIngredientKey(ingredient);
  if (!key) return false;
  if (key === "municipality_state") {
    return presentIngredients.has("municipality") && presentIngredients.has("state");
  }
  return presentIngredients.has(key);
}

function humanizedStringArrayFromValue(value: unknown, limit = 8): string[] {
  return Array.from(
    new Set(stringArrayFromValue(value, limit * 2).map(humanizeMissingIngredient))
  ).slice(0, limit);
}

function truncateDescription(description: string, maxLength: number) {
  if (description.length <= maxLength) {
    return { text: description, truncated: false };
  }
  return {
    text: `${description.slice(0, Math.max(0, maxLength - 3)).trim()}...`,
    truncated: true,
  };
}

/**
 * Commercial copy must not expose internal visual-analysis caveats or mutable
 * structured commercial values. Price, currency, commission, availability and
 * listing status belong in portal fields so one field remains the source of
 * truth throughout the commercialization lifecycle.
 */
export function sanitizeListingDescriptionCommercialCopy(value: unknown): string {
  const text = cleanText(value);
  if (!text) return "";
  const withoutMutableCommercialSentences = text
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/u)
    .filter((sentence) => {
      const exactMoney =
        /(?:[$€£]\s*\d)|(?:\b\d[\d.,\s]*\s*(?:mxn|usd|eur|pesos?|d[oó]lares?)\b)/i;
      const mutableCommercialValue =
        /\b(?:precio(?:\s+de\s+(?:venta|renta|publicaci[oó]n))?|renta\s+mensual|mantenimiento|comisi[oó]n)\b[^.!?]{0,100}\d/i;
      return !exactMoney.test(sentence) && !mutableCommercialValue.test(sentence);
    })
    .join(" ")
    .trim();
  return withoutMutableCommercialSentences
    .replace(
      /\s*,?\s*(?:aunque|pero)\s+[^.!?]{0,180}?\b(?:no\s+(?:es|son|está|están)\s+(?:claramente\s+)?visibles?|no\s+se\s+(?:aprecia|observa|ve|distingue))[^.!?]{0,120}?\b(?:imágenes|fotografías|fotos)\b[^.!?]*/gi,
      ""
    )
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatListingDescriptionReviewNotifyText(
  draft: ListingDescriptionDraftLike,
  options: ListingDescriptionReviewFormatOptions = {}
): string {
  const headline = sanitizeListingDescriptionCommercialCopy(draft.headline);
  const shortDescription = sanitizeListingDescriptionCommercialCopy(
    draft.short_description
  );
  const description = sanitizeListingDescriptionCommercialCopy(draft.description);
  const presentIngredients = derivePresentIngredientKeys(options.currentContext);
  const missingIngredients = humanizedStringArrayFromValue(draft.missing_ingredients, 8)
    .filter((item) => !ingredientIsContradictedByContext(item, presentIngredients));
  const maxDescriptionLength = options.maxDescriptionLength ?? 1200;
  const excerpt = truncateDescription(description, maxDescriptionLength);

  const lines = [
    "**Revisión de descripción comercial**",
    "",
    "Revisa el borrador preparado para publicar la propiedad.",
    "",
    headline ? `**Título:** ${headline}` : null,
    shortDescription ? `**Resumen corto:** ${shortDescription}` : null,
    excerpt.text ? `**Descripción:** ${excerpt.text}` : null,
    excerpt.truncated
      ? "Nota: texto recortado para este mensaje. Revisa el borrador completo en el panel del caso."
      : null,
    missingIngredients.length > 0
      ? `**Posibles mejoras futuras (opcionales):** Si más adelante se actualiza la ficha, podrían enriquecerla: ${missingIngredients.join(", ")}. No son requisitos para aprobar ni continuar; este paso solo revisa el texto y no solicita una nueva carga.`
      : null,
    "",
    "Usa los botones: Aprobar descripción o Pedir cambios. Si respondes por texto, describe qué ajustar, qué puntos clave agregar o pega una versión exacta.",
  ].filter((line): line is string => line != null);

  return lines.join("\n").trim();
}
