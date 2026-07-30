import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
import { isControlledE2EOperationalCase } from "@agents/types";
import { removeConsumedSegments } from "./residual-intent";

type PriceDecisionIntent = "approve" | "adjust" | "reject" | "unclear";

type ParsedPriceDecision = {
  intent: PriceDecisionIntent;
  patch?: {
    salida?: number;
    ideal?: number;
    minimo?: number;
  };
  reason?: string;
  /**
   * Monto nombrado junto a una aprobación simple ("Aprobar $4.8 millones").
   * Slice 0.2: si difiere de la propuesta registrada, el handler aclara en
   * lugar de aprobar.
   */
  approvalAmount?: number | null;
  /**
   * Escalas plausibles del monto nombrado cuando no trae unidad explícita
   * ("aprobar 4.8" → 4.8 | 4,800 | 4,800,000). La comparación con la
   * propuesta es de igualdad exacta contra cualquiera de los candidatos.
   */
  approvalAmountCandidates?: number[];
  /**
   * Remanente del texto que el parser NO consumió (slice 0.1). El router lo
   * convierte en `ResidualIntent` para reconocerlo en la respuesta.
   */
  residual?: string | null;
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

type FieldMatch = {
  value: number;
  segment: { index: number; length: number };
};

function extractFieldWithMatch(
  text: string,
  field: "salida" | "ideal" | "minimo"
): FieldMatch | null {
  const patterns = [
    new RegExp(`${field}\\s*[:=]?\\s*\\$?\\s*([\\d.,]+\\s*(?:mil|k)?)`, "i"),
    new RegExp(`${field}\\s+(?:a|en)\\s+\\$?\\s*([\\d.,]+\\s*(?:mil|k)?)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && match.index != null) {
      const value = parseAmount(match[1]);
      if (value != null) {
        return {
          value,
          segment: { index: match.index, length: match[0].length },
        };
      }
    }
  }
  return null;
}

/**
 * Monto nombrado en texto libre tras una aprobación ("$4.8 millones",
 * "5,200,000", "4.8 mdp", "500 mil"). Devuelve valores candidatos ya
 * normalizados: con unidad explícita hay un único candidato; sin unidad se
 * consideran las escalas plausibles (literal, miles, millones) porque la
 * comparación posterior es de igualdad exacta, nunca difusa.
 */
export function extractApprovalAmount(text: string): {
  candidates: number[];
  segment: { index: number; length: number };
} | null {
  const pattern =
    /(?:^|[\s,;:])(?:en\s+|a\s+|por\s+)?\$?\s*(\d[\d.,]*)\s*(millones|millón|millon|mdp|mil|k|m)?(?=[\s,;.]|$)/i;
  const match = text.match(pattern);
  if (!match?.[1] || match.index == null) return null;
  const numericRaw = match[1].replace(/,/g, "");
  const base = Number(numericRaw);
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = match[2]?.toLowerCase() ?? null;
  let candidates: number[];
  if (unit === "millones" || unit === "millón" || unit === "millon" || unit === "mdp" || unit === "m") {
    candidates = [Math.round(base * 1_000_000)];
  } else if (unit === "mil" || unit === "k") {
    candidates = [Math.round(base * 1_000)];
  } else {
    // Sin unidad: "4,800,000" es literal; "4800" podría ser miles; "4.8"
    // podría ser millones. Igualdad exacta contra la propuesta decide.
    candidates = [...new Set([base, base * 1_000, base * 1_000_000])].map(
      (value) => Math.round(value)
    );
  }
  return {
    candidates,
    segment: { index: match.index, length: match[0].length },
  };
}

export function parsePriceApprovalDecision(text: string): ParsedPriceDecision {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacia." };
  const approveMatch = trimmed.match(
    /^(aprobar|aprobado|apruebo|ok|va|sí|si)(\s+(el\s+)?precio)?\b/i
  );
  if (approveMatch) {
    const remainder = trimmed.slice(approveMatch[0].length);
    const amount = extractApprovalAmount(remainder);
    const residualRaw = amount
      ? removeConsumedSegments(remainder, [amount.segment])
      : remainder;
    return {
      intent: "approve",
      approvalAmount: amount ? amount.candidates[0] : null,
      ...(amount ? { approvalAmountCandidates: amount.candidates } : {}),
      residual: residualRaw.trim() ? residualRaw : null,
    };
  }
  if (/^(rechazar|rechazo|no aprobar|no apruebo|cancelar)(\s+precio)?\b/i.test(normalized)) {
    // El resto del texto se consume como motivo del rechazo.
    return { intent: "reject", reason: trimmed, residual: null };
  }
  const fieldMatches: Partial<Record<"salida" | "ideal" | "minimo", FieldMatch>> = {
    salida: extractFieldWithMatch(trimmed, "salida") ?? undefined,
    ideal: extractFieldWithMatch(trimmed, "ideal") ?? undefined,
    minimo: extractFieldWithMatch(trimmed, "minimo") ?? undefined,
  };
  const patch = {
    salida: fieldMatches.salida?.value,
    ideal: fieldMatches.ideal?.value,
    minimo: fieldMatches.minimo?.value,
  };
  const hasPatch = Object.values(patch).some((value) => value != null);
  const adjustVerbMatch = trimmed.match(
    /\b(ajust\w*|cambia\w*|baja\w*|sube\w*|modifica\w*)(\s+(el\s+|los\s+)?precios?)?\b/i
  );
  if (hasPatch || adjustVerbMatch) {
    if (!hasPatch) {
      return {
        intent: "unclear",
        reason:
          "Entendi que quieres ajustar, pero necesito un valor. Ejemplo: AJUSTAR PRECIO salida=23000 ideal=22000 minimo=18000.",
      };
    }
    const consumed = [
      ...Object.values(fieldMatches)
        .filter((match): match is FieldMatch => Boolean(match))
        .map((match) => match.segment),
      ...(adjustVerbMatch && adjustVerbMatch.index != null
        ? [{ index: adjustVerbMatch.index, length: adjustVerbMatch[0].length }]
        : []),
    ];
    const residualRaw = removeConsumedSegments(trimmed, consumed);
    return {
      intent: "adjust",
      patch,
      residual: residualRaw.trim() ? residualRaw : null,
    };
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

function proposalNumber(proposal: Record<string, unknown>, key: string): number | null {
  const value = proposal[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function formatMxnAmount(value: number): string {
  return `$${value.toLocaleString("es-MX")}`;
}

/**
 * Slice 0.2 — Amarre de monto en aprobaciones.
 *
 * Una aprobación simple que nombra un monto solo aprueba si ese monto
 * coincide exactamente (tras normalización de separadores/escala) con la
 * `salida` o la `ideal` de la propuesta registrada. La `salida` es el precio
 * de publicación (el que una aprobación simple autoriza); se acepta también
 * `ideal` porque el asesor a veces cita ese número. Cualquier otro monto ⇒
 * aclaración, nunca aprobación. Sin tolerancia difusa.
 */
export function detectPriceApprovalAmountMismatch(params: {
  approvalAmountCandidates: number[] | null | undefined;
  proposal: Record<string, unknown>;
}): {
  mismatch: boolean;
  namedAmount: number | null;
  salida: number | null;
  ideal: number | null;
} {
  const salida = proposalNumber(params.proposal, "salida");
  const ideal = proposalNumber(params.proposal, "ideal");
  const candidates = params.approvalAmountCandidates ?? [];
  if (candidates.length === 0) {
    return { mismatch: false, namedAmount: null, salida, ideal };
  }
  const matches = candidates.some(
    (candidate) =>
      (salida != null && candidate === salida) ||
      (ideal != null && candidate === ideal)
  );
  return {
    mismatch: !matches,
    namedAmount: candidates[0] ?? null,
    salida,
    ideal,
  };
}

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
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

/**
 * Dispara el tick del agente E2E para un caso ya actualizado, recargándolo por
 * id. Se usa desde el webhook de Telegram para ejecutar el avance del caso
 * *después* de haber enviado la confirmación al usuario (ver
 * `deferControlledE2ETick`).
 */
export async function runDeferredControlledE2ETick(
  db: DbClient,
  caseId: string,
  source: string
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  await triggerControlledE2EAgentTick(db, opCase, source);
}

export async function handlePriceApprovalDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    /**
     * Cuando el caller es Telegram, difiere el tick del agente E2E para que
     * el webhook envíe primero la confirmación ("Precio aprobado…") y sólo
     * después dispare el avance (que puede producir sus propios mensajes,
     * p.ej. "Falta correo del propietario"). Evita que el chat muestre el
     * mensaje del siguiente paso antes que la confirmación del ack.
     */
    deferControlledE2ETick?: boolean;
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
    // Slice 0.2: si la aprobación nombra un monto distinto a la propuesta
    // registrada, aclaramos en lugar de aprobar. El pendiente sigue abierto.
    const amountCheck = detectPriceApprovalAmountMismatch({
      approvalAmountCandidates: parsed.approvalAmountCandidates,
      proposal,
    });
    if (amountCheck.mismatch) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "human_decision",
        actor: "user",
        stepKey: "price_proposal_pending",
        payload: {
          kind: "price_approval_amount_mismatch",
          named_amount: amountCheck.namedAmount,
          proposal_salida: amountCheck.salida,
          proposal_ideal: amountCheck.ideal,
          text: params.text,
        },
      });
      const registered = [
        amountCheck.salida != null
          ? `salida ${formatMxnAmount(amountCheck.salida)}`
          : null,
        amountCheck.ideal != null
          ? `ideal ${formatMxnAmount(amountCheck.ideal)}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
      return {
        ok: false,
        status: "amount_mismatch",
        message: `Mencionaste ${
          amountCheck.namedAmount != null
            ? formatMxnAmount(amountCheck.namedAmount)
            : "un monto"
        }, pero la propuesta registrada es ${registered || "otra"}. No aprobé nada. Si quieres ese monto, responde AJUSTAR PRECIO salida=NUEVO_MONTO; si quieres aprobar la propuesta tal cual, responde APROBAR PRECIO.`,
        case_id: opCase.id,
      };
    }
    const nextProposal = {
      ...proposal,
      approval_status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: params.userId,
    };
    const settingsTestCase = isSettingsTestCase(context);
    const controlledE2ECase = isControlledE2EOperationalCase(opCase);
    const shouldPauseBeforeContract = settingsTestCase && !controlledE2ECase;
    const updated = await advisedUpdateCase(db, opCase, opCase.version, {
      status: shouldPauseBeforeContract ? "paused" : "active",
      currentStep: "contract_pending",
      nextActionAt: shouldPauseBeforeContract ? null : new Date().toISOString(),
      context: {
        ...context,
        pricing_proposal: nextProposal,
        ...(shouldPauseBeforeContract
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
      stepKey: "price_proposal_pending",
      payload: {
        kind: "price_approved",
        current_step: "price_proposal_pending",
        to: { current_step: "contract_pending", status: updated.status },
        pricing_proposal: nextProposal,
      },
    });
    if (!shouldPauseBeforeContract) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "state_changed",
        actor: "system",
        stepKey: "contract_pending",
        payload: {
          kind: "contract_preparation_entered",
          current_step: "contract_pending",
          via: "price_approved",
        },
      });
    }
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
      userId: params.userId,
      caseId: opCase.id,
      kind: "property_data_quality_review",
      status: "dismissed",
    });
    const deferTick = controlledE2ECase && params.deferControlledE2ETick === true;
    if (controlledE2ECase && !deferTick) {
      void triggerControlledE2EAgentTick(db, updated, "price_approved").catch((tickError) => {
        console.error("[price-approval] e2e tick failed:", tickError);
      });
    }
    return {
      ok: true,
      status: "approved",
      message: shouldPauseBeforeContract
        ? "Precio aprobado. El caso de prueba quedó detenido antes del siguiente paso."
        : "Precio aprobado. El caso avanzó a contrato.",
      case_id: opCase.id,
      deferredControlledE2ETick: deferTick
        ? { source: "price_approved" as const }
        : null,
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
    const updated = await advisedUpdateCase(db, opCase, opCase.version, {
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
      stepKey: "price_proposal_pending",
      payload: {
        kind: "price_rejected",
        current_step: "price_proposal_pending",
        reason: parsed.reason ?? params.text,
      },
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
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);
  const shouldPauseBeforeContract = settingsTestCase && !controlledE2ECase;
  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
    status: shouldPauseBeforeContract ? "paused" : "active",
    currentStep: "contract_pending",
    nextActionAt: shouldPauseBeforeContract ? null : new Date().toISOString(),
    context: {
      ...context,
      pricing_proposal: nextProposal,
      ...(shouldPauseBeforeContract
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
    stepKey: "price_proposal_pending",
    payload: {
      kind: "price_adjusted_and_approved",
      current_step: "price_proposal_pending",
      to: { current_step: "contract_pending", status: updated.status },
      patch: parsed.patch,
      pricing_proposal: nextProposal,
    },
  });
  if (!shouldPauseBeforeContract) {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_preparation_entered",
        current_step: "contract_pending",
        via: "price_adjusted_and_approved",
      },
    });
  }
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId: opCase.id,
    kind: "property_data_quality_review",
    status: "dismissed",
  });
  const deferTick = controlledE2ECase && params.deferControlledE2ETick === true;
  if (controlledE2ECase && !deferTick) {
    void triggerControlledE2EAgentTick(db, updated, "price_adjusted_and_approved").catch(
      (tickError) => {
        console.error("[price-approval] e2e tick failed:", tickError);
      }
    );
  }
  return {
    ok: true,
    status: "adjusted_and_approved",
    message: shouldPauseBeforeContract
      ? "Ajuste aplicado y precio aprobado. El caso de prueba quedó detenido antes del siguiente paso."
      : "Ajuste aplicado y precio aprobado. El caso avanzó a contrato.",
    pricing_proposal: nextProposal,
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick
      ? { source: "price_adjusted_and_approved" as const }
      : null,
  };
}
