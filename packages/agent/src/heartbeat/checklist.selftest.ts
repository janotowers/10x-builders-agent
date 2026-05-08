import assert from "node:assert/strict";
import {
  extractReminderWindowMinutes,
  formatHeartbeatChecklist,
  parseHeartbeatChecklist,
} from "./checklist";

function testExtractReminderWindowMinutesSpanish(): void {
  assert.equal(extractReminderWindowMinutes("60 minutos antes"), 60);
  assert.equal(extractReminderWindowMinutes("30 min"), 30);
  assert.equal(extractReminderWindowMinutes("ventana de 2 horas"), 120);
}

function testExtractReminderWindowMinutesEnglish(): void {
  assert.equal(extractReminderWindowMinutes("starts in 90 minutes"), 90);
  assert.equal(extractReminderWindowMinutes("alert 1 hour ahead"), 60);
}

function testExtractReminderWindowMinutesEmpty(): void {
  assert.equal(extractReminderWindowMinutes(undefined, ""), null);
  assert.equal(extractReminderWindowMinutes("no number here"), null);
}

function testParseHeartbeatChecklistExtractsWindowFromThreshold(): void {
  const md = [
    "# Heartbeat checklist",
    "",
    "- Detectar reuniones próximas; Umbral: solo si faltan 60 minutos o menos para una reunión; Avisar cuando: hay acción concreta antes de la reunión.",
  ].join("\n");
  const items = parseHeartbeatChecklist(md);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.reminderWindowMinutes, 60);
}

function testParseHeartbeatChecklistRespectsExplicitVentana(): void {
  const md = [
    "# Heartbeat checklist",
    "",
    "- Detectar reuniones próximas; Umbral: hay reunión próxima; Avisar cuando: hay acción concreta; Ventana_minutos: 30.",
  ].join("\n");
  const items = parseHeartbeatChecklist(md);
  assert.equal(items[0]?.reminderWindowMinutes, 30);
}

function testFormatHeartbeatChecklistRoundTrip(): void {
  const md = [
    "# Heartbeat checklist",
    "",
    "- Detectar reuniones próximas; Umbral: solo si faltan 60 minutos; Avisar cuando: hay acción concreta; Skills: meeting-readiness-watch; Fuentes: calendar, calendar_tasks; Ventana_minutos: 45.",
  ].join("\n");
  const items = parseHeartbeatChecklist(md);
  const reformatted = formatHeartbeatChecklist(items);
  const reparsed = parseHeartbeatChecklist(reformatted);
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0]?.reminderWindowMinutes, 45);
  assert.deepEqual(reparsed[0]?.candidateSkills, ["meeting-readiness-watch"]);
  assert.deepEqual(reparsed[0]?.sources, ["calendar", "calendar_tasks"]);
}

function main(): void {
  testExtractReminderWindowMinutesSpanish();
  testExtractReminderWindowMinutesEnglish();
  testExtractReminderWindowMinutesEmpty();
  testParseHeartbeatChecklistExtractsWindowFromThreshold();
  testParseHeartbeatChecklistRespectsExplicitVentana();
  testFormatHeartbeatChecklistRoundTrip();
  console.log("heartbeat checklist selftest: all 6 cases passed");
}

main();
