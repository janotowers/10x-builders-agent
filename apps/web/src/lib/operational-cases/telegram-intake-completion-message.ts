import type { OperationalCase } from "@agents/types";

export function isIntakeInProgress(opCase: OperationalCase | null | undefined) {
  if (!opCase) return false;
  return (
    opCase.current_step === "intake" ||
    opCase.context_jsonb?.intake_status !== "complete"
  );
}

export function intakeJustCompleted(
  before: OperationalCase | null | undefined,
  after: OperationalCase | null | undefined
) {
  return Boolean(before && after && isIntakeInProgress(before) && !isIntakeInProgress(after));
}

/**
 * Mensaje corto al cerrar intake por Telegram. No menciona documentos: el paso
 * operativo siguiente (automático o manual) se encarga de solicitarlos.
 */
export function buildTelegramIntakeCompletionMessage(opCase: OperationalCase) {
  const context = opCase.context_jsonb ?? {};
  const field = (key: string) => {
    const value = context[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const title = field("property_title");
  const zone = field("property_zone");
  const operation = field("operation_type");
  const propertyType = field("property_type");

  const details = [
    title ? `- Título / propiedad: ${title}` : null,
    zone ? `- Zona / colonia: ${zone}` : null,
    operation ? `- Operación: ${operation}` : null,
    propertyType ? `- Tipo de propiedad: ${propertyType}` : null,
  ].filter(Boolean);

  if (title) {
    return [
      `«${title}» quedó registrada en el caso con estos datos:`,
      "",
      ...details,
    ].join("\n");
  }
  return "La propiedad quedó registrada en el caso.";
}
