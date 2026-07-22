/**
 * Shared pending-decision router (Telegram/web parity).
 *
 * Before a free-text turn reaches the generic agent, decision-owning HITL
 * notifications get first claim on the message. This module ports the
 * Telegram webhook's text gates so the web chat can run the exact same
 * deterministic routing before `runAgent`:
 *
 *   0. read-only case queries (price/status) answered deterministically,
 *      without resolving notifications or mutating case state
 *   1. listing_description_review (incl. read_artifact + pending «Pedir
 *      cambios» reply intent + competing-intake guard)
 *   2. price_approval
 *   3. contract_data_review (claims any pending text, except clearly
 *      interrogative data-free side questions, which escape to the agent)
 *   4. contract_review (incl. contract_pending with no missing fields)
 *   5. titularidad_review
 *   6. comparables_search_expansion_decision
 *
 * `property_data_review` stays in the Telegram webhook: it is bound to the
 * external contact's chat and has no web-chat equivalent.
 *
 * Message ordering: when `deferChannelTicks` is true (Telegram), E2E ticks and
 * follow-up notifications are returned as `runAfterReply` so the caller can
 * deliver the confirmation message first. On web the handlers fire their own
 * non-blocking ticks (same as the pending-inbox API routes).
 */

import {
  findPendingConversationBindings,
  getOperationalCase,
  listInternalUserNotifications,
  type DbClient,
} from "@agents/db";
import type { InternalUserNotification, OperationalCase } from "@agents/types";
import { notifyPriceApprovalForCase } from "@agents/agent";
import { notify } from "@/lib/notify";
import { businessDecisionHandler } from "./registry";
import {
  parsePriceApprovalDecision,
  runDeferredControlledE2ETick,
} from "./price-approval";
import {
  parseContractReviewDecision,
  runDeferredContractControlledE2ETick,
} from "./contract-review";
import { parseTitularidadReviewDecision } from "./titularidad-review";
import {
  runDeferredListingDescriptionControlledE2ETick,
  shouldRouteTelegramTextToListingDescriptionReview,
} from "./listing-description-review";
import {
  handleComparablesExpansionDecision,
  parseComparablesExpansionDecision,
} from "./comparables-expansion-decision";
import {
  formatCaseStatusQueryAnswer,
  formatPricingProposalQueryAnswer,
  looksLikeSideQuestionNotData,
  parseCaseQueryIntent,
  type CaseQueryIntent,
} from "./case-query";
import { caseContextFromOperationalCase } from "@/lib/notifications/enrich-case-context";
import { isIntakeInProgress } from "@/lib/operational-cases/telegram-intake-completion-message";

export type PendingDecisionChannel = "telegram" | "web";

export type PendingDecisionTurnParams = {
  userId: string;
  text: string;
  channel: PendingDecisionChannel;
  /** Telegram chat id (scopes intake-competition bindings). */
  chatId?: number | null;
  /** True for slash commands (Telegram); commands never claim decisions. */
  isCommand?: boolean;
  /** Deterministic start-case intent (e.g. "quiero opcionar una propiedad"). */
  isExplicitNewCaseIntent?: boolean;
  /** Preloaded unread notifications; avoids a duplicate query when the caller already has them. */
  pendingNotifications?: InternalUserNotification[];
  /**
   * Defer E2E ticks / follow-up notifies into `runAfterReply` so the caller
   * controls message order (Telegram). Defaults to channel === "telegram".
   */
  deferChannelTicks?: boolean;
};

export type PendingDecisionTurn =
  | { handled: false }
  | {
      handled: true;
      routed: string;
      ok: boolean;
      status?: string;
      caseId?: string | null;
      notificationId?: string | null;
      decision?: string;
      /** User-facing confirmation/rejection text (channel-neutral). */
      message: string;
      /** read_artifact: full draft; Telegram sends .txt, web inlines it. */
      artifact?: { filename: string; content: string } | null;
      /** Run after the reply is delivered (deferred ticks/notifies). */
      runAfterReply?: () => Promise<void>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `contract_pending` counts as an actionable contract review only when the
 * notification carries no missing required fields (mirrors the webhook).
 */
export function isActionableContractReviewNotification(notification: {
  kind: string;
  metadata_jsonb?: unknown;
}): boolean {
  if (notification.kind === "contract_review") return true;
  if (notification.kind !== "contract_pending") return false;
  const metadata = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  const raw = metadata.missing_required_fields;
  const missing = Array.isArray(raw)
    ? raw.filter(
        (field): field is string =>
          typeof field === "string" && field.trim().length > 0
      )
    : [];
  return missing.length === 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function runDeferredTickFromResult(
  db: DbClient,
  result: { ok?: boolean; case_id?: unknown; deferredControlledE2ETick?: unknown },
  runner: (db: DbClient, caseId: string, source: string) => Promise<void>,
  fallbackSource: string,
  label: string
): Promise<void> {
  if (!result.ok) return;
  const caseId = typeof result.case_id === "string" ? result.case_id : null;
  const deferred = result.deferredControlledE2ETick;
  if (!deferred || !caseId) return;
  const source =
    isRecord(deferred) && typeof deferred.source === "string"
      ? deferred.source
      : fallbackSource;
  try {
    await runner(db, caseId, source);
  } catch (tickError) {
    console.error(`[pending-decision-router] deferred ${label} tick failed:`, tickError);
  }
}

/**
 * Resolves the target case for a read-only query and formats the answer.
 * Returns null on ambiguity or missing data — the turn then falls through to
 * the conversational routing/agent instead of guessing. Never resolves
 * notifications nor mutates case state.
 */
async function answerCaseQuery(
  db: DbClient,
  params: {
    userId: string;
    channel: PendingDecisionChannel;
    chatId?: number | null;
    intent: CaseQueryIntent;
    pendingInternal: InternalUserNotification[];
  }
): Promise<{ caseId: string; message: string } | null> {
  const notificationCaseIds = params.pendingInternal
    .map((notification) => notification.case_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  let bindingCaseIds: string[] = [];
  try {
    const bindings = await findPendingConversationBindings(db, {
      userId: params.userId,
      channel: params.channel,
      chatId: params.channel === "telegram" ? params.chatId : undefined,
    });
    bindingCaseIds = bindings.map((binding) => binding.case_id);
  } catch (bindingError) {
    console.warn(
      "[pending-decision-router] case-query bindings lookup failed:",
      bindingError
    );
  }

  const loadOwnedCase = async (caseId: string): Promise<OperationalCase | null> => {
    const opCase = await getOperationalCase(db, caseId);
    return opCase && opCase.user_id === params.userId ? opCase : null;
  };

  if (params.intent === "price") {
    // Prefer the case of an unread price_approval; else the single candidate
    // case that actually carries a pricing_proposal.
    const priceNotification = params.pendingInternal.find(
      (notification) =>
        notification.kind === "price_approval" &&
        typeof notification.case_id === "string"
    );
    const orderedCandidates = [
      ...(priceNotification?.case_id ? [priceNotification.case_id] : []),
      ...notificationCaseIds,
      ...bindingCaseIds,
    ];
    const seen = new Set<string>();
    const withProposal: Array<{ caseId: string; message: string }> = [];
    for (const caseId of orderedCandidates) {
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      const opCase = await loadOwnedCase(caseId);
      if (!opCase) continue;
      const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
      const message = formatPricingProposalQueryAnswer(context.pricing_proposal);
      if (message) withProposal.push({ caseId, message });
    }
    if (priceNotification?.case_id) {
      const preferred = withProposal.find(
        (candidate) => candidate.caseId === priceNotification.case_id
      );
      if (preferred) return preferred;
    }
    return withProposal.length === 1 ? withProposal[0] : null;
  }

  // status: only answer when the turn maps to exactly one candidate case.
  const distinctCaseIds = [
    ...new Set([...notificationCaseIds, ...bindingCaseIds]),
  ];
  if (distinctCaseIds.length !== 1) return null;
  const opCase = await loadOwnedCase(distinctCaseIds[0]);
  if (!opCase) return null;
  const pendingKinds = params.pendingInternal
    .filter((notification) => notification.case_id === opCase.id)
    .map((notification) => notification.kind);
  return {
    caseId: opCase.id,
    message: formatCaseStatusQueryAnswer({
      context: caseContextFromOperationalCase(opCase),
      pendingKinds,
    }),
  };
}

export async function resolvePendingDecisionTurn(
  db: DbClient,
  params: PendingDecisionTurnParams
): Promise<PendingDecisionTurn> {
  const text = params.text ?? "";
  if (!text.trim()) return { handled: false };
  const deferTicks = params.deferChannelTicks ?? params.channel === "telegram";

  const pendingInternal =
    params.pendingNotifications ??
    (await listInternalUserNotifications(db, params.userId, {
      statuses: ["unread"],
      limit: 30,
    }));

  // ---- Gate 0: read-only case queries (price/status) ----------------------
  // Answers known side questions deterministically without closing pendings.
  // On ambiguity (no case / several cases / missing data) it falls through.
  const queryIntent =
    params.isCommand || params.isExplicitNewCaseIntent === true
      ? null
      : parseCaseQueryIntent(text);
  if (queryIntent) {
    try {
      const answer = await answerCaseQuery(db, {
        userId: params.userId,
        channel: params.channel,
        chatId: params.chatId,
        intent: queryIntent,
        pendingInternal,
      });
      if (answer) {
        return {
          handled: true,
          routed: `case_query_${queryIntent}`,
          ok: true,
          status: "answered",
          caseId: answer.caseId,
          message: answer.message,
        };
      }
    } catch (queryError) {
      console.error(
        "[pending-decision-router] case query failed; falling through:",
        queryError
      );
    }
  }

  // ---- Gate 1: listing_description_review -------------------------------
  const pendingListingDescriptionReviews = pendingInternal.filter(
    (notification) => notification.kind === "listing_description_review"
  );
  const pendingListingDescriptionReply = pendingListingDescriptionReviews.find(
    (notification) => {
      const metadata = isRecord(notification.metadata_jsonb)
        ? notification.metadata_jsonb
        : {};
      return metadata.telegram_pending_reply_intent === "request_changes";
    }
  );
  const listingDescriptionReviewTarget =
    pendingListingDescriptionReply ?? pendingListingDescriptionReviews[0];

  // An incomplete conversational intake owned by this chat must beat a sticky
  // keyword listing-description HITL from another (often stale) case. An
  // explicit «Pedir cambios» pending-reply intent still wins.
  let hasCompetingActiveConversationalIntake = false;
  if (pendingListingDescriptionReviews.length > 0) {
    const earlyPendingBindings = await findPendingConversationBindings(db, {
      userId: params.userId,
      channel: params.channel,
      chatId: params.channel === "telegram" ? params.chatId : undefined,
    });
    const reviewCaseId =
      typeof listingDescriptionReviewTarget?.case_id === "string"
        ? listingDescriptionReviewTarget.case_id
        : null;
    for (const binding of earlyPendingBindings) {
      if (reviewCaseId && binding.case_id === reviewCaseId) continue;
      const boundCase = await getOperationalCase(db, binding.case_id);
      if (
        boundCase &&
        boundCase.status !== "paused" &&
        boundCase.status !== "completed" &&
        boundCase.status !== "failed" &&
        isIntakeInProgress(boundCase)
      ) {
        hasCompetingActiveConversationalIntake = true;
        break;
      }
    }
  }

  const shouldRouteListingDescriptionText =
    shouldRouteTelegramTextToListingDescriptionReview({
      text,
      isTelegramCommand: params.isCommand,
      pendingReviewCount: pendingListingDescriptionReviews.length,
      hasPendingReplyIntent: Boolean(pendingListingDescriptionReply),
      isExplicitNewCaseIntent: params.isExplicitNewCaseIntent === true,
      hasCompetingActiveConversationalIntake,
    });
  if (shouldRouteListingDescriptionText && listingDescriptionReviewTarget) {
    const result = await businessDecisionHandler(
      "listing_description_review"
    ).handle(db, {
      userId: params.userId,
      notificationId: listingDescriptionReviewTarget.id,
      text,
      deferControlledE2ETick: deferTicks,
    });
    const artifact =
      result.status === "artifact_text" &&
      isRecord(result.artifact) &&
      typeof result.artifact.content === "string" &&
      typeof result.artifact.filename === "string"
        ? {
            filename: result.artifact.filename,
            content: result.artifact.content,
          }
        : null;
    if (artifact) {
      return {
        handled: true,
        routed: "listing_description_artifact_sent",
        ok: true,
        status: "artifact_text",
        caseId: stringOrNull(result.case_id),
        notificationId: listingDescriptionReviewTarget.id,
        message:
          result.message ?? "Te comparto el borrador completo de la descripción.",
        artifact,
      };
    }
    return {
      handled: true,
      routed: result.ok
        ? "listing_description_review"
        : "listing_description_review_rejected",
      ok: result.ok === true,
      status: result.status,
      caseId: stringOrNull(result.case_id),
      notificationId: listingDescriptionReviewTarget.id,
      message:
        result.message ??
        (result.ok
          ? "Listo, procesé tu revisión de descripción."
          : "No pude procesar la revisión de descripción."),
      runAfterReply: deferTicks
        ? () =>
            runDeferredTickFromResult(
              db,
              result,
              runDeferredListingDescriptionControlledE2ETick,
              "listing_description_approved",
              "listing-description"
            )
        : undefined,
    };
  }
  if (
    pendingListingDescriptionReviews.length > 0 &&
    (params.isExplicitNewCaseIntent === true ||
      hasCompetingActiveConversationalIntake)
  ) {
    console.info(
      "[pending-decision-router] bypassing listing_description_review for active conversational turn",
      {
        channel: params.channel,
        pending_review_count: pendingListingDescriptionReviews.length,
        pending_reply_intent: Boolean(pendingListingDescriptionReply),
        notification_id: listingDescriptionReviewTarget?.id ?? null,
        explicit_optioning_intent: params.isExplicitNewCaseIntent === true,
        competing_active_intake: hasCompetingActiveConversationalIntake,
      }
    );
  }

  // ---- Gate 2: price_approval --------------------------------------------
  const parsedPriceDecision = parsePriceApprovalDecision(text);
  if (parsedPriceDecision.intent !== "unclear") {
    const pendingPriceApproval = pendingInternal.find(
      (notification) => notification.kind === "price_approval"
    );
    if (pendingPriceApproval) {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId: params.userId,
        notificationId: pendingPriceApproval.id,
        text,
        deferControlledE2ETick: deferTicks,
      });
      return {
        handled: true,
        routed: "price_approval",
        ok: result.ok === true,
        status: result.status,
        caseId: stringOrNull(result.case_id),
        notificationId: pendingPriceApproval.id,
        message:
          result.message ??
          (result.ok
            ? "Listo, procese tu decision de precio."
            : "No pude procesar la decision de precio."),
        runAfterReply: deferTicks
          ? () =>
              runDeferredTickFromResult(
                db,
                result,
                runDeferredControlledE2ETick,
                "price_approved",
                "price"
              )
          : undefined,
      };
    }
  }

  // ---- Gate 3: contract_data_review (claims any pending text) -------------
  const pendingContractData = pendingInternal.find(
    (notification) => notification.kind === "contract_data_review"
  );
  if (pendingContractData && looksLikeSideQuestionNotData(text)) {
    // Clearly interrogative, data-free message: let the agent answer instead
    // of dead-ending in "No pude registrar los datos contractuales". The
    // notification stays unread, so the gate keeps claiming real data replies.
    console.info(
      "[pending-decision-router] contract_data_review: side question escapes to agent",
      {
        channel: params.channel,
        notification_id: pendingContractData.id,
        case_id: pendingContractData.case_id ?? null,
      }
    );
  } else if (pendingContractData) {
    // Always route free text through the central handler (hybrid extractor +
    // deterministic judge). Never fall through silently on unclear replies.
    const result = await businessDecisionHandler("contract_data_review").handle(
      db,
      {
        userId: params.userId,
        notificationId: pendingContractData.id,
        text,
      }
    );
    return {
      handled: true,
      routed: "contract_data_review",
      ok: result.ok === true,
      status: result.status,
      caseId: stringOrNull(result.case_id),
      notificationId: pendingContractData.id,
      message:
        result.message ??
        (result.ok
          ? result.status === "partial"
            ? "Registré parte de los datos. Aún faltan pendientes del contrato."
            : "Listo, registré los datos contractuales."
          : "No pude registrar los datos contractuales."),
    };
  }

  // ---- Gate 4: contract_review --------------------------------------------
  const parsedContractDecision = parseContractReviewDecision(text);
  if (parsedContractDecision.intent !== "unclear") {
    const pendingContractReview = pendingInternal.find((notification) =>
      isActionableContractReviewNotification(notification)
    );
    if (pendingContractReview) {
      const result = await businessDecisionHandler("contract_review").handle(db, {
        userId: params.userId,
        notificationId: pendingContractReview.id,
        text,
        deferControlledE2ETick: deferTicks,
      });
      return {
        handled: true,
        routed: "contract_review",
        ok: result.ok === true,
        status: result.status,
        caseId: stringOrNull(result.case_id),
        notificationId: pendingContractReview.id,
        message:
          result.message ??
          (result.ok
            ? "Listo, procesé tu decisión sobre el contrato."
            : "No pude procesar la decisión del contrato."),
        runAfterReply: deferTicks
          ? () =>
              runDeferredTickFromResult(
                db,
                result,
                runDeferredContractControlledE2ETick,
                "contract_email_sent",
                "contract"
              )
          : undefined,
      };
    }
  }

  // ---- Gate 5: titularidad_review ------------------------------------------
  const parsedTitularidadDecision = parseTitularidadReviewDecision(text);
  if (parsedTitularidadDecision.intent !== "unclear") {
    const pendingTitularidadReview = pendingInternal.find(
      (notification) => notification.kind === "titularidad_review"
    );
    if (pendingTitularidadReview) {
      const result = await businessDecisionHandler("titularidad_review").handle(
        db,
        {
          userId: params.userId,
          notificationId: pendingTitularidadReview.id,
          text,
        }
      );
      return {
        handled: true,
        routed: "titularidad_review",
        ok: result.ok === true,
        status: result.status,
        caseId: stringOrNull(result.case_id),
        notificationId: pendingTitularidadReview.id,
        message:
          result.message ??
          (result.ok
            ? "Titularidad aprobada. Generaré el contrato."
            : "No pude procesar la decisión de titularidad."),
      };
    }
  }

  // ---- Gate 6: comparables_search_expansion_decision -----------------------
  if (parseComparablesExpansionDecision(text) !== "unclear") {
    const comparablesDecisionCandidates = (
      await Promise.all(
        pendingInternal
          .filter(
            (notification) =>
              notification.kind === "comparables_search_expansion_decision"
          )
          .map(async (notification) => {
            if (!notification.case_id) return null;
            const opCase = await getOperationalCase(db, notification.case_id);
            if (!opCase || opCase.user_id !== params.userId) return null;
            if (opCase.current_step !== "comparables_in_progress") return null;
            return { notification, opCase };
          })
      )
    ).filter(
      (
        candidate
      ): candidate is {
        notification: InternalUserNotification;
        opCase: OperationalCase;
      } => Boolean(candidate)
    );

    if (comparablesDecisionCandidates.length > 0) {
      // pendingInternal ya viene en orden de recencia; tomamos el primero vigente.
      const { notification, opCase } = comparablesDecisionCandidates[0]!;
      const result = await handleComparablesExpansionDecision(db, {
        userId: params.userId,
        notificationId: notification.id,
        text,
        source: params.channel,
        deferPriceApprovalNotify: deferTicks,
      });
      const runAfterReply = async () => {
        // Orden de mensajes: tras confirmar la decisión, disparamos la
        // notificación de precio que quedó diferida dentro del handler.
        if (
          deferTicks &&
          result.ok &&
          result.status === "processed" &&
          result.deferredPriceApproval &&
          result.case_id
        ) {
          try {
            await notifyPriceApprovalForCase({
              db,
              caseId: result.case_id,
              userId: params.userId,
              pricingProposal: result.deferredPriceApproval.pricingProposal,
              source: `comparables_decision_${params.channel}_${result.decision}`,
              notifyUser: async (notifyDb, notifyUserId, payload, urgency) =>
                notify(notifyDb, notifyUserId, payload, urgency),
            });
          } catch (notifyError) {
            console.error(
              "[pending-decision-router] deferred price approval notify failed:",
              notifyError
            );
          }
        }
        if (
          result.ok &&
          result.status === "processed" &&
          result.decision === "expand_search" &&
          opCase.context_jsonb?.e2e_controlled === true &&
          result.case_id
        ) {
          const { runSettingsTestCaseAgentTick } = await import(
            "@/lib/operational-cases/run-settings-test-case-tick"
          );
          const refreshedCase = await getOperationalCase(db, result.case_id);
          if (refreshedCase) {
            void runSettingsTestCaseAgentTick(
              db,
              refreshedCase,
              refreshedCase.user_id,
              {
                // Keep the historical telegram source string for traceability.
                source:
                  params.channel === "telegram"
                    ? "telegram_webhook_conversational_e2e_comparables_expand_search"
                    : "web_chat_conversational_e2e_comparables_expand_search",
                ownerResponseText: text,
              }
            ).catch((tickError) => {
              console.error(
                "[pending-decision-router] comparables decision tick failed:",
                tickError
              );
            });
          }
        }
      };
      return {
        handled: true,
        routed:
          result.ok && result.status === "processed"
            ? "comparables_expansion_decision"
            : "comparables_expansion_decision_rejected",
        ok: result.ok === true,
        status: result.status,
        caseId: result.case_id ?? opCase.id,
        notificationId: result.notification_id ?? notification.id,
        decision: result.decision,
        message: result.message ?? "No pude procesar esa decisión todavía.",
        runAfterReply,
      };
    }
  }

  return { handled: false };
}
