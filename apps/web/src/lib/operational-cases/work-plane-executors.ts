/**
 * Resolución de ejecutores del plano de trabajo (Slices 2.3/2.4).
 *
 * Convención Phase 2 de `required_capability` → modo de ejecución:
 *   - `human` o `human:<detalle>`   → executor human (notifica + review)
 *   - `service` o `service:<detalle>` → deterministic_service (registro en
 *     código por `work_type`; NUNCA dispatch dinámico de strings de DB a
 *     funciones arbitrarias)
 *   - `agent` o `agent:<detalle>`   → main_agent (case-runner existente)
 *   - cualquier otra capability     → null ⇒ el dispatcher bloquea el item
 *     explícitamente (`no_executor_for_capability:<capability>`); los modos
 *     declarados-pero-no-implementados permanecen sin implementar.
 *
 * En Fase 3.4 esta resolución pasa a worker profiles con enforcement de
 * `allowed_tools`/`allowed_data_scopes` en la selección.
 */
import type { DbClient } from "@agents/db";
import { upsertActiveInternalUserNotification } from "@agents/db";
import type { ExecutorAdapter } from "@agents/workflows";
import {
  createDeterministicServiceExecutor,
  createHumanExecutor,
  createMainAgentExecutor,
  type DeterministicWorkFn,
} from "@agents/workflows";
import type { WorkItem } from "@agents/types";
import { makeWorkItemAgentTurnRunner } from "./work-plane-agent-turn";

/**
 * Registro de funciones deterministas (por `work_type`), definido en código.
 * Los `work_plane_synthetic_*` existen para el soak 2.6 (casos sintéticos):
 * devuelven el input contract como resultado, sin efectos. Los tres tipos de
 * rama componen el fixture de rama paralela + fan-in del soak vivo.
 */
const syntheticEcho: DeterministicWorkFn = async ({ item }) => ({
  echo: item.input_contract_jsonb,
  work_type: item.work_type,
  completed_at: new Date().toISOString(),
});

const DETERMINISTIC_REGISTRY: ReadonlyMap<string, DeterministicWorkFn> = new Map<
  string,
  DeterministicWorkFn
>([
  ["work_plane_synthetic_echo", syntheticEcho],
  ["work_plane_synthetic_branch_a", syntheticEcho],
  ["work_plane_synthetic_branch_b", syntheticEcho],
  ["work_plane_synthetic_fan_in", syntheticEcho],
]);

export function createWorkPlaneExecutorResolver(
  db: DbClient
): (item: WorkItem) => ExecutorAdapter | null {
  const mainAgent = createMainAgentExecutor(makeWorkItemAgentTurnRunner(db));
  const deterministic = createDeterministicServiceExecutor(
    DETERMINISTIC_REGISTRY
  );
  const human = createHumanExecutor(async ({ userId, item }) => {
    const objective = (item.input_contract_jsonb ?? {}).objective;
    await upsertActiveInternalUserNotification(db, {
      userId,
      caseId: item.case_id,
      kind: "work_item_review",
      title: `Trabajo pendiente de revisión: ${item.work_type}`,
      body:
        typeof objective === "string" && objective.trim()
          ? objective.trim()
          : `El trabajo «${item.work_type}» requiere intervención humana.`,
      metadata: { work_item_id: item.id },
    });
  });

  return (item: WorkItem): ExecutorAdapter | null => {
    const capability = item.required_capability;
    if (capability === "human" || capability.startsWith("human:")) return human;
    if (capability === "service" || capability.startsWith("service:")) {
      return deterministic;
    }
    if (capability === "agent" || capability.startsWith("agent:")) {
      return mainAgent;
    }
    return null;
  };
}
