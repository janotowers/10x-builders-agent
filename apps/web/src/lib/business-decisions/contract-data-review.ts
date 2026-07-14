import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  refreshInternalUserNotificationContent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  applyCommissionTermsPatch,
  buildContractCommercialMinimumsSummaryMessage,
  buildContractCommercialCaptureAckMessage,
  evaluateContractCommercialMinimums,
  parseCommissionTerms,
  parseContractCommercialReply,
  type ContractCommercialMissingField,
  type ContractCommercialPatch,
} from "@agents/agent";
import { isControlledE2EOperationalCase } from "@agents/types";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import { extractContractCommercialReply } from "@/lib/business-decisions/contract-commercial-extraction";

export type ParsedContractDataReviewReply = {
  intent: "provide_data" | "unclear";
  owner_email?: string;
  patch?: ContractCommercialPatch;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEmailCandidate(value: string): string {
  return value.trim().replace(/[.,;:!?)\]}>]+$/g, "");
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailCandidate(value));
}

export function extractOwnerEmailFromContractDataReply(text: string): string | null {
  const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (!match) return null;
  const email = normalizeEmailCandidate(match[0]);
  return looksLikeEmail(email) ? email : null;
}

function missingFieldsFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): ContractCommercialMissingField[] {
  const structured = metadata?.missing_fields;
  if (Array.isArray(structured)) {
    return structured.filter(
      (item): item is ContractCommercialMissingField =>
        isRecord(item) &&
        typeof item.key === "string" &&
        typeof item.question === "string"
    );
  }
  const keys = Array.isArray(metadata?.missing_required_fields)
    ? metadata.missing_required_fields.filter(
        (field): field is string =>
          typeof field === "string" && field.trim().length > 0
      )
    : [];
  return keys.map((key) => ({
    key,
    label: key,
    question: key,
    kind:
      key === "owner_email"
        ? "email"
        : key === "collaboration_enabled" || key === "exclusive"
          ? "boolean"
          : "text",
  }));
}

/**
 * Sync deterministic wrapper kept for lightweight selftests and typed callers.
 * Production free-text path uses `extractContractCommercialReply` (hybrid).
 */
export function parseContractDataReviewReply(
  text: string,
  missing?: ContractCommercialMissingField[]
): ParsedContractDataReviewReply {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      intent: "unclear",
      reason: "Escribe los datos faltantes para continuar.",
    };
  }

  if (missing && missing.length > 0) {
    const parsed = parseContractCommercialReply(trimmed, missing);
    if (parsed.intent === "unclear") {
      return { intent: "unclear", reason: parsed.reason, patch: {} };
    }
    return {
      intent: "provide_data",
      patch: parsed.patch,
      owner_email: parsed.patch.owner_email,
    };
  }

  // Legacy email-only fallback
  const ownerEmail = extractOwnerEmailFromContractDataReply(trimmed);
  if (!ownerEmail) {
    return {
      intent: "unclear",
      reason:
        "No encontré datos válidos. Ejemplo: maria.castaneda@example.com · Sí se comparte comisión · Comisión cobrada al propietario 5% · Exclusiva · Duración 6 meses",
    };
  }
  return {
    intent: "provide_data",
    owner_email: ownerEmail,
    patch: { owner_email: ownerEmail },
  };
}

function normalizePatch(raw: unknown): ContractCommercialPatch {
  if (!isRecord(raw)) return {};
  const patch: ContractCommercialPatch = {};
  if (typeof raw.owner_email === "string" && looksLikeEmail(raw.owner_email)) {
    patch.owner_email = normalizeEmailCandidate(raw.owner_email);
  }
  if ("commission_pct" in raw) {
    patch.commission_pct =
      raw.commission_pct === null ? null : Number(raw.commission_pct);
  }
  if ("exclusive" in raw) {
    patch.exclusive =
      raw.exclusive === null ? null : Boolean(raw.exclusive);
  }
  if ("duration_months" in raw) {
    patch.duration_months =
      raw.duration_months === null ? null : Number(raw.duration_months);
  }
  if ("collaboration_enabled" in raw) {
    patch.collaboration_enabled =
      raw.collaboration_enabled === null
        ? null
        : Boolean(raw.collaboration_enabled);
  }
  if (typeof raw.compensation_mode === "string") {
    patch.compensation_mode =
      raw.compensation_mode as ContractCommercialPatch["compensation_mode"];
  }
  if ("compensation_value" in raw) {
    patch.compensation_value =
      raw.compensation_value === null ? null : Number(raw.compensation_value);
  }
  if (typeof raw.compensation_currency === "string" || raw.compensation_currency === null) {
    patch.compensation_currency = raw.compensation_currency as string | null;
  }
  if (typeof raw.collaboration_notes === "string" || raw.collaboration_notes === null) {
    patch.collaboration_notes = raw.collaboration_notes as string | null;
  }
  if (raw.confirm === true) patch.confirm = true;
  if (typeof raw.confirmed_by === "string") patch.confirmed_by = raw.confirmed_by;
  return patch;
}

export async function handleContractDataReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text?: string;
    patch?: ContractCommercialPatch | Record<string, unknown>;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (notification.kind !== "contract_data_review") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es de datos contractuales faltantes.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no está asociado a un caso.",
    };
  }

  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  if (opCase.current_step !== "contract_pending") {
    return {
      ok: false,
      status: "wrong_stage",
      message: "El caso ya no está en preparación de contrato.",
    };
  }

  const metadata = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const propertyData = isRecord(context.property_data)
    ? { ...context.property_data }
    : {};

  const evaluationBefore = evaluateContractCommercialMinimums({
    context,
    propertyData,
    requireConfirmation: false,
  });
  const missingFromMeta = missingFieldsFromMetadata(metadata);
  const missingForParse =
    missingFromMeta.length > 0 ? missingFromMeta : evaluationBefore.missing;

  const typedPatch = normalizePatch(params.patch);
  let patch: ContractCommercialPatch = { ...typedPatch };
  let extractionMeta: {
    method: "llm" | "llm_retry" | "deterministic_fallback" | "typed_patch";
    confidence: "high" | "medium" | "low";
    unresolved: Array<{ field: string; reason: string }>;
    assumptions: string[];
    attempts: number;
    validationErrors?: string[];
  } = {
    method: "typed_patch",
    confidence: "high",
    unresolved: [],
    assumptions: [],
    attempts: 0,
  };

  if (Object.keys(patch).length === 0 && typeof params.text === "string") {
    const extraction = await extractContractCommercialReply({
      text: params.text,
      missingFields: missingForParse,
      knownTerms: evaluationBefore.terms,
      currentOwnerEmail: evaluationBefore.owner_email,
    });
    extractionMeta = {
      method: extraction.method,
      confidence: extraction.confidence,
      unresolved: extraction.unresolved,
      assumptions: extraction.assumptions,
      attempts: extraction.attempts,
      ...(extraction.validationErrors
        ? { validationErrors: extraction.validationErrors }
        : {}),
    };
    if (extraction.intent === "unclear" || Object.keys(extraction.patch).length === 0) {
      return {
        ok: false,
        status: "unclear",
        message:
          extraction.reason ??
          "No pude interpretar los datos. Responde con los faltantes listados.",
      };
    }
    patch = { ...extraction.patch };
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      status: "unclear",
      message: "No recibí datos contractuales para guardar.",
    };
  }

  const currentTerms = parseCommissionTerms(context.commission_terms);
  let nextTerms = applyCommissionTermsPatch(currentTerms, patch);

  if (typeof patch.owner_email === "string" && looksLikeEmail(patch.owner_email)) {
    propertyData.owner_email = normalizeEmailCandidate(patch.owner_email);
  }

  const interimContext = {
    ...context,
    ...(typeof patch.owner_email === "string"
      ? { owner_email: normalizeEmailCandidate(patch.owner_email) }
      : {}),
    property_data: propertyData,
    commission_terms: nextTerms,
  };

  let evaluation = evaluateContractCommercialMinimums({
    context: interimContext,
    propertyData,
    requireConfirmation: false,
  });

  const requiredStillMissing = evaluation.missing.filter(
    (item) => item.optional !== true
  );
  const capturedComplete = requiredStillMissing.length === 0;

  if (capturedComplete) {
    nextTerms = applyCommissionTermsPatch(nextTerms, {
      confirm: true,
      confirmed_by: params.userId,
    });
    evaluation = evaluateContractCommercialMinimums({
      context: {
        ...interimContext,
        commission_terms: nextTerms,
      },
      propertyData,
      requireConfirmation: true,
    });
  }

  const capturedFields = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );

  const updatedCase = await updateOperationalCase(db, opCase.id, opCase.version, {
    // Only resume agent/cron when required commercial fields are complete.
    nextActionAt: capturedComplete ? new Date().toISOString() : null,
    context: {
      ...interimContext,
      commission_terms: nextTerms,
      contract_data_review: {
        status: capturedComplete ? "captured" : "partial",
        captured_at: new Date().toISOString(),
        captured_fields: capturedFields,
        missing_required_fields: requiredStillMissing.map((item) => item.key),
        missing_fields: evaluation.missing,
        extraction_method: extractionMeta.method,
        extraction_confidence: extractionMeta.confidence,
        extraction_unresolved: extractionMeta.unresolved,
        extraction_assumptions: extractionMeta.assumptions,
        extraction_attempts: extractionMeta.attempts,
        ...(extractionMeta.validationErrors
          ? { extraction_validation_errors: extractionMeta.validationErrors }
          : {}),
      },
    },
  });
  if (!updatedCase) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updatedCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_review_response",
      source: "contract_data_review",
      notification_id: notification.id,
      patch: capturedFields,
      missing_required_fields: requiredStillMissing.map((item) => item.key),
      complete: capturedComplete,
      extraction_method: extractionMeta.method,
      extraction_confidence: extractionMeta.confidence,
      unresolved: extractionMeta.unresolved,
      assumptions: extractionMeta.assumptions,
      validation_errors: extractionMeta.validationErrors ?? [],
    },
  });

  if (!capturedComplete) {
    const summary = buildContractCommercialMinimumsSummaryMessage(evaluation, {
      mode: "partial",
    });
    await insertOperationalCaseEvent(db, {
      caseId: updatedCase.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_data_partial_capture",
        source: "contract_data_review",
        missing_required_fields: requiredStillMissing.map((item) => item.key),
        extraction_method: extractionMeta.method,
      },
    });

    // Keep the unread notification active with remaining fields (deduped upsert path).
    await refreshInternalUserNotificationContent(db, notification, {
      body: summary,
      metadata: {
        case_id: updatedCase.id,
        missing_required_fields: requiredStillMissing.map((item) => item.key),
        missing_fields: evaluation.missing,
        known_fields: evaluation.known,
        source: "contract_data_review_partial",
      },
    });

    return {
      ok: true,
      status: "partial",
      message: summary,
      missing_required_fields: requiredStillMissing.map((item) => item.key),
      missing_fields: evaluation.missing,
    };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updatedCase.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_captured",
      source: "contract_data_review",
      owner_email: evaluation.owner_email,
      commission_terms_confirmed: true,
      extraction_method: extractionMeta.method,
    },
  });

  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  if (isControlledE2EOperationalCase(updatedCase)) {
    void runSettingsTestCaseAgentTick(db, updatedCase, updatedCase.user_id, {
      source: "contract_data_review_captured",
    }).catch((tickError) => {
      console.error("[contract-data-review] e2e tick failed:", tickError);
    });
  }

  return {
    ok: true,
    status: "captured",
    message: buildContractCommercialCaptureAckMessage({
      ownerEmail: evaluation.owner_email,
      terms: nextTerms,
    }),
    owner_email: evaluation.owner_email,
    commission_terms: nextTerms,
  };
}

