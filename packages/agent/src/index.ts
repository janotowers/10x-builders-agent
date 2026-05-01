export { runAgent } from "./graph";
export { TOOL_CATALOG } from "./tools/catalog";
export { githubApi } from "./tools/github-api";
export type { AgentInput, AgentOutput } from "./graph";
export {
  calendarFreeBusyQuery,
  buildEventResource,
  executeCalendarCreateEvent,
  executeCalendarPatchEvent,
  executeCalendarDeleteEvent,
} from "./tools/calendar-api";
export { flushSessionMemory } from "./memory_flush";
export type {
  FlushInput,
  FlushResult,
  FlushReason,
} from "./memory_flush";
export { generateEmbedding, cosineSimilarity } from "./embeddings";
export { logMemoryTrigger } from "./nodes/memory_log";
export type { TriggerLogInput } from "./nodes/memory_log";
export {
  writeTurnSummary,
  createTurnCollector,
  approxTokensFromChars,
} from "./turn_log";
export type { TurnSummaryInput } from "./turn_log";

// Skills (V1-A registry + V1-B selector/runtime). The registry surface is
// consumed by tests; the runtime surface is what `runAgent` uses internally
// and what V1-E will reuse for the Settings UI ("toggle skills").
export {
  parseSkillFile,
  parseSkillSource,
  SkillParseError,
  estimateTokens as estimateSkillBodyTokens,
  MAX_SKILL_BODY_TOKENS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  loadGlobalSkillRegistry,
  buildRegistryFromRecords,
  resolveSkill,
  SkillResolveError,
  FrontmatterError,
  selectSkillForTurn,
  parseSelectorJson,
  NO_SKILL_ID,
  getGlobalSkillRegistry,
  resetGlobalSkillRegistryForTests,
  buildPlaybookInjection,
  defaultSkillsRoot,
} from "./skills";
export type {
  SkillMetadata,
  SkillRecord,
  SkillRegistry,
  ResolvedSkill,
  SkillScope,
  LoadRegistryOptions,
  SkillSelection,
  SelectionNoneReason,
  SelectorChatModel,
  SelectSkillInput,
  GetSkillRegistryOptions,
} from "./skills";

export {
  readSkillReference,
  MAX_REFERENCE_BYTES,
} from "./tools/skill-references";
export type {
  ReadSkillReferenceArgs,
  ReadSkillReferenceResult,
} from "./tools/skill-references";

// Business Brain — V1-C-α: tenant context block injection.
export {
  buildTenantContextBlock,
  appendTenantContextBlock,
} from "./business-brain/tenant-context";
export type {
  BuildTenantContextArgs,
  TenantContextMode,
  TenantContextResult,
} from "./business-brain/tenant-context";
