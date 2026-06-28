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

export type ComparableFallbackStep = {
  level: "expanded" | "wide" | "location_only";
  filters: RecordValue;
  reason: string;
};

export type ComparableFilterContractResult = {
  filters: RecordValue;
  search_validity: ComparableSearchValidity;
  invalid_fields: string[];
  warnings: string[];
  suggested_filters?: RecordValue;
  fallback_filters?: RecordValue;
  fallback_filter_ladder?: ComparableFallbackStep[];
};

const AREA_FILTER_KEYS = ["min_area_m2", "max_area_m2", "area_basis"] as const;

function omitFilterKeys(source: RecordValue, keys: readonly string[]): RecordValue {
  const next: RecordValue = { ...source };
  for (const key of keys) delete next[key];
  return next;
}

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

function firstPositiveNumber(source: RecordValue, keys: readonly string[]): number | null {
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

function isResidentialComparableType(value: unknown) {
  const normalized = normalizePropertyType(value)?.toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("casa") ||
    normalized.includes("departamento") ||
    normalized.includes("depto") ||
    normalized.includes("condo")
  );
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
      `Rango invalido: ${params.minField} (${minValue}) debe ser menor que ${params.maxField} (${maxValue}).`
    );
    return { minValue: null, maxValue: null, invalidFields, warnings };
  }
  return { minValue, maxValue, invalidFields, warnings };
}

function uniqueFallbackSteps(steps: ComparableFallbackStep[]): ComparableFallbackStep[] {
  const seen = new Set<string>();
  const out: ComparableFallbackStep[] = [];
  for (const step of steps) {
    const key = JSON.stringify(step.filters);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
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
  const propertyData = input.propertyData;
  const propertyType =
    propertyData.property_type ??
    propertyData.tipo_propiedad ??
    propertyData.propertyType;
  const residentialType = isResidentialComparableType(propertyType);
  const lowerRatio =
    fallbackLevel === "strict"
      ? 0.15
      : fallbackLevel === "expanded"
        ? 0.2
        : 0.25;
  const upperRatio =
    fallbackLevel === "strict"
      ? residentialType
        ? 0.85
        : 0.35
      : fallbackLevel === "expanded"
        ? residentialType
          ? 1.1
          : 0.6
        : residentialType
          ? 1.4
          : 0.9;
  const absoluteLowerBand = fallbackLevel === "strict" ? 20 : fallbackLevel === "expanded" ? 25 : 35;
  const absoluteUpperBand = fallbackLevel === "strict" ? 35 : fallbackLevel === "expanded" ? 50 : 75;
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
  const lowerDelta = Math.max(Math.round(sourceArea * lowerRatio), absoluteLowerBand);
  const upperDelta = Math.max(Math.round(sourceArea * upperRatio), absoluteUpperBand);
  const min_area_m2 = Math.max(1, Math.round(sourceArea - lowerDelta));
  const max_area_m2 = Math.max(min_area_m2 + 1, Math.round(sourceArea + upperDelta));
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
      warnings: ["Faltan filtros base para busqueda de comparables."],
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
  const propertyDataProvided = input.propertyData != null;
  const trustedReferencePrice = input.propertyData
    ? firstPositiveNumber(input.propertyData, [
        "target_price",
        "price",
        "listing_price",
        "asking_price",
        "precio",
        "precio_objetivo",
        "precio_estimado",
      ])
    : null;
  const providedPriceRange =
    normalizedPrice.minValue != null || normalizedPrice.maxValue != null;
  if (propertyDataProvided && providedPriceRange && trustedReferencePrice == null) {
    warnings.push(
      `Se descartaron filtros de precio provistos (${normalizedPrice.minValue ?? "?"}-${normalizedPrice.maxValue ?? "?"}) porque el caso aun no tiene precio objetivo confiable; la busqueda de mercado no debe autocensurarse por un tope inventado.`
    );
  } else {
    if (normalizedPrice.minValue != null) filters.min_price = normalizedPrice.minValue;
    if (normalizedPrice.maxValue != null) filters.max_price = normalizedPrice.maxValue;
  }

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

  if (raw.parking_spaces === 0 || raw.min_parking_spaces === 0) {
    warnings.push(
      "Se descarto parking_spaces=0 como filtro exacto; se considera valor no confiable por default."
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

  const strictAreaBand = input.propertyData
    ? deriveComparableAreaBand({ propertyData: input.propertyData })
    : null;
  const providedAreaRange =
    normalizedArea.minValue != null || normalizedArea.maxValue != null;

  if (strictAreaBand) {
    const trustedArea = strictAreaBand.source_area_m2;
    const providedRangeMatchesCanonicalStrict =
      normalizedArea.minValue != null &&
      normalizedArea.maxValue != null &&
      normalizedArea.minValue === strictAreaBand.min_area_m2 &&
      normalizedArea.maxValue === strictAreaBand.max_area_m2;
    if (!providedRangeMatchesCanonicalStrict) {
      if (providedAreaRange) {
        warnings.push(
          `Se reemplazo rango de area provisto (${normalizedArea.minValue ?? "?"}-${normalizedArea.maxValue ?? "?"} m2) por banda canonica estricta (${strictAreaBand.min_area_m2}-${strictAreaBand.max_area_m2} m2) derivada del area confiable del caso (${trustedArea} m2).`
        );
      } else {
        warnings.push(
          `Se derivo rango de area canonico estricto (${strictAreaBand.min_area_m2}-${strictAreaBand.max_area_m2} m2) desde property_data.`
        );
      }
    }
    filters.min_area_m2 = strictAreaBand.min_area_m2;
    filters.max_area_m2 = strictAreaBand.max_area_m2;
    filters.area_basis = strictAreaBand.area_basis;
  } else if (propertyDataProvided && providedAreaRange) {
    delete filters.min_area_m2;
    delete filters.max_area_m2;
    delete filters.area_basis;
    warnings.push(
      `Se descartaron filtros de area provistos (${normalizedArea.minValue ?? "?"}-${normalizedArea.maxValue ?? "?"} m2) porque no hay superficie confiable en property_data; la busqueda se ejecuta sin restriccion de area.`
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

  const fallbackSeedContext: RecordValue = {
    ...(input.propertyData ?? {}),
    property_zone:
      filters.zona ??
      cleanString(input.propertyData?.property_zone) ??
      cleanString(input.propertyData?.zona) ??
      undefined,
    operation:
      filters.operation ??
      operationOrNull(input.propertyData?.operation ?? input.propertyData?.operation_type) ??
      undefined,
    property_type:
      filters.property_type ??
      normalizePropertyType(
        input.propertyData?.property_type ??
          input.propertyData?.tipo_propiedad ??
          input.propertyData?.propertyType
      ) ??
      undefined,
  };
  const suggestedResult = buildComparableSearchFilters({ context: fallbackSeedContext });
  const expandedFallbackResult = buildComparableSearchFilters({
    context: fallbackSeedContext,
    fallbackLevel: "expanded",
  });
  const wideFallbackResult = buildComparableSearchFilters({
    context: fallbackSeedContext,
    fallbackLevel: "wide",
  });

  const fallbackSteps: ComparableFallbackStep[] = [];
  if (expandedFallbackResult?.search_validity === "valid") {
    fallbackSteps.push({
      level: "expanded",
      filters: {
        ...filters,
        ...expandedFallbackResult.filters,
      },
      reason: "expand_area_preserving_soft_room_constraints",
    });
  }
  if (wideFallbackResult?.search_validity === "valid") {
    const wideBase = {
      ...filters,
      ...wideFallbackResult.filters,
    };
    fallbackSteps.push({
      level: "wide",
      filters: { ...wideBase },
      reason: "expand_area_wide_and_drop_parking",
    });
    fallbackSteps.push({
      level: "location_only",
      filters: omitFilterKeys(wideBase, AREA_FILTER_KEYS),
      reason: "location_and_type_only_no_area_or_room_constraints",
    });
  }

  const dedupedFallbackSteps = uniqueFallbackSteps(fallbackSteps);
  const suggested_filters =
    search_validity === "invalid_filters" && suggestedResult?.search_validity === "valid"
      ? suggestedResult.filters
      : undefined;

  return {
    filters,
    search_validity,
    invalid_fields: Array.from(new Set(invalid_fields)),
    warnings,
    ...(suggested_filters ? { suggested_filters } : {}),
    ...(dedupedFallbackSteps[0]
      ? { fallback_filters: dedupedFallbackSteps[0].filters }
      : {}),
    ...(dedupedFallbackSteps.length > 0
      ? { fallback_filter_ladder: dedupedFallbackSteps }
      : {}),
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
