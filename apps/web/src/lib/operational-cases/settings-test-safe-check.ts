import {
  createServerClient,
  insertOperationalCaseEvent,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseActivationPolicy,
  OperationalCaseFlowStep,
} from "@agents/types";

type Db = ReturnType<typeof createServerClient>;

export type SettingsTestSafeCheckResult =
  | { case: OperationalCase }
  | { error: "concurrent_update"; status: 409 };

export function safeTestStartStep(policy?: OperationalCaseActivationPolicy | null) {
  return policy?.safe_test?.start_step?.trim() || "intake";
}

export function firstOperationalStep(flow: OperationalCaseFlowStep[] = []) {
  return flow.find(
    (step) =>
      step.step_key !== "intake" && step.step_key !== "transversal_tools"
  )?.step_key;
}

export function safeTestSuccessStep(
  policy?: OperationalCaseActivationPolicy | null,
  flow: OperationalCaseFlowStep[] = []
) {
  return (
    policy?.safe_test?.success_step?.trim() ||
    firstOperationalStep(flow) ||
    "awaiting_documents"
  );
}

export async function runSettingsTestSafeCheck(
  db: Db,
  fresh: OperationalCase,
  opts: {
    activationPolicy?: OperationalCaseActivationPolicy | null;
    flow?: OperationalCaseFlowStep[];
    source?: string;
  } = {}
): Promise<SettingsTestSafeCheckResult> {
  const source = opts.source ?? "case_type_settings";
  const startStep = safeTestStartStep(opts.activationPolicy);
  const successStep = safeTestSuccessStep(opts.activationPolicy, opts.flow);

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_started",
      source,
      safe_mode: true,
      note:
        opts.activationPolicy?.safe_test?.timeline_note ??
        "Validación segura: registro y paso inicial sin agente.",
    },
  });

  const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
    status: "paused",
    currentStep: fresh.current_step === startStep ? successStep : fresh.current_step,
    nextActionAt: null,
    context: {
      ...fresh.context_jsonb,
      test_mode: true,
      controlled_test_playthrough_anchor_at:
        typeof fresh.context_jsonb?.controlled_test_playthrough_anchor_at ===
          "string" &&
        fresh.context_jsonb.controlled_test_playthrough_anchor_at.trim()
          ? fresh.context_jsonb.controlled_test_playthrough_anchor_at.trim()
          : new Date().toISOString(),
      controlled_test_cycle_reset_at: undefined,
      controlled_test_last_run_at: new Date().toISOString(),
      controlled_test_status: "passed_safe_checks",
    },
  });

  if (!updated) {
    return { error: "concurrent_update", status: 409 };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updated.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: "case_type_settings_test",
      status: updated.status,
      current_step: updated.current_step,
      result: "safe_readiness_passed",
      next_action:
        opts.activationPolicy?.safe_test?.next_action ??
        "Ejecutar una transición controlada con agente desde el paso actual.",
    },
  });

  return { case: updated };
}
