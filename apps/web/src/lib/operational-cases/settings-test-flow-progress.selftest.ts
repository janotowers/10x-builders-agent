import assert from "node:assert/strict";
import {
  buildSettingsTestFlowProgress,
  flowProgressForE2ESummary,
  type SettingsTestFlowProgressStep,
} from "./settings-test-flow-progress";
import type { OperationalCase, OperationalCaseFlowStep, ToolCall } from "@agents/types";

const flow: SettingsTestFlowProgressStep[] = [
  {
    step_key: "intake",
    step_label: "Completar registro del caso",
    status: "completed",
    evidence: ["event:step_completed", "event:state_changed"],
    evidenceItems: [
      {
        kind: "event",
        id: "e-safe",
        created_at: "2026-06-05T10:00:00.000Z",
        event_type: "step_completed",
        event_kind: "controlled_test_started",
        summary: "Prueba segura iniciada",
      },
      {
        kind: "event",
        id: "e-safe-state",
        created_at: "2026-06-05T10:00:01.000Z",
        event_type: "state_changed",
        event_result: "safe_readiness_passed",
        summary: "Cambio de estado del caso",
      },
    ],
  },
  {
    step_key: "awaiting_documents",
    step_label: "Solicitar documentos",
    status: "in_progress",
    evidence: ["event:step_completed", "tool:telegram_send_message_to_contact:executed"],
    evidenceItems: [
      {
        kind: "event",
        id: "e-e2e",
        created_at: "2026-06-05T10:05:00.000Z",
        event_type: "step_completed",
        event_kind: "controlled_test_e2e_started",
        summary: "Transición con agente iniciada",
      },
      {
        kind: "tool",
        id: "t1",
        created_at: "2026-06-05T10:05:02.000Z",
        tool_name: "telegram_send_message_to_contact",
        status: "executed",
        summary: "telegram_send_message_to_contact · Ejecutada",
      },
    ],
  },
];

const filtered = flowProgressForE2ESummary(flow, {
  e2eStartedAt: "2026-06-05T10:05:00.000Z",
});

assert.equal(filtered[0]?.evidenceItems.length, 0);
assert.equal(filtered[0]?.status, "pending");
assert.equal(filtered[1]?.evidenceItems.length, 2);
assert.equal(filtered[1]?.status, "in_progress");

const preE2EDocumentFlow = flowProgressForE2ESummary(
  [
    {
      step_key: "awaiting_documents",
      step_label: "Solicitar documentos",
      status: "completed",
      evidence: ["event:external_response"],
      evidenceItems: [
        {
          kind: "event",
          id: "doc-pre-e2e",
          created_at: "2026-06-05T10:04:30.000Z",
          event_type: "external_response",
          event_kind: "document_registered",
          summary: "Documento recibido",
        },
      ],
    },
  ],
  {
    e2eStartedAt: "2026-06-05T10:05:00.000Z",
  }
);
assert.equal(
  preE2EDocumentFlow[0]?.evidenceItems.some((item) => item.id === "doc-pre-e2e"),
  true,
  "los documentos previos al arranque E2E deben conservarse en el resumen"
);

const conversationalIntake = flowProgressForE2ESummary(
  [
    {
      step_key: "intake",
      step_label: "Completar registro del caso",
      status: "completed",
      evidence: ["event:step_completed", "event:reminder_sent"],
      evidenceItems: [
        {
          kind: "event",
          id: "case-created",
          created_at: "2026-06-05T10:01:00.000Z",
          event_type: "step_completed",
          event_kind: "case_created",
          summary: "Caso conversacional creado",
        },
        {
          kind: "event",
          id: "intake-requested",
          created_at: "2026-06-05T10:01:01.000Z",
          event_type: "reminder_sent",
          event_kind: "intake_fields_requested",
          summary: "Campos de intake solicitados",
        },
      ],
    },
    flow[1]!,
  ],
  { e2eStartedAt: "2026-06-05T10:05:00.000Z" }
);

assert.deepEqual(
  conversationalIntake[0]?.evidenceItems.map((item) => item.id),
  ["case-created", "intake-requested"]
);
assert.equal(conversationalIntake[0]?.status, "completed");

const caseFlow: OperationalCaseFlowStep[] = [
  {
    step_key: "awaiting_documents",
    step_label: "Solicitar documentos",
    step_tools: [
      { tool_id: "operational_case_update_state", tool_label: "Actualizar" },
    ],
  },
];
const opCase = {
  current_step: "awaiting_documents",
  context_jsonb: {},
} as OperationalCase;
const approvalAndOwnedExecution = buildSettingsTestFlowProgress({
  opCase,
  events: [],
  flow: caseFlow,
  toolCalls: [
    {
      id: "approval-row",
      session_id: "s1",
      turn_id: "turn-1",
      tool_name: "operational_case_update_state",
      arguments_json: { case_id: "case-1", current_step: "awaiting_documents" },
      status: "executed",
      requires_confirmation: true,
      created_at: "2026-06-05T10:05:01.000Z",
    },
    {
      id: "owned-execution-row",
      session_id: "s1",
      turn_id: "turn-1",
      tool_name: "operational_case_update_state",
      arguments_json: { case_id: "case-1", current_step: "awaiting_documents" },
      status: "executed",
      requires_confirmation: false,
      created_at: "2026-06-05T10:05:02.000Z",
    },
  ] as ToolCall[],
});

assert.deepEqual(
  approvalAndOwnedExecution[0]?.evidenceItems.map((item) => item.id),
  ["owned-execution-row"]
);

// Documentos registrados (sin `current_step` en su payload) se atribuyen al
// paso "Solicitar documentos" para que el panel muestre actividad documental.
const docFlow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Completar registro del caso" },
  { step_key: "awaiting_documents", step_label: "Solicitar documentos" },
];
const docCase = {
  current_step: "awaiting_documents",
  context_jsonb: {},
} as OperationalCase;
const withDocs = buildSettingsTestFlowProgress({
  opCase: docCase,
  events: [
    {
      id: "doc-1",
      case_id: "case-1",
      event_type: "external_response",
      actor: "user",
      created_at: "2026-06-05T10:06:00.000Z",
      payload_jsonb: {
        kind: "document_registered",
        source: "advisor_telegram",
        original_name: "Boleta Registral.pdf",
      },
    },
  ] as unknown as Parameters<typeof buildSettingsTestFlowProgress>[0]["events"],
  flow: docFlow,
});
const documentsStep = withDocs.find(
  (step) => step.step_key === "awaiting_documents"
);
assert.equal(
  documentsStep?.evidenceItems.some((item) => item.id === "doc-1"),
  true,
  "el documento registrado debe aparecer en Solicitar documentos"
);
assert.ok(
  documentsStep?.evidenceItems.some(
    (item) => item.kind === "event" && item.summary.includes("Boleta Registral.pdf")
  ),
  "el panel debe mostrar el nombre del documento"
);
// No debe filtrarse al paso intake.
const intakeStep = withDocs.find((step) => step.step_key === "intake");
assert.equal(
  intakeStep?.evidenceItems.some((item) => item.id === "doc-1"),
  false
);

console.log("settings-test-flow-progress.selftest: ok");
