/**
 * Inventario puro de creaciones propias del Studio (Diseño).
 *
 * Agrupa versiones de flujo por familia, deduplica schedule↔durable_task y
 * produce tarjetas con deep links estables. No toca DB.
 * UI: «Mis creaciones» — no usar «artefactos» (reservado al plano de impacto).
 */

import type {
  AccountSkill,
  DurableTask,
  WorkflowDefinition,
} from "@agents/types";
import {
  definitionLifecycleLabel,
  filterCatalogDefinitions,
  friendlyCaseTypeLabel,
  groupDefinitionFamilies,
  isVigenteForNewCases,
} from "@/lib/workflow-studio/definition-catalog";
import {
  accountSkillProvenanceLabel,
  classifyAccountSkillProvenance,
  type SkillProvenanceKind,
} from "@/lib/skill-provenance";

export type StudioArtifactKind =
  | "case_workflow"
  | "durable_task"
  | "reusable_skill"
  | "schedule";

export type StudioArtifactCard = {
  kind: StudioArtifactKind;
  id: string;
  title: string;
  subtitle: string;
  statusLabel: string;
  href: string;
  updatedAt: string;
  provenanceKind?: SkillProvenanceKind;
  provenanceLabel?: string;
  /** Versiones publicadas históricas (solo flujos). */
  historicalPublishedCount?: number;
  draftCount?: number;
};

export const STUDIO_KIND_BADGE: Record<
  StudioArtifactKind,
  { label: string; className: string }
> = {
  case_workflow: {
    label: "Flujo de caso",
    className:
      "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  },
  durable_task: {
    label: "Tarea durable",
    className:
      "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  },
  reusable_skill: {
    label: "Skill",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  },
  schedule: {
    label: "Programación",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  },
};

const DURABLE_TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  active: "Activa",
  paused: "Pausada",
  completed: "Completada",
  cancelled: "Cancelada",
  failed: "Fallida",
};

const SKILL_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  active: "Activa",
  archived: "Archivada",
};

export type StudioScheduleInput = {
  id: string;
  display_title?: string | null;
  cron_expr?: string | null;
  timezone?: string | null;
  schedule_type?: string | null;
  status: string;
  durable_task_id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type BuildStudioInventoryInput = {
  ownDefinitions: WorkflowDefinition[];
  durableTasks: DurableTask[];
  accountSkills: AccountSkill[];
  scheduledTasks: StudioScheduleInput[];
  /** Slugs globales conocidos (para provenance de skills de cuenta). */
  globalSkillSlugs?: ReadonlySet<string> | readonly string[];
  showTests?: boolean;
  testsQuerySuffix?: string;
};

function designHref(
  params: { definition?: string; durable_task?: string; schedule?: string },
  testsSuffix: string
): string {
  const qs = new URLSearchParams();
  if (params.definition) qs.set("definition", params.definition);
  if (params.durable_task) qs.set("durable_task", params.durable_task);
  if (params.schedule) qs.set("schedule", params.schedule);
  const base = qs.toString();
  if (!base) return `/operations/workflows/design${testsSuffix}`;
  if (testsSuffix.startsWith("?")) {
    return `/operations/workflows/design?${base}&${testsSuffix.slice(1)}`;
  }
  if (testsSuffix.startsWith("&")) {
    return `/operations/workflows/design?${base}${testsSuffix}`;
  }
  return `/operations/workflows/design?${base}`;
}

function definitionUpdatedAt(definition: WorkflowDefinition): string {
  return (
    (definition as { updated_at?: string }).updated_at ??
    definition.published_at ??
    definition.created_at ??
    ""
  );
}

/**
 * Construye la lista de tarjetas de **Mis creaciones**.
 *
 * - Una tarjeta por familia de flujo (cabeza = vigente / mejor candidata).
 * - Si un schedule apunta a un durable_task, se muestra solo la
 *   Programación (el durable queda enlazado en el subtítulo).
 */
export function buildStudioInventory(
  input: BuildStudioInventoryInput
): StudioArtifactCard[] {
  const showTests = Boolean(input.showTests);
  const testsSuffix = showTests ? "?tests=1" : "";
  const globalSlugs = new Set(
    input.globalSkillSlugs
      ? [...input.globalSkillSlugs]
      : []
  );

  const filtered = filterCatalogDefinitions(input.ownDefinitions, {
    showTests,
  });
  const families = groupDefinitionFamilies(filtered, {});

  const cards: StudioArtifactCard[] = [];

  for (const family of families) {
    const head = family.head;
    const published = family.versions.filter((v) => v.status === "published");
    const historicalPublishedCount = published.filter(
      (v) => !isVigenteForNewCases(v, family.versions)
    ).length;
    const statusLabel = definitionLifecycleLabel(head, family.versions);
    cards.push({
      kind: "case_workflow",
      id: head.id,
      title: friendlyCaseTypeLabel(head.case_type),
      subtitle: `${head.case_type} · v${head.version}${
        historicalPublishedCount > 0
          ? ` · ${historicalPublishedCount} histórica${
              historicalPublishedCount === 1 ? "" : "s"
            }`
          : ""
      }${
        family.draftCount > 0
          ? ` · ${family.draftCount} borrador${
              family.draftCount === 1 ? "" : "es"
            }`
          : ""
      }`,
      statusLabel,
      href: designHref({ definition: head.id }, testsSuffix),
      updatedAt: definitionUpdatedAt(head),
      historicalPublishedCount,
      draftCount: family.draftCount,
    });
  }

  const durableIdsCoveredBySchedule = new Set<string>();
  for (const schedule of input.scheduledTasks) {
    if (schedule.durable_task_id) {
      durableIdsCoveredBySchedule.add(schedule.durable_task_id);
    }
  }

  for (const task of input.durableTasks) {
    if (durableIdsCoveredBySchedule.has(task.id)) continue;
    if (task.schedule_ref) {
      // Cubierto por programación (aunque el listado de schedules falle).
      const matching = input.scheduledTasks.find(
        (schedule) => schedule.id === task.schedule_ref
      );
      if (matching) continue;
    }
    const objective = (task.objective ?? "").trim();
    cards.push({
      kind: "durable_task",
      id: task.id,
      title: task.title,
      subtitle:
        objective.slice(0, 80) + (objective.length > 80 ? "…" : ""),
      statusLabel:
        DURABLE_TASK_STATUS_LABELS[task.status] ?? task.status,
      href: designHref({ durable_task: task.id }, testsSuffix),
      updatedAt: task.updated_at ?? task.created_at ?? "",
    });
  }

  for (const skill of input.accountSkills) {
    const provenance = classifyAccountSkillProvenance({
      slug: skill.slug,
      metadata: skill.metadata_jsonb,
      globalSkillSlugs: globalSlugs,
    });
    const displayTitle =
      (typeof skill.metadata_jsonb?.display_title === "string" &&
        skill.metadata_jsonb.display_title.trim()) ||
      (typeof skill.metadata_jsonb?.name === "string" &&
        skill.metadata_jsonb.name.trim()) ||
      skill.slug;
    cards.push({
      kind: "reusable_skill",
      id: skill.id,
      title: displayTitle,
      subtitle: skill.slug,
      statusLabel: SKILL_STATUS_LABELS[skill.status] ?? skill.status,
      href: `/operations/workflows/design?account_skill=${encodeURIComponent(skill.slug)}${testsSuffix}`,
      updatedAt: skill.updated_at ?? skill.created_at ?? "",
      provenanceKind: provenance,
      provenanceLabel: accountSkillProvenanceLabel(provenance),
    });
  }

  for (const schedule of input.scheduledTasks) {
    const title =
      (typeof schedule.display_title === "string" &&
        schedule.display_title.trim()) ||
      "Tarea programada";
    const cronBit = schedule.cron_expr
      ? `Cron ${schedule.cron_expr}${
          schedule.timezone ? ` · ${schedule.timezone}` : ""
        }`
      : schedule.schedule_type ?? "Programación";
    const durableBit = schedule.durable_task_id
      ? " · con tarea durable"
      : "";
    cards.push({
      kind: "schedule",
      id: schedule.id,
      title,
      subtitle: `${cronBit}${durableBit}`,
      statusLabel:
        schedule.status === "active"
          ? "Activa"
          : schedule.status === "paused"
            ? "Pausada"
            : schedule.status,
      href: schedule.durable_task_id
        ? designHref(
            {
              durable_task: schedule.durable_task_id,
              schedule: schedule.id,
            },
            testsSuffix
          )
        : designHref({ schedule: schedule.id }, testsSuffix),
      updatedAt: schedule.updated_at ?? schedule.created_at ?? "",
    });
  }

  return cards.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );
}
