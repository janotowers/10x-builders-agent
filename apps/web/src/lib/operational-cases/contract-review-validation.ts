/** Validación de outcomes N4 para contract_pending (borrador y HITL). */

import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  generatedDocumentHasStoredOutput,
} from "./generated-case-document";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Salida A: borrador real generado y en revisión interna. */
export function validateContractDraftReadyStepOutcome(params: {
  current_step: string;
  status: string;
  contract_drafted_event: boolean;
  notify_user_executed: boolean;
  generate_document_rendered: boolean;
  contract_draft_has_output_path: boolean;
}) {
  const errors: string[] = [];
  if (params.current_step !== "contract_pending") {
    errors.push("current_step debe permanecer en contract_pending.");
  }
  if (!params.generate_document_rendered) {
    errors.push(
      "generate_document_from_template debe ejecutarse con status=rendered (borrador real)."
    );
  }
  if (!params.contract_draft_has_output_path) {
    errors.push(
      "context_jsonb.contract_draft debe incluir output_path del borrador generado."
    );
  }
  if (!params.notify_user_executed) {
    errors.push("notify_user debe ejecutarse (kind=contract_review con enlace al borrador).");
  }
  if (params.status !== "waiting_internal") {
    errors.push(
      `status debe ser waiting_internal tras borrador listo; se obtuvo ${params.status}.`
    );
  }
  if (!params.contract_drafted_event) {
    errors.push("Debe existir human_decision con kind=contract_drafted.");
  }
  return { ok: errors.length === 0, errors };
}

/** Salida B: plantilla ausente o render imposible — pausa con aviso, sin borrador. */
export function validateContractTemplateMissingStepOutcome(params: {
  current_step: string;
  status: string;
  contract_drafted_event: boolean;
  notify_user_executed: boolean;
  generate_document_rendered?: boolean;
  contract_draft_has_output_path?: boolean;
}) {
  const errors: string[] = [];
  if (params.generate_document_rendered) {
    errors.push(
      "generate_document_from_template no debe renderizar en este escenario: elimina la plantilla DOCX (commission_contract_template) de la cuenta antes de correrlo."
    );
  }
  if (params.contract_draft_has_output_path) {
    errors.push(
      "No debe quedar contract_draft.output_path: este guardrail exige probar sin plantilla DOCX usable."
    );
  }
  if (params.current_step !== "contract_pending") {
    errors.push("current_step debe permanecer en contract_pending.");
  }
  if (!params.notify_user_executed) {
    errors.push(
      "notify_user debe ejecutarse explicando la falta de plantilla o el fallo de generación."
    );
  }
  if (params.status !== "paused") {
    errors.push(`status debe ser paused; se obtuvo ${params.status}.`);
  }
  if (params.contract_drafted_event) {
    errors.push(
      "No debe existir contract_drafted cuando no hubo borrador real (plantilla faltante)."
    );
  }
  return { ok: errors.length === 0, errors };
}

/** @deprecated Usar validateContractDraftReadyStepOutcome o validateContractTemplateMissingStepOutcome. */
export function validateContractDraftReviewStepOutcome(params: {
  current_step: string;
  status: string;
  contract_drafted_event: boolean;
  notify_user_executed: boolean;
}) {
  const templateMissingBranch =
    params.status === "paused" && !params.contract_drafted_event;
  if (templateMissingBranch) {
    return validateContractTemplateMissingStepOutcome(params);
  }
  return validateContractDraftReadyStepOutcome({
    ...params,
    generate_document_rendered: params.contract_drafted_event,
    contract_draft_has_output_path: params.contract_drafted_event,
  });
}

export function validateContractHitlPrerequisites(context: unknown) {
  const errors: string[] = [];
  if (!isRecord(context)) {
    errors.push("context_jsonb inválido.");
    return { ok: false, errors };
  }
  const draft = context.contract_draft;
  const hasOutput =
    isRecord(draft) &&
    typeof draft.output_path === "string" &&
    draft.output_path.trim().length > 0;
  if (!hasOutput) {
    errors.push(
      "Falta borrador real (contract_draft.output_path). Ejecuta primero el escenario «Borrador de contrato para revisión» con plantilla DOCX configurada."
    );
  }
  return { ok: errors.length === 0, errors };
}

export function validateContractApprovedSendStepOutcome(params: {
  current_step: string;
  status: string;
  approved_event: boolean;
  sent_event: boolean;
}) {
  const errors: string[] = [];
  if (params.current_step !== "photos_scheduled") {
    errors.push("current_step debe avanzar a photos_scheduled tras envío por email.");
  }
  if (params.status !== "paused") {
    errors.push(
      "status debe ser paused en caso de prueba de settings tras enviar contrato por email."
    );
  }
  if (!params.approved_event) {
    errors.push(
      "Debe existir human_decision con kind=contract_approved_for_email_send."
    );
  }
  if (!params.sent_event) {
    errors.push("Debe existir reminder_sent con purpose=contract_sent_to_owner.");
  }
  return { ok: errors.length === 0, errors };
}

export function validateContractChangesRequestedStepOutcome(params: {
  current_step: string;
  status: string;
  changes_event: boolean;
}) {
  const errors: string[] = [];
  if (params.current_step !== "contract_pending") {
    errors.push("current_step debe permanecer en contract_pending.");
  }
  if (params.status !== "waiting_internal") {
    errors.push("status debe ser waiting_internal mientras se piden cambios.");
  }
  if (!params.changes_event) {
    errors.push("Debe existir human_decision con kind=contract_changes_requested.");
  }
  return { ok: errors.length === 0, errors };
}

export function validateContractSignedStepOutcome(params: {
  current_step: string;
  status: string;
  contract_signed_event: boolean;
}) {
  const errors: string[] = [];
  if (params.current_step !== "photos_scheduled") {
    errors.push("current_step debe avanzar a photos_scheduled tras firma.");
  }
  if (params.status !== "paused") {
    errors.push(
      "status debe ser paused en caso de prueba de settings tras registrar firma."
    );
  }
  if (!params.contract_signed_event) {
    errors.push("Debe existir step_completed con kind=contract_signed.");
  }
  return { ok: errors.length === 0, errors };
}

export function contractReviewContextOk(context: unknown) {
  if (!isRecord(context)) return false;
  const review = context.contract_review;
  return isRecord(review) && typeof review.status === "string";
}

export function contractDraftHasStoredOutput(context: unknown) {
  return generatedDocumentHasStoredOutput(context, CONTRACT_DRAFT_DOCUMENT_BINDING);
}
