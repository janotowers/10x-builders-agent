/**
 * Procedencia de skills para Studio / Settings.
 *
 * Tres vías de procedencia:
 *   - Global de producto (skill en disco / catálogo)
 *   - Personalizada (account override del mismo slug)
 *   - Creada en Diseño / propia de la cuenta (account_native)
 */

import type { AccountSkill, WorkflowDefinition } from "@agents/types";
import { stepSkillSummary } from "@/lib/workflow-studio/definition-catalog";

export type SkillProvenanceKind =
  | "global"
  | "account_override"
  | "account_native";

export function classifyAccountSkillProvenance(input: {
  slug: string;
  metadata?: Record<string, unknown> | null;
  globalSkillSlugs: ReadonlySet<string> | readonly string[];
}): SkillProvenanceKind {
  const globals = input.globalSkillSlugs instanceof Set
    ? input.globalSkillSlugs
    : new Set(input.globalSkillSlugs);
  if (globals.has(input.slug)) return "account_override";
  return "account_native";
}

export function classifySkillProvenance(input: {
  slug: string;
  accountSkill: AccountSkill | null | undefined;
  globalSkillSlugs: ReadonlySet<string> | readonly string[];
}): SkillProvenanceKind {
  const globals = input.globalSkillSlugs instanceof Set
    ? input.globalSkillSlugs
    : new Set(input.globalSkillSlugs);
  if (input.accountSkill) {
    return classifyAccountSkillProvenance({
      slug: input.slug,
      metadata: input.accountSkill.metadata_jsonb,
      globalSkillSlugs: globals,
    });
  }
  return "global";
}

export function skillProvenanceLabel(kind: SkillProvenanceKind): string {
  switch (kind) {
    case "global":
      return "Global de producto";
    case "account_override":
      return "Personalizada (reemplaza la global de producto)";
    case "account_native":
      return "Creada en Diseño";
  }
}

/** Label corto para tarjetas de skills de cuenta (nunca "Global de producto"). */
export function accountSkillProvenanceLabel(kind: SkillProvenanceKind): string {
  if (kind === "account_override") {
    return "Personalizada (reemplaza la global de producto)";
  }
  return "Creada en Diseño";
}

export type SkillUsageRole = "root" | "step";

export type SkillUsageEntry = {
  slug: string;
  caseTypes: string[];
  roles: SkillUsageRole[];
};

/**
 * Índice "Usada por" a partir de definiciones (step_bindings) y, opcionalmente,
 * default_skill_slug por case type.
 */
export function buildSkillUsageIndex(input: {
  definitions: WorkflowDefinition[];
  caseTypeRoots?: ReadonlyArray<{ caseType: string; defaultSkillSlug: string }>;
}): Map<string, SkillUsageEntry> {
  const index = new Map<string, SkillUsageEntry>();

  function touch(slug: string, caseType: string, role: SkillUsageRole) {
    const key = slug.trim();
    if (!key) return;
    const existing = index.get(key) ?? {
      slug: key,
      caseTypes: [],
      roles: [],
    };
    if (!existing.caseTypes.includes(caseType)) {
      existing.caseTypes.push(caseType);
    }
    if (!existing.roles.includes(role)) {
      existing.roles.push(role);
    }
    index.set(key, existing);
  }

  for (const root of input.caseTypeRoots ?? []) {
    touch(root.defaultSkillSlug, root.caseType, "root");
  }

  for (const definition of input.definitions) {
    const steps = stepSkillSummary(definition.graph_jsonb);
    for (const step of steps) {
      if (step.skill) touch(step.skill, definition.case_type, "step");
    }
  }

  return index;
}

export function formatSkillUsedBy(
  entry: SkillUsageEntry | undefined,
  friendlyCaseTypeLabel: (caseType: string) => string
): string | null {
  if (!entry || entry.caseTypes.length === 0) return null;
  const labels = entry.caseTypes.map(friendlyCaseTypeLabel);
  if (labels.length === 1) return `Usada por: ${labels[0]}`;
  return `Usada por: ${labels.join(", ")}`;
}

/**
 * Etiqueta de uso para tarjetas de Studio: distingue skill raíz de caso
 * vs skill de paso, más el/los flujos que la referencian.
 */
export function formatSkillStudioUsageLabel(
  entry: SkillUsageEntry | undefined,
  friendlyCaseTypeLabel: (caseType: string) => string
): string | null {
  if (!entry || entry.caseTypes.length === 0) return null;
  const roleLabel = entry.roles.includes("root")
    ? "Skill raíz"
    : entry.roles.includes("step")
      ? "Skill de paso"
      : null;
  const usedBy = formatSkillUsedBy(entry, friendlyCaseTypeLabel);
  return [roleLabel, usedBy].filter(Boolean).join(" · ");
}
