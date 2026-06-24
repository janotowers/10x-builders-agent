type RecordValue = Record<string, unknown>;

export type ComparableSearchValidity =
  | "valid"
  | "invalid_filters"
  | "missing_required_source"
  | "property_data_untrusted"
  | "insufficient_market_data";

export type ComparableAreaBand = {
  min_area_m2: number;
  max_area_m2: number;
  area_basis: "constructed" | "total";
  source_area_m2: number;
  fallback_level: "strict" | "expanded" | "wide";
};

export type ComparableFilterContractResult = {
  filters: RecordValue;
  search_validity: ComparableSearchValidity;
  invalid_fields: string[];
  warnings: string[];
  suggested_filters?: RecordValue;
  fallback_filters?: RecordValue;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstPositiveNumber(
  source: RecordValue,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = positiveNumberOrNull(source[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function operationOrNull(value: unknown): "sale" | "rent" | null {
  const cleaned = cleanString(value)?.toLowerCase();
  if (!cleaned) return null;
  if (cleaned === "sale" || cleaned.includes("venta")) return "sale";
  if (cleaned === "rent" || cleaned.includes("renta")) return "rent";
  return null;
}

function normalizePropertyType(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned ?? null;
}

function normalizeComparableRange(params: {
  minValue: number | null;
  maxValue: number | null;
  minField: string;
  maxField: string;
}): {
  minValue: number | null;
  maxValue: number | null;
  invalidFields: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const invalidFields: string[] = [];
  const minValue = params.minValue;
  const maxValue = params.maxValue;
  if (minValue == null && maxValue == null) {
    return { minValue: null, maxValue: null, invalidFields, warnings };
  }
  if (minValue != null && maxValue != null && minValue >= maxValue) {
    invalidFields.push(params.minField, params.maxField);
    warnings.push(
      `Rango inválido: ${params.minField} (${minValue}) debe ser menor que ${params.maxField} (${maxValue}).`
    );
    return { minValue: null, maxValue: null, invalidFields, warnings };
  }
  return { minValue, maxValue, invalidFields, warnings };
}

export function requiresAvaclick(propertyData: RecordValue): boolean {
  const propertyType = normalizePropertyType(
    propertyData.property_type ??
      propertyData.tipo_propiedad ??
      propertyData.propertyType
  )?.toLowerCase();
  if (!propertyType) return false;
  return (
    propertyType.includes("casa") ||
    propertyType.includes("departamento") ||
    propertyType.includes("depto") ||
    propertyType.includes("condo")
  );
}

export function deriveComparableAreaBand(input: {
  propertyData: RecordValue;
  fallbackLevel?: "strict" | "expanded" | "wide";
}): ComparableAreaBand | null {
  const fallbackLevel = input.fallbackLevel ?? "strict";
  const ratio =
    fallbackLevel === "strict" ? 0.15 : fallbackLevel === "expanded" ? 0.25 : 0.35;
  const absoluteBand = fallbackLevel === "strict" ? 20 : fallbackLevel === "expanded" ? 30 : 40;
  const propertyData = input.propertyData;
  const areaConstruida = firstPositiveNumber(propertyData, [
    "area_construida_m2",
    "construction_area_m2",
    "built_area_m2",
    "sup_const",
  ]);
  const areaTotal = firstPositiveNumber(propertyData, [
    "area_total_m2",
    "area_m2",
    "surface_m2",
    "sup_terr",
  ]);
  const sourceArea = areaConstruida ?? areaTotal;
  if (sourceArea == null) return null;
  const area_basis: ComparableAreaBand["area_basis"] =
    areaConstruida != null ? "constructed" : "total";
  const delta = Math.max(Math.round(sourceArea * ratio), absoluteBand);
  const min_area_m2 = Math.max(1, Math.round(sourceArea - delta));
  const max_area_m2 = Math.max(min_area_m2 + 1, Math.round(sourceArea + delta));
  return {
    min_area_m2,
    max_area_m2,
    area_basis,
    source_area_m2: sourceArea,
    fallback_level: fallbackLevel,
  };
}

export function buildComparableSearchFilters(input: {
  context: RecordValue;
  fallbackLevel?: "strict" | "expanded" | "wide";
}): ComparableFilterContractResult {
  const context = input.context;
  const propertyData = isRecord(context.property_data) ? context.property_data : context;
  const zona =
    cleanString(propertyData.zona) ??
    cleanString(propertyData.property_zone) ??
    cleanString(propertyData.neighborhood) ??
    cleanString(propertyData.colonia) ??
    cleanString(propertyData.city_area);
  const operation = operationOrNull(
    propertyData.operation ?? propertyData.operation_type ?? propertyData.tipo_operacion
  );
  const property_type = normalizePropertyType(
    propertyData.property_type ?? propertyData.tipo_propiedad ?? propertyData.propertyType
  );
  const areaBand = deriveComparableAreaBand({
    propertyData,
    fallbackLevel: input.fallbackLevel ?? "strict",
  });
  const filters: RecordValue = {};
  if (zona) filters.zona = zona;
  if (operation) filters.operation = operation;
  if (property_type) filters.property_type = property_type;
  if (areaBand) {
    filters.min_area_m2 = areaBand.min_area_m2;
    filters.max_area_m2 = areaBand.max_area_m2;
    filters.area_basis = areaBand.area_basis;
  }
  if (!zona || !operation || !property_type) {
    return {
      filters,
      search_validity: "invalid_filters",
      invalid_fields: [
        ...(!zona ? ["zona"] : []),
        ...(!operation ? ["operation"] : []),
        ...(!property_type ? ["property_type"] : []),
      ],
      warnings: ["Faltan filtros base para búsqueda de comparables."],
    };
  }
  return {
    filters,
    search_validity: "valid",
    invalid_fields: [],
    warnings: [],
  };
}

export function sanitizeComparableSearchFilters(input: {
  raw: RecordValue;
  propertyData?: RecordValue;
  allowExactZeroParking?: boolean;
}): ComparableFilterContractResult {
  const raw = input.raw;
  const warnings: string[] = [];
  const invalid_fields: string[] = [];
  const filters: RecordValue = {};

  const zona = cleanString(raw.zona ?? raw.neighborhood ?? raw.colonia);
  if (zona) filters.zona = zona;

  const operation = operationOrNull(raw.operation);
  if (operation) filters.operation = operation;

  const property_type = normalizePropertyType(raw.property_type);
  if (property_type) filters.property_type = property_type;

  const minPrice = positiveNumberOrNull(raw.min_price);
  const maxPrice = positiveNumberOrNull(raw.max_price);
  const normalizedPrice = normalizeComparableRange({
    minValue: minPrice,
    maxValue: maxPrice,
    minField: "min_price",
    maxField: "max_price",
  });
  warnings.push(...normalizedPrice.warnings);
  invalid_fields.push(...normalizedPrice.invalidFields);
  if (normalizedPrice.minValue != null) filters.min_price = normalizedPrice.minValue;
  if (normalizedPrice.maxValue != null) filters.max_price = normalizedPrice.maxValue;

  const minArea = positiveNumberOrNull(raw.min_area_m2);
  const maxArea = positiveNumberOrNull(raw.max_area_m2);
  const normalizedArea = normalizeComparableRange({
    minValue: minArea,
    maxValue: maxArea,
    minField: "min_area_m2",
    maxField: "max_area_m2",
  });
  warnings.push(...normalizedArea.warnings);
  invalid_fields.push(...normalizedArea.invalidFields);
  if (normalizedArea.minValue != null) filters.min_area_m2 = normalizedArea.minValue;
  if (normalizedArea.maxValue != null) filters.max_area_m2 = normalizedArea.maxValue;

  const bedrooms = positiveNumberOrNull(raw.bedrooms);
  if (bedrooms != null) filters.bedrooms = Math.trunc(bedrooms);
  const bathrooms = positiveNumberOrNull(raw.bathrooms);
  if (bathrooms != null) filters.bathrooms = Math.trunc(bathrooms);
  const parking = positiveNumberOrNull(raw.parking_spaces);
  if (parking != null) {
    filters.parking_spaces = Math.trunc(parking);
  } else if (
    raw.parking_spaces === 0 &&
    input.allowExactZeroParking === true
  ) {
    filters.parking_spaces = 0;
  } else if (raw.parking_spaces === 0) {
    warnings.push(
      "Se descartó parking_spaces=0 como filtro exacto; se considera valor no confiable por default."
    );
  }

  const page = positiveNumberOrNull(raw.page);
  if (page != null) filters.page = Math.trunc(page);
  const limit = positiveNumberOrNull(raw.limit);
  if (limit != null) filters.limit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const monthsBack = positiveNumberOrNull(raw.months_back);
  if (monthsBack != null) filters.months_back = Math.trunc(monthsBack);

  let search_validity: ComparableSearchValidity = "valid";
  if (invalid_fields.length > 0) {
    search_validity = "invalid_filters";
  }

  // La banda de área canónica derivada de property_data confiable es la ÚNICA
  // fuente válida para filtros de área. Nunca se confía en un rango provisto por
  // el modelo sin respaldo: un rango fuera de escala (p. ej. 60-90 m² para una
  // casa de 146 m², o un rango inventado cuando no se conoce la superficie)
  // envenena la búsqueda y devuelve cero comparables.
  const strictAreaBand = input.propertyData
    ? deriveComparableAreaBand({ propertyData: input.propertyData })
    : null;
  const propertyDataProvided = input.propertyData != null;
  const providedAreaRange =
    normalizedArea.minValue != null || normalizedArea.maxValue != null;

  if (strictAreaBand) {
    // Caso con superficie confiable: imponer la banda canónica salvo que el rango
    // provisto ya contenga el área confiable del caso.
    const trustedArea = strictAreaBand.source_area_m2;
    const providedRangeContainsTrustedArea =
      normalizedArea.minValue != null &&
      normalizedArea.maxValue != null &&
      trustedArea >= normalizedArea.minValue &&
      trustedArea <= normalizedArea.maxValue;
    if (!providedRangeContainsTrustedArea) {
      if (providedAreaRange) {
        warnings.push(
          `Se reemplazó rango de área provisto (${normalizedArea.minValue ?? "?"}-${normalizedArea.maxValue ?? "?"} m²) por banda canónica (${strictAreaBand.min_area_m2}-${strictAreaBand.max_area_m2} m²) derivada del área confiable del caso (${trustedArea} m²).`
        );
      } else {
        warnings.push(
          `Se derivó rango de área automáticamente (${strictAreaBand.min_area_m2}-${strictAreaBand.max_area_m2} m²) desde property_data.`
        );
      }
      filters.min_area_m2 = strictAreaBand.min_area_m2;
      filters.max_area_m2 = strictAreaBand.max_area_m2;
      filters.area_basis = strictAreaBand.area_basis;
    }
  } else if (propertyDataProvided && providedAreaRange) {
    // No hay superficie confiable en property_data y el modelo envió un rango de
    // área (probablemente inferido/inventado). Se descarta para no sesgar la
    // búsqueda: los comparables se obtienen sin restricción de área y la
    // superficie se resuelve aguas abajo (precio/m² ya está protegido cuando el
    // área no es confiable).
    delete filters.min_area_m2;
    delete filters.max_area_m2;
    delete filters.area_basis;
    warnings.push(
      `Se descartaron filtros de área provistos (${normalizedArea.minValue ?? "?"}-${normalizedArea.maxValue ?? "?"} m²) porque no hay superficie confiable en property_data; la búsqueda se ejecuta sin restricción de área.`
    );
  }

  const missingBaseFields = [
    filters.zona == null ? "zona" : null,
    filters.operation == null ? "operation" : null,
    filters.property_type == null ? "property_type" : null,
  ].filter((item): item is string => item != null);
  if (missingBaseFields.length > 0) {
    search_validity = "invalid_filters";
    invalid_fields.push(...missingBaseFields);
  }

  const suggestedResult = input.propertyData
    ? buildComparableSearchFilters({ context: input.propertyData })
    : null;
  const fallbackResult = input.propertyData
    ? buildComparableSearchFilters({
        context: input.propertyData,
        fallbackLevel: "expanded",
      })
    : null;
  const suggested_filters =
    search_validity === "invalid_filters" && suggestedResult?.search_validity === "valid"
      ? suggestedResult.filters
      : undefined;
  const fallback_filters =
    fallbackResult?.search_validity === "valid"
      ? fallbackResult.filters
      : undefined;

  return {
    filters,
    search_validity,
    invalid_fields: Array.from(new Set(invalid_fields)),
    warnings,
    ...(suggested_filters ? { suggested_filters } : {}),
    ...(fallback_filters ? { fallback_filters } : {}),
  };
}

export function classifyComparableSearchOutcome(input: {
  usable_count: number;
  search_validity: ComparableSearchValidity | null | undefined;
  property_data_untrusted?: boolean;
  missing_required_source?: boolean;
}): ComparableSearchValidity {
  if (input.search_validity === "invalid_filters") return "invalid_filters";
  if (input.missing_required_source) return "missing_required_source";
  if (input.property_data_untrusted) return "property_data_untrusted";
  if (input.usable_count <= 0) return "insufficient_market_data";
  return "valid";
}
