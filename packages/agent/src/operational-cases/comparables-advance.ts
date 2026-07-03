import {
  getOperationalCase,
  insertOperationalCaseEvent,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import {
  comparablesHasDefensibleSample,
  comparablesUsableCount,
} from "./comparables-analysis";
import {
  buildPricingProposalFromComparables,
  formatPriceApprovalNotifyText,
  type PricingProposal,
} from "./pricing-proposal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function priceApprovalEventHasDeliveredNotification(payload: unknown): boolean {
  if (!isRecord(payload) || payload.kind !== "price_approval_requested") return false;
  const delivered = payload.notify_delivered;
  if (!Array.isArray(delivered)) return false;
  return delivered.some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as { ok?: boolean }).ok === true
  );
}

export function priceApprovalEventHasDeliveredNotificationForTest(payload: unknown): boolean {
  return priceApprovalEventHasDeliveredNotification(payload);
}

/** Área del inmueble para base de precio por m² (construida preferida). */
export function subjectAreaFromCaseContext(context: Record<string, unknown> | null): {
  area: number | null;
  basis: "construction" | "total" | null;
} {
  const propertyData = isRecord(context?.property_data) ? context.property_data : context ?? {};
  const construction = positiveNumberOrNull(
    propertyData.area_construida_m2 ??
      propertyData.construction_area_m2 ??
      propertyData.built_area_m2 ??
      propertyData.sup_const
  );
  if (construction != null) return { area: construction, basis: "construction" };
  const total = positiveNumberOrNull(
    propertyData.area_total_m2 ??
      propertyData.terreno ??
      propertyData.area_m2 ??
      propertyData.surface_m2 ??
      propertyData.sup_terr
  );
  if (total != null) return { area: total, basis: "total" };
  return { area: null, basis: null };
}

export type AdvanceComparablesResult = {
  case: OperationalCase | null;
  advanced: boolean;
  pricingProposal: PricingProposal | null;
  skipReason?: string;
};

/**
 * Avanza determinísticamente de `comparables_in_progress` a
 * `price_proposal_pending` cuando hay muestra defendible, tolerando
 * conflictos de versión. Genera `pricing_proposal` en el mismo write.
 */
export async function advanceComparablesToPriceProposalWithRetry(params: {
  db: DbClient;
  opCase: OperationalCase;
  source: string;
  maxAttempts?: number;
  allowLimitedSample?: boolean;
  preferAvaclickPrimary?: boolean;
}): Promise<AdvanceComparablesResult> {
  const { db, source } = params;
  const maxAttempts = params.maxAttempts ?? 4;
  let current = params.opCase;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (current.current_step === "price_proposal_pending") {
      const ctx = isRecord(current.context_jsonb) ? current.context_jsonb : {};
      const existing = isRecord(ctx.pricing_proposal)
        ? (ctx.pricing_proposal as PricingProposal)
        : null;
      return { case: current, advanced: false, pricingProposal: existing };
    }
    if (current.current_step !== "comparables_in_progress") {
      return {
        case: current,
        advanced: false,
        pricingProposal: null,
        skipReason: `wrong_step:${current.current_step ?? "none"}`,
      };
    }

    const freshContext = isRecord(current.context_jsonb) ? current.context_jsonb : {};
    const freshAnalysis = isRecord(freshContext.comparables_analysis)
      ? freshContext.comparables_analysis
      : null;
    const hasDefensibleSample = freshAnalysis
      ? comparablesHasDefensibleSample(freshAnalysis)
      : false;
    const hasUsableComparables = freshAnalysis
      ? comparablesUsableCount(freshAnalysis) > 0
      : false;
    const avaclick =
      freshAnalysis && isRecord(freshAnalysis.external_valuation)
        ? freshAnalysis.external_valuation
        : null;
    const hasAvaclickValuation =
      positiveNumberOrNull(avaclick?.sale_average_mxn) != null;
    const wantsAvaclickPrimary = params.preferAvaclickPrimary === true;
    const preferAvaclickPrimary = Boolean(
      wantsAvaclickPrimary && hasAvaclickValuation
    );
    const allowLimitedSample = Boolean(
      params.allowLimitedSample && hasUsableComparables
    );
    if (
      !freshAnalysis ||
      (!hasDefensibleSample && !allowLimitedSample && !preferAvaclickPrimary)
    ) {
      return {
        case: current,
        advanced: false,
        pricingProposal: null,
        skipReason: wantsAvaclickPrimary && !hasAvaclickValuation
          ? "avaclick_valuation_missing"
          : "sample_not_defensible",
      };
    }

    const subject = subjectAreaFromCaseContext(freshContext);
    const pricingProposal = buildPricingProposalFromComparables({
      analysis: freshAnalysis,
      subjectAreaM2: subject.area,
      areaBasis: subject.basis,
      preferAvaclickPrimary,
    });
    if (!pricingProposal) {
      await insertOperationalCaseEvent(db, {
        caseId: current.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "comparables_advance_skipped",
          source,
          reason: "pricing_proposal_build_failed",
          attempt,
        },
      });
      return {
        case: current,
        advanced: false,
        pricingProposal: null,
        skipReason: "pricing_proposal_build_failed",
      };
    }

    const updated = await updateOperationalCase(db, current.id, current.version, {
      status: "waiting_internal",
      currentStep: "price_proposal_pending",
      nextActionAt: new Date().toISOString(),
      context: { ...freshContext, pricing_proposal: pricingProposal },
    });
    if (updated) {
      await insertOperationalCaseEvent(db, {
        caseId: updated.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "comparables_in_progress",
        payload: {
          kind: "comparables_analysis_completed",
          source,
          attempt,
          current_step: "comparables_in_progress",
          pricing_proposal_generated: true,
          pricing_proposal_basis: pricingProposal.basis,
          to: {
            current_step: "price_proposal_pending",
            status: "waiting_internal",
          },
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: updated.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "price_proposal_pending",
        payload: {
          kind: "price_proposal_prepared",
          source,
          current_step: "price_proposal_pending",
          pricing_proposal_basis: pricingProposal.basis,
          subject_area_m2: pricingProposal.subject_area_m2,
          source_summary: pricingProposal.per_source.map((item) => ({
            source: item.source,
            sample_size: item.sample_size,
          })),
        },
      });
      return { case: updated, advanced: true, pricingProposal };
    }

    const reloaded = await getOperationalCase(db, current.id);
    if (!reloaded) {
      return {
        case: null,
        advanced: false,
        pricingProposal: null,
        skipReason: "case_not_found_after_reload",
      };
    }
    current = reloaded;
  }

  await insertOperationalCaseEvent(db, {
    caseId: current.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "comparables_advance_version_conflict",
      source,
      attempts: maxAttempts,
      current_step: current.current_step,
      version: current.version,
    },
  });
  return {
    case: current,
    advanced: false,
    pricingProposal: null,
    skipReason: "version_conflict",
  };
}

export type NotifyUserFn = (
  db: DbClient,
  userId: string,
  payload: { text: string; kind?: string; data?: Record<string, unknown> },
  urgency?: "low" | "normal" | "high"
) => Promise<{
  delivered: Array<{ channel: string; ok: boolean; reason?: string }>;
  attempted: Array<{ channel: string; ok: boolean; reason?: string }>;
}>;

/**
 * Notifica `price_approval` para un caso que ya tiene `pricing_proposal`
 * preparada, con dedupe idempotente (por evento entregado y por notificación
 * sin leer) y registra el evento `price_approval_requested` en el paso de
 * precio. Reutilizable por el avance automático y por los flujos que difieren
 * la notificación para controlar el orden de mensajes (p. ej. Telegram, donde
 * la confirmación de la decisión debe llegar antes que la propuesta).
 */
export async function notifyPriceApprovalForCase(params: {
  db: DbClient;
  caseId: string;
  userId: string;
  pricingProposal: PricingProposal;
  source: string;
  notifyUser: NotifyUserFn;
}): Promise<{ notified: boolean }> {
  const { db, caseId, userId, pricingProposal, source, notifyUser } = params;

  const hasUnreadPriceApprovalNotification = async (): Promise<boolean> => {
    const { data, error } = await db
      .from("internal_user_notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("case_id", caseId)
      .eq("kind", "price_approval")
      .eq("status", "unread")
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  };

  const recentEvents = await db
    .from("operational_case_events")
    .select("payload_jsonb,created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(15);
  const alreadyNotifiedByEvent = (recentEvents.data ?? []).some((row) => {
    const payload = isRecord((row as { payload_jsonb?: unknown }).payload_jsonb)
      ? ((row as { payload_jsonb: Record<string, unknown> }).payload_jsonb as Record<
          string,
          unknown
        >)
      : null;
    return priceApprovalEventHasDeliveredNotification(payload);
  });
  const alreadyNotifiedByUnread = await hasUnreadPriceApprovalNotification();
  if (alreadyNotifiedByEvent || alreadyNotifiedByUnread) {
    return { notified: false };
  }

  const text = formatPriceApprovalNotifyText(pricingProposal);
  const notifyResult = await notifyUser(
    db,
    userId,
    {
      text,
      kind: "price_approval",
      data: {
        case_id: caseId,
        artifact_key: "pricing_proposal",
        actions: ["approve", "adjust", "reject"],
      },
    },
    "normal"
  );

  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "human_decision",
    actor: "system",
    stepKey: "price_proposal_pending",
    payload: {
      kind: "price_approval_requested",
      source,
      current_step: "price_proposal_pending",
      notify_delivered: notifyResult.delivered,
    },
  });

  return { notified: notifyResult.delivered.length > 0 };
}

/**
 * Tras persistir comparables con muestra defendible: avanza paso, genera
 * pricing_proposal y (opcional) notifica price_approval con números concretos.
 */
export async function tryAdvanceComparablesAfterPersist(params: {
  db: DbClient;
  opCase: OperationalCase;
  userId: string;
  source: string;
  notifyUser?: NotifyUserFn;
  allowLimitedSample?: boolean;
  preferAvaclickPrimary?: boolean;
}): Promise<AdvanceComparablesResult & { notified: boolean }> {
  const advance = await advanceComparablesToPriceProposalWithRetry({
    db: params.db,
    opCase: params.opCase,
    source: params.source,
    allowLimitedSample: params.allowLimitedSample,
    preferAvaclickPrimary: params.preferAvaclickPrimary,
  });
  if (!advance.case || !advance.pricingProposal) {
    return { ...advance, notified: false };
  }

  if (!params.notifyUser) {
    return { ...advance, notified: false };
  }

  const { notified } = await notifyPriceApprovalForCase({
    db: params.db,
    caseId: advance.case.id,
    userId: params.userId,
    pricingProposal: advance.pricingProposal,
    source: params.source,
    notifyUser: params.notifyUser,
  });

  return { ...advance, notified };
}
