/**
 * N4 por decisión HITL de negocio (handler compartido con Telegram/inbox).
 * Patrón: PATTERN_STEP_TEST_BUSINESS_DECISION
 */

import {
  createInternalUserNotification,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import {
  businessDecisionHandler,
  type BusinessDecisionKind,
} from "@/lib/business-decisions/registry";
import {
  buildContractDraftDownloadUrl,
  parseContractDraftFromContext,
} from "@/lib/operational-cases/contract-draft-document";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function latestUnreadNotificationForKind(
  db: DbClient,
  userId: string,
  caseId: string,
  notificationKind: string
) {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .eq("kind", notificationKind)
    .eq("status", "unread")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id as string | undefined;
}

export async function ensureBusinessDecisionNotificationForCase(
  db: DbClient,
  params: {
    userId: string;
    opCase: OperationalCase;
    kind: BusinessDecisionKind;
    title?: string;
    body?: string;
  }
) {
  const handler = businessDecisionHandler(params.kind);
  const existing = await latestUnreadNotificationForKind(
    db,
    params.userId,
    params.opCase.id,
    handler.notificationKind
  );
  if (existing) return existing;

  const created = await createInternalUserNotification(db, {
    userId: params.userId,
    caseId: params.opCase.id,
    kind: handler.notificationKind,
    title: params.title ?? `${handler.label} (prueba N4)`,
    body: params.body ?? "Pendiente de decisión del asesor — caso de prueba en Ajustes.",
    priority: "normal",
    metadata: {
      source: "step_test_business_decision_fixture",
      business_decision_kind: params.kind,
    },
  });
  return created.id;
}

/** Precio: asegura evento price_proposed antes de aplicar decisión del asesor. */
export async function ensurePreDecisionEventsForCase(
  db: DbClient,
  opCase: OperationalCase,
  kind: BusinessDecisionKind
) {
  if (kind === "price_approval") {
    const events = await getRecentOperationalCaseEvents(db, opCase.id, 50);
    const hasProposed = events.some((event) => {
      const payload = event.payload_jsonb;
      return isRecord(payload) && payload.kind === "price_proposed";
    });
    if (hasProposed) return;

    const context = isRecord(opCase.context_jsonb)
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
    const proposal = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "system",
      payload: {
        kind: "price_proposed",
        source: "step_test_business_decision_fixture",
        pricing_proposal: proposal,
      },
    });
    return;
  }

  if (kind === "contract_review") {
    const events = await getRecentOperationalCaseEvents(db, opCase.id, 50);
    const hasDrafted = events.some((event) => {
      const payload = event.payload_jsonb;
      return isRecord(payload) && payload.kind === "contract_drafted";
    });
    if (hasDrafted) return;
    const context = isRecord(opCase.context_jsonb)
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
    const draft = parseContractDraftFromContext(context);
    if (!draft?.output_path?.trim()) return;
    const docUrl = buildContractDraftDownloadUrl(opCase.id);
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "system",
      payload: {
        kind: "contract_drafted",
        source: "step_test_business_decision_fixture",
        doc_url: docUrl,
        output_path: draft.output_path,
        output_bucket: draft.output_bucket,
      },
    });
    return;
  }

  if (kind === "contract_owner_signed") {
    const events = await getRecentOperationalCaseEvents(db, opCase.id, 50);
    const hasSent = events.some((event) => {
      const payload = event.payload_jsonb;
      return (
        isRecord(payload) &&
        (payload.kind === "contract_approved_for_email_send" ||
          payload.purpose === "contract_sent_to_owner")
      );
    });
    if (!hasSent) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "reminder_sent",
        actor: "system",
        payload: {
          purpose: "contract_sent_to_owner",
          source: "step_test_business_decision_fixture",
        },
      });
    }
  }
}

function defaultNotificationBody(
  kind: BusinessDecisionKind,
  opCase: OperationalCase
): string {
  if (kind === "contract_review") {
    return "Borrador de contrato listo para revisión (prueba N4).";
  }
  if (kind === "contract_owner_signed") {
    return "Simulación: dueño devolvió contrato firmado (prueba N4).";
  }
  if (kind !== "price_approval") {
    return "Pendiente de decisión del asesor — caso de prueba.";
  }
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const proposal = isRecord(context.pricing_proposal) ? context.pricing_proposal : null;
  const ideal =
    isRecord(proposal) && typeof proposal.ideal === "number" ? proposal.ideal : 24000;
  return `Propuesta de prueba · ideal $${ideal.toLocaleString("es-MX")} MXN`;
}

export async function runBusinessDecisionStepTest(params: {
  db: DbClient;
  userId: string;
  opCase: OperationalCase;
  kind: BusinessDecisionKind;
  decisionText: string;
}) {
  const handler = businessDecisionHandler(params.kind);
  await ensurePreDecisionEventsForCase(params.db, params.opCase, params.kind);
  const notificationId = await ensureBusinessDecisionNotificationForCase(params.db, {
    userId: params.userId,
    opCase: params.opCase,
    kind: params.kind,
    body: defaultNotificationBody(params.kind, params.opCase),
  });
  const result = await handler.handle(params.db, {
    userId: params.userId,
    notificationId,
    text: params.decisionText,
  });
  if (!result.ok) {
    throw new Error(
      typeof result.message === "string"
        ? result.message
        : `La decisión HITL (${handler.label}) no se aplicó en la prueba.`
    );
  }
  return result;
}

/** @deprecated Usar runBusinessDecisionStepTest con kind price_approval */
export const runPriceApprovalDecisionStepTest = (params: {
  db: DbClient;
  userId: string;
  opCase: OperationalCase;
  decisionText: string;
}) =>
  runBusinessDecisionStepTest({
    ...params,
    kind: "price_approval",
  });
