/**
 * Materializadores de artefactos del Studio (Slice 5.3).
 *
 * Tras el router de autoría, convierte la clasificación en un borrador
 * persistido (definición de caso, tarea durable, skill, schedule) o en una
 * redirección sin artefacto (chat / clarify).
 */

import { Cron } from "croner";
import {
  createDurableTask,
  createScheduledTask,
  insertDraftDefinition,
  listWorkflowDefinitionsVisibleToUser,
  updateDurableTask,
  upsertAccountSkill,
  type DbClient,
} from "@agents/db";
import {
  parseAccountSkillSource,
  SkillParseError,
  WORKFLOW_COMPILER_MODEL_ID,
} from "@agents/agent";
import {
  computeDefinitionHash,
  durableTaskSpecSchema,
  suggestEnglishSlug,
  type AuthoringRouterKind,
  type ReusableSkillSubtype,
  type SolutionPatternComposition,
} from "@agents/workflows";
import { compileWorkflowDescription } from "./compile-definition";
import { compileDurableTaskDescription } from "./compile-durable-task";
import { compileReusableSkillDescription } from "./compile-reusable-skill";

export interface AuthoringMaterializeCatalogs {
  availableGuards: string[];
  availableSkills: string[];
  availableCapabilities: string[];
  availableTools: string[];
}

export interface MaterializeAuthoringArtifactInput {
  db: DbClient;
  userId: string;
  kind: AuthoringRouterKind;
  skillSubtype?: ReusableSkillSubtype;
  title?: string | null;
  slug?: string | null;
  description: string;
  clarificationAnswers?: string[];
  catalogs?: AuthoringMaterializeCatalogs;
  authoringSessionId?: string;
  patternComposition?: SolutionPatternComposition;
  /** Zona horaria para schedules (default America/Mexico_City). */
  timezone?: string;
}

export interface MaterializeAuthoringArtifactResult {
  kind: AuthoringRouterKind;
  redirectPath?: string;
  artifactRef: Record<string, unknown>;
  error?: string;
  /** Preguntas del compilador de caso (no del router). */
  clarifyingQuestions?: string[];
}

function normalizeSnakeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

function snakeToKebab(slug: string): string {
  return slug.replace(/_/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function parseRecurringSchedule(
  description: string
): { cronExpr: string } | { question: string } {
  const text = description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const time = text.match(/\b(?:a\s+las?\s+)?([01]?\d|2[0-3])(?::([0-5]\d))\b/);
  if (!time) {
    return {
      question:
        "¿A qué hora debe ejecutarse la tarea programada (en tu zona horaria)?",
    };
  }
  const hour = Number(time[1]);
  const minute = Number(time[2] ?? "0");
  if (/\b(cada dia|diario|diariamente|todos los dias)\b/.test(text)) {
    return { cronExpr: `${minute} ${hour} * * *` };
  }
  const days: Array<[RegExp, number]> = [
    [/\b(?:cada|todos los)\s+domingo/, 0],
    [/\b(?:cada|todos los)\s+lunes/, 1],
    [/\b(?:cada|todos los)\s+martes/, 2],
    [/\b(?:cada|todos los)\s+miercoles/, 3],
    [/\b(?:cada|todos los)\s+jueves/, 4],
    [/\b(?:cada|todos los)\s+viernes/, 5],
    [/\b(?:cada|todos los)\s+sabado/, 6],
  ];
  const day = days.find(([pattern]) => pattern.test(text));
  if (day) return { cronExpr: `${minute} ${hour} * * ${day[1]}` };
  return {
    question:
      "¿Qué días debe ejecutarse la tarea? Por ejemplo: «cada lunes a las 08:00».",
  };
}

async function materializeCaseWorkflow(
  input: MaterializeAuthoringArtifactInput
): Promise<MaterializeAuthoringArtifactResult> {
  const catalogs = input.catalogs;
  if (!catalogs) {
    return {
      kind: "case_workflow",
      artifactRef: {},
      error: "Faltan catálogos del tenant para compilar el flujo de caso.",
    };
  }
  const caseType =
    normalizeSnakeSlug(input.slug || "") ||
    suggestEnglishSlug(input.title || input.description);
  const title =
    input.title?.trim() ||
    caseType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const compiled = await compileWorkflowDescription({
    description: input.description,
    caseType,
    clarificationAnswers: input.clarificationAnswers,
    availableGuards: catalogs.availableGuards,
    availableSkills: catalogs.availableSkills,
    availableCapabilities: catalogs.availableCapabilities,
    availableTools: catalogs.availableTools,
    patternComposition: input.patternComposition,
  });

  if (compiled.kind === "error") {
    return {
      kind: "case_workflow",
      artifactRef: {},
      error: compiled.message,
    };
  }
  if (compiled.kind === "clarification") {
    return {
      kind: "clarify",
      artifactRef: {},
      clarifyingQuestions: compiled.questions,
    };
  }

  const visible = await listWorkflowDefinitionsVisibleToUser(
    input.db,
    input.userId
  );
  const maxOwnVersion = visible
    .filter((d) => d.user_id === input.userId && d.case_type === caseType)
    .reduce((max, d) => Math.max(max, d.version), 0);

  const draft = await insertDraftDefinition(input.db, {
    userId: input.userId,
    caseType,
    version: maxOwnVersion + 1,
    graph: compiled.graph,
    definitionHash: computeDefinitionHash(compiled.graph),
    businessSpec: {
      ...compiled.businessSpec,
      title: compiled.businessSpec.title || title,
    },
    implementationSpec: compiled.implementationSpec,
    provenance: {
      compiler: {
        model: WORKFLOW_COMPILER_MODEL_ID,
        compiled_at: new Date().toISOString(),
        authoring_router: true,
        studio_authoring_session_id: input.authoringSessionId ?? null,
        solution_patterns: input.patternComposition
          ? {
              base_bundle_id: input.patternComposition.baseBundleId,
              triggers: input.patternComposition.triggers,
              pattern_ids: input.patternComposition.patternIds,
            }
          : null,
      },
    },
  });

  return {
    kind: "case_workflow",
    redirectPath: `/operations/workflows/design?definition=${draft.id}`,
    artifactRef: {
      workflow_definition_id: draft.id,
      case_type: caseType,
    },
  };
}

async function materializeDurableTask(
  input: MaterializeAuthoringArtifactInput,
  status: "draft" | "active" = "draft"
): Promise<MaterializeAuthoringArtifactResult> {
  const catalogs = input.catalogs;
  if (!catalogs) {
    return {
      kind: "durable_task",
      artifactRef: {},
      error: "Faltan catálogos del tenant para compilar la tarea durable.",
    };
  }
  const compiled = await compileDurableTaskDescription({
    description: input.description,
    title: input.title,
    clarificationAnswers: input.clarificationAnswers,
    availableCapabilities: catalogs.availableCapabilities,
    availableTools: catalogs.availableTools,
    patternComposition: input.patternComposition,
  });
  if (compiled.kind === "error") {
    return {
      kind: "durable_task",
      artifactRef: {},
      error: compiled.message,
    };
  }
  if (compiled.kind === "clarification") {
    return {
      kind: "clarify",
      artifactRef: {},
      clarifyingQuestions: compiled.questions,
    };
  }
  const spec = durableTaskSpecSchema.parse(compiled.spec);
  const title = input.title?.trim() || spec.title;
  const task = await createDurableTask(input.db, {
    userId: input.userId,
    title,
    objective: spec.objective,
    status,
    retentionPolicy: spec.retention_policy,
    inputContract: {
      input_requirements: spec.input_requirements,
    },
    spec,
    acceptanceCriteria: spec.acceptance_criteria,
    workTemplates: spec.work_templates,
    resultContract: spec.result_contract,
    provenance: {
      authoring_router: true,
      compiler_model: WORKFLOW_COMPILER_MODEL_ID,
      created_at: new Date().toISOString(),
      studio_authoring_session_id: input.authoringSessionId ?? null,
      solution_patterns: input.patternComposition
        ? {
            base_bundle_id: input.patternComposition.baseBundleId,
            triggers: input.patternComposition.triggers,
            pattern_ids: input.patternComposition.patternIds,
          }
        : null,
    },
  });
  return {
    kind: "durable_task",
    redirectPath: `/operations/workflows/design?durable_task=${task.id}`,
    artifactRef: { durable_task_id: task.id },
  };
}

async function materializeReusableSkill(
  input: MaterializeAuthoringArtifactInput
): Promise<MaterializeAuthoringArtifactResult> {
  const snake =
    normalizeSnakeSlug(input.slug || "") ||
    suggestEnglishSlug(input.title || input.description);
  const slug = snakeToKebab(snake);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return {
      kind: "reusable_skill",
      artifactRef: {},
      error: "No se pudo generar un slug válido para el skill.",
    };
  }
  const title = input.title?.trim() || slug.replace(/-/g, " ");
  if (!input.catalogs) {
    return {
      kind: "reusable_skill",
      artifactRef: {},
      error: "Faltan catálogos del tenant para compilar el skill.",
    };
  }
  let bodyMd: string;
  let compilerModelId: string;
  try {
    const compiled = await compileReusableSkillDescription({
      slug,
      title,
      description: input.description,
      skillSubtype: input.skillSubtype,
      clarificationAnswers: input.clarificationAnswers,
      catalogs: input.catalogs,
      patternComposition: input.patternComposition,
    });
    bodyMd = compiled.bodyMd;
    compilerModelId = compiled.modelId;
  } catch (error) {
    return {
      kind: "reusable_skill",
      artifactRef: {},
      error:
        error instanceof Error
          ? `No se pudo compilar el skill: ${error.message}`
          : "No se pudo compilar el skill.",
    };
  }

  let metadata: Record<string, unknown>;
  try {
    const record = parseAccountSkillSource(bodyMd, slug, input.userId);
    const unknownTools = [...record.metadata.allowedTools].filter(
      (toolId) => !input.catalogs!.availableTools.includes(toolId)
    );
    const unknownIncludes = [...record.metadata.includes].filter(
      (skillSlug) => !input.catalogs!.availableSkills.includes(skillSlug)
    );
    if (unknownTools.length > 0 || unknownIncludes.length > 0) {
      throw new Error(
        [
          unknownTools.length > 0
            ? `tools fuera de catálogo: ${unknownTools.join(", ")}`
            : "",
          unknownIncludes.length > 0
            ? `includes fuera de catálogo: ${unknownIncludes.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; ")
      );
    }
    metadata = {
      name: record.metadata.name,
      description: record.metadata.description,
      scope: record.metadata.scope,
      allowed_tools: [...record.metadata.allowedTools],
      includes: [...record.metadata.includes],
      requires_tenant_context: record.metadata.requiresTenantContext,
      memory_extraction: record.metadata.memoryExtraction,
      skill_subtype: input.skillSubtype ?? "simple",
      display_title: title,
      provenance: "studio_native",
      studio_authoring_session_id: input.authoringSessionId ?? null,
      compiler_model_id: compilerModelId,
      solution_patterns: input.patternComposition
        ? {
            base_bundle_id: input.patternComposition.baseBundleId,
            triggers: input.patternComposition.triggers,
            pattern_ids: input.patternComposition.patternIds,
          }
        : null,
    };
  } catch (error) {
    const message =
      error instanceof SkillParseError
        ? error.message
        : error instanceof Error
          ? error.message
          : "SKILL.md inválido";
    return {
      kind: "reusable_skill",
      artifactRef: {},
      error: `No se pudo validar el borrador del skill: ${message}`,
    };
  }

  await upsertAccountSkill(input.db, {
    userId: input.userId,
    slug,
    bodyMd,
    metadata,
    status: "draft",
  });

  return {
    kind: "reusable_skill",
    redirectPath: `/operations/workflows/design?account_skill=${encodeURIComponent(slug)}`,
    artifactRef: { skill_slug: slug },
  };
}

async function materializeSchedule(
  input: MaterializeAuthoringArtifactInput
): Promise<MaterializeAuthoringArtifactResult> {
  const tz = input.timezone?.trim() || "America/Mexico_City";
  const schedule = parseRecurringSchedule(input.description);
  if ("question" in schedule) {
    return {
      kind: "clarify",
      artifactRef: {},
      clarifyingQuestions: [schedule.question],
    };
  }
  const cronExpr = schedule.cronExpr;
  let nextRunAt: string;
  try {
    const cron = new Cron(cronExpr, { timezone: tz });
    const next = cron.nextRun();
    if (!next) throw new Error("sin próxima ejecución");
    nextRunAt = next.toISOString();
  } catch {
    return {
      kind: "schedule",
      artifactRef: {},
      error: "No se pudo calcular la próxima ejecución de la recurrencia.",
    };
  }

  const title =
    input.title?.trim() ||
    suggestEnglishSlug(input.description).replace(/_/g, " ");
  // Un schedule programa un artefacto subyacente; no es el procedimiento.
  const durable = await materializeDurableTask(input, "draft");
  if (durable.kind === "clarify") {
    return {
      kind: "clarify",
      artifactRef: durable.artifactRef,
      clarifyingQuestions: durable.clarifyingQuestions,
    };
  }
  if (durable.error) {
    return {
      kind: "schedule",
      artifactRef: durable.artifactRef,
      error: durable.error,
    };
  }
  const durableTaskId = String(durable.artifactRef.durable_task_id ?? "");
  const task = await createScheduledTask(input.db, {
    userId: input.userId,
    prompt: input.description,
    userRequest: input.description,
    displayTitle: title,
    scheduleType: "recurring",
    cronExpr,
    timezone: tz,
    nextRunAt,
    durableTaskId,
  });
  const durableTask = await updateDurableTask(input.db, {
    userId: input.userId,
    taskId: durableTaskId,
    expectedVersion: 1,
    status: "active",
    scheduleRef: task.id,
  });
  if (!durableTask) {
    return {
      kind: "schedule",
      artifactRef: { scheduled_task_id: task.id, durable_task_id: durableTaskId },
      error: "Se creó la programación, pero no se pudo enlazar la tarea durable.",
    };
  }

  return {
    kind: "schedule",
    redirectPath: `/operations/workflows/design?durable_task=${durableTaskId}`,
    artifactRef: {
      scheduled_task_id: task.id,
      durable_task_id: durableTaskId,
    },
  };
}

export async function materializeAuthoringArtifact(
  input: MaterializeAuthoringArtifactInput
): Promise<MaterializeAuthoringArtifactResult> {
  if (
    input.patternComposition &&
    (input.patternComposition.issues.length > 0 ||
      (isMaterializablePatternWorkForm(input.kind) &&
        input.patternComposition.workForm !== input.kind))
  ) {
    return {
      kind: input.kind,
      artifactRef: {},
      error: `Composición de patrones inválida: ${[
        ...input.patternComposition.issues,
        input.patternComposition.workForm !== input.kind
          ? `work_form_mismatch:${input.patternComposition.workForm}:${input.kind}`
          : "",
      ]
        .filter(Boolean)
        .join("; ")}`,
    };
  }
  switch (input.kind) {
    case "clarify":
      return { kind: "clarify", artifactRef: {} };
    case "redirect_to_chat":
      return {
        kind: "redirect_to_chat",
        redirectPath: "/chat",
        artifactRef: {},
      };
    case "case_workflow":
      return materializeCaseWorkflow(input);
    case "durable_task":
      return materializeDurableTask(input);
    case "reusable_skill":
      return materializeReusableSkill(input);
    case "schedule":
      return materializeSchedule(input);
    default: {
      const _exhaustive: never = input.kind;
      return {
        kind: "clarify",
        artifactRef: {},
        error: `Tipo de autoría no soportado: ${String(_exhaustive)}`,
      };
    }
  }
}

function isMaterializablePatternWorkForm(
  kind: AuthoringRouterKind
): kind is SolutionPatternComposition["workForm"] {
  return (
    kind === "case_workflow" ||
    kind === "durable_task" ||
    kind === "reusable_skill" ||
    kind === "schedule"
  );
}
