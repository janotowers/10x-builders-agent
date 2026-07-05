import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";

type ListingDescriptionIntent =
  | "approve"
  | "request_changes"
  | "add_highlights"
  | "unclear";

type ParsedListingDescriptionDecision = {
  intent: ListingDescriptionIntent;
  reason?: string;
  highlights?: string[];
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
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  return inline;
}

export function parseListingDescriptionReviewDecision(
  text: string
): ParsedListingDescriptionDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  if (
    /^(aprobar|aprobado|apruebo|ok|va|listo|si|sí)\b/.test(normalized) &&
    !/cambio|ajust|corrig|highlight/.test(normalized)
  ) {
    return { intent: "approve" };
  }
  if (
    /highlight|resaltar|agrega|agregar|incluye|incluir/.test(normalized)
  ) {
    const highlights = parseHighlights(text);
    return highlights.length > 0
      ? { intent: "add_highlights", highlights }
      : {
          intent: "unclear",
          reason:
            "Entendí que quieres agregar highlights, pero no detecté bullets. Inclúyelos en líneas separadas.",
        };
  }
  if (
    /cambiar|cambio|ajustar|ajusta|corregir|corrige|editar|edita|modificar|modifica/.test(
      normalized
    )
  ) {
    return { intent: "request_changes", reason: text.trim() };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí si quieres aprobar, pedir cambios o agregar highlights. Ejemplos: APROBAR DESCRIPCIÓN, AJUSTAR DESCRIPCIÓN ... o HIGHLIGHTS: ...",
  };
}

export async function handleListingDescriptionReviewDecision(
  db: DbClient,
  params: { userId: string; notificationId: string; text: string }
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
      currentStep: opCase.current_step ?? "package_ready",
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
    return {
      ok: true,
      status: "approved",
      message: "Descripción aprobada. El caso puede continuar a publicación.",
      case_id: opCase.id,
    };
  }

  if (parsed.intent === "add_highlights") {
    const existing = Array.isArray(context.listing_highlights)
      ? context.listing_highlights.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    const merged = Array.from(new Set([...existing, ...(parsed.highlights ?? [])])).slice(
      0,
      12
    );
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "active",
      currentStep: opCase.current_step ?? "package_ready",
      nextActionAt: new Date().toISOString(),
      context: {
        ...context,
        listing_highlights: merged,
        listing_description_review: {
          status: "highlights_added",
          decided_at: nowIso,
          decided_by: params.userId,
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
        kind: "listing_description_highlights_added",
        highlights: merged,
      },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    return {
      ok: true,
      status: "highlights_added",
      message:
        "Highlights guardados. Ejecuta de nuevo la preparación del borrador para incorporar cambios.",
      case_id: opCase.id,
    };
  }

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: "waiting_internal",
    currentStep: opCase.current_step ?? "package_ready",
    nextActionAt: null,
    context: {
      ...context,
      listing_description_review: {
        status: "changes_requested",
        requested_at: nowIso,
        requested_by: params.userId,
        notes: params.text.trim(),
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
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  return {
    ok: true,
    status: "changes_requested",
    message: "Cambios registrados. El caso queda en revisión interna.",
    case_id: opCase.id,
  };
}
