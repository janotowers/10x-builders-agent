import assert from "node:assert/strict";
import type { OperationalCaseFlowStep } from "@agents/types";
import {
  operationalStepUsesTenantBigQueryForTest,
  resolveStepBoundSkillSlugForTest,
  shouldBlockCompanyDataAnswerWithoutSuccessfulBigQueryForTest,
  shouldRequireListingDescriptionDraftForTest,
} from "./graph";
import type { ResolvedSkill } from "./skills/types";

const flow: OperationalCaseFlowStep[] = [
  {
    step_key: "awaiting_documents",
    step_label: "Solicitar documentos",
    step_skills: [
      {
        skill_slug: "request-property-documents",
      },
    ],
  },
  {
    step_key: "comparables_in_progress",
    step_label: "Comparables",
    step_skills: [
      {
        skill_slug: "perform-comparable-analysis",
        skill_tools: [
          {
            tool_id: "bigquery_lookup_local_comparables",
            tool_label: "Comparables internos",
          },
        ],
      },
    ],
  },
];

assert.equal(
  resolveStepBoundSkillSlugForTest({
    stepKey: "comparables_in_progress",
    flow,
  }),
  "perform-comparable-analysis"
);

assert.equal(
  resolveStepBoundSkillSlugForTest({
    stepKey: "awaiting_documents",
    flow: [
      {
        step_key: "awaiting_documents",
        step_label: "Solicitar documentos",
        step_skills: [
          { skill_slug: "request-property-documents" },
          { skill_slug: "extract-property-characteristics" },
        ],
      },
    ],
  }),
  null,
  "si el paso tiene múltiples skills, no se debe forzar una sola"
);

assert.equal(
  operationalStepUsesTenantBigQueryForTest({
    stepKey: "comparables_in_progress",
    flow,
  }),
  true
);

assert.equal(
  operationalStepUsesTenantBigQueryForTest({
    stepKey: "awaiting_documents",
    flow,
  }),
  false
);

assert.equal(
  operationalStepUsesTenantBigQueryForTest({
    stepKey: "price_proposal_pending",
    flow: [
      {
        step_key: "price_proposal_pending",
        step_label: "Preparar precio",
        step_tools: [
          {
            tool_id: "bigquery_run_query",
            tool_label: "BQ",
          },
        ],
      },
    ],
  }),
  true
);

const companyDataSkill = { rootName: "company-data" } as ResolvedSkill;

assert.equal(
  shouldBlockCompanyDataAnswerWithoutSuccessfulBigQueryForTest({
    activeSkill: companyDataSkill,
    message: "cuantos leads tuvimos en mayo?",
    toolNamesAvailable: new Set(["bigquery_run_query"]),
    successfulBigQueryCalls: 0,
  }),
  true
);

assert.equal(
  shouldBlockCompanyDataAnswerWithoutSuccessfulBigQueryForTest({
    activeSkill: companyDataSkill,
    message: "cuantos leads tuvimos en mayo?",
    toolNamesAvailable: new Set(["bigquery_run_query"]),
    successfulBigQueryCalls: 1,
  }),
  false
);

assert.equal(
  shouldBlockCompanyDataAnswerWithoutSuccessfulBigQueryForTest({
    activeSkill: companyDataSkill,
    message: "hola",
    toolNamesAvailable: new Set(["bigquery_run_query"]),
    successfulBigQueryCalls: 0,
  }),
  false
);

assert.equal(
  shouldRequireListingDescriptionDraftForTest({
    operationalStepKey: "package_ready",
    message:
      "Acción esperada: el asesor pidió cambios en la descripción comercial. Llama prepare_listing_description_draft(case_id).",
    toolNamesAvailable: ["prepare_listing_description_draft", "notify_user"],
  }),
  true
);

assert.equal(
  shouldRequireListingDescriptionDraftForTest({
    operationalStepKey: "package_ready",
    message: "Llama prepare_listing_description_draft(case_id).",
    toolNamesAvailable: ["prepare_listing_description_draft"],
    toolCallNames: ["prepare_listing_description_draft"],
  }),
  false
);

assert.equal(
  shouldRequireListingDescriptionDraftForTest({
    operationalStepKey: "package_ready",
    message: "Llama prepare_listing_description_draft(case_id).",
    toolNamesAvailable: ["notify_user"],
  }),
  false
);

assert.equal(
  shouldRequireListingDescriptionDraftForTest({
    operationalStepKey: "photos_requested",
    message: "Llama prepare_listing_description_draft(case_id).",
    toolNamesAvailable: ["prepare_listing_description_draft"],
  }),
  false
);

console.log("graph.selftest: ok");
