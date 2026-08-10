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

  // Regresión 2026-08-09: el copy operativo del asistente ("Tu mensaje podría
  // corresponder a este caso en curso…") contiene la palabra «mensaje» y
  // secuestraba la continuidad hacia lead-follow-up-draft. Un cambio de mes
  // tras un turno de métricas debe seguir siendo company-data.
  const analyticsAfterClarifyNoise = deriveSkillRoutingContext(
    [
      msg("user", "cuantos leads tuvimos en abril?"),
      msg(
        "assistant",
        "En abril tuvimos 510 leads creados. Lo medimos en horario de México CDMX y considerando la inmobiliaria Alebrixe."
      ),
      msg("user", "y en julio?"),
      msg(
        "assistant",
        "Tu mensaje podría corresponder a este caso en curso:\n• [Real] Casa en venta en Las Fuentes\n¿Quieres que lo asocie a ese caso? Responde: sí / no."
      ),
    ],
    "y en julio?",
    { identity: { org_name: "Alebrixe" } }
  );
  assert.equal(analyticsAfterClarifyNoise.isContinuation, true);
  assert.equal(analyticsAfterClarifyNoise.lastActiveSkill, "company-data");
  assert.equal(shouldRouteFromContinuity(analyticsAfterClarifyNoise), true);

  // Incluso sin la palabra «total»/«cuántos» en el historial (metric ausente),
  // un fragmento de solo-mes con dominio reciente es continuación analítica.
  const analyticsDeclarativeHistory = deriveSkillRoutingContext(
    [
      msg(
        "assistant",
        "En abril tuvimos 510 leads creados. Lo medimos en horario de México CDMX."
      ),
    ],
    "y en julio?",
    {}
  );
  assert.equal(analyticsDeclarativeHistory.lastActiveSkill, "company-data");

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
