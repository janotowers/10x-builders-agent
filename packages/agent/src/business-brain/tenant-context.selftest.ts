/**
 * Selftest for `business-brain/tenant-context.ts`.
 *
 * Cubre los 3 casos canónicos del bloque + edge cases:
 *   - Caso 1: usuario regular con identity completa.
 *   - Caso 2: admin Ungga sin inmobiliaria mencionada (cross-tenant).
 *   - Caso 3: admin Ungga con inmobiliaria mencionada en el turno.
 *   - Edge: usuario regular sin identity (modo "no configurado").
 *   - Edge: requires_tenant_context = false → no inyecta nada.
 *   - Edge: deep parse de varias formas de mencionar inmobiliaria.
 *   - Edge: defaults de project/location desde env override.
 *
 * Convención: `tsx tenant-context.selftest.ts` con node:assert/strict
 * y un `async function main()` (ver otros *.selftest.ts del paquete).
 */
import assert from "node:assert/strict";
import {
  appendTenantContextBlock,
  buildTenantContextBlock,
} from "./tenant-context";

const cases: Array<[string, () => void | Promise<void>]> = [];
function it(name: string, fn: () => void | Promise<void>) {
  cases.push([name, fn]);
}

// ── Caso 1: usuario regular OBLIGATORIO ─────────────────────────────
it("Caso 1: usuario regular → MODO OBLIGATORIO con organization_id", () => {
  const r = buildTenantContextBlock({
    businessBrain: {
      identity: { organization_id: "org_7f3a1c", org_name: "Inmobiliaria Garios" },
      bigquery: { project_id: "ungga-full", location: "US" },
    },
    isUnggaAdmin: false,
    userMessage: "¿cuántos leads atendidos tuve este mes?",
  });
  assert.equal(r.mode, "obligatorio");
  assert.equal(r.organizationId, "org_7f3a1c");
  assert.match(r.block, /MODO: OBLIGATORIO/);
  assert.match(r.block, /org_7f3a1c \(Inmobiliaria Garios\)/);
  assert.match(r.block, /TODO query DEBE filtrar por.*organization_id/);
  assert.match(r.block, /Solo puedo consultar datos de Inmobiliaria Garios/);
  assert.match(r.block, /BigQuery project: ungga-full \| location: US/);
});

// ── Edge: usuario regular pero org_name vacío → fallback genérico ───
it("Caso 1b: usuario regular sin org_name → frase genérica 'tu inmobiliaria'", () => {
  const r = buildTenantContextBlock({
    businessBrain: {
      identity: { organization_id: "org_xyz" },
      bigquery: { project_id: "ungga-full", location: "US" },
    },
    isUnggaAdmin: false,
    userMessage: "dame KPIs",
  });
  assert.equal(r.mode, "obligatorio");
  assert.match(r.block, /Solo puedo consultar datos de tu inmobiliaria/);
});

// ── Caso "no configurado": regular sin identity ─────────────────────
it("Caso no configurado: regular con BB vacío → modo obligatorio_no_configurado", () => {
  const r = buildTenantContextBlock({
    businessBrain: {},
    isUnggaAdmin: false,
    userMessage: "cuántos leads tuvimos",
  });
  assert.equal(r.mode, "obligatorio_no_configurado");
  assert.equal(r.organizationId, undefined);
  assert.match(r.block, /MODO: OBLIGATORIO/);
  assert.match(r.block, /inmobiliaria NO configurada/);
  assert.match(r.block, /pídele al usuario que vaya a Ajustes/);
});

// ── Caso 2: admin Ungga sin inmobiliaria nombrada ───────────────────
it("Caso 2: admin Ungga sin inmobiliaria mencionada → modo cross-tenant", () => {
  const r = buildTenantContextBlock({
    businessBrain: {
      bigquery: { project_id: "ungga-full", location: "US" },
    },
    isUnggaAdmin: true,
    userMessage: "dame los KPIs del mes",
  });
  assert.equal(r.mode, "admin_cross_tenant");
  assert.match(r.block, /MODO: ADMIN UNGGA/);
  assert.match(r.block, /cross-tenant/);
  assert.match(r.block, /¿de qué inmobiliaria\(s\) o de todas\?/);
  assert.match(r.block, /BigQuery project: ungga-full/);
});

// ── Caso 3: admin Ungga con "Inmobiliaria Garios" ───────────────────
it("Caso 3: admin Ungga + 'inmobiliaria Garios' → modo organizacion_mencionada", () => {
  const r = buildTenantContextBlock({
    businessBrain: { bigquery: { project_id: "ungga-full", location: "US" } },
    isUnggaAdmin: true,
    userMessage: "dame los leads de Inmobiliaria Garios este mes",
  });
  assert.equal(r.mode, "admin_organizacion_mencionada");
  assert.equal(r.mentionedOrgName, "Garios");
  assert.match(r.block, /Inmobiliaria mencionada en el turno: "Garios"/);
  assert.match(r.block, /helper `org_name → organization_id`/);
});

it("Caso 3b: admin Ungga + nombre entre comillas tipográficas → captura el nombre", () => {
  const r = buildTenantContextBlock({
    businessBrain: {},
    isUnggaAdmin: true,
    userMessage: "dame las citas de \u201CGarios Real Estate\u201D para hoy",
  });
  assert.equal(r.mode, "admin_organizacion_mencionada");
  assert.equal(r.mentionedOrgName, "Garios Real Estate");
});

it("Caso 3c: admin Ungga + 'inmobiliaria Ruz, hoy' → captura sin coma final", () => {
  const r = buildTenantContextBlock({
    businessBrain: {},
    isUnggaAdmin: true,
    userMessage: "leads de inmobiliaria Ruz, hoy",
  });
  assert.equal(r.mode, "admin_organizacion_mencionada");
  assert.equal(r.mentionedOrgName, "Ruz");
});

// ── Edge: defaults de env ──────────────────────────────────────────
it("Defaults: defaultProjectId/Location se aplican si BB no los tiene", () => {
  const r = buildTenantContextBlock({
    businessBrain: { identity: { organization_id: "org_a" } },
    isUnggaAdmin: false,
    userMessage: "x",
    defaultProjectId: "ungga-full",
    defaultLocation: "US",
  });
  assert.match(r.block, /BigQuery project: ungga-full \| location: US/);
});

it("Defaults: BB.bigquery toma precedencia sobre defaultProjectId/Location", () => {
  const r = buildTenantContextBlock({
    businessBrain: {
      identity: { organization_id: "org_a" },
      bigquery: { project_id: "custom-proj", location: "EU" },
    },
    isUnggaAdmin: false,
    userMessage: "x",
    defaultProjectId: "ungga-full",
    defaultLocation: "US",
  });
  assert.match(r.block, /BigQuery project: custom-proj \| location: EU/);
});

it("Defaults: sin BB y sin env → muestra '(no configurado)'", () => {
  const r = buildTenantContextBlock({
    businessBrain: { identity: { organization_id: "org_a" } },
    isUnggaAdmin: false,
    userMessage: "x",
  });
  assert.match(r.block, /BigQuery project: \(no configurado\) \| location: \(no configurada\)/);
});

// ── appendTenantContextBlock con flag ───────────────────────────────
it("appendTenantContextBlock: requiresTenantContext=false deja prompt intacto", () => {
  const out = appendTenantContextBlock("BASE_PROMPT", {
    requiresTenantContext: false,
    businessBrain: { identity: { organization_id: "org_a" } },
    isUnggaAdmin: false,
    userMessage: "x",
  });
  assert.equal(out.prompt, "BASE_PROMPT");
  assert.equal(out.result, null);
});

it("appendTenantContextBlock: requiresTenantContext=true concatena el bloque al prompt", () => {
  const out = appendTenantContextBlock("BASE_PROMPT", {
    requiresTenantContext: true,
    businessBrain: { identity: { organization_id: "org_a", org_name: "Test" } },
    isUnggaAdmin: false,
    userMessage: "x",
  });
  assert.match(out.prompt, /^BASE_PROMPT/);
  assert.match(out.prompt, /\[Contexto de tenant — generado automáticamente\]/);
  assert.equal(out.result?.mode, "obligatorio");
});

// ── Edge: detección cuidadosa de mención (no falsos positivos) ──────
it("Detección: 'inmobiliaria' como palabra suelta sin nombre → NO matchea", () => {
  const r = buildTenantContextBlock({
    businessBrain: {},
    isUnggaAdmin: true,
    userMessage: "qué es una inmobiliaria",
  });
  // "qué" no califica como nombre y `inmobiliaria` queda sin substantivo seguible.
  // Esperamos cross-tenant (no organizacion_mencionada).
  assert.equal(r.mode, "admin_cross_tenant");
});

it("Detección: 'inmobiliaria' al final de la frase sin nombre → NO matchea", () => {
  const r = buildTenantContextBlock({
    businessBrain: {},
    isUnggaAdmin: true,
    userMessage: "dame KPIs por inmobiliaria",
  });
  // 'inmobiliaria' al final no tiene token siguiente → cross-tenant.
  assert.equal(r.mode, "admin_cross_tenant");
});

async function main() {
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(
    `business-brain/tenant-context.selftest: all ${passed} cases passed`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
