/**
 * Selftests for the model-facing surface of the SL-1 read capabilities.
 *
 * This is the tool-surface half of SA-1.7. The gateway's own selftests
 * (`apps/web/src/lib/legacy-gateway/legacy-gateway.selftest.ts`) prove the
 * reads; these prove that what a model can reach is exactly four bounded reads,
 * that the Organization is never taken from a model argument, and that a
 * refusal comes back as a result the model can act on rather than as a failed
 * turn.
 */
import assert from "node:assert/strict";
import { TOOL_CATALOG } from "./catalog";
import {
  LEGACY_GATEWAY_TOOL_IDS,
  buildLegacyGatewayTools,
  resolveToolOrganization,
  type LegacyGatewayDeps,
} from "./legacy-gateway-adapters";
import type { ToolContext } from "./tool-context";

/**
 * The builder returns heterogeneous LangChain tools whose `invoke` signatures
 * differ by schema, so the union is not callable. Tests only need the name and
 * a JSON round trip.
 */
interface Invoker {
  name: string;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}
function asInvokers(tools: ReturnType<typeof buildLegacyGatewayTools>): Invoker[] {
  return tools as unknown as Invoker[];
}

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

function fakeCtx(): ToolContext {
  return {
    db: {} as ToolContext["db"],
    userId: "user-1",
    sessionId: "session-1",
    enabledTools: [],
    integrations: [],
    channel: "web",
  };
}

function fakeDeps(overrides: Partial<LegacyGatewayDeps> = {}): LegacyGatewayDeps {
  return {
    listActorOrganizations: async () => [ORG],
    readLeadContext: async () => ({ value: { legacyLeadId: "lead" }, provenance: {} }),
    readRecentMessages: async () => ({ value: { items: [] }, provenance: {} }),
    readDealAppointments: async () => ({ value: { entries: [] }, provenance: {} }),
    readPropertyDetails: async () => ({ value: {}, provenance: {} }),
    describeRefusal: (error) =>
      error instanceof Error && error.name === "LegacyReadRefusal"
        ? { reason: (error as Error & { reason: string }).reason }
        : null,
    ...overrides,
  };
}

function testCatalogEntriesAreReadOnly(): void {
  for (const toolId of LEGACY_GATEWAY_TOOL_IDS) {
    const definition = TOOL_CATALOG.find((entry) => entry.id === toolId);
    assert.ok(definition, `${toolId} is missing from TOOL_CATALOG`);
    assert.equal(definition.risk, "low", `${toolId} is a read; risk must be low`);
    assert.equal(
      /\bRead-only\b/i.test(definition.description),
      true,
      `${toolId} must say it is read-only`
    );
    // No parameter may name a collection, a table or a query: that is the
    // shape a generic CRUD tool would need.
    const properties = Object.keys(
      (definition.parameters_schema as { properties?: Record<string, unknown> })
        .properties ?? {}
    );
    for (const property of properties) {
      assert.equal(
        /(collection|table|query|sql|filter|path|write|body)/i.test(property),
        false,
        `${toolId} exposes a generic parameter: ${property}`
      );
    }
  }

  // Nothing else in the catalog may claim to read Traditional Gu directly.
  const legacyish = TOOL_CATALOG.filter(
    (entry) =>
      !LEGACY_GATEWAY_TOOL_IDS.includes(
        entry.id as (typeof LEGACY_GATEWAY_TOOL_IDS)[number]
      ) && /^legacy_/.test(entry.id)
  );
  assert.deepEqual(
    legacyish.map((entry) => entry.id),
    [],
    "only the four SL-1 capabilities may carry the legacy_ prefix"
  );
  console.log("  ok  catalog exposes four read-only capabilities and nothing generic");
}

function testAvailabilityGating(): void {
  const ctx = fakeCtx();
  const none = buildLegacyGatewayTools(ctx, fakeDeps(), () => false);
  assert.equal(none.length, 0, "a disabled gateway offers no tools at all");

  const all = asInvokers(buildLegacyGatewayTools(ctx, fakeDeps(), () => true));
  assert.deepEqual(
    all.map((entry) => entry.name).sort(),
    [...LEGACY_GATEWAY_TOOL_IDS].sort()
  );

  const one = asInvokers(buildLegacyGatewayTools(
    ctx,
    fakeDeps(),
    (toolId) => toolId === "property_get_details"
  ));
  assert.deepEqual(one.map((entry) => entry.name), ["property_get_details"]);
  console.log("  ok  availability gating is per tool, and off means absent");
}

async function testOrganizationIsResolvedNeverSupplied(): Promise<void> {
  const ctx = fakeCtx();

  // No schema accepts an organization argument, so a model cannot name a tenant.
  for (const definition of TOOL_CATALOG.filter((entry) =>
    LEGACY_GATEWAY_TOOL_IDS.includes(
      entry.id as (typeof LEGACY_GATEWAY_TOOL_IDS)[number]
    )
  )) {
    const properties = Object.keys(
      (definition.parameters_schema as { properties?: Record<string, unknown> })
        .properties ?? {}
    );
    for (const property of properties) {
      assert.equal(
        /organi[sz]ation|tenant|org_id/i.test(property),
        false,
        `${definition.id} would let a model supply a tenant: ${property}`
      );
    }
  }

  // Exactly one active membership resolves.
  const resolved = await resolveToolOrganization(fakeDeps(), ctx);
  assert.equal(resolved.ok && resolved.organizationId, ORG);

  // Zero and many both fail closed rather than picking one.
  const none = await resolveToolOrganization(
    fakeDeps({ listActorOrganizations: async () => [] }),
    ctx
  );
  assert.equal(none.ok, false);
  assert.equal(
    !none.ok && none.result.status,
    "organization_not_resolved"
  );

  const many = await resolveToolOrganization(
    fakeDeps({ listActorOrganizations: async () => [ORG, OTHER_ORG] }),
    ctx
  );
  assert.equal(many.ok, false);
  assert.equal(
    !many.ok && many.result.status === "organization_not_resolved"
      ? many.result.reason
      : "",
    "the acting user belongs to more than one Organization"
  );

  // And the ambiguous case never reaches the gateway.
  let called = false;
  const [leadTool] = asInvokers(buildLegacyGatewayTools(
    ctx,
    fakeDeps({
      listActorOrganizations: async () => [ORG, OTHER_ORG],
      readLeadContext: async () => {
        called = true;
        return {};
      },
    }),
    (toolId) => toolId === "legacy_lead_get_context"
  ));
  const output = JSON.parse(
    (await leadTool.invoke({ legacy_lead_id: "lead-1" })) as string
  );
  assert.equal(output.status, "organization_not_resolved");
  assert.equal(called, false, "an unresolved Organization must not read");
  console.log("  ok  the Organization is resolved from memberships, and ambiguity fails closed");
}

async function testRefusalsAreResults(): Promise<void> {
  const ctx = fakeCtx();
  class Refusal extends Error {
    readonly name = "LegacyReadRefusal";
    constructor(readonly reason: string) {
      super(reason);
    }
  }

  const [leadTool] = asInvokers(buildLegacyGatewayTools(
    ctx,
    fakeDeps({
      readLeadContext: async () => {
        throw new Refusal("belongs_to_another_organization");
      },
    }),
    (toolId) => toolId === "legacy_lead_get_context"
  ));
  const refused = JSON.parse(
    (await leadTool.invoke({ legacy_lead_id: "lead-1" })) as string
  );
  assert.equal(refused.status, "refused");
  assert.equal(refused.reason, "belongs_to_another_organization");

  // An unexpected error is reported, not swallowed into a plausible answer.
  const [failing] = asInvokers(buildLegacyGatewayTools(
    ctx,
    fakeDeps({
      readLeadContext: async () => {
        throw new Error("source unreachable");
      },
    }),
    (toolId) => toolId === "legacy_lead_get_context"
  ));
  const failed = JSON.parse(
    (await failing.invoke({ legacy_lead_id: "lead-1" })) as string
  );
  assert.equal(failed.status, "failed");

  // An environment with no gateway wired answers `not_configured` and reads
  // nothing, rather than failing the turn.
  const [unwired] = asInvokers(buildLegacyGatewayTools(
    ctx,
    null,
    (toolId) => toolId === "legacy_lead_get_context"
  ));
  const unconfigured = JSON.parse(
    (await unwired.invoke({ legacy_lead_id: "lead-1" })) as string
  );
  assert.equal(unconfigured.status, "not_configured");

  // The happy path still returns the gateway result untouched.
  const [ok] = asInvokers(buildLegacyGatewayTools(
    ctx,
    fakeDeps(),
    (toolId) => toolId === "legacy_lead_get_context"
  ));
  const success = JSON.parse(
    (await ok.invoke({ legacy_lead_id: "lead-1" })) as string
  );
  assert.equal(success.status, "ok");
  assert.equal(success.result.value.legacyLeadId, "lead");
  console.log("  ok  refusal, failure and not_configured come back as results, not exceptions");
}

async function main(): Promise<void> {
  console.log("legacy gateway tool surface selftest");
  testCatalogEntriesAreReadOnly();
  testAvailabilityGating();
  await testOrganizationIsResolvedNeverSupplied();
  await testRefusalsAreResults();
  console.log("legacy gateway tool surface selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
