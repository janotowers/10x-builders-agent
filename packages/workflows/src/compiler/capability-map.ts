/**
 * Capability map (Slice 4.2-1; Technical Plan §15): resuelve lo que un grafo
 * DECLARA contra lo que la cuenta TIENE — skills, tools del catálogo,
 * capacidades de worker profiles, guards registrados, `required_assets`
 * contra `account_assets` e integraciones conectadas.
 *
 * Dos clases de resultado, a propósito distintas (§5.4):
 *   - Gap BLOQUEANTE: el runtime no podría ejecutar (skill/tool/guard/
 *     capacidad inexistentes). Falla el gate de capability resolution.
 *   - Gap NO bloqueante (backlog del cliente): falta subir un asset o
 *     conectar una integración. La definición puede publicarse; el gap se
 *     muestra en palabras del cliente con link al panel correspondiente
 *     ("la lista de gaps es backlog, no un callejón sin salida" — §15).
 *
 * Módulo puro: los catálogos llegan resueltos (la capa web los arma desde
 * @agents/db / @agents/agent). Cero I/O aquí.
 */

import type { WorkflowGraph } from "@agents/types";

export type CapabilityRequirementKind =
  | "skill"
  | "tool"
  | "worker_capability"
  | "guard"
  | "account_asset"
  | "integration";

export interface CapabilityMapEntry {
  kind: CapabilityRequirementKind;
  key: string;
  status: "resolved" | "missing";
  /** true = su ausencia impide ejecutar (falla el gate). */
  blocking: boolean;
  /** Estados/lugares del grafo que lo requieren. */
  requiredBy: string[];
  detail?: string;
}

export interface CapabilityGap {
  kind: CapabilityRequirementKind;
  key: string;
  blocking: boolean;
  /** Wording para el cliente (ES), sin vocabulario técnico interno. */
  customerMessage: string;
  /** A dónde puede ir el cliente a resolverlo. */
  linkHint: "assets_panel" | "integrations_panel" | null;
}

export interface CapabilityCatalogs {
  /** Slugs de skills disponibles para el tenant (globales + propias activas). */
  skillSlugs: Iterable<string>;
  /** Ids de tools del TOOL_CATALOG. */
  toolIds: Iterable<string>;
  /** toolId → integración requerida (ToolDefinition.requires_integration). */
  toolIntegrationById?: ReadonlyMap<string, string | undefined>;
  /** skill slug → tools que esa skill usa (metadata.allowedTools). */
  skillAllowedTools?: ReadonlyMap<string, readonly string[]>;
  /** Capacidades cubiertas por los worker profiles del tenant. */
  workerCapabilities: Iterable<string>;
  /** Guards registrados en el runtime. */
  knownGuards: Iterable<string>;
  /** asset_keys ya configurados (con archivo) en account_assets. */
  tenantConfiguredAssetKeys: Iterable<string>;
  /** Providers de integración conectados (user_integrations + tool secrets). */
  connectedIntegrations: Iterable<string>;
}

export interface CapabilityMapResult {
  entries: CapabilityMapEntry[];
  gaps: CapabilityGap[];
  blockingGaps: CapabilityGap[];
  /** true cuando no hay gaps bloqueantes (los backlog no cuentan). */
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
      return `Falta conectar la integración "${key}" para que el flujo pueda operar.`;
  }
}

function linkHintFor(
  kind: CapabilityRequirementKind
): CapabilityGap["linkHint"] {
  if (kind === "account_asset") return "assets_panel";
  if (kind === "integration") return "integrations_panel";
  return null;
}

interface Requirement {
  kind: CapabilityRequirementKind;
  key: string;
  blocking: boolean;
  requiredBy: string;
  label?: string;
}

/** Requisitos declarados por el grafo (la fuente de verdad, no el LLM). */
function collectRequirements(
  graph: WorkflowGraph,
  catalogs: CapabilityCatalogs
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
      // Tools de la skill (y sus integraciones) también cuentan.
      for (const toolId of catalogs.skillAllowedTools?.get(binding.skill) ?? []) {
        requirements.push({
          kind: "tool",
          key: toolId,
          blocking: true,
          requiredBy: `${binding.state} (skill ${binding.skill})`,
        });
      }
    }
    for (const asset of binding.required_assets ?? []) {
      const optional = asset.required === false || (asset.min_count ?? 1) === 0;
      if (optional) continue;
      requirements.push({
        kind: "account_asset",
        key: asset.asset_key,
        blocking: false,
        requiredBy: binding.state,
        label: asset.label,
      });
    }
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
  catalogs: CapabilityCatalogs
): CapabilityMapResult {
  const skills = new Set(catalogs.skillSlugs);
  const tools = new Set(catalogs.toolIds);
  const capabilities = new Set(catalogs.workerCapabilities);
  const guards = new Set(catalogs.knownGuards);
  const assets = new Set(catalogs.tenantConfiguredAssetKeys);
  const integrations = new Set(catalogs.connectedIntegrations);

  const requirements = collectRequirements(graph, catalogs);

  // Integraciones derivadas de los tools usados (requires_integration).
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

  // Dedupe (kind, key) acumulando requiredBy; blocking gana sobre backlog.
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

  const resolvedFor = (kind: CapabilityRequirementKind, key: string): boolean => {
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
    }
  };

  const entries: CapabilityMapEntry[] = [];
  const gaps: CapabilityGap[] = [];
  for (const { requirement, requiredBy } of byId.values()) {
    const resolved = resolvedFor(requirement.kind, requirement.key);
    entries.push({
      kind: requirement.kind,
      key: requirement.key,
      status: resolved ? "resolved" : "missing",
      blocking: requirement.blocking,
      requiredBy: [...requiredBy].sort(),
      ...(requirement.label ? { detail: requirement.label } : {}),
    });
    if (!resolved) {
      gaps.push({
        kind: requirement.kind,
        key: requirement.key,
        blocking: requirement.blocking,
        customerMessage: customerMessageFor(
          requirement.kind,
          requirement.key,
          requirement.label
        ),
        linkHint: linkHintFor(requirement.kind),
      });
    }
  }

  entries.sort((a, b) =>
    a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)
  );
  const blockingGaps = gaps.filter((gap) => gap.blocking);
  return { entries, gaps, blockingGaps, ok: blockingGaps.length === 0 };
}
