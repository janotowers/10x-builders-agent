/**
 * Selftests de los executor adapters (Slice 2.4).
 *
 * Cubre: disciplina finding-18 del mensaje main-agent (objetivo + guardrails
 * + criterios de salida, sin procedimiento paso-a-paso), mapeo de resultados
 * de turno a ExecutorReport, registro determinista (hit / miss / throw) y el
 * executor human (notificación + review; fallo de notificación ⇒ reporte
 * fallido, nunca trabajo humano invisible).
 */
import assert from "node:assert/strict";
import type { WorkItem, WorkItemAttempt } from "@agents/types";
import type { ExecutorContext } from "../dispatcher";
import {
  buildWorkItemExecutionMessage,
  createMainAgentExecutor,
} from "./main-agent";
import {
  createDeterministicServiceExecutor,
  type DeterministicWorkFn,
} from "./deterministic-service";
import {
  createSpecializedAgentExecutor,
  type SpecializedAgentWorkFn,
} from "./specialized-agent";
import { createHumanExecutor } from "./human";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    case_id: "case-1",
    user_id: "user-1",
    workflow_definition_version: 1,
    work_type: "draft_description",
    origin: "definition_template",
    status: "running",
    priority: 100,
    required_capability: "agent:listing_copy",
    assigned_worker_profile_id: null,
    not_before: null,
    due_at: null,
    attempt_count: 1,
    max_attempts: 3,
    current_attempt_id: "attempt-1",
    blocked_reason: null,
    input_contract_jsonb: {},
    output_contract_jsonb: {},
    verification_contract_jsonb: {},
    result_jsonb: null,
    idempotency_key: "s:draft_description",
    version: 2,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function attempt(over: Partial<WorkItemAttempt> = {}): WorkItemAttempt {
  return {
    id: "attempt-1",
    work_item_id: "item-1",
    user_id: "user-1",
    attempt_number: 1,
    executor_kind: "main_agent",
    executor_ref: "runner-1",
    worker_profile_id: null,
    status: "running",
    claimed_at: "",
    claim_expires_at: "",
    last_liveness_at: null,
    last_progress_at: null,
    completed_at: null,
    error_jsonb: null,
    evidence_jsonb: null,
    created_at: "",
    ...over,
  };
}

function ctx(workItem: WorkItem): ExecutorContext {
  return {
    userId: "user-1",
    work: { item: workItem, attempt: attempt() },
    signal: new AbortController().signal,
    reportProgress: async () => {},
  };
}

function testExecutionMessageDiscipline(): void {
  const message = buildWorkItemExecutionMessage(
    item({
      input_contract_jsonb: {
        objective: "Redactar la descripción comercial de la propiedad.",
        guardrails: [
          "No inventar amenidades que no estén en los hechos del caso.",
          "Máximo 1200 caracteres.",
        ],
      },
      verification_contract_jsonb: {
        exit_criteria: ["La descripción está registrada en el caso."],
      },
      output_contract_jsonb: { required_keys: ["response_summary"] },
    })
  );

  // Objetivo + guardrails + criterios de salida presentes.
  assert.ok(message.includes("Objetivo:"));
  assert.ok(message.includes("Redactar la descripción comercial"));
  assert.ok(message.includes("Guardrails"));
  assert.ok(message.includes("No inventar amenidades"));
  assert.ok(message.includes("Criterios de salida"));
  assert.ok(message.includes("registrada en el caso"));
  assert.ok(message.includes("response_summary"));
  // El método es del ejecutor: sin procedimiento numerado paso-a-paso.
  assert.ok(!/paso \d|step \d/i.test(message));
  assert.ok(message.includes("Decide tú el método"));

  // Sin contratos: fallback razonable al work_type.
  const bare = buildWorkItemExecutionMessage(item());
  assert.ok(bare.includes("draft_description"));
  console.log("✓ mensaje main-agent: objetivo + guardrails + exit criteria (finding 18)");
}

async function testMainAgentReportMapping(): Promise<void> {
  const okExecutor = createMainAgentExecutor(async (params) => {
    assert.equal(params.workItemId, "item-1");
    assert.equal(params.attemptId, "attempt-1");
    assert.ok(params.message.includes("[Work item]"));
    return { ok: true, responseSummary: "hecho", pendingHuman: false };
  });
  const ok = await okExecutor.execute(ctx(item()));
  assert.equal(ok.outcome, "succeeded");
  assert.equal(ok.requiresHumanReview, false);
  assert.deepEqual(ok.result, { response_summary: "hecho" });

  const hitlExecutor = createMainAgentExecutor(async () => ({
    ok: true,
    pendingHuman: true,
  }));
  const hitl = await hitlExecutor.execute(ctx(item()));
  assert.equal(hitl.outcome, "succeeded");
  assert.equal(hitl.requiresHumanReview, true);

  const failExecutor = createMainAgentExecutor(async () => ({
    ok: false,
    error: "boom",
  }));
  const failed = await failExecutor.execute(ctx(item()));
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.error, { message: "boom" });
  console.log("✓ main-agent: ok / HITL→review / fallo");
}

async function testDeterministicRegistry(): Promise<void> {
  const registry = new Map<string, DeterministicWorkFn>([
    ["echo", async ({ item: workItem }) => ({ echoed: workItem.work_type })],
    [
      "explodes",
      async () => {
        throw new Error("kaboom");
      },
    ],
  ]);
  const executor = createDeterministicServiceExecutor(registry);

  const hit = await executor.execute(ctx(item({ work_type: "echo" })));
  assert.equal(hit.outcome, "succeeded");
  assert.deepEqual(hit.result, { echoed: "echo" });

  const miss = await executor.execute(ctx(item({ work_type: "unknown_fn" })));
  assert.equal(miss.outcome, "failed");
  assert.equal(
    (miss.error as { reason: string }).reason,
    "registered_function_not_found"
  );

  const threw = await executor.execute(ctx(item({ work_type: "explodes" })));
  assert.equal(threw.outcome, "failed");
  assert.equal((threw.error as { message: string }).message, "kaboom");
  console.log("✓ deterministic-service: hit / miss explícito / throw contenido");
}

async function testSpecializedAgentExecutor(): Promise<void> {
  const registry = new Map<string, SpecializedAgentWorkFn>([
    [
      "verify_valuation",
      async () => ({
        result: { verdict: "fail", findings: ["banda fuera de rango"] },
        evidence: { verdict: "fail", findings: ["banda fuera de rango"] },
        requiresHumanReview: true,
      }),
    ],
    [
      "verify_ok",
      async () => ({ result: { verdict: "pass", findings: [] } }),
    ],
  ]);
  const executor = createSpecializedAgentExecutor(registry);
  assert.equal(executor.executionMode, "specialized_agent");

  // Verdict fail de negocio: succeeded + review humano, NUNCA retry ciego.
  const fail = await executor.execute(ctx(item({ work_type: "verify_valuation" })));
  assert.equal(fail.outcome, "succeeded");
  assert.equal(fail.requiresHumanReview, true);
  assert.deepEqual(fail.evidence, {
    verdict: "fail",
    findings: ["banda fuera de rango"],
  });

  const pass = await executor.execute(ctx(item({ work_type: "verify_ok" })));
  assert.equal(pass.outcome, "succeeded");
  assert.equal(pass.requiresHumanReview, undefined);

  const miss = await executor.execute(ctx(item({ work_type: "unknown" })));
  assert.equal(miss.outcome, "failed");
  assert.equal(
    (miss.error as { reason: string }).reason,
    "registered_specialized_agent_not_found"
  );
  console.log("✓ specialized-agent: verdict→review / pass / miss explícito");
}

async function testHumanExecutor(): Promise<void> {
  const notified: string[] = [];
  const executor = createHumanExecutor(async ({ item: workItem }) => {
    notified.push(workItem.id);
  });
  const report = await executor.execute(ctx(item()));
  assert.equal(report.outcome, "succeeded");
  assert.equal(report.requiresHumanReview, true);
  assert.deepEqual(notified, ["item-1"]);

  const failing = createHumanExecutor(async () => {
    throw new Error("telegram down");
  });
  const failedReport = await failing.execute(ctx(item()));
  assert.equal(failedReport.outcome, "failed");
  assert.equal(
    (failedReport.error as { reason: string }).reason,
    "human_notification_failed"
  );
  console.log("✓ human: notifica + review; fallo de notificación reintenta");
}

async function main(): Promise<void> {
  testExecutionMessageDiscipline();
  await testMainAgentReportMapping();
  await testDeterministicRegistry();
  await testSpecializedAgentExecutor();
  await testHumanExecutor();
  console.log("executors selftest: all green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
