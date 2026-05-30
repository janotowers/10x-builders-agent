/** Validación de pricing_proposal (N3/N4). Patrón: HITL precio antes de contrato. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validatePricingProposal(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["pricing_proposal debe ser un objeto."];
  }
  const salida = value.salida;
  const ideal = value.ideal;
  const minimo = value.minimo;
  if (!positiveNumber(salida)) errors.push("pricing_proposal.salida debe ser mayor a 0.");
  if (!positiveNumber(ideal)) errors.push("pricing_proposal.ideal debe ser mayor a 0.");
  if (!positiveNumber(minimo)) errors.push("pricing_proposal.minimo debe ser mayor a 0.");
  const salidaNumber = positiveNumber(salida) ? salida : null;
  const idealNumber = positiveNumber(ideal) ? ideal : null;
  const minimoNumber = positiveNumber(minimo) ? minimo : null;
  if (salidaNumber != null && idealNumber != null && salidaNumber < idealNumber) {
    errors.push("pricing_proposal.salida debe ser mayor o igual a ideal.");
  }
  if (idealNumber != null && minimoNumber != null && idealNumber < minimoNumber) {
    errors.push("pricing_proposal.ideal debe ser mayor o igual a minimo.");
  }
  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
    errors.push("pricing_proposal.rationale no debe estar vacio.");
  }
  if (!Array.isArray(value.comparables_used) || value.comparables_used.length === 0) {
    errors.push("pricing_proposal.comparables_used debe incluir al menos un comparable.");
  }
  return errors;
}

export function validatePriceProposalStepOutcome(params: {
  pricing_proposal: unknown;
  current_step: string;
  status: string;
  price_proposed_event: boolean;
  notify_user_executed: boolean;
}) {
  const errors: string[] = [
    ...validatePricingProposal(params.pricing_proposal),
  ];
  if (isRecord(params.pricing_proposal)) {
    const approval = params.pricing_proposal.approval_status;
    if (approval !== "pending") {
      errors.push(
        "pricing_proposal.approval_status debe ser pending hasta aprobación humana."
      );
    }
  }
  if (params.current_step !== "price_proposal_pending") {
    errors.push("current_step debe permanecer en price_proposal_pending.");
  }
  if (params.status !== "waiting_internal") {
    errors.push("status debe ser waiting_internal mientras espera al asesor.");
  }
  if (!params.price_proposed_event) {
    errors.push("Debe existir evento human_decision con kind=price_proposed.");
  }
  if (!params.notify_user_executed) {
    errors.push("notify_user debe ejecutarse para solicitar aprobación HITL.");
  }
  return { ok: errors.length === 0, errors };
}

export function validatePriceApprovedStepOutcome(params: {
  pricing_proposal: unknown;
  current_step: string;
  status: string;
  price_approved_event: boolean;
}) {
  const errors: string[] = [...validatePricingProposal(params.pricing_proposal)];
  if (isRecord(params.pricing_proposal)) {
    if (params.pricing_proposal.approval_status !== "approved") {
      errors.push("pricing_proposal.approval_status debe ser approved.");
    }
  }
  if (params.current_step !== "contract_pending") {
    errors.push("current_step debe avanzar a contract_pending tras aprobar.");
  }
  if (params.status !== "paused") {
    errors.push(
      "status debe ser paused en caso de prueba de settings tras aprobar (detiene antes de contrato automático)."
    );
  }
  if (!params.price_approved_event) {
    errors.push("Debe existir evento human_decision con kind=price_approved.");
  }
  return { ok: errors.length === 0, errors };
}

export function validatePriceAdjustedAndApprovedStepOutcome(params: {
  pricing_proposal: unknown;
  current_step: string;
  status: string;
  expected: { salida: number; ideal: number; minimo: number };
  price_adjusted_event: boolean;
}) {
  const errors: string[] = [...validatePricingProposal(params.pricing_proposal)];
  if (isRecord(params.pricing_proposal)) {
    if (params.pricing_proposal.approval_status !== "approved") {
      errors.push("pricing_proposal.approval_status debe ser approved tras ajustar.");
    }
    for (const field of ["salida", "ideal", "minimo"] as const) {
      const expected = params.expected[field];
      if (params.pricing_proposal[field] !== expected) {
        errors.push(
          `pricing_proposal.${field} debe ser ${expected} tras el ajuste del asesor.`
        );
      }
    }
  }
  if (params.current_step !== "contract_pending") {
    errors.push("current_step debe avanzar a contract_pending tras ajustar y aprobar.");
  }
  if (params.status !== "paused") {
    errors.push("status debe ser paused en caso de prueba de settings tras ajustar.");
  }
  if (!params.price_adjusted_event) {
    errors.push(
      "Debe existir evento human_decision con kind=price_adjusted_and_approved."
    );
  }
  return { ok: errors.length === 0, errors };
}
