/**
 * Capability map (Slice 4.2-1; Technical Plan §15 + Phase 5 taxonomy):
 * resuelve lo que un grafo/spec DECLARA contra lo que la cuenta TIENE.
 *
 * Dos clases de resultado, a propósito distintas (§5.4):
 *   - Gap BLOQUEANTE: skill/tool/guard/capacidad inexistentes.
 *   - Gap NO bloqueante (backlog): account_asset / integration faltantes.
 *
 * Phase 5: también entiende `input_requirements` tipados. Los
 * `generated_artifact` no producen gap; `case_fact`/`runtime_input`/
 * `business_record` producen mensajes distintos a "súbela en Recursos".
 */

import type { WorkflowGraph } from "@agents/types";
import {
  customerMessageForInputRequirement,
  isGeneratedOutput,
  linkHintForInputRequirement,
  looksLikeMisclassifiedAccountAsset,
  type InputRequirement,
  type InputRequirementKind,
} from "./input-requirements";

export type CapabilityRequirementKind =
  | "skill"
  | "tool"
  | "worker_capability"
  | "guard"
  | "account_asset"
  | "integration"
  | "runtime_input"
  | "case_fact"
  | "business_record"
  | "knowledge_requirement"
  | "generated_artifact"
  | "human_input"
  | "misclassified_asset";

export interface CapabilityMapEntry {
  kind: CapabilityRequirementKind;
  key: string;
  status: "resolved" | "missing" | "informational";
  /** true = su ausencia impide ejecutar (falla el gate). */
  blocking: boolean;
  requiredBy: string[];
  detail?: string;
}

export interface CapabilityGap {
  kind: CapabilityRequirementKind;
  key: string;
  blocking: boolean;
  customerMessage: string;
  linkHint:
    | "assets_panel"
    | "integrations_panel"
    | "case_intake"
    | null;
}

export interface CapabilityCatalogs {
  skillSlugs: Iterable<string>;
  toolIds: Iterable<string>;
  toolIntegrationById?: ReadonlyMap<string, string | undefined>;
  skillAllowedTools?: ReadonlyMap<string, readonly string[]>;
  workerCapabilities: Iterable<string>;
  knownGuards: Iterable<string>;
  tenantConfiguredAssetKeys: Iterable<string>;
  connectedIntegrations: Iterable<string>;
}

export interface CapabilityMapResult {
  entries: CapabilityMapEntry[];
  gaps: CapabilityGap[];
  blockingGaps: CapabilityGap[];
  ok: boolean;
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function customerMessageFor(
  kind: CapabilityRequirementKind,
  key: string,
  label?: string
): string {
  switch (kind) {
    case "skill":
      return `El flujo usa la habilidad "${key}" y esta cuenta no la tiene disponible.`;
    case "tool":
      return `El flujo necesita la herramienta "${key}" y no está en el catálogo de la cuenta.`;
    case "worker_capability":
      return `Ningún perfil de trabajo de la cuenta puede ejecutar "${key}".`;
    case "guard":
      return `La regla de transición "${key}" no está registrada en el sistema.`;
    case "account_asset":
      return `Falta ${lowerFirst(label ?? key)}: súbela en el panel de recursos de la cuenta.`;
    case "integration":
      return `Falta conectar la integración "${key}". Puedes publicarla igual; configúrala en la cuenta antes de operar.`;
    case "runtime_input":
      return `${label ?? key} se pedirá al iniciar la ejecución (no es un recurso permanente).`;
    case "case_fact":
      return `${label ?? key} se captura o verifica en el expediente del caso.`;
    case "business_record":
      return `${label ?? key} se lee del sistema de negocio / warehouse conectado.`;
    case "knowledge_requirement":
      return `${label ?? key} se consultará en la base de conocimiento cuando esté disponible.`;
    case "generated_artifact":
      return `${label ?? key} se genera durante la ejecución; no hay que subirlo.`;
    case "human_input":
      return `${label ?? key} se solicitará a una persona en el momento adecuado.`;
    case "misclassified_asset":
      return `"${label ?? key}" no es un recurso de cuenta reutilizable; reclasifícalo como dato del caso, input de ejecución o artefacto generado.`;
  }
}

function linkHintFor(
  kind: CapabilityRequirementKind
): CapabilityGap["linkHint"] {
  if (kind === "account_asset") return "assets_panel";
  if (kind === "integration") return "integrations_panel";
  if (
    kind === "runtime_input" ||
    kind === "case_fact" ||
    kind === "human_input"
  ) {
    return "case_intake";
  }
  return null;
}

interface Requirement {
  kind: CapabilityRequirementKind;
  key: string;
  blocking: boolean;
  requiredBy: string;
  label?: string;
  /** Informational entries never become gaps. */
  informational?: boolean;
}

function asCapabilityKind(
  kind: InputRequirementKind
): CapabilityRequirementKind {
  if (kind === "tool") return "tool";
  if (kind === "integration") return "integration";
  return kind;
}

/** Requisitos declarados por el grafo (la fuente de verdad, no el LLM). */
function collectRequirements(
  graph: WorkflowGraph,
  catalogs: CapabilityCatalogs,
  inputRequirements: InputRequirement[] = []
): Requirement[] {
  const requirements: Requirement[] = [];

  for (const binding of graph.step_bindings) {
    if (binding.skill) {
      requirements.push({
        kind: "skill",
        key: binding.skill,
        blocking: true,
        requiredBy: binding.state,
      });
      for (const toolId of catalogs.skillAllowedTools?.get(binding.skill) ?? []) {
        requirements.push({
          kind: "tool",
          key: toolId,
          blocking: true,
          requiredBy: `${binding.state} (skill ${binding.skill})`,
        });
      }
    }
    if (binding.bigquery_context) {
      requirements.push({
        kind: "tool",
        key: "bigquery_run_query",
        blocking: true,
        requiredBy: `${binding.state} (warehouse)`,
      });
    }
    for (const asset of binding.required_assets ?? []) {
      const optional = asset.required === false || (asset.min_count ?? 1) === 0;
      if (optional) continue;
      const pseudo: InputRequirement = {
        kind: "account_asset",
        key: asset.asset_key,
        label: asset.label,
      };
      if (looksLikeMisclassifiedAccountAsset(pseudo)) {
        requirements.push({
          kind: "misclassified_asset",
          key: asset.asset_key,
          blocking: true,
          requiredBy: binding.state,
          label: asset.label,
        });
        continue;
      }
      requirements.push({
        kind: "account_asset",
        key: asset.asset_key,
        blocking: false,
        requiredBy: binding.state,
        label: asset.label,
      });
    }
  }

  for (const req of inputRequirements) {
    if (isGeneratedOutput(req)) {
      requirements.push({
        kind: "generated_artifact",
        key: req.key,
        blocking: false,
        requiredBy: req.producer_step ?? "implementation_spec",
        label: req.label,
        informational: true,
      });
      continue;
    }
    if (looksLikeMisclassifiedAccountAsset(req)) {
      requirements.push({
        kind: "misclassified_asset",
        key: req.key,
        blocking: true,
        requiredBy: "implementation_spec",
        label: req.label,
      });
      continue;
    }
    const kind = asCapabilityKind(req.kind);
    const blocking = kind === "tool" || kind === "skill";
    requirements.push({
      kind,
      key: req.key,
      blocking,
      requiredBy: "implementation_spec",
      label: req.label,
      // Runtime/case facts are not pre-publish blockers.
      informational:
        kind === "runtime_input" ||
        kind === "case_fact" ||
        kind === "business_record" ||
        kind === "knowledge_requirement" ||
        kind === "human_input",
    });
  }

  for (const template of graph.work_templates) {
    if (template.required_capability) {
      requirements.push({
        kind: "worker_capability",
        key: template.required_capability,
        blocking: true,
        requiredBy: template.on_enter_state,
      });
    }
  }

  for (const transition of graph.transitions) {
    for (const guard of transition.guards) {
      requirements.push({
        kind: "guard",
        key: guard,
        blocking: true,
        requiredBy: `${transition.from} → ${transition.to}`,
      });
    }
  }

  return requirements;
}

export function resolveCapabilityMap(
  graph: WorkflowGraph,
  catalogs: CapabilityCatalogs,
  options?: { inputRequirements?: InputRequirement[] }
): CapabilityMapResult {
  const skills = new Set(catalogs.skillSlugs);
  const tools = new Set(catalogs.toolIds);
  const capabilities = new Set(catalogs.workerCapabilities);
  const guards = new Set(catalogs.knownGuards);
  const assets = new Set(catalogs.tenantConfiguredAssetKeys);
  const integrations = new Set(catalogs.connectedIntegrations);

  const requirements = collectRequirements(
    graph,
    catalogs,
    options?.inputRequirements ?? []
  );

  const derivedIntegrations: Requirement[] = [];
  for (const requirement of requirements) {
    if (requirement.kind !== "tool") continue;
    const integration = catalogs.toolIntegrationById?.get(requirement.key);
    if (integration) {
      derivedIntegrations.push({
        kind: "integration",
        key: integration,
        blocking: false,
        requiredBy: `tool ${requirement.key}`,
      });
    }
  }
  requirements.push(...derivedIntegrations);

  const byId = new Map<
    string,
    { requirement: Requirement; requiredBy: Set<string> }
  >();
  for (const requirement of requirements) {
    const id = `${requirement.kind}:${requirement.key}`;
    const existing = byId.get(id);
    if (existing) {
      existing.requiredBy.add(requirement.requiredBy);
      if (requirement.blocking) existing.requirement.blocking = true;
      if (requirement.label && !existing.requirement.label) {
        existing.requirement.label = requirement.label;
      }
      continue;
    }
    byId.set(id, {
      requirement: { ...requirement },
      requiredBy: new Set([requirement.requiredBy]),
    });
  }

  const resolvedFor = (
    kind: CapabilityRequirementKind,
    key: string
  ): boolean | "informational" => {
    switch (kind) {
      case "skill":
        return skills.has(key);
      case "tool":
        return tools.has(key);
      case "worker_capability":
        return capabilities.has(key);
      case "guard":
        return guards.has(key);
      case "account_asset":
        return assets.has(key);
      case "integration":
        return integrations.has(key);
      case "generated_artifact":
      case "runtime_input":
      case "case_fact":
      case "business_record":
      case "knowledge_requirement":
      case "human_input":
        return "informational";
      case "misclassified_asset":
        return false;
    }
  };

  const entries: CapabilityMapEntry[] = [];
  const gaps: CapabilityGap[] = [];
  for (const { requirement, requiredBy } of byId.values()) {
    const resolved = resolvedFor(requirement.kind, requirement.key);
    const status =
      resolved === "informational"
        ? "informational"
        : resolved
          ? "resolved"
          : "missing";
    entries.push({
      kind: requirement.kind,
      key: requirement.key,
      status,
      blocking: requirement.blocking,
      requiredBy: [...requiredBy].sort(),
      ...(requirement.label ? { detail: requirement.label } : {}),
    });
    if (status === "missing") {
      const typed: InputRequirement | null =
        requirement.kind === "account_asset" ||
        requirement.kind === "runtime_input" ||
        requirement.kind === "case_fact" ||
        requirement.kind === "business_record" ||
        requirement.kind === "knowledge_requirement" ||
        requirement.kind === "generated_artifact" ||
        requirement.kind === "human_input" ||
        requirement.kind === "integration" ||
        requirement.kind === "tool"
          ? {
              kind: requirement.kind,
              key: requirement.key,
              label: requirement.label ?? requirement.key,
            }
          : null;
      gaps.push({
        kind: requirement.kind,
        key: requirement.key,
        blocking: requirement.blocking,
        customerMessage: typed
          ? customerMessageForInputRequirement(typed)
          : customerMessageFor(
              requirement.kind,
              requirement.key,
              requirement.label
            ),
        linkHint:
          typed && requirement.kind !== "misclassified_asset"
            ? (() => {
                const hint = linkHintForInputRequirement(typed.kind);
                return hint === "none" ? null : hint;
              })()
            : linkHintFor(requirement.kind),
      });
    }
  }

  entries.sort((a, b) =>
    a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)
  );
  const blockingGaps = gaps.filter((gap) => gap.blocking);
  return { entries, gaps, blockingGaps, ok: blockingGaps.length === 0 };
}
