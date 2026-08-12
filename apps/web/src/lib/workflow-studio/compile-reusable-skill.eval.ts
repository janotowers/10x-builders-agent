import assert from "node:assert/strict";
import path from "node:path";
import {
  getGlobalSkillRegistry,
  parseAccountSkillSource,
  TOOL_CATALOG,
} from "@agents/agent";
import {
  loadWebEnvLocal,
  withCliAiUsageMetering,
} from "../ai-usage/cli-metering";
import { compileReusableSkillDescription } from "./compile-reusable-skill";
import type { ReusableSkillCompilationContract } from "./reusable-skill-compilation-contract";

const repoRoot = path.resolve(process.cwd(), "../..");
loadWebEnvLocal(process.cwd());

async function main() {
  assert.ok(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY required");
  await withCliAiUsageMetering(
    async () => {
      const registry = await getGlobalSkillRegistry({
        rootDirOverride: repoRoot,
      });
      const tools = TOOL_CATALOG.map((tool) => tool.id);
      const contract: ReusableSkillCompilationContract = {
        schema_version: "1",
        discovery_hash: `sha256:${"0".repeat(64)}`,
        title: "Seguimiento cordial a propietarios",
        slug: "owner-followup-message",
        objective:
          "Preparar un seguimiento basado en el último acuerdo registrado.",
        acceptance_criteria: [
          "No inventa compromisos ni fechas.",
          "El asesor decide si se envía.",
        ],
        source_contract: {
          strategy: {
            kind: "system_record",
            label: "BigQuery",
            source_ref: {
              type: "input_requirement",
              key: "owner_history",
            },
            evidence: [],
          },
          data_sources: {
            document_source: null,
            document_intake_route: null,
          },
          audited_sources: ["BigQuery"],
        },
        input_contract: {
          requirements: [
            {
              kind: "business_record",
              key: "owner_history",
              label: "Historial y último acuerdo del propietario",
              required: true,
              resolve_at: "runtime",
              source_hint: "BigQuery",
            },
          ],
          invocation_channels: [],
        },
        outbound_contract: null,
        recipient_provenance_review: null,
        requested_effects: [],
        capabilities: [],
      };
      const compiled = await compileReusableSkillDescription({
        contract,
        description:
          "Cada vez que prepares un seguimiento para un propietario, resume el último acuerdo y propone una siguiente acción; no inventes compromisos ni fechas.",
        skillSubtype: "simple",
        clarificationAnswers: [
          "El historial y el último acuerdo se consultan en BigQuery usando el identificador del propietario. Gu sólo prepara el borrador; el asesor decide si lo envía.",
        ],
        catalogs: {
          availableGuards: [],
          availableSkills: registry.list().map((skill) => skill.name),
          availableCapabilities: [],
          availableTools: tools,
        },
      });
      const parsed = parseAccountSkillSource(
        compiled.bodyMd,
        "owner-followup-message",
        "00000000-0000-0000-0000-000000000000"
      );
      assert.ok(
        parsed.metadata.allowedTools.length > 0,
        "data-backed skill needs a read tool"
      );
      assert.ok(
        [...parsed.metadata.allowedTools].every((tool) => tools.includes(tool)),
        "compiled tools must exist in catalog"
      );
      assert.equal(parsed.metadata.requiresTenantContext, true);
      console.log(
        `compile-reusable-skill.eval: passed with ${parsed.metadata.allowedTools.length} tool(s)`
      );
    },
    { label: "compile-reusable-skill.eval" }
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
