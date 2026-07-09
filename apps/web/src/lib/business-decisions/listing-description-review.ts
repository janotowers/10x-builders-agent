import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
} from "@agents/types";
import {
  classifyListingDescriptionChange,
  type ListingDescriptionChangeClassification,
} from "./listing-description-change-classifier";

type ListingDescriptionIntent =
  | "approve"
  | "change_request"
  | "unclear";

type ParsedListingDescriptionDecision = {
  intent: ListingDescriptionIntent;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseHighlights(text: string): string[] {
  const inline = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[-*•]\s*/, "")
        .replace(/^(highlights?|puntos clave|elementos clave)\s*:\s*/i, "")
        .trim()
    )
    .filter((line) => !/^(highlights?|puntos clave|elementos clave)\s*:?$/i.test(line))
    .filter((line) => line.length > 0)
    .slice(0, 8);
  return inline;
}

function isEditorialInstructionText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(menciona(?:r)?|agrega(?:r)?|incluye(?:r)?|resalta(?:r)?|destaca(?:r)?|enfatiza(?:r)?|usa(?:r)?|evita(?:r)?|haz(?:lo)?|mejora(?:r)?|ajusta(?:r)?|cambia(?:r)?|corrige(?:r)?)\b/.test(
    normalized
  );
}

export function splitInstructionAndHighlights(values: string[]) {
  const editorial: string[] = [];
  const highlights: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (isEditorialInstructionText(trimmed)) {
      editorial.push(trimmed);
    } else {
      highlights.push(trimmed);
    }
  }
  return { editorial, highlights };
}

export function parseListingDescriptionReviewDecision(
  text: string
): ParsedListingDescriptionDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  if (
    /^(aprobar|aprobado|apruebo|ok|va|listo|si|sí)\b/.test(normalized) &&
    !/cambio|ajust|corrig|highlight|puntos?\s+clave|elementos?\s+clave/.test(normalized)
  ) {
    return { intent: "approve" };
  }
  if (text.trim()) return { intent: "change_request", reason: text.trim() };
  return {
    intent: "unclear",
    reason:
      "No entendí si quieres aprobar o pedir cambios. Ejemplos: APROBAR DESCRIPCIÓN o indicar qué ajustar/agregar.",
  };
}

function fallbackListingDescriptionChangeClassification(
  text: string
): ListingDescriptionChangeClassification {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  const replacementPrefix = normalized.match(
    /^(usa exactamente|usa este texto|reemplaza por|descripcion final|descripción final)\s*:?\s*/i
  );
  if (replacementPrefix && trimmed.length > replacementPrefix[0].length) {
    return {
      change_type: "exact_replacement",
      editorial_instructions: [],
      new_facts_or_highlights: [],
      replacement_text: trimmed.slice(replacementPrefix[0].length).trim() || null,
      confidence: "medium",
      requires_clarification: false,
    };
  }
  const highlightHints =
    /highlight|puntos?\s+clave|elementos?\s+clave|resaltar|resalta|destacar|destaca|enfatizar|enfatiza|mencionar|menciona|agrega|agregar|incluye|incluir/i.test(
      trimmed
    ) || /^[\s-•*]+/m.test(trimmed);
  if (highlightHints) {
    return {
      change_type: "new_fact_or_highlight",
      editorial_instructions: [],
      new_facts_or_highlights: parseHighlights(trimmed),
      replacement_text: null,
      confidence: "low",
      requires_clarification: false,
    };
  }
  return {
    change_type: "editorial_instruction",
    editorial_instructions: trimmed ? [trimmed] : [],
    new_facts_or_highlights: [],
    replacement_text: null,
    confidence: "low",
    requires_clarification: false,
  };
}

function shouldRunListingDescriptionAgentTick(opCase: {
  context_jsonb?: Record<string, unknown> | null;
}): boolean {
  return (
    isControlledE2EOperationalCase(opCase) || isSettingsOperationalTestCase(opCase)
  );
}

async function triggerControlledE2EAgentTick(
  db: DbClient,
  updated: NonNullable<Awaited<ReturnType<typeof updateOperationalCase>>>,
  source: string
) {
  const { runSettingsTestCaseAgentTick } = await import(
    "@/lib/operational-cases/run-settings-test-case-tick"
  );
  await runSettingsTestCaseAgentTick(db, updated, updated.user_id, { source });
}

export async function runDeferredListingDescriptionControlledE2ETick(
  db: DbClient,
  caseId: string,
  source: string
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  await triggerControlledE2EAgentTick(db, opCase, source);
}

export async function handleListingDescriptionReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    deferControlledE2ETick?: boolean;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (notification.kind !== "listing_description_review") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no corresponde a revisión de descripción.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no está ligado a un caso.",
    };
  }
  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  const parsed = parseListingDescriptionReviewDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const draft = isRecord(context.listing_description_draft)
    ? context.listing_description_draft
    : null;
  const nowIso = new Date().toISOString();

  if (parsed.intent === "approve") {
    if (!draft) {
      return {
        ok: false,
        status: "missing_draft",
        message: "No encontré listing_description_draft para aprobar.",
      };
    }
    const approved = {
      headline: cleanText(draft.headline),
      short_description: cleanText(draft.short_description),
      description: cleanText(draft.description),
      approved_at: nowIso,
      approved_by: params.userId,
      source: "listing_description_review",
    };
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "active",
      currentStep: "package_ready",
      nextActionAt: new Date().toISOString(),
      context: {
        ...context,
        listing_description_review: {
          status: "approved",
          decided_at: nowIso,
          decided_by: params.userId,
        },
        listing_description_approved: approved,
      },
    });
    if (!updated) {
      return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
    }
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      stepKey: "package_ready",
      payload: {
        kind: "listing_description_approved",
        current_step: "package_ready",
      },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    const runAgentTick = shouldRunListingDescriptionAgentTick(opCase);
    const deferTick = runAgentTick && params.deferControlledE2ETick === true;
    if (runAgentTick && !deferTick) {
      void triggerControlledE2EAgentTick(db, updated, "listing_description_approved").catch(
        (tickError) => {
          console.error("[listing-description-review] e2e tick failed:", tickError);
        }
      );
    }
    return {
      ok: true,
      status: "approved",
      message: "Descripción aprobada. El caso puede continuar a publicación.",
      case_id: opCase.id,
      deferredControlledE2ETick: deferTick
        ? { source: "listing_description_approved" as const }
        : null,
    };
  }

  if (parsed.intent !== "change_request") {
    return { ok: false, status: "unclear", message: parsed.reason ?? "No entendí tu respuesta." };
  }

  const classification =
    (await classifyListingDescriptionChange({
      text: params.text,
      draft,
    })) ?? fallbackListingDescriptionChangeClassification(params.text);
  if (classification.requires_clarification) {
    return {
      ok: false,
      status: "unclear",
      message:
        classification.clarification_question ??
        "¿Quieres que cambie la redacción, que agregue puntos clave o que use un texto exacto?",
    };
  }

  const existingHighlights = Array.isArray(context.listing_highlights)
    ? context.listing_highlights.filter((item): item is string => typeof item === "string")
    : [];
  const existingCopyInstructions = Array.isArray(context.listing_copy_instructions)
    ? context.listing_copy_instructions.filter(
        (item): item is string => typeof item === "string"
      )
    : [];
  const classifiedSplit = splitInstructionAndHighlights(
    classification.new_facts_or_highlights
  );
  const mergedEditorialInstructions = Array.from(
    new Set([
      ...existingCopyInstructions,
      ...classification.editorial_instructions,
      ...classifiedSplit.editorial,
    ])
  ).slice(0, 12);
  const mergedHighlights = Array.from(
    new Set([...existingHighlights, ...classifiedSplit.highlights])
  ).slice(0, 12);
  const effectiveChangeType =
    classification.change_type === "new_fact_or_highlight" &&
    mergedHighlights.length === 0 &&
    mergedEditorialInstructions.length > 0
      ? "editorial_instruction"
      : classification.change_type;
  const normalizedClassification: ListingDescriptionChangeClassification = {
    ...classification,
    change_type: effectiveChangeType,
    editorial_instructions: mergedEditorialInstructions.slice(0, 8),
    new_facts_or_highlights: mergedHighlights.slice(0, 12),
  };
  const statusForReview =
    normalizedClassification.change_type === "new_fact_or_highlight"
      ? "highlights_added"
      : "changes_requested";
  const replacementCandidate = classification.replacement_text
    ? {
        text: classification.replacement_text,
        captured_at: nowIso,
        captured_by: params.userId,
      }
    : null;

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "active",
    currentStep: "package_ready",
    nextActionAt: new Date().toISOString(),
    context: {
      ...context,
      ...(mergedHighlights.length > 0 ? { listing_highlights: mergedHighlights } : {}),
      ...(mergedEditorialInstructions.length > 0
        ? { listing_copy_instructions: mergedEditorialInstructions }
        : {}),
      ...(replacementCandidate ? { listing_description_replacement_candidate: replacementCandidate } : {}),
      listing_description_review: {
        status: statusForReview,
        requested_at: nowIso,
        requested_by: params.userId,
        notes: params.text.trim(),
        change_classification: normalizedClassification,
      },
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "package_ready",
    payload: {
      kind: "listing_description_changes_requested",
      notes: params.text.trim(),
      change_type: normalizedClassification.change_type,
      highlights: normalizedClassification.new_facts_or_highlights,
      editorial_instructions: normalizedClassification.editorial_instructions,
      replacement_candidate: normalizedClassification.replacement_text ?? null,
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  const runAgentTick = shouldRunListingDescriptionAgentTick(opCase);
  const deferTick = runAgentTick && params.deferControlledE2ETick === true;
  if (runAgentTick && !deferTick) {
    void triggerControlledE2EAgentTick(db, updated, "listing_description_changes_requested").catch(
      (tickError) => {
        console.error("[listing-description-review] e2e tick failed:", tickError);
      }
    );
  }
  return {
    ok: true,
    status: normalizedClassification.change_type === "new_fact_or_highlight"
      ? "highlights_added"
      : "changes_requested",
    message:
      normalizedClassification.change_type === "new_fact_or_highlight"
        ? "Puntos clave guardados. Voy a regenerar el borrador para incorporarlos."
        : replacementCandidate
          ? "Cambios registrados. Voy a regenerar el borrador usando el texto propuesto como base."
          : "Cambios registrados. Voy a regenerar el borrador tomando en cuenta tus instrucciones.",
    case_id: opCase.id,
    change_classification: normalizedClassification,
    deferredControlledE2ETick: deferTick
      ? { source: "listing_description_changes_requested" as const }
      : null,
  };
}
