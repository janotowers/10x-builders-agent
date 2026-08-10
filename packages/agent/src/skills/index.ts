/**
 * Public surface of the skills module.
 *
 * V1-A delivered the registry plumbing (parse, resolve, load). V1-B added
 * the pre-graph selector (`selectSkillForTurn`) and the runAgent runtime
 * helpers (`getGlobalSkillRegistry`, `buildPlaybookInjection`).
 */
export type {
  SkillMetadata,
  SkillRecord,
  SkillRegistry,
  ResolvedSkill,
  SkillScope,
  HeartbeatSkillMode,
  HeartbeatSkillSignal,
  HeartbeatSignalKind,
} from "./types";

export {
  parseSkillFile,
  parseSkillSource,
  parseAccountSkillSource,
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

export {
  selectSkillForTurn,
  parseSelectorJson,
  NO_SKILL_ID,
  type SkillSelection,
  type SelectionNoneReason,
  type SelectorChatModel,
  type SelectSkillInput,
} from "./select";

export {
  getGlobalSkillRegistry,
  getSkillRegistryForUser,
  resetGlobalSkillRegistryForTests,
  getCachedSkillsRegistryRoot,
  buildPlaybookInjection,
  defaultSkillsRoot,
  overlaySkillRegistryForTurn,
  SkillUnderTestValidationError,
  validateSkillUnderTestInput,
  type GetSkillRegistryOptions,
  type SkillUnderTestInput,
} from "./runtime";

export {
  summarizeSkillQualificationEvidence,
  type SkillQualificationOutputLike,
  type SkillQualificationSummary,
} from "./qualification-summary";
