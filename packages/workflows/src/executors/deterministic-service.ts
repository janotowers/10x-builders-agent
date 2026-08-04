/**
 * Executor deterministic_service (Slice 2.4; Technical Plan §20).
 *
 * Invoca una función registrada por nombre. Seguridad: el registro se define
 * en código — NUNCA dispatch dinámico desde strings de la DB a funciones
 * arbitrarias; un `work_type` sin registro produce un reporte fallido
 * explícito (y el dispatcher acabará bloqueando el item), no un lookup
 * creativo.
 */
import type { WorkItem } from "@agents/types";
import type { ExecutorAdapter, ExecutorReport } from "../dispatcher";

export type DeterministicWorkFn = (params: {
  userId: string;
  item: WorkItem;
  signal: AbortSignal;
}) => Promise<Record<string, unknown>>;

export function createDeterministicServiceExecutor(
  registry: ReadonlyMap<string, DeterministicWorkFn>
): ExecutorAdapter {
  return {
    executionMode: "deterministic_service",
    async execute(ctx): Promise<ExecutorReport> {
      const fn = registry.get(ctx.work.item.work_type);
      if (!fn) {
        return {
          outcome: "failed",
          error: {
            reason: "registered_function_not_found",
            work_type: ctx.work.item.work_type,
          },
        };
      }
      try {
        const result = await fn({
          userId: ctx.userId,
          item: ctx.work.item,
          signal: ctx.signal,
        });
        return { outcome: "succeeded", result };
      } catch (error) {
        return {
          outcome: "failed",
          error: {
            message: (error as Error)?.message ?? "deterministic_service_threw",
          },
        };
      }
    },
  };
}
