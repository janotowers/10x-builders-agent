import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";

type PublishDestinationIntent = "approve" | "reject" | "skip" | "unclear";

type ParsedDestinationDecision = {
  intent: PublishDestinationIntent;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function destinationFromNotificationKind(kind: string):
  | "easybroker"
  | "ungga"
  | "manual"
  | null {
  if (kind === "easybroker_publish_approval") return "easybroker";
  if (kind === "ungga_publish_approval") return "ungga";
  if (kind === "manual_publish_package_approval") return "manual";
  return null;
}

function buildManualPublishPackage(context: Record<string, unknown>) {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const approved = isRecord(context.listing_description_approved)
    ? context.listing_description_approved
    : {};
  const pricing = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
  const rawPhotos = Array.isArray(context.raw_photos)
    ? context.raw_photos.filter((item): item is string => typeof item === "string")
    : [];
  return {
    headline:
      (typeof approved.headline === "string" && approved.headline.trim()) ||
      (typeof propertyData.property_title === "string" && propertyData.property_title.trim()) ||
      "Ficha de propiedad",
    description:
      (typeof approved.description === "string" && approved.description.trim()) ||
      (typeof context.listing_description_md === "string"
        ? context.listing_description_md.trim()
        : ""),
    price:
      (typeof pricing.target_price === "number" && Number.isFinite(pricing.target_price)
        ? pricing.target_price
        : typeof propertyData.target_price === "number" &&
            Number.isFinite(propertyData.target_price)
          ? propertyData.target_price
          : 0) ?? 0,
    currency:
      (typeof pricing.currency === "string" && pricing.currency.trim()) ||
      (typeof propertyData.currency === "string" && propertyData.currency.trim()) ||
      "MXN",
    address_summary:
      (typeof propertyData.legal_address === "string" && propertyData.legal_address.trim()) ||
      (typeof propertyData.address === "string" && propertyData.address.trim()) ||
      "",
    image_paths: rawPhotos,
    generated_at: new Date().toISOString(),
    source: "manual_publish_package_approval",
  };
}

export function parsePublishDestinationApprovalDecision(
  text: string
): ParsedDestinationDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  if (/^(aprobar|aprobado|apruebo|ok|va|si|sí|confirmo)\b/.test(normalized)) {
    return { intent: "approve" };
  }
  if (/^(rechazar|rechazo|cancelar|no|detener|deten)\b/.test(normalized)) {
    return { intent: "reject", reason: text.trim() };
  }
  if (/^(omitir|skip|saltar|manual)\b/.test(normalized)) {
    return { intent: "skip", reason: text.trim() };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Responde APROBAR, RECHAZAR u OMITIR para este destino.",
  };
}

export async function handlePublishDestinationApprovalDecision(
  db: DbClient,
  params: { userId: string; notificationId: string; text: string }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  const destination = destinationFromNotificationKind(notification.kind);
  if (!destination) {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no corresponde a aprobación por destino.",
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
  const parsed = parsePublishDestinationApprovalDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const nextState =
    parsed.intent === "approve"
      ? "approved"
      : parsed.intent === "skip"
        ? "skipped"
        : "rejected";
  const nowIso = new Date().toISOString();
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: parsed.intent === "reject" ? "waiting_internal" : "active",
    currentStep: opCase.current_step ?? "package_ready",
    nextActionAt: parsed.intent === "reject" ? null : new Date().toISOString(),
    context: {
      ...context,
      publish_approvals: {
        ...approvals,
        [destination]: nextState,
      },
      ...(destination === "manual" && nextState === "approved"
        ? { manual_publish_package: buildManualPublishPackage(context) }
        : {}),
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
      kind: "publish_destination_decision",
      destination,
      decision: nextState,
      decided_at: nowIso,
      reason: parsed.reason ?? null,
      ...(destination === "manual" && nextState === "approved"
        ? { manual_publish_package_delivered: true }
        : {}),
    },
  });
  if (destination === "manual" && nextState === "approved") {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "user",
      stepKey: "package_ready",
      payload: {
        kind: "manual_publish_package_delivered",
        destination: "manual",
      },
    });
  }
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  return {
    ok: true,
    status: nextState,
    message:
      nextState === "approved"
        ? `Destino ${destination} aprobado.`
        : nextState === "skipped"
          ? `Destino ${destination} marcado como omitido.`
          : `Destino ${destination} rechazado; el caso queda en revisión interna.`,
    destination,
    case_id: opCase.id,
  };
}
