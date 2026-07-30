import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  setInternalUserNotificationStatus,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
  );
}

/**
 * Simula el cierre del paso de contrato cuando el dueño devuelve el contrato firmado.
 * En producción esto suele entrar vía external_response + tick del agente; en N4 de
 * laboratorio usamos el mismo handler determinístico que Telegram/inbox.
 */
export async function handleContractOwnerSignedDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    fileId?: string | null;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
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
      status: "wrong_step",
      message: `El caso está en ${opCase.current_step}; se esperaba contract_pending.`,
    };
  }

  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const settingsTestCase = isSettingsTestCase(context);
  const fileId =
    params.fileId?.trim() ||
    (/\bfile_id[=:\s]+([^\s]+)/i.exec(params.text)?.[1] ?? "signed_contract_test");

  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
    status: settingsTestCase ? "paused" : "active",
    currentStep: "photos_requested",
    nextActionAt: settingsTestCase ? null : new Date().toISOString(),
    context: {
      ...context,
      contract_signed: {
        file_id: fileId,
        signed_at: new Date().toISOString(),
        source: settingsTestCase ? "step_test_simulation" : "owner_response",
      },
      ...(settingsTestCase
        ? {
            controlled_test_status: "contract_signed_stopped_before_photos",
            controlled_test_note:
              "Contrato firmado simulado en caso de prueba; detenido en paused antes de coordinar fotos automáticamente.",
          }
        : {}),
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "step_completed",
    actor: "user",
    payload: {
      kind: "contract_signed",
      file_id: fileId,
      note: params.text.trim() || "Contrato firmado registrado.",
    },
  });
  await setInternalUserNotificationStatus(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  return {
    ok: true,
    status: "contract_signed",
    message: settingsTestCase
      ? "Contrato firmado registrado (simulado). El caso avanzó a photos_requested en paused."
      : "Contrato firmado por el dueño. El caso avanzó a coordinación de fotos.",
  };
}
