import { userMessageIsScheduleIntent } from "./schedule-intent";
import assert from "node:assert/strict";

const cases: Array<{ msg: string; expected: boolean }> = [
  { msg: "Me puedes dar cada 5 minutos las Hacker News?", expected: true },
  { msg: "en 10 minutos dame las Hacker News", expected: true },
  { msg: "recuerdame mañana a las 9 que llame al banco", expected: true },
  { msg: "todos los lunes a las 9 envíame el reporte", expected: true },
  { msg: "programa una tarea para mañana", expected: true },
  { msg: "quiero que cada hora me consultes hacker news", expected: true },
  { msg: "Hoy a las 19:45 consulta hacker news", expected: true },
  { msg: "dame las noticias de hoy", expected: false },
  { msg: "qué hora es?", expected: false },
  { msg: "lista mis repos", expected: false },
  { msg: "hola", expected: false },
];

let failed = 0;
for (const c of cases) {
  const got = userMessageIsScheduleIntent(c.msg);
  if (got !== c.expected) {
    failed++;
    console.error(`FAIL: "${c.msg}" expected=${c.expected} got=${got}`);
  }
}
assert.equal(failed, 0, `${failed} schedule-intent cases failed`);
console.log(`schedule-intent self-test ok (${cases.length} cases)`);
