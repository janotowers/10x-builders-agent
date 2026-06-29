import { evaluatePropertyDataMinimumsForReview } from "@agents/agent";
import {
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  operationalCaseDocumentRequestTargetFromContext,
  type OperationalCase,
} from "@agents/types";
import { looksLikeDocumentBatchComplete } from "./document-batch-completion";
import { extractOwnerCharacteristics } from "./owner-characteristics-extraction";
import { syncIntakeFieldsFromPropertyData } from "./parse-owner-characteristics";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function derivePropertyTypeHint(
  context: Record<string, unknown>,
  propertyData: Record<string, unknown>
): string | null {
  const fromData = propertyData.property_type;
  if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  const fromContext = context.property_type;
  if (typeof fromContext === "string" && fromContext.trim()) {
    return fromContext.trim();
  }
  if (Array.isArray(fromContext)) {
    const first = fromContext.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    if (first) return first.trim();
  }
  return null;
}

export function isInternalCharacteristicsReplyCandidate(params: {
  opCase: OperationalCase;
  text: string;
}): boolean {
  const normalized = params.text.trim();
  if (!normalized) return false;
  if (looksLikeDocumentBatchComplete(normalized)) return false;
  return (
    params.opCase.current_step === "documents_received" &&
    params.opCase.status === "waiting_internal" &&
    operationalCaseDocumentRequestTargetFromContext(params.opCase.context_jsonb) ===
      "internal_user"
  );
}

export async function isAwaitingCharacteristicsResponse(
  db: DbClient,
  opCase: OperationalCase
): Promise<boolean> {
  if (opCase.current_step !== "documents_received") return false;
  let expectedPurpose: string;
  if (opCase.status === "waiting_external") {
    expectedPurpose = "characteristics_pending";
  } else if (opCase.status === "waiting_internal") {
    expectedPurpose = "characteristics_pending_internal";
  } else {
    return false;
  }

  const events = await getRecentOperationalCaseEvents(db, opCase.id, 20);
  return events.some((event) => {
    const payload = event.payload_jsonb;
    return (
      event.event_type === "reminder_sent" &&
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).purpose === expectedPurpose
    );
  });
}

export async function mergeCharacteristicsOwnerResponseDeterministically(params: {
  db: DbClient;
  opCase: OperationalCase;
  text: string;
  source: string;
  nextActionAt: string | null;
}): Promise<OperationalCase> {
  const currentContext = isRecord(params.opCase.context_jsonb)
    ? params.opCase.context_jsonb
    : {};
  const currentPropertyData = isRecord(currentContext.property_data)
    ? currentContext.property_data
    : {};

  const missingFields = evaluatePropertyDataMinimumsForReview(currentContext).missing;
  const extraction = await extractOwnerCharacteristics({
    text: params.text,
    propertyType: derivePropertyTypeHint(currentContext, currentPropertyData),
    missingFields,
    currentPropertyData,
  });
  const parsedKeys = Object.keys(extraction.patch);

  const propertyData = {
    ...currentPropertyData,
    ...extraction.patch,
  };
  const mergedContext = syncIntakeFieldsFromPropertyData(
    currentContext,
    propertyData
  );
  const updated = await updateOperationalCase(
    params.db,
    params.opCase.id,
    params.opCase.version,
    {
      status: "waiting_internal",
      currentStep: "documents_received",
      nextActionAt: params.nextActionAt,
      context: {
        ...mergedContext,
        owner_response_processed_at: new Date().toISOString(),
        owner_response_extraction_method: extraction.method,
        owner_response_extraction_confidence: extraction.confidence,
        owner_response_extraction_parsed_fields: parsedKeys,
        owner_response_extraction_unresolved: extraction.unresolved,
        ...(extraction.assumptions.length > 0
          ? { owner_response_extraction_assumptions: extraction.assumptions }
          : {}),
        ...(extraction.validationErrors
          ? { owner_response_extraction_validation_errors: extraction.validationErrors }
          : {}),
      },
    }
  );

  const mergedCase = updated ?? params.opCase;
  await insertOperationalCaseEvent(params.db, {
    caseId: mergedCase.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: mergedCase.current_step ?? undefined,
    payload: {
      kind: "owner_characteristics_merged",
      source: params.source,
      extraction_method: extraction.method,
      extraction_confidence: extraction.confidence,
      parsed_fields: parsedKeys,
      unresolved: extraction.unresolved,
      assumptions: extraction.assumptions,
      validation_errors: extraction.validationErrors,
    },
  });

  return mergedCase;
}

export async function processCharacteristicsReplyDeterministically(params: {
  db: DbClient;
  opCase: OperationalCase;
  text: string;
  source: string;
  nextActionAt: string | null;
}): Promise<OperationalCase> {
  const merged = await mergeCharacteristicsOwnerResponseDeterministically({
    db: params.db,
    opCase: params.opCase,
    text: params.text,
    source: params.source,
    nextActionAt: params.nextActionAt,
  });

  try {
    await resolveUnreadInternalNotificationsByKindForCaseWithReminders(params.db, {
      userId: merged.user_id,
      caseId: merged.id,
      kind: "property_data_minimums_missing",
      status: "actioned",
    });
  } catch (resolveError) {
    console.error(
      "[characteristics-response] failed to resolve property_data_minimums_missing pending:",
      resolveError
    );
  }

  return merged;
}
