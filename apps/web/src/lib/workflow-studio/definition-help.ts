/**
 * Resolver de ayudas/descripciones para el detalle del Studio.
 *
 * Precedencia de descripción de paso:
 *   1. Metadata del flow del laboratorio (`step_description`)
 *   2. Fallback conocido para estados añadidos solo en el grafo ejecutable
 *      (p. ej. property_data_review / published del transformer)
 *   3. null → la UI muestra "Sin descripción disponible"
 *
 * Skills (Studio): se prioriza copy de operador sobre jerga de lab/runtime.
 *   - Si el flow es técnico y el registry no, gana el registry.
 *   - Si solo hay copy técnico, se suaviza para el operador y el original
 *     queda en `skillTechnicalNotes`.
 * Nunca inventa texto con IA: solo ensambla y reformatea fuentes existentes.
 */

import type { OperationalCaseFlowStep, WorkflowGraph } from "@agents/types";

export interface RootSkillHelp {
  slug: string;
  /** Parte “qué es” orientada al operador (sin cláusulas de routing). */
  description: string | null;
  /**
   * Cláusulas `Use when` / `Do not use` del selector de skills.
   * Son instrucciones para el agente, no copy de producto.
   */
  routingHint: string | null;
  /** Copy original con ids/herramientas, si se suavizó la descripción. */
  technicalNotes: string | null;
  /** Sub-skills que compone (includes del registry), si es compuesta. */
  includes: string[];
}

export interface DefinitionHelpCatalog {
  stepDescriptions: Record<string, string>;
  skillDescriptions: Record<string, string>;
  /** Routing hints por slug (solo si el description del skill los traía). */
  skillRoutingHints: Record<string, string>;
  /**
   * Descripción original (lab/registry) cuando el summary de operador se
   * suavizó para ocultar ids/herramientas.
   */
  skillTechnicalNotes: Record<string, string>;
  skillLabels: Record<string, string>;
  rootSkill: RootSkillHelp | null;
}

export interface SkillDescriptionParts {
  /** Texto para el operador. */
  summary: string;
  /** Texto de selección del agente, o null si no había cláusula de routing. */
  routing: string | null;
}

export interface SoftenedSkillCopy {
  summary: string;
  /** Original (o pre-suavizado) si se detectó/aplicó jerga técnica. */
  technicalNotes: string | null;
}

/**
 * Separa el description del skill (campo único del frontmatter) en:
 *   - summary: qué hace (humano)
 *   - routing: `Use when` / `Do not use` (selector LLM)
 *
 * El campo viene mezclado a propósito para el runtime; en el Studio no
 * conviene mostrarlo como un solo párrafo de producto.
 */
export function splitSkillDescriptionForStudio(
  raw: string
): SkillDescriptionParts {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { summary: "", routing: null };

  const match = normalized.match(/\b(?:Use when|Do not use)\b/i);
  if (!match || match.index == null) {
    return { summary: collapseWhitespace(normalized), routing: null };
  }

  const summary = collapseWhitespace(normalized.slice(0, match.index));
  const routing = collapseWhitespace(normalized.slice(match.index));
  return {
    summary: summary || collapseWhitespace(normalized),
    routing: routing || null,
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function studioSkillParts(raw: string): SkillDescriptionParts {
  return splitSkillDescriptionForStudio(raw);
}

/** Tokens de lab/runtime que no deben liderar el copy del Studio. */
const TECHNICAL_PHRASE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdocument_request_target\b/gi, "quién debe aportar los documentos"],
  [/\bnotify_user\b/gi, "notificación al asesor"],
  [/\bawaiting_documents\b/gi, "el paso de espera de documentos"],
  [/\bcase_type\b/gi, "tipo de caso"],
];

/**
 * Detecta copy orientado a implementación (ids snake_case, backticks de
 * herramientas, nombres de tools) frente a prosa de operador.
 */
export function looksLikeTechnicalSkillCopy(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/`[a-z0-9_./-]+`/i.test(value)) return true;
  if (/\b[a-z]+(?:_[a-z0-9]+)+\b/.test(value)) return true;
  return false;
}

/**
 * Reformatea jerga conocida para el operador. No inventa un párrafo nuevo:
 * solo sustituye tokens y quita backticks. Si hubo cambio o el texto sigue
 * siendo técnico, el original queda en `technicalNotes`.
 */
export function softenSkillCopyForOperator(summary: string): SoftenedSkillCopy {
  const original = collapseWhitespace(summary);
  if (!original) return { summary: "", technicalNotes: null };
  if (!looksLikeTechnicalSkillCopy(original)) {
    return { summary: original, technicalNotes: null };
  }

  let softened = original;
  for (const [pattern, replacement] of TECHNICAL_PHRASE_REPLACEMENTS) {
    softened = softened.replace(pattern, replacement);
  }
  softened = softened.replace(/`([^`]+)`/g, "$1");
  softened = collapseWhitespace(softened);

  return {
    summary: softened || original,
    technicalNotes: original,
  };
}

/** Compara etiquetas de paso/habilidad ignorando acentos y mayúsculas. */
export function studioLabelsEquivalent(a: string, b: string): boolean {
  const norm = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/**
 * Estados que el transformer añade al grafo y que NO viven en
 * operational_flow_jsonb del lab — por eso el flow no trae descripción.
 */
const GRAPH_ONLY_STEP_DESCRIPTIONS: Record<string, string> = {
  property_data_review:
    "Revisión humana de los datos estructurados de la propiedad antes de avanzar al análisis de comparables. Este paso existe en la definición ejecutable; el laboratorio histórico no lo tenía como paso separado.",
  published:
    "Estado final del flujo: la propiedad quedó publicada y el caso se considera completado.",
};

export function emptyHelpCatalog(): DefinitionHelpCatalog {
  return {
    stepDescriptions: {},
    skillDescriptions: {},
    skillRoutingHints: {},
    skillTechnicalNotes: {},
    skillLabels: {},
    rootSkill: null,
  };
}

function applyStoredSkillSummary(
  catalog: DefinitionHelpCatalog,
  slug: string,
  summary: string,
  options: { overwrite: boolean }
): void {
  const softened = softenSkillCopyForOperator(summary);
  if (!softened.summary) return;

  const existing = catalog.skillDescriptions[slug];
  if (existing && !options.overwrite) return;

  catalog.skillDescriptions[slug] = softened.summary;
  if (softened.technicalNotes) {
    catalog.skillTechnicalNotes[slug] = softened.technicalNotes;
  } else if (options.overwrite) {
    delete catalog.skillTechnicalNotes[slug];
  }
}

function storeSkillDescription(
  catalog: DefinitionHelpCatalog,
  slug: string,
  raw: string,
  options: { overwrite?: boolean } = {}
): void {
  const parts = studioSkillParts(raw);
  applyStoredSkillSummary(catalog, slug, parts.summary, {
    overwrite: options.overwrite === true,
  });
  if (parts.routing) {
    if (options.overwrite || !catalog.skillRoutingHints[slug]) {
      catalog.skillRoutingHints[slug] = parts.routing;
    }
  }
}

/** Extrae descripciones del operational_flow_jsonb del case type. */
export function helpCatalogFromFlow(
  flow: OperationalCaseFlowStep[] | null | undefined
): DefinitionHelpCatalog {
  const catalog = emptyHelpCatalog();
  for (const step of flow ?? []) {
    const description = step.step_description?.trim();
    if (description) catalog.stepDescriptions[step.step_key] = description;
    for (const skill of step.step_skills ?? []) {
      const skillDescription = skill.skill_description?.trim();
      if (skillDescription) {
        storeSkillDescription(catalog, skill.skill_slug, skillDescription);
      }
      const skillLabel = skill.skill_label?.trim();
      if (skillLabel) catalog.skillLabels[skill.skill_slug] = skillLabel;
    }
  }
  return catalog;
}

/**
 * Rellena descripciones de estados presentes en el grafo que el lab no tiene
 * (estados añadidos por el transformer). No sobrescribe descripciones del flow.
 */
export function applyGraphOnlyStepFallbacks(
  catalog: DefinitionHelpCatalog,
  graph: WorkflowGraph
): DefinitionHelpCatalog {
  const next: DefinitionHelpCatalog = {
    ...catalog,
    stepDescriptions: { ...catalog.stepDescriptions },
  };
  for (const state of graph.states) {
    if (next.stepDescriptions[state.key]) continue;
    const fallback = GRAPH_ONLY_STEP_DESCRIPTIONS[state.key];
    if (fallback) next.stepDescriptions[state.key] = fallback;
  }
  return next;
}

export interface SkillHelpSource {
  name: string;
  description: string;
  includes?: readonly string[];
}

/**
 * Complementa con el registro de skills del tenant.
 * Si el flow ya guardó copy técnico y el registry ofrece prosa de operador,
 * el registry gana para el summary del Studio.
 */
export function mergeSkillRegistryHelp(
  catalog: DefinitionHelpCatalog,
  skills: ReadonlyArray<SkillHelpSource>
): DefinitionHelpCatalog {
  const next: DefinitionHelpCatalog = {
    stepDescriptions: { ...catalog.stepDescriptions },
    skillDescriptions: { ...catalog.skillDescriptions },
    skillRoutingHints: { ...catalog.skillRoutingHints },
    skillTechnicalNotes: { ...catalog.skillTechnicalNotes },
    skillLabels: { ...catalog.skillLabels },
    rootSkill: catalog.rootSkill,
  };
  for (const skill of skills) {
    const description = skill.description.trim();
    if (!description) continue;

    const parts = studioSkillParts(description);
    const softened = softenSkillCopyForOperator(parts.summary);
    const existing = next.skillDescriptions[skill.name];
    const existingTechnical =
      Boolean(next.skillTechnicalNotes[skill.name]) ||
      looksLikeTechnicalSkillCopy(existing ?? "");
    const candidateIsOperatorFacing =
      Boolean(softened.summary) &&
      !looksLikeTechnicalSkillCopy(softened.summary);

    if (!existing) {
      storeSkillDescription(next, skill.name, description);
      continue;
    }

    if (existingTechnical && candidateIsOperatorFacing) {
      // Conserva la jerga del flow/registry previo como nota técnica.
      const previousOriginal =
        next.skillTechnicalNotes[skill.name] ?? existing;
      next.skillDescriptions[skill.name] = softened.summary;
      next.skillTechnicalNotes[skill.name] = previousOriginal;
    }

    if (parts.routing && !next.skillRoutingHints[skill.name]) {
      next.skillRoutingHints[skill.name] = parts.routing;
    }
  }
  return next;
}

/**
 * Fija la habilidad raíz del case type (`default_skill_slug`) usando el
 * registry para descripción e includes.
 */
export function withRootSkill(
  catalog: DefinitionHelpCatalog,
  rootSlug: string | null | undefined,
  skills: ReadonlyArray<SkillHelpSource>
): DefinitionHelpCatalog {
  const slug = rootSlug?.trim();
  if (!slug) return catalog;
  const match = skills.find((skill) => skill.name === slug);
  const parts = match
    ? studioSkillParts(match.description)
    : {
        summary: catalog.skillDescriptions[slug] ?? "",
        routing: catalog.skillRoutingHints[slug] ?? null,
      };
  const softened = softenSkillCopyForOperator(
    parts.summary || catalog.skillDescriptions[slug] || ""
  );
  return {
    ...catalog,
    rootSkill: {
      slug,
      description: softened.summary || null,
      routingHint: parts.routing,
      technicalNotes:
        softened.technicalNotes ??
        catalog.skillTechnicalNotes[slug] ??
        null,
      includes: match?.includes ? [...match.includes] : [],
    },
  };
}

export function resolveStepDescription(
  stepKey: string,
  help: DefinitionHelpCatalog
): string | null {
  return help.stepDescriptions[stepKey] ?? null;
}

export function resolveSkillDescription(
  skillSlug: string | null | undefined,
  help: DefinitionHelpCatalog
): string | null {
  if (!skillSlug) return null;
  return help.skillDescriptions[skillSlug] ?? null;
}

export function resolveSkillRoutingHint(
  skillSlug: string | null | undefined,
  help: DefinitionHelpCatalog
): string | null {
  if (!skillSlug) return null;
  return help.skillRoutingHints[skillSlug] ?? null;
}

export function resolveSkillTechnicalNotes(
  skillSlug: string | null | undefined,
  help: DefinitionHelpCatalog
): string | null {
  if (!skillSlug) return null;
  return help.skillTechnicalNotes[skillSlug] ?? null;
}

export function resolveSkillLabel(
  skillSlug: string | null | undefined,
  help: DefinitionHelpCatalog
): string | null {
  if (!skillSlug) return null;
  return help.skillLabels[skillSlug] ?? null;
}
