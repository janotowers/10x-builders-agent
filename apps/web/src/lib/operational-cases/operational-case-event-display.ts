import type { OperationalCaseEvent } from "@agents/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function eventTechnicalKind(event: OperationalCaseEvent): string {
  const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : {};
  const kind = typeof payload.kind === "string" ? payload.kind.trim() : "";
  return kind || event.event_type;
}

function compactState(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const step =
    typeof payload.current_step === "string" ? payload.current_step.trim() : "";
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  if (step && status) return `${status} / ${step}`;
  if (step) return step;
  if (status) return status;
  return null;
}

function withTechnicalKind(
  label: string,
  technicalKind: string,
  includeTechnicalKind: boolean
): string {
  if (!includeTechnicalKind) return label;
  return `${label} (${technicalKind})`;
}

export function formatOperationalCaseEventSummary(
  event: OperationalCaseEvent,
  opts?: { includeTechnicalKind?: boolean }
): string {
  const includeTechnicalKind = opts?.includeTechnicalKind === true;
  const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : {};
  const technicalKind = eventTechnicalKind(event);

  if (technicalKind === "case_created") return "Caso conversacional creado";
  if (technicalKind === "intake_fields_requested") return "Campos de intake solicitados";
  if (technicalKind === "controlled_test_e2e_started") return "Transición con agente iniciada";
  if (technicalKind === "comparables_analysis_completed")
    return "Análisis de comparables completado";
  if (technicalKind === "price_proposal_prepared") return "Propuesta de precio preparada";
  if (technicalKind === "price_approval_requested") return "Aprobación de precio solicitada";
  if (technicalKind === "price_approved") return "Precio aprobado";
  if (technicalKind === "price_adjusted_and_approved") return "Precio ajustado y aprobado";
  if (technicalKind === "price_rejected") return "Precio rechazado";
  if (technicalKind === "contract_preparation_entered") return "Preparación de contrato iniciada";
  if (technicalKind === "contract_review_requested") return "Revisión de contrato solicitada";
  if (technicalKind === "contract_data_review_requested")
    return "Datos contractuales solicitados al asesor";
  if (technicalKind === "contract_data_review_response")
    return "Datos contractuales capturados por el asesor";
  if (technicalKind === "contract_data_captured")
    return withTechnicalKind(
      "Datos contractuales listos para generar contrato",
      technicalKind,
      includeTechnicalKind
    );
  if (technicalKind === "contract_generation_unverified")
    return "Contrato no verificado: falta render real";
  if (technicalKind === "owner_characteristics_merged")
    return withTechnicalKind(
      "Datos del propietario integrados al caso",
      technicalKind,
      includeTechnicalKind
    );
  if (
    technicalKind === "document_surfaces_consolidated_to_property_data" ||
    technicalKind === "document_address_consolidated_to_property_data"
  ) {
    return withTechnicalKind(
      "Datos documentales consolidados en la ficha de propiedad",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "documents_batch_completed") {
    const count = typeof payload.document_count === "number" ? payload.document_count : null;
    return count != null
      ? `Documentos recibidos: lote completo (${count})`
      : "Documentos recibidos: lote completo";
  }
  if (technicalKind === "document_registered") {
    const originalName =
      typeof payload.original_name === "string" && payload.original_name.trim()
        ? payload.original_name.trim()
        : null;
    return originalName ? `Documento recibido: ${originalName}` : "Documento recibido";
  }

  if (event.event_type === "external_response") return "Respuesta del contacto externo";

  if (event.event_type === "reminder_sent") {
    const purpose = typeof payload.purpose === "string" ? payload.purpose.trim() : "";
    const channel = typeof payload.channel === "string" ? payload.channel.trim() : "";
    const descriptor = [
      purpose ? `propósito ${purpose}` : "",
      channel ? `canal ${channel}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return withTechnicalKind(
      descriptor ? `Recordatorio enviado (${descriptor})` : "Recordatorio enviado",
      technicalKind,
      includeTechnicalKind
    );
  }

  if (event.event_type === "state_changed") {
    const from = compactState(payload.from);
    const to = compactState(payload.to);
    const result = typeof payload.result === "string" ? payload.result.trim() : "";
    if (from && to) {
      return withTechnicalKind(
        `Cambio de estado: ${from} → ${to}`,
        technicalKind,
        includeTechnicalKind
      );
    }
    if (result) {
      return withTechnicalKind(
        `Cambio de estado del caso (${result})`,
        technicalKind,
        includeTechnicalKind
      );
    }
    return withTechnicalKind(
      "Cambio de estado del caso",
      technicalKind,
      includeTechnicalKind
    );
  }

  if (event.event_type === "human_decision") {
    return withTechnicalKind(
      "Decisión / acción manual",
      technicalKind,
      includeTechnicalKind
    );
  }

  return includeTechnicalKind ? `${technicalKind} · ${event.actor}` : technicalKind;
}
