import {
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  updateOperationalCase,
  type DbClient,
  type UpdateOperationalCaseInput,
} from "@agents/db";
import { adviseCaseTransition } from "@agents/agent";
import type { OperationalCase } from "@agents/types";

type AdvisedCase = Pick<
  OperationalCase,
  | "id"
  | "user_id"
  | "case_type"
  | "status"
  | "current_step"
  | "context_jsonb"
  | "workflow_definition_id"
  | "workflow_definition_version"
>;

/**
 * Slice 1.4 (sitios 2 y 3): versión "advised" de updateOperationalCase para
 * decision handlers y transiciones de runtime/cron. Evalúa la propuesta contra
 * la definición pinned del caso; en advisory registra divergencias y continúa;
 * en enforcing (S1.7) devuelve null sin escribir (el caller muestra su mensaje
 * de reintento y el evento transition_rejected queda en el caso).
 *
 * Uso por archivo:
 *   const advisedUpdateCase = createAdvisedCaseUpdate("price-approval");
 *   const updated = await advisedUpdateCase(db, opCase, opCase.version, patch);
 */
export function createAdvisedCaseUpdate(
  site: string,
  proposer: "decision_handler" | "runtime" = "decision_handler"
) {
  return async function advisedCaseUpdate(
    db: DbClient,
    opCase: AdvisedCase,
    expectedVersion: number,
    patch: UpdateOperationalCaseInput
  ): Promise<OperationalCase | null> {
    // Paridad con el adapter del modelo: al salir de awaiting_documents el
    // guard D4 necesita recentEventTypes (p. ej. external_response emitido al
    // registrar documentos, incluso en la rama internal_user).
    const leavingAwaitingDocuments =
      opCase.current_step === "awaiting_documents" &&
      typeof patch.currentStep === "string" &&
      patch.currentStep !== "awaiting_documents";
    const recentEventTypes = leavingAwaitingDocuments
      ? (await getRecentOperationalCaseEvents(db, opCase.id, 30)).map(
          (event) => event.event_type
        )
      : undefined;

    const advice = await adviseCaseTransition({
      db,
      opCase,
      proposal: {
        toStep: patch.currentStep,
        toStatus: patch.status ?? null,
        proposer,
      },
      recentEventTypes,
      site,
    });
    if (advice.reject) return null;
    const updated = await updateOperationalCase(
      db,
      opCase.id,
      expectedVersion,
      patch
    );
    // El replay histórico (S1.6) mostró que no todos los paths registran la
    // transición from/to; este evento cierra ese hueco de instrumentación.
    if (updated && updated.current_step !== opCase.current_step) {
      try {
        await insertOperationalCaseEvent(db, {
          caseId: opCase.id,
          eventType: "state_changed",
          actor: proposer === "runtime" ? "system" : "user",
          payload: {
            kind: "workflow_step_transition",
            source: site,
            from: { current_step: opCase.current_step, status: opCase.status },
            to: { current_step: updated.current_step, status: updated.status },
          },
        });
      } catch {
        // La transición ya se aplicó; el evento es telemetría.
      }
    }
    return updated;
  };
}

/**
 * Site 2 (decision handlers). El par from/to del payload de divergencia
 * identifica al handler concreto; el site queda como etiqueta genérica.
 */
export const advisedUpdateCase = createAdvisedCaseUpdate("decision_handler");

/** Site 3 (transiciones de runtime: publication runner, intake successor). */
export const advisedRuntimeCaseUpdate = createAdvisedCaseUpdate(
  "runtime",
  "runtime"
);
