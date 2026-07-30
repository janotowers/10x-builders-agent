import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
import {
  isControlledE2EOperationalCase,
  isSettingsOperationalTestCase,
} from "@agents/types";
import {
  classifyListingDescriptionChange,
  type ListingDescriptionChangeClassification,
} from "./listing-description-change-classifier";
import {
  buildListingDescriptionDraftTxtAttachment,
  sanitizeListingDescriptionCommercialCopy,
} from "@agents/agent";

type ListingDescriptionIntent =
  | "approve"
  | "change_request"
  | "read_artifact"
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

/** Explicit approve verbs may carry trailing words ("apruebo la descripción"). */
const EXPLICIT_APPROVE_VERB = /^(aprobar|aprobado|apruebo)\b/;
/**
 * Bare affirmatives approve only when standalone. "ok gracias" after e.g.
 * asking to see the full draft is an acknowledgment, not an approval — it
 * must trigger a clarification instead of publishing.
 */
const STANDALONE_AFFIRMATIVE =
  /^(ok(?:ay|ey)?|va(?:le)?|listo|dale|s[ií]|perfecto|de acuerdo)[\s.,!…]*$/;
/** Affirmative/courtesy opener with extra words → ambiguous, ask. */
const AFFIRMATIVE_OR_COURTESY_LEAD =
  /^(ok(?:ay|ey)?|va(?:le)?|listo|dale|s[ií]|perfecto|de acuerdo|entendido|gracias)\b/;
/** `cambi` (not `cambio`) so imperatives like "cambia el tono" also match. */
const CHANGE_HINT =
  /cambi|ajust|corrig|highlight|puntos?\s+clave|elementos?\s+clave/;

/**
 * Read-only request for the full draft ("dame el texto completo de la
 * descripción"). Must be answered with the artifact, never treated as a
 * change request nor as a decision that closes the review.
 */
const READ_ARTIFACT_REQUEST =
  /\b(?:dame|env[ií]a(?:me)?|manda(?:me)?|comparte(?:me)?|mu[eé]stra(?:me)?|ens[eé]ña(?:me)?|p[aá]sa(?:me)?|quiero\s+(?:ver|leer)|puedo\s+ver|necesito\s+(?:ver|leer))\b[^.!?]{0,60}\b(?:texto|descripci[oó]n|borrador)\b|\b(?:texto|descripci[oó]n|borrador)\b[^.!?]{0,30}\bcomplet[oa]\b/i;

/**
 * Interrogative reads about the draft content ("¿qué dice el título?",
 * "¿cómo quedó la descripción?") are also answered with the artifact. The
 * editorial exclusion below still wins ("¿puedes cambiar el título?" is a
 * change request, not a read).
 */
// (?!\w) instead of \b: JS \b fails after accented chars ("qué" → é ∉ \w).
const READ_ARTIFACT_INTERROGATIVE =
  /^(?:¿)?\s*(?:qu[eé]|cu[aá]l(?:es)?|c[oó]mo)(?!\w)[^.!?]{0,80}\b(?:t[ií]tulo|descripci[oó]n|borrador|texto|resumen|highlights?)\b/i;

/**
 * Editorial imperatives beat the bare "texto completo" pattern, so
 * "reescribe el texto completo" stays a change request, not a read.
 */
const READ_ARTIFACT_EDITORIAL_EXCLUSION =
  /\b(?:reescrib|regener|redact|mencion|agreg|incluy|resalt|destac|enfatiz|mejor|corrig|cambi|ajust|evit|quita|elimin|acort|alarg|haz(?:lo)?)\w*\b/i;

export function looksLikeListingDescriptionReadRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (READ_ARTIFACT_EDITORIAL_EXCLUSION.test(trimmed)) return false;
  return (
    READ_ARTIFACT_REQUEST.test(trimmed) ||
    READ_ARTIFACT_INTERROGATIVE.test(trimmed)
  );
}

export function parseListingDescriptionReviewDecision(
  text: string
): ParsedListingDescriptionDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  if (EXPLICIT_APPROVE_VERB.test(normalized) && !CHANGE_HINT.test(normalized)) {
    return { intent: "approve" };
  }
  if (STANDALONE_AFFIRMATIVE.test(normalized)) {
    return { intent: "approve" };
  }
  if (
    AFFIRMATIVE_OR_COURTESY_LEAD.test(normalized) &&
    !CHANGE_HINT.test(normalized)
  ) {
    return {
      intent: "unclear",
      reason:
        "No me queda claro si apruebas la descripción tal cual. Responde APROBAR para aprobarla, o dime qué ajustar.",
    };
  }
  if (
    looksLikeListingDescriptionReadRequest(normalized) &&
    !CHANGE_HINT.test(normalized)
  ) {
    return { intent: "read_artifact" };
  }
  return { intent: "change_request", reason: text.trim() };
}

const LISTING_DESCRIPTION_REVIEW_TEXT_HINT =
  /\b(descripci[oó]n|descripcion|t[ií]tulo|headline|highlights?|puntos?\s+clave|elementos?\s+clave|resaltar|destacar|mencion(?:a|ar|e|es)|enfatiz(?:a|ar|e|es)|vendedor|vendedora|premium|persuasiv[ao]|portal)\b/i;

const LISTING_DESCRIPTION_APPROVE_HINT =
  /^(aprobar|aprobado|apruebo|ok|va|listo|si|sí)\b/i;

const LISTING_DESCRIPTION_EDITORIAL_HINT =
  /\b(hazlo|hacerlo|cambia(?:r)?|ajust(?:a|ar)|corrig(?:e|ir)|reescrib(?:e|ir)|tono|redacci[oó]n|m[aá]s\s+(ejecutivo|sobrio|corto|largo|vendedor|persuasiv[ao]))\b/i;

/**
 * Free-text must look like a listing-description decision — not merely "any
 * text while one review is pending". Intake replies and new-case intents are
 * not description edits.
 */
export function looksLikeListingDescriptionDecisionText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (LISTING_DESCRIPTION_APPROVE_HINT.test(trimmed)) return true;
  if (LISTING_DESCRIPTION_REVIEW_TEXT_HINT.test(trimmed)) return true;
  if (LISTING_DESCRIPTION_EDITORIAL_HINT.test(trimmed)) return true;
  if (looksLikeListingDescriptionReadRequest(trimmed)) return true;
  return false;
}

/**
 * Sticky HITL for listing-description review must not swallow:
 * - explicit new-case / optioning intents
 * - turns that belong to an active incomplete conversational intake
 *   (unless the user just pressed «Pedir cambios» and we are waiting for
 *   that explicit reply)
 *
 * Mirror price/contract HITL: only claim messages that look like answers to
 * this decision (or an explicit "write your changes" pending reply).
 */
export function shouldRouteTelegramTextToListingDescriptionReview(params: {
  text: string;
  isTelegramCommand?: boolean;
  pendingReviewCount: number;
  hasPendingReplyIntent: boolean;
  /** Deterministic start-case intent (e.g. "quiero opcionar una propiedad"). */
  isExplicitNewCaseIntent: boolean;
  /**
   * True when this chat already has an incomplete conversational intake that
   * should own the turn (usually a different case than the stale review).
   * Does NOT override an explicit pending-reply intent from «Pedir cambios».
   */
  hasCompetingActiveConversationalIntake?: boolean;
}): boolean {
  const text = params.text.trim();
  if (!text || params.isTelegramCommand) return false;
  // Explicit "start another case" still wins over a description edit.
  if (params.isExplicitNewCaseIntent) return false;
  if (params.pendingReviewCount <= 0) return false;
  // User pressed «Pedir cambios» and was asked to write the edit: that reply
  // must reach listing_description_review even if another intake is open in
  // the same chat (otherwise the edit is misread as property_zone / intake).
  if (params.hasPendingReplyIntent) return true;
  if (params.hasCompetingActiveConversationalIntake) return false;
  return looksLikeListingDescriptionDecisionText(text);
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
  const draftDescription =
    draft && typeof draft.description === "string" ? draft.description.trim() : "";
  const hasUsableDraft = Boolean(draft && draftDescription);
  const nowIso = new Date().toISOString();

  if (parsed.intent === "read_artifact") {
    // Read-only: answer with the full draft. The review stays pending — no
    // state change, no notification resolution, no agent tick.
    if (!hasUsableDraft || !draft) {
      return {
        ok: false,
        status: "missing_draft",
        message:
          "Aún no hay borrador comercial que mostrar. Usa «Pedir cambios» para que el agente lo prepare.",
      };
    }
    const artifact = buildListingDescriptionDraftTxtAttachment(draft, {
      caseId: opCase.id,
    });
    if (!artifact) {
      return {
        ok: false,
        status: "missing_draft",
        message: "El borrador está vacío; usa «Pedir cambios» para regenerarlo.",
      };
    }
    return {
      ok: true,
      status: "artifact_text",
      message:
        "Te comparto el borrador completo. La revisión sigue pendiente: responde APROBAR o dime qué ajustar.",
      artifact,
      case_id: opCase.id,
    };
  }

  if (parsed.intent === "approve") {
    if (!draft || !draftDescription) {
      return {
        ok: false,
        status: "missing_draft",
        message:
          "No hay borrador comercial aún. Usa «Pedir cambios» (puedes dejar una nota o el texto por defecto) para cerrar este pendiente y que el agente prepare el borrador real.",
      };
    }
    const approved = {
      headline: cleanText(draft.headline),
      short_description: cleanText(draft.short_description),
      // Also sanitize drafts generated before the copy guard was deployed so
      // an internal photo-coverage caveat cannot reach publication on approve.
      description: sanitizeListingDescriptionCommercialCopy(draft.description),
      approved_at: nowIso,
      approved_by: params.userId,
      source: "listing_description_review",
    };
    const updated = await advisedUpdateCase(db, opCase, opCase.version, {
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

  // Pendiente prematuro sin borrador: cerrar HITL y pedir al agente el flujo real.
  if (!hasUsableDraft) {
    const notes =
      params.text.trim() ||
      "Sin borrador previo: generar photo_analysis, zone_context y listing_description_draft.";
    const updated = await advisedUpdateCase(db, opCase, opCase.version, {
      status: "active",
      currentStep: "package_ready",
      nextActionAt: new Date().toISOString(),
      context: {
        ...context,
        listing_description_review: {
          status: "regeneration_requested",
          requested_at: nowIso,
          requested_by: params.userId,
          notes,
          reason: "missing_listing_description_draft",
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
        kind: "listing_description_regeneration_requested",
        reason: "missing_listing_description_draft",
        notes,
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
      void triggerControlledE2EAgentTick(
        db,
        updated,
        "listing_description_regeneration_requested"
      ).catch((tickError) => {
        console.error("[listing-description-review] e2e tick failed:", tickError);
      });
    }
    return {
      ok: true,
      status: "regeneration_requested",
      message:
        "No había borrador aún. Cerré este pendiente; el agente preparará análisis, entorno y el borrador real. Si el laboratorio sigue bloqueado, pulsa «Revisar avance».",
      case_id: opCase.id,
      deferredControlledE2ETick: deferTick
        ? { source: "listing_description_regeneration_requested" as const }
        : null,
    };
  }

  let classification =
    (await classifyListingDescriptionChange({
      text: params.text,
      draft,
    })) ?? fallbackListingDescriptionChangeClassification(params.text);
  if (classification.requires_clarification) {
    const fallback = fallbackListingDescriptionChangeClassification(params.text);
    if (params.text.trim().length >= 8 && fallback.editorial_instructions.length > 0) {
      classification = fallback;
    } else {
      return {
        ok: false,
        status: "unclear",
        message:
          "Escribe arriba el cambio concreto (ej. «hazlo más corto», «menciona la terraza») y vuelve a pulsar Pedir cambios.",
      };
    }
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

  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
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
