"use server";

/**
 * Server actions del Workflow Studio (Slice 4.2-4).
 *
 * Reglas de gobernanza (§10.5 / §15):
 *   - Compilar crea un DRAFT; jamás publica.
 *   - Validar corre los gates §5.4 + simulación y REGISTRA EVIDENCIA por gate
 *     contra el definition_hash; si todo pasa, draft → validated.
 *   - Publicar es un acto humano: re-corre los gates en la misma llamada
 *     (nunca confía en un resultado anterior), registra evidencia y solo
 *     entonces hace el flip a published.
 *   - Fork solo desde definiciones publicadas (query lo exige).
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  countPinnedActiveCasesByDefinition,
  createServerClient,
  deleteDraftDefinition,
  forkDefinition,
  getWorkflowDefinitionById,
  insertDraftDefinition,
  listWorkflowDefinitionsVisibleToUser,
  markDefinitionValidated,
  publishDefinition,
} from "@agents/db";
import {
  runWithAiUsageContext,
  WORKFLOW_COMPILER_MODEL_ID,
  TOOL_CATALOG,
} from "@agents/agent";
import { computeDefinitionHash } from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import {
  buildCapabilityCatalogsForUser,
  recordDefinitionValidationEvidence,
  validateDefinitionForUser,
} from "@/lib/workflow-studio/definition-validation";
import { compileWorkflowDescription } from "@/lib/workflow-studio/compile-definition";
import { findIdenticalOwnFork } from "@/lib/workflow-studio/definition-catalog";

const CATALOG_PATH = "/operations/workflows";
const DESIGN_PATH = "/operations/workflows/design";
/** §14: máximo 3 rondas de aclaración antes de pedir reformular. */
const MAX_CLARIFICATION_ROUNDS = 3;

async function requireUser() {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");
  return user;
}

/** Carga una definición verificando que pertenece al usuario. */
async function loadOwnDefinition(userId: string, definitionId: string) {
  const db = createServerClient();
  const definition = await getWorkflowDefinitionById(db, definitionId);
  if (!definition || definition.user_id !== userId) return null;
  return definition;
}

// ─── Compilar (NL → draft) ──────────────────────────────────────────────────

export interface CompileFormState {
  status: "idle" | "clarification" | "error";
  questions?: string[];
  error?: string;
  round: number;
  description: string;
  caseType: string;
  answers: string[];
}

export async function compileDescriptionAction(
  prevState: CompileFormState,
  formData: FormData
): Promise<CompileFormState> {
  const user = await requireUser();
  const description = String(formData.get("description") ?? "").trim();
  const caseType = String(formData.get("case_type") ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
  const newAnswer = String(formData.get("clarification_answer") ?? "").trim();
  const answers = [...prevState.answers, ...(newAnswer ? [newAnswer] : [])];
  const round = prevState.status === "clarification" ? prevState.round + 1 : 1;

  const base: CompileFormState = {
    status: "idle",
    round,
    description,
    caseType,
    answers,
  };
  if (!description) {
    return { ...base, status: "error", error: "Describe el flujo antes de compilar." };
  }
  if (!caseType) {
    return { ...base, status: "error", error: "Indica un tipo de caso (p. ej. property_optioning)." };
  }
  if (round > MAX_CLARIFICATION_ROUNDS) {
    return {
      ...base,
      status: "error",
      error:
        "Se alcanzó el límite de rondas de aclaración. Reformula la descripción incorporando las respuestas y vuelve a intentar.",
    };
  }

  const db = createServerClient();
  const catalogs = await buildCapabilityCatalogsForUser(db, user.id);
  const result = await runWithAiUsageContext(
    { userId: user.id, channel: "web" },
    db,
    () =>
      compileWorkflowDescription({
        description,
        caseType,
        clarificationAnswers: answers,
        availableGuards: [...catalogs.knownGuards],
        availableSkills: [...catalogs.skillSlugs],
        availableCapabilities: [...new Set(catalogs.workerCapabilities)],
        availableTools: TOOL_CATALOG.map((tool) => tool.id),
      })
  );

  if (result.kind === "error") {
    return { ...base, status: "error", error: result.message };
  }
  if (result.kind === "clarification") {
    return { ...base, status: "clarification", questions: result.questions };
  }

  // Versión siguiente para (usuario, case_type) — mismo criterio que fork.
  const visible = await listWorkflowDefinitionsVisibleToUser(db, user.id);
  const maxOwnVersion = visible
    .filter((d) => d.user_id === user.id && d.case_type === caseType)
    .reduce((max, d) => Math.max(max, d.version), 0);

  const draft = await insertDraftDefinition(db, {
    userId: user.id,
    caseType,
    version: maxOwnVersion + 1,
    graph: result.graph,
    definitionHash: computeDefinitionHash(result.graph),
    businessSpec: result.businessSpec,
    implementationSpec: result.implementationSpec,
    provenance: {
      compiler: {
        model: WORKFLOW_COMPILER_MODEL_ID,
        compiled_at: new Date().toISOString(),
        clarification_rounds: round - 1,
      },
    },
  });

  revalidatePath(DESIGN_PATH);
  redirect(`${DESIGN_PATH}?definition=${draft.id}`);
}

// ─── Fork ───────────────────────────────────────────────────────────────────

export async function forkDefinitionAction(formData: FormData) {
  const user = await requireUser();
  const definitionId = String(formData.get("definition_id") ?? "").trim();
  if (!definitionId) redirect(CATALOG_PATH);
  const db = createServerClient();
  // La visibilidad del catálogo ya garantiza que el id es global o propio;
  // re-verificamos igual para no forkear privadas ajenas por id arbitrario.
  const visible = await listWorkflowDefinitionsVisibleToUser(db, user.id);
  const source = visible.find((definition) => definition.id === definitionId);
  if (!source) redirect(CATALOG_PATH);

  // Anti-doble-fork: si ya hay un borrador/validado propio idéntico
  // (mismo origen + mismo hash), reutilizarlo en vez de crear otro.
  const own = visible.filter((definition) => definition.user_id === user.id);
  const existing = findIdenticalOwnFork(own, source);
  if (existing) {
    revalidatePath(DESIGN_PATH);
    redirect(`${DESIGN_PATH}?definition=${existing.id}&notice=existing_fork`);
  }

  const draft = await forkDefinition(db, user.id, definitionId);
  revalidatePath(DESIGN_PATH);
  revalidatePath(CATALOG_PATH);
  redirect(`${DESIGN_PATH}?definition=${draft.id}`);
}

// ─── Descartar borrador propio ──────────────────────────────────────────────

export async function discardDraftDefinitionAction(formData: FormData) {
  const user = await requireUser();
  const definitionId = String(formData.get("definition_id") ?? "").trim();
  if (!definitionId) redirect(CATALOG_PATH);

  const definition = await loadOwnDefinition(user.id, definitionId);
  if (!definition) redirect(CATALOG_PATH);
  if (definition.status !== "draft" && definition.status !== "validated") {
    redirect(`${CATALOG_PATH}?definition=${definition.id}&error=not_draft`);
  }

  const db = createServerClient();
  const pinnedCounts = await countPinnedActiveCasesByDefinition(db, user.id);
  if ((pinnedCounts[definition.id] ?? 0) > 0) {
    redirect(`${CATALOG_PATH}?definition=${definition.id}&error=pinned`);
  }

  await deleteDraftDefinition(db, {
    userId: user.id,
    definitionId: definition.id,
  });
  revalidatePath(CATALOG_PATH);
  revalidatePath(DESIGN_PATH);
  redirect(CATALOG_PATH);
}

// ─── Validar (gates + evidencia) ────────────────────────────────────────────

export async function validateDefinitionAction(formData: FormData) {
  const user = await requireUser();
  const definitionId = String(formData.get("definition_id") ?? "").trim();
  const definition = definitionId
    ? await loadOwnDefinition(user.id, definitionId)
    : null;
  if (!definition) redirect(DESIGN_PATH);
  if (definition.status !== "draft" && definition.status !== "validated") {
    redirect(`${DESIGN_PATH}?definition=${definition.id}`);
  }

  const db = createServerClient();
  const report = await validateDefinitionForUser(db, {
    userId: user.id,
    definition,
  });
  await recordDefinitionValidationEvidence(db, {
    userId: user.id,
    definition,
    gates: report.gates,
  });
  if (report.ok && definition.status === "draft") {
    await markDefinitionValidated(db, definition.id);
  }
  revalidatePath(DESIGN_PATH);
  redirect(`${DESIGN_PATH}?definition=${definition.id}`);
}

// ─── Publicar (acto humano, gates en la misma llamada) ─────────────────────

export async function publishDefinitionAction(formData: FormData) {
  const user = await requireUser();
  const definitionId = String(formData.get("definition_id") ?? "").trim();
  const definition = definitionId
    ? await loadOwnDefinition(user.id, definitionId)
    : null;
  if (!definition) redirect(DESIGN_PATH);
  if (definition.status !== "draft" && definition.status !== "validated") {
    redirect(`${DESIGN_PATH}?definition=${definition.id}`);
  }

  const db = createServerClient();
  const report = await validateDefinitionForUser(db, {
    userId: user.id,
    definition,
  });
  await recordDefinitionValidationEvidence(db, {
    userId: user.id,
    definition,
    gates: report.gates,
  });
  if (!report.ok) {
    redirect(`${DESIGN_PATH}?definition=${definition.id}&error=gates`);
  }
  await publishDefinition(db, definition.id, user.id);
  revalidatePath(DESIGN_PATH);
  revalidatePath("/operations/workflows");
  redirect(`/operations/workflows?definition=${definition.id}`);
}
