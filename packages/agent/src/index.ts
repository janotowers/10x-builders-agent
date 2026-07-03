export { runAgent } from "./graph";
export { isPropertyOptioningIntent } from "./skills/property-optioning-intent";
export {
  buildOperationalCaseIntakeUpdateContext,
  buildOperationalCaseCreateContext,
  buildPropertyDataMinimumsSummaryMessage,
  documentExtractionMinimumsContext,
  evaluatePropertyDataMinimumsForReview,
  evaluatePropertyAdvanceGate,
  ownerConsistencyStatusFromFields,
  titularidadOverrideApproved,
  runDocumentFieldExtraction,
  missingRequiredIntakeFields,
  operationalCaseIntakeSuccessStep,
} from "./tools/operational-cases-adapters";
export type {
  PropertyAdvanceTransition,
  PropertyAdvanceGateBlockReason,
  PropertyAdvanceRemediationOwner,
  PropertyAdvanceGateBlock,
  PropertyAdvanceGateResult,
  DocumentFieldExtractionResult,
} from "./tools/operational-cases-adapters";
export { TOOL_CATALOG } from "./tools/catalog";
export { githubApi } from "./tools/github-api";
export type { AgentInput, AgentOutput, AgentTurnEvent, AgentTurnEventType } from "./graph";
export {
  calendarFreeBusyQuery,
  calendarEventsPath,
  buildEventResource,
  executeCalendarCreateEvent,
  executeCalendarPatchEvent,
  executeCalendarDeleteEvent,
  googleCalendarJson,
} from "./tools/calendar-api";
export { eventDisplayFields } from "./tools/calendar-event-display";
export { flushSessionMemory } from "./memory_flush";
export {
  buildLangChainTools,
  normalizeToolApprovalPolicy,
  setBuildLangChainToolsDeps,
  getBuildLangChainToolsDeps,
  type BuildLangChainToolsDeps,
} from "./tools/adapters";
export type { ToolContext } from "./tools/tool-context";
export {
  normalizeTelegramSendText,
  telegramSendInputsMatch,
} from "@agents/types";
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
  parseAccountSkillSource,
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
  getSkillRegistryForUser,
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
  HeartbeatSkillMode,
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

export {
  COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS,
  deriveCommissionContractTemplateData,
  readablePropertyAddress,
} from "./tools/commission-contract-template-data";
export type { CommissionContractPlaceholderKey } from "./tools/commission-contract-template-data";
export { testAvaclickCredentials } from "./tools/avaclick";
export {
  buildComparableSearchFilters,
  sanitizeComparableSearchFilters,
  deriveComparableAreaBand,
  requiresAvaclick,
  classifyComparableSearchOutcome,
} from "./operational-cases/comparable-search-contract";
export type {
  ComparableSearchValidity,
  ComparableAreaBand,
  ComparableFilterContractResult,
} from "./operational-cases/comparable-search-contract";
export {
  buildComparablesAnalysisFromToolCalls,
  comparablesHasDefensibleSample,
  comparablesUniqueCount,
  comparablesUsableCount,
  MIN_DEFENSIBLE_UNIQUE_COMPARABLES,
  resolveSubjectAreaM2FromPropertyData,
  validateComparablesAnalysisArtifact,
} from "./operational-cases/comparables-analysis";
export type {
  ComparableSourceConflict,
  ComparablesAnalysisBuildOptions,
} from "./operational-cases/comparables-analysis";
export { buildPricingProposalFromComparables, formatPriceApprovalNotifyText } from "./operational-cases/pricing-proposal";
export {
  advanceComparablesToPriceProposalWithRetry,
  notifyPriceApprovalForCase,
  subjectAreaFromCaseContext,
  tryAdvanceComparablesAfterPersist,
} from "./operational-cases/comparables-advance";
export type {
  PricingProposal,
  PricingProposalPerSource,
} from "./operational-cases/pricing-proposal";

export {
  HEARTBEAT_CHECKLIST_TEMPLATES,
  extractReminderWindowMinutes,
  formatHeartbeatChecklist,
  generateHeartbeatChecklistProposal,
  getHeartbeatChecklistTemplate,
  normalizeHeartbeatChecklist,
  parseHeartbeatChecklist,
  validateHeartbeatChecklist,
  formatHeartbeatSkillSelectionBlock,
  isHeartbeatSafeResolvedSkill,
  selectHeartbeatSkillsForChecklist,
  runHeartbeatPrefetchers,
  calendarEventsPrefetcher,
  calendarTasksPrefetcher,
} from "./heartbeat";
export type {
  HeartbeatChecklistItem,
  HeartbeatChecklistSource,
  HeartbeatChecklistTemplate,
  HeartbeatSkillSelectionItem,
  HeartbeatSkillSelectionResult,
  HeartbeatSkillSelectionStatus,
  HeartbeatPrefetcher,
  HeartbeatPrefetchEnv,
  HeartbeatPrefetchInput,
  HeartbeatPrefetchOutput,
  HeartbeatPrefetchSignal,
  HeartbeatPrefetchRunResult,
} from "./heartbeat";

// Business Brain — V1-C-α: tenant context block injection.
export {
  buildTenantContextBlock,
  appendTenantContextBlock,
} from "./business-brain/tenant-context";
export {
  getBusinessBrainWarehouse,
  buildWarehouseCompatibilityPatch,
  truncateBusinessBrainText,
  BUSINESS_BRAIN_SLOT_DESCRIPTIONS,
  BUSINESS_BRAIN_TEXT_LIMITS,
} from "./business-brain/schema";
export {
  buildBusinessBrainContextBlock,
  appendBusinessBrainContextBlock,
} from "./business-brain/compiler";
export {
  reviewBusinessBrainSlot,
  reviewBusinessBrainFields,
  runDeterministicReview,
} from "./business-brain/reviewer";
export type {
  BuildTenantContextArgs,
  TenantContextMode,
  TenantContextResult,
} from "./business-brain/tenant-context";
export type { BusinessBrainReviewSlot } from "./business-brain/schema";
export type {
  BusinessBrainReviewResult,
  BusinessBrainSectionReviewResult,
  BusinessBrainReviewSeverity,
  BusinessBrainMovedSuggestion,
  BusinessBrainRejectedItem,
} from "./business-brain/reviewer";
