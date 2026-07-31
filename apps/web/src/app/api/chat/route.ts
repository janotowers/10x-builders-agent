import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  addMessage,
  createServerClient,
  decryptToken,
  findPendingConversationBindings,
  getGoogleCalendarAccessToken,
  getActiveE2ELabSession,
  getOperationalCase,
  insertOperationalCaseEvent,
  touchConversationBindingForCase,
} from "@agents/db";
import {
  appendRawPhoto,
  internalCaseMediaRegisteredKind,
} from "@/lib/operational-cases/append-raw-photo";
import { ingestStagedCaseDocument } from "@/lib/operational-cases/case-document-ingestion";
import {
  bindAiUsageContext,
  isPropertyOptioningIntent,
  runAgent,
} from "@agents/agent";
import { maybeCatchUpFlush, fireAndForgetFlush } from "@/lib/memory/trigger";
import { publishTurnEvent } from "@/lib/agent-turn-events";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import {
  buildOperationalCaseToolApprovalPolicy,
  resolveConversationalCaseForChannel,
} from "@/lib/operational-cases/conversational-case-orchestrator";
import { resolveConversationalIntakeTurn } from "@/lib/operational-cases/conversational-intake-orchestrator";
import {
  resolveConversationalClarificationReply,
  resolveRoutableConversationBindings,
  routeConversationalMessageAgainstBindings,
} from "@/lib/operational-cases/conversational-routing-orchestrator";
import { maybeRunPostIntakeConversationalE2ETick } from "@/lib/operational-cases/conversational-e2e-post-intake";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import type { OperationalCase, ToolApprovalPolicy } from "@agents/types";
import { resolveOperationalCaseDocumentRequestTarget } from "@agents/types";
import {
  applyDocumentRequestTargetChoice,
  inferInternalDocumentTargetOnUpload,
  resolveCharacteristicsReplyAgainstBindings,
  resolveDocumentTargetReplyAgainstBindings,
  resolveInternalDocumentMessageCase,
  resolveInternalDocumentUploadCaseForMedia,
  shouldPromptCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";
import {
  processCharacteristicsReplyDeterministically,
  shouldProcessInternalCharacteristicsReply,
} from "@/lib/operational-cases/characteristics-response";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import { looksLikeDocumentBatchComplete } from "@/lib/operational-cases/document-batch-completion";
import { photosUploadProgressAckText } from "@/lib/operational-cases/photo-batch-completion";
import { completeUploadBatch } from "@/lib/operational-cases/upload-batch-completion";
import {
  finalizePropertyOptioningAgentTurn,
  isOperationalContinueNudge,
  maybeRecoverContractPendingTurn,
  maybeRecoverPackageReadyContinue,
} from "@/lib/operational-cases/operational-case-post-turn";
import {
  buildExternalContactDeepLink,
  buildExternalContactSetupMessage,
} from "@/lib/operational-cases/external-contact-link";
import { handleContractRevisionUploadAndSend } from "@/lib/business-decisions/contract-review";
import { resolvePendingDecisionTurn } from "@/lib/business-decisions/pending-decision-router";
import { appendResidualAcknowledgment } from "@/lib/business-decisions/residual-intent";
import { buildMediaGroupReceivedAck } from "@/lib/operational-cases/case-document-collection";
import type { PendingAttachmentRef } from "@/lib/operational-cases/pending-attachment-envelope";
import {
  buildUserMessageStructuredPayload,
  stripEmbeddedAttachmentOcr,
} from "@/lib/chat/attachment-message-display";

const TOOL_CALL_SELECT =
  "id, turn_id, tool_name, arguments_json, result_json, status, requires_confirmation, created_at, finished_at, executor_kind";

async function loadTurnToolCalls(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: { sessionId: string; turnId?: string | null }
): Promise<Array<Record<string, unknown>>> {
  if (!params.turnId) return [];
  const { data, error } = await supabase
    .from("tool_calls")
    .select(TOOL_CALL_SELECT)
    .eq("session_id", params.sessionId)
    .eq("turn_id", params.turnId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[chat] load turn tool calls failed:", error);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

type IncomingAttachment = PendingAttachmentRef;

function attachmentOwnedByUser(
  attachment: IncomingAttachment,
  userId: string
): boolean {
  return attachment.storagePath.startsWith(`${userId}/`);
}

function filterAttachmentsOwnedByUser(
  attachments: IncomingAttachment[],
  userId: string
): IncomingAttachment[] {
  return attachments.filter((attachment) =>
    attachmentOwnedByUser(attachment, userId)
  );
}

function fileExtensionFromName(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function isAllowedContractRevisionAttachment(fileName: string): boolean {
  const extension = fileExtensionFromName(fileName);
  return extension === "pdf" || extension === "doc" || extension === "docx";
}

function caseWaitingContractRevisionUpload(opCase: OperationalCase): boolean {
  if (opCase.current_step !== "contract_pending") return false;
  if (opCase.status !== "waiting_internal") return false;
  const context = opCase.context_jsonb;
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  const review = (context as Record<string, unknown>).contract_review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  return (review as Record<string, unknown>).status === "awaiting_revision_upload";
}

function normalizeIncomingAttachments(raw: unknown): IncomingAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (
        typeof record.fileName !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.storageBucket !== "string" ||
        typeof record.storagePath !== "string" ||
        typeof record.sha256 !== "string"
      ) {
        return null;
      }
      return {
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes:
          typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes)
            ? record.sizeBytes
            : 0,
        storageBucket: record.storageBucket,
        storagePath: record.storagePath,
        sha256: record.sha256,
        suggestedKind:
          typeof record.suggestedKind === "string" ? record.suggestedKind : "unknown",
      } as IncomingAttachment;
    })
    .filter((item): item is IncomingAttachment => Boolean(item));
}

async function registerInternalCaseAttachments(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase;
  attachments: IncomingAttachment[];
}): Promise<{
  registered: number;
  opCase: OperationalCase;
  photosAdded: number;
  rawPhotosCount: number;
  registeredFiles: Array<{ originalName: string; kind: string }>;
}> {
  if (params.attachments.length === 0) {
    return {
      registered: 0,
      opCase: params.opCase,
      photosAdded: 0,
      rawPhotosCount: 0,
      registeredFiles: [],
    };
  }
  // Paridad Telegram: persistir inferencia interna si el asesor sube docs
  // antes de elegir interno/externo (no solo resolver por default).
  const inferred = await inferInternalDocumentTargetOnUpload({
    db: params.db,
    opCase: params.opCase,
    source: "web_chat",
    reason: "advisor_uploaded_documents_before_choice",
  });
  let currentCase = inferred.opCase;
  const target = resolveOperationalCaseDocumentRequestTarget({
    externalContact: currentCase.external_contact_jsonb,
    context: currentCase.context_jsonb,
  });
  const supportsInternalDocs =
    target === "internal_user" && currentCase.current_step === "awaiting_documents";
  const supportsInternalPhotos = currentCase.current_step === "photos_requested";
  if (!supportsInternalDocs && !supportsInternalPhotos) {
    return {
      registered: 0,
      opCase: currentCase,
      photosAdded: 0,
      rawPhotosCount: 0,
      registeredFiles: [],
    };
  }

  let registered = 0;
  let photosAdded = 0;
  let rawPhotosCount = 0;
  const registeredFiles: Array<{ originalName: string; kind: string }> = [];
  const ownedAttachments = filterAttachmentsOwnedByUser(
    params.attachments,
    currentCase.user_id
  );
  for (const attachment of ownedAttachments) {
    // Paridad Telegram: promover staging → ruta canónica del caso + misma
    // fila/kind/blocking que ingestCaseDocument.
    const ingested = await ingestStagedCaseDocument({
      db: params.db,
      caseId: currentCase.id,
      userId: currentCase.user_id,
      source: "advisor_web",
      fileName: attachment.fileName,
      contentType: attachment.mimeType,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      stagedBucket: attachment.storageBucket,
      stagedPath: attachment.storagePath,
      suggestedKind: attachment.suggestedKind,
      sourceMetadata: { source: "chat_web_attachment" },
    });
    const document = ingested.document;
    console.info("[chat] attachment promoted", {
      case_id: currentCase.id,
      staging_path: attachment.storagePath,
      final_path: document.storage_path,
      kind: document.kind,
    });
    await insertOperationalCaseEvent(params.db, {
      caseId: currentCase.id,
      eventType: "external_response",
      actor: "user",
      payload: {
        kind: internalCaseMediaRegisteredKind(currentCase.current_step),
        source: "advisor_web_chat",
        document_id: document.id,
        document_kind: document.kind,
        current_step: currentCase.current_step,
        step_key: currentCase.current_step,
        original_name: attachment.fileName,
      },
    });
    registered += 1;
    registeredFiles.push({
      originalName: attachment.fileName,
      kind: document.kind,
    });

    if (!supportsInternalPhotos) {
      continue;
    }
    const photoResult = await appendRawPhoto({
      db: params.db,
      opCase: currentCase,
      ingested,
    });
    currentCase = photoResult.opCase;
    if (photoResult.photoAdded) {
      photosAdded += 1;
    }
    if (photoResult.photoCount > 0) {
      rawPhotosCount = photoResult.photoCount;
    }
  }
  return {
    registered,
    opCase: currentCase,
    photosAdded,
    rawPhotosCount,
    registeredFiles,
  };
}

export async function POST(request: Request) {
  try {
    ensureAgentToolDepsWired();
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      message?: unknown;
      turnId?: unknown;
      attachments?: unknown;
    };
    const { message } = body;
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const requestTurnId =
      typeof body.turnId === "string" && uuidRe.test(body.turnId)
        ? body.turnId
        : undefined;
    const incomingAttachments = filterAttachmentsOwnedByUser(
      normalizeIncomingAttachments(body.attachments),
      user.id
    );

    const db = createServerClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "name, agent_system_prompt, agent_name, timezone, email, phone, business_brain, is_ungga_admin"
      )
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: skillSettings } = await supabase
      .from("user_skill_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await supabase
      .from("user_integrations")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active");

    const githubIntegration = integrations?.find(
      (i: Record<string, unknown>) =>
        i.provider === "github" && i.status === "active"
    );
    let githubToken: string | undefined;
    if (githubIntegration?.encrypted_tokens) {
      try {
        githubToken = decryptToken(
          githubIntegration.encrypted_tokens as string
        );
      } catch (e) {
        console.error("Failed to decrypt GitHub token:", e);
      }
    }

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);

    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }

    if (!session) {
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 }
      );
    }

    // Slice 0.4: contexto ambiente de metering AI para clasificadores y
    // extractores pre-agente (runAgent lo enriquece con turn/case ids).
    bindAiUsageContext(
      {
        userId: user.id,
        channel: "web",
        sessionId: session.id,
        turnId: requestTurnId ?? null,
      },
      db
    );

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, user.id)) ?? undefined;

    // Catch-up de memoria larga ANTES de runAgent: si la sesión está fría
    // (idle ≥ CATCHUP_IDLE_MIN) o hay otra sesión del usuario sin flushear,
    // consolida esos hechos ahora para que la inyección del turno los vea.
    // Se absorbe su latencia aquí UNA vez (primer turno tras el hueco).
    await maybeCatchUpFlush({
      db,
      userId: user.id,
      sessionId: session.id,
      channel: "web",
    });

    // Paridad de canal: igual que el webhook de Telegram, el chat web resuelve
    // o crea el caso conversacional operacional ANTES de invocar al agente,
    // siguiendo el MISMO orden: (1) responder una aclaración multi-caso
    // pendiente, (2) detectar intención/crear caso, (3) enrutar contra bindings
    // pendientes (asociar / pedir aclaración), y (4) correr el motor de intake
    // determinístico. Si algún paso maneja el turno, se responde directo
    // (short-circuit) sin invocar al agente. Todo el bloque es defensivo:
    // cualquier fallo no debe romper el chat general.
    let conversationalCaseId: string | undefined;
    let operationalToolApprovalPolicy: ToolApprovalPolicy | undefined;
    // El mensaje/adjuntos sobre los que se actúa: tras resolver una aclaración,
    // son el envelope pendiente (texto + staging refs), no la respuesta ("1"/"sí").
    let effectiveMessage = message;
    let effectiveAttachments: IncomingAttachment[] = incomingAttachments;

    const respondConversational = (
      responseText: string,
      options?: { assistantStructuredPayload?: Record<string, unknown> }
    ) => {
      // Persistimos el turno en el historial web para que sobreviva al refresh
      // (Telegram no lo necesita: su historial vive en Telegram).
      return (async () => {
        // Guardamos chips de adjunto + userText; el content puede llevar OCR
        // para el agente, pero el UI no debe rehidratar ese dump crudo.
        const userPayload = buildUserMessageStructuredPayload({
          message,
          attachments: effectiveAttachments,
        });
        await addMessage(db, session.id, "user", message, {
          turn_id: requestTurnId ?? null,
          structured_payload: userPayload,
        });
        await addMessage(db, session.id, "assistant", responseText, {
          turn_id: requestTurnId ?? null,
          ...(options?.assistantStructuredPayload
            ? { structured_payload: options.assistantStructuredPayload }
            : {}),
        });
        return NextResponse.json({
          response: responseText,
          turnId: requestTurnId ?? null,
          appliedSkills: [],
          memoryUsed: [],
          pendingConfirmation: null,
          toolCalls: [],
          ...(options?.assistantStructuredPayload
            ? { structuredPayload: options.assistantStructuredPayload }
            : {}),
        });
      })();
    };

    // Paridad de canal con Telegram: las decisiones HITL pendientes (revisión
    // de descripción, precio, datos/revisión de contrato, titularidad,
    // comparables) reclaman el turno ANTES del routing conversacional y del
    // agente. Mismo router determinístico que el webhook. Defensivo: un fallo
    // aquí no debe romper el chat general.
    try {
      const pendingDecisionTurn = await resolvePendingDecisionTurn(db, {
        userId: user.id,
        text: message,
        channel: "web",
        isExplicitNewCaseIntent: isPropertyOptioningIntent(message),
      });
      if (pendingDecisionTurn.handled) {
        if (pendingDecisionTurn.caseId) {
          await touchConversationBindingForCase(db, {
            caseId: pendingDecisionTurn.caseId,
            channel: "web",
            sessionId: session.id,
          }).catch((touchError) => {
            console.warn("[chat] touch pending-decision web binding failed:", touchError);
          });
        }
        // Slice 0.1: reconoce el texto sobre el que la decisión NO actuó.
        const messageWithResidual = appendResidualAcknowledgment(
          pendingDecisionTurn.message,
          pendingDecisionTurn.residual
        );
        // read_artifact: en web el texto completo va inline en la respuesta.
        const responseText = pendingDecisionTurn.artifact
          ? `${messageWithResidual}\n\n${pendingDecisionTurn.artifact.content}`
          : messageWithResidual;
        // Paridad Telegram: primero el ack en el timeline, luego follow-ups
        // diferidos (p. ej. price_approval) para que no adelanten al ack.
        const response = await respondConversational(responseText);
        if (pendingDecisionTurn.runAfterReply) {
          try {
            await pendingDecisionTurn.runAfterReply();
          } catch (afterReplyError) {
            console.error(
              "[chat] pending-decision runAfterReply failed:",
              afterReplyError
            );
          }
        }
        return response;
      }
    } catch (pendingDecisionError) {
      console.error(
        "[chat] pending-decision router failed; continuing to agent:",
        pendingDecisionError
      );
    }

    try {
      let conversationalCase: OperationalCase | null = null;
      let conversationalJustCreated = false;
      let explicitOperationalIntent = false;
      let forceNewConversationalCase = false;
      const deterministicPropertyIntent = isPropertyOptioningIntent(effectiveMessage);

      const pendingWebBindings = await findPendingConversationBindings(db, {
        userId: user.id,
        channel: "web",
        statuses: ["awaiting_user", "clarification_needed"],
      });
      const activeE2ELabSession = await getActiveE2ELabSession(db, {
        userId: user.id,
        caseType: "property_optioning",
      });
      const routingResolution = await resolveRoutableConversationBindings({
        db,
        pendingBindings: pendingWebBindings,
        e2eLabSessionActive: Boolean(activeE2ELabSession),
        caseType: "property_optioning",
      });
      const routingWebBindings = routingResolution.routableBindings;
      const routingCasesById = routingResolution.candidateCasesById;
      if (effectiveMessage && deterministicPropertyIntent) {
        console.info("[chat] routing bindings resolved", {
          raw_bindings_count: pendingWebBindings.length,
          routable_bindings_count: routingWebBindings.length,
          ignored_binding_reasons: routingResolution.ignoredBindings.map(
            (entry) => entry.reason
          ),
          active_e2e_session_id: activeE2ELabSession?.id ?? null,
          deterministic_property_intent: deterministicPropertyIntent,
        });
      }

      // (1) Respuesta a una aclaración multi-caso pendiente.
      const pendingClarification = routingWebBindings.find(
        (binding) => binding.status === "clarification_needed"
      );
      if (pendingClarification) {
        const reply = await resolveConversationalClarificationReply({
          db,
          binding: pendingClarification,
          message,
        });
        if (reply.status === "invalid_index" || reply.status === "resolved_no") {
          return await respondConversational(reply.responseText);
        }
        if (reply.status === "resolved_new_case") {
          forceNewConversationalCase = true;
          explicitOperationalIntent = true;
          if (reply.effectiveMessage) effectiveMessage = reply.effectiveMessage;
          if (reply.effectiveAttachments.length > 0) {
            effectiveAttachments = reply.effectiveAttachments;
          }
        }
        if (reply.status === "resolved_case" && reply.case) {
          conversationalCase = reply.case;
          if (reply.effectiveMessage) effectiveMessage = reply.effectiveMessage;
          if (reply.effectiveAttachments.length > 0) {
            effectiveAttachments = reply.effectiveAttachments;
          }
        }
        // Tras restaurar el envelope ("sí apruebo"), re-intentar decisiones
        // HITL pendientes: el primer pase corrió sobre "1" y no las vio.
        if (
          (reply.status === "resolved_case" ||
            reply.status === "resolved_new_case") &&
          effectiveMessage.trim() &&
          effectiveMessage.trim() !== message.trim()
        ) {
          try {
            const restoredDecision = await resolvePendingDecisionTurn(db, {
              userId: user.id,
              text: effectiveMessage,
              channel: "web",
              isExplicitNewCaseIntent: isPropertyOptioningIntent(effectiveMessage),
            });
            if (restoredDecision.handled) {
              if (restoredDecision.caseId) {
                await touchConversationBindingForCase(db, {
                  caseId: restoredDecision.caseId,
                  channel: "web",
                  sessionId: session.id,
                }).catch((touchError) => {
                  console.warn(
                    "[chat] touch restored-decision web binding failed:",
                    touchError
                  );
                });
              }
              const messageWithResidual = appendResidualAcknowledgment(
                restoredDecision.message,
                restoredDecision.residual
              );
              const responseText = restoredDecision.artifact
                ? `${messageWithResidual}\n\n${restoredDecision.artifact.content}`
                : messageWithResidual;
              const response = await respondConversational(responseText);
              if (restoredDecision.runAfterReply) {
                try {
                  await restoredDecision.runAfterReply();
                } catch (afterReplyError) {
                  console.error(
                    "[chat] restored pending-decision runAfterReply failed:",
                    afterReplyError
                  );
                }
              }
              return response;
            }
          } catch (restoredDecisionError) {
            console.error(
              "[chat] restored pending-decision after clarify failed:",
              restoredDecisionError
            );
          }
        }
      }

      // (1.5) Paridad Telegram: con bindings activos + intención de opcionar,
      // preguntar «continuar vs nueva» ANTES de crear/adoptar. Si corremos
      // ensure primero, `shouldForceNew…` abre un caso nuevo en silencio cuando
      // el existente ya pasó intake.
      if (
        !conversationalCase &&
        !forceNewConversationalCase &&
        !activeE2ELabSession &&
        routingWebBindings.length > 0 &&
        deterministicPropertyIntent
      ) {
        explicitOperationalIntent = true;
        const startRoute = await routeConversationalMessageAgainstBindings({
          db,
          channel: "web",
          message: effectiveMessage,
          pendingBindings: routingWebBindings,
          explicitIntent: true,
          candidateCasesById: routingCasesById,
          attachments: effectiveAttachments,
        });
        if (startRoute.route === "clarify") {
          // Con adjuntos: el envelope ya quedó en pending_message_jsonb.
          return await respondConversational(startRoute.responseText);
        }
        if (startRoute.route === "case") {
          conversationalCase = startRoute.case;
        }
      }

      // (2) Intención explícita → crear/adoptar caso conversacional.
      if (!conversationalCase) {
        const resolved = await resolveConversationalCaseForChannel({
          db,
          userId: user.id,
          channel: "web",
          message: effectiveMessage,
          forceNewCase: forceNewConversationalCase,
        });
        explicitOperationalIntent = explicitOperationalIntent || resolved.explicitIntent;
        conversationalCase = resolved.case;
        conversationalJustCreated =
          resolved.created ||
          (deterministicPropertyIntent &&
            conversationalCase?.current_step === "intake" &&
            conversationalCase.context_jsonb?.intake_status !== "complete");
      }

      // (2b) Respuesta interno/externo a un caso que espera esa decisión:
      // resolver el caso correcto ANTES del routing genérico para no disparar
      // una desambiguación multi-caso innecesaria. Usa pendingWebBindings
      // (sin filtro E2E) porque la respuesta es inequívoca al prompt del caso.
      if (!conversationalCase) {
        const targetReply = await resolveDocumentTargetReplyAgainstBindings({
          db,
          message: effectiveMessage,
          pendingBindings: pendingWebBindings,
        });
        if (targetReply.matchedCase) {
          conversationalCase = targetReply.matchedCase;
        }
      }

      // (2b-media) Paridad Telegram: adjuntos reales → caso interno de
      // recolección más reciente. El OCR del PDF hace el mensaje demasiado
      // largo para el gate de texto (2c) y caería en clarify multi-caso.
      if (!conversationalCase && effectiveAttachments.length > 0) {
        try {
          const mediaCase = await resolveInternalDocumentUploadCaseForMedia({
            db,
            pendingBindings: pendingWebBindings,
          });
          if (mediaCase) {
            conversationalCase = mediaCase;
            console.info("[chat] media-first case resolved", {
              case_id: mediaCase.id,
              attachment_count: effectiveAttachments.length,
            });
          }
        } catch (err) {
          console.error(
            "[chat] media-first internal case resolution failed:",
            err
          );
        }
      }

      // (2c) Texto de subida ("documentos adjuntos") o cierre de lote ("listo")
      // en ruta interna: asociar al caso interno que recaba documentos, sin
      // desambiguación multi-caso.
      if (!conversationalCase) {
        const uploadReply = await resolveInternalDocumentMessageCase({
          db,
          message: effectiveMessage,
          pendingBindings: routingWebBindings,
        });
        if (uploadReply.matchedCase) {
          conversationalCase = uploadReply.matchedCase;
        }
      }

      // (2d) Respuesta esperada a características faltantes en ruta interna:
      // resolver ANTES del routing genérico para evitar clarificación innecesaria.
      // Usar bindings crudos (como document-target): un caso en ficha mínima no
      // debe perderse por el filtro routable.
      if (!conversationalCase) {
        const characteristicsReply = await resolveCharacteristicsReplyAgainstBindings({
          db,
          message: effectiveMessage,
          pendingBindings: pendingWebBindings,
        });
        if (characteristicsReply.matchedCase) {
          conversationalCase = characteristicsReply.matchedCase;
        }
      }

      // (2e) «continua»: si hay exactamente un caso en contract_pending entre
      // los bindings, le pertenece (con o sin borrador). Evita el aclarador
      // multi-caso contra otro caso en «Solicitar documentos» / intake.
      if (!conversationalCase && isOperationalContinueNudge(effectiveMessage)) {
        const contractCandidates = (
          await Promise.all(
            pendingWebBindings.map((binding) =>
              getOperationalCase(db, binding.case_id)
            )
          )
        ).filter(
          (candidate): candidate is OperationalCase =>
            Boolean(candidate && candidate.current_step === "contract_pending")
        );
        const unique = [
          ...new Map(contractCandidates.map((item) => [item.id, item])).values(),
        ];
        if (unique.length === 1) conversationalCase = unique[0]!;
      }

      // (3) Enrutamiento contra bindings pendientes (asociar o pedir aclaración).
      // Con adjuntos: si hace falta selección se aclara, pero el envelope
      // (texto + staging refs) queda persistido — nunca se pierde el archivo.
      if (!conversationalCase) {
        const routeResult = await routeConversationalMessageAgainstBindings({
          db,
          channel: "web",
          message: effectiveMessage,
          pendingBindings: routingWebBindings,
          explicitIntent: explicitOperationalIntent,
          candidateCasesById: routingCasesById,
          attachments: effectiveAttachments,
        });
        if (routeResult.route === "clarify") {
          return await respondConversational(routeResult.responseText);
        }
        if (routeResult.route === "case") {
          conversationalCase = routeResult.case;
        }
      }

      if (!conversationalCase && deterministicPropertyIntent) {
        console.warn(
          "[chat] deterministic property intent without routable case; forcing deterministic ensure",
          {
            raw_bindings_count: pendingWebBindings.length,
            routable_bindings_count: routingWebBindings.length,
            force_new_requested: forceNewConversationalCase,
            active_e2e_session_id: activeE2ELabSession?.id ?? null,
          }
        );
        const forced = await resolveConversationalCaseForChannel({
          db,
          userId: user.id,
          channel: "web",
          message: effectiveMessage,
          forceNewCase: true,
        });
        explicitOperationalIntent =
          explicitOperationalIntent || forced.explicitIntent;
        conversationalCase = forced.case;
        conversationalJustCreated =
          conversationalJustCreated ||
          forced.created ||
          (conversationalCase?.current_step === "intake" &&
            conversationalCase.context_jsonb?.intake_status !== "complete");
      }

      // (4) Motor de intake determinístico / respuesta de características.
      if (conversationalCase) {
        await touchConversationBindingForCase(db, {
          caseId: conversationalCase.id,
          channel: "web",
          sessionId: session.id,
        }).catch((touchError) => {
          console.warn("[chat] touch conversational web binding failed:", touchError);
        });
      }
      if (
        conversationalCase &&
        (await shouldProcessInternalCharacteristicsReply({
          db,
          opCase: conversationalCase,
          text: effectiveMessage,
        }))
      ) {
        const isE2EControlled = conversationalCase.context_jsonb?.e2e_controlled === true;
        conversationalCase = await processCharacteristicsReplyDeterministically({
          db,
          opCase: conversationalCase,
          text: effectiveMessage,
          source: "web_chat_characteristics_response",
          nextActionAt: isE2EControlled ? null : new Date().toISOString(),
        });
        if (isE2EControlled) {
          void runSettingsTestCaseAgentTick(
            db,
            conversationalCase,
            conversationalCase.user_id,
            {
              source: "web_chat_conversational_e2e_characteristics_response",
              ownerResponseText: effectiveMessage,
            }
          ).catch((tickError) => {
            console.error("[chat] characteristics response tick failed:", tickError);
          });
        } else {
          // Producción: pedir property_data_review de inmediato (paridad
          // Telegram histórica). El sync del chat web trae el bubble de revisión.
          void applyPropertyOptioningPostAgentInvariants({
            db,
            opCase: conversationalCase,
            source: "web_chat_characteristics_response",
          }).catch((invariantError) => {
            console.error(
              "[chat] characteristics post-agent invariants failed:",
              invariantError
            );
          });
        }
        return await respondConversational(
          "Gracias, ya registré la información adicional. La voy a procesar y te aviso el siguiente paso."
        );
      }

      if (conversationalCase) {
        const intakeTurn = await resolveConversationalIntakeTurn({
          db,
          userId: user.id,
          sessionId: session.id,
          opCase: conversationalCase,
          message: effectiveMessage,
          channel: "web",
          justCreated: conversationalJustCreated,
        });
        if (intakeTurn.handled) {
          conversationalCase = intakeTurn.updatedCase;
          if (intakeTurn.shouldRunPostIntakeE2ETick) {
            try {
              await maybeRunPostIntakeConversationalE2ETick({
                db,
                opCase: conversationalCase,
                userId: user.id,
                channel: "web",
              });
            } catch (tickError) {
              console.error("[chat] post-intake E2E tick failed:", tickError);
            }
          }
          return await respondConversational(intakeTurn.responseText ?? "");
        }
        conversationalCase = intakeTurn.updatedCase;
        if (shouldPromptCaseDocumentRequestTarget(conversationalCase)) {
          const choice = await applyDocumentRequestTargetChoice({
            db,
            opCase: conversationalCase,
            message: effectiveMessage,
            channel: "web",
          });
          if (choice.handled) {
            conversationalCase = choice.updatedCase;
            if (choice.shouldRunPostChoiceE2ETick) {
              try {
                await maybeRunPostIntakeConversationalE2ETick({
                  db,
                  opCase: conversationalCase,
                  userId: user.id,
                  channel: "web",
                });
              } catch (tickError) {
                console.error("[chat] post-choice E2E tick failed:", tickError);
              }
            }
            if (choice.externalContactSetupToken) {
              const deepLink = await buildExternalContactDeepLink(
                choice.externalContactSetupToken
              );
              return await respondConversational(
                buildExternalContactSetupMessage({ deepLink })
              );
            }
            return await respondConversational(choice.responseText);
          }
        }
        const attachmentRegistration = await registerInternalCaseAttachments({
          db,
          opCase: conversationalCase,
          attachments: effectiveAttachments,
        });
        conversationalCase = attachmentRegistration.opCase;
        // Paridad Telegram caption+listo: el OCR embebido no debe ocultar la
        // señal de cierre ("listo"). Evaluamos el texto del usuario, no el dump.
        const batchCompleteSignal = looksLikeDocumentBatchComplete(
          stripEmbeddedAttachmentOcr(effectiveMessage)
        );
        const target = resolveOperationalCaseDocumentRequestTarget({
          externalContact: conversationalCase.external_contact_jsonb,
          context: conversationalCase.context_jsonb,
        });
        const canCompleteUploadBatch =
          conversationalCase.current_step === "photos_requested" ||
          (target === "internal_user" &&
            conversationalCase.current_step === "awaiting_documents");

        const finalizeUploadBatchTurn = async () => {
          const source =
            conversationalCase!.current_step === "photos_requested"
              ? "web_chat_internal_photos_marked_ready"
              : "web_chat_internal_documents_marked_ready";
          const completion = await completeUploadBatch({
            db,
            caseId: conversationalCase!.id,
            channel: "web",
            source,
          });
          conversationalCase = completion.case;
          if (
            (completion.status === "advanced" ||
              completion.status === "already_advanced") &&
            conversationalCase.context_jsonb?.e2e_controlled === true
          ) {
            void runSettingsTestCaseAgentTick(
              db,
              conversationalCase,
              conversationalCase.user_id,
              { source }
            ).catch((tickError) => {
              console.error(
                "[chat] upload batch marked ready tick failed:",
                tickError
              );
            });
          }
          return completion;
        };

        if (
          effectiveAttachments.length > 0 &&
          attachmentRegistration.photosAdded > 0 &&
          conversationalCase.current_step === "photos_requested" &&
          !batchCompleteSignal
        ) {
          return await respondConversational(
            photosUploadProgressAckText(attachmentRegistration.rawPhotosCount)
          );
        }
        if (
          effectiveAttachments.length > 0 &&
          caseWaitingContractRevisionUpload(conversationalCase)
        ) {
          const contractAttachment = effectiveAttachments.find((attachment) =>
            isAllowedContractRevisionAttachment(attachment.fileName)
          );
          if (!contractAttachment) {
            return await respondConversational(
              "Para enviar el contrato corregido necesito un archivo DOCX o PDF."
            );
          }
          const sent = await handleContractRevisionUploadAndSend(db, {
            userId: user.id,
            caseId: conversationalCase.id,
            storagePath: contractAttachment.storagePath,
            storageBucket: contractAttachment.storageBucket,
            fileName: contractAttachment.fileName,
          });
          return await respondConversational(
            sent.ok
              ? sent.message ??
                  "Contrato corregido recibido y enviado por email al propietario."
              : sent.message ??
                  "Recibí el archivo, pero no pude enviarlo por email. Revisa Gmail y owner_email."
          );
        }
        // Acuse determinístico ANTES del LLM. Si el mismo turno trae «listo»
        // (paridad Telegram markReadyFromCaption), cerramos el lote aquí.
        if (attachmentRegistration.registered > 0) {
          console.info("[chat] deterministic document ack", {
            case_id: conversationalCase.id,
            current_step: conversationalCase.current_step,
            registered: attachmentRegistration.registered,
            mark_ready: batchCompleteSignal && canCompleteUploadBatch,
          });
          const receiveAck = buildMediaGroupReceivedAck(
            attachmentRegistration.registeredFiles,
            {
              expectMore: !(batchCompleteSignal && canCompleteUploadBatch),
            }
          );
          if (batchCompleteSignal && canCompleteUploadBatch) {
            const completion = await finalizeUploadBatchTurn();
            console.info("[chat] upload+listo batch completed", {
              case_id: conversationalCase.id,
              status: completion.status,
              current_step: conversationalCase.current_step,
            });
            return await respondConversational(
              `${receiveAck}\n\n${completion.ackText}`
            );
          }
          return await respondConversational(receiveAck);
        }
        if (batchCompleteSignal && canCompleteUploadBatch) {
          const completion = await finalizeUploadBatchTurn();
          return await respondConversational(completion.ackText);
        }
        conversationalCaseId = conversationalCase.id;
        operationalToolApprovalPolicy =
          buildOperationalCaseToolApprovalPolicy(conversationalCase);
      }
      if (!conversationalCase && deterministicPropertyIntent) {
        console.error(
          "[chat] deterministic property intent unresolved; aborting LLM fallback",
          {
            raw_bindings_count: pendingWebBindings.length,
            routable_bindings_count: routingWebBindings.length,
            force_new_requested: forceNewConversationalCase,
            active_e2e_session_id: activeE2ELabSession?.id ?? null,
          }
        );
        return await respondConversational(
          "No pude resolver el caso operativo de forma determinística en este momento. Intenta de nuevo en unos segundos para iniciar el intake."
        );
      }
    } catch (err) {
      console.error(
        "[chat] resolve conversational case failed; continuing without case:",
        err
      );
    }

    if (conversationalCaseId) {
      try {
        const contractRecovery = await maybeRecoverContractPendingTurn({
          db,
          userId: user.id,
          caseId: conversationalCaseId,
          channel: "web",
          message,
          effectiveMessage,
          webSessionId: session.id,
        });
        if (contractRecovery.handled) {
          return await respondConversational(contractRecovery.responseText, {
            ...(contractRecovery.assistantStructuredPayload
              ? {
                  assistantStructuredPayload:
                    contractRecovery.assistantStructuredPayload,
                }
              : {}),
          });
        }
      } catch (contractAskError) {
        console.error(
          "[chat] ensure contract commercial ask failed:",
          contractAskError
        );
      }
    }

    if (conversationalCaseId) {
      try {
        const packageRecovery = await maybeRecoverPackageReadyContinue({
          db,
          userId: user.id,
          caseId: conversationalCaseId,
          channel: "web",
          message,
          effectiveMessage,
        });
        if (packageRecovery.handled) {
          return await respondConversational(packageRecovery.responseText);
        }
      } catch (packageReadyContinueError) {
        console.error(
          "[chat] package_ready continue check failed:",
          packageReadyContinueError
        );
      }
    }

    const result = await runAgent({
      message: effectiveMessage,
      turnId: requestTurnId,
      userId: user.id,
      sessionId: session.id,
      caseId: conversationalCaseId,
      toolApprovalPolicy: operationalToolApprovalPolicy,
      systemPrompt:
        (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      enabledSkills: (skillSettings ?? []).map((s: Record<string, unknown>) => ({
        id: s.id as string,
        user_id: s.user_id as string,
        skill_id: s.skill_id as string,
        enabled: s.enabled as boolean,
        config_json: (s.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      userTimezone: (profile?.timezone as string) ?? undefined,
      userName: (profile?.name as string | null) ?? null,
      userEmail: (profile?.email as string | null) ?? null,
      userPhone: (profile?.phone as string | null) ?? null,
      businessBrain:
        (profile?.business_brain as Record<string, unknown> | null) ?? {},
      isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
      channel: "web",
      googleCalendarAccessToken,
      onEvent: (event) => {
        const eventTurnId = event.turnId ?? requestTurnId;
        if (eventTurnId) publishTurnEvent(eventTurnId, event);
      },
    });

    void finalizePropertyOptioningAgentTurn({
      db,
      caseId: conversationalCaseId,
      source: "web_chat_post_agent",
      hasPendingConfirmation: Boolean(result.pendingConfirmation),
    });

    // Flush POST fire-and-forget: solo si el turno cerró (sin pendingConfirmation).
    // Un turno con HITL pendiente no "terminó" todavía; el flush se lanzará
    // cuando el usuario apruebe/rechace y el resume devuelva sin pending.
    if (!result.pendingConfirmation) {
      fireAndForgetFlush({
        db,
        userId: user.id,
        sessionId: session.id,
        memoryFlushPending: result.memoryFlushPending,
      });
    }

    return NextResponse.json({
      response: result.pendingConfirmation ? null : result.response,
      turnId: result.turnId,
      appliedSkills: result.appliedSkills,
      memoryUsed: result.memoryUsed,
      pendingConfirmation: result.pendingConfirmation,
      toolCalls: await loadTurnToolCalls(supabase, {
        sessionId: session.id,
        turnId: result.turnId,
      }),
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
