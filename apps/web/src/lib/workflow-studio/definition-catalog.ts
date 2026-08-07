import type {
  WorkflowDefinition,
  WorkflowDefinitionStatus,
  WorkflowGraph,
  WorkflowOwnerScope,
} from "@agents/types";

/**
 * Mapeos puros para el catálogo del Workflow Studio (Slice 2.7-2 + mejoras
 * de presentación del catálogo/detalle). Solo presentación: nada aquí muta
 * definiciones ni toca la DB.
 */

export const EMPTY_WORK_TEMPLATES_MESSAGE =
  "Esta versión no declara plantillas del plano de trabajo (normal en definiciones portadas del laboratorio).";

const FRIENDLY_CASE_TYPE_LABELS: Record<string, string> = {
  property_optioning: "Opcionamiento de propiedad",
  lead_follow_up: "Seguimiento de leads",
  work_plane_soak_synthetic: "Soak del plano de trabajo (prueba)",
};

const KNOWN_GUARD_LABELS: Record<string, string> = {
  step_order_no_regression: "Sin retroceder de paso",
  external_response_exists: "Respuesta externa recibida",
  defensible_comparables_sample: "Muestra de comparables defendible",
  completion_pairing: "Publicado y completado en pareja",
  publication_keys_protected: "Claves de publicación protegidas",
};

const KNOWN_APPROVAL_KIND_LABELS: Record<string, string> = {
  price: "Aprobación de precio",
  contract: "Aprobación de contrato",
  listing: "Aprobación de publicación",
  owner_approval: "Aprobación del propietario",
};

const KNOWN_CHECK_LABELS: Record<string, string> = {
  publication_preflight: "Verificación previa a la publicación",
};

const KNOWN_EVIDENCE_INPUT_LABELS: Record<string, string> = {
  comparables_analysis: "Análisis de comparables",
  pricing_proposal: "Propuesta de precio",
  listing_description: "Descripción del anuncio",
  valuation: "Valuación",
};

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

/**
 * Linaje amigable cuando el origen está en el catálogo visible; si no,
 * cae al label con hash corto.
 */
export function resolveForkLineageLabel(
  definition: Pick<
    WorkflowDefinition,
    "derived_from_definition_id" | "derived_from_version"
  >,
  byId: ReadonlyMap<string, WorkflowDefinition>
): string | null {
  if (!definition.derived_from_definition_id) return null;
  const source = byId.get(definition.derived_from_definition_id);
  if (!source) return forkLineageLabel(definition);
  const version =
    definition.derived_from_version != null
      ? definition.derived_from_version
      : source.version;
  return `Fork de ${friendlyCaseTypeLabel(source.case_type)} ${ownerScopeLabel(source.owner_scope)} v${version}`;
}

export function pinnedCasesLabel(count: number): string {
  if (count === 0) return "Sin casos activos";
  if (count === 1) return "1 caso activo";
  return `${count} casos activos`;
}

export function isInternalTestDefinition(
  definition: Pick<WorkflowDefinition, "case_type">
): boolean {
  return definition.case_type === "work_plane_soak_synthetic";
}

export function filterCatalogDefinitions(
  definitions: WorkflowDefinition[],
  options: { showTests: boolean }
): WorkflowDefinition[] {
  if (options.showTests) return definitions;
  return definitions.filter((definition) => !isInternalTestDefinition(definition));
}

export function friendlyCaseTypeLabel(caseType: string): string {
  if (FRIENDLY_CASE_TYPE_LABELS[caseType]) {
    return FRIENDLY_CASE_TYPE_LABELS[caseType];
  }
  return caseType
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function guardLabel(guard: string): string {
  return KNOWN_GUARD_LABELS[guard] ?? guard;
}

export function approvalKindLabel(kind: string): string {
  if (KNOWN_APPROVAL_KIND_LABELS[kind]) return KNOWN_APPROVAL_KIND_LABELS[kind];
  // "price_approval" → "Aprobación price" no; humanizar snake_case.
  const humanized = kind
    .replace(/_approval$/i, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return humanized ? `Aprobación: ${humanized}` : `Aprobación: ${kind}`;
}

export function checkLabel(check: string): string {
  return KNOWN_CHECK_LABELS[check] ?? check;
}

export function evidenceInputLabel(input: string): string {
  return KNOWN_EVIDENCE_INPUT_LABELS[input] ?? input;
}

export function emptyWorkTemplatesMessage(): string {
  return EMPTY_WORK_TEMPLATES_MESSAGE;
}

export interface HappyPathState {
  key: string;
  label: string;
  kind: "operational" | "terminal";
  isTerminal: boolean;
}

/** Estados del grafo en orden declarado (camino de lectura del Studio). */
export function happyPathStates(graph: WorkflowGraph): HappyPathState[] {
  const terminalSet = new Set(graph.completion.terminal_states);
  return graph.states.map((state) => ({
    key: state.key,
    label: state.label?.trim() || state.key,
    kind: state.kind,
    isTerminal: state.kind === "terminal" || terminalSet.has(state.key),
  }));
}

export interface TransitionSummaryRow {
  fromKey: string;
  toKey: string;
  fromLabel: string;
  toLabel: string;
  guards: string[];
  guardLabels: string[];
  approvalRequired: string | null;
}

export function transitionSummary(graph: WorkflowGraph): TransitionSummaryRow[] {
  const labelByKey = new Map(
    graph.states.map((state) => [state.key, state.label?.trim() || state.key])
  );
  return graph.transitions.map((transition) => ({
    fromKey: transition.from,
    toKey: transition.to,
    fromLabel: labelByKey.get(transition.from) ?? transition.from,
    toLabel: labelByKey.get(transition.to) ?? transition.to,
    guards: transition.guards,
    guardLabels: transition.guards.map(guardLabel),
    approvalRequired: transition.approval_required,
  }));
}

export interface StepSkillSummary {
  stateKey: string;
  stateLabel: string;
  skill: string | null;
  bigqueryContext: boolean;
  requiredAssetKeys: string[];
}

export function stepSkillSummary(graph: WorkflowGraph): StepSkillSummary[] {
  const labelByKey = new Map(
    graph.states.map((state) => [state.key, state.label?.trim() || state.key])
  );
  return graph.step_bindings.map((binding) => ({
    stateKey: binding.state,
    stateLabel: labelByKey.get(binding.state) ?? binding.state,
    skill: binding.skill,
    bigqueryContext: Boolean(binding.bigquery_context),
    requiredAssetKeys: (binding.required_assets ?? []).map(
      (asset) => asset.asset_key
    ),
  }));
}

/**
 * Borrador/validado propio idéntico a un fork de la fuente (mismo origen +
 * mismo hash). Sirve para dedupe anti-doble-click en la action de fork.
 */
export function findIdenticalOwnFork(
  ownDefinitions: WorkflowDefinition[],
  source: Pick<WorkflowDefinition, "id" | "case_type" | "definition_hash">
): WorkflowDefinition | null {
  const matches = ownDefinitions.filter(
    (definition) =>
      (definition.status === "draft" || definition.status === "validated") &&
      definition.case_type === source.case_type &&
      definition.derived_from_definition_id === source.id &&
      definition.definition_hash === source.definition_hash
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.version - a.version);
  return matches[0] ?? null;
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
  pinnedCounts: Record<string, number>,
  options?: { byId?: ReadonlyMap<string, WorkflowDefinition> }
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
    lineage: options?.byId
      ? resolveForkLineageLabel(definition, options.byId)
      : forkLineageLabel(definition),
    pinnedActiveCases: pinned,
    pinnedLabel: pinnedCasesLabel(pinned),
  };
}

export interface DefinitionFamily {
  key: string;
  caseType: string;
  ownerScope: WorkflowOwnerScope;
  userId: string | null;
  title: string;
  head: WorkflowDefinition;
  versions: WorkflowDefinition[];
  draftCount: number;
  pinnedActiveCases: number;
  pinnedLabel: string;
  headStatusLabel: string;
  scopeLabel: string;
  lineage: string | null;
}

function familyKey(definition: WorkflowDefinition): string {
  return `${definition.owner_scope}:${definition.user_id ?? "global"}:${definition.case_type}`;
}

/**
 * Cabeza de familia para la tarjeta del catálogo: la publicada de mayor
 * versión (lo que un operador entiende como "la vigente"), luego validada,
 * luego borrador. Los borradores siguen visibles como contador en la tarjeta.
 */
export function pickFamilyHead(
  versions: WorkflowDefinition[]
): WorkflowDefinition {
  const byHighestVersion = (list: WorkflowDefinition[]) =>
    list.reduce((best, current) =>
      current.version > best.version ? current : best
    );
  const published = versions.filter(
    (definition) => definition.status === "published"
  );
  if (published.length > 0) return byHighestVersion(published);
  const validated = versions.filter(
    (definition) => definition.status === "validated"
  );
  if (validated.length > 0) return byHighestVersion(validated);
  const drafts = versions.filter((definition) => definition.status === "draft");
  if (drafts.length > 0) return byHighestVersion(drafts);
  return byHighestVersion(versions);
}

/** Suma casos pineados de todas las versiones de la familia. */
export function sumPinnedActiveCases(
  versions: WorkflowDefinition[],
  pinnedCounts: Record<string, number>
): number {
  return versions.reduce(
    (total, definition) => total + (pinnedCounts[definition.id] ?? 0),
    0
  );
}

/**
 * Sello corto de evidencia (sin repetir el checklist de gates en vivo).
 * `null` cuando aún no hay evidencia registrada.
 */
export function formatEvidenceSeal(input: {
  evidenceCount: number;
  gateCount: number;
  latestAt: string | null;
  shortHash: string;
}): string | null {
  if (input.evidenceCount <= 0) return null;
  const when = input.latestAt
    ? new Date(input.latestAt).toLocaleString("es-MX")
    : "fecha desconocida";
  const gates =
    input.gateCount > 0
      ? `${input.evidenceCount}/${input.gateCount} gates`
      : `${input.evidenceCount} registros`;
  return `Sellada el ${when} · ${gates} · ${input.shortHash}…`;
}

/**
 * Agrupa definiciones por (case_type, owner_scope, user_id). La cabeza
 * prefiere la publicada de mayor versión; si no hay, validada/borrador.
 */
export function groupDefinitionFamilies(
  definitions: WorkflowDefinition[],
  pinnedCounts: Record<string, number>
): DefinitionFamily[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const groups = new Map<string, WorkflowDefinition[]>();
  for (const definition of definitions) {
    const key = familyKey(definition);
    const list = groups.get(key) ?? [];
    list.push(definition);
    groups.set(key, list);
  }

  const families: DefinitionFamily[] = [];
  for (const [key, group] of groups) {
    const versions = [...group].sort((a, b) => b.version - a.version);
    const head = pickFamilyHead(versions);
    const draftCount = versions.filter(
      (definition) =>
        definition.status === "draft" || definition.status === "validated"
    ).length;
    const pinnedActiveCases = sumPinnedActiveCases(versions, pinnedCounts);
    families.push({
      key,
      caseType: head.case_type,
      ownerScope: head.owner_scope,
      userId: head.user_id,
      title: friendlyCaseTypeLabel(head.case_type),
      head,
      versions,
      draftCount,
      pinnedActiveCases,
      pinnedLabel: pinnedCasesLabel(pinnedActiveCases),
      headStatusLabel: definitionStatusLabel(head.status),
      scopeLabel: ownerScopeLabel(head.owner_scope),
      lineage: resolveForkLineageLabel(head, byId),
    });
  }

  // Mis flujos primero (por título), luego globales.
  families.sort((a, b) => {
    if (a.ownerScope !== b.ownerScope) {
      return a.ownerScope === "user" ? -1 : b.ownerScope === "user" ? 1 : 0;
    }
    return a.title.localeCompare(b.title, "es");
  });
  return families;
}

export function familySiblings(
  definition: WorkflowDefinition,
  families: DefinitionFamily[]
): WorkflowDefinition[] {
  const key = familyKey(definition);
  return families.find((family) => family.key === key)?.versions ?? [definition];
}
