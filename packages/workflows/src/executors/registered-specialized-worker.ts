/**
 * Executor registered_specialized_worker (Slice 3.4-3; Technical Plan §9/§20;
 * antes `specialized_agent`, renombrado 2026-08-06 para no colisionar con
 * futuros sub-agentes IA — ver taxonomía en @agents/types WORKER_EXECUTION_MODES).
 *
 * Igual que deterministic_service, el registro se define en CÓDIGO por
 * `work_type` — nunca dispatch dinámico de strings de DB. La diferencia es
 * semántica: un registered specialized worker tiene contexto AISLADO y
 * contrato de verificación propio, y puede ser híbrido — checks deterministas
 * siempre, segunda opinión model-backed opcional (p. ej. el valuation
 * verifier: pass/fail + findings, superficie read-only). Un verdict de
 * negocio "fail" NO es un fallo de infraestructura: el runner devuelve
 * `outcome: "review"` vía `pendingHuman` para que el item quede en revisión
 * en lugar de reintentar ciegamente.
 */
import type { WorkItem } from "@agents/types";
import type { ExecutorAdapter, ExecutorReport } from "../dispatcher";

export type RegisteredSpecializedWorkerFn = (params: {
  userId: string;
  item: WorkItem;
  signal: AbortSignal;
}) => Promise<{
  result: Record<string, unknown>;
  /** Evidencia del contrato de verificación (verdict, findings…). */
  evidence?: Record<string, unknown>;
  /** true ⇒ el item termina en review (decisión/verdict que un humano ve). */
  requiresHumanReview?: boolean;
}>;

export function createRegisteredSpecializedWorkerExecutor(
  registry: ReadonlyMap<string, RegisteredSpecializedWorkerFn>
): ExecutorAdapter {
  return {
    executionMode: "registered_specialized_worker",
    async execute(ctx): Promise<ExecutorReport> {
      const fn = registry.get(ctx.work.item.work_type);
      if (!fn) {
        return {
          outcome: "failed",
          error: {
            reason: "registered_specialized_worker_not_found",
            work_type: ctx.work.item.work_type,
          },
        };
      }
      try {
        const { result, evidence, requiresHumanReview } = await fn({
          userId: ctx.userId,
          item: ctx.work.item,
          signal: ctx.signal,
        });
        return {
          outcome: "succeeded",
          result,
          ...(evidence ? { evidence } : {}),
          ...(requiresHumanReview ? { requiresHumanReview: true } : {}),
        };
      } catch (error) {
        return {
          outcome: "failed",
          error: {
            message:
              (error as Error)?.message ?? "registered_specialized_worker_threw",
          },
        };
      }
    },
  };
}
