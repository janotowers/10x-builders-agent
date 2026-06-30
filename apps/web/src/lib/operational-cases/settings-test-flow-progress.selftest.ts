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

const preE2EDocumentReminderFlow = flowProgressForE2ESummary(
  [
    {
      step_key: "awaiting_documents",
      step_label: "Solicitar documentos",
      status: "completed",
      evidence: ["event:reminder_sent"],
      evidenceItems: [
        {
          kind: "event",
          id: "doc-reminder-pre-e2e",
          created_at: "2026-06-05T10:04:20.000Z",
          event_type: "reminder_sent",
          event_kind: "internal_upload_instructions",
          summary: "Instrucciones de carga interna enviadas",
        },
      ],
    },
  ],
  {
    e2eStartedAt: "2026-06-05T10:05:00.000Z",
  }
);
assert.equal(
  preE2EDocumentReminderFlow[0]?.evidenceItems.some(
    (item) => item.id === "doc-reminder-pre-e2e"
  ),
  true,
  "los recordatorios documentales previos al arranque E2E deben conservarse en el resumen"
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

const withToolPayloadDetails = buildSettingsTestFlowProgress({
  opCase: {
    current_step: "awaiting_documents",
    context_jsonb: {},
  } as OperationalCase,
  events: [],
  flow: [
    {
      step_key: "awaiting_documents",
      step_label: "Solicitar documentos",
      step_tools: [{ tool_id: "notify_user", tool_label: "Notificar" }],
    },
  ],
  toolCalls: [
    {
      id: "tool-with-details",
      session_id: "s1",
      turn_id: "turn-2",
      tool_name: "notify_user",
      arguments_json: {
        case_id: "case-1",
        message: "x".repeat(1500),
      },
      result_json: {
        ok: true,
        rows: Array.from({ length: 30 }, (_, idx) => idx + 1),
      },
      status: "executed",
      requires_confirmation: false,
      created_at: "2026-06-05T10:07:00.000Z",
    },
  ] as ToolCall[],
});
const toolDetailItem = withToolPayloadDetails[0]?.evidenceItems.find(
  (item) => item.kind === "tool" && item.id === "tool-with-details"
);
assert.ok(toolDetailItem && toolDetailItem.kind === "tool");
assert.equal(
  typeof toolDetailItem?.arguments_json === "object",
  true,
  "debe adjuntar arguments_json sanitizado al item de evidencia"
);
assert.equal(
  Array.isArray(
    (toolDetailItem?.result_json as { rows?: unknown[] } | undefined)?.rows
  ),
  true
);

// `step_key` autoritativo: la atribución es EXCLUSIVA al paso indicado, aunque
// el payload contenga `to.current_step` de otro paso (transición). Esto evita
// que un mismo evento se cuente en dos pasos a la vez.
const authoritativeFlow: OperationalCaseFlowStep[] = [
  { step_key: "price_proposal_pending", step_label: "Preparar precio" },
  { step_key: "contract_pending", step_label: "Preparar contrato" },
];
const authoritativeCase = {
  current_step: "contract_pending",
  context_jsonb: {},
} as OperationalCase;
const withAuthoritative = buildSettingsTestFlowProgress({
  opCase: authoritativeCase,
  events: [
    {
      id: "price-approved-1",
      case_id: "case-1",
      event_type: "human_decision",
      actor: "user",
      created_at: "2026-06-05T10:10:00.000Z",
      payload_jsonb: {
        kind: "price_approved",
        step_key: "price_proposal_pending",
        current_step: "price_proposal_pending",
        to: { current_step: "contract_pending", status: "active" },
      },
    },
    {
      id: "contract-entered-1",
      case_id: "case-1",
      event_type: "state_changed",
      actor: "system",
      created_at: "2026-06-05T10:10:01.000Z",
      payload_jsonb: {
        kind: "contract_preparation_entered",
        step_key: "contract_pending",
        current_step: "contract_pending",
      },
    },
  ] as unknown as Parameters<typeof buildSettingsTestFlowProgress>[0]["events"],
  flow: authoritativeFlow,
});
const priceStep = withAuthoritative.find(
  (step) => step.step_key === "price_proposal_pending"
);
const contractStep = withAuthoritative.find(
  (step) => step.step_key === "contract_pending"
);
assert.deepEqual(
  priceStep?.evidenceItems.map((item) => item.id),
  ["price-approved-1"],
  "price_approved debe atribuirse SOLO a Preparar precio (paso autoritativo)"
);
assert.deepEqual(
  contractStep?.evidenceItems.map((item) => item.id),
  ["contract-entered-1"],
  "contract_preparation_entered debe atribuirse SOLO a Preparar contrato"
);

// El resumen E2E conserva eventos con paso autoritativo aunque su `source` no
// esté en el allowlist heredado (esto es lo que dejaba el Paso 4 "sin actividad").
const e2eWithAuthoritative = flowProgressForE2ESummary(
  [
    {
      step_key: "price_proposal_pending",
      step_label: "Preparar precio",
      status: "completed",
      evidence: ["event:state_changed"],
      evidenceItems: [
        {
          kind: "event",
          id: "price-prepared-evt",
          created_at: "2026-06-05T10:10:30.000Z",
          event_type: "state_changed",
          event_kind: "price_proposal_prepared",
          event_source: "operational_case_persist_comparables_analysis",
          event_step_key: "price_proposal_pending",
          summary: "Propuesta de precio preparada",
        },
      ],
    },
  ],
  { e2eStartedAt: "2026-06-05T10:05:00.000Z" }
);
assert.equal(
  e2eWithAuthoritative[0]?.evidenceItems.some(
    (item) => item.id === "price-prepared-evt"
  ),
  true,
  "el resumen E2E debe conservar eventos con event_step_key autoritativo"
);

const contractToolSummary = buildSettingsTestFlowProgress({
  opCase: {
    current_step: "contract_pending",
    context_jsonb: {},
  } as OperationalCase,
  events: [
    {
      id: "contract-review-requested",
      case_id: "case-1",
      event_type: "human_decision",
      actor: "system",
      created_at: "2026-06-05T10:20:00.000Z",
      payload_jsonb: {
        kind: "contract_review_requested",
        step_key: "contract_pending",
      },
    },
  ] as unknown as Parameters<typeof buildSettingsTestFlowProgress>[0]["events"],
  flow: [
    {
      step_key: "contract_pending",
      step_label: "Preparar contrato",
      step_tools: [
        { tool_id: "generate_document_from_template", tool_label: "Generar" },
      ],
    },
  ],
  toolCalls: [
    {
      id: "contract-doc-pending",
      session_id: "s1",
      turn_id: "turn-contract",
      tool_name: "generate_document_from_template",
      arguments_json: { case_id: "case-1", template_slug: "commission_contract" },
      status: "pending_confirmation",
      requires_confirmation: true,
      created_at: "2026-06-05T10:20:01.000Z",
      metadata_jsonb: { operational_step_key: "contract_pending" },
    },
    {
      id: "contract-doc-executed",
      session_id: "s1",
      turn_id: "turn-contract",
      tool_name: "generate_document_from_template",
      arguments_json: { case_id: "case-1", template_slug: "commission_contract" },
      status: "executed",
      requires_confirmation: false,
      created_at: "2026-06-05T10:20:02.000Z",
      metadata_jsonb: { operational_step_key: "contract_pending" },
    },
  ] as ToolCall[],
});
const contractEvidenceSummaries = (
  contractToolSummary[0]?.evidenceItems.filter((item) => item.kind === "tool") ?? []
).map((item) => item.summary);
assert.ok(
  contractEvidenceSummaries.includes("Borrador de contrato generado"),
  "cuando generate_document_from_template se ejecuta en contract_pending debe mostrar resumen de borrador generado"
);
assert.ok(
  contractEvidenceSummaries.includes("Generando borrador interno (pendiente)"),
  "cuando generate_document_from_template queda pending_confirmation debe mostrar resumen de generación interna pendiente"
);
assert.ok(
  contractToolSummary[0]?.evidenceItems.some(
    (item) => item.kind === "event" && item.summary === "Revisión de contrato solicitada"
  ),
  "contract_review_requested debe tener summary legible en Paso 5"
);

const chronologicalOrder = buildSettingsTestFlowProgress({
  opCase: {
    current_step: "comparables_in_progress",
    context_jsonb: {},
  } as OperationalCase,
  events: [
    {
      id: "event-later",
      case_id: "case-1",
      event_type: "state_changed",
      actor: "system",
      created_at: "2026-06-05T10:30:02.000Z",
      payload_jsonb: {
        kind: "comparables_analysis_completed",
        step_key: "comparables_in_progress",
      },
    },
    {
      id: "event-earlier",
      case_id: "case-1",
      event_type: "state_changed",
      actor: "system",
      created_at: "2026-06-05T10:30:00.000Z",
      payload_jsonb: {
        kind: "controlled_test_e2e_started",
        step_key: "comparables_in_progress",
      },
    },
  ] as unknown as Parameters<typeof buildSettingsTestFlowProgress>[0]["events"],
  flow: [
    {
      step_key: "comparables_in_progress",
      step_label: "Análisis de comparables",
    },
  ],
  toolCalls: [
    {
      id: "tool-middle",
      session_id: "s1",
      turn_id: "turn-1",
      tool_name: "easybroker_search_listings",
      arguments_json: { case_id: "case-1" },
      status: "executed",
      requires_confirmation: false,
      created_at: "2026-06-05T10:30:01.000Z",
      metadata_jsonb: { operational_step_key: "comparables_in_progress" },
    },
  ] as ToolCall[],
});
assert.deepEqual(
  chronologicalOrder[0]?.evidenceItems.map((item) => item.id),
  ["event-earlier", "tool-middle", "event-later"],
  "Ver actividad debe listar evidencia en orden cronológico (antiguo arriba, reciente abajo)"
);

console.log("settings-test-flow-progress.selftest: ok");
