import assert from "node:assert/strict";
import { userMessageAnchorsCalendarPeriodOnly } from "./calendar-period-intent";

const yes = [
  "de esta semana",
  "esta semana",
  "hoy",
  "el mes en curso",
  "this week",
  "next week",
];
const no = [
  "lista mis repos de esta semana",
  "github esta semana",
  "issues de esta semana en mi-org/mi-repo",
  "crea un evento mañana",
  "dame los calendarios que tengo",
];

for (const msg of yes) {
  assert.equal(
    userMessageAnchorsCalendarPeriodOnly(msg),
    true,
    `expected calendar period: ${JSON.stringify(msg)}`
  );
}
for (const msg of no) {
  assert.equal(
    userMessageAnchorsCalendarPeriodOnly(msg),
    false,
    `expected NOT calendar-only: ${JSON.stringify(msg)}`
  );
}

console.log("calendar-period-intent.selftest: passed");
