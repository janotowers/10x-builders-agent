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
      const compiled = await compileReusableSkillDescription({
        slug: "owner-followup-message",
        title: "Seguimiento cordial a propietarios",
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
