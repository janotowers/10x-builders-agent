import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  addMessage,
  createOperationalCaseDocument,
  createServerClient,
  decryptToken,
  findPendingConversationBindings,
  getGoogleCalendarAccessToken,
  insertOperationalCaseEvent,
} from "@agents/db";
import { runAgent } from "@agents/agent";
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
  routeConversationalMessageAgainstBindings,
} from "@/lib/operational-cases/conversational-routing-orchestrator";
import { maybeRunPostIntakeConversationalE2ETick } from "@/lib/operational-cases/conversational-e2e-post-intake";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import type { OperationalCase, ToolApprovalPolicy } from "@agents/types";
import { resolveOperationalCaseDocumentRequestTarget } from "@agents/types";
import {
  applyDocumentRequestTargetChoice,
  resolveDocumentTargetReplyAgainstBindings,
  shouldPromptCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";
import {
  completeDocumentBatchForCase,
  looksLikeDocumentBatchComplete,
} from "@/lib/operational-cases/document-batch-completion";

type IncomingAttachment = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageBucket: string;
  storagePath: string;
  sha256: string;
  suggestedKind?: string;
};

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
}): Promise<number> {
  if (params.attachments.length === 0) return 0;
  const target = resolveOperationalCaseDocumentRequestTarget({
    externalContact: params.opCase.external_contact_jsonb,
    context: params.opCase.context_jsonb,
  });
  if (target !== "internal_user" || params.opCase.current_step !== "awaiting_documents") {
    return 0;
  }
  let registered = 0;
  for (const attachment of params.attachments) {
    const document = await createOperationalCaseDocument(params.db, {
      caseId: params.opCase.id,
      userId: params.opCase.user_id,
      kind: attachment.suggestedKind ?? "unknown",
      displayName: attachment.suggestedKind ?? "unknown",
      storageBucket: attachment.storageBucket,
      storagePath: attachment.storagePath,
      originalName: attachment.fileName,
      contentType: attachment.mimeType,
      fileSizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      source: "advisor_web",
      sourceMetadata: {
        source: "chat_web_attachment",
      },
      blocking: (attachment.suggestedKind ?? "unknown") === "escritura_descripcion",
    });
    await insertOperationalCaseEvent(params.db, {
      caseId: params.opCase.id,
      eventType: "external_response",
      actor: "user",
      payload: {
        kind: "document_registered",
        source: "advisor_web_chat",
        document_id: document.id,
        document_kind: document.kind,
      },
    });
    registered += 1;
  }
  return registered;
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
    const incomingAttachments = normalizeIncomingAttachments(body.attachments);

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
    // El mensaje sobre el que se actúa: tras resolver una aclaración, es el
    // mensaje original pendiente, no la respuesta ("1" / "sí").
    let effectiveMessage = message;

    const respondConversational = (responseText: string) => {
      // Persistimos el turno en el historial web para que sobreviva al refresh
      // (Telegram no lo necesita: su historial vive en Telegram).
      return (async () => {
        await addMessage(db, session.id, "user", message, {
          turn_id: requestTurnId ?? null,
        });
        await addMessage(db, session.id, "assistant", responseText, {
          turn_id: requestTurnId ?? null,
        });
        return NextResponse.json({
          response: responseText,
          turnId: requestTurnId ?? null,
          appliedSkills: [],
          memoryUsed: [],
          pendingConfirmation: null,
          toolCalls: [],
        });
      })();
    };

    try {
      let conversationalCase: OperationalCase | null = null;
      let conversationalJustCreated = false;
      let explicitOperationalIntent = false;

      const pendingWebBindings = await findPendingConversationBindings(db, {
        userId: user.id,
        channel: "web",
        statuses: ["awaiting_user", "clarification_needed"],
      });

      // (1) Respuesta a una aclaración multi-caso pendiente.
      const pendingClarification = pendingWebBindings.find(
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
        if (reply.status === "resolved_case" && reply.case) {
          conversationalCase = reply.case;
          if (reply.effectiveMessage) effectiveMessage = reply.effectiveMessage;
        }
      }

      // (2) Intención explícita → crear/adoptar caso conversacional.
      if (!conversationalCase) {
        const resolved = await resolveConversationalCaseForChannel({
          db,
          userId: user.id,
          channel: "web",
          message: effectiveMessage,
        });
        explicitOperationalIntent = resolved.explicitIntent;
        conversationalCase = resolved.case;
        conversationalJustCreated = resolved.created;
      }

      // (2b) Respuesta interno/externo a un caso que espera esa decisión:
      // resolver el caso correcto ANTES del routing genérico para no disparar
      // una desambiguación multi-caso innecesaria.
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

      // (3) Enrutamiento contra bindings pendientes (asociar o pedir aclaración).
      if (!conversationalCase) {
        const routeResult = await routeConversationalMessageAgainstBindings({
          db,
          channel: "web",
          message: effectiveMessage,
          pendingBindings: pendingWebBindings,
          explicitIntent: explicitOperationalIntent,
        });
        if (routeResult.route === "clarify") {
          return await respondConversational(routeResult.responseText);
        }
        if (routeResult.route === "case") {
          conversationalCase = routeResult.case;
        }
      }

      // (4) Motor de intake determinístico.
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
            return await respondConversational(choice.responseText);
          }
        }
        await registerInternalCaseAttachments({
          db,
          opCase: conversationalCase,
          attachments: incomingAttachments,
        });
        const target = resolveOperationalCaseDocumentRequestTarget({
          externalContact: conversationalCase.external_contact_jsonb,
          context: conversationalCase.context_jsonb,
        });
        if (
          target === "internal_user" &&
          conversationalCase.current_step === "awaiting_documents" &&
          looksLikeDocumentBatchComplete(effectiveMessage)
        ) {
          const completion = await completeDocumentBatchForCase({
            db,
            caseId: conversationalCase.id,
            channel: "web",
            source: "web_chat_internal_documents_marked_ready",
          });
          if (completion.status === "no_documents") {
            return await respondConversational(
              "Aún no veo documentos registrados en el caso. Sube al menos uno y luego escribe “listo”."
            );
          }
          if (completion.status === "failed") {
            return await respondConversational(
              "Registré tu confirmación, pero no pude avanzar el caso en este momento. Intenta de nuevo en unos segundos."
            );
          }
          conversationalCase = completion.case;
          if (conversationalCase.context_jsonb?.e2e_controlled === true) {
            void runSettingsTestCaseAgentTick(
              db,
              conversationalCase,
              conversationalCase.user_id,
              { source: "web_chat_internal_documents_marked_ready" }
            ).catch((tickError) => {
              console.error(
                "[chat] internal documents marked ready tick failed:",
                tickError
              );
            });
          }
          return await respondConversational(
            "Perfecto, marqué el caso como documentos recibidos y continúo con la extracción."
          );
        }
        conversationalCaseId = conversationalCase.id;
        operationalToolApprovalPolicy =
          buildOperationalCaseToolApprovalPolicy(conversationalCase);
      }
    } catch (err) {
      console.error(
        "[chat] resolve conversational case failed; continuing without case:",
        err
      );
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
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
