/**
 * Tras aprobar precio / entrar a contract_pending: pedir datos comerciales
 * faltantes en el canal activo (paridad Telegram histórica).
 */
import {
  buildContractCommercialMinimumsSummaryMessage,
  evaluateContractCommercialMinimums,
} from "@agents/agent";
import {
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { createAdvisedCaseUpdate } from "./advised-case-update";
import { deliverInternalCaseFollowUp } from "./deliver-internal-case-follow-up";

const advisedUpdate = createAdvisedCaseUpdate(
  "ensure_contract_commercial_ask",
  "runtime"
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function ensureContractCommercialDataAsk(params: {
  db: DbClient;
  opCase: OperationalCase;
  source: string;
}): Promise<{
  asked: boolean;
  case: OperationalCase;
  reason?: string;
  text?: string;
}> {
  const { db, source } = params;
  let workingCase = params.opCase;
  if (workingCase.current_step !== "contract_pending") {
    return { asked: false, case: workingCase, reason: "wrong_step" };
  }

  const context = isRecord(workingCase.context_jsonb)
    ? workingCase.context_jsonb
    : {};
  const propertyData = isRecord(context.property_data)
    ? context.property_data
    : {};
  const externalContact = isRecord(workingCase.external_contact_jsonb)
    ? (workingCase.external_contact_jsonb as Record<string, unknown>)
    : {};

  const commercial = evaluateContractCommercialMinimums({
    context,
    propertyData,
    externalContact,
    requireConfirmation: true,
  });
  const requiredMissing = commercial.missing.filter(
    (item) => item.optional !== true
  );
  if (requiredMissing.length === 0 && commercial.ok) {
    return { asked: false, case: workingCase, reason: "no_missing_fields" };
  }

  const recentEvents = await getRecentOperationalCaseEvents(db, workingCase.id, 30);
  const alreadyRequested = recentEvents.some((event) => {
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : null;
    return payload?.kind === "contract_data_review_requested";
  });
  if (alreadyRequested) {
    return { asked: false, case: workingCase, reason: "already_requested" };
  }

  const text = buildContractCommercialMinimumsSummaryMessage(commercial);
  const missingKeys = requiredMissing.map((item) => item.key);
  const delivery = await deliverInternalCaseFollowUp({
    db,
    userId: workingCase.user_id,
    caseId: workingCase.id,
    text,
    kind: "contract_data_review",
    data: {
      missing_required_fields: missingKeys,
      missing_fields: commercial.missing,
      known_fields: commercial.known,
      source,
    },
    urgency: "high",
  });

  await insertOperationalCaseEvent(db, {
    caseId: workingCase.id,
    eventType: "human_decision",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_review_requested",
      source,
      missing_required_fields: missingKeys,
      active_internal_channel: delivery.activeChannel,
      notify_delivered: delivery.notifyDelivered,
      web_chat_mirrored: delivery.webChatMirrored,
    },
  });

  const updated = await advisedUpdate(db, workingCase, workingCase.version, {
    status: "waiting_internal",
    currentStep: "contract_pending",
    nextActionAt: null,
  });
  workingCase = updated ?? workingCase;

  return { asked: true, case: workingCase, text };
}
