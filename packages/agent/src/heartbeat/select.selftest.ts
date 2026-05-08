import assert from "node:assert/strict";
import type { UserSkillSetting } from "@agents/types";
import { parseSkillSource } from "../skills/parse";
import { buildRegistryFromRecords } from "../skills/registry";
import { selectHeartbeatSkillsForChecklist } from "./select";
import type { HeartbeatChecklistItem } from "./checklist";

function makeSkill(slug: string) {
  return parseSkillSource(
    [
      "---",
      `name: ${slug}`,
      `description: Test skill ${slug} for heartbeat selection.`,
      "scope: shared",
      "allowed_tools:",
      "  - calendar_list_events",
      "  - calendar_list_tasks",
      "includes: []",
      "requires_tenant_context: false",
      "memory_extraction: ephemeral",
      "heartbeat: native",
      "---",
      "",
      `# ${slug}`,
      "",
    ].join("\n"),
    `/repo/skills/global/${slug}/SKILL.md`
  );
}

function setting(skillId: string, enabled: boolean): UserSkillSetting {
  return {
    id: `${skillId}-setting`,
    user_id: "user-1",
    skill_id: skillId,
    enabled,
    config_json: {},
  };
}

const calendarItem: HeartbeatChecklistItem = {
  id: "calendar-prep",
  text: "Detectar reuniones próximas",
  intent: "Detectar reuniones próximas",
  threshold: "Evento dentro de 60 minutos",
  notifyWhen: "Hay una reunión próxima",
  candidateSkills: ["meeting-readiness-watch"],
  sources: ["calendar"],
};

async function testMissingSettingKeepsSkillEnabled(): Promise<void> {
  const registry = buildRegistryFromRecords([makeSkill("meeting-readiness-watch")]);
  const result = await selectHeartbeatSkillsForChecklist({
    registry,
    items: [calendarItem],
    enabledSkills: [setting("pending-approval-watch", true)],
  });

  assert.deepEqual(result.selections[0]?.skillIds, ["meeting-readiness-watch"]);
  assert.deepEqual(result.blockedSkillIds, []);
}

async function testExplicitDisabledSettingBlocksSkill(): Promise<void> {
  const registry = buildRegistryFromRecords([makeSkill("meeting-readiness-watch")]);
  const result = await selectHeartbeatSkillsForChecklist({
    registry,
    items: [calendarItem],
    enabledSkills: [setting("meeting-readiness-watch", false)],
  });

  assert.deepEqual(result.selections[0]?.skillIds, []);
  assert.deepEqual(result.selections[0]?.blockedSkillIds, [
    "meeting-readiness-watch",
  ]);
}

async function main(): Promise<void> {
  await testMissingSettingKeepsSkillEnabled();
  await testExplicitDisabledSettingBlocksSkill();
  console.log("heartbeat select selftests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
