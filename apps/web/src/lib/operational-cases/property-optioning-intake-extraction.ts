const FIELD_KEYS = [
  "property_title",
  "property_zone",
  "operation_type",
  "property_type",
] as const;

type IntakeFieldKey = (typeof FIELD_KEYS)[number];

function normalizeForIntent(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdownBold(value: string) {
  return value.replace(/\*\*/g, "").trim();
}

function inferPropertyTitleFromFreeText(text: string) {
  const prefix = text
    .split(/\b(?:la\s+)?zona(?:\s*\/\s*colonia)?\b/i)[0]
    ?.replace(
      /^(?:es(?:\s+una|\s+un)?|ser[ií]a(?:\s+una|\s+un)?|se\s+trata\s+de(?:\s+una|\s+un)?|quiero\s+opcionar(?:\s+una)?\s+propiedad)\s*[:,-]?\s*/i,
      ""
    )
    .trim()
    .replace(/[.,;]\s*$/, "");
  if (!prefix || prefix.length < 8 || prefix.length > 140) return null;
  const normalized = normalizeForIntent(prefix);
  const hasPropertySignal =
    /\b(casa|departamento|depa|terreno|propiedad|inmueble)\b/.test(normalized);
  const hasOperationSignal = /\b(venta|renta|en venta|en renta|alquiler)\b/.test(normalized);
  if (!hasPropertySignal || !hasOperationSignal) return null;
  return sentenceCapitalize(prefix);
}

function sentenceCapitalize(value: string) {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

const PROPERTY_TYPE_TOKEN =
  String.raw`casa|departamento|depa|terreno|propiedad|inmueble`;

function looksLikeWeakGenericTitle(value: string) {
  const normalized = normalizeForIntent(value);
  if (!normalized) return true;
  if (/^(es|es una|es un)\s+/.test(normalized)) return true;
  // Bare type ("Casa") is not a usable listing title — it duplicates property_type.
  if (new RegExp(String.raw`^(?:${PROPERTY_TYPE_TOKEN})$`).test(normalized)) {
    return true;
  }
  if (
    new RegExp(
      String.raw`^(?:${PROPERTY_TYPE_TOKEN})\s+(?:en\s+)?(?:venta|renta|alquiler)$`
    ).test(normalized)
  ) {
    return true;
  }
  const hasProperty = new RegExp(String.raw`\b(?:${PROPERTY_TYPE_TOKEN})\b`).test(
    normalized
  );
  const hasOperation = /\b(venta|renta|alquiler)\b/.test(normalized);
  const hasLocation = /\b(zona|colonia|zapopan|guadalajara|jalisco|en\s+[a-záéíóúüñ]{3,})\b/.test(
    normalized
  );
  return hasProperty && hasOperation && !hasLocation;
}

function buildFallbackPropertyTitle(values: Record<string, unknown>) {
  const propertyType = hasMeaningfulString(values.property_type) ? values.property_type.trim() : "";
  const operation = hasMeaningfulString(values.operation_type) ? values.operation_type.trim() : "";
  const zone = hasMeaningfulString(values.property_zone) ? values.property_zone.trim() : "";
  if (!propertyType || !operation || !zone) return null;
  const operationPhrase =
    operation.toLowerCase() === "venta"
      ? "en venta"
      : operation.toLowerCase() === "renta"
        ? "en renta"
        : `para ${operation}`;
  return sentenceCapitalize(`${propertyType} ${operationPhrase} en ${zone}`);
}

function enrichTitleWithZoneIfNeeded(values: Record<string, unknown>) {
  const title = hasMeaningfulString(values.property_title) ? values.property_title.trim() : "";
  const zone = hasMeaningfulString(values.property_zone) ? values.property_zone.trim() : "";
  if (!title || !zone) return title || null;
  if (!looksLikeWeakGenericTitle(title)) return title;
  const normalizedTitle = normalizeForIntent(title);
  // Prefer "Casa en venta en {zona}" over appending zone to a bare type token.
  if (
    new RegExp(
      String.raw`^(?:${PROPERTY_TYPE_TOKEN})(?:\s+(?:en\s+)?(?:venta|renta|alquiler))?$`
    ).test(normalizedTitle)
  ) {
    const fallback = buildFallbackPropertyTitle(values);
    if (fallback) return fallback;
  }
  const normalizedZone = normalizeForIntent(zone);
  if (normalizedZone && normalizedTitle.includes(normalizedZone)) return title;
  return sentenceCapitalize(`${title} en ${zone}`);
}

function hasMeaningfulString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function inferPropertyTypeFromText(text: string) {
  const normalized = normalizeForIntent(text);
  if (/\bterreno\b/.test(normalized)) return "Terreno";
  if (/\bdepartamento\b|\bdepa\b|\bdept[o]?\.?\b/.test(normalized)) {
    return "Departamento";
  }
  if (/\bcasa\b/.test(normalized)) return "Casa";
  return null;
}

export function inferOperationTypeFromText(text: string) {
  const normalized = normalizeForIntent(text);
  if (/\bventa\b|\bvender\b|\ben venta\b/.test(normalized)) return "Venta";
  if (/\brenta\b|\brentar\b|\ben renta\b|\balquiler\b/.test(normalized)) {
    return "Renta";
  }
  return null;
}

/**
 * Un valor plausible de zona/colonia es una frase nominal corta ("Las
 * Fuentes, Zapopan"), no una oración con instrucciones. Protege contra
 * mensajes de corrección mal ruteados cuyo texto después de "zona" era una
 * instrucción completa (visto 2026-07-11: "…entorno/zona con las coordenadas
 * reales del caso (sin lat/lng 0) e incluye puntos de interés…" quedó
 * guardado como property_zone del caso).
 */
export function looksLikePlausibleZoneValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return false;
  const normalized = normalizeForIntent(trimmed);
  if (/^(?:con|sin|para|porque|donde|cuando|como|que)\b/.test(normalized)) {
    return false;
  }
  return !/\b(regenerar?|generar?|usar?|incluye|incluir|actualizar?|corrige|corregir|agregar?|coordenadas?|lat\s*\/?\s*lng|descripcion(?:es)?|puntos de interes)\b/.test(
    normalized
  );
}

export function fieldValueBeforeNextLabel(
  text: string,
  labelPattern: string,
  nextLabelPattern = String.raw`(?:la\s+)?zona(?:\s*\/\s*colonia)?|operaci[oó]n(?:\s+aplicable)?|tipo(?:\s+de\s+propiedad)?|t[ií]tulo(?:\s*\/\s*propiedad)?|propiedad`
) {
  const linkPattern = String.raw`(?:\s*:\s*|\s+(?:ser[ií]a|es|est[aá]\s+en|en)\s*:?\s*)`;
  const pattern = new RegExp(
    String.raw`\b(?:${labelPattern})\b${linkPattern}([\s\S]*?)(?=(?:[,.;]\s*)?\b(?:${nextLabelPattern})\b${linkPattern}|$)`,
    "i"
  );
  const value = text.match(pattern)?.[1]?.trim();
  return value ? value.replace(/[.,;]\s*$/, "").trim() : null;
}

export function extractConservativeIntakePatch(text: string) {
  const patch: Record<string, unknown> = {};
  const cleaned = stripMarkdownBold(text);

  const titledValue = fieldValueBeforeNextLabel(
    cleaned,
    String.raw`t[ií]tulo(?:\s*\/\s*propiedad)?|propiedad`
  );
  if (titledValue) {
    patch.property_title = titledValue;
  } else {
    const inferredTitle = inferPropertyTitleFromFreeText(cleaned);
    if (inferredTitle) patch.property_title = inferredTitle;
  }

  const zone = fieldValueBeforeNextLabel(
    cleaned,
    String.raw`(?:la\s+)?zona(?:\s*\/\s*colonia)?`
  );
  if (zone && looksLikePlausibleZoneValue(zone)) {
    patch.property_zone = zone;
  } else {
    const zoneLoosePatternWithConnector = new RegExp(
      String.raw`\b(?:la\s+)?zona(?:\s*\/\s*colonia)?\b\s*(?::|(?:ser[ií]a|es|est[aá]\s+en|en)\s*:?)\s*([\s\S]*?)(?=(?:[,.;]\s*)?\b(?:operaci[oó]n(?:\s+aplicable)?|tipo(?:\s+de\s+propiedad)?|t[ií]tulo(?:\s*\/\s*propiedad)?|propiedad)\b\s*(?::|(?:ser[ií]a|es|est[aá]\s+en|en)\s*:?)|$)`,
      "i"
    );
    const zoneLoosePatternBare = new RegExp(
      String.raw`\b(?:la\s+)?zona(?:\s*\/\s*colonia)?\b\s+([\s\S]*?)(?=(?:[,.;]\s*)?\b(?:operaci[oó]n(?:\s+aplicable)?|tipo(?:\s+de\s+propiedad)?|t[ií]tulo(?:\s*\/\s*propiedad)?|propiedad)\b|$)`,
      "i"
    );
    const zoneLoose = cleaned
      .match(zoneLoosePatternWithConnector)?.[1]
      ?.trim()
      .replace(/[.,;]\s*$/, "")
      .trim();
    const zoneLooseBare = cleaned
      .match(zoneLoosePatternBare)?.[1]
      ?.trim()
      .replace(/[.,;]\s*$/, "")
      .trim();
    if (zoneLoose && looksLikePlausibleZoneValue(zoneLoose)) {
      patch.property_zone = zoneLoose;
    } else if (zoneLooseBare && looksLikePlausibleZoneValue(zoneLooseBare)) {
      patch.property_zone = zoneLooseBare;
    }
  }

  const operation = fieldValueBeforeNextLabel(
    cleaned,
    String.raw`operaci[oó]n(?:\s+aplicable)?`
  );
  if (operation) {
    patch.operation_type = operation;
  } else {
    const operationType = inferOperationTypeFromText(cleaned);
    if (operationType) patch.operation_type = operationType;
  }

  const propertyTypeValue = fieldValueBeforeNextLabel(
    cleaned,
    String.raw`tipo(?:\s+de\s+propiedad)?`
  );
  if (propertyTypeValue) {
    patch.property_type = propertyTypeValue;
  } else {
    const propertyType = inferPropertyTypeFromText(cleaned);
    if (propertyType) patch.property_type = propertyType;
  }

  return patch;
}

export function normalizeIntakePatchValues(
  patch: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  const title = hasMeaningfulString(patch.property_title)
    ? patch.property_title.trim()
    : "";
  if (title) normalized.property_title = title;

  // Puerta final compartida por todos los callers (parser regex y
  // clasificador LLM): una "zona" que parece instrucción no se persiste.
  const zone = hasMeaningfulString(patch.property_zone) ? patch.property_zone.trim() : "";
  if (zone && looksLikePlausibleZoneValue(zone)) normalized.property_zone = zone;

  const rawOperation = hasMeaningfulString(patch.operation_type)
    ? patch.operation_type.trim()
    : "";
  const operation = inferOperationTypeFromText(rawOperation);
  if (operation) {
    normalized.operation_type = operation;
  } else if (rawOperation) {
    normalized.operation_type = rawOperation;
  }

  const rawType = hasMeaningfulString(patch.property_type) ? patch.property_type.trim() : "";
  const propertyType = inferPropertyTypeFromText(rawType);
  if (propertyType) {
    normalized.property_type = propertyType;
  } else if (rawType) {
    normalized.property_type = rawType;
  }

  return normalized;
}

export function mergeIntakePatches(
  llmPatch: Record<string, unknown> | undefined,
  deterministicPatch: Record<string, unknown> | undefined
) {
  const merged: Record<string, unknown> = {};
  for (const key of FIELD_KEYS.filter((field) => field !== "property_title")) {
    const llmValue = llmPatch?.[key];
    const deterministicValue = deterministicPatch?.[key];
    if (hasMeaningfulString(llmValue)) {
      merged[key] = llmValue.trim();
      continue;
    }
    if (hasMeaningfulString(deterministicValue)) {
      merged[key] = deterministicValue.trim();
    }
  }
  const llmTitle = hasMeaningfulString(llmPatch?.property_title)
    ? llmPatch?.property_title.trim()
    : null;
  const deterministicTitle = hasMeaningfulString(deterministicPatch?.property_title)
    ? deterministicPatch?.property_title.trim()
    : null;
  if (llmTitle && deterministicTitle) {
    merged.property_title =
      looksLikeWeakGenericTitle(llmTitle) && !looksLikeWeakGenericTitle(deterministicTitle)
        ? deterministicTitle
        : llmTitle;
  } else if (llmTitle) {
    merged.property_title = llmTitle;
  } else if (deterministicTitle) {
    merged.property_title = deterministicTitle;
  } else {
    const fallbackTitle = buildFallbackPropertyTitle(merged);
    if (fallbackTitle) merged.property_title = fallbackTitle;
  }
  const enrichedTitle = enrichTitleWithZoneIfNeeded(merged);
  if (enrichedTitle) merged.property_title = enrichedTitle;
  return merged;
}

export type { IntakeFieldKey };
