import type {
  AccountAsset,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  OperationalCaseRequiredAsset,
  ToolDefinition,
} from "@agents/types";

/**
 * Helpers puros de required assets + readiness, extraídos de
 * `api/tool-readiness/route.ts` (Slice 2.7-3: reutilizar la lógica del lab
 * sin forkearla). El route del lab y el panel de assets del tenant importan
 * de aquí; NO dupliques estas funciones.
 */

export type AssetRequirementStatus = OperationalCaseRequiredAsset & {
  configured: boolean;
  asset: AccountAsset | null;
  assets: AccountAsset[];
  configured_count: number;
  min_count: number;
  max_count: number;
};

export function validAssetRequirements(
  requirements: OperationalCaseRequiredAsset[] | undefined
) {
  return Array.isArray(requirements)
    ? requirements.filter(
        (item): item is OperationalCaseRequiredAsset =>
          Boolean(item?.asset_key && item.label)
      )
    : [];
}

export function mergeAssetRequirementsWithDefaults(
  defaults: OperationalCaseRequiredAsset[],
  overrides: OperationalCaseRequiredAsset[]
) {
  if (overrides.length === 0) return defaults;
  return overrides.map((override) => {
    const fallback = defaults.find(
      (item) => item.asset_key === override.asset_key
    );
    return fallback ? { ...fallback, ...override } : override;
  });
}

export function collectAssetsForScope(
  flow: OperationalCaseFlowStep[],
  allowedTools: string[],
  catalogById: Map<string, ToolDefinition>,
  scope: "account" | "test"
) {
  const byTool = new Map<string, OperationalCaseRequiredAsset[]>();
  const add = (toolId: string, requirements: OperationalCaseRequiredAsset[]) => {
    if (requirements.length === 0) return;
    const existing = byTool.get(toolId) ?? [];
    const byKey = new Map(existing.map((item) => [item.asset_key, item]));
    for (const requirement of requirements) {
      byKey.set(requirement.asset_key, {
        ...(byKey.get(requirement.asset_key) ?? {}),
        ...requirement,
      });
    }
    byTool.set(toolId, Array.from(byKey.values()));
  };
  const addTool = (tool: OperationalCaseFlowTool) => {
    const def = catalogById.get(tool.tool_id);
    const defaults = validAssetRequirements(def?.asset_profile?.[scope]);
    const overrides = validAssetRequirements(
      scope === "account" ? tool.required_assets : tool.test_assets
    );
    add(tool.tool_id, mergeAssetRequirementsWithDefaults(defaults, overrides));
  };
  for (const step of flow) {
    for (const tool of step.step_tools ?? []) addTool(tool);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) addTool(tool);
    }
  }
  for (const toolId of allowedTools) {
    if (byTool.has(toolId)) continue;
    const def = catalogById.get(toolId);
    add(toolId, validAssetRequirements(def?.asset_profile?.[scope]));
  }
  return byTool;
}

export function minAssetCount(requirement: OperationalCaseRequiredAsset) {
  if (typeof requirement.min_count === "number") return requirement.min_count;
  return requirement.required === false ? 0 : 1;
}

export function maxAssetCount(requirement: OperationalCaseRequiredAsset) {
  if (typeof requirement.max_count === "number") return requirement.max_count;
  return 1;
}

export function isAssetCollection(requirement: OperationalCaseRequiredAsset) {
  return requirement.collection === true || maxAssetCount(requirement) > 1;
}

export function assetsForRequirement(
  accountAssets: AccountAsset[],
  requirement: OperationalCaseRequiredAsset
) {
  const exact = accountAssets.filter(
    (asset) => asset.asset_key === requirement.asset_key
  );
  if (!isAssetCollection(requirement)) return exact;
  const prefixed = accountAssets.filter((asset) =>
    asset.asset_key.startsWith(`${requirement.asset_key}__`)
  );
  return [...exact, ...prefixed].sort((a, b) =>
    a.asset_key.localeCompare(b.asset_key)
  );
}

export function assetRequirementStatus(
  requirement: OperationalCaseRequiredAsset,
  accountAssets: AccountAsset[]
): AssetRequirementStatus {
  const assets = assetsForRequirement(accountAssets, requirement);
  const minCount = minAssetCount(requirement);
  const maxCount = maxAssetCount(requirement);
  return {
    ...requirement,
    min_count: minCount,
    max_count: maxCount,
    configured: assets.length >= minCount,
    asset: assets[0] ?? null,
    assets,
    configured_count: assets.length,
  };
}
