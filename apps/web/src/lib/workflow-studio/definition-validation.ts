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
  insertEvidenceRecord,
  getUserIntegrations,
  listAccountAssets,
  listAccountToolSecretsPublic,
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

export async function buildCapabilityCatalogsForUser(
  db: DbClient,
  userId: string
): Promise<CapabilityCatalogs> {
  registerBuiltinGuards();
  const [registry, profiles, assets, integrations, toolSecrets] =
    await Promise.all([
      getSkillRegistryForUser(db, userId),
      listWorkerProfilesForUser(db, userId),
      listAccountAssets(db, { userId }),
      getUserIntegrations(db, userId).catch(() => []),
      listAccountToolSecretsPublic(db, userId).catch(() => []),
    ]);

  const skillAllowedTools = new Map<string, readonly string[]>();
  for (const skill of registry.list()) {
    skillAllowedTools.set(skill.name, skill.allowedTools);
  }

  const connectedIntegrations = new Set<string>([
    ...integrations.map((integration) => integration.provider),
    // Credenciales de portales/tools activas también cuentan como conexión.
    ...toolSecrets
      .filter((secret) => secret.status === "active")
      .map((secret) => secret.provider),
  ]);

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
 * Persiste el reporte como evidence records (uno por gate). Best-effort por
 * gate: un insert fallido no oculta los demás; el error se propaga al final
 * para que el caller sepa que la evidencia quedó incompleta.
 */
export async function recordDefinitionValidationEvidence(
  db: DbClient,
  params: {
    userId: string;
    definition: WorkflowDefinition;
    gates: CompilerGateResult[];
  }
): Promise<void> {
  let firstError: unknown = null;
  for (const gate of params.gates) {
    try {
      await insertEvidenceRecord(db, {
        userId: params.userId,
        subjectKind: "workflow_definition",
        subjectId: params.definition.id,
        gate: gate.gate,
        artifactHash: params.definition.definition_hash,
        result: gate.result,
        detail: gate.detail,
      });
    } catch (error) {
      firstError ??= error;
      console.error(
        `[workflow-studio] evidence insert failed for gate ${gate.gate}:`,
        error
      );
    }
  }
  if (firstError) throw firstError;
}
