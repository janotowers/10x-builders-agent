/**
 * Catálogo machine-readable de patrones operacionales reutilizables.
 * Fuente narrativa: docs/operational-cases/operational-case-reusable-patterns.md
 *
 * Fase C1: IDs + metadata para autoría NL y futura UI (sin refactor React aún).
 */

export type TestPatternLayer =
  | "runtime"
  | "test_contract"
  | "test_ui"
  | "test_n2";

export type TestPatternEntry = {
  id: string;
  layer: TestPatternLayer;
  label: string;
  description: string;
  /** Ruta relativa al repo desde la raíz, para navegación en IDE */
  implementationPaths: string[];
  appliesToTools?: string[];
  appliesToSkills?: string[];
  testLevels?: Array<"n0" | "n1" | "n2" | "n3" | "n4" | "n5">;
  settingsTestOnly?: boolean;
  docAnchor: string;
};

const DOC = "docs/operational-cases/operational-case-reusable-patterns.md";

export const OPERATIONAL_TEST_PATTERNS: TestPatternEntry[] = [
  {
    id: "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
    layer: "runtime",
    label: "Dedup Telegram mismo turno",
    description:
      "Evita doble sendMessage cuando el modelo invoca telegram_send_message_to_contact dos veces con texto equivalente.",
    implementationPaths: [
      "packages/types/src/telegram-send-dedup.ts",
      "packages/agent/src/tools/realestate-adapters.ts",
    ],
    appliesToTools: ["telegram_send_message_to_contact"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_telegram_dedup_same_turn`,
  },
  {
    id: "PATTERN_NOTIFY_USER_CHANNELS",
    layer: "runtime",
    label: "Notify interno multi-canal",
    description:
      "notify_user persiste en web y envía push según preferencias (telegram, etc.).",
    implementationPaths: [
      "apps/web/src/lib/notify/index.ts",
      "packages/agent/src/tools/operational-cases-adapters.ts",
    ],
    appliesToTools: ["notify_user"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_notify_user_channels`,
  },
  {
    id: "PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION",
    layer: "runtime",
    label: "Gate único con remediación por dueño",
    description:
      "Predicado único evaluatePropertyAdvanceGate decide si un caso puede avanzar y cada bloqueo declara su remediation.owner (deterministic|external|human|llm). Consumido por tool gate, invariante y gate de contrato; targetTransition desacopla comparables vs contrato.",
    implementationPaths: [
      "packages/agent/src/tools/operational-cases-adapters.ts",
      "apps/web/src/lib/operational-cases/property-optioning-post-agent-invariants.ts",
      "packages/agent/src/tools/realestate-adapters.ts",
    ],
    appliesToTools: ["notify_user", "generate_document_from_template"],
    appliesToSkills: [
      "extract-property-characteristics",
      "prepare-commission-contract",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_gated_transition_with_owned_remediation`,
  },
  {
    id: "PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER",
    layer: "runtime",
    label: "Auto-remediación determinística con breaker",
    description:
      "El invariante post-agente re-OCR-ea documentos pendientes (runDocumentFieldExtraction force=true) con tope N=3 por documento y escala a humano al agotarse, sin dejar estados terminales silenciosos.",
    implementationPaths: [
      "packages/agent/src/tools/operational-cases-adapters.ts",
      "apps/web/src/lib/operational-cases/property-optioning-post-agent-invariants.ts",
    ],
    appliesToTools: ["operational_case_extract_document_fields"],
    appliesToSkills: ["extract-property-characteristics"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_deterministic_auto_remediation_with_circuit_breaker`,
  },
  {
    id: "PATTERN_SKILL_GATE_CONTRACT_PARITY",
    layer: "runtime",
    label: "Paridad skill ↔ gate",
    description:
      "Las instrucciones de la skill describen exactamente lo que exige el gate determinístico por transición, evitando split-brain (la skill cree terminar pero el gate sigue bloqueando).",
    implementationPaths: [
      "skills/global/extract-property-characteristics/SKILL.md",
      "skills/global/prepare-commission-contract/SKILL.md",
      "packages/agent/src/tools/operational-cases-adapters.ts",
    ],
    appliesToSkills: [
      "extract-property-characteristics",
      "prepare-commission-contract",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_skill_gate_contract_parity`,
  },
  {
    id: "PATTERN_CASE_UPDATE_STATE_OPTIMISTIC_RETRY",
    layer: "runtime",
    label: "Update state con retry de versión",
    description:
      "operational_case_update_state reintenta una vez tras version_mismatch por llamadas paralelas.",
    implementationPaths: [
      "packages/agent/src/tools/operational-cases-adapters.ts",
    ],
    appliesToTools: ["operational_case_update_state"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_case_update_state_optimistic_retry`,
  },
  {
    id: "PATTERN_SETTINGS_TEST_SEED_AND_REPAIR",
    layer: "runtime",
    label: "Semilla y reparación en prueba N3",
    description:
      "Solo casos case_type_settings_test: semilla de estado/artefacto y repair post-tick en run-skill.",
    implementationPaths: [
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
    ],
    settingsTestOnly: true,
    testLevels: ["n3"],
    docAnchor: `${DOC}#pattern_settings_test_seed_and_repair`,
  },
  {
    id: "PATTERN_SKILL_TEST_CONTRACT",
    layer: "test_contract",
    label: "Contrato N3 por habilidad",
    description:
      "expected_tool_calls, events, context keys en test_contract o SKILL_TEST_CONTRACTS.",
    implementationPaths: [
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
    ],
    testLevels: ["n3"],
    docAnchor: `${DOC}#pattern_skill_test_contract`,
  },
  {
    id: "PATTERN_STEP_TEST_SCENARIO",
    layer: "test_contract",
    label: "Escenario N4 por paso",
    description:
      "Registry único con metadata UI, semilla, expect y mensaje de prueba; ejecución N4 durable con run_id y polling.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/step-test-scenario-registry.ts",
      "apps/web/src/lib/operational-cases/step-test-scenarios.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
      "packages/db/supabase/migrations/00040_operational_case_test_runs.sql",
    ],
    testLevels: ["n4"],
    docAnchor: `${DOC}#pattern_step_test_scenario`,
  },
  {
    id: "PATTERN_STEP_BRANCH_DECISION",
    layer: "test_contract",
    label: "Decisión de rama en un paso (explicativa)",
    description:
      "Mismo step_key con 2+ caminos (audiencia/espera). Runtime en código+contexto; flow/UI solo documentan ramas. Cada rama declarada exige ≥1 N4 milestone. No es motor de grafos en el panel.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/document-request-target.ts",
      "apps/web/src/lib/operational-cases/step-decision.ts",
      "skills/global/request-property-documents/SKILL.md",
      "packages/agent/src/tools/realestate-adapters.ts",
      "packages/db/supabase/migrations/00059_property_optioning_awaiting_documents_step_decision.sql",
      "packages/db/supabase/migrations/00060_property_optioning_step_decision_documents_comparables.sql",
      "packages/db/supabase/migrations/00061_property_optioning_documents_received_pending_internal_branch.sql",
      "docs/operational-cases/step-branch-clarity-plan.md",
    ],
    appliesToSkills: [
      "request-property-documents",
      "extract-property-characteristics",
      "perform-comparable-analysis",
      "property-optioning-coach",
    ],
    testLevels: ["n3", "n4", "n5"],
    docAnchor: `${DOC}#pattern_step_branch_decision`,
  },
  {
    id: "PATTERN_STEP_TEST_BUSINESS_DECISION",
    layer: "test_contract",
    label: "N4 por decisión HITL (handler)",
    description:
      "Escenarios N4 con execution=business_decision: semilla + runBusinessDecisionStepTest (mismo handler que Telegram/inbox), sin tick del agente raíz. Copy genérico en step-test-ui-copy con overrides ui por escenario.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/step-test-business-decision.ts",
      "apps/web/src/lib/operational-cases/step-test-ui-copy.ts",
      "apps/web/src/lib/business-decisions/registry.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
    ],
    testLevels: ["n4"],
    docAnchor: `${DOC}#pattern_step_test_business_decision`,
  },
  {
    id: "PATTERN_SKILL_TEST_PROMPT_GUARDRAILS",
    layer: "test_contract",
    label: "Guardrails en prompt de prueba",
    description:
      "Instrucciones en buildSkillTestMessage / mensaje N4: una Telegram por tick, notify obligatorio, ramas explícitas.",
    implementationPaths: [
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_skill_test_prompt_guardrails`,
  },
  {
    id: "PATTERN_SKILL_TEST_CALL_DETAILS",
    layer: "test_ui",
    label: "Detalle unificado tool calls N3/N4",
    description:
      "UI compartida: Telegram externo, notify interno, conteo envíos reales vs duplicadas.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/skill-test-call-details.tsx",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_skill_test_call_details`,
  },
  {
    id: "PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT",
    layer: "runtime",
    label: "Zona efectiva comparables",
    description:
      "N1/N3/N4 usan property_zone del caso para recipes y property_data; evita Colomos en preset vs Sendas en semilla.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/property-search-zone.ts",
      "apps/web/src/app/api/tool-readiness/run-tool/route.ts",
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
    ],
    appliesToSkills: ["perform-comparable-analysis"],
    appliesToTools: [
      "easybroker_search_listings",
      "easybroker_search_closed_deals",
      "bigquery_lookup_local_comparables",
    ],
    testLevels: ["n1", "n3", "n4"],
    docAnchor: `${DOC}#pattern_comparable_search_zone_alignment`,
  },
  {
    id: "PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE",
    layer: "runtime",
    label: "Muestra insuficiente — no avanzar a precio",
    description:
      "Si no existe una muestra defendible de al menos 3 comparables únicos, permanecer en comparables_in_progress + waiting_internal + notify_user.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/comparables-analysis-validation.ts",
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
      "skills/global/perform-comparable-analysis/SKILL.md",
    ],
    appliesToSkills: ["perform-comparable-analysis"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_comparables_insufficient_no_advance`,
  },
  {
    id: "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
    layer: "test_ui",
    label: "N3/N4 bloqueados sin N1",
    description:
      "Probar habilidad y Probar paso deshabilitados hasta que las tools readiness-visible del paso tengan N1 exitosa; API run-skill y run-step usan readinessToolIdsForStep/Skill.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/readiness-test-ui.ts",
      "apps/web/src/lib/operational-cases/tool-surface-classification.ts",
      "apps/web/src/lib/operational-cases/tested-tools-for-user.ts",
      "apps/web/src/app/api/tool-readiness/run-skill/route.ts",
      "apps/web/src/app/api/tool-readiness/run-step/route.ts",
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_readiness_n3_n4_blocked_by_tools`,
  },
  {
    id: "PATTERN_STEP_STATUS_N3_VS_N4",
    layer: "test_ui",
    label: "Pill de paso: N3 no sustituye N4",
    description:
      "Paso probado solo cuando todos los escenarios del registry tienen run N4 exitoso por scenario_id. Progreso parcial: pill «Paso en progreso» y «X de Y escenarios probados». Sin escenarios configurados, basta habilidad probada.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/step-test-scenario-evidence.ts",
      "packages/db/supabase/migrations/00040_operational_case_test_runs.sql",
      "apps/web/src/app/api/tool-readiness/route.ts",
      "apps/web/src/lib/operational-cases/readiness-test-ui.ts",
      "apps/web/src/lib/operational-cases/step-test-scenario-registry.ts",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_step_status_n3_vs_n4`,
  },
  {
    id: "PATTERN_TOOL_SURFACE_CLASSIFICATION",
    layer: "runtime",
    label: "Clasificación superficie de tools",
    description:
      "Separa tools N1 (integración/acción) de internas de plataforma/dominio y scenario_only; no usar allowed_tools como lista N1 automática.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/tool-surface-classification.ts",
      "apps/web/src/app/api/tool-readiness/route.ts",
    ],
    testLevels: ["n1", "n3", "n4"],
    docAnchor: `${DOC}#pattern_tool_surface_classification`,
  },
  {
    id: "PATTERN_CASE_INTAKE_PRECONDITION",
    layer: "test_ui",
    label: "Preparar caso de prueba (N0)",
    description:
      "Resumen readiness-visible, tarjeta N0 (pill fixture), intake y pasos Paso N colapsados por defecto; formulario + safe_check en N0.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/tool-surface-classification.ts",
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
    ],
    testLevels: ["n0"],
    settingsTestOnly: true,
    docAnchor: `${DOC}#pattern_case_intake_precondition`,
  },
  {
    id: "PATTERN_DETERMINISTIC_ARTIFACT_FROM_TOOL_RESULTS",
    layer: "runtime",
    label: "Artefacto determinístico desde tool_calls",
    description:
      "Artefactos críticos se construyen en código desde result_json de tools, no desde narrativa/JSON libre del modelo.",
    implementationPaths: [
      "packages/agent/src/operational-cases/comparables-analysis.ts",
      "packages/agent/src/tools/operational-cases-adapters.ts",
    ],
    appliesToSkills: ["perform-comparable-analysis"],
    appliesToTools: ["operational_case_persist_comparables_analysis"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_deterministic_artifact_from_tool_results`,
  },
  {
    id: "PATTERN_TOOL_AUDIT_SINGLE_OWNER",
    layer: "runtime",
    label: "Auditoría de tool con un solo dueño",
    description:
      "El grafo no crea fila approved previa si el handler de la tool ya persiste tool_calls (evita duplicados en N3 con auto_execute).",
    implementationPaths: [
      "packages/agent/src/tools/tool-audit-ownership.ts",
      "packages/agent/src/graph.ts",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_tool_audit_single_owner`,
  },
  {
    id: "PATTERN_GENERATED_DOCUMENT_DEDUP",
    layer: "runtime",
    label: "Dedup generate_document mismo turno",
    description:
      "Clave template_slug|format|case_id; primera renderiza, siguientes skipped_render sin segunda auditoría.",
    implementationPaths: [
      "packages/types/src/generated-document-dedup.ts",
      "packages/agent/src/tools/realestate-adapters.ts",
      "packages/agent/src/graph.ts",
    ],
    appliesToTools: ["generate_document_from_template"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_generated_document_dedup`,
  },
  {
    id: "PATTERN_BUSINESS_DECISION_CONTRACT_REVIEW",
    layer: "runtime",
    label: "HITL revisión y envío de contrato",
    description:
      "Borrador interno, decisión del asesor (aprobar/cambios/revisión), envío al dueño y firma simulada en laboratorio.",
    implementationPaths: [
      "apps/web/src/lib/business-decisions/contract-review.ts",
      "apps/web/src/lib/business-decisions/contract-owner-signed.ts",
      "apps/web/src/lib/business-decisions/registry.ts",
      "apps/web/src/app/api/business-decisions/contract-review/route.ts",
      "apps/web/src/lib/operational-cases/contract-review-validation.ts",
    ],
    appliesToSkills: ["prepare-commission-contract"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_business_decision_contract_review`,
  },
  {
    id: "PATTERN_OPERATIONAL_WRITE_GATE",
    layer: "runtime",
    label: "Gate de escritura operacional",
    description:
      "Transiciones críticas se validan en el adapter antes de persistir estado/contexto.",
    implementationPaths: [
      "packages/agent/src/tools/operational-cases-adapters.ts",
      "packages/agent/src/operational-cases/comparables-analysis.ts",
    ],
    appliesToTools: ["operational_case_update_state"],
    testLevels: ["n3", "n4", "n5"],
    docAnchor: `${DOC}#pattern_operational_write_gate`,
  },
  {
    id: "PATTERN_NOTIFY_DELIVERY_WARNING",
    layer: "test_ui",
    label: "Aviso notify sin Telegram",
    description:
      "Muestra aviso cuando notify_user no entregó por un canal push esperado (p. ej. telegram).",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/skill-test-call-details.tsx",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_notify_delivery_warning`,
  },
  {
    id: "PATTERN_LAB_FORM_PROPERTY_DATA_SYNC",
    layer: "runtime",
    label: "Precedencia de datos en laboratorio",
    description:
      "Sincroniza el formulario N0 con property_data respetando evidencia documental y evitando que una semilla de prueba sobrescriba datos de mayor autoridad.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/lab-form-property-data-sync.ts",
    ],
    settingsTestOnly: true,
    testLevels: ["n0", "n3", "n4"],
    docAnchor: `${DOC}#pattern_lab_form_property_data_sync`,
  },
  {
    id: "PATTERN_ARTIFACT_IDENTITY_STALENESS",
    layer: "runtime",
    label: "Staleness por identidad del artefacto",
    description:
      "Invalida resultados derivados cuando cambia la identidad de propiedad o la evidencia fuente usada para producirlos.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/property-identity-signature.ts",
      "apps/web/src/app/api/tool-readiness/run-tool/route.ts",
    ],
    testLevels: ["n1", "n3", "n4"],
    docAnchor: `${DOC}#pattern_artifact_identity_staleness`,
  },
  {
    id: "PATTERN_HITL_ACTION_CONTRACT",
    layer: "runtime",
    label: "Contrato canónico de acciones HITL",
    description:
      "Comparte IDs, callbacks, límites y presentación de las decisiones humanas entre web, Telegram y pruebas.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/hitl-action-contract.ts",
    ],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_hitl_action_contract`,
  },
  {
    id: "PATTERN_INTEGRATION_RECONNECT_DEGRADED_CONTINUATION",
    layer: "runtime",
    label: "Reconexión y continuación degradada",
    description:
      "Una integración desconectada produce una acción de reconexión y solo permite continuar con fuentes alternativas cuando el resultado sigue siendo defendible.",
    implementationPaths: [
      "packages/agent/src/tools/realestate-adapters.ts",
      "apps/web/src/lib/operational-cases/comparables-analysis-validation.ts",
    ],
    testLevels: ["n1", "n3", "n4"],
    docAnchor: `${DOC}#pattern_integration_reconnect_degraded_continuation`,
  },
  {
    id: "PATTERN_GENERATED_CASE_DOCUMENT_ACCESS",
    layer: "runtime",
    label: "Acceso estable a documentos generados",
    description:
      "Publica enlaces autenticados estables ligados al caso y evita exponer signed URLs temporales en mensajes o decisiones.",
    implementationPaths: [
      "apps/web/src/lib/operational-cases/generated-case-document.ts",
    ],
    appliesToTools: ["generate_document_from_template"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_generated_case_document_access`,
  },
  {
    id: "PATTERN_BUSINESS_DECISION_CONTRACT_DATA_REVIEW",
    layer: "test_contract",
    label: "Revisión humana de datos contractuales",
    description:
      "Normaliza la revisión de campos comerciales extraídos antes de generar o enviar un contrato.",
    implementationPaths: [
      "apps/web/src/lib/business-decisions/contract-data-review.ts",
      "apps/web/src/lib/business-decisions/registry.ts",
    ],
    appliesToSkills: ["prepare-commission-contract"],
    testLevels: ["n3", "n4"],
    docAnchor: `${DOC}#pattern_business_decision_contract_data_review`,
  },
  {
    id: "n2_telegram_abc",
    layer: "test_n2",
    label: "N2 Telegram A→B→C",
    description: "Validar mensaje, enviar real, simular respuesta si aplica.",
    implementationPaths: [
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
    ],
    appliesToTools: ["telegram_send_message_to_contact"],
    testLevels: ["n2"],
    docAnchor: `${DOC}#6-patrones-n2-escenarios-guiados-abc`,
  },
  {
    id: "n2_request_documents",
    layer: "test_n2",
    label: "N2 solicitud documentos (paso 2)",
    description: "Telegram A→B + list_documents N1 + notify opcional + N3 skill.",
    implementationPaths: [
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
    ],
    appliesToSkills: ["request-property-documents"],
    appliesToTools: [
      "telegram_send_message_to_contact",
      "operational_case_list_documents",
      "notify_user",
    ],
    testLevels: ["n1", "n2", "n3"],
    docAnchor: `${DOC}#paso-2--awaiting_documents`,
  },
  {
    id: "n2_characteristics_telegram_abc",
    layer: "test_n2",
    label: "N2 características Telegram",
    description: "characteristics_pending: A validar, B enviar, C simular.",
    implementationPaths: [
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
    ],
    appliesToSkills: ["extract-property-characteristics"],
    appliesToTools: ["telegram_send_message_to_contact"],
    testLevels: ["n2"],
    docAnchor: `${DOC}#paso-3--documents_received`,
  },
  {
    id: "n2_easybroker_ab",
    layer: "test_n2",
    label: "N2 EasyBroker A→B",
    description: "easybroker_create_listing luego upload_images al listing_id.",
    implementationPaths: [
      "apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx",
      "apps/web/src/app/api/tool-readiness/run-tool/route.ts",
    ],
    appliesToSkills: ["publish-listing-package"],
    appliesToTools: ["easybroker_create_listing", "easybroker_upload_images"],
    testLevels: ["n2"],
    docAnchor: `${DOC}#n2_easybroker_ab`,
  },
  {
    id: "n1_single",
    layer: "test_n2",
    label: "N1 tool individual",
    description: "Una tool sin wizard A/B/C en su tarjeta.",
    implementationPaths: [
      "apps/web/src/app/api/tool-readiness/run-tool/route.ts",
    ],
    testLevels: ["n1"],
    docAnchor: `${DOC}#6-patrones-n2-escenarios-guiados-abc`,
  },
];

/** Piloto property_optioning — mapeo paso → patrones recomendados */
export const PROPERTY_OPTIONING_STEP_PATTERNS: Record<
  string,
  {
    stepKey: string;
    n3Skills?: string[];
    n4ScenarioIds?: string[];
    patternIds: string[];
  }
> = {
  awaiting_documents: {
    stepKey: "awaiting_documents",
    n3Skills: ["request-property-documents"],
    n4ScenarioIds: [
      "awaiting_documents_internal_upload",
      "awaiting_documents_outreach",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_BRANCH_DECISION",
      "n2_request_documents",
      "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
      "PATTERN_SKILL_TEST_CONTRACT",
      "PATTERN_SKILL_TEST_PROMPT_GUARDRAILS",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_STEP_STATUS_N3_VS_N4",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
    ],
  },
  documents_received: {
    stepKey: "documents_received",
    n3Skills: ["extract-property-characteristics"],
    n4ScenarioIds: [
      "documents_received_property_data_review",
      "documents_received_characteristics_pending",
      "documents_received_characteristics_pending_internal",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_BRANCH_DECISION",
      "n2_characteristics_telegram_abc",
      "PATTERN_SKILL_TEST_CONTRACT",
      "PATTERN_NOTIFY_USER_CHANNELS",
      "PATTERN_NOTIFY_DELIVERY_WARNING",
      "PATTERN_SETTINGS_TEST_SEED_AND_REPAIR",
      "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_SKILL_TEST_PROMPT_GUARDRAILS",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
    ],
  },
  price_proposal_pending: {
    stepKey: "price_proposal_pending",
    n3Skills: ["prepare-listing-price"],
    n4ScenarioIds: [
      "price_proposal_pending_hitl",
      "price_proposal_pending_advisor_approves",
      "price_proposal_pending_advisor_adjusts",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
      "PATTERN_SKILL_TEST_CONTRACT",
      "PATTERN_SETTINGS_TEST_SEED_AND_REPAIR",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_STEP_TEST_BUSINESS_DECISION",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
    ],
  },
  comparables_in_progress: {
    stepKey: "comparables_in_progress",
    n3Skills: ["perform-comparable-analysis"],
    n4ScenarioIds: [
      "comparables_in_progress_complete",
      "comparables_in_progress_insufficient_data",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_BRANCH_DECISION",
      "PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT",
      "PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE",
      "PATTERN_DETERMINISTIC_ARTIFACT_FROM_TOOL_RESULTS",
      "PATTERN_OPERATIONAL_WRITE_GATE",
      "n1_single",
      "PATTERN_SKILL_TEST_CONTRACT",
      "PATTERN_SETTINGS_TEST_SEED_AND_REPAIR",
      "PATTERN_CASE_UPDATE_STATE_OPTIMISTIC_RETRY",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_SKILL_TEST_PROMPT_GUARDRAILS",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
    ],
  },
  contract_pending: {
    stepKey: "contract_pending",
    n3Skills: ["prepare-commission-contract"],
    n4ScenarioIds: [
      "contract_pending_draft_review",
      "contract_pending_template_missing",
      "contract_pending_advisor_approves_send",
      "contract_pending_advisor_requests_changes",
      "contract_pending_owner_signed",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
      "PATTERN_TOOL_AUDIT_SINGLE_OWNER",
      "PATTERN_GENERATED_DOCUMENT_DEDUP",
      "PATTERN_GENERATED_CASE_DOCUMENT_ACCESS",
      "PATTERN_BUSINESS_DECISION_CONTRACT_REVIEW",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_STEP_TEST_BUSINESS_DECISION",
      "PATTERN_NOTIFY_USER_CHANNELS",
      "PATTERN_SKILL_TEST_CONTRACT",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
    ],
  },
  photos_requested: {
    stepKey: "photos_requested",
    n3Skills: ["request-property-photos"],
    n4ScenarioIds: ["photos_requested_request_internal_photos"],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
      "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
    ],
  },
  package_ready: {
    stepKey: "package_ready",
    n3Skills: ["publish-listing-package"],
    n4ScenarioIds: [
      "package_ready_preflight_blocked",
      "package_ready_description_review_requested",
      "package_ready_description_approved",
      "package_ready_easybroker_approval_requested",
      "package_ready_easybroker_published",
      "package_ready_completed_summary_sent",
    ],
    patternIds: [
      "PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS",
      "PATTERN_STEP_STATUS_N3_VS_N4",
      "PATTERN_STEP_TEST_SCENARIO",
      "PATTERN_SKILL_TEST_CALL_DETAILS",
    ],
  },
};

const patternById = new Map(
  OPERATIONAL_TEST_PATTERNS.map((entry) => [entry.id, entry])
);

export function getTestPatternById(id: string): TestPatternEntry | undefined {
  return patternById.get(id);
}

export function testPatternsForStep(
  caseTypeSlug: string,
  stepKey: string
): TestPatternEntry[] {
  if (caseTypeSlug !== "property_optioning") return [];
  const mapping = PROPERTY_OPTIONING_STEP_PATTERNS[stepKey];
  if (!mapping) return [];
  return mapping.patternIds
    .map((id) => patternById.get(id))
    .filter((entry): entry is TestPatternEntry => Boolean(entry));
}
