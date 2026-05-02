import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@agents/types";
import { sanitizeCompanyDataHistory } from "./sanitize-history";

function msg(role: AgentMessage["role"], content: string): AgentMessage {
  return {
    id: randomUUID(),
    session_id: "s",
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

function run(): void {
  // 1. Single-month user, multi-month assistant with leads context => sanitized.
  {
    const before = [
      msg("user", "cuantos leads tuvimos en abril?"),
      msg(
        "assistant",
        "**Total de leads en abril: 510** | Leads Creados | 510 | **Total de leads en marzo: 282** | Leads Creados | 282 | Estos números representan abril y marzo de 2026."
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after.length, 2);
    assert.equal(after[0].content, before[0].content);
    assert.match(after[1].content, /respuesta histórica descartada/i);
    assert.match(after[1].content, /abril/);
    assert.match(after[1].content, /marzo/);
  }

  // 2. Single-month user, single-month assistant => NOT sanitized.
  {
    const before = [
      msg("user", "cuantos leads tuvimos en abril?"),
      msg(
        "assistant",
        "**Total de leads en abril: 510**. Si necesitas más detalle, ¡házmelo saber!"
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after[1].content, before[1].content);
  }

  // 3. Multi-month user (legit comparative question), multi-month assistant => NOT sanitized.
  {
    const before = [
      msg("user", "compárame leads de abril vs marzo"),
      msg(
        "assistant",
        "Total de leads en abril: 510. Total de leads en marzo: 282."
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after[1].content, before[1].content);
  }

  // 4. Multi-month assistant but no leads/metric context => NOT sanitized.
  {
    const before = [
      msg("user", "que pasó en abril?"),
      msg(
        "assistant",
        "En abril hubo varias reuniones; en marzo hubo una conferencia."
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after[1].content, before[1].content);
  }

  // 5. Tool/system messages are returned unchanged and not used as anchors.
  {
    const before = [
      msg("user", "cuantos leads tuvimos en abril?"),
      msg("tool", "tool noise"),
      msg(
        "assistant",
        "**Total de leads en abril: 510** | **Total de leads en febrero: 20**"
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after[1].content, before[1].content);
    assert.match(after[2].content, /respuesta histórica descartada/i);
  }

  // 6. setiembre normalized to septiembre (does NOT count as a second month).
  {
    const before = [
      msg("user", "cuantos leads tuvimos en septiembre?"),
      msg(
        "assistant",
        "Total de leads en septiembre: 100. Total de leads en setiembre: 100."
      ),
    ];
    const after = sanitizeCompanyDataHistory(before);
    assert.equal(after[1].content, before[1].content);
  }

  console.log("sanitize-history.selftest.ts: ok");
}

run();
