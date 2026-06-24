import type { StepTestScenarioUiCopy } from "./step-test-ui-copy";

export type StepTestExecutionMode = "agent" | "business_decision";

export type StepTestSeed = {
  current_step?: string;
  status?: string;
  context_patch?: Record<string, unknown>;
};

export type StepTestExpect = {
  current_step?: string;
  status?: string;
  expected_events?: string[];
  expected_context_keys?: string[];
  expected_tool_calls?: string[];
};

export type StepTestScenarioDef = {
  id: string;
  label: string;
  summary?: string;
  seed_summary?: string;
  expect_summary?: string;
  seed?: StepTestSeed;
  expect: StepTestExpect;
  message: string;
  execution?: StepTestExecutionMode;
  business_decision_kind?: string;
  decision_text?: string;
  ui?: StepTestScenarioUiCopy;
  /**
   * Si es false, el escenario sigue visible y ejecutable pero no cuenta para
   * «Paso probado» ni para X de Y en el acordeón (prueba guardrail opcional).
   */
  counts_toward_step_milestone?: boolean;
};

export type StepTestScenarioMeta = Omit<
  StepTestScenarioDef,
  "seed" | "expect" | "message" | "decision_text"
>;

export type StepTestScenarioCatalog = Record<
  string,
  Record<string, StepTestScenarioDef[]>
>;

export const STEP_TEST_SCENARIO_CATALOG: StepTestScenarioCatalog = {
  property_optioning: {
    awaiting_documents: [
      {
        id: "awaiting_documents_outreach",
        label: "Solicitud inicial vía habilidad raíz",
        summary:
          "Caso en awaiting_documents: la raíz solicita documentos y deja el caso esperando al contacto externo.",
        seed_summary: "Entrada: awaiting_documents / active.",
        expect_summary: "Salida: awaiting_documents / waiting_external.",
        seed: { current_step: "awaiting_documents", status: "active" },
        expect: {
          current_step: "awaiting_documents",
          status: "waiting_external",
          expected_events: ["reminder_sent"],
        },
        message:
          "Prueba controlada de paso (N4) para awaiting_documents. Actúa como la habilidad raíz del caso operacional. Si el contacto externo aún no tiene la solicitud de documentos, envíala por el canal configurado (escritura, predial, identificación, comprobante de domicilio, boleta registral, etc.), registra reminder_sent y deja status=waiting_external. No pidas dormitorios, baños ni estacionamiento (eso corresponde al paso documents_received / extract-property-characteristics). No avances current_step a documents_received en esta prueba. Invoca telegram_send_message_to_contact como máximo una vez en este tick; no repitas el mismo mensaje al contacto externo.",
      },
    ],
    documents_received: [
      {
        id: "documents_received_property_data_review",
        label: "Extracción y revisión interna",
        summary:
          "Documentos recibidos con datos suficientes: la raíz estructura property_data y pide revisión interna.",
        seed_summary: "Entrada: documents_received / active.",
        expect_summary: "Salida: property_data_review / waiting_internal.",
        seed: { current_step: "documents_received", status: "active" },
        expect: {
          current_step: "property_data_review",
          status: "waiting_internal",
          expected_context_keys: ["property_data"],
          expected_events: ["step_completed"],
          expected_tool_calls: ["operational_case_list_documents", "notify_user"],
        },
        message:
          "Prueba controlada de paso (N4) para documents_received. Actúa como la habilidad raíz del caso operacional. Debes enrutar al paso de extracción de características, consultar documentos del caso y estructurar property_data. Si los datos críticos quedan completos, solicita revisión interna con notify_user(kind='property_data_review') y deja status=waiting_internal/current_step=property_data_review. Si faltan datos críticos, pregunta únicamente esos faltantes al contacto externo con telegram_send_message_to_contact(purpose='characteristics_pending') y deja status=waiting_external/current_step=documents_received; en ese caso esta prueba debe evidenciar el bloqueo por faltantes.",
      },
      {
        id: "documents_received_characteristics_pending",
        label: "Faltantes críticos al contacto",
        summary:
          "Documentos recibidos con datos críticos faltantes: la raíz pregunta sólo faltantes al contacto externo.",
        seed_summary: "Entrada: documents_received / active con property_data incompleto.",
        expect_summary: "Salida: documents_received / waiting_external.",
        seed: {
          current_step: "documents_received",
          status: "active",
          context_patch: {
            property_data: {
              operation: "rent",
              property_type: "departamento",
              area_total_m2: 116.93,
              address: {
                street: "Privada del Tulipán",
                exterior_number: "1501",
                neighborhood: "Sendas Residencial G1",
                city: "Zapopan",
                state: "Jalisco",
                country: "MX",
                postal_code: "45050",
              },
              missing_critical_fields: ["bedrooms", "bathrooms", "parking_spots"],
            },
          },
        },
        expect: {
          current_step: "documents_received",
          status: "waiting_external",
          expected_context_keys: ["property_data"],
          expected_events: ["reminder_sent"],
          expected_tool_calls: [
            "operational_case_list_documents",
            "telegram_send_message_to_contact",
          ],
        },
        message:
          "Prueba controlada de paso (N4) para documents_received, escenario de faltantes críticos. Actúa como la habilidad raíz del caso operacional. El context_jsonb.property_data sembrado está incompleto a propósito: faltan bedrooms, bathrooms y parking_spots. Debes consultar documentos del caso para confirmar fuentes disponibles, NO solicites revisión interna todavía y NO avances a property_data_review. Pregunta únicamente esos faltantes al contacto externo con telegram_send_message_to_contact(purpose='characteristics_pending') y deja status=waiting_external/current_step=documents_received.",
      },
    ],
    comparables_in_progress: [
      {
        id: "comparables_in_progress_complete",
        label: "Análisis completo y avance a precio",
        summary:
          "Caso en comparables_in_progress con property_data alineado a la zona del caso: la raíz ejecuta perform-comparable-analysis, persiste comparables_analysis defendible y avanza a price_proposal_pending.",
        seed_summary:
          "Entrada: comparables_in_progress / active; property_data resuelto desde property_zone del caso.",
        expect_summary:
          "Salida: price_proposal_pending / active con comparables usables > 0.",
        seed: {
          current_step: "comparables_in_progress",
          status: "active",
          context_patch: { skill_test_n4_seed: "comparables_in_progress_complete" },
        },
        expect: {
          current_step: "price_proposal_pending",
          status: "active",
          expected_context_keys: ["property_data", "comparables_analysis"],
        },
        message:
          "Prueba controlada de paso (N4) para comparables_in_progress — escenario con muestra defendible. Actúa como property-optioning-coach. Usa la zona efectiva del caso (property_zone del contexto de prueba); alinea property_data.address.neighborhood con esa zona. Enruta a perform-comparable-analysis y consulta easybroker_search_listings, easybroker_search_closed_deals y bigquery_lookup_local_comparables. Si el tipo es casa/departamento en condominio, agrega get_avaclick_valuation como fuente complementaria; si faltan coordenadas pero hay dirección suficiente, usa geocode_property_address antes de Avaclick. Si una fuente devuelve not_configured, missing_required_fields o vacío, continúa con las demás y documenta la limitación. Si la suma de comparables USABLES (activas + históricas + internas) es mayor que cero: guarda comparables_analysis con stats defendibles, avanza a price_proposal_pending y status=active, y notify_user al asesor. No uses telegram_send_message_to_contact.",
      },
      {
        id: "comparables_in_progress_insufficient_data",
        label: "Sin comparables usables — no avanzar a precio",
        summary:
          "Filtros muy estrechos (~8 m²): si todas las fuentes devuelven 0 usables, el caso permanece en comparables_in_progress y el asesor recibe notify_user.",
        seed_summary:
          "Entrada: comparables_in_progress / active con property_data restrictivo.",
        expect_summary:
          "Salida: comparables_in_progress / waiting_internal + notify_user.",
        seed: {
          current_step: "comparables_in_progress",
          status: "active",
          context_patch: {
            skill_test_n4_seed: "comparables_in_progress_insufficient_data",
          },
        },
        expect: {
          current_step: "comparables_in_progress",
          status: "waiting_internal",
          expected_context_keys: ["property_data", "comparables_analysis"],
          expected_tool_calls: ["notify_user"],
        },
        message:
          "Prueba controlada de paso (N4) para comparables_in_progress — escenario datos insuficientes. Actúa como property-optioning-coach. El property_data sembrado usa ~8 m² a propósito (filtros muy estrechos). Consulta las tres fuentes base (EasyBroker activas, EasyBroker cerradas, BigQuery interno) y, si aplica por tipo de propiedad, get_avaclick_valuation como complemento. Si Avaclick devuelve validation_error con missing_required_fields, registra warning y continúa; no bloquees el paso por eso. Si tras normalizar la suma de comparables USABLES es 0 en todas las fuentes: NO avances a price_proposal_pending; deja current_step=comparables_in_progress y status=waiting_internal; persiste comparables_analysis con filters_used, data_quality.warnings y usable_count=0; ejecuta notify_user(kind=comparables_insufficient_data) al asesor con datos de la propiedad, filtros usados y sugerencias concretas para ampliar búsqueda. No uses telegram_send_message_to_contact.",
      },
    ],
    price_proposal_pending: [
      {
        id: "price_proposal_pending_hitl",
        label: "Propuesta de precio y aprobación HITL",
        summary:
          "Caso en price_proposal_pending con comparables defendibles: la raíz enruta a prepare-listing-price, persiste pricing_proposal y solicita aprobación al asesor.",
        seed_summary:
          "Entrada: price_proposal_pending / active; comparables_analysis y property_data sembrados si faltan.",
        expect_summary:
          "Salida: price_proposal_pending / waiting_internal con pricing_proposal pending y notify_user.",
        seed: {
          current_step: "price_proposal_pending",
          status: "active",
          context_patch: { skill_test_n4_seed: "price_proposal_pending_hitl" },
        },
        expect: {
          current_step: "price_proposal_pending",
          status: "waiting_internal",
          expected_context_keys: [
            "property_data",
            "comparables_analysis",
            "pricing_proposal",
          ],
          expected_events: ["human_decision:price_proposed"],
          expected_tool_calls: ["notify_user"],
        },
        message:
          "Prueba controlada de paso (N4) para price_proposal_pending. Actúa como property-optioning-coach. Enruta a prepare-listing-price. Usa context_jsonb.comparables_analysis.stats (precio total o precio/m²) para calcular salida, ideal y mínimo con números concretos (sin placeholders ni ceros). Persiste pricing_proposal con approval_status=pending, rationale y comparables_used. Ejecuta notify_user(kind=price_approval) al asesor interno. Inserta operational_case_add_event human_decision con kind=price_proposed. Deja current_step=price_proposal_pending y status=waiting_internal. NO marques approved ni avances a contract_pending. NO uses telegram_send_message_to_contact.",
      },
      {
        id: "price_proposal_pending_advisor_approves",
        label: "Asesor aprueba precio (HITL)",
        execution: "business_decision",
        business_decision_kind: "price_approval",
        summary:
          "Tras propuesta pendiente, simula la decisión del asesor (mismo handler que Telegram/inbox) y avanza a contrato en caso de prueba.",
        seed_summary:
          "Entrada: price_proposal_pending / waiting_internal con pricing_proposal pending.",
        expect_summary:
          "Salida: contract_pending / paused con pricing_proposal approved y evento price_approved.",
        seed: {
          current_step: "price_proposal_pending",
          status: "waiting_internal",
          context_patch: {
            skill_test_n4_seed: "price_proposal_pending_advisor_approves",
          },
        },
        expect: {
          current_step: "contract_pending",
          status: "paused",
          expected_context_keys: [
            "property_data",
            "comparables_analysis",
            "pricing_proposal",
          ],
          expected_events: ["human_decision:price_approved"],
        },
        message:
          "Escenario N4 de cierre HITL: el asesor aprueba la propuesta pendiente vía handler de negocio (no tick del agente).",
        decision_text: "aprobar precio",
      },
      {
        id: "price_proposal_pending_advisor_adjusts",
        label: "Asesor ajusta y aprueba precio",
        execution: "business_decision",
        business_decision_kind: "price_approval",
        summary:
          "Simula ajuste con montos concretos y cierre HITL en un paso (producto actual: ajustar-y-aprobar).",
        seed_summary:
          "Entrada: propuesta pending (salida 25200 / ideal 24000 / mínimo 21000).",
        expect_summary:
          "Salida: contract_pending / paused con salida=26000, ideal=25000, minimo=20000 y price_adjusted_and_approved.",
        ui: {
          success_summary:
            "La decisión HITL aplicó el ajuste y aprobó el precio; el caso quedó en el estado esperado.",
        },
        seed: {
          current_step: "price_proposal_pending",
          status: "waiting_internal",
          context_patch: {
            skill_test_n4_seed: "price_proposal_pending_advisor_adjusts",
          },
        },
        expect: {
          current_step: "contract_pending",
          status: "paused",
          expected_context_keys: [
            "property_data",
            "comparables_analysis",
            "pricing_proposal",
          ],
          expected_events: ["human_decision:price_adjusted_and_approved"],
        },
        message:
          "Escenario N4 de cierre HITL: el asesor ajusta montos y aprueba en un paso vía handler de negocio.",
        decision_text: "AJUSTAR PRECIO salida=26000 ideal=25000 minimo=20000",
      },
    ],
    contract_pending: [
      {
        id: "contract_pending_template_missing",
        label: "Plantilla ausente o inválida (guardrail)",
        counts_toward_step_milestone: false,
        summary:
          "Opcional: sin plantilla DOCX en la cuenta el agente pausa y avisa sin inventar borrador.",
        seed_summary:
          "Entrada: contract_pending / active. Elimina o reemplaza commission_contract_template en Paso 5 antes de correr.",
        expect_summary:
          "Salida B: paused + notify_user (sin botones HITL); sin generate_document renderizado ni contract_drafted.",
        seed: {
          current_step: "contract_pending",
          status: "active",
          context_patch: { skill_test_n4_seed: "contract_pending_template_missing" },
        },
        expect: {
          current_step: "contract_pending",
          expected_context_keys: ["property_data", "pricing_proposal"],
          expected_tool_calls: ["notify_user"],
        },
        message:
          "Prueba guardrail (N4) para contract_pending — plantilla faltante (Salida B). Actúa como property-optioning-coach. Intenta generate_document_from_template una vez; si devuelve not_configured o failed, notify_user al asesor (NO uses kind=contract_review: usa kind=contract_template_missing o sin kind HITL) explicando que falta la plantilla DOCX commission_contract_template en la cuenta y deja status=paused. NO insertes contract_drafted ni pidas revisión de un borrador inexistente. NO uses herramientas de otros pasos.",
      },
      {
        id: "contract_pending_draft_review",
        label: "Borrador de contrato para revisión",
        summary:
          "Caso en contract_pending con precio aprobado: la raíz enruta a prepare-commission-contract y solicita revisión interna del borrador.",
        seed_summary:
          "Entrada: contract_pending / active; pricing_proposal.approval_status=approved.",
        expect_summary:
          "Salida A (requiere plantilla DOCX en cuenta): waiting_internal + generate_document renderizado + contract_draft.output_path + contract_drafted + notify_user(kind=contract_review) con enlace corto de descarga.",
        seed: {
          current_step: "contract_pending",
          status: "active",
          context_patch: { skill_test_n4_seed: "contract_pending_draft_review" },
        },
        expect: {
          current_step: "contract_pending",
          status: "waiting_internal",
          expected_context_keys: ["property_data", "pricing_proposal", "contract_draft"],
          expected_tool_calls: ["generate_document_from_template", "notify_user"],
        },
        message:
          "Prueba controlada de paso (N4) para contract_pending — borrador real (Salida A). Actúa como property-optioning-coach. En este tick SOLO el flujo de contrato: enruta a prepare-commission-contract y usa únicamente generate_document_from_template y notify_user (no uses ungga_publish_listing, easybroker_*, image_watermark ni herramientas de package_ready). Verifica pricing_proposal.approval_status=approved. Llama generate_document_from_template(template_slug=commission_contract, format=docx, case_id=...) exactamente una vez; los placeholders del DOCX se rellenan desde el caso (no hace falta pasar data). Debe devolver status=rendered con output_path. NO uses la signed_url larga de Supabase en el mensaje: en notify_user(kind=contract_review) escribe «Descargar borrador del contrato» seguido del enlace estable /api/operational-cases/{case_id}/documents/contract_draft/download (URL completa con el dominio del sitio si lo conoces). Inserta human_decision kind=contract_drafted con ese mismo enlace corto. Deja current_step=contract_pending y status=waiting_internal. NO mandes el contrato al dueño por Telegram en este tick. NO avances a photos_scheduled.",
      },
      {
        id: "contract_pending_advisor_approves_send",
        label: "Asesor aprueba envío al dueño",
        execution: "business_decision",
        business_decision_kind: "contract_review",
        summary:
          "Tras borrador en revisión, el asesor autoriza enviar el contrato al dueño (mismo handler que Telegram/inbox).",
        seed_summary:
          "Entrada: contract_pending / waiting_internal; requiere contract_draft.output_path del escenario «Borrador de contrato para revisión».",
        expect_summary:
          "Salida: contract_pending / paused (caso de prueba) con eventos de aprobación y envío al dueño.",
        seed: {
          current_step: "contract_pending",
          status: "waiting_internal",
          context_patch: {
            skill_test_n4_seed: "contract_pending_advisor_approves_send",
          },
        },
        expect: {
          current_step: "contract_pending",
          status: "paused",
          expected_events: [
            "human_decision:contract_approved_for_owner",
            "reminder_sent",
          ],
        },
        message:
          "Escenario N4 HITL: el asesor aprueba enviar el borrador al dueño.",
        decision_text: "mándalo al dueño",
      },
      {
        id: "contract_pending_advisor_requests_changes",
        label: "Asesor pide cambios al borrador",
        execution: "business_decision",
        business_decision_kind: "contract_review",
        summary:
          "El asesor indica que el borrador necesita ajustes antes de contactar al dueño.",
        seed_summary:
          "Entrada: contract_pending / waiting_internal; requiere borrador real previo (output_path).",
        expect_summary:
          "Salida: contract_pending / waiting_internal con contract_changes_requested.",
        seed: {
          current_step: "contract_pending",
          status: "waiting_internal",
          context_patch: {
            skill_test_n4_seed: "contract_pending_advisor_requests_changes",
          },
        },
        expect: {
          current_step: "contract_pending",
          status: "waiting_internal",
          expected_events: ["human_decision:contract_changes_requested"],
        },
        message:
          "Escenario N4 HITL: el asesor pide cambios al borrador antes de enviarlo al dueño.",
        decision_text: "necesita cambios en la cláusula de comisión",
      },
      {
        id: "contract_pending_owner_signed",
        label: "Dueño devuelve contrato firmado",
        execution: "business_decision",
        business_decision_kind: "contract_owner_signed",
        summary:
          "Simula la firma del dueño y el avance a coordinación de fotos (laboratorio N4).",
        seed_summary:
          "Entrada: contract_pending tras envío al dueño (waiting_external o paused en prueba).",
        expect_summary:
          "Salida: photos_scheduled / paused con step_completed kind=contract_signed.",
        seed: {
          current_step: "contract_pending",
          status: "paused",
          context_patch: {
            skill_test_n4_seed: "contract_pending_owner_signed",
            contract_review: { status: "approved_for_owner" },
          },
        },
        expect: {
          current_step: "photos_scheduled",
          status: "paused",
          expected_events: ["step_completed:contract_signed"],
        },
        message:
          "Escenario N4 HITL: simula que el dueño devolvió el contrato firmado.",
        decision_text: "contrato firmado file_id=test_signed_contract.pdf",
      },
    ],
    photos_scheduled: [
      {
        id: "photos_scheduled_propose_slots",
        label: "Proponer horarios de fotos al dueño",
        summary:
          "Caso en photos_scheduled: la raíz revisa calendario, propone ventanas al contacto externo y deja el caso esperando respuesta.",
        seed_summary: "Entrada: photos_scheduled / active con property_data.",
        expect_summary:
          "Salida: photos_scheduled / waiting_external con telegram_send_message_to_contact.",
        seed: {
          current_step: "photos_scheduled",
          status: "active",
          context_patch: { skill_test_n4_seed: "photos_scheduled_propose_slots" },
        },
        expect: {
          current_step: "photos_scheduled",
          status: "waiting_external",
          expected_context_keys: ["property_data"],
          expected_events: ["reminder_sent"],
          expected_tool_calls: ["telegram_send_message_to_contact"],
        },
        message:
          "Prueba controlada de paso (N4) para photos_scheduled — proponer horarios. Actúa como property-optioning-coach. Enruta a coordinate-photo-session. Consulta calendar_list_events para disponibilidad y propone 3 ventanas diurnas al contacto externo con telegram_send_message_to_contact(purpose=propose_photo_slots). Inserta reminder_sent con purpose=propose_photo_slots. Deja status=waiting_external y current_step=photos_scheduled. NO crees calendar_create_event antes de confirmación del dueño. Invoca telegram_send_message_to_contact como máximo una vez en este tick.",
      },
    ],
    package_ready: [
      {
        id: "package_ready_preflight_blocked",
        label: "Preflight incompleto — no publicar",
        summary:
          "Caso en package_ready sin fotos crudas suficientes: la raíz debe bloquear publicación y avisar al asesor qué falta.",
        seed_summary:
          "Entrada: package_ready / active; precio aprobado pero raw_photos vacío.",
        expect_summary:
          "Salida: package_ready / paused con notify_user explicando faltantes.",
        seed: {
          current_step: "package_ready",
          status: "active",
          context_patch: { skill_test_n4_seed: "package_ready_preflight_blocked" },
        },
        expect: {
          current_step: "package_ready",
          status: "paused",
          expected_context_keys: ["property_data", "pricing_proposal"],
          expected_tool_calls: ["notify_user"],
        },
        message:
          "Prueba controlada de paso (N4) para package_ready — preflight bloqueado. Actúa como property-optioning-coach. Enruta a publish-listing-package. El contexto sembrado tiene raw_photos vacío o insuficiente: NO publiques en EasyBroker ni Ungga. notify_user al asesor listando qué falta (fotos crudas, contrato firmado en timeline si aplica). Deja current_step=package_ready y status=paused.",
      },
    ],
  },
};

export const DEFAULT_STEP_TEST_CATALOG_SLUG_BY_ROOT_SKILL: Record<string, string> = {
  "property-optioning-coach": "property_optioning",
};

export function stepTestCatalogSlugForRootSkill(
  rootSkillSlug: string | null | undefined
): string | null {
  return rootSkillSlug
    ? DEFAULT_STEP_TEST_CATALOG_SLUG_BY_ROOT_SKILL[rootSkillSlug] ?? null
    : null;
}

export function stepTestScenariosFor(
  catalogSlug: string,
  stepKey: string
): StepTestScenarioDef[] {
  return STEP_TEST_SCENARIO_CATALOG[catalogSlug]?.[stepKey] ?? [];
}

/** Escenarios que cuentan para el hito «Paso probado» (excluye guardrails opcionales). */
export function stepTestMilestoneScenariosFor(
  catalogSlug: string,
  stepKey: string
): StepTestScenarioDef[] {
  return stepTestScenariosFor(catalogSlug, stepKey).filter(
    (scenario) => scenario.counts_toward_step_milestone !== false
  );
}

export function stepTestScenarioCountsTowardMilestone(
  scenario: Pick<StepTestScenarioDef, "counts_toward_step_milestone">
): boolean {
  return scenario.counts_toward_step_milestone !== false;
}

export function stepTestScenarioMetasFor(
  catalogSlug: string,
  stepKey: string
): StepTestScenarioMeta[] {
  return stepTestScenariosFor(catalogSlug, stepKey).map((scenario) => ({
    id: scenario.id,
    label: scenario.label,
    summary: scenario.summary,
    seed_summary: scenario.seed_summary,
    expect_summary: scenario.expect_summary,
    execution: scenario.execution,
    business_decision_kind: scenario.business_decision_kind,
    ui: scenario.ui,
    counts_toward_step_milestone: scenario.counts_toward_step_milestone,
  }));
}

export function stepTestAvailable(catalogSlug: string, stepKey: string) {
  return stepTestScenariosFor(catalogSlug, stepKey).length > 0;
}
