/**
 * Sync del formulario del caso de prueba hacia `property_data` canónico.
 *
 * Objetivo: que el laboratorio tenga UNA sola verdad de la propiedad
 * (`property_data`), evitando que la raíz del contexto (lo que el usuario escribe
 * en el formulario) y `property_data` (semilla / corridas previas) diverjan.
 *
 * Precedencia (misma que producción, reutiliza `surfaceSourceScore`):
 *   predial(4) > boleta(3) > escritura(2) > documento(1) > lab_form/semilla(0)
 * El formulario se registra como fuente `lab_form` (score 0) y solo adopta un
 * valor cuando el campo está vacío o su fuente actual también es score 0
 * (vacío / semilla / edición previa del formulario). NUNCA sobrescribe un dato
 * proveniente de documentos oficiales.
 */

import { surfaceSourceScore } from "./property-optioning-post-agent-invariants";

export const LAB_FORM_SOURCE = "lab_form";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstSelectedString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) return item.trim();
      if (isRecord(item) && typeof item.value === "string" && item.value.trim()) {
        return item.value.trim();
      }
    }
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOperation(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rent" || normalized.includes("renta")) return "rent";
  if (normalized === "sale" || normalized.includes("venta")) return "sale";
  return normalized || null;
}

function isDocumentSource(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("predial") ||
    normalized.includes("boleta") ||
    normalized.includes("escritura") ||
    normalized.includes("document")
  );
}

type FieldMapping = {
  /** Campo destino en property_data. */
  target: string;
  /** Valor entrante derivado del formulario (ya normalizado). */
  incoming: unknown;
};

export type LabFormSyncResult = {
  propertyData: Record<string, unknown>;
  /** Campos de property_data efectivamente adoptados desde el formulario. */
  adopted: string[];
  /** Campos que el formulario NO pudo sobrescribir por venir de documentos. */
  skippedByDocumentSource: string[];
  changed: boolean;
};

/**
 * Deriva los valores del formulario relevantes para la identidad de la propiedad.
 * Incluye shim legacy: `area_m2` (campo viejo, alias de construcción por catálogo)
 * alimenta `area_construida_m2` cuando el campo nuevo aún no existe.
 */
function deriveFormFields(formContext: Record<string, unknown>): FieldMapping[] {
  const propertyType = firstSelectedString(formContext.property_type);
  const operation = normalizeOperation(firstSelectedString(formContext.operation_type));
  const bedrooms = numberOrNull(formContext.bedrooms);
  const bathrooms = numberOrNull(formContext.bathrooms);
  const parking = numberOrNull(formContext.parking_spaces);
  const areaTotal = numberOrNull(formContext.area_total_m2);
  const areaBuilt =
    numberOrNull(formContext.area_construida_m2) ??
    numberOrNull(formContext.area_built_m2) ??
    numberOrNull(formContext.area_m2); // shim legacy: area_m2 = construcción

  return [
    { target: "property_type", incoming: propertyType },
    { target: "operation", incoming: operation },
    { target: "bedrooms", incoming: bedrooms },
    { target: "bathrooms", incoming: bathrooms },
    { target: "parking_spots", incoming: parking },
    { target: "area_total_m2", incoming: areaTotal },
    { target: "area_construida_m2", incoming: areaBuilt },
  ];
}

/**
 * Aplica los valores del formulario sobre `property_data` respetando la
 * precedencia por fuente. Devuelve una copia nueva de property_data.
 */
export function syncLabFormIntoPropertyData(input: {
  formContext: Record<string, unknown>;
  propertyData: Record<string, unknown> | null | undefined;
}): LabFormSyncResult {
  const base = isRecord(input.propertyData) ? { ...input.propertyData } : {};
  const adopted: string[] = [];
  const skippedByDocumentSource: string[] = [];

  for (const { target, incoming } of deriveFormFields(input.formContext)) {
    if (incoming == null) continue;
    const sourceKey = `${target}_source`;
    const existing = base[target];
    const existingScore = surfaceSourceScore(base[sourceKey]);

    if (existing != null && existingScore > 0) {
      // Valor de documento oficial: el formulario no lo pisa.
      if (existing !== incoming) skippedByDocumentSource.push(target);
      continue;
    }

    if (existing === incoming && base[sourceKey] === LAB_FORM_SOURCE) continue;

    base[target] = incoming;
    base[sourceKey] = LAB_FORM_SOURCE;
    adopted.push(target);
  }

  // Sincroniza dirección/zona del formulario hacia property_data.address
  // preservando ciudad/estado/país existentes y respetando precedencia documental.
  const zone = cleanText(input.formContext.property_zone);
  const street = cleanText(input.formContext.street);
  const exteriorNumber = cleanText(input.formContext.exterior_number);
  const postalCode = cleanText(input.formContext.postal_code);
  const hasAddressInput = Boolean(zone || street || exteriorNumber || postalCode);
  if (hasAddressInput) {
    const nextAddress = isRecord(base.address) ? { ...base.address } : {};
    const existingAddressSource =
      cleanText(nextAddress.source) ?? cleanText(base.address_source);
    const addressFromDocument = isDocumentSource(existingAddressSource);

    const syncAddressField = (
      key: "neighborhood" | "street" | "exterior_number" | "postal_code",
      incoming: string | null
    ) => {
      if (!incoming) return;
      const existing = cleanText(nextAddress[key]);
      if (addressFromDocument && existing && existing !== incoming) {
        skippedByDocumentSource.push(`address.${key}`);
        return;
      }
      if (existing === incoming) return;
      nextAddress[key] = incoming;
      adopted.push(`address.${key}`);
    };

    syncAddressField("neighborhood", zone);
    syncAddressField("street", street);
    syncAddressField("exterior_number", exteriorNumber);
    syncAddressField("postal_code", postalCode);

    if (
      adopted.some((field) =>
        ["address.neighborhood", "address.street", "address.exterior_number", "address.postal_code"].includes(
          field
        )
      )
    ) {
      if (!addressFromDocument) {
        nextAddress.source = LAB_FORM_SOURCE;
        base.address_source = LAB_FORM_SOURCE;
      }
      base.address = nextAddress;
    }

    if (zone) {
      const existingSearchZone = cleanText(base.search_zone);
      const existingSearchZoneSource = cleanText(base.search_zone_source);
      const searchZoneFromDocument = isDocumentSource(existingSearchZoneSource);
      if (searchZoneFromDocument && existingSearchZone && existingSearchZone !== zone) {
        skippedByDocumentSource.push("search_zone");
      } else if (existingSearchZone !== zone) {
        base.search_zone = zone;
        base.search_zone_source = LAB_FORM_SOURCE;
        adopted.push("search_zone");
      }
    }
  }

  return {
    propertyData: base,
    adopted,
    skippedByDocumentSource,
    changed: adopted.length > 0,
  };
}
