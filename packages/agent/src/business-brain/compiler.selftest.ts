import assert from "node:assert/strict";
import { buildBusinessBrainContextBlock } from "./compiler";
import { getBusinessBrainWarehouse } from "./schema";
import { buildTenantContextBlock } from "./tenant-context";

const cases: Array<[string, () => void | Promise<void>]> = [];
function it(name: string, fn: () => void | Promise<void>) {
  cases.push([name, fn]);
}

it("compiles soul as style-only guidance with priority warning", () => {
  const block = buildBusinessBrainContextBlock({
    agent_identity: { name: "Gu", role: "copiloto comercial" },
    soul: {
      voice: "directa y cálida",
      brevity: "breve por defecto",
    },
  });
  assert.match(block, /Business Brain Del Perfil/);
  assert.match(block, /menor prioridad que las reglas de seguridad/);
  assert.match(block, /Soul \/ Voz/);
  assert.match(block, /Voz: directa y cálida/);
});

it("operating preferences are explicitly subordinate to HITL/tools/tenant", () => {
  const block = buildBusinessBrainContextBlock({
    operating_preferences: {
      text: "Prioriza leads calientes y pregunta una sola aclaración.",
    },
  });
  assert.match(block, /Preferencias Operativas Del Usuario/);
  assert.match(block, /HITL/);
  assert.match(block, /tenant isolation/);
});

it("data_sources.warehouse normalizes to the same tenant context as legacy", () => {
  const businessBrain = {
    data_sources: {
      warehouse: {
        provider: "bigquery" as const,
        organization_id: "org_new",
        org_name: "Inmobiliaria Nueva",
        project_id: "ungga-full",
        location: "US",
      },
    },
  };
  const warehouse = getBusinessBrainWarehouse(businessBrain);
  assert.equal(warehouse?.organization_id, "org_new");
  assert.equal(warehouse?.org_name, "Inmobiliaria Nueva");

  const tenant = buildTenantContextBlock({
    businessBrain,
    isUnggaAdmin: false,
    userMessage: "cuántos leads tuve este mes",
  });
  assert.equal(tenant.mode, "obligatorio");
  assert.equal(tenant.organizationId, "org_new");
  assert.match(tenant.block, /org_new \(Inmobiliaria Nueva\)/);
  assert.match(tenant.block, /BigQuery project: ungga-full \| location: US/);
});

it("agent avatar URLs are not injected into the prompt", () => {
  const block = buildBusinessBrainContextBlock({
    agent_identity: {
      name: "Gu",
      emoji: "✨",
      avatar_url: "https://example.com/avatar.png",
      avatar_path: "user/agent-avatar.png",
    },
  });
  assert.match(block, /Emoji: ✨/);
  assert.doesNotMatch(block, /avatar\.png/);
  assert.doesNotMatch(block, /https:\/\/example\.com/);
});

async function main() {
  for (const [name, fn] of cases) {
    await fn();
    console.log(`ok - ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
