import {
  createOperationalCase,
  findLatestConversationalOperationalCase,
  getOperationalCaseTypeForUser,
  getConversationBindingForCase,
  insertOperationalCaseEvent,
  upsertConversationBinding,
} from "@agents/db";
import {
  buildOperationalCaseCreateContext,
  missingRequiredIntakeFields,
} from "@agents/agent";
import type {
  OperationalCase,
  OperationalCaseExternalContact,
  OperationalCaseIntakeField,
} from "@agents/types";

type DbClient = Parameters<typeof getOperationalCaseTypeForUser>[0];

export interface EnsureConversationalCaseResult {
  case: OperationalCase;
  created: boolean;
}

/**
 * Garantiza, de forma determinística, que exista un caso conversacional para el
 * `caseType` indicado cuando un canal real (Telegram/chat) detecta intención.
 *
 * - Si ya existe un caso conversacional reciente en estados procesables, lo
 *   adopta (lo devuelve sin crear duplicados).
 * - Si no existe, crea un draft `agent_conversation` en `current_step='intake'`,
 *   con `intake_status='incomplete'` y los `missing_required` derivados del
 *   intake_schema, de modo que el agente continúe recolectando datos sobre ESE
 *   caso ya creado.
 *
 * Marcar `e2e_controlled` sólo ocurre cuando el laboratorio activó un modo E2E
 * explícito. En producción normal, el caso no debe ser controlado por prueba.
 */
export async function ensureConversationalCase(
  db: DbClient,
  params: {
    userId: string;
    caseType: string;
    channel?: string;
    e2eControlled?: boolean;
    labTelegramChatId?: number;
    /**
     * When true, do NOT adopt the latest active conversational case; always
     * create a fresh draft. Used when the user explicitly asks to open another
     * case while one is already in progress.
     */
    forceNew?: boolean;
  }
): Promise<EnsureConversationalCaseResult | null> {
  const e2eControlled = params.e2eControlled === true;
  const labExternalContact: OperationalCaseExternalContact | undefined =
    e2eControlled &&
    params.channel !== "web" &&
    typeof params.labTelegramChatId === "number" &&
    Number.isFinite(params.labTelegramChatId)
      ? {
          channel: "telegram",
          chat_id: params.labTelegramChatId,
          display_name: "Contacto de prueba E2E",
        }
      : undefined;
  const existing = params.forceNew
    ? null
    : await findLatestConversationalOperationalCase(db, {
        userId: params.userId,
        caseType: params.caseType,
        statuses: ["active", "waiting_internal", "waiting_external"],
      });
  if (existing && existing.status !== "paused") {
    const existingExternal = existing.external_contact_jsonb ?? {};
    if (
      labExternalContact &&
      String(existingExternal.chat_id ?? "") !== String(labExternalContact.chat_id)
    ) {
      await db
        .from("operational_cases")
        .update({
          external_contact_jsonb: {
            ...existingExternal,
            ...labExternalContact,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .eq("user_id", params.userId);
      existing.external_contact_jsonb = {
        ...existingExternal,
        ...labExternalContact,
      };
    }
    await upsertConversationBinding(db, {
      userId: params.userId,
      caseId: existing.id,
      caseType: existing.case_type,
      channel: params.channel === "web" ? "web" : "telegram",
      status: "awaiting_user",
      awaitingFields:
        (existing.context_jsonb?.missing_required as unknown[]) ?? [],
      metadata: { source: "ensure_conversational_case_reuse" },
    });
    return { case: existing, created: false };
  }

  const caseType = await getOperationalCaseTypeForUser(
    db,
    params.userId,
    params.caseType
  );
  if (!caseType || caseType.status === "archived") {
    return null;
  }

  const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
    | OperationalCaseIntakeField[]
    | undefined;
  const missing = missingRequiredIntakeFields(intakeSchema, {});
  const incompleteDraft = missing.length > 0;

  const created = await createOperationalCase(db, {
    userId: params.userId,
    caseTypeId: caseType.id,
    caseType: caseType.case_type,
    status: incompleteDraft ? "waiting_internal" : "active",
    currentStep: "intake",
    externalContact: labExternalContact,
    nextActionAt: e2eControlled || incompleteDraft ? null : new Date().toISOString(),
    context: buildOperationalCaseCreateContext({
      context: {},
      missing,
      allowIncompleteIntake: true,
      e2eControlled,
      channel: params.channel,
    }),
  });

  await insertOperationalCaseEvent(db, {
    caseId: created.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "case_created",
      source: "deterministic_conversational_intake",
      channel: params.channel ?? null,
      case_type: created.case_type,
      current_step: created.current_step,
      intake_status: created.context_jsonb.intake_status ?? null,
      missing_required: created.context_jsonb.missing_required ?? [],
      e2e_controlled: e2eControlled,
    },
  });

  const channel = params.channel === "web" ? "web" : "telegram";
  const existingBinding = await getConversationBindingForCase(db, {
    caseId: created.id,
    channel,
    statuses: ["awaiting_user", "clarification_needed"],
  });
  await upsertConversationBinding(db, {
    userId: params.userId,
    caseId: created.id,
    caseType: created.case_type,
    channel,
    status: "awaiting_user",
    awaitingFields: (created.context_jsonb?.missing_required as unknown[]) ?? [],
    metadata: {
      source: "ensure_conversational_case_create",
      binding_reused: Boolean(existingBinding),
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: created.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "binding_created",
      source: "conversation_binding",
      channel,
      status: "awaiting_user",
    },
  });

  return { case: created, created: true };
}
