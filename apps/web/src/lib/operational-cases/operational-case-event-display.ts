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

function truncateDetail(value: string, max = 72): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatAddressDetail(adopted: Record<string, unknown>): string | null {
  const street = typeof adopted.street === "string" ? adopted.street.trim() : "";
  const exterior =
    typeof adopted.exterior_number === "string" ? adopted.exterior_number.trim() : "";
  const neighborhood =
    typeof adopted.neighborhood === "string" ? adopted.neighborhood.trim() : "";
  const municipality =
    typeof adopted.municipality === "string" ? adopted.municipality.trim() : "";
  const parts = [
    [street, exterior].filter(Boolean).join(" "),
    neighborhood,
    municipality,
  ].filter(Boolean);
  return parts.length > 0 ? truncateDetail(parts.join(", ")) : null;
}

function formatConsolidatedSurfacesDetail(adopted: unknown): string | null {
  if (!isRecord(adopted)) return null;
  const parts: string[] = [];
  if (typeof adopted.area_total_m2 === "number" && Number.isFinite(adopted.area_total_m2)) {
    parts.push(`terreno ${adopted.area_total_m2} m²`);
  }
  if (
    typeof adopted.area_construida_m2 === "number" &&
    Number.isFinite(adopted.area_construida_m2)
  ) {
    parts.push(`construcción ${adopted.area_construida_m2} m²`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

const ADDRESS_CONFLICT_FIELD_LABELS: Record<string, string> = {
  street: "calle",
  exterior_number: "número exterior",
  neighborhood: "colonia",
  municipality: "municipio",
  state: "estado",
  postal_code: "código postal",
};

function formatAddressConflictDetail(conflicts: unknown): string | null {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
  const parts: string[] = [];
  for (const entry of conflicts) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === "string" ? entry.field.trim() : "";
    const existing = typeof entry.existing === "string" ? entry.existing.trim() : "";
    const incoming = typeof entry.incoming === "string" ? entry.incoming.trim() : "";
    if (!existing || !incoming) continue;
    const label = ADDRESS_CONFLICT_FIELD_LABELS[field] ?? field ?? "campo";
    parts.push(`${label}: «${existing}» vs «${incoming}»`);
  }
  if (parts.length === 0) return null;
  return truncateDetail(parts.join("; "), 100);
}

function formatConsolidatedLegalIdentityDetail(adopted: unknown): string | null {
  if (!isRecord(adopted)) return null;
  const owner =
    typeof adopted.owner_name === "string" && adopted.owner_name.trim()
      ? adopted.owner_name.trim()
      : Array.isArray(adopted.owner_names) &&
          typeof adopted.owner_names[0] === "string" &&
          adopted.owner_names[0].trim()
        ? adopted.owner_names[0].trim()
        : null;
  const legalAddress =
    typeof adopted.legal_address === "string" && adopted.legal_address.trim()
      ? adopted.legal_address.trim()
      : Array.isArray(adopted.legal_addresses) &&
          typeof adopted.legal_addresses[0] === "string" &&
          adopted.legal_addresses[0].trim()
        ? adopted.legal_addresses[0].trim()
        : null;
  if (owner && legalAddress) {
    return truncateDetail(`${owner} · ${legalAddress}`);
  }
  if (owner) return truncateDetail(owner);
  if (legalAddress) return truncateDetail(legalAddress);
  return null;
}

function documentFlowReminderLabel(purpose: string): string | null {
  switch (purpose) {
    case "documents_checklist_post_intake":
      return "Documentos solicitados al asesor (checklist post-intake)";
    case "internal_upload_instructions":
      return "Instrucciones de carga interna enviadas";
    case "external_documents_routed":
      return "Solicitud de documentos enrutada al contacto externo";
    case "initial_request":
      return "Solicitud inicial de documentos enviada";
    default:
      return null;
  }
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
  if (technicalKind === "comparables_search_expansion_decision_response") {
    const decision =
      typeof payload.decision === "string" ? payload.decision : "";
    const decisionLabel =
      decision === "use_avaclick_primary"
        ? "usar Avaclick como base"
        : decision === "use_current_comparables"
          ? "avanzar con comparables actuales"
          : decision === "expand_search"
            ? "ampliar búsqueda"
            : null;
    return withTechnicalKind(
      decisionLabel
        ? `Decisión de comparables: ${decisionLabel}`
        : "Decisión de comparables registrada",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "price_proposal_prepared") return "Propuesta de precio preparada";
  if (technicalKind === "price_approval_requested") return "Aprobación de precio solicitada";
  if (technicalKind === "price_approved") return "Precio aprobado";
  if (technicalKind === "price_adjusted_and_approved") return "Precio ajustado y aprobado";
  if (technicalKind === "price_rejected") return "Precio rechazado";
  if (technicalKind === "contract_preparation_entered") return "Preparación de contrato iniciada";
  if (technicalKind === "contract_review_requested") return "Revisión de contrato solicitada";
  if (technicalKind === "contract_email_send_attempted")
    return withTechnicalKind(
      "Enviando contrato por email al propietario",
      technicalKind,
      includeTechnicalKind
    );
  if (technicalKind === "contract_email_send_failed") {
    const reason =
      typeof payload.error_reason === "string" && payload.error_reason.trim()
        ? payload.error_reason.trim()
        : typeof payload.status === "string" && payload.status.trim()
          ? payload.status.trim()
          : null;
    return withTechnicalKind(
      reason
        ? `Falló el envío del contrato por email (${truncateDetail(reason)})`
        : "Falló el envío del contrato por email",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "contract_approved_for_email_send")
    return withTechnicalKind(
      "Contrato aprobado para envío por email",
      technicalKind,
      includeTechnicalKind
    );
  if (technicalKind === "contract_sent_to_owner_email")
    return withTechnicalKind(
      "Contrato enviado por email al propietario",
      technicalKind,
      includeTechnicalKind
    );
  if (technicalKind === "contract_revised_uploaded_and_sent")
    return withTechnicalKind(
      "Contrato corregido recibido y enviado al propietario",
      technicalKind,
      includeTechnicalKind
    );
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
  if (technicalKind === "document_surfaces_consolidated_to_property_data") {
    const detail = formatConsolidatedSurfacesDetail(payload.adopted);
    return withTechnicalKind(
      detail
        ? `Superficies consolidadas en ficha: ${detail}`
        : "Superficies consolidadas en la ficha de propiedad",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "document_address_consolidated_to_property_data") {
    const detail = isRecord(payload.adopted) ? formatAddressDetail(payload.adopted) : null;
    return withTechnicalKind(
      detail
        ? `Dirección consolidada en ficha: ${detail}`
        : "Dirección consolidada en la ficha de propiedad",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "document_address_conflict_detected") {
    const detail = formatAddressConflictDetail(payload.conflicts);
    return withTechnicalKind(
      detail
        ? `Conflicto de dirección detectado: ${detail}`
        : "Conflicto de dirección detectado entre fuentes",
      technicalKind,
      includeTechnicalKind
    );
  }
  if (technicalKind === "document_legal_identity_consolidated_to_property_data") {
    const detail = formatConsolidatedLegalIdentityDetail(payload.adopted);
    return withTechnicalKind(
      detail
        ? `Titularidad consolidada en ficha: ${detail}`
        : "Titularidad consolidada en la ficha de propiedad",
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
  if (technicalKind === "photo_registered") {
    const originalName =
      typeof payload.original_name === "string" && payload.original_name.trim()
        ? payload.original_name.trim()
        : null;
    return originalName ? `Foto recibida: ${originalName}` : "Foto recibida";
  }

  if (event.event_type === "external_response") return "Respuesta del contacto externo";

  if (event.event_type === "reminder_sent") {
    const purpose = typeof payload.purpose === "string" ? payload.purpose.trim() : "";
    const channel = typeof payload.channel === "string" ? payload.channel.trim() : "";
    const friendlyPurpose = documentFlowReminderLabel(purpose);
    if (friendlyPurpose) {
      return withTechnicalKind(
        channel ? `${friendlyPurpose} · canal ${channel}` : friendlyPurpose,
        technicalKind,
        includeTechnicalKind
      );
    }
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
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : {};
    if (payload.kind === "step_branch_selected") {
      const branch =
        typeof payload.branch_value === "string" ? payload.branch_value.trim() : "";
      const branchLabel =
        branch === "internal_user"
          ? "equipo interno"
          : branch === "external_contact"
            ? "contacto externo"
            : branch || "rama";
      const decidedBy =
        typeof payload.decided_by === "string" ? payload.decided_by.trim() : "";
      const decidedHint =
        decidedBy === "inferred"
          ? " (inferido)"
          : decidedBy === "user"
            ? ""
            : decidedBy
              ? ` (${decidedBy})`
              : "";
      return withTechnicalKind(
        `Rama documental: ${branchLabel}${decidedHint}`,
        technicalKind,
        includeTechnicalKind
      );
    }
    return withTechnicalKind(
      "Decisión / acción manual",
      technicalKind,
      includeTechnicalKind
    );
  }

  return includeTechnicalKind ? `${technicalKind} · ${event.actor}` : technicalKind;
}
