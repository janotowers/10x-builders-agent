import type { OperationalCaseIntakeField } from "@agents/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function draftScalar(value: unknown): string | string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "")))
      .filter(Boolean);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

/**
 * Hidrata el borrador del formulario de prueba desde context_jsonb (+ property_data).
 * Cubre el gap entre valores en raíz, legacy `area_m2` y la semilla en property_data.
 */
export function hydratePropertyOptioningTestContextDraft(
  fields: OperationalCaseIntakeField[],
  context: Record<string, unknown> | null | undefined
): Record<string, string | string[]> {
  const ctx = context ?? {};
  const propertyData = isRecord(ctx.property_data) ? ctx.property_data : {};
  const draft: Record<string, string | string[]> = {};

  for (const field of fields) {
    draft[field.name] = draftScalar(ctx[field.name]);
  }

  if (fields.some((field) => field.name === "area_construida_m2")) {
    const current = draft.area_construida_m2;
    if (current === "" || current == null) {
      draft.area_construida_m2 = draftScalar(
        ctx.area_construida_m2 ??
          ctx.area_m2 ??
          propertyData.area_construida_m2 ??
          propertyData.area_built_m2
      );
    }
  }

  if (fields.some((field) => field.name === "area_total_m2")) {
    const current = draft.area_total_m2;
    if (current === "" || current == null) {
      draft.area_total_m2 = draftScalar(
        ctx.area_total_m2 ?? propertyData.area_total_m2
      );
    }
  }

  return draft;
}

/** Par consecutivo de superficies en el intake (total + construida). */
export function isPropertyOptioningAreaFieldPair(
  fields: OperationalCaseIntakeField[],
  index: number
): boolean {
  return (
    fields[index]?.name === "area_total_m2" &&
    fields[index + 1]?.name === "area_construida_m2"
  );
}
