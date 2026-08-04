/**
 * UI selftest de la vista de trabajo (Slice 2.5-4).
 *
 * Verifica el mapeo estado/etiqueta y — crítico — que la palabra "heartbeat"
 * jamás se renderiza en ninguna combinación de cues de liveness (regla 4:
 * ese nombre está reservado para el Gu OS Heartbeat de proactividad).
 */
import assert from "node:assert/strict";
import {
  blockedReasonLabel,
  caseWorkChipLabel,
  executorKindLabel,
  livenessCue,
  retryStateLabel,
  verificationStateLabel,
  workItemStatusLabel,
  workTypeLabel,
  WORK_VIEW_COLUMNS,
} from "./work-view-labels";

// Columnas: las seis del plan, en orden.
assert.deepEqual(
  WORK_VIEW_COLUMNS.map((c) => c.status),
  ["todo", "ready", "running", "blocked", "review", "done"]
);

assert.equal(workItemStatusLabel("ready"), "Listo para ejecutar");
assert.equal(workItemStatusLabel("cancelled"), "Cancelado");

assert.equal(executorKindLabel("main_agent"), "Agente principal");
assert.equal(executorKindLabel("deterministic_service"), "Servicio determinista");
assert.equal(executorKindLabel("human"), "Humano");
assert.equal(executorKindLabel(null), "—");

assert.equal(retryStateLabel({ attempt_count: 2, max_attempts: 3 }), "Intento 2/3");

// Work types: diccionario para los conocidos; humanización genérica como
// fallback. El slug crudo se muestra aparte en la UI, nunca se pierde.
assert.equal(workTypeLabel("work_plane_synthetic_echo"), "Eco de prueba (sintético)");
assert.equal(
  workTypeLabel("work_plane_synthetic_fan_in"),
  "Convergencia de ramas (sintético)"
);
assert.equal(
  workTypeLabel("work_plane_synthetic_unregistered"),
  "Tipo no registrado (fixture de fallo)"
);
assert.equal(workTypeLabel("generate_listing_copy"), "Generate listing copy");
assert.equal(workTypeLabel("revisar-contrato"), "Revisar contrato");

// Motivos de bloqueo: códigos conocidos traducidos; texto libre tal cual.
assert.equal(
  blockedReasonLabel("max_attempts_exhausted"),
  "Se agotaron los intentos permitidos"
);
assert.equal(
  blockedReasonLabel("no_executor_for_capability:contract_generation"),
  "Sin ejecutor para la capacidad «contract_generation»"
);
assert.equal(
  blockedReasonLabel("no_executor_for_capability:"),
  "Sin ejecutor para la capacidad «desconocida»"
);
assert.equal(blockedReasonLabel(null), "Razón desconocida");
assert.equal(blockedReasonLabel(""), "Razón desconocida");
assert.equal(blockedReasonLabel("error inesperado del servicio"), "error inesperado del servicio");

assert.equal(
  verificationStateLabel({
    status: "done",
    verification_contract_jsonb: {},
    output_contract_jsonb: {},
  }),
  "Verificado"
);
assert.equal(
  verificationStateLabel({
    status: "review",
    verification_contract_jsonb: {},
    output_contract_jsonb: {},
  }),
  "Pendiente de revisión humana"
);
assert.equal(
  verificationStateLabel({
    status: "running",
    verification_contract_jsonb: {},
    output_contract_jsonb: { required_keys: ["a"] },
  }),
  "Contrato declarado"
);

// Cues de liveness (§10) en todas las combinaciones relevantes.
const now = new Date("2026-08-03T18:00:00.000Z");
const activeCue = livenessCue(
  {
    status: "running",
    claim_expires_at: "2026-08-03T18:05:00.000Z",
    last_liveness_at: "2026-08-03T17:59:00.000Z",
  },
  now
);
assert.ok(activeCue.startsWith("Ejecutor activo"));
assert.ok(activeCue.includes("vitalidad"));
assert.ok(activeCue.includes("El claim expira"));

const stalledCue = livenessCue(
  {
    status: "running",
    claim_expires_at: "2026-08-03T17:00:00.000Z",
    last_liveness_at: null,
  },
  now
);
assert.equal(stalledCue, "La ejecución parece estancada · Claim expirado");

const reassignedCue = livenessCue(
  {
    status: "claim_expired",
    claim_expires_at: "2026-08-03T17:00:00.000Z",
    last_liveness_at: null,
  },
  now
);
assert.equal(reassignedCue, "Claim expirado · Trabajo reasignado");

const noLivenessYet = livenessCue(
  {
    status: "running",
    claim_expires_at: "2026-08-03T18:05:00.000Z",
    last_liveness_at: null,
  },
  now
);
assert.ok(noLivenessYet.includes("Sin actualización de vitalidad todavía"));

// La palabra prohibida jamás se renderiza, en ninguna salida del módulo.
const allRendered = [
  ...WORK_VIEW_COLUMNS.map((c) => c.label),
  workItemStatusLabel("cancelled"),
  executorKindLabel("main_agent"),
  executorKindLabel("deterministic_service"),
  executorKindLabel("human"),
  executorKindLabel("unresolved"),
  retryStateLabel({ attempt_count: 1, max_attempts: 3 }),
  verificationStateLabel({
    status: "todo",
    verification_contract_jsonb: {},
    output_contract_jsonb: {},
  }),
  activeCue,
  stalledCue,
  reassignedCue,
  noLivenessYet,
  caseWorkChipLabel({ total: 3, blocked: 1 }),
  workTypeLabel("work_plane_synthetic_echo"),
  workTypeLabel("some_future_work_type"),
  blockedReasonLabel("max_attempts_exhausted"),
  blockedReasonLabel("no_executor_for_capability:x"),
].join(" | ");
assert.ok(
  !/heartbeat/i.test(allRendered),
  `la palabra "heartbeat" no debe renderizarse jamás en la vista de trabajo: ${allRendered}`
);

// Chip del broker: resumen sin estados de trabajo.
assert.equal(caseWorkChipLabel({ total: 0, blocked: 0 }), "");
assert.equal(caseWorkChipLabel({ total: 1, blocked: 0 }), "1 trabajo");
assert.equal(caseWorkChipLabel({ total: 3, blocked: 1 }), "3 trabajos · 1 bloqueado(s)");

console.log("work-view-labels-ui.selftest: ok");
