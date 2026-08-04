/**
 * Executor main_agent (Slice 2.4; Technical Plan §20).
 *
 * Invoca el case-runner existente (`runAgent`) con el contrato del work item.
 * La invocación se inyecta (este paquete no puede depender de @agents/agent —
 * la dependencia va en sentido contrario); apps/web la cablea al path real
 * con canal `case_runner` y correlación workItemId/attemptId en el metering.
 *
 * Disciplina de mensaje (finding 18): objetivo + guardrails + criterios de
 * salida. NUNCA portar el estilo paso-a-paso de `buildCaseE2ETickMessage`
 * (§X.2): el ejecutor decide el método dentro de su envelope.
 */
import type { WorkItem } from "@agents/types";
import type { ExecutorAdapter, ExecutorReport } from "../dispatcher";

export interface MainAgentTurnParams {
  userId: string;
  caseId: string;
  workItemId: string;
  attemptId: string;
  message: string;
  signal: AbortSignal;
}

export interface MainAgentTurnResult {
  ok: boolean;
  /** Resumen textual del turno (no chain-of-thought). */
  responseSummary?: string;
  /** true cuando el turno dejó un HITL pendiente: el item va a review. */
  pendingHuman?: boolean;
  error?: string;
}

export type MainAgentTurnRunner = (
  params: MainAgentTurnParams
) => Promise<MainAgentTurnResult>;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/**
 * Mensaje de ejecución del work item: objetivo, guardrails y criterios de
 * salida desde los contratos. Sin procedimientos: el "cómo" es del agente.
 */
export function buildWorkItemExecutionMessage(item: WorkItem): string {
  const input = item.input_contract_jsonb ?? {};
  const objective =
    typeof input.objective === "string" && input.objective.trim()
      ? input.objective.trim()
      : `Completar el trabajo «${item.work_type}» de este caso.`;
  const guardrails = asStringArray(input.guardrails);
  const exitCriteria = asStringArray(
    (item.verification_contract_jsonb ?? {}).exit_criteria
  );
  const requiredKeys = asStringArray(
    (item.output_contract_jsonb ?? {}).required_keys
  );

  const lines: string[] = [
    "[Work item]",
    `Tipo de trabajo: ${item.work_type}`,
    "",
    "Objetivo:",
    objective,
  ];
  if (guardrails.length > 0) {
    lines.push("", "Guardrails (límites, no procedimiento):");
    for (const rail of guardrails) lines.push(`- ${rail}`);
  }
  if (exitCriteria.length > 0 || requiredKeys.length > 0) {
    lines.push("", "Criterios de salida (cuándo está terminado):");
    for (const criterion of exitCriteria) lines.push(`- ${criterion}`);
    if (requiredKeys.length > 0) {
      lines.push(
        `- El resultado debe incluir: ${requiredKeys.join(", ")}.`
      );
    }
  }
  lines.push(
    "",
    "Decide tú el método usando las herramientas disponibles. Cuando el objetivo esté cumplido, registra el resultado en el caso como lo harías normalmente."
  );
  return lines.join("\n");
}

export function createMainAgentExecutor(
  runTurn: MainAgentTurnRunner
): ExecutorAdapter {
  return {
    executionMode: "main_agent",
    async execute(ctx): Promise<ExecutorReport> {
      const { item, attempt } = ctx.work;
      const turn = await runTurn({
        userId: ctx.userId,
        caseId: item.case_id,
        workItemId: item.id,
        attemptId: attempt.id,
        message: buildWorkItemExecutionMessage(item),
        signal: ctx.signal,
      });
      if (!turn.ok) {
        return {
          outcome: "failed",
          error: { message: turn.error ?? "main_agent_turn_failed" },
        };
      }
      return {
        outcome: "succeeded",
        result: { response_summary: turn.responseSummary ?? "" },
        requiresHumanReview: turn.pendingHuman === true,
      };
    },
  };
}
