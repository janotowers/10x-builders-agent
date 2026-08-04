import type {
  AccountAsset,
  OperationalCaseFlowStep,
  OperationalCaseRequiredAsset,
  ToolDefinition,
  WorkflowDefinition,
} from "@agents/types";
import {
  assetRequirementStatus,
  mergeAssetRequirementsWithDefaults,
  validAssetRequirements,
  type AssetRequirementStatus,
} from "@/lib/tool-readiness/asset-requirements";

/**
 * Resolver de required assets del tenant (Slice 2.7-3/2.7-4).
 *
 * Precedencia [D 2.7-4]: si la definición publicada resuelta trae
 * `graph_jsonb.step_bindings[].required_assets`, esa es la fuente. Mientras
 * ninguna versión publicada los traiga (definiciones anteriores al port del
 * transformer 2.7-5), fallback a la fuente del lab: `operational_flow_jsonb`
 * + defaults del tool catalog. NUNCA se muta una definición publicada para
 * "arreglar" sus assets — el camino correcto es publicar una nueva versión.
 */

export type RequiredAssetSource = "definition" | "lab_fallback";

export interface ResolvedRequiredAsset {
  requirement: OperationalCaseRequiredAsset;
  source: RequiredAssetSource;
  caseType: string;
  /** Estado del grafo (fuente definición) o step_key del flow (fallback). */
  stepKey: string;
  stepLabel?: string;
  definitionId?: string;
  definitionVersion?: number;
}

export interface LabFallbackSource {
  flow: OperationalCaseFlowStep[];
  catalogById: Map<string, ToolDefinition>;
}

/** Assets por paso desde el flow del lab (misma merge que tool-readiness). */
function fallbackAssetsByStep(
  fallback: LabFallbackSource
): Array<{ stepKey: string; stepLabel?: string; assets: OperationalCaseRequiredAsset[] }> {
  const result: Array<{
    stepKey: string;
    stepLabel?: string;
    assets: OperationalCaseRequiredAsset[];
  }> = [];
  for (const step of fallback.flow) {
    const byKey = new Map<string, OperationalCaseRequiredAsset>();
    const tools = [
      ...(step.step_tools ?? []),
      ...(step.step_skills ?? []).flatMap((skill) => skill.skill_tools ?? []),
    ];
    for (const tool of tools) {
      const defaults = validAssetRequirements(
        fallback.catalogById.get(tool.tool_id)?.asset_profile?.account
      );
      const overrides = validAssetRequirements(tool.required_assets);
      for (const requirement of mergeAssetRequirementsWithDefaults(
        defaults,
        overrides
      )) {
        byKey.set(requirement.asset_key, {
          ...(byKey.get(requirement.asset_key) ?? {}),
          ...requirement,
        });
      }
    }
    if (byKey.size > 0) {
      result.push({
        stepKey: step.step_key,
        stepLabel: step.step_label,
        assets: [...byKey.values()],
      });
    }
  }
  return result;
}

export function resolveRequiredAssetsForDefinition(params: {
  definition: Pick<
    WorkflowDefinition,
    "id" | "version" | "case_type" | "graph_jsonb"
  >;
  fallback?: LabFallbackSource;
}): ResolvedRequiredAsset[] {
  const { definition, fallback } = params;
  const bindingsWithAssets = definition.graph_jsonb.step_bindings.filter(
    (binding) => (binding.required_assets?.length ?? 0) > 0
  );

  if (bindingsWithAssets.length > 0) {
    const labelByState = new Map(
      definition.graph_jsonb.states.map((state) => [state.key, state.label])
    );
    return bindingsWithAssets.flatMap((binding) =>
      validAssetRequirements(binding.required_assets).map((requirement) => ({
        requirement,
        source: "definition" as const,
        caseType: definition.case_type,
        stepKey: binding.state,
        stepLabel: labelByState.get(binding.state),
        definitionId: definition.id,
        definitionVersion: definition.version,
      }))
    );
  }

  if (!fallback) return [];
  return fallbackAssetsByStep(fallback).flatMap(({ stepKey, stepLabel, assets }) =>
    assets.map((requirement) => ({
      requirement,
      source: "lab_fallback" as const,
      caseType: definition.case_type,
      stepKey,
      stepLabel,
      definitionId: definition.id,
      definitionVersion: definition.version,
    }))
  );
}

export type TenantAssetReadiness = "configured" | "missing" | "optional_missing";

export interface TenantAssetConsumer {
  caseType: string;
  stepKey: string;
  stepLabel?: string;
  definitionId?: string;
  definitionVersion?: number;
  source: RequiredAssetSource;
}

export interface TenantAssetEntry {
  assetKey: string;
  status: AssetRequirementStatus;
  readiness: TenantAssetReadiness;
  consumers: TenantAssetConsumer[];
}

export function tenantAssetReadinessLabel(readiness: TenantAssetReadiness): string {
  switch (readiness) {
    case "configured":
      return "Configurado";
    case "missing":
      return "Falta subir";
    case "optional_missing":
      return "Opcional (sin archivo)";
  }
}

/**
 * Agregación del panel (Slice 2.7-3): dedupe por asset_key entre definiciones
 * y pasos; en conflicto de detalle gana el requirement con fuente
 * `definition`. Cada entrada lista todos sus consumidores (definición+paso).
 */
export function aggregateTenantAssets(
  resolved: ResolvedRequiredAsset[],
  accountAssets: AccountAsset[]
): TenantAssetEntry[] {
  const byKey = new Map<
    string,
    { requirement: OperationalCaseRequiredAsset; fromDefinition: boolean; consumers: TenantAssetConsumer[] }
  >();
  for (const item of resolved) {
    const key = item.requirement.asset_key;
    const existing = byKey.get(key);
    const consumer: TenantAssetConsumer = {
      caseType: item.caseType,
      stepKey: item.stepKey,
      stepLabel: item.stepLabel,
      definitionId: item.definitionId,
      definitionVersion: item.definitionVersion,
      source: item.source,
    };
    if (!existing) {
      byKey.set(key, {
        requirement: item.requirement,
        fromDefinition: item.source === "definition",
        consumers: [consumer],
      });
      continue;
    }
    existing.consumers.push(consumer);
    if (item.source === "definition" && !existing.fromDefinition) {
      existing.requirement = item.requirement;
      existing.fromDefinition = true;
    }
  }

  return [...byKey.entries()]
    .map(([assetKey, entry]) => {
      const status = assetRequirementStatus(entry.requirement, accountAssets);
      // Un opcional (min_count 0) sin archivo cuenta como "configured" para
      // el lab; el panel lo distingue como optional_missing para que el
      // tenant sepa que puede (no debe) subirlo.
      const readiness: TenantAssetReadiness =
        status.configured && status.configured_count > 0
          ? "configured"
          : status.min_count === 0
            ? "optional_missing"
            : "missing";
      return { assetKey, status, readiness, consumers: entry.consumers };
    })
    .sort((a, b) => {
      // Faltantes primero, luego opcionales, luego configurados.
      const rank = (r: TenantAssetReadiness) =>
        r === "missing" ? 0 : r === "optional_missing" ? 1 : 2;
      const diff = rank(a.readiness) - rank(b.readiness);
      return diff !== 0 ? diff : a.assetKey.localeCompare(b.assetKey);
    });
}
