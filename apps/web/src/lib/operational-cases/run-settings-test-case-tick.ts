import {
  evaluatePropertyAdvanceGate,
  runAgent,
  runDocumentFieldExtraction,
} from "@agents/agent";
import {
  createToolCall,
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
  listOperationalCaseDocuments,
  markCaseProcessing,
  updateOperationalCase,
  updateToolCallStatus,
} from "@agents/db";
import {
  SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID,
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
  operationalCaseDocumentRequestTargetFromContext,
  resolveOperationalCaseDocumentRequestTarget,
  type OperationalCase,
  type OperationalCaseDocument,
  type PendingConfirmation,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { notify } from "@/lib/notify";
import { buildDocumentChecklistLines } from "@/lib/operational-cases/case-document-collection";
import {
  buildContractDraftDownloadUrl,
  parseContractDraftFromContext,
  parseGenerateDocumentRenderResult,
} from "@/lib/operational-cases/contract-draft-document";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import { telegramChatIdFromCase } from "@/lib/operational-cases/settings-test-telegram-lab";

type PostAgentInvariantAction = Awaited<
  ReturnType<typeof applyPropertyOptioningPostAgentInvariants>
>["action"];

type TurnToolCallRow = {
  tool_name: string;
  status: string;
  result_json: Record<string, unknown> | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deterministicDocumentIdsFromBlocks(
  blocks: ReturnType<typeof evaluatePropertyAdvanceGate>["blocks"]
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.remediation.owner !== "deterministic") continue;
    for (const id of block.remediation.document_ids ?? []) ids.add(id);
  }
  return [...ids];
}

function shouldSkipPreflightExtraction(document: OperationalCaseDocument): boolean {
  const extraction =
    document.extraction_jsonb && typeof document.extraction_jsonb === "object"
      ? (document.extraction_jsonb as Record<string, unknown>)
      : {};
  if (Object.keys(extraction).length === 0) return false;
  if (document.extraction_status === "ok") return true;
  return document.extraction_status === "low_confidence" && Boolean(document.extracted_at);
}

function contextRecord(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb && typeof opCase.context_jsonb === "object"
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

function shouldAutoExecuteContractDraftGeneration(opCase: OperationalCase): boolean {
  if (opCase.case_type !== "property_optioning") return false;
  if (opCase.current_step !== "contract_pending") return false;
  const context = contextRecord(opCase);
  const pricingProposal =
    context.pricing_proposal && typeof context.pricing_proposal === "object"
      ? (context.pricing_proposal as Record<string, unknown>)
      : null;
  return pricingProposal?.approval_status === "approved";
}

async function listTurnToolCalls(
  db: ReturnType<typeof createServerClient>,
  turnId: string | null | undefined
): Promise<TurnToolCallRow[]> {
  if (!turnId) return [];
  const { data, error } = await db
    .from("tool_calls")
    .select("tool_name,status,result_json")
    .eq("turn_id", turnId);
  if (error) return [];
  return (data ?? []) as TurnToolCallRow[];
}

function hasRenderedContractDraftFromToolCalls(toolCalls: TurnToolCallRow[]): boolean {
  return toolCalls.some((call) => {
    if (call.tool_name !== "generate_document_from_template") return false;
    if (call.status !== "executed") return false;
    return parseGenerateDocumentRenderResult(call.result_json ?? undefined) != null;
  });
}

export function missingContractFieldsFromToolCalls(toolCalls: TurnToolCallRow[]): string[] {
  const fields = new Set<string>();
  for (const call of toolCalls) {
    if (call.tool_name !== "generate_document_from_template") continue;
    const result = call.result_json ?? {};
    if (result.error !== "commission_contract_missing_required_data") continue;
    const missing = result.missing_required_fields;
    if (!Array.isArray(missing)) continue;
    for (const field of missing) {
      if (typeof field === "string" && field.trim()) fields.add(field.trim());
    }
  }
  return [...fields];
}

async function hasUnreadContractReviewNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_review")
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function hasUnreadContractDataNotification(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_data_review")
    .eq("status", "unread")
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function runAuditedDocumentExtraction(params: {
  db: ReturnType<typeof createServerClient>;
  sessionId: string;
  opCase: OperationalCase;
  userId: string;
  documentId: string;
  force: boolean;
  source: string;
}) {
  const args = { document_id: params.documentId, force: params.force };
  const record = await createToolCall(
    params.db,
    params.sessionId,
    "operational_case_extract_document_fields",
    args,
    false,
    null,
    {
      executorKind: "deterministic",
      metadata: {
        case_id: params.opCase.id,
        operational_step_key: params.opCase.current_step ?? "documents_received",
        channel: "case_runner",
        source: "agent_e2e",
      },
    }
  );
  const out = await runDocumentFieldExtraction(params.db, {
    userId: params.userId,
    documentId: params.documentId,
    force: params.force,
  });
  await updateToolCallStatus(params.db, record.id, out.ok ? "executed" : "failed", out);
  return out;
}

async function ensureRequiredDocumentExtractionsForE2E(params: {
  db: ReturnType<typeof createServerClient>;
  sessionId: string;
  opCase: OperationalCase;
  userId: string;
  source: string;
}): Promise<{
  status: "ready" | "blocked";
  documents: OperationalCaseDocument[];
  blockingDocumentIds: string[];
  blockingReasons: string[];
}> {
  let documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  const initialIds = new Set(documents.map((document) => document.id));

  for (const document of documents) {
    if (shouldSkipPreflightExtraction(document)) continue;
    await runAuditedDocumentExtraction({
      ...params,
      documentId: document.id,
      force: false,
      source: `${params.source}:preflight_all_received_documents`,
    });
  }

  documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  let gate = evaluatePropertyAdvanceGate({
    documents,
    context: params.opCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  const remediationIds = deterministicDocumentIdsFromBlocks(gate.blocks).filter((id) =>
    initialIds.has(id)
  );

  for (const documentId of remediationIds) {
    await runAuditedDocumentExtraction({
      ...params,
      documentId,
      force: true,
      source: `${params.source}:preflight_remediation`,
    });
  }

  documents = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  gate = evaluatePropertyAdvanceGate({
    documents,
    context: params.opCase.context_jsonb,
    targetTransition: "comparables_in_progress",
  });
  const blockingDocumentIds = deterministicDocumentIdsFromBlocks(gate.blocks);
  // Importante: los bloqueos de calidad predial con owner=human NO deben
  // detener aquí el tick E2E como "blocked_pending_extraction". Esos casos
  // se atienden en applyPropertyOptioningPostAgentInvariants, que emite
  // notify_user(kind=property_data_quality_review) y deja el caso en
  // waiting_internal con acción humana clara. Si bloqueamos en preflight,
  // el panel queda en limbo sin pendiente accionable.
  if (blockingDocumentIds.length > 0) {
    return {
      status: "blocked",
      documents,
      blockingDocumentIds: [...new Set(blockingDocumentIds)],
      blockingReasons: gate.blocks.map((block) => block.reason),
    };
  }
  return { status: "ready", documents, blockingDocumentIds: [], blockingReasons: [] };
}

/**
 * Translate the deterministic invariant outcome into an honest controlled-E2E
 * status so the lab panel never reports a hollow "tick completed" when the case
 * is actually waiting on the owner or blocked on document extraction.
 */
function deriveControlledE2EStatus(
  action: PostAgentInvariantAction,
  pendingConfirmation: boolean
): string {
  if (pendingConfirmation) return "pending_hitl";
  switch (action) {
    case "requested_property_data_review":
    case "remediated_extraction":
      return "manual_tick_completed";
    case "asked_missing_characteristics":
    case "asked_missing_characteristics_again":
      return "waiting_external";
    case "asked_missing_characteristics_internal":
    case "asked_missing_characteristics_again_internal":
    case "requested_comparables_decision":
    case "requested_property_data_quality_review":
      return "waiting_internal";
    case "deferred_pending_extraction":
      return "blocked_pending_extraction";
    case "remediated_comparables":
    case "advanced_to_price_proposal":
      return "manual_tick_completed";
    case "escalated_extraction_to_human":
      return "extraction_escalated_to_human";
    case "no_action":
    case "not_applicable":
    default:
      return "manual_tick_completed";
  }
}

export function isSettingsTestCase(opCase: OperationalCase): boolean {
  return isSettingsOperationalTestCase(opCase);
}

function buildCaseE2ETickMessage(
  opCase: OperationalCase,
  options?: { ownerResponseText?: string }
): string {
  const context =
    opCase.context_jsonb && typeof opCase.context_jsonb === "object"
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
  const explicitDocumentRequestTarget =
    operationalCaseDocumentRequestTargetFromContext(context);
  if (options?.ownerResponseText?.trim()) {
    return [
      `Procesa la respuesta reciente del dueño en el caso ${opCase.id}.`,
      `Estado actual: status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}.`,
      "Acción esperada: sub-skill extract-property-characteristics mientras el caso esté en documents_received.",
      "Integra el evento external_response reciente en context_jsonb.property_data.",
      "No avances a comparables, precio, contrato ni publicación en este tick.",
      "Antes de extraer, llama operational_case_list_documents y usa únicamente IDs UUID reales devueltos ahí; nunca uses placeholders como <document_id>.",
      "Antes de preguntar faltantes, consolida lo extraído de documentos de propiedad (escritura, predial, boleta): titulares, dirección legal y superficie/metraje. No uses dirección de IFE/comprobante como dirección del inmueble salvo que esté marcada como propiedad.",
      explicitDocumentRequestTarget === "internal_user"
        ? "Si faltan campos mínimos, notifícalos al asesor interno (notify_user) y conserva status=waiting_internal/current_step=documents_received. NO uses telegram_send_message_to_contact cuando document_request_target=internal_user."
        : "Si faltan campos mínimos, prepara preguntas al dueño (purpose=characteristics_pending). Mínimos comunes: dueño/titulares, dirección y superficie/metraje. Por tipo: casa requiere construcción m2, plantas, recámaras, baños completos, medios baños y cocina integral; departamento requiere recámaras, baños completos, medios baños, cajones, piso, elevador y amenidades; terreno requiere metraje y si está en coto/condominio/parque industrial o es independiente; bodega/nave requiere m2 de bodega, altura, oficinas si aplica, baños, cajones, KVA y transformador. Para terrenos/lotes no preguntes recámaras, baños ni estacionamientos salvo que exista construcción.",
      "Al mezclar datos, conserva como canónicos los campos del intake ya confirmado (property_title, property_zone, operation_type, property_type). Los documentos pueden aportar dirección legal, superficie, folio, titular, medidas y colindancias, pero no deben reemplazar property_type='Terreno' por etiquetas notariales como 'Unidad Privativa' salvo que pidas confirmación explícita como posible conflicto.",
      "Si los mínimos están completos, solicita revisión interna con notify_user(kind=property_data_review). En ese mensaje separa claramente: datos confirmados por intake; datos encontrados en documentos; faltantes/advertencias/conflictos. No pongas tipo/operación/zona como datos extraídos si solo vienen del intake. No combines zona y dirección bajo un solo campo. Para terrenos/lotes muestra recámaras/baños/estacionamientos como 'No aplica' salvo que exista construcción.",
    ].join(" ");
  }
  const settingsTestCase = isSettingsOperationalTestCase(opCase);
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);
  const externalChatId =
    telegramChatIdFromCase(opCase, context) ??
    (settingsTestCase || controlledE2ECase
        ? SETTINGS_TEST_TELEGRAM_LAB_CHAT_ID
      : null);
  const documentRequestTarget = resolveOperationalCaseDocumentRequestTarget({
    externalContact: opCase.external_contact_jsonb,
    context,
  });
  return [
    `Tick E2E controlado para el caso ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    settingsTestCase || controlledE2ECase
      ? "Ejecuta la siguiente acción según la skill del caso de prueba. En este tick de prueba controlada las tools operativas y Telegram al contacto están pre-autorizadas (sin HITL)."
      : "Ejecuta la siguiente acción según la skill del caso. Este tick reemplaza al cron para un recorrido E2E controlado; los mensajes entrantes por Telegram siguen siendo parte del flujo real.",
    explicitDocumentRequestTarget === "external_contact" && externalChatId
      ? `Contacto externo Telegram del caso: usa exactamente chat_id=${externalChatId} al llamar telegram_send_message_to_contact.`
      : "",
    opCase.current_step === "awaiting_documents"
      ? [
          explicitDocumentRequestTarget == null
            ? "Acción esperada para este paso: antes de pedir documentos, solicita al asesor elegir destino («interno» o «externo») con notify_user(kind=case_update). No envíes solicitud documental todavía."
            : documentRequestTarget === "external_contact"
            ? "Acción esperada para este paso: usa request-property-documents, envía el mensaje inicial de solicitud de documentos al contacto por Telegram, registra reminder_sent con purpose=initial_request y deja el caso en waiting_external / awaiting_documents."
            : "Acción esperada para este paso: NO contactes al dueño por Telegram. Usa notify_user(kind=case_update) para pedir al asesor interno que suba documentos al caso (web, Telegram interno o panel de casos) y confirme con “listo” cuando termine.",
          explicitDocumentRequestTarget == null
            ? "Si el asesor responde «interno», registra document_request_target=internal_user. Si responde «externo», registra document_request_target=external_contact y entonces sí solicita documentos al contacto."
            : documentRequestTarget === "external_contact"
            ? "El mensaje inicial DEBE enumerar documentos específicos, no uses una frase genérica. Incluye estos bullets:"
            : "La notificación interna DEBE enumerar documentos específicos, no uses una frase genérica. Incluye estos bullets:",
          ...buildDocumentChecklistLines(),
          explicitDocumentRequestTarget === "external_contact"
            ? "Si falta alguno, pide que envíe lo disponible y aclara que pueden continuar por texto sin detener el proceso."
            : "Si falta alguno, indica que puede subir lo disponible y continuar por texto sin detener el proceso.",
          "Incluye una frase breve de privacidad: solo se usan para verificar la propiedad y armar el contrato; no se comparten sin autorización.",
          explicitDocumentRequestTarget == null
            ? "No avances de awaiting_documents hasta que exista elección explícita de document_request_target."
            : documentRequestTarget === "external_contact"
            ? "No avances a documents_received, comparables, precio ni contrato sin external_response."
            : "No avances a documents_received, comparables, precio ni contrato hasta que el asesor confirme “listo” y exista al menos un documento registrado.",
        ].join(" ")
      : "",
    opCase.current_step === "comparables_in_progress"
      ? [
          "Acción esperada para este paso: usa perform-comparable-analysis.",
          "No regreses a awaiting_documents ni documents_received.",
          "Consulta comparables con easybroker_search_listings, easybroker_search_closed_deals y bigquery_lookup_local_comparables usando property_zone/property_data como filtros.",
          "No uses placeholders con 0 en filtros opcionales (m², precio, cajones). La búsqueda debe correr en escalera determinística strict -> expanded -> wide -> location_only (sin área) antes de concluir insuficiencia real.",
          "Si el tipo es casa/departamento en condominio, intenta siempre get_avaclick_valuation antes de persistir comparables_analysis. Si faltan coordenadas pero hay dirección suficiente, intenta geocode_property_address primero.",
          "Si Avaclick devuelve missing_required_fields, not_configured o validation_error, no bloquees el paso: continúa con las otras fuentes y deja warning explícito en comparables_analysis.",
          "No llames operational_case_persist_comparables_analysis hasta tener get_avaclick_valuation ejecutado (o un resultado no recuperable documentado de Avaclick). Después persiste comparables_analysis; no lo escribas manualmente.",
          "Si detectas que area_construida_m2 es implausible/no confiable, no avances a precio: permanece en comparables_in_progress, status=waiting_internal y notifica con notify_user(kind=property_data_quality_review) solicitando confirmación/corrección.",
          "Si hay muestra defendible, avanza a price_proposal_pending con status=active y notifica al asesor. Si data_quality.search_validity=insufficient_market_data y el caso quedará en waiting_internal, solicita decisión concreta con notify_user(kind=comparables_search_expansion_decision). Usa comparables_insufficient_data solo como resumen informativo no bloqueante. Si data_quality.search_validity=invalid_filters, corrige/reintenta y no notifiques insuficiencia.",
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
    let caseForLock = opCase;
    const maxLockAttempts = isControlledE2EOperationalCase(opCase) ? 4 : 1;
    for (let attempt = 0; attempt < maxLockAttempts; attempt += 1) {
      const locked = await markCaseProcessing(
        db,
        caseForLock.id,
        caseForLock.version,
        1
      );
      if (locked) {
        break;
      }
      if (attempt === maxLockAttempts - 1) {
        throw new Error("case_busy");
      }
      await sleep(750 * (attempt + 1));
      const reread = await getOperationalCase(db, opCase.id);
      if (!reread) {
        throw new Error("case_not_found");
      }
      caseForLock = reread;
    }
  }

  const fresh = await getOperationalCase(db, opCase.id);
  if (!fresh) {
    throw new Error("case_not_found");
  }
  const caseWithTarget = fresh;

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    stepKey: fresh.current_step ?? undefined,
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
  const explicitDocumentRequestTarget =
    operationalCaseDocumentRequestTargetFromContext(
      (caseWithTarget.context_jsonb as Record<string, unknown>) ?? null
    );
  const deterministicDocumentsReceivedPath =
    caseWithTarget.current_step === "documents_received";

  if (deterministicDocumentsReceivedPath) {
    const extractionReadiness = await ensureRequiredDocumentExtractionsForE2E({
      db,
      sessionId: session.id,
      opCase: caseWithTarget,
      userId,
      source: options?.source ?? "settings_test_case_tick",
    });
    if (extractionReadiness.status === "blocked") {
      const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
        nextActionAt: controlledE2ECase ? null : new Date().toISOString(),
        context: {
          ...(fresh.context_jsonb ?? {}),
          ...(settingsTestCase
            ? {
                controlled_test_status: "blocked_pending_extraction",
                controlled_test_e2e_last_run_at: new Date().toISOString(),
              }
            : {}),
          ...(controlledE2ECase
            ? {
                e2e_control_status: "blocked_pending_extraction",
                e2e_control_last_run_at: new Date().toISOString(),
                e2e_control_last_invariant_action: "deferred_pending_extraction",
              }
            : {}),
          extraction_preflight_blocked_document_ids:
            extractionReadiness.blockingDocumentIds,
          extraction_preflight_blocking_reasons:
            extractionReadiness.blockingReasons,
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: fresh.current_step ?? undefined,
        payload: {
          source: options?.source ?? "settings_test_case_tick",
          kind: "document_extraction_preflight_blocked",
          result: "blocked_pending_extraction",
          pending_document_ids: extractionReadiness.blockingDocumentIds,
          reasons: extractionReadiness.blockingReasons,
        },
      });
      return {
        case: updated ?? fresh,
        pending_confirmation: false,
        pendingConfirmation: null,
        response_preview: null,
      };
    }
  }

  if (deterministicDocumentsReceivedPath) {
    const invariantResult = await applyPropertyOptioningPostAgentInvariants({
      db,
      opCase: caseWithTarget,
      source: "post_agent_invariant_e2e",
    });
    const caseAfterDeterministicFallback = invariantResult.case ?? caseWithTarget;
    const version = caseAfterDeterministicFallback.version ?? fresh.version;
    const controlledStatus = deriveControlledE2EStatus(invariantResult.action, false);
    const updated = await updateOperationalCase(db, fresh.id, version, {
      nextActionAt: controlledE2ECase ? null : undefined,
      context: {
        ...(caseAfterDeterministicFallback.context_jsonb ?? fresh.context_jsonb),
        ...(settingsTestCase
          ? {
              test_mode: true,
              controlled_test_e2e_last_run_at: new Date().toISOString(),
              controlled_test_e2e_pending_confirmation: false,
              controlled_test_status: "e2e_tick_completed",
            }
          : {}),
        ...(controlledE2ECase
          ? {
              e2e_control_last_run_at: new Date().toISOString(),
              e2e_control_pending_confirmation: false,
              e2e_control_status: controlledStatus,
              e2e_control_last_invariant_action: invariantResult.action,
            }
          : {}),
      },
    });

    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: (updated ?? caseAfterDeterministicFallback ?? fresh).current_step ?? undefined,
      payload: {
        source: options?.source ?? "settings_test_case_tick",
        result: "e2e_tick_completed",
        pending_confirmation: false,
        invariant_action: invariantResult.action,
        controlled_status: controlledStatus,
        response_preview: null,
      },
    });

    return {
      case: updated ?? caseAfterDeterministicFallback ?? fresh,
      pending_confirmation: false,
      pendingConfirmation: null,
      response_preview: null,
    };
  }

  const agentResult = await runAgent({
    message: buildCaseE2ETickMessage(caseWithTarget, {
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
      ? buildSettingsTestToolApprovalPolicy(undefined, {
          documentRequestTarget: explicitDocumentRequestTarget,
          autoExecuteContractDraftGeneration:
            shouldAutoExecuteContractDraftGeneration(caseWithTarget),
        })
      : undefined,
    caseId: caseWithTarget.id,
    toolCallSource: "agent_e2e",
  });

  const afterAgent = await getOperationalCase(db, fresh.id);
  const invariantResult = await applyPropertyOptioningPostAgentInvariants({
    db,
    opCase: afterAgent,
    source: "post_agent_invariant_e2e",
  });
  const caseAfterDeterministicFallback = invariantResult.case ?? afterAgent;
  const turnToolCalls = await listTurnToolCalls(db, agentResult.turnId);
  const hasRenderedContractDraft = hasRenderedContractDraftFromToolCalls(turnToolCalls);
  const missingContractFields = missingContractFieldsFromToolCalls(turnToolCalls);
  const contractDraft = parseContractDraftFromContext(
    caseAfterDeterministicFallback?.context_jsonb ?? null
  );
  const hasContractDraftOutputPath = Boolean(contractDraft?.output_path?.trim());
  let responsePreviewForEvent = agentResult.response?.slice(0, 500) ?? null;
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length === 0 &&
    !hasContractDraftOutputPath &&
    !hasRenderedContractDraft
  ) {
    responsePreviewForEvent = null;
    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_generation_unverified",
        source: options?.source ?? "settings_test_case_tick",
        reason: "missing_generate_document_render",
      },
    });
  }
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length > 0 &&
    !agentResult.pendingConfirmation
  ) {
    responsePreviewForEvent = null;
    const hasUnreadContractData = await hasUnreadContractDataNotification(
      db,
      userId,
      fresh.id
    );
    if (!hasUnreadContractData) {
      const missingFieldsLabel = missingContractFields.join(", ");
      const needsOwnerEmail = missingContractFields.includes("owner_email");
      await notify(
        db,
        userId,
        {
          text: needsOwnerEmail
            ? `Falta correo electrónico del propietario para generar el contrato de comisión. Captura el correo del comitente (campos faltantes: ${missingFieldsLabel}).`
            : `No pude generar el borrador de contrato porque faltan datos obligatorios: ${missingFieldsLabel}. Completa esos campos para continuar.`,
          kind: "contract_data_review",
          data: {
            case_id: fresh.id,
            missing_required_fields: missingContractFields,
            source: options?.source ?? "settings_test_case_tick",
          },
        },
        "high"
      );
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "human_decision",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_data_review_requested",
          source: options?.source ?? "settings_test_case_tick",
          missing_required_fields: missingContractFields,
        },
      });
    }
  }
  if (
    caseAfterDeterministicFallback?.current_step === "contract_pending" &&
    missingContractFields.length === 0 &&
    hasContractDraftOutputPath &&
    !agentResult.pendingConfirmation
  ) {
    const hasUnreadReview = await hasUnreadContractReviewNotification(
      db,
      userId,
      fresh.id
    );
    if (!hasUnreadReview) {
      const contractUrl = buildContractDraftDownloadUrl(fresh.id);
      await notify(
        db,
        userId,
        {
          text: `Borrador de contrato listo para revisión.\n\nDescargar borrador del contrato: ${contractUrl}\n\nResponde “mándalo al dueño” o “pedir cambios”, o usa los botones.`,
          kind: "contract_review",
          data: {
            case_id: fresh.id,
            contract_draft_ready: true,
            contract_draft_url: contractUrl,
          },
        },
        "normal"
      );
      await insertOperationalCaseEvent(db, {
        caseId: fresh.id,
        eventType: "human_decision",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_review_requested",
          source: options?.source ?? "settings_test_case_tick",
          doc_url: contractUrl,
        },
      });
    }
  }
  const version = caseAfterDeterministicFallback?.version ?? fresh.version;
  const controlledStatus = deriveControlledE2EStatus(
    invariantResult.action,
    Boolean(agentResult.pendingConfirmation)
  );
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
            e2e_control_status: controlledStatus,
            e2e_control_last_invariant_action: invariantResult.action,
          }
        : {}),
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: (updated ?? caseAfterDeterministicFallback ?? fresh).current_step ?? undefined,
    payload: {
      source: options?.source ?? "settings_test_case_tick",
      result: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      invariant_action: invariantResult.action,
      controlled_status: controlledStatus,
      response_preview: responsePreviewForEvent,
    },
  });

  return {
    case: updated ?? caseAfterDeterministicFallback ?? fresh,
    pending_confirmation: Boolean(agentResult.pendingConfirmation),
    pendingConfirmation: agentResult.pendingConfirmation ?? null,
    response_preview: agentResult.response?.slice(0, 800) ?? null,
  };
}
