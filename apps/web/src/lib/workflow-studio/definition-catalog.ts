import type {
  WorkflowDefinition,
  WorkflowDefinitionStatus,
  WorkflowOwnerScope,
} from "@agents/types";

/**
 * Mapeos puros para el catálogo read-only del Workflow Studio (Slice 2.7-2).
 * Solo presentación: nada aquí muta definiciones ni toca la DB.
 */

export function definitionStatusLabel(status: WorkflowDefinitionStatus): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "validated":
      return "Validada";
    case "published":
      return "Publicada";
    case "deprecated":
      return "Obsoleta";
  }
}

export function ownerScopeLabel(scope: WorkflowOwnerScope): string {
  switch (scope) {
    case "global":
      return "Global";
    case "user":
      return "Privada";
    case "organization":
      return "Organización";
  }
}

/** Hash corto para la UI (el completo vive en la fila y en evidencia). */
export function shortDefinitionHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Linaje de fork legible; null cuando la definición no deriva de otra. */
export function forkLineageLabel(
  definition: Pick<
    WorkflowDefinition,
    "derived_from_definition_id" | "derived_from_version"
  >
): string | null {
  if (!definition.derived_from_definition_id) return null;
  const version =
    definition.derived_from_version != null
      ? ` v${definition.derived_from_version}`
      : "";
  return `Derivada de ${shortDefinitionHash(definition.derived_from_definition_id)}…${version}`;
}

export function pinnedCasesLabel(count: number): string {
  if (count === 0) return "Sin casos activos";
  if (count === 1) return "1 caso activo";
  return `${count} casos activos`;
}

export interface DefinitionCatalogRow {
  id: string;
  caseType: string;
  workflowKey: string;
  version: number;
  status: WorkflowDefinitionStatus;
  statusLabel: string;
  scopeLabel: string;
  shortHash: string;
  lineage: string | null;
  pinnedActiveCases: number;
  pinnedLabel: string;
}

export function toDefinitionCatalogRow(
  definition: WorkflowDefinition,
  pinnedCounts: Record<string, number>
): DefinitionCatalogRow {
  const pinned = pinnedCounts[definition.id] ?? 0;
  return {
    id: definition.id,
    caseType: definition.case_type,
    workflowKey: definition.workflow_key,
    version: definition.version,
    status: definition.status,
    statusLabel: definitionStatusLabel(definition.status),
    scopeLabel: ownerScopeLabel(definition.owner_scope),
    shortHash: shortDefinitionHash(definition.definition_hash),
    lineage: forkLineageLabel(definition),
    pinnedActiveCases: pinned,
    pinnedLabel: pinnedCasesLabel(pinned),
  };
}
