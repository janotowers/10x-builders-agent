import { runAgent } from "@agents/agent";
import {
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getProfile,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  getOrCreateSession,
  insertOperationalCaseEvent,
  markCaseProcessing,
  updateOperationalCase,
} from "@agents/db";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
  type OperationalCase,
  type PendingConfirmation,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";

export function isSettingsTestCase(opCase: OperationalCase): boolean {
  return isSettingsOperationalTestCase(opCase);
}

function buildCaseE2ETickMessage(
  opCase: OperationalCase,
  options?: { ownerResponseText?: string }
): string {
  if (options?.ownerResponseText?.trim()) {
    return [
      `Procesa la respuesta reciente del dueño en el caso ${opCase.id}.`,
      `Estado actual: status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}.`,
      "Acción esperada: sub-skill extract-property-characteristics mientras el caso esté en documents_received.",
      "Integra el evento external_response reciente en context_jsonb.property_data.",
      "No avances a comparables, precio, contrato ni publicación en este tick.",
      "Antes de extraer, llama operational_case_list_documents y usa únicamente IDs UUID reales devueltos ahí; nunca uses placeholders como <document_id>.",
      "Antes de preguntar faltantes, consolida lo extraído de documentos de propiedad (escritura, predial, boleta): titulares, dirección legal y superficie/metraje. No uses dirección de IFE/comprobante como dirección del inmueble salvo que esté marcada como propiedad.",
      "Si faltan campos mínimos, prepara preguntas al dueño (purpose=characteristics_pending). Mínimos comunes: dueño/titulares, dirección y superficie/metraje. Por tipo: casa requiere construcción m2, plantas, recámaras, baños completos, medios baños y cocina integral; departamento requiere recámaras, baños completos, medios baños, cajones, piso, elevador y amenidades; terreno requiere metraje y si está en coto/condominio/parque industrial o es independiente; bodega/nave requiere m2 de bodega, altura, oficinas si aplica, baños, cajones, KVA y transformador. Para terrenos/lotes no preguntes recámaras, baños ni estacionamientos salvo que exista construcción.",
      "Al mezclar datos, conserva como canónicos los campos del intake ya confirmado (property_title, property_zone, operation_type, property_type). Los documentos pueden aportar dirección legal, superficie, folio, titular, medidas y colindancias, pero no deben reemplazar property_type='Terreno' por etiquetas notariales como 'Unidad Privativa' salvo que pidas confirmación explícita como posible conflicto.",
      "Si los mínimos están completos, solicita revisión interna con notify_user(kind=property_data_review). En ese mensaje separa claramente: datos confirmados por intake; datos encontrados en documentos; faltantes/advertencias/conflictos. No pongas tipo/operación/zona como datos extraídos si solo vienen del intake. No combines zona y dirección bajo un solo campo. Para terrenos/lotes muestra recámaras/baños/estacionamientos como 'No aplica' salvo que exista construcción.",
    ].join(" ");
  }
  const settingsTestCase = isSettingsOperationalTestCase(opCase);
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);
  const externalChatId =
    opCase.external_contact_jsonb?.channel === "telegram" &&
    typeof opCase.external_contact_jsonb.chat_id === "number"
      ? opCase.external_contact_jsonb.chat_id
      : null;
  return [
    `Tick E2E controlado para el caso ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    settingsTestCase || controlledE2ECase
      ? "Ejecuta la siguiente acción según la skill del caso de prueba. En este tick de prueba controlada las tools operativas y Telegram al contacto están pre-autorizadas (sin HITL)."
      : "Ejecuta la siguiente acción según la skill del caso. Este tick reemplaza al cron para un recorrido E2E controlado; los mensajes entrantes por Telegram siguen siendo parte del flujo real.",
    externalChatId
      ? `Contacto externo Telegram del caso: usa exactamente chat_id=${externalChatId} al llamar telegram_send_message_to_contact.`
      : "",
    opCase.current_step === "awaiting_documents"
      ? [
          "Acción esperada para este paso: usa request-property-documents, envía el mensaje inicial de solicitud de documentos al contacto por Telegram, registra reminder_sent con purpose=initial_request y deja el caso en waiting_external / awaiting_documents.",
          "El mensaje inicial DEBE enumerar documentos específicos, no uses una frase genérica. Incluye estos bullets:",
          "• Escritura: primera hoja o sección donde esté la descripción de la propiedad, y última hoja si la tiene a la mano (indispensable para avanzar)",
          "• Último recibo de predial",
          "• Identificación oficial (anverso y reverso)",
          "• Comprobante de domicilio (≤ 3 meses)",
          "• Boleta registral",
          "Incluye una frase breve de privacidad: solo se usan para verificar la propiedad y armar el contrato; no se comparten sin autorización.",
          "No avances a documents_received, comparables, precio ni contrato sin external_response.",
        ].join(" ")
      : "",
    opCase.current_step === "comparables_in_progress"
      ? [
          "Acción esperada para este paso: usa perform-comparable-analysis.",
          "No regreses a awaiting_documents ni documents_received.",
          "Consulta comparables con easybroker_search_listings, easybroker_search_closed_deals y bigquery_lookup_local_comparables usando property_zone/property_data como filtros. Si el tipo es casa/departamento en condominio, incluye get_avaclick_valuation como fuente complementaria.",
          "Si faltan coordenadas para Avaclick y la dirección es suficiente, intenta geocode_property_address antes de valorar. Si Avaclick devuelve missing_required_fields, continúa con las otras fuentes y deja warning en comparables_analysis.",
          "Después llama operational_case_persist_comparables_analysis; no escribas comparables_analysis manualmente.",
          "Si hay muestra defendible, avanza a price_proposal_pending con status=active y notifica al asesor. Si no hay comparables usables, permanece en comparables_in_progress con status=waiting_internal y notifica al asesor con sugerencias para ampliar criterios.",
        ].join(" ")
      : "",
  ].join(" ");
}

export type SettingsTestCaseTickResult = {
  case: OperationalCase;
  pending_confirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
  response_preview: string | null;
};

/**
 * Un tick del agente sobre un caso de prueba creado desde Settings.
 * Usado por la API de pruebas y por el webhook de Telegram cuando el
 * contacto externo responde (el cron no procesa estos casos).
 */
export async function runSettingsTestCaseAgentTick(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  userId: string,
  options?: {
    source?: string;
    skipLock?: boolean;
    ownerResponseText?: string;
  }
): Promise<SettingsTestCaseTickResult> {
  ensureAgentToolDepsWired();

  if (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    return {
      case: opCase,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview:
        "Skipped: conversational intake is incomplete; continue collecting fields in Telegram.",
    };
  }

  if (!options?.skipLock) {
    const locked = await markCaseProcessing(db, opCase.id, opCase.version, 1);
    if (!locked) {
      throw new Error("case_busy");
    }
  }

  const fresh = await getOperationalCase(db, opCase.id);
  if (!fresh) {
    throw new Error("case_not_found");
  }

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_e2e_started",
      source: options?.source ?? "settings_test_case_tick",
      current_step: fresh.current_step ?? null,
      status: fresh.status,
      note: "Transición con agente sobre caso de prueba (tools reales, pre-autorizadas en Settings).",
    },
  });

  const profile = await getProfile(db, userId);
  const toolSettings = await getUserToolSettings(db, userId);
  const skillSettings = await getUserSkillSettings(db, userId);
  const integrations = await getUserIntegrations(db, userId);

  const githubIntegration = integrations.find((i) => i.provider === "github");
  let githubToken: string | undefined;
  if (githubIntegration) {
    const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
      .encrypted_tokens;
    if (raw) {
      try {
        githubToken = decryptToken(raw);
      } catch {
        /* sin token GitHub */
      }
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;
  const session = await getOrCreateSession(db, userId, "case_runner");
  const controlledE2ECase = isControlledE2EOperationalCase(fresh);
  const settingsTestCase = isSettingsOperationalTestCase(fresh);

  const agentResult = await runAgent({
    message: buildCaseE2ETickMessage(fresh, {
      ownerResponseText: options?.ownerResponseText,
    }),
    userId,
    sessionId: session.id,
    systemPrompt: profile.agent_system_prompt,
    db,
    enabledTools: toolSettings,
    enabledSkills: skillSettings,
    integrations,
    githubToken,
    userTimezone: profile.timezone,
    userName: profile.name,
    userEmail: profile.email,
    userPhone: profile.phone,
    businessBrain: profile.business_brain ?? {},
    isUnggaAdmin: profile.is_ungga_admin ?? false,
    channel: "case_runner",
    googleCalendarAccessToken,
    autoApproveTools: false,
    toolApprovalPolicy: settingsTestCase || controlledE2ECase
      ? buildSettingsTestToolApprovalPolicy()
      : undefined,
    caseId: fresh.id,
    toolCallSource: "agent_e2e",
  });

  const afterAgent = await getOperationalCase(db, fresh.id);
  const invariantResult = await applyPropertyOptioningPostAgentInvariants({
    db,
    opCase: afterAgent,
    source: "post_agent_invariant_e2e",
  });
  const caseAfterDeterministicFallback = invariantResult.case ?? afterAgent;
  const version = caseAfterDeterministicFallback?.version ?? fresh.version;
  const updated = await updateOperationalCase(db, fresh.id, version, {
    nextActionAt: controlledE2ECase ? null : undefined,
    context: {
      ...(caseAfterDeterministicFallback?.context_jsonb ?? fresh.context_jsonb),
      ...(settingsTestCase
        ? {
            test_mode: true,
            controlled_test_e2e_last_run_at: new Date().toISOString(),
            controlled_test_e2e_pending_confirmation: Boolean(
              agentResult.pendingConfirmation
            ),
            controlled_test_status: agentResult.pendingConfirmation
              ? "e2e_pending_hitl"
              : "e2e_tick_completed",
          }
        : {}),
      ...(controlledE2ECase
        ? {
            e2e_control_last_run_at: new Date().toISOString(),
            e2e_control_pending_confirmation: Boolean(
              agentResult.pendingConfirmation
            ),
            e2e_control_status: agentResult.pendingConfirmation
              ? "pending_hitl"
              : "manual_tick_completed",
          }
        : {}),
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: options?.source ?? "settings_test_case_tick",
      result: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      response_preview: agentResult.response?.slice(0, 500) ?? null,
    },
  });

  return {
    case: updated ?? caseAfterDeterministicFallback ?? fresh,
    pending_confirmation: Boolean(agentResult.pendingConfirmation),
    pendingConfirmation: agentResult.pendingConfirmation ?? null,
    response_preview: agentResult.response?.slice(0, 800) ?? null,
  };
}
