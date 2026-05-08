import { TOOL_CATALOG } from "../tools/catalog";
import type { ResolvedSkill, SkillRegistry } from "../skills/types";
import { resolveSkill } from "../skills/resolve";
import type { UserSkillSetting } from "@agents/types";
import type { HeartbeatChecklistItem } from "./checklist";

const HEARTBEAT_SAFE_TOOLS = new Set([
  "get_user_preferences",
  "list_enabled_tools",
  "manage_scheduled_tasks",
  "read_skill_reference",
  "list_user_memories",
  "search_user_memories",
  "github_list_repos",
  "github_list_issues",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_list_tasks",
  "read_file",
]);

const HEARTBEAT_TENANT_SKILL_TOOLS = new Set([
  ...HEARTBEAT_SAFE_TOOLS,
  "bigquery_run_query",
]);

export type HeartbeatSkillSelectionStatus = "selected" | "none" | "blocked";

export interface HeartbeatSkillSelectionItem {
  item: HeartbeatChecklistItem;
  status: HeartbeatSkillSelectionStatus;
  skillIds: string[];
  blockedSkillIds: string[];
  reason?: string;
}

export interface HeartbeatSkillSelectionResult {
  selections: HeartbeatSkillSelectionItem[];
  skills: ResolvedSkill[];
  blockedSkillIds: string[];
}

function disabledSkillSet(settings?: readonly UserSkillSetting[]): Set<string> {
  if (!settings || settings.length === 0) return new Set();
  return new Set(
    settings.filter((setting) => setting.enabled === false).map((setting) => setting.skill_id)
  );
}

export function isHeartbeatSafeResolvedSkill(skill: ResolvedSkill): boolean {
  if (skill.heartbeatMode === "blocked") return false;
  const allowed = skill.requiresTenantContext
    ? HEARTBEAT_TENANT_SKILL_TOOLS
    : HEARTBEAT_SAFE_TOOLS;
  return skill.allowedTools.every((toolId) => {
    if (!allowed.has(toolId)) return false;
    const risk = TOOL_CATALOG.find((tool) => tool.id === toolId)?.risk ?? "high";
    return risk === "low";
  });
}

export async function selectHeartbeatSkillsForChecklist(args: {
  registry: SkillRegistry;
  items: readonly HeartbeatChecklistItem[];
  enabledSkills?: readonly UserSkillSetting[];
}): Promise<HeartbeatSkillSelectionResult> {
  const disabled = disabledSkillSet(args.enabledSkills);
  const resolvedById = new Map<string, ResolvedSkill>();
  const blocked = new Set<string>();
  const selections: HeartbeatSkillSelectionItem[] = [];

  for (const item of args.items) {
    const selectedIds: string[] = [];
    const blockedIds: string[] = [];
    for (const skillId of item.candidateSkills) {
      if (!args.registry.has(skillId)) continue;
      if (disabled.has(skillId)) {
        blockedIds.push(skillId);
        blocked.add(skillId);
        continue;
      }
      try {
        const resolved = await resolveSkill(skillId, args.registry);
        if (!isHeartbeatSafeResolvedSkill(resolved)) {
          blockedIds.push(skillId);
          blocked.add(skillId);
          continue;
        }
        selectedIds.push(skillId);
        resolvedById.set(skillId, resolved);
      } catch {
        blockedIds.push(skillId);
        blocked.add(skillId);
      }
    }
    selections.push({
      item,
      status:
        selectedIds.length > 0
          ? "selected"
          : blockedIds.length > 0
            ? "blocked"
            : "none",
      skillIds: selectedIds,
      blockedSkillIds: blockedIds,
      reason:
        selectedIds.length > 0
          ? undefined
          : blockedIds.length > 0
            ? "candidate skills were disabled, missing, or not heartbeat-safe"
            : "no matching heartbeat-safe candidate skill",
    });
  }

  return {
    selections,
    skills: [...resolvedById.values()],
    blockedSkillIds: [...blocked],
  };
}

export function formatHeartbeatSkillSelectionBlock(
  result: HeartbeatSkillSelectionResult
): string {
  if (result.selections.length === 0) return "";
  const lines = [
    "[HEARTBEAT CHECKLIST ITEMS — evaluated independently]",
    "Use the selected skills as operational playbooks for their matching items. Prefer heartbeat-native skills. If an item is blocked or has no skill, evaluate it conservatively with the allowed read-only tools only.",
    "No-signal contract: if no item crosses its threshold, return only a compact OK/no-action message. Do not include empty agenda, blocker, status, evidence, event, lead, or task sections.",
    "Do not list observed data unless it crossed a threshold and creates a concrete action for the user.",
  ];
  for (const selection of result.selections) {
    const skillText =
      selection.skillIds.length > 0
        ? `skills=${selection.skillIds
            .map((skillId) => {
              const mode =
                result.skills.find((skill) => skill.rootName === skillId)
                  ?.heartbeatMode ?? "compatible";
              return `${skillId}:${mode}`;
            })
            .join(", ")}`
        : selection.status === "blocked"
          ? `blocked_skills=${selection.blockedSkillIds.join(", ")}`
          : "skills=none";
    lines.push(
      `- ${selection.item.id}: ${selection.item.intent} | threshold=${selection.item.threshold} | notify_when=${selection.item.notifyWhen} | sources=${selection.item.sources.join(", ") || "unspecified"} | ${skillText}`
    );
  }
  return lines.join("\n");
}
