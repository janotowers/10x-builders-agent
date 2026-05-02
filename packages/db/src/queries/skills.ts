import type { DbClient } from "../client";
import type { UserSkillSetting } from "@agents/types";

export async function getUserSkillSettings(db: DbClient, userId: string) {
  const { data, error } = await db
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as UserSkillSetting[];
}

export async function upsertSkillSetting(
  db: DbClient,
  userId: string,
  skillId: string,
  enabled: boolean,
  configJson: Record<string, unknown> = {}
) {
  const { data, error } = await db
    .from("user_skill_settings")
    .upsert(
      { user_id: userId, skill_id: skillId, enabled, config_json: configJson },
      { onConflict: "user_id,skill_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as UserSkillSetting;
}
