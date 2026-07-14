import assert from "node:assert/strict";
import path from "node:path";
import { loadGlobalSkillRegistry, TOOL_CATALOG } from "@agents/agent";
import { isReadinessVisibleTool } from "@/lib/operational-cases/tool-surface-classification";
import { VERIFIED_ADAPTER_TOOLS } from "./verified-adapter-tools";

async function main() {
  const workspaceRoot = path.resolve(process.cwd(), "..", "..");
  const registry = await loadGlobalSkillRegistry(workspaceRoot);
  const root = "property-optioning-coach";
  const orderedSkills: string[] = [];
  const visited = new Set<string>();

  function visit(slug: string) {
    if (visited.has(slug)) return;
    visited.add(slug);
    const skill = registry.get(slug);
    assert.ok(skill, `Missing included skill: ${slug}`);
    for (const include of skill.metadata.includes) visit(include);
    orderedSkills.push(slug);
  }

  visit(root);

  const allowedTools = new Set<string>();
  for (const slug of orderedSkills) {
    const skill = registry.get(slug)!;
    for (const toolId of skill.metadata.allowedTools) allowedTools.add(toolId);
  }
  // property-optioning uses the scoped wrapper, not raw BigQuery.
  allowedTools.delete("bigquery_run_query");

  const catalogIds = new Set(TOOL_CATALOG.map((tool) => tool.id));
  const readinessVisible = [...allowedTools].filter(isReadinessVisibleTool);
  const missingCatalog = readinessVisible.filter(
    (toolId) => !catalogIds.has(toolId)
  );
  const missingAdapter = readinessVisible.filter(
    (toolId) => !VERIFIED_ADAPTER_TOOLS.has(toolId)
  );

  assert.deepEqual(
    missingCatalog,
    [],
    "Readiness-visible tools must exist in catalog"
  );
  assert.deepEqual(
    missingAdapter,
    [],
    "Readiness-visible tools must have a verified runtime adapter"
  );

  console.log(
    `verified-adapter-tools.selftest: ok (${readinessVisible.length} visible tools)`
  );
}

void main();
