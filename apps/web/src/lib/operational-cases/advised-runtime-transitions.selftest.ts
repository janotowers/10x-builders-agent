/**
 * S1.7 / finding 13: batch + characteristics step transitions must stay on the
 * advised wrapper and remain legal under the production evaluator.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationalCaseFlowStep } from "@agents/types";
import { evaluateTransition, transformFlowToGraph } from "@agents/workflows";

const here = dirname(fileURLToPath(import.meta.url));

const advisedSites = [
  {
    file: "document-batch-completion.ts",
    site: "document_batch_completion",
  },
  {
    file: "photo-batch-completion.ts",
    site: "photo_batch_completion",
  },
  {
    file: "characteristics-response.ts",
    site: "characteristics_response",
  },
] as const;

for (const entry of advisedSites) {
  const src = readFileSync(join(here, entry.file), "utf8");
  assert.match(
    src,
    new RegExp(`createAdvisedCaseUpdate\\(\\s*"${entry.site}"`),
    `${entry.file} must use advised site ${entry.site}`
  );
  assert.doesNotMatch(
    src,
    /await updateOperationalCase\s*\(/,
    `${entry.file} must not call updateOperationalCase directly for transitions`
  );
}

const flow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Intake" },
  { step_key: "awaiting_documents", step_label: "Docs" },
  { step_key: "documents_received", step_label: "Recibidos" },
  { step_key: "comparables_in_progress", step_label: "Comparables" },
  { step_key: "price_proposal_pending", step_label: "Precio" },
  { step_key: "contract_pending", step_label: "Contrato" },
  { step_key: "photos_requested", step_label: "Fotos" },
  { step_key: "package_ready", step_label: "Paquete" },
];
const graph = transformFlowToGraph({ caseType: "property_optioning", flow });

function evaluate(params: {
  currentStep: string;
  toStep: string;
  toStatus?: string | null;
  recentEventTypes?: string[];
  contextPatchKeys?: string[];
}) {
  return evaluateTransition({
    graph,
    caseType: "property_optioning",
    caseState: { currentStep: params.currentStep, status: "active" },
    proposal: {
      toStep: params.toStep,
      toStatus: params.toStatus ?? null,
      proposer: "runtime",
      contextPatchKeys: params.contextPatchKeys,
    },
    facts: {
      context: {},
      recentEventTypes: params.recentEventTypes ?? [],
    },
  });
}

// document-batch-completion: awaiting_documents → documents_received
const docsAdvanced = evaluate({
  currentStep: "awaiting_documents",
  toStep: "documents_received",
  toStatus: "waiting_internal",
  recentEventTypes: ["external_response"],
});
assert.equal(docsAdvanced.verdict, "legal");

// photo-batch-completion: photos_requested → package_ready
const photosAdvanced = evaluate({
  currentStep: "photos_requested",
  toStep: "package_ready",
  toStatus: "active",
});
assert.equal(photosAdvanced.verdict, "legal");

// characteristics-response may stay on documents_received (context write)
const characteristicsStay = evaluate({
  currentStep: "documents_received",
  toStep: "documents_received",
  toStatus: "waiting_internal",
});
assert.equal(characteristicsStay.verdict, "legal");

// Negative evidence for S1.7: protected publication keys remain illegal.
const protectedWrite = evaluate({
  currentStep: "package_ready",
  toStep: "package_ready",
  contextPatchKeys: ["publication", "note"],
});
assert.equal(protectedWrite.verdict, "illegal");
assert.ok(
  protectedWrite.guardResults.some(
    (g) => g.guard === "publication_keys_protected" && !g.pass
  )
);

console.log("advised-runtime-transitions.selftest: ok");
