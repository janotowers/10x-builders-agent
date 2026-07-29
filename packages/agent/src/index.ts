export { runAgent } from "./graph";
export {
  DEFAULT_MAIN_AGENT_MODEL_ID,
  DEFAULT_COMPACTION_MODEL_ID,
  DEFAULT_SKILL_SELECTOR_MODEL_ID,
  DEFAULT_BUSINESS_BRAIN_REVIEWER_MODEL_ID,
  DEFAULT_OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID,
  DEFAULT_IMAGE_VISION_MODEL_ID,
  DEFAULT_LISTING_COPY_MODEL_ID,
  MAIN_AGENT_MODEL_ID,
  CHAT_MODEL_ID,
  COMPACTION_MODEL_ID,
  SKILL_SELECTOR_MODEL_ID,
  BUSINESS_BRAIN_REVIEWER_MODEL_ID,
  OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID,
  IMAGE_VISION_MODEL_ID,
  LISTING_COPY_MODEL_ID,
  resolveHeartbeatModelId,
  createChatModel,
  createCompactionModel,
  createSkillSelectorModel,
  createBusinessBrainReviewerModel,
} from "./model";
export { isPropertyOptioningIntent } from "./skills/property-optioning-intent";
export {
  buildOperationalCaseIntakeUpdateContext,
  buildOperationalCaseCreateContext,
  buildPropertyDataMinimumsSummaryMessage,
  buildContractDataReviewNotifyText,
  contractDraftOutputPathFromContext,
  documentExtractionMinimumsContext,
  evaluateContractReviewNotifyGate,
  evaluateListingDescriptionReviewNotifyGate,
  listingDescriptionDraftContentFromContext,
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
export {
  PHOTO_LABEL_CONFIDENCE_THRESHOLD,
  applyPublicUrlsToManifest,
  applyWatermarkOutputsToManifest,
  buildPhotoManifestFromRawPhotos,
  imagePathsForUpload,
  imageTitlesFromManifest,
  manifestNeedsLabelReview,
  manifestsMatchRawPhotosInOrder,
  manifestsMatchRawPhotosSet,
  mergePhotoEntries,
  mergePhotoLabelsIntoManifest,
  normalizePhotoSourcePath,
  parsePhotoManifest,
  photoUploadPairsFromManifest,
  publicImageUrlsFromManifest,
  resolveRawPhotoPaths,
} from "./operational-cases/photo-manifest";
export type {
  PhotoManifestEntry,
  PhotoManifestError,
  PhotoUploadPair,
} from "./operational-cases/photo-manifest";
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
  amountToSpanishLegalWords,
  contractDatePartsFromTimezone,
  deriveCommissionContractTemplateData,
  formatContractSalidaPrice,
  integerToSpanishWordsLower,
  operationContractTypeLabel,
  operationTypeLabel,
  percentToSpanishWords,
  readablePropertyAddress,
  resolveContractOperationKind,
} from "./tools/commission-contract-template-data";
export type {
  CommissionContractPlaceholderKey,
  ContractOperationKind,
} from "./tools/commission-contract-template-data";
export {
  applyCommissionTermsPatch,
  buildContractCommercialMinimumsSummaryMessage,
  buildContractCommercialCaptureAckMessage,
  collaborationCompensationModeChoices,
  emptyCommissionTerms,
  evaluateContractCommercialMinimums,
  formatCollaborationCompensationMode,
  mapCollaborationToEasyBroker,
  mapCollaborationToUngga,
  parseCommissionTerms,
  parseContractCommercialReply,
  classifyExclusivePolarity,
  classifyCollaborationPolarity,
  resolveOwnerEmailFromSources,
  COLLABORATION_COMPENSATION_MODE_LABELS,
} from "./operational-cases/contract-commercial-terms";
export type {
  BooleanPolarity,
  CollaborationCompensationMode,
  CollaborationTerms,
  CommissionTerms,
  ContractCommercialMinimumsResult,
  ContractCommercialMissingField,
  ContractCommercialPatch,
  ContractCommercialSummaryMode,
} from "./operational-cases/contract-commercial-terms";
export { testAvaclickCredentials } from "./tools/avaclick";
export {
  buildComparableSearchFilters,
  sanitizeComparableSearchFilters,
  deriveComparableAreaBand,
  requiresAvaclick,
  classifyComparableSearchOutcome,
  mapToEasyBrokerPropertyType,
  propertyTypesMatch,
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
  buildListingDescriptionDraftTxtAttachment,
  formatListingDescriptionReviewNotifyText,
  listingDescriptionReviewExcerptTruncated,
  sanitizeListingDescriptionCommercialCopy,
} from "./operational-cases/listing-description-review";
export {
  formatPublishDestinationApprovalNotifyText,
  publicationDestinationLabelFromKind,
  type PublicationDestinationLabel,
} from "./operational-cases/publication-destination-approval-copy";
export { resolveImagePathsFromRawPhotos } from "./tools/realestate-adapters";
export { normalizeAnalyzeImageStorageRef } from "./tools/realestate-adapters";
export {
  renderCommissionContractForCase,
  type CommissionContractRenderResult,
} from "./tools/realestate-adapters";
export {
  isUsableLatLng,
  mergeEasyBrokerCreateInputFromCaseSources,
  buildEasyBrokerCreatePayload,
  filterFeaturesAgainstCatalog,
  parseMexicanAddressParts,
  EASYBROKER_CREATE_TOP_LEVEL_ALLOWLIST,
  EASYBROKER_CREATE_LOCATION_ALLOWLIST,
} from "./tools/realestate-adapters";
export type {
  EasyBrokerCreatePayloadBuildResult,
  EasyBrokerDroppedField,
} from "./tools/realestate-adapters";
export {
  canCompleteListingPublishedSummaryFromContext,
  formatListingPublishedSummaryNotifyText,
} from "./operational-cases/listing-published-summary";
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
  compileBusinessBrainSoul,
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
  CompileBusinessBrainSoulInput,
  CompileBusinessBrainSoulResult,
} from "./business-brain/reviewer";
export {
  bindAiUsageContext,
  runWithAiUsageContext,
  enrichAiUsageContext,
  currentAiUsageContext,
} from "./usage/ai-usage-context";
export {
  recordAiUsageEvent,
  recordOpenRouterCallUsage,
  createAiUsageCallbackHandler,
  setAiUsageRecorder,
  getDroppedAiUsageMeterCount,
  isAiUsageMeteringEnabled,
  sanitizeUsageMetadata,
  normalizeOpenRouterUsage,
  normalizeLangChainUsage,
  extractLangChainReportedCostMicroUsd,
  extractLangChainProviderRequestId,
  enrichWithCatalogEstimate,
  withEstimatedCost,
} from "./usage/ai-usage-meter";
export type { OpenRouterUsagePayload, AiUsageRecorder } from "./usage/ai-usage-meter";
export {
  MODEL_PRICE_CATALOG_VERSION,
  getModelPrice,
  getCatalogSnapshot,
  estimateCostMicroUsd,
  listModelPriceCatalogVersions,
  CATALOG_REQUIRED_MODEL_IDS,
} from "./usage/model-price-catalog";
export type {
  ModelPrice,
  ModelPriceCatalogSnapshot,
} from "./usage/model-price-catalog";
export {
  createOpenRouterMeteringFetch,
  openRouterClientConfiguration,
  stashOpenRouterUsage,
  takeStashedOpenRouterUsage,
  clearOpenRouterUsageStash,
} from "./usage/openrouter-usage-capture";
