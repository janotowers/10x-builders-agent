import assert from "node:assert/strict";
import {
  notifyUserIntentForFlowTool,
  normalizeToolTestBehavior,
  toolTestBehaviorForFlowTool,
  toolTestBehaviorForTool,
} from "./tool-test-behavior";

const prepare = toolTestBehaviorForTool("prepare_listing_description_draft");
assert.equal(prepare.kind, "case_assembler");
assert.deepEqual(prepare.data_sources, [
  "case_context",
  "prior_artifacts",
  "manual_overrides",
]);
assert.deepEqual(prepare.dependency_steps, [
  "analyze_property_images",
  "lookup_property_surroundings",
]);
assert.ok(
  prepare.prerequisites.includes("pricing_proposal.salida (aprobado)"),
  "prepare_listing_description_draft debe declarar salida aprobada."
);
assert.ok(
  prepare.reads_from_case.includes("pricing_proposal"),
  "prepare_listing_description_draft debe declarar lectura de pricing_proposal."
);
assert.ok(
  prepare.persists_to_case.includes("listing_description_draft"),
  "prepare_listing_description_draft debe declarar persistencia de borrador."
);

const analyze = toolTestBehaviorForTool("analyze_property_images");
assert.equal(analyze.kind, "prior_artifact");
assert.equal(analyze.label, "Procesa fotos del caso");
assert.equal(analyze.user_facing_test_type, "Tool con fotos/assets de prueba");
assert.ok(
  analyze.persists_to_case.some((entry) => entry.includes("photo_analysis")),
  "analyze_property_images debe documentar persistencia de photo_analysis."
);

const surroundings = toolTestBehaviorForTool("lookup_property_surroundings");
assert.equal(surroundings.kind, "self_contained");
assert.equal(surroundings.label, "Contexto de zona");
assert.ok(
  surroundings.persists_to_case.some((entry) => entry.includes("zone_context")),
  "lookup_property_surroundings debe documentar persistencia de zone_context."
);

const notifyUser = toolTestBehaviorForTool("notify_user");
assert.equal(notifyUser.kind, "case_backed");
assert.ok(
  notifyUser.prerequisites.includes("listing_description_draft para kind=listing_description_review"),
  "notify_user debe declarar el borrador como precondicion del review de descripcion."
);

const easyBrokerCreate = toolTestBehaviorForTool("easybroker_create_listing");
assert.equal(easyBrokerCreate.kind, "case_assembler");
assert.equal(easyBrokerCreate.label, "Publicadora con datos del caso");

const unggaPublish = toolTestBehaviorForTool("ungga_publish_listing");
assert.equal(unggaPublish.kind, "case_assembler");
assert.equal(unggaPublish.label, "Publicadora con datos del caso");
assert.ok(
  notifyUser.downstream_for.includes("listing_description_approved"),
  "notify_user debe declarar la aprobacion de descripcion como downstream."
);

const notifyClosingFlowTool = {
  tool_id: "notify_user",
  tool_label: "Enviar resumen final de publicación",
  tool_description:
    "Notifica al asesor el cierre del caso con links y resumen canónico (listing_published_summary).",
};
assert.equal(
  notifyUserIntentForFlowTool(notifyClosingFlowTool),
  "listing_published_summary",
  "La segunda instancia de notify_user debe resolverse como cierre."
);
const notifyClosing = toolTestBehaviorForFlowTool(notifyClosingFlowTool);
assert.equal(notifyClosing.label, "Resumen final de cierre");
assert.ok(
  notifyClosing.prerequisites.some((entry) => entry.includes("published.easybroker")),
  "El cierre debe declarar precondiciones de publicación, no de borrador."
);
assert.ok(
  !notifyClosing.downstream_for.includes("listing_description_approved"),
  "El cierre no debe declararse como HITL de descripción."
);

const partial = normalizeToolTestBehavior("prepare_listing_description_draft", {
  kind: "case_assembler",
  label: "Ensambladora del caso",
  summary: "metadata parcial",
  mode_hint: "hint",
  prerequisites: ["case_id del caso de prueba"],
});
assert.ok(
  partial.reads_from_case.length > 0,
  "normalizeToolTestBehavior debe rellenar reads_from_case desde defaults."
);
assert.ok(
  partial.persists_to_case.includes("listing_description_draft"),
  "normalizeToolTestBehavior debe rellenar persists_to_case desde defaults."
);

console.log("tool-test-behavior.selftest: ok");
