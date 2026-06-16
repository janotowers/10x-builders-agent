import {
  effectiveInternalNotificationKind,
  internalNotificationKindConfig,
} from "@/lib/internal-notifications/registry";

export type PendingActionLinkInput = {
  kind: "tool_confirmation" | "internal_notification";
  notification_kind?: string;
  action_url?: string | null;
  body?: string;
};

export function caseActionUrl(caseId: string) {
  return `/operational-cases?case=${encodeURIComponent(caseId)}`;
}

const TOOL_CONFIRMATION_LABELS: Record<string, string> = {
  telegram_send_message_to_contact: "enviar un mensaje por Telegram",
};

export function toolConfirmationCardTitle() {
  return "Aprobación humana (HITL)";
}

export function describeToolConfirmationAction(toolName: string) {
  const action =
    TOOL_CONFIRMATION_LABELS[toolName] ?? `ejecutar «${toolName}»`;
  return `El agente pidió tu OK para ${action}. Sin aprobar, el flujo queda en espera.`;
}

export function toolConfirmationToolLine(toolName: string) {
  const action =
    TOOL_CONFIRMATION_LABELS[toolName] ?? toolName;
  return `Acción: ${action}`;
}

export function pendientesDeepLink(params: {
  caseId?: string | null;
  focus?: string | null;
}) {
  const url = new URL("/chat/pending", "http://local");
  if (params.caseId) {
    url.searchParams.set("case", params.caseId);
  }
  if (params.focus) {
    url.searchParams.set("focus", params.focus);
  }
  return `${url.pathname}${url.search}`;
}

export function normalizeNotificationActionUrl(
  actionUrl: string | null | undefined
): string | null {
  if (!actionUrl) return null;
  try {
    if (actionUrl.startsWith("/operational-cases?")) {
      const parsed = new URL(actionUrl, "http://local");
      const legacyCaseId = parsed.searchParams.get("case_id");
      if (legacyCaseId && !parsed.searchParams.get("case")) {
        parsed.searchParams.set("case", legacyCaseId);
        parsed.searchParams.delete("case_id");
      }
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return actionUrl;
  }
  return actionUrl;
}

export function pendingActionLinkLabel(
  action: PendingActionLinkInput,
  role: "case" | "action_url" | "pendientes" = "action_url"
): string {
  if (role === "pendientes") return "Ir a este pendiente";
  if (role === "case") return "Ver caso en operación";

  const normalized = normalizeNotificationActionUrl(action.action_url ?? null);
  if (normalized?.startsWith("/chat/pending")) {
    const parsed = new URL(normalized, "http://local");
    return parsed.searchParams.get("focus") ? "Ir a este pendiente" : "Ir a Pendientes";
  }
  if (normalized?.includes("/documents/") && normalized.includes("/download")) {
    return "Descargar documento";
  }
  if (normalized?.startsWith("/operational-cases")) {
    return "Ver caso en operación";
  }
  if (action.kind === "internal_notification") {
    const effectiveKind = effectiveInternalNotificationKind({
      kind: action.notification_kind ?? "",
      body: action.body,
    });
    if (effectiveKind === "integration_reconnect") {
      return "Reconectar integración";
    }
    const config = internalNotificationKindConfig(effectiveKind);
    if (config.businessDecision) return "Resolver en Pendientes";
  }
  return "Abrir enlace";
}

export function shouldShowAssociatedActionLink(action: PendingActionLinkInput & {
  body?: string;
  caseId?: string | null;
  suppressGenericPendingCaseLink?: boolean;
}): boolean {
  const normalized = normalizeNotificationActionUrl(action.action_url ?? null);
  if (!normalized) return false;
  if (normalized.startsWith("/operational-cases")) return false;
  if (
    action.suppressGenericPendingCaseLink &&
    normalized.startsWith("/chat/pending")
  ) {
    const parsed = new URL(normalized, "http://local");
    const focus = parsed.searchParams.get("focus");
    const caseId = parsed.searchParams.get("case");
    if (!focus && (!action.caseId || !caseId || caseId === action.caseId)) {
      return false;
    }
  }

  const body = action.body ?? "";
  const lowerBody = body.toLowerCase();
  if (
    normalized.includes("/documents/") &&
    normalized.includes("/download") &&
    (/plantilla/.test(lowerBody) || /no est[aá] configurada/.test(lowerBody))
  ) {
    return false;
  }
  if (body.includes(normalized) || (action.action_url && body.includes(action.action_url))) {
    return false;
  }
  if (
    normalized.includes("/documents/") &&
    normalized.includes("/download") &&
    /descargar borrador|contrato de comisi[oó]n|borrador del contrato/i.test(body)
  ) {
    return false;
  }
  return true;
}

export function pendingActionFocusId(action: {
  kind: "tool_confirmation" | "internal_notification";
  tool_call_id?: string;
  notification_id?: string;
}) {
  if (action.kind === "tool_confirmation" && action.tool_call_id) {
    return action.tool_call_id;
  }
  if (action.kind === "internal_notification" && action.notification_id) {
    return action.notification_id;
  }
  return null;
}

/** Autolink bare URLs in markdown-ish text for ReactMarkdown. */
export function prepareNotificationBodyMarkdown(body: string): string {
  const withAbsoluteLinks = body.replace(
    /(?<!\]\()(?<!\()(https?:\/\/[^\s<>\])]+)/g,
    "[Abrir enlace]($1)"
  );
  return withAbsoluteLinks.replace(
    /(^|\s)(\/api\/[^\s<>\])]+)/g,
    "$1[Descargar documento]($2)"
  );
}
