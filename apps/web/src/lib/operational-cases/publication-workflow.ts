/**
 * Re-export shared publication state machine from @agents/agent so adapters
 * and the web runner share one source of truth.
 */
export {
  PUBLICATION_DESTINATIONS,
  PUBLICATION_APPROVALS,
  PUBLICATION_PHASES,
  PUBLICATION_PROTECTED_CONTEXT_KEYS,
  emptyDestinationState,
  emptyPublicationState,
  migrateLegacyPublicationState,
  publicationFromContext,
  projectLegacyPublicationFields,
  isTerminalPublicationPhase,
  isEasybrokerEffectivelyPublished,
  isEasybrokerDraftCreated,
  isDestinationResolvedIdleReason,
  areAllPublicationDestinationsResolved,
  nextPublicationAction,
  applyPublicationEvent,
  buildPublicationContextPatch,
  containsProtectedPublicationKeys,
  reconcilePublicationWithArtifacts,
} from "@agents/agent/src/operational-cases/publication-workflow";

export type {
  PublicationDestination,
  PublicationApproval,
  PublicationPhase,
  PublicationMachineAction,
  PublicationPreflightStatus,
  PublicationArtifact,
  PublicationMediaState,
  PublicationDestinationState,
  PublicationState,
  PublicationEvent,
} from "@agents/agent/src/operational-cases/publication-workflow";
