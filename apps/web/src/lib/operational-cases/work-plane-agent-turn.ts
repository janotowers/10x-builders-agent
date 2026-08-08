/**
 * Runner del turno de agente para el executor main_agent (Slice 2.4).
 *
 * Reusa el path case-runner existente (`runAgent`, canal `case_runner`) con
 * el mensaje de work item (objetivo + guardrails + criterios de salida,
 * finding 18) y correlación `workItemId`/`workItemAttemptId` en el metering
 * de AI usage (cierra el TODO 0.4-8).
 *
 * Paridad con el loop v1 del cron: sin autoApproveTools (las decisiones de
 * juicio comercial conservan su HITL) y la misma tool policy del caso.
 */
import {
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getDurableTask,
  getWorkRun,
  getOrCreateSession,
  getProfile,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  decryptToken,
  type DbClient,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import type { MainAgentTurnRunner } from "@agents/workflows";
import { buildOperationalCaseCronToolApprovalPolicy } from "./operational-case-cron-tool-policy";

export function makeWorkItemAgentTurnRunner(db: DbClient): MainAgentTurnRunner {
  return async (params) => {
    try {
      const profile = await getProfile(db, params.userId);
      if (!profile) return { ok: false, error: "profile_not_found" };
      if (!params.caseId && !params.workRunId) {
        return { ok: false, error: "work_root_required_for_main_agent" };
      }

      const [toolSettings, skillSettings, integrations] = await Promise.all([
        getUserToolSettings(db, params.userId),
        getUserSkillSettings(db, params.userId),
        getUserIntegrations(db, params.userId),
      ]);

      let githubToken: string | undefined;
      const githubIntegration = integrations.find(
        (i) => i.provider === "github"
      );
      const rawGithubTokens = (
        githubIntegration as unknown as { encrypted_tokens?: string } | undefined
      )?.encrypted_tokens;
      if (rawGithubTokens) {
        try {
          githubToken = decryptToken(rawGithubTokens);
        } catch {
          // Sin token de GitHub disponible.
        }
      }

      const googleCalendarAccessToken =
        (await getGoogleCalendarAccessToken(db, params.userId)) ?? undefined;
      const opCase = params.caseId
        ? await getOperationalCase(db, params.caseId)
        : null;
      const workRun = params.workRunId
        ? await getWorkRun(db, params.userId, params.workRunId)
        : null;
      const durableTask = workRun
        ? await getDurableTask(db, params.userId, workRun.durable_task_id)
        : null;
      if (params.workRunId && (!workRun || !durableTask)) {
        return { ok: false, error: "durable_work_root_not_found" };
      }
      const session = await getOrCreateSession(db, params.userId, "case_runner");
      const durableContext = durableTask
        ? [
            "",
            "[Tarea durable]",
            `ID: ${durableTask.id}`,
            `Título: ${durableTask.title}`,
            `Objetivo raíz: ${durableTask.objective}`,
            `Inputs de la corrida: ${JSON.stringify(workRun?.input_jsonb ?? {})}`,
            "No inventes un caso comercial. Devuelve el resultado del trabajo solicitado.",
          ].join("\n")
        : "";

      const result = await runAgent({
        message: `${params.message}${durableContext}`,
        userId: params.userId,
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
        toolApprovalPolicy: opCase
          ? buildOperationalCaseCronToolApprovalPolicy(opCase)
          : undefined,
        caseId: params.caseId ?? undefined,
        workItemId: params.workItemId,
        workItemAttemptId: params.attemptId,
        // 3.4-6: atribución completa work item → definición en el ledger.
        workflowDefinitionId: opCase?.workflow_definition_id ?? null,
      });

      return {
        ok: true,
        responseSummary: (result.response ?? "").slice(0, 2000),
        pendingHuman: Boolean(result.pendingConfirmation),
      };
    } catch (error) {
      return {
        ok: false,
        error: (error as Error)?.message ?? "main_agent_turn_failed",
      };
    }
  };
}
