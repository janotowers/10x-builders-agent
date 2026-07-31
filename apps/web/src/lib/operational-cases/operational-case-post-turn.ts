/**
 * Finalización y recuperaciones post-turno compartidas web ↔ Telegram.
 */
import {
  getOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { contractDraftOutputPathFromContext } from "@agents/agent";
import { ensureContractCommercialDataAsk } from "./ensure-contract-commercial-ask";
import { applyPropertyOptioningPostAgentInvariants } from "./property-optioning-post-agent-invariants";
import { listingDescriptionIsApproved } from "./publication-tool-policy";
import {
  kickContractPendingAfterDataCapture,
  createPublicationRunnerOwnedAgentTick,
} from "./run-settings-test-case-tick";
import { buildContractReviewWebChatPresentation } from "./contract-draft-document";
import { buildHitlActionsForKind } from "./hitl-action-contract";

export function isOperationalContinueNudge(value: string): boolean {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return /^(continua|continuar|sigue|seguir|adelante|reintenta|reintentar|ok|listo)[.!?]?$/.test(
    normalized
  );
}

export async function finalizePropertyOptioningAgentTurn(params: {
  db: DbClient;
  caseId: string | null | undefined;
  source: string;
  /** Si hay pendingConfirmation de tool, no aplicar invariantes. */
  hasPendingConfirmation?: boolean;
}): Promise<{ case: OperationalCase | null; action: string | null }> {
  if (!params.caseId || params.hasPendingConfirmation) {
    return { case: null, action: null };
  }
  const opCase = await getOperationalCase(params.db, params.caseId);
  if (!opCase || opCase.case_type !== "property_optioning") {
    return { case: opCase, action: null };
  }
  try {
    const result = await applyPropertyOptioningPostAgentInvariants({
      db: params.db,
      opCase,
      source: params.source,
    });
    return {
      case: result.case ?? opCase,
      action: typeof result.action === "string" ? result.action : null,
    };
  } catch (error) {
    console.error(
      `[operational-case-post-turn] invariants failed (${params.source}):`,
      error
    );
    return { case: opCase, action: "invariant_error" };
  }
}

async function resolveUnreadContractReviewNotificationId(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<string | null> {
  const { data } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", "contract_review")
    .eq("status", "unread")
    .order("created_at", { ascending: false })
    .limit(1);
  const id = data?.[0]?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export type ContractPendingRecoveryResult =
  | { handled: false }
  | {
      handled: true;
      responseText: string;
      assistantStructuredPayload?: Record<string, unknown>;
    };

/**
 * Recuperación de contract_pending: pedir datos comerciales o generar/entregar
 * borrador. Channel-agnostic; el caller decide cómo renderizar adjuntos web.
 */
export async function maybeRecoverContractPendingTurn(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  channel: "web" | "telegram";
  message: string;
  effectiveMessage?: string;
  /** Solo web: session id para dedupe de bubbles contract_review. */
  webSessionId?: string | null;
}): Promise<ContractPendingRecoveryResult> {
  const opCase = await getOperationalCase(params.db, params.caseId);
  if (
    !opCase ||
    opCase.case_type !== "property_optioning" ||
    opCase.current_step !== "contract_pending"
  ) {
    return { handled: false };
  }

  const ask = await ensureContractCommercialDataAsk({
    db: params.db,
    opCase,
    source: `${params.channel}_contract_pending_ensure`,
  });
  if (ask.asked && ask.text) {
    return { handled: true, responseText: ask.text };
  }
  if (ask.reason !== "no_missing_fields") {
    return { handled: false };
  }

  const hadDraft =
    contractDraftOutputPathFromContext(opCase.context_jsonb) != null;
  const isContinueNudge =
    isOperationalContinueNudge(params.message) ||
    (typeof params.effectiveMessage === "string" &&
      isOperationalContinueNudge(params.effectiveMessage));

  let kickResult: Awaited<
    ReturnType<typeof kickContractPendingAfterDataCapture>
  > | null = null;
  let afterKick = opCase;
  if (!hadDraft) {
    kickResult = await kickContractPendingAfterDataCapture({
      db: params.db,
      opCase,
      source: `${params.channel}_contract_pending_draft_kick`,
    });
    afterKick =
      (await getOperationalCase(params.db, opCase.id)) ?? opCase;
  }

  if (contractDraftOutputPathFromContext(afterKick.context_jsonb) != null) {
    if (!hadDraft || isContinueNudge) {
      if (params.channel === "web" && params.webSessionId) {
        const { data: priorReviews } = await params.db
          .from("agent_messages")
          .select("structured_payload")
          .eq("session_id", params.webSessionId)
          .eq("role", "assistant")
          .eq("structured_payload->>source", "operational_case")
          .eq("structured_payload->>case_id", afterKick.id)
          .eq("structured_payload->>kind", "contract_review")
          .order("created_at", { ascending: false })
          .limit(3);
        const hasActionableReview = (priorReviews ?? []).some((row) => {
          const payload = row.structured_payload as {
            attachments?: unknown;
            notification_id?: unknown;
            actions?: unknown;
          } | null;
          return (
            Array.isArray(payload?.attachments) &&
            payload.attachments.length > 0 &&
            typeof payload?.notification_id === "string" &&
            payload.notification_id.trim().length > 0 &&
            Array.isArray(payload?.actions) &&
            payload.actions.length > 0
          );
        });
        if (hasActionableReview) {
          return {
            handled: true,
            responseText:
              "El borrador ya está arriba (archivo + botones). Usa “Enviar por email” o “Subir contrato corregido y enviar”, o responde en texto.",
          };
        }
        const webPresentation = buildContractReviewWebChatPresentation({
          caseId: afterKick.id,
        });
        const notificationId = await resolveUnreadContractReviewNotificationId(
          params.db,
          params.userId,
          afterKick.id
        );
        return {
          handled: true,
          responseText: webPresentation.text,
          assistantStructuredPayload: {
            source: "operational_case",
            kind: "contract_review",
            case_id: afterKick.id,
            ...(notificationId ? { notification_id: notificationId } : {}),
            actions: buildHitlActionsForKind("contract_review"),
            attachments: [webPresentation.attachment],
          },
        };
      }
      // Telegram: el kick/notify ya envía el DOCX + botones; acuse corto.
      return {
        handled: true,
        responseText: hadDraft
          ? "El borrador de contrato ya está listo arriba (archivo + botones)."
          : "Generé el borrador de contrato. Revísalo con los botones o responde en texto.",
      };
    }
    return { handled: false };
  }

  if (kickResult?.humanWait) {
    const { data: blockers } = await params.db
      .from("internal_user_notifications")
      .select("kind,body")
      .eq("user_id", params.userId)
      .eq("case_id", afterKick.id)
      .eq("status", "unread")
      .in("kind", [
        "contract_template_missing",
        "titularidad_review",
        "document_extraction_failed",
        "contract_data_review",
      ])
      .order("created_at", { ascending: false })
      .limit(1);
    const blocker = blockers?.[0] as { kind?: string; body?: string } | undefined;
    if (typeof blocker?.body === "string" && blocker.body.trim()) {
      return { handled: true, responseText: blocker.body.trim() };
    }
    return {
      handled: true,
      responseText:
        "El borrador quedó detenido por una revisión humana pendiente. Revisa el pendiente del caso para continuar.",
    };
  }

  if (!hadDraft) {
    return {
      handled: true,
      responseText:
        "No pude terminar el borrador en este intento. Dejé el caso programado para reintento y registré el error en Pendientes.",
    };
  }

  return { handled: false };
}

export type PackageReadyContinueResult =
  | { handled: false }
  | { handled: true; responseText: string };

export async function maybeRecoverPackageReadyContinue(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  channel: "web" | "telegram";
  message: string;
  effectiveMessage?: string;
}): Promise<PackageReadyContinueResult> {
  if (
    !isOperationalContinueNudge(params.message) &&
    !(
      typeof params.effectiveMessage === "string" &&
      isOperationalContinueNudge(params.effectiveMessage)
    )
  ) {
    return { handled: false };
  }

  const pkgCase = await getOperationalCase(params.db, params.caseId);
  const pkgContext =
    pkgCase?.context_jsonb &&
    typeof pkgCase.context_jsonb === "object" &&
    !Array.isArray(pkgCase.context_jsonb)
      ? (pkgCase.context_jsonb as Record<string, unknown>)
      : null;
  if (
    !pkgCase ||
    pkgCase.case_type !== "property_optioning" ||
    pkgCase.current_step !== "package_ready" ||
    !listingDescriptionIsApproved(pkgContext)
  ) {
    return { handled: false };
  }

  const { data: pendingPublish } = await params.db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", params.userId)
    .eq("case_id", pkgCase.id)
    .eq("status", "unread")
    .in("kind", [
      "easybroker_publish_approval",
      "ungga_publish_approval",
      "publication_review_required",
    ])
    .limit(1);
  if ((pendingPublish ?? []).length > 0) {
    return { handled: false };
  }

  const source = `${params.channel}_package_ready_continue`;
  const { requestPublicationProgress } = await import(
    "@/lib/operational-cases/publication-runner"
  );
  void requestPublicationProgress(params.db, pkgCase.id, source, {
    runAgentTick: createPublicationRunnerOwnedAgentTick(
      params.db,
      params.userId,
      source
    ),
  }).catch((progressError) => {
    console.error(
      `[operational-case-post-turn] package_ready continue failed (${source}):`,
      progressError
    );
  });

  return {
    handled: true,
    responseText:
      "Retomé la publicación. En un momento te llega la aprobación del siguiente destino (p. ej. EasyBroker).",
  };
}
