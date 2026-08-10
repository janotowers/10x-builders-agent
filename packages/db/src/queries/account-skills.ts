/**
 * Queries para account_skills (V1 Opción B).
 * Ver docs/operational-cases/architecture.md sección 9 y la migración
 * 00020_account_skills.sql.
 */
import type { DbClient } from "../client";
import type {
  AccountSkill,
  AccountSkillMetadata,
  AccountSkillStatus,
} from "@agents/types";

export async function listAccountSkillsForUser(
  db: DbClient,
  userId: string,
  opts: { statuses?: AccountSkillStatus[] } = {}
): Promise<AccountSkill[]> {
  const statuses = opts.statuses ?? ["draft", "active"];
  const { data, error } = await db
    .from("account_skills")
    .select("*")
    .eq("user_id", userId)
    .in("status", statuses)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AccountSkill[];
}

/**
 * Devuelve solo las account_skills activas de un usuario. Esta es la query
 * que usa el runtime del agente cada vez que necesita componer el registry.
 */
export async function listActiveAccountSkillsForUser(
  db: DbClient,
  userId: string
): Promise<AccountSkill[]> {
  return listAccountSkillsForUser(db, userId, { statuses: ["active"] });
}

export async function getAccountSkill(
  db: DbClient,
  userId: string,
  slug: string
): Promise<AccountSkill | null> {
  const { data, error } = await db
    .from("account_skills")
    .select("*")
    .eq("user_id", userId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountSkill | null) ?? null;
}

export async function getAccountSkillById(
  db: DbClient,
  userId: string,
  skillId: string
): Promise<AccountSkill | null> {
  const { data, error } = await db
    .from("account_skills")
    .select("*")
    .eq("user_id", userId)
    .eq("id", skillId)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountSkill | null) ?? null;
}

export interface UpsertAccountSkillInput {
  userId: string;
  slug: string;
  bodyMd: string;
  metadata: AccountSkillMetadata;
  status?: AccountSkillStatus;
}

export async function upsertAccountSkill(
  db: DbClient,
  input: UpsertAccountSkillInput
): Promise<AccountSkill> {
  const existing = await getAccountSkill(db, input.userId, input.slug);
  const now = new Date().toISOString();
  if (existing) {
    const { data, error } = await db
      .from("account_skills")
      .update({
        body_md: input.bodyMd,
        metadata_jsonb: input.metadata,
        status: input.status ?? existing.status,
        version: existing.version + 1,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data as AccountSkill;
  }
  const { data, error } = await db
    .from("account_skills")
    .insert({
      user_id: input.userId,
      slug: input.slug,
      body_md: input.bodyMd,
      metadata_jsonb: input.metadata,
      status: input.status ?? "draft",
      version: 1,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as AccountSkill;
}

export async function deleteAccountSkill(
  db: DbClient,
  userId: string,
  slug: string
): Promise<void> {
  const { error } = await db
    .from("account_skills")
    .delete()
    .eq("user_id", userId)
    .eq("slug", slug);
  if (error) throw error;
}
