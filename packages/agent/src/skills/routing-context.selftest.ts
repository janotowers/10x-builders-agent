import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@agents/types";
import {
  deriveSkillRoutingContext,
  formatRoutingContextForSelector,
  shouldRouteFromContinuity,
} from "./routing-context";

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
  const ctx = deriveSkillRoutingContext(
    [
      msg("user", "cuantos leads tuvimos en abril?"),
      msg("assistant", "Total de leads en abril: 510"),
    ],
    "y en febrero?",
    { identity: { org_name: "Alebrixe" } }
  );

  assert.equal(ctx.isContinuation, true);
  assert.equal(ctx.lastActiveSkill, "company-data");
  assert.equal(ctx.lastDomain, "leads");
  assert.equal(ctx.lastMetric, "count");
  assert.equal(ctx.lastPeriod, "febrero 2026");
  assert.equal(ctx.lastTenantName, "Alebrixe");
  assert.equal(ctx.confidence, "high");
  assert.equal(shouldRouteFromContinuity(ctx), true);
  assert.match(formatRoutingContextForSelector(ctx), /"lastDomain": "leads"/);

  const nonBusiness = deriveSkillRoutingContext(
    [
      msg("user", "que tengo en el calendario en abril?"),
      msg("assistant", "Tienes una cita el martes."),
    ],
    "y en febrero?",
    {}
  );
  assert.equal(nonBusiness.lastActiveSkill, undefined);
  assert.equal(shouldRouteFromContinuity(nonBusiness), false);

  const leadFollowUp = deriveSkillRoutingContext(
    [
      msg("user", "Ayúdame a escribir un WhatsApp para darle seguimiento a un lead"),
      msg(
        "assistant",
        "Claro, necesito un poco más de información: Nombre del lead, propiedad o desarrollo, última interacción y tono."
      ),
    ],
    "Su nombre es Julieta Evelia",
    {}
  );
  assert.equal(leadFollowUp.isContinuation, true);
  assert.equal(leadFollowUp.lastActiveSkill, "lead-follow-up-draft");
  assert.equal(leadFollowUp.confidence, "high");
  assert.equal(shouldRouteFromContinuity(leadFollowUp), true);
  assert.match(
    formatRoutingContextForSelector(leadFollowUp),
    /"lastActiveSkill": "lead-follow-up-draft"/
  );

  const leadFollowUpWithArticle = deriveSkillRoutingContext(
    [
      msg("user", "Ayúdame a escribir un WhatsApp para darle seguimiento a un lead"),
      msg(
        "assistant",
        "Para poder ayudarte mejor, necesito que me proporciones el nombre del lead."
      ),
    ],
    "El nombre es Julieta Evelia pero no recuerdo qué propiedad",
    {}
  );
  assert.equal(leadFollowUpWithArticle.isContinuation, true);
  assert.equal(leadFollowUpWithArticle.lastActiveSkill, "lead-follow-up-draft");
  assert.equal(shouldRouteFromContinuity(leadFollowUpWithArticle), true);

  console.log("routing-context.selftest.ts: ok");
}

run();
