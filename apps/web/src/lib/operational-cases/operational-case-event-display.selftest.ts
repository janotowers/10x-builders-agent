import assert from "node:assert/strict";
import type { OperationalCaseEvent } from "@agents/types";
import { formatOperationalCaseEventSummary } from "./operational-case-event-display";

function event(input: {
  event_type: string;
  actor?: "system" | "agent" | "user";
  payload?: Record<string, unknown>;
}): OperationalCaseEvent {
  return {
    id: "evt-1",
    case_id: "case-1",
    event_type: input.event_type,
    actor: input.actor ?? "system",
    payload_jsonb: input.payload ?? {},
    created_at: "2026-06-28T19:50:41.000Z",
  } as OperationalCaseEvent;
}

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        from: { status: "waiting_internal", current_step: "property_data_review" },
        to: { status: "active", current_step: "comparables_in_progress" },
      },
    })
  ),
  "Cambio de estado: waiting_internal / property_data_review → active / comparables_in_progress"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "reminder_sent",
      payload: {
        kind: "reminder_sent",
        purpose: "characteristics_pending_internal",
        channel: "notify_user",
      },
    }),
    { includeTechnicalKind: true }
  ),
  "Recordatorio enviado (propósito characteristics_pending_internal · canal notify_user) (reminder_sent)"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      actor: "agent",
      payload: { kind: "contract_drafted" },
    }),
    { includeTechnicalKind: true }
  ),
  "Cambio de estado del caso (contract_drafted)"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "reminder_sent",
      payload: {
        purpose: "internal_upload_instructions",
        channel: "telegram",
      },
    })
  ),
  "Instrucciones de carga interna enviadas · canal telegram"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        kind: "document_surfaces_consolidated_to_property_data",
        adopted: { area_total_m2: 138, area_construida_m2: 146 },
      },
    })
  ),
  "Superficies consolidadas en ficha: terreno 138 m², construcción 146 m²"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        kind: "document_address_conflict_detected",
        conflicts: [
          {
            field: "exterior_number",
            existing: "3668",
            incoming: "368",
            existing_source: "boleta_registral",
            incoming_source: "escritura",
          },
        ],
      },
    })
  ),
  "Conflicto de dirección detectado: número exterior: «3668» vs «368»"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        kind: "document_address_conflict_detected",
        conflicts: [],
      },
    })
  ),
  "Conflicto de dirección detectado entre fuentes"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "human_decision",
      actor: "user",
      payload: {
        kind: "comparables_search_expansion_decision_response",
        decision: "use_avaclick_primary",
      },
    })
  ),
  "Decisión de comparables: usar Avaclick como base"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "human_decision",
      actor: "user",
      payload: {
        kind: "comparables_search_expansion_decision_response",
        decision: "expand_search",
      },
    })
  ),
  "Decisión de comparables: ampliar búsqueda"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "human_decision",
      actor: "user",
      payload: {
        kind: "comparables_search_expansion_decision_response",
        decision: "use_current_comparables",
      },
    })
  ),
  "Decisión de comparables: avanzar con comparables actuales"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "human_decision",
      actor: "user",
      payload: {
        kind: "contract_email_send_attempted",
        channel: "email",
        owner_email: "alex@example.com",
      },
    })
  ),
  "Enviando contrato por email al propietario"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        kind: "contract_email_send_failed",
        channel: "email",
        status: "gmail_send_failed",
        error_reason: "insufficientPermissions",
      },
    })
  ),
  "Falló el envío del contrato por email (insufficientPermissions)"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "state_changed",
      payload: {
        kind: "contract_email_send_failed",
        channel: "email",
        status: "gmail_send_failed",
      },
    })
  ),
  "Falló el envío del contrato por email (gmail_send_failed)"
);

assert.equal(
  formatOperationalCaseEventSummary(
    event({
      event_type: "step_completed",
      payload: { kind: "contract_sent_to_owner_email" },
    })
  ),
  "Contrato enviado por email al propietario"
);

console.log("operational-case-event-display.selftest: ok");
