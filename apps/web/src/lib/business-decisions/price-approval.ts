import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";

type PriceDecisionIntent = "approve" | "adjust" | "reject" | "unclear";

type ParsedPriceDecision = {
  intent: PriceDecisionIntent;
  patch?: {
    salida?: number;
    ideal?: number;
    minimo?: number;
  };
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAmount(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/\b(mil|k)\b/g, "000")
    .replace(/[^\d.]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1000 ? parsed * 1000 : Math.round(parsed);
}

function extractField(text: string, field: "salida" | "ideal" | "minimo") {
  const patterns = [
    new RegExp(`${field}\\s*[:=]?\\s*\\$?\\s*([\\d.,]+\\s*(?:mil|k)?)`, "i"),
    new RegExp(`${field}\\s+(?:a|en)\\s+\\$?\\s*([\\d.,]+\\s*(?:mil|k)?)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return parseAmount(match[1]);
  }
  return null;
}

export function parsePriceApprovalDecision(text: string): ParsedPriceDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacia." };
  if (/^(aprobar|aprobado|apruebo|ok|va|sí|si)(\s+precio)?\b/i.test(normalized)) {
    return { intent: "approve" };
  }
  if (/^(rechazar|rechazo|no aprobar|no apruebo|cancelar)(\s+precio)?\b/i.test(normalized)) {
    return { intent: "reject", reason: text.trim() };
  }
  const patch = {
    salida: extractField(text, "salida") ?? undefined,
    ideal: extractField(text, "ideal") ?? undefined,
    minimo: extractField(text, "minimo") ?? undefined,
  };
  const hasPatch = Object.values(patch).some((value) => value != null);
  if (hasPatch || /\b(ajust|cambia|baja|sube|modifica)\w*/i.test(normalized)) {
    if (!hasPatch) {
      return {
        intent: "unclear",
        reason:
          "Entendi que quieres ajustar, pero necesito un valor. Ejemplo: AJUSTAR PRECIO salida=23000 ideal=22000 minimo=18000.",
      };
    }
    return { intent: "adjust", patch };
  }
  return {
    intent: "unclear",
    reason:
      "No entendi si quieres aprobar o ajustar. Puedes responder APROBAR PRECIO o AJUSTAR PRECIO salida=23000.",
  };
}

function pricingProposalFromCase(context: Record<string, unknown>) {
  const proposal = context.pricing_proposal;
  return isRecord(proposal) ? proposal : null;
}

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
  );
}

export async function handlePriceApprovalDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontre el pendiente." };
  }
  if (notification.kind !== "price_approval") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es una aprobacion de precio.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no esta asociado a un caso.",
    };
  }
  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontre el caso." };
  }
  const parsed = parsePriceApprovalDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const proposal = pricingProposalFromCase(context);
  if (!proposal) {
    return {
      ok: false,
      status: "missing_proposal",
      message: "El caso no tiene pricing_proposal.",
    };
  }

  if (parsed.intent === "approve") {
    const nextProposal = {
      ...proposal,
      approval_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: params.userId,
    };
    const settingsTestCase = isSettingsTestCase(context);
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: settingsTestCase ? "paused" : "active",
      currentStep: "contract_pending",
      nextActionAt: settingsTestCase ? null : new Date().toISOString(),
      context: {
        ...context,
        pricing_proposal: nextProposal,
        ...(settingsTestCase
          ? {
              controlled_test_status: "price_approved_stopped_before_next_step",
              controlled_test_note:
                "Precio aprobado en caso de prueba; detenido antes de preparar contrato para no mezclar settings con operacion real.",
            }
          : {}),
      },
    });
    if (!updated) return { ok: false, status: "version_conflict", message: "El caso cambio; intenta de nuevo." };
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: { kind: "price_approved", pricing_proposal: nextProposal },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    return {
      ok: true,
      status: "approved",
      message: settingsTestCase
        ? "Precio aprobado. El caso de prueba quedó detenido antes del siguiente paso."
        : "Precio aprobado. El caso avanzó a contrato.",
    };
  }

  if (parsed.intent === "reject") {
    const nextProposal = {
      ...proposal,
      approval_status: "rejected",
      rejected_at: new Date().toISOString(),
      rejected_by: params.userId,
      rejection_reason: parsed.reason ?? params.text,
    };
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "active",
      currentStep: "price_proposal_pending",
      nextActionAt: new Date().toISOString(),
      context: { ...context, pricing_proposal: nextProposal },
    });
    if (!updated) return { ok: false, status: "version_conflict", message: "El caso cambio; intenta de nuevo." };
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: { kind: "price_rejected", reason: parsed.reason ?? params.text },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    return {
      ok: true,
      status: "rejected",
      message: "Precio rechazado. El caso volvera a preparar propuesta.",
    };
  }

  const nextProposal = {
    ...proposal,
    ...parsed.patch,
    approval_status: "approved",
    adjusted_at: new Date().toISOString(),
    adjusted_by: params.userId,
    approved_at: new Date().toISOString(),
    approved_by: params.userId,
  };
  const settingsTestCase = isSettingsTestCase(context);
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: settingsTestCase ? "paused" : "active",
    currentStep: "contract_pending",
    nextActionAt: settingsTestCase ? null : new Date().toISOString(),
    context: {
      ...context,
      pricing_proposal: nextProposal,
      ...(settingsTestCase
        ? {
            controlled_test_status: "price_adjusted_approved_stopped_before_next_step",
            controlled_test_note:
              "Precio ajustado/aprobado en caso de prueba; detenido antes de preparar contrato para no mezclar settings con operacion real.",
          }
        : {}),
    },
  });
  if (!updated) return { ok: false, status: "version_conflict", message: "El caso cambio; intenta de nuevo." };
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    payload: {
      kind: "price_adjusted_and_approved",
      patch: parsed.patch,
      pricing_proposal: nextProposal,
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  return {
    ok: true,
    status: "adjusted_and_approved",
    message: settingsTestCase
      ? "Ajuste aplicado y precio aprobado. El caso de prueba quedó detenido antes del siguiente paso."
      : "Ajuste aplicado y precio aprobado. El caso avanzó a contrato.",
    pricing_proposal: nextProposal,
  };
}
