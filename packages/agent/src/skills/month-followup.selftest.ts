import assert from "node:assert/strict";
import {
  isShortMonthPeriodFollowUp,
  recentMessagesSuggestCompanyData,
} from "./month-followup";

function run(): void {
  assert.equal(isShortMonthPeriodFollowUp("y en abril?"), true);
  assert.equal(isShortMonthPeriodFollowUp("¿y en febrero?"), true);
  assert.equal(isShortMonthPeriodFollowUp("y en marzo"), true);
  assert.equal(isShortMonthPeriodFollowUp("y en julio?"), true);
  assert.equal(isShortMonthPeriodFollowUp("marzo"), true);
  assert.equal(isShortMonthPeriodFollowUp("cuantos leads en abril"), false);
  assert.equal(isShortMonthPeriodFollowUp("hola"), false);

  assert.equal(
    recentMessagesSuggestCompanyData([
      {
        id: "1",
        session_id: "s",
        role: "user",
        content: "cuantos leads tuvimos en abril?",
        created_at: "",
      },
    ]),
    true
  );
  assert.equal(
    recentMessagesSuggestCompanyData([
      {
        id: "1",
        session_id: "s",
        role: "assistant",
        content: "**Total de leads en abril: 510**",
        created_at: "",
      },
    ]),
    true
  );
  assert.equal(
    recentMessagesSuggestCompanyData([
      {
        id: "1",
        session_id: "s",
        role: "user",
        content: "como se llama mi inmobiliaria?",
        created_at: "",
      },
    ]),
    false
  );

  console.log("month-followup.selftest.ts: ok");
}

run();
