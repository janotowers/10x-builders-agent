/**
 * Queries de studio_authoring_sessions (Phase 5 / Slice 5.3 seam).
 *
 * Persiste el estado del router NL→artefacto. Toda query exige `userId`
 * (regla 3). Consumida por el router/materializador del Studio.
 */
import type { DbClient } from "../client";
import type {
  StudioAuthoringSession,
  StudioAuthoringSessionStatus,
} from "@agents/types";

export interface CreateStudioAuthoringSessionInput {
  userId: string;
  descriptionNl: string;
  title?: string | null;
  suggestedSlug?: string | null;
  status?: StudioAuthoringSessionStatus;
  routerKind?: string | null;
  routerOutput?: Record<string, unknown>;
  modelId?: string | null;
  provenance?: Record<string, unknown>;
}

export async function createStudioAuthoringSession(
  db: DbClient,
  input: CreateStudioAuthoringSessionInput
): Promise<StudioAuthoringSession> {
  const { data, error } = await db
    .from("studio_authoring_sessions")
    .insert({
      user_id: input.userId,
      description_nl: input.descriptionNl,
      title: input.title ?? null,
      suggested_slug: input.suggestedSlug ?? null,
      status: input.status ?? "active",
      router_kind: input.routerKind ?? null,
      router_output_jsonb: input.routerOutput ?? {},
      model_id: input.modelId ?? null,
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as StudioAuthoringSession;
}

export async function getStudioAuthoringSession(
  db: DbClient,
  userId: string,
  sessionId: string
): Promise<StudioAuthoringSession | null> {
  const { data, error } = await db
    .from("studio_authoring_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return (data as StudioAuthoringSession | null) ?? null;
}

export interface UpdateStudioAuthoringSessionInput {
  userId: string;
  sessionId: string;
  status?: StudioAuthoringSessionStatus;
  title?: string | null;
  suggestedSlug?: string | null;
  routerKind?: string | null;
  routerOutput?: Record<string, unknown>;
  clarificationRound?: number;
  messages?: unknown[];
  progress?: unknown[];
  artifactKind?: string | null;
  artifactRef?: Record<string, unknown>;
  modelId?: string | null;
  provenance?: Record<string, unknown>;
  descriptionNl?: string;
  expectedUpdatedAt?: string;
}

export async function updateStudioAuthoringSession(
  db: DbClient,
  input: UpdateStudioAuthoringSessionInput
): Promise<StudioAuthoringSession | null> {
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.title !== undefined) patch.title = input.title;
  if (input.suggestedSlug !== undefined) {
    patch.suggested_slug = input.suggestedSlug;
  }
  if (input.routerKind !== undefined) patch.router_kind = input.routerKind;
  if (input.routerOutput !== undefined) {
    patch.router_output_jsonb = input.routerOutput;
  }
  if (input.clarificationRound !== undefined) {
    patch.clarification_round = input.clarificationRound;
  }
  if (input.messages !== undefined) patch.messages_jsonb = input.messages;
  if (input.progress !== undefined) patch.progress_jsonb = input.progress;
  if (input.artifactKind !== undefined) {
    patch.artifact_kind = input.artifactKind;
  }
  if (input.artifactRef !== undefined) {
    patch.artifact_ref = input.artifactRef;
  }
  if (input.modelId !== undefined) patch.model_id = input.modelId;
  if (input.provenance !== undefined) {
    patch.provenance_jsonb = input.provenance;
  }
  if (input.descriptionNl !== undefined) {
    patch.description_nl = input.descriptionNl;
  }
  if (Object.keys(patch).length === 0) {
    return getStudioAuthoringSession(db, input.userId, input.sessionId);
  }

  let query = db
    .from("studio_authoring_sessions")
    .update(patch)
    .eq("user_id", input.userId)
    .eq("id", input.sessionId);
  if (input.expectedUpdatedAt) {
    query = query.eq("updated_at", input.expectedUpdatedAt);
  }
  const { data, error } = await query.select("*");
  if (error) throw error;
  const rows = (data ?? []) as StudioAuthoringSession[];
  return rows[0] ?? null;
}

/**
 * Claim atómico previo a materializar. Dos confirmaciones concurrentes no
 * pueden pasar de active → materializing para la misma sesión.
 */
export async function claimStudioAuthoringSessionForMaterialization(
  db: DbClient,
  params: { userId: string; sessionId: string; expectedUpdatedAt?: string }
): Promise<StudioAuthoringSession | null> {
  let query = db
    .from("studio_authoring_sessions")
    .update({ status: "materializing" })
    .eq("user_id", params.userId)
    .eq("id", params.sessionId)
    .eq("status", "active");
  if (params.expectedUpdatedAt) {
    query = query.eq("updated_at", params.expectedUpdatedAt);
  }
  const { data, error } = await query.select("*");
  if (error) throw error;
  const rows = (data ?? []) as StudioAuthoringSession[];
  return rows[0] ?? null;
}

/** Append a message entry to messages_jsonb (read-modify-write). */
export async function appendStudioAuthoringSessionMessage(
  db: DbClient,
  params: {
    userId: string;
    sessionId: string;
    message: Record<string, unknown>;
  }
): Promise<StudioAuthoringSession> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await getStudioAuthoringSession(
      db,
      params.userId,
      params.sessionId
    );
    if (!session) {
      throw new Error(
        `studio_authoring_sessions not found: ${params.sessionId}`
      );
    }
    const messages = [...(session.messages_jsonb ?? []), params.message];
    const updated = await updateStudioAuthoringSession(db, {
      userId: params.userId,
      sessionId: params.sessionId,
      messages,
      expectedUpdatedAt: session.updated_at,
    });
    if (updated) return updated;
  }
  throw new Error(
    `studio_authoring_sessions message append conflicted: ${params.sessionId}`
  );
}

/** Append a progress entry to progress_jsonb (read-modify-write). */
export async function appendStudioAuthoringSessionProgress(
  db: DbClient,
  params: {
    userId: string;
    sessionId: string;
    entry: Record<string, unknown>;
  }
): Promise<StudioAuthoringSession> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await getStudioAuthoringSession(
      db,
      params.userId,
      params.sessionId
    );
    if (!session) {
      throw new Error(
        `studio_authoring_sessions not found: ${params.sessionId}`
      );
    }
    const progress = [...(session.progress_jsonb ?? []), params.entry];
    const updated = await updateStudioAuthoringSession(db, {
      userId: params.userId,
      sessionId: params.sessionId,
      progress,
      expectedUpdatedAt: session.updated_at,
    });
    if (updated) return updated;
  }
  throw new Error(
    `studio_authoring_sessions progress append conflicted: ${params.sessionId}`
  );
}
