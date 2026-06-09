import type { DbClient } from "../client";
import type {
  OperationalCaseE2ELabSession,
  OperationalCaseE2ELabSessionStatus,
} from "@agents/types";

export const E2E_LAB_SESSION_DURATION_MS = 2 * 60 * 60 * 1000;

export function e2eLabSessionExpiresAt(
  startedAt: Date,
  durationMs = E2E_LAB_SESSION_DURATION_MS
): string {
  return new Date(startedAt.getTime() + durationMs).toISOString();
}

export function isE2ELabSessionUsable(
  session: Pick<OperationalCaseE2ELabSession, "status" | "expires_at"> | null,
  now = new Date()
): boolean {
  return (
    session?.status === "active" &&
    new Date(session.expires_at).getTime() > now.getTime()
  );
}

export function shouldCreateControlledE2ECase(
  session: Pick<OperationalCaseE2ELabSession, "status" | "expires_at"> | null,
  now = new Date()
): boolean {
  return isE2ELabSessionUsable(session, now);
}

export async function expireE2ELabSessions(
  db: DbClient,
  params?: { userId?: string; caseType?: string }
): Promise<number> {
  const now = new Date().toISOString();
  let query = db
    .from("operational_case_e2e_lab_sessions")
    .update({
      status: "expired",
      updated_at: now,
    })
    .eq("status", "active")
    .lt("expires_at", now);
  if (params?.userId) query = query.eq("user_id", params.userId);
  if (params?.caseType) query = query.eq("case_type", params.caseType);
  const { data, error } = await query.select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function getActiveE2ELabSession(
  db: DbClient,
  params: { userId: string; caseType: string }
): Promise<OperationalCaseE2ELabSession | null> {
  await expireE2ELabSessions(db, params);
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("operational_case_e2e_lab_sessions")
    .select("*")
    .eq("user_id", params.userId)
    .eq("case_type", params.caseType)
    .eq("status", "active")
    .gt("expires_at", now)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseE2ELabSession | null) ?? null;
}

export async function activateE2ELabSession(
  db: DbClient,
  params: {
    userId: string;
    caseType: string;
    caseId?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number;
  }
): Promise<OperationalCaseE2ELabSession> {
  await expireE2ELabSessions(db, {
    userId: params.userId,
    caseType: params.caseType,
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = e2eLabSessionExpiresAt(now, params.durationMs);

  const { data: existing, error: existingError } = await db
    .from("operational_case_e2e_lab_sessions")
    .select("*")
    .eq("user_id", params.userId)
    .eq("case_type", params.caseType)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;

  const payload = {
    user_id: params.userId,
    case_type: params.caseType,
    case_id: params.caseId ?? null,
    status: "active" as OperationalCaseE2ELabSessionStatus,
    metadata_jsonb: params.metadata ?? {},
    started_at: nowIso,
    expires_at: expiresAt,
    updated_at: nowIso,
  };

  if (existing) {
    const { data, error } = await db
      .from("operational_case_e2e_lab_sessions")
      .update(payload)
      .eq("id", (existing as OperationalCaseE2ELabSession).id)
      .select("*")
      .single();
    if (error) throw error;
    return data as OperationalCaseE2ELabSession;
  }

  const { data, error } = await db
    .from("operational_case_e2e_lab_sessions")
    .insert({
      ...payload,
      created_at: nowIso,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseE2ELabSession;
}

export async function setE2ELabSessionStatus(
  db: DbClient,
  params: {
    sessionId: string;
    status: OperationalCaseE2ELabSessionStatus;
    metadataMerge?: Record<string, unknown>;
  }
): Promise<OperationalCaseE2ELabSession | null> {
  const patch: Record<string, unknown> = {
    status: params.status,
    updated_at: new Date().toISOString(),
  };
  if (params.metadataMerge) {
    const { data: current, error: currentError } = await db
      .from("operational_case_e2e_lab_sessions")
      .select("metadata_jsonb")
      .eq("id", params.sessionId)
      .maybeSingle();
    if (currentError) throw currentError;
    patch.metadata_jsonb = {
      ...((current?.metadata_jsonb as Record<string, unknown>) ?? {}),
      ...params.metadataMerge,
    };
  }
  const { data, error } = await db
    .from("operational_case_e2e_lab_sessions")
    .update(patch)
    .eq("id", params.sessionId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseE2ELabSession | null) ?? null;
}

export async function cancelE2ELabSession(
  db: DbClient,
  params: { userId: string; caseType: string }
): Promise<OperationalCaseE2ELabSession | null> {
  const active = await getActiveE2ELabSession(db, params);
  if (!active) return null;
  return setE2ELabSessionStatus(db, {
    sessionId: active.id,
    status: "cancelled",
    metadataMerge: {
      cancelled_at: new Date().toISOString(),
    },
  });
}

export async function linkE2ELabSessionToCase(
  db: DbClient,
  params: { sessionId: string; caseId: string }
): Promise<OperationalCaseE2ELabSession | null> {
  const { data, error } = await db
    .from("operational_case_e2e_lab_sessions")
    .update({
      case_id: params.caseId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.sessionId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseE2ELabSession | null) ?? null;
}
