import type { OperationalCaseIntakeField } from "@agents/types";

/** Valores realistas para property_optioning (alineados al dry-run Ungga exitoso). */
export const PROPERTY_OPTIONING_TEST_CONTEXT: Record<string, unknown> = {
  property_title: "Opcionar propiedad - prueba",
  owner_name: "Contacto de prueba",
  property_zone: "Colomos Providencia, Guadalajara, Jalisco",
  operation_type: ["rent"],
  property_type: ["Departamento"],
  target_price: 21000,
  min_price: 18000,
  max_price: 24000,
  area_m2: 80,
  bedrooms: 3,
  bathrooms: 2,
  parking_spaces: 1,
  telegram_chat_id: "",
  // Campos usados por recipes (Ungga / comparables) aunque no estén en el intake UI:
  condition: "Bueno",
  age_range: "1-5 años",
  current_status: "Habitable",
  address:
    "Colomos Providencia, Guadalajara, Jalisco, México",
  currency: "MXN",
};

function optionValue(option: unknown) {
  if (typeof option === "string") return option;
  if (option && typeof option === "object" && "value" in option) {
    return typeof option.value === "string" ? option.value : "";
  }
  return "";
}

function numberFromPlaceholder(field: OperationalCaseIntakeField): string | null {
  const match = field.placeholder?.match(/[\d.]+/);
  return match?.[0] ?? null;
}

function sampleValueForField(
  field: OperationalCaseIntakeField,
  caseTypeSlug: string
): unknown {
  const preset =
    caseTypeSlug === "property_optioning"
      ? PROPERTY_OPTIONING_TEST_CONTEXT[field.name]
      : undefined;
  if (preset !== undefined) {
    if (field.type === "number") {
      if (preset === "" || preset == null) return "";
      return typeof preset === "number" ? preset : String(preset);
    }
    if (field.type === "multi_select") {
      return Array.isArray(preset) ? preset : [String(preset)];
    }
    return preset;
  }

  if (field.type === "number") {
    if (field.name.includes("price")) return "20000";
    if (field.name.includes("area") || field.name.includes("m2")) return "80";
    if (field.name.includes("bedroom")) return "3";
    if (field.name.includes("bath")) return "2";
    if (field.name.includes("parking")) return "1";
    if (field.name.includes("telegram")) return "";
    return numberFromPlaceholder(field) ?? "100";
  }
  if (field.type === "select") {
    return optionValue(field.options?.[0]) || "prueba";
  }
  if (field.type === "multi_select") {
    const first = optionValue(field.options?.[0]);
    return first ? [first] : [];
  }
  if (field.name.includes("owner")) return "Contacto de prueba";
  if (field.name.includes("lead")) return "Lead de prueba";
  if (field.name.includes("zone") || field.name.includes("zona")) {
    return "Colonia de prueba, CDMX";
  }
  if (field.name.includes("property") || field.name.includes("title")) {
    return "Propiedad de prueba";
  }
  return field.placeholder?.replace(/^Ej\.\s*/i, "") || `${field.label} de prueba`;
}

export function buildTestContext(
  fields: OperationalCaseIntakeField[],
  caseTypeSlug: string
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const field of fields) {
    context[field.name] = sampleValueForField(field, caseTypeSlug);
  }
  if (caseTypeSlug === "property_optioning") {
    for (const [key, value] of Object.entries(PROPERTY_OPTIONING_TEST_CONTEXT)) {
      if (context[key] === undefined || context[key] === "") {
        context[key] = value;
      }
    }
  }
  return context;
}
