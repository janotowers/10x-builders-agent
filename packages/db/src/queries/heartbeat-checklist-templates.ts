import type { DbClient } from "../client";
import type { HeartbeatChecklistTemplateRow } from "@agents/types";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalize(row: Record<string, unknown>): HeartbeatChecklistTemplateRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    markdown: String(row.markdown ?? ""),
    status: row.status === "draft" ? "draft" : "validated",
    validation_warnings: stringArray(row.validation_warnings),
    detected_skills: stringArray(row.detected_skills),
    source_template_id:
      typeof row.source_template_id === "string" ? row.source_template_id : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export async function listHeartbeatChecklistTemplates(
  db: DbClient,
  userId: string
): Promise<HeartbeatChecklistTemplateRow[]> {
  const { data, error } = await db
    .from("heartbeat_checklist_templates")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(normalize);
}

export async function createHeartbeatChecklistTemplate(
  db: DbClient,
  params: {
    userId: string;
    name: string;
    description?: string;
    markdown: string;
    status: "draft" | "validated";
    validationWarnings: string[];
    detectedSkills: string[];
    sourceTemplateId?: string | null;
  }
): Promise<HeartbeatChecklistTemplateRow> {
  const { data, error } = await db
    .from("heartbeat_checklist_templates")
    .insert({
      user_id: params.userId,
      name: params.name,
      description: params.description ?? "",
      markdown: params.markdown,
      status: params.status,
      validation_warnings: params.validationWarnings,
      detected_skills: params.detectedSkills,
      source_template_id: params.sourceTemplateId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return normalize(data as Record<string, unknown>);
}

export async function deleteHeartbeatChecklistTemplate(
  db: DbClient,
  params: { userId: string; templateId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from("heartbeat_checklist_templates")
    .delete()
    .eq("id", params.templateId)
    .eq("user_id", params.userId)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

