/**
 * Public surface of the skills module (V1-A).
 *
 * V1-B will plug `selectSkillForTurn` and `resolveSkill` into `runAgent`
 * to inject the playbook into the system prompt and intersect tools at
 * `buildLangChainTools` time. Until then, this module is plumbing only:
 * loading SKILL.md files, validating frontmatter, and resolving composites.
 */
export type {
  SkillMetadata,
  SkillRecord,
  SkillRegistry,
  ResolvedSkill,
  SkillScope,
} from "./types";

export {
  parseSkillFile,
  parseSkillSource,
  SkillParseError,
  estimateTokens,
  MAX_SKILL_BODY_TOKENS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
} from "./parse";

export {
  loadGlobalSkillRegistry,
  buildRegistryFromRecords,
  type LoadRegistryOptions,
} from "./registry";

export { resolveSkill, SkillResolveError } from "./resolve";

export { FrontmatterError } from "./frontmatter";
