/**
 * Selftest del tablero Trabajo durable: clasificación por prioridad,
 * bandejas blocked vs paused, y copy de fechas (sin "Vence" / heartbeat).
 */
import assert from "node:assert/strict";
import {
  classifyDurableWorkColumn,
  durableCaseDetailDateRows,
  durableCaseStatusLabel,
  formatDurableDateTime,
} from "./durable-work-view-labels";

assert.equal(
  classifyDurableWorkColumn({ status: "waiting_internal" }),
  "needs_attention"
);
assert.equal(
  classifyDurableWorkColumn({
    status: "active",
    work: { byStatus: { review: 1 } },
  }),
  "needs_attention"
);
assert.equal(
  classifyDurableWorkColumn({
    status: "active",
    work: { blocked: 1, byStatus: { blocked: 1 } },
  }),
  "blocked",
  "work blocked gana sobre active"
);
assert.equal(
  classifyDurableWorkColumn({ status: "paused" }),
  "paused",
  "paused es bandeja propia, no blocked"
);
assert.equal(
  classifyDurableWorkColumn({
    status: "paused",
    work: { blocked: 2, byStatus: { blocked: 2 } },
  }),
  "blocked",
  "work blocked gana sobre paused"
);
assert.equal(
  classifyDurableWorkColumn({ status: "waiting_external" }),
  "waiting_external"
);
assert.equal(
  classifyDurableWorkColumn({
    status: "active",
    work: { byStatus: { running: 2 } },
  }),
  "in_progress"
);
assert.equal(classifyDurableWorkColumn({ status: "completed" }), "done");
assert.equal(classifyDurableWorkColumn({ status: "failed" }), "done");

assert.equal(durableCaseStatusLabel("waiting_external"), "Esperando externo");
assert.match(formatDurableDateTime("2026-08-05T15:30:00.000Z"), /\d/);

const now = Date.parse("2026-08-05T18:00:00.000Z");
const detailActive = durableCaseDetailDateRows({
  status: "active",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
  nextActionAt: "2026-08-05T20:00:00.000Z",
  dueAt: "2026-08-06T10:00:00.000Z",
  nowMs: now,
});
assert.ok(
  detailActive.some((r) => r.label === "Fecha límite"),
  "due futuro usa Fecha límite"
);
assert.ok(
  detailActive.some((r) => r.label === "Próx. revisión"),
  "next_action_at con valor se muestra"
);
assert.ok(
  !detailActive.some((r) => /vence/i.test(r.label)),
  "no usar copy Vence"
);
assert.deepEqual(
  detailActive.map((r) => r.label),
  ["Creado", "Actualizado", "Próx. revisión", "Fecha límite"],
  "orden cronológico por timestamp"
);

const detailPausedPastDue = durableCaseDetailDateRows({
  status: "paused",
  createdAt: "2026-07-22T16:21:03.000Z",
  updatedAt: "2026-07-22T22:09:06.000Z",
  nextActionAt: null,
  dueAt: "2026-07-22T16:45:21.000Z",
  nowMs: now,
});
assert.ok(
  !detailPausedPastDue.some((r) => r.label.includes("Fecha límite")),
  "límite vencido en paused se oculta"
);
assert.ok(
  !detailPausedPastDue.some((r) => r.label.includes("Próxima")),
  "next_action nulo no se muestra"
);

const detailActivePastDue = durableCaseDetailDateRows({
  status: "active",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
  dueAt: "2026-08-04T10:00:00.000Z",
  nowMs: now,
});
assert.ok(
  detailActivePastDue.some((r) => r.label === "Fecha límite (vencida)"),
  "en active, límite pasado se marca vencida"
);

const rendered = [
  durableCaseStatusLabel("active"),
  formatDurableDateTime("2026-08-05T15:30:00.000Z"),
  ...detailActive.map((r) => r.label),
].join(" ");
assert.ok(
  !/heartbeat/i.test(rendered),
  `no debe aparecer heartbeat: ${rendered}`
);

console.log("durable-work-view-labels-ui.selftest: ok");
