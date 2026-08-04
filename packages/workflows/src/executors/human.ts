/**
 * Executor human (Slice 2.4; Technical Plan §20).
 *
 * No ejecuta trabajo: notifica al humano interno (registry de
 * internal-notifications, inyectado por apps/web) y deja el item en `review`
 * vía `requiresHumanReview`. El humano lo termina desde la vista de trabajo
 * (2.5). Si la notificación falla, el reporte falla y el item reintenta —
 * nunca dejar trabajo humano invisible en review sin aviso.
 */
import type { WorkItem } from "@agents/types";
import type { ExecutorAdapter, ExecutorReport } from "../dispatcher";

export type HumanWorkNotifier = (params: {
  userId: string;
  item: WorkItem;
}) => Promise<void>;

export function createHumanExecutor(notify: HumanWorkNotifier): ExecutorAdapter {
  return {
    executionMode: "human",
    async execute(ctx): Promise<ExecutorReport> {
      try {
        await notify({ userId: ctx.userId, item: ctx.work.item });
      } catch (error) {
        return {
          outcome: "failed",
          error: {
            reason: "human_notification_failed",
            message: (error as Error)?.message ?? "unknown",
          },
        };
      }
      return {
        outcome: "succeeded",
        result: { handoff: "internal_notification_created" },
        requiresHumanReview: true,
      };
    },
  };
}
