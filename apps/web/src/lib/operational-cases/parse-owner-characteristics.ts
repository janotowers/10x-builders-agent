export const OWNER_RESPONSE_CRITICAL_FIELDS = [
  "operation",
  "property_type",
  "area_total_m2",
  "bedrooms",
  "bathrooms",
] as const;

export function normalizeOwnerText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const SPANISH_INTEGER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

function numberTokenToNumber(token: string): number | null {
  const normalized = normalizeOwnerText(token).trim();
  if (normalized in SPANISH_INTEGER_WORDS) return SPANISH_INTEGER_WORDS[normalized];
  const parsed = Number(normalized.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberBefore(text: string, nounPattern: string): number | null {
  const token =
    "(\\d+(?:[\\.,]\\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)";
  const match = text.match(new RegExp(`\\b${token}\\s+(?:${nounPattern})\\b`, "i"));
  return match ? numberTokenToNumber(match[1]) : null;
}

export function parseOwnerCharacteristics(text: string): Record<string, unknown> {
  const normalized = normalizeOwnerText(text);
  const parsed: Record<string, unknown> = {};

  if (/\b(venta|vender|vende|es venta)\b/.test(normalized)) {
    parsed.operation = "sale";
  } else if (/\b(renta|rentar|alquiler|es renta)\b/.test(normalized)) {
    parsed.operation = "rent";
  }

  const propertyTypes = [
    "departamento",
    "casa",
    "terreno",
    "local",
    "oficina",
    "bodega",
  ];
  const matchedType = propertyTypes.find((type) =>
    new RegExp(`\\b${type}s?\\b`).test(normalized)
  );
  if (matchedType) parsed.property_type = matchedType;

  const floors = numberBefore(normalized, "pisos?|plantas?|niveles?");
  if (floors != null) parsed.floors = floors;

  const bedrooms = numberBefore(normalized, "recamaras?|habitaciones?|cuartos?");
  if (bedrooms != null) parsed.bedrooms = bedrooms;

  const bathrooms = numberBefore(normalized, "banos?(?:\\s+completos?)?");
  if (bathrooms != null) parsed.bathrooms = bathrooms;

  if (
    /\b(?:sin|ningun(?:o|a)?|no\s+(?:tiene|hay)|cero|0)\s+medios?\s+banos?\b/.test(
      normalized
    ) ||
    /\b(?:sin|ningun(?:o|a)?|no\s+(?:tiene|hay)|cero|0)\s+medio\s+bano\b/.test(
      normalized
    ) ||
    /\bno\s+medio\s+bano(?:s)?\b/.test(normalized)
  ) {
    parsed.half_bathrooms = 0;
  } else {
    const halfBathrooms = numberBefore(normalized, "medios?\\s+banos?");
    if (halfBathrooms != null) parsed.half_bathrooms = halfBathrooms;
  }

  if (/\bcocina\s+integral\b/.test(normalized)) {
    parsed.integral_kitchen = !/\b(?:sin|no\s+(?:tiene|hay|cuenta\s+con))\s+cocina\s+integral\b/.test(
      normalized
    );
  }

  let parkingSpots = numberBefore(
    normalized,
    "cajon(?:es)?(?:\\s+de\\s+estacionamiento)?|estacionamientos?|cocheras?"
  );
  if (parkingSpots == null) {
    const parkingMatch = normalized.match(
      /\b(?:y\s+)?(\d+|un|una|uno|dos|tres)\s+cajon(?:es)?\s+de\s+estacionamiento\b/
    );
    if (parkingMatch) parkingSpots = numberTokenToNumber(parkingMatch[1]);
  }
  if (parkingSpots != null) parsed.parking_spots = parkingSpots;

  const areaTotal = numberBefore(normalized, "m2|m²|metros(?:\\s+cuadrados)?");
  if (areaTotal != null) parsed.area_total_m2 = areaTotal;

  if (/\b(coto|condominio|fraccionamiento privado|privada)\b/.test(normalized)) {
    parsed.land_context = "coto/condominio";
  } else if (/\bparque industrial\b/.test(normalized)) {
    parsed.land_context = "parque industrial";
  } else if (/\bindependiente\b/.test(normalized)) {
    parsed.land_context = "independiente";
  }

  return parsed;
}

export function missingOwnerResponseCriticalFields(
  propertyData: Record<string, unknown>
) {
  return OWNER_RESPONSE_CRITICAL_FIELDS.filter((field) => {
    const value = propertyData[field];
    return value == null || value === "";
  });
}

function propertyTypeLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Keep intake fields aligned with canonical property_data after owner merge. */
export function syncIntakeFieldsFromPropertyData(
  context: Record<string, unknown>,
  propertyData: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...context,
    property_data: propertyData,
  };
  if (propertyData.operation === "sale") {
    next.operation_type = ["sale"];
  } else if (propertyData.operation === "rent") {
    next.operation_type = ["rent"];
  }
  if (typeof propertyData.property_type === "string") {
    next.property_type = [propertyTypeLabel(propertyData.property_type)];
  }
  if (typeof propertyData.bedrooms === "number") {
    next.bedrooms = propertyData.bedrooms;
  }
  if (typeof propertyData.bathrooms === "number") {
    next.bathrooms = propertyData.bathrooms;
  }
  if (typeof propertyData.parking_spots === "number") {
    next.parking_spaces = propertyData.parking_spots;
  }
  return next;
}

export function buildPropertyDataReviewMessage(params: {
  propertyTitle: string;
  propertyData: Record<string, unknown>;
}) {
  const { propertyTitle, propertyData } = params;
  return [
    `Se ha recibido la respuesta del dueño con los detalles de ${propertyTitle}.`,
    "Se requiere revisión interna de los datos extraídos antes de comparables.",
    "",
    `Operación: ${String(propertyData.operation ?? "pendiente")}`,
    `Tipo: ${String(propertyData.property_type ?? "pendiente")}`,
    `Recámaras: ${String(propertyData.bedrooms ?? "pendiente")}`,
    `Baños: ${String(propertyData.bathrooms ?? "pendiente")}`,
    `m² totales: ${String(propertyData.area_total_m2 ?? "pendiente")}`,
    typeof propertyData.parking_spots === "number"
      ? `Estacionamientos: ${propertyData.parking_spots}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}
