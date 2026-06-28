import {
  getOperationalCase,
  insertOperationalCaseEvent,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { comparablesHasDefensibleSample } from "./comparables-analysis";
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
    if (!freshAnalysis || !comparablesHasDefensibleSample(freshAnalysis)) {
      return {
        case: current,
        advanced: false,
        pricingProposal: null,
        skipReason: "sample_not_defensible",
      };
    }

    const subject = subjectAreaFromCaseContext(freshContext);
    const pricingProposal = buildPricingProposalFromComparables({
      analysis: freshAnalysis,
      subjectAreaM2: subject.area,
      areaBasis: subject.basis,
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
      status: "active",
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
            status: "active",
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
 * Tras persistir comparables con muestra defendible: avanza paso, genera
 * pricing_proposal y (opcional) notifica price_approval con números concretos.
 */
export async function tryAdvanceComparablesAfterPersist(params: {
  db: DbClient;
  opCase: OperationalCase;
  userId: string;
  source: string;
  notifyUser?: NotifyUserFn;
}): Promise<AdvanceComparablesResult & { notified: boolean }> {
  const advance = await advanceComparablesToPriceProposalWithRetry({
    db: params.db,
    opCase: params.opCase,
    source: params.source,
  });
  if (!advance.advanced || !advance.case || !advance.pricingProposal) {
    return { ...advance, notified: false };
  }

  if (!params.notifyUser) {
    return { ...advance, notified: false };
  }

  const recentEvents = await params.db
    .from("operational_case_events")
    .select("payload_jsonb,created_at")
    .eq("case_id", advance.case.id)
    .order("created_at", { ascending: false })
    .limit(15);
  const alreadyNotified = (recentEvents.data ?? []).some((row) => {
    const payload = isRecord((row as { payload_jsonb?: unknown }).payload_jsonb)
      ? ((row as { payload_jsonb: Record<string, unknown> }).payload_jsonb as Record<
          string,
          unknown
        >)
      : null;
    return payload?.kind === "price_approval_requested";
  });
  if (alreadyNotified) {
    return { ...advance, notified: false };
  }

  const text = formatPriceApprovalNotifyText(advance.pricingProposal);
  const notifyResult = await params.notifyUser(
    params.db,
    params.userId,
    {
      text,
      kind: "price_approval",
      data: {
        case_id: advance.case.id,
        artifact_key: "pricing_proposal",
        actions: ["approve", "adjust", "reject"],
      },
    },
    "normal"
  );

  await insertOperationalCaseEvent(params.db, {
    caseId: advance.case.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: "price_proposal_pending",
    payload: {
      kind: "price_approval_requested",
      source: params.source,
      current_step: "price_proposal_pending",
      notify_delivered: notifyResult.delivered,
    },
  });

  return { ...advance, notified: notifyResult.delivered.length > 0 };
}
