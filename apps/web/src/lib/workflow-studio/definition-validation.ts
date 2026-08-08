/**
 * Binding de los gates del compilador a producción (Slice 4.2-2/4.2-3).
 *
 * Arma los `CapabilityCatalogs` reales del tenant (skills globales+propias,
 * TOOL_CATALOG, worker profiles, guards registrados, account_assets e
 * integraciones conectadas), corre los gates §5.4 + simulación del paquete
 * puro `@agents/workflows`, y persiste cada gate como evidence record con
 * `subject_kind = "workflow_definition"` y `artifact_hash = definition_hash`
 * — la publicación queda auditada contra la versión exacta del grafo.
 */

import {
  insertEvidenceRecords,
  listAccountAssets,
  listWorkerProfilesForUser,
  type DbClient,
} from "@agents/db";
import { TOOL_CATALOG, getSkillRegistryForUser } from "@agents/agent";
import {
  registerBuiltinGuards,
  registeredGuardNames,
  runDefinitionValidationGates,
  runSimulationGate,
  type CapabilityCatalogs,
  type CapabilityMapResult,
  type CompilerGateResult,
  type SimulationScenarioOutcome,
} from "@agents/workflows";
import type { WorkflowDefinition } from "@agents/types";
import { loadTenantProviderSnapshot } from "@/lib/tool-readiness/load-tenant-provider-snapshot";
import { buildConnectedCatalogIntegrations } from "@/lib/tool-readiness/provider-readiness";

export async function buildCapabilityCatalogsForUser(
  db: DbClient,
  userId: string
): Promise<CapabilityCatalogs> {
  registerBuiltinGuards();
  const [registry, profiles, assets, providerSnapshot] = await Promise.all([
    getSkillRegistryForUser(db, userId),
    listWorkerProfilesForUser(db, userId),
    listAccountAssets(db, { userId }),
    // Publish gates: no contar env/CLI del deployment como "conectado".
    loadTenantProviderSnapshot(db, userId, { includeDeploymentEnv: false }),
  ]);

  const skillAllowedTools = new Map<string, readonly string[]>();
  for (const skill of registry.list()) {
    skillAllowedTools.set(skill.name, skill.allowedTools);
  }

  const connectedIntegrations = buildConnectedCatalogIntegrations(
    providerSnapshot,
    { includeDeploymentEnv: false }
  );

  return {
    skillSlugs: [...skillAllowedTools.keys()],
    toolIds: TOOL_CATALOG.map((tool) => tool.id),
    toolIntegrationById: new Map(
      TOOL_CATALOG.map((tool) => [tool.id, tool.requires_integration])
    ),
    skillAllowedTools,
    workerCapabilities: profiles.flatMap((profile) => profile.capabilities),
    knownGuards: registeredGuardNames(),
    tenantConfiguredAssetKeys: assets.map((asset) => asset.asset_key),
    connectedIntegrations,
  };
}

export interface DefinitionValidationReport {
  /** true cuando TODOS los gates (incluida la simulación) pasan. */
  ok: boolean;
  gates: CompilerGateResult[];
  capabilityMap: CapabilityMapResult | null;
  simulationOutcomes: SimulationScenarioOutcome[];
}

/** Corre gates §5.4 + simulación sobre una definición, sin persistir nada. */
export async function validateDefinitionForUser(
  db: DbClient,
  params: { userId: string; definition: WorkflowDefinition }
): Promise<DefinitionValidationReport> {
  const catalogs = await buildCapabilityCatalogsForUser(db, params.userId);
  const validation = runDefinitionValidationGates({
    graphValue: params.definition.graph_jsonb,
    businessSpecValue: params.definition.business_spec_jsonb,
    implementationSpecValue: params.definition.implementation_spec_jsonb,
    catalogs,
  });

  const gates = [...validation.gates];
  let simulationOutcomes: SimulationScenarioOutcome[] = [];
  if (validation.graph) {
    const simulation = runSimulationGate({
      graph: validation.graph,
      caseType: params.definition.case_type,
    });
    gates.push(simulation.gate);
    simulationOutcomes = simulation.outcomes;
  } else {
    gates.push({
      gate: "simulation",
      result: "fail",
      detail: { failures: ["graph_schema falló: sin grafo simulable"] },
    });
  }

  return {
    ok: gates.every((gate) => gate.result === "pass"),
    gates,
    capabilityMap: validation.capabilityMap,
    simulationOutcomes,
  };
}

/**
 * Persiste el reporte como evidence records (uno por gate) en un solo batch
 * atómico: nunca deja evidencia parcial y evita ocho
 * round-trips/statement timeouts antes de publicar.
 */
export async function recordDefinitionValidationEvidence(
  db: DbClient,
  params: {
    userId: string;
    definition: WorkflowDefinition;
    gates: CompilerGateResult[];
  }
): Promise<void> {
  await insertEvidenceRecords(
    db,
    params.gates.map((gate) => ({
      userId: params.userId,
      subjectKind: "workflow_definition",
      subjectId: params.definition.id,
      gate: gate.gate,
      artifactHash: params.definition.definition_hash,
      result: gate.result,
      detail: gate.detail,
    }))
  );
}
