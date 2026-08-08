/**
 * Selftest del router de autoría (capa web): batería vía camino determinístico
 * (sin red) + resolución de model id.
 *
 * Run: npm run test:authoring-router --workspace @agents/web
 */

import assert from "node:assert/strict";
import { AUTHORING_BATTERY_FIXTURES } from "@agents/workflows";
import {
  resolveAuthoringRouterModelId,
  routeAuthoringDescription,
} from "./authoring-router";

async function main() {
  let passed = 0;

  const modelId = resolveAuthoringRouterModelId();
  assert.ok(typeof modelId === "string" && modelId.length > 0, "model id");
  passed += 1;
  console.log(`  ✓ resolveAuthoringRouterModelId → ${modelId}`);

  for (const fixture of AUTHORING_BATTERY_FIXTURES) {
    const result = await routeAuthoringDescription({
      description: fixture.description,
      // Modelo inyectado que falla si se invoca — la batería debe ser determinística.
      model: {
        route: async () => {
          throw new Error(`model should not be called for ${fixture.id}`);
        },
      },
    });
    assert.equal(
      result.kind,
      fixture.expectedKind,
      `${fixture.id}: kind expected ${fixture.expectedKind}, got ${result.kind}`
    );
    assert.equal(
      result.source,
      "deterministic",
      `${fixture.id}: expected deterministic source`
    );
    if (fixture.expectedSkillSubtype) {
      assert.equal(
        result.skill_subtype,
        fixture.expectedSkillSubtype,
        `${fixture.id}: skill subtype`
      );
    }
    passed += 1;
    console.log(`  ✓ battery ${fixture.id} → ${result.kind}`);
  }

  // Vacío → fail-closed clarify sin red.
  const empty = await routeAuthoringDescription({ description: "   " });
  assert.equal(empty.kind, "clarify");
  assert.equal(empty.source, "fail_closed");
  passed += 1;
  console.log("  ✓ empty description fail-closed clarify");

  console.log(`authoring-router.selftest: OK (${passed} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
