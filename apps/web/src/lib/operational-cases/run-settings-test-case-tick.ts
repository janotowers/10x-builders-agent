import { runAgent } from "@agents/agent";
import {
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getProfile,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  getOrCreateSession,
  insertOperationalCaseEvent,
  markCaseProcessing,
  updateOperationalCase,
} from "@agents/db";
import type { OperationalCase, PendingConfirmation } from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";

export function isSettingsTestCase(opCase: OperationalCase): boolean {
  return opCase.context_jsonb?.created_from === "case_type_settings_test";
}

function buildCaseE2ETickMessage(
  opCase: OperationalCase,
  options?: { ownerResponseText?: string }
): string {
  if (options?.ownerResponseText?.trim()) {
    return [
      `Procesa la respuesta reciente del dueño en el caso ${opCase.id}.`,
      `Estado actual: status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}.`,
      "Acción esperada: sub-skill extract-property-characteristics mientras el caso esté en documents_received.",
      "Integra el evento external_response reciente en context_jsonb.property_data.",
      "No avances a comparables, precio, contrato ni publicación en este tick.",
      "Si faltan campos críticos, prepara preguntas al dueño (purpose=characteristics_pending).",
      "Si los críticos están completos, solicita revisión interna con notify_user(kind=property_data_review).",
    ].join(" ");
  }
  return [
    `Tick E2E de prueba para el caso ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    "Ejecuta la siguiente acción según la skill del caso de prueba. En este tick de prueba controlada las tools operativas y Telegram al contacto están pre-autorizadas (sin HITL).",
  ].join(" ");
}

export type SettingsTestCaseTickResult = {
  case: OperationalCase;
  pending_confirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
  response_preview: string | null;
};

/**
 * Un tick del agente sobre un caso de prueba creado desde Settings.
 * Usado por la API de pruebas y por el webhook de Telegram cuando el
 * contacto externo responde (el cron no procesa estos casos).
 */
export async function runSettingsTestCaseAgentTick(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  userId: string,
  options?: {
    source?: string;
    skipLock?: boolean;
    ownerResponseText?: string;
  }
): Promise<SettingsTestCaseTickResult> {
  ensureAgentToolDepsWired();

  if (!options?.skipLock) {
    const locked = await markCaseProcessing(db, opCase.id, opCase.version, 1);
    if (!locked) {
      throw new Error("case_busy");
    }
  }

  const fresh = await getOperationalCase(db, opCase.id);
  if (!fresh) {
    throw new Error("case_not_found");
  }

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_e2e_started",
      source: options?.source ?? "settings_test_case_tick",
      current_step: fresh.current_step ?? null,
      status: fresh.status,
      note: "Transición con agente sobre caso de prueba (tools reales, pre-autorizadas en Settings).",
    },
  });

  const profile = await getProfile(db, userId);
  const toolSettings = await getUserToolSettings(db, userId);
  const skillSettings = await getUserSkillSettings(db, userId);
  const integrations = await getUserIntegrations(db, userId);

  const githubIntegration = integrations.find((i) => i.provider === "github");
  let githubToken: string | undefined;
  if (githubIntegration) {
    const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
      .encrypted_tokens;
    if (raw) {
      try {
        githubToken = decryptToken(raw);
      } catch {
        /* sin token GitHub */
      }
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;
  const session = await getOrCreateSession(db, userId, "case_runner");

  const agentResult = await runAgent({
    message: buildCaseE2ETickMessage(fresh, {
      ownerResponseText: options?.ownerResponseText,
    }),
    userId,
    sessionId: session.id,
    systemPrompt: profile.agent_system_prompt,
    db,
    enabledTools: toolSettings,
    enabledSkills: skillSettings,
    integrations,
    githubToken,
    userTimezone: profile.timezone,
    userName: profile.name,
    userEmail: profile.email,
    userPhone: profile.phone,
    businessBrain: profile.business_brain ?? {},
    isUnggaAdmin: profile.is_ungga_admin ?? false,
    channel: "case_runner",
    googleCalendarAccessToken,
    autoApproveTools: false,
    toolApprovalPolicy: isSettingsTestCase(fresh)
      ? buildSettingsTestToolApprovalPolicy()
      : undefined,
    caseId: fresh.id,
    toolCallSource: "agent_e2e",
  });

  const afterAgent = await getOperationalCase(db, fresh.id);
  const version = afterAgent?.version ?? fresh.version;
  const updated = await updateOperationalCase(db, fresh.id, version, {
    context: {
      ...(afterAgent?.context_jsonb ?? fresh.context_jsonb),
      test_mode: true,
      controlled_test_e2e_last_run_at: new Date().toISOString(),
      controlled_test_e2e_pending_confirmation: Boolean(
        agentResult.pendingConfirmation
      ),
      controlled_test_status: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: options?.source ?? "settings_test_case_tick",
      result: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      response_preview: agentResult.response?.slice(0, 500) ?? null,
    },
  });

  return {
    case: updated ?? afterAgent ?? fresh,
    pending_confirmation: Boolean(agentResult.pendingConfirmation),
    pendingConfirmation: agentResult.pendingConfirmation ?? null,
    response_preview: agentResult.response?.slice(0, 800) ?? null,
  };
}
