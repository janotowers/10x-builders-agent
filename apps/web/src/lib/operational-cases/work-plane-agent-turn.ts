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
      const opCase = await getOperationalCase(db, params.caseId);
      const session = await getOrCreateSession(db, params.userId, "case_runner");

      const result = await runAgent({
        message: params.message,
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
        caseId: params.caseId,
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
