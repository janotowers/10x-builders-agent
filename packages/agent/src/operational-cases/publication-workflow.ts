/**
 * Máquina de estados determinística para publicación por destino
 * (EasyBroker / Ungga). El LLM no decide el orden de side effects.
 */
import { WORKFLOW_PUBLICATION_PROTECTED_CONTEXT_KEYS } from "@agents/workflows";

export const PUBLICATION_DESTINATIONS = ["easybroker", "ungga"] as const;
export type PublicationDestination = (typeof PUBLICATION_DESTINATIONS)[number];

export const PUBLICATION_APPROVALS = [
  "pending",
  "approved",
  "skipped",
  "rejected",
] as const;
export type PublicationApproval = (typeof PUBLICATION_APPROVALS)[number];

export const PUBLICATION_PHASES = [
  "awaiting_approval",
  "draft_pending",
  "draft_creating",
  "draft_ready",
  "media_pending",
  "media_processing",
  "validating",
  "review_required",
  "publish_pending",
  "publishing",
  "published",
  "failed",
  "unknown_outcome",
  "skipped",
] as const;
export type PublicationPhase = (typeof PUBLICATION_PHASES)[number];

export type PublicationMachineAction =
  | { type: "request_approval"; destination: PublicationDestination }
  | { type: "create_draft"; destination: PublicationDestination }
  | { type: "process_media"; destination: PublicationDestination }
  | { type: "wait_remote_media"; destination: PublicationDestination }
  | { type: "validate"; destination: PublicationDestination }
  | { type: "request_review"; destination: PublicationDestination }
  | { type: "publish"; destination: PublicationDestination }
  | { type: "complete"; destination: PublicationDestination }
  | { type: "idle"; reason: string };

export type PublicationPreflightStatus =
  | "pass"
  | "waiting"
  | "review_required"
  | "blocked"
  | null;

export type PublicationArtifact = {
  listing_id?: string | null;
  public_id?: string | null;
  ungga_property_id?: string | null;
  draft_url?: string | null;
  published_url?: string | null;
  agent_url?: string | null;
  remote_status?: string | null;
  image_count?: number | null;
  images_status?: string | null;
  images_uploaded?: boolean;
  images_error?: string | null;
  /** How the Ungga property was created: cli | api | easybroker_import | unknown */
  creation_source?: string | null;
};

export type PublicationMediaState = {
  required: boolean;
  submitted: boolean;
  verified: boolean;
  expected_count: number;
  remote_count: number | null;
  last_checked_at?: string | null;
};

export type PublicationDestinationState = {
  approval: PublicationApproval;
  phase: PublicationPhase;
  artifact: PublicationArtifact;
  media: PublicationMediaState;
  preflight: PublicationPreflightStatus;
  last_error: string | null;
  operation_key: string | null;
  review_reason: string | null;
  updated_at: string | null;
  /** Silent prepare_draft media auto-retries used (runner-owned; max 1). */
  prepare_auto_retries_used?: number;
};

export type PublicationState = {
  version: 1;
  destinations: {
    easybroker: PublicationDestinationState;
    ungga: PublicationDestinationState;
  };
  feature_enabled?: boolean;
};

// Canonical list lives in @agents/workflows so the transition evaluator and
// this runtime adapter can never drift (Slice 1.4). Re-exported here to keep
// existing import sites stable.
export const PUBLICATION_PROTECTED_CONTEXT_KEYS =
  WORKFLOW_PUBLICATION_PROTECTED_CONTEXT_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyMedia(required = false): PublicationMediaState {
  return {
    required,
    submitted: false,
    verified: false,
    expected_count: 0,
    remote_count: null,
    last_checked_at: null,
  };
}

export function emptyDestinationState(
  approval: PublicationApproval = "pending",
  options?: { mediaRequired?: boolean }
): PublicationDestinationState {
  const phase: PublicationPhase =
    approval === "skipped" || approval === "rejected"
      ? "skipped"
      : approval === "approved"
        ? "draft_pending"
        : "awaiting_approval";
  return {
    approval,
    phase,
    artifact: {},
    media: emptyMedia(options?.mediaRequired ?? false),
    preflight: null,
    last_error: null,
    operation_key: null,
    review_reason: null,
    updated_at: null,
    prepare_auto_retries_used: 0,
  };
}

export function emptyPublicationState(
  options?: { featureEnabled?: boolean }
): PublicationState {
  return {
    version: 1,
    feature_enabled: options?.featureEnabled ?? true,
    destinations: {
      easybroker: emptyDestinationState("pending", { mediaRequired: true }),
      ungga: emptyDestinationState("pending", { mediaRequired: true }),
    },
  };
}

function approvalFromLegacy(value: unknown): PublicationApproval {
  if (value === "approved" || value === "skipped" || value === "rejected") {
    return value;
  }
  if (value === "pending") return "pending";
  return "pending";
}

function countPhotos(context: Record<string, unknown>): number {
  if (Array.isArray(context.raw_photos)) return context.raw_photos.length;
  if (Array.isArray(context.watermarked_photos)) {
    return context.watermarked_photos.length;
  }
  if (Array.isArray(context.photo_manifest)) {
    return context.photo_manifest.length;
  }
  return 0;
}

/**
 * Reconstruye `publication` desde `publish_approvals` + `published` legados.
 * No inventa fases posteriores a lo que el contexto demuestra.
 */
export function migrateLegacyPublicationState(
  context: Record<string, unknown> | null | undefined
): PublicationState {
  const base = emptyPublicationState({ featureEnabled: true });
  if (!isRecord(context)) return base;

  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const published = isRecord(context.published) ? context.published : {};
  const photoCount = countPhotos(context);

  for (const destination of PUBLICATION_DESTINATIONS) {
    const approval = approvalFromLegacy(approvals[destination]);
    const dest = emptyDestinationState(approval, {
      mediaRequired: photoCount > 0,
    });
    dest.media.expected_count = photoCount;

    const artifactRaw = isRecord(published[destination])
      ? published[destination]
      : null;

    if (destination === "easybroker" && artifactRaw) {
      const listingId =
        typeof artifactRaw.listing_id === "string"
          ? artifactRaw.listing_id
          : typeof artifactRaw.public_id === "string"
            ? artifactRaw.public_id
            : null;
      if (listingId) {
        dest.artifact = {
          listing_id: listingId,
          public_id:
            typeof artifactRaw.public_id === "string"
              ? artifactRaw.public_id
              : listingId,
          published_url:
            typeof artifactRaw.url === "string"
              ? artifactRaw.url
              : typeof artifactRaw.public_url === "string"
                ? artifactRaw.public_url
                : null,
          agent_url:
            typeof artifactRaw.agent_url === "string"
              ? artifactRaw.agent_url
              : null,
          remote_status:
            typeof artifactRaw.status === "string"
              ? artifactRaw.status
              : "not_published",
          image_count:
            typeof artifactRaw.image_count === "number"
              ? artifactRaw.image_count
              : null,
          images_status:
            typeof artifactRaw.images_status === "string"
              ? artifactRaw.images_status
              : null,
          images_uploaded: artifactRaw.images_uploaded === true,
          images_error:
            typeof artifactRaw.images_error === "string"
              ? artifactRaw.images_error
              : null,
        };

        const imagesOk =
          artifactRaw.images_uploaded === true ||
          artifactRaw.images_status === "submitted" ||
          (typeof artifactRaw.image_count === "number" &&
            artifactRaw.image_count > 0);
        const imagesFailed = artifactRaw.images_status === "failed";
        const isPubliclyPublished =
          artifactRaw.remote_status === "published" ||
          artifactRaw.status === "published";

        if (isPubliclyPublished) {
          dest.phase = "published";
          dest.media.submitted = true;
          dest.media.verified = true;
        } else if (imagesFailed) {
          dest.phase = "failed";
          dest.last_error =
            typeof artifactRaw.images_error === "string"
              ? artifactRaw.images_error
              : "easybroker_images_upload_failed";
          dest.media.submitted = false;
        } else if (imagesOk) {
          dest.phase = "validating";
          dest.media.submitted = true;
        } else if (photoCount > 0) {
          dest.phase = "media_pending";
        } else {
          dest.phase = "validating";
        }
      }
    }

    if (destination === "ungga" && artifactRaw) {
      const unggaId =
        typeof artifactRaw.ungga_property_id === "string"
          ? artifactRaw.ungga_property_id
          : null;
      const draftUrl =
        typeof artifactRaw.draft_url === "string" ? artifactRaw.draft_url : null;
      const publishedUrl =
        typeof artifactRaw.published_url === "string"
          ? artifactRaw.published_url
          : null;
      dest.artifact = {
        ungga_property_id: unggaId,
        draft_url: draftUrl,
        published_url: publishedUrl,
        remote_status:
          typeof artifactRaw.status === "string" ? artifactRaw.status : null,
      };
      if (publishedUrl || artifactRaw.status === "published") {
        dest.phase = "published";
      } else if (unggaId || draftUrl) {
        dest.phase = "validating";
      }
    }

    if (approval === "skipped" || approval === "rejected") {
      dest.phase = "skipped";
    }

    base.destinations[destination] = dest;
  }

  return base;
}

export function publicationFromContext(
  context: Record<string, unknown> | null | undefined
): PublicationState {
  if (!isRecord(context)) return emptyPublicationState();
  const existing = context.publication;
  if (isRecord(existing) && existing.version === 1 && isRecord(existing.destinations)) {
    const migrated = migrateLegacyPublicationState(context);
    const destinations = existing.destinations as Record<string, unknown>;
    const merged = emptyPublicationState({
      featureEnabled:
        typeof existing.feature_enabled === "boolean"
          ? existing.feature_enabled
          : true,
    });
    for (const destination of PUBLICATION_DESTINATIONS) {
      const raw = destinations[destination];
      if (!isRecord(raw)) {
        merged.destinations[destination] = migrated.destinations[destination];
        continue;
      }
      const fallback = migrated.destinations[destination];
      merged.destinations[destination] = {
        approval: approvalFromLegacy(raw.approval) || fallback.approval,
        phase:
          typeof raw.phase === "string" &&
          (PUBLICATION_PHASES as readonly string[]).includes(raw.phase)
            ? (raw.phase as PublicationPhase)
            : fallback.phase,
        artifact: isRecord(raw.artifact)
          ? { ...fallback.artifact, ...raw.artifact }
          : fallback.artifact,
        media: isRecord(raw.media)
          ? {
              ...fallback.media,
              required: raw.media.required === true,
              submitted: raw.media.submitted === true,
              verified: raw.media.verified === true,
              expected_count:
                typeof raw.media.expected_count === "number"
                  ? raw.media.expected_count
                  : fallback.media.expected_count,
              remote_count:
                typeof raw.media.remote_count === "number"
                  ? raw.media.remote_count
                  : fallback.media.remote_count,
              last_checked_at:
                typeof raw.media.last_checked_at === "string"
                  ? raw.media.last_checked_at
                  : fallback.media.last_checked_at,
            }
          : fallback.media,
        preflight:
          raw.preflight === "pass" ||
          raw.preflight === "waiting" ||
          raw.preflight === "review_required" ||
          raw.preflight === "blocked"
            ? raw.preflight
            : fallback.preflight,
        last_error:
          typeof raw.last_error === "string" ? raw.last_error : fallback.last_error,
        operation_key:
          typeof raw.operation_key === "string"
            ? raw.operation_key
            : fallback.operation_key,
        review_reason:
          typeof raw.review_reason === "string"
            ? raw.review_reason
            : fallback.review_reason,
        updated_at:
          typeof raw.updated_at === "string" ? raw.updated_at : fallback.updated_at,
        prepare_auto_retries_used:
          typeof raw.prepare_auto_retries_used === "number" &&
          Number.isFinite(raw.prepare_auto_retries_used) &&
          raw.prepare_auto_retries_used >= 0
            ? Math.floor(raw.prepare_auto_retries_used)
            : typeof fallback.prepare_auto_retries_used === "number"
              ? fallback.prepare_auto_retries_used
              : 0,
      };
    }
    return merged;
  }
  return migrateLegacyPublicationState(context);
}

/** Proyecciones legadas para UI/prompts que aún leen publish_approvals/published. */
export function projectLegacyPublicationFields(
  publication: PublicationState
): {
  publish_approvals: Record<string, string>;
  published: Record<string, Record<string, unknown>>;
} {
  const publish_approvals: Record<string, string> = {};
  const published: Record<string, Record<string, unknown>> = {};
  for (const destination of PUBLICATION_DESTINATIONS) {
    const dest = publication.destinations[destination];
    publish_approvals[destination] = dest.approval;
    if (dest.artifact.listing_id || dest.artifact.ungga_property_id) {
      published[destination] = {
        ...dest.artifact,
        listing_id: dest.artifact.listing_id ?? dest.artifact.public_id ?? null,
        url: dest.artifact.published_url ?? null,
        public_url: dest.artifact.published_url ?? null,
        status:
          dest.phase === "published"
            ? "published"
            : dest.artifact.remote_status ?? "not_published",
        images_uploaded: dest.media.submitted || dest.artifact.images_uploaded === true,
        images_status:
          dest.media.verified
            ? "verified"
            : dest.media.submitted
              ? "submitted"
              : dest.artifact.images_status ?? null,
        image_count:
          dest.media.remote_count ?? dest.artifact.image_count ?? null,
        ok: dest.phase === "published" || Boolean(dest.artifact.listing_id),
      };
    }
  }
  return { publish_approvals, published };
}

export function isTerminalPublicationPhase(phase: PublicationPhase): boolean {
  return (
    phase === "published" ||
    phase === "skipped" ||
    phase === "failed" ||
    phase === "unknown_outcome"
  );
}

export function isEasybrokerEffectivelyPublished(
  publication: PublicationState
): boolean {
  return publication.destinations.easybroker.phase === "published";
}

/** True when EasyBroker has a listing artifact (draft or published). */
export function isEasybrokerDraftCreated(
  publication: PublicationState
): boolean {
  const dest = publication.destinations.easybroker;
  return Boolean(dest.artifact.listing_id || dest.artifact.public_id);
}

/**
 * Idle reasons that mean this destination needs no further machine work.
 * In-flight / no_action idles must NOT fall through to all_destinations_resolved.
 */
export function isDestinationResolvedIdleReason(reason: string): boolean {
  return (
    reason.endsWith("_already_published") ||
    reason.endsWith("_skipped_or_rejected")
  );
}

/**
 * True when every destination is terminal-success (published) or explicitly
 * skipped/rejected. Failed / unknown_outcome / in-flight never qualify.
 */
export function areAllPublicationDestinationsResolved(
  publication: PublicationState
): boolean {
  return PUBLICATION_DESTINATIONS.every((destination) => {
    const dest = publication.destinations[destination];
    if (dest.approval === "skipped" || dest.approval === "rejected") {
      return true;
    }
    return dest.phase === "published" || dest.phase === "skipped";
  });
}

/**
 * Reducer puro: una sola acción siguiente por caso.
 * Orden: EasyBroker completo (o skipped/rejected) antes de Ungga.
 */
export function nextPublicationAction(
  publication: PublicationState
): PublicationMachineAction {
  if (publication.feature_enabled === false) {
    return { type: "idle", reason: "feature_disabled" };
  }

  for (const destination of PUBLICATION_DESTINATIONS) {
    if (destination === "ungga") {
      const eb = publication.destinations.easybroker;
      const ebDone =
        eb.phase === "published" ||
        eb.phase === "skipped" ||
        eb.approval === "skipped" ||
        eb.approval === "rejected";
      if (!ebDone) {
        // EasyBroker must finish (or be skipped) before Ungga approval/work.
        if (eb.approval === "pending" || eb.phase === "awaiting_approval") {
          return { type: "request_approval", destination: "easybroker" };
        }
        const ebAction = actionForDestination("easybroker", eb);
        if (ebAction.type !== "idle") return ebAction;
        // Preserve in-flight / unresolved idle from EasyBroker (do not discard).
        if (
          ebAction.type === "idle" &&
          !isDestinationResolvedIdleReason(ebAction.reason)
        ) {
          return ebAction;
        }
        return {
          type: "idle",
          reason: "waiting_easybroker_before_ungga",
        };
      }
    }

    const dest = publication.destinations[destination];
    const action = actionForDestination(destination, dest);
    if (action.type !== "idle") return action;
    // Keep draft_in_flight / publish_in_flight / no_action — never escalate to
    // all_destinations_resolved while a destination is still unresolved.
    if (!isDestinationResolvedIdleReason(action.reason)) {
      return action;
    }
  }

  if (!areAllPublicationDestinationsResolved(publication)) {
    return { type: "idle", reason: "destinations_unresolved" };
  }

  return { type: "idle", reason: "all_destinations_resolved" };
}

function actionForDestination(
  destination: PublicationDestination,
  dest: PublicationDestinationState
): PublicationMachineAction {
  if (dest.approval === "skipped" || dest.approval === "rejected") {
    return { type: "idle", reason: `${destination}_skipped_or_rejected` };
  }
  if (dest.phase === "published") {
    return { type: "idle", reason: `${destination}_already_published` };
  }
  if (dest.phase === "unknown_outcome") {
    return { type: "request_review", destination };
  }
  if (dest.phase === "failed") {
    return { type: "request_review", destination };
  }
  if (dest.approval === "pending" || dest.phase === "awaiting_approval") {
    return { type: "request_approval", destination };
  }
  if (
    dest.phase === "draft_pending" ||
    dest.phase === "draft_creating" ||
    (dest.approval === "approved" &&
      !dest.artifact.listing_id &&
      !dest.artifact.ungga_property_id &&
      dest.phase !== "review_required")
  ) {
    if (dest.phase === "draft_creating") {
      return { type: "idle", reason: `${destination}_draft_in_flight` };
    }
    return { type: "create_draft", destination };
  }
  if (dest.phase === "media_pending" || dest.phase === "media_processing") {
    if (dest.media.required && !dest.media.submitted) {
      return { type: "process_media", destination };
    }
    if (dest.media.submitted && !dest.media.verified) {
      return { type: "wait_remote_media", destination };
    }
  }
  if (dest.phase === "review_required") {
    return { type: "request_review", destination };
  }
  if (dest.phase === "validating") {
    return { type: "validate", destination };
  }
  if (dest.phase === "publish_pending" || dest.phase === "publishing") {
    if (dest.phase === "publishing") {
      return { type: "idle", reason: `${destination}_publish_in_flight` };
    }
    return { type: "publish", destination };
  }
  if (dest.phase === "draft_ready") {
    if (dest.media.required && !dest.media.submitted) {
      return { type: "process_media", destination };
    }
    return { type: "validate", destination };
  }
  return { type: "idle", reason: `${destination}_no_action` };
}

export type PublicationEvent =
  | {
      type: "approval_decided";
      destination: PublicationDestination;
      approval: Exclude<PublicationApproval, "pending">;
      at?: string;
    }
  | {
      type: "draft_started";
      destination: PublicationDestination;
      operation_key: string;
      at?: string;
    }
  | {
      type: "draft_created";
      destination: PublicationDestination;
      artifact: PublicationArtifact;
      at?: string;
    }
  | {
      type: "draft_failed";
      destination: PublicationDestination;
      error: string;
      unknown?: boolean;
      at?: string;
    }
  | {
      type: "media_submitted";
      destination: PublicationDestination;
      expected_count: number;
      at?: string;
    }
  | {
      type: "media_verified";
      destination: PublicationDestination;
      remote_count: number;
      at?: string;
    }
  | {
      type: "media_failed";
      destination: PublicationDestination;
      error: string;
      at?: string;
    }
  | {
      type: "preflight_result";
      destination: PublicationDestination;
      status: Exclude<PublicationPreflightStatus, null>;
      reason?: string | null;
      at?: string;
    }
  | {
      type: "review_resolved";
      destination: PublicationDestination;
      at?: string;
    }
  | {
      type: "publish_started";
      destination: PublicationDestination;
      operation_key: string;
      at?: string;
    }
  | {
      type: "publish_succeeded";
      destination: PublicationDestination;
      artifact?: PublicationArtifact;
      at?: string;
    }
  | {
      type: "publish_failed";
      destination: PublicationDestination;
      error: string;
      unknown?: boolean;
      at?: string;
    };

export function applyPublicationEvent(
  publication: PublicationState,
  event: PublicationEvent
): PublicationState {
  const next: PublicationState = {
    ...publication,
    destinations: {
      easybroker: { ...publication.destinations.easybroker },
      ungga: { ...publication.destinations.ungga },
    },
  };
  const dest = { ...next.destinations[event.destination] };
  const at = event.at ?? new Date().toISOString();
  dest.updated_at = at;

  switch (event.type) {
    case "approval_decided":
      dest.approval = event.approval;
      if (event.approval === "skipped" || event.approval === "rejected") {
        dest.phase = "skipped";
      } else {
        dest.phase = "draft_pending";
      }
      dest.last_error = null;
      dest.review_reason = null;
      break;
    case "draft_started":
      dest.phase = "draft_creating";
      dest.operation_key = event.operation_key;
      dest.last_error = null;
      break;
    case "draft_created":
      dest.artifact = { ...dest.artifact, ...event.artifact };
      dest.phase =
        dest.media.required && !dest.media.submitted
          ? "media_pending"
          : "draft_ready";
      dest.last_error = null;
      break;
    case "draft_failed":
      dest.phase = event.unknown ? "unknown_outcome" : "failed";
      dest.last_error = event.error;
      break;
    case "media_submitted":
      dest.media = {
        ...dest.media,
        required: true,
        submitted: true,
        verified: false,
        expected_count: event.expected_count,
      };
      dest.phase = "media_processing";
      dest.last_error = null;
      break;
    case "media_verified":
      dest.media = {
        ...dest.media,
        submitted: true,
        verified: true,
        remote_count: event.remote_count,
        last_checked_at: at,
      };
      dest.phase = "validating";
      dest.last_error = null;
      break;
    case "media_failed":
      dest.phase = "failed";
      dest.last_error = event.error;
      dest.media = { ...dest.media, submitted: false, verified: false };
      break;
    case "preflight_result":
      dest.preflight = event.status;
      if (event.status === "pass") {
        dest.phase = "publish_pending";
        dest.review_reason = null;
        dest.last_error = null;
      } else if (event.status === "waiting") {
        dest.phase = "media_processing";
      } else if (event.status === "review_required") {
        dest.phase = "review_required";
        dest.review_reason = event.reason ?? "preflight_review_required";
      } else {
        dest.phase = "failed";
        dest.last_error = event.reason ?? "preflight_blocked";
      }
      break;
    case "review_resolved":
      dest.phase = "validating";
      dest.review_reason = null;
      dest.preflight = null;
      break;
    case "publish_started":
      dest.phase = "publishing";
      dest.operation_key = event.operation_key;
      break;
    case "publish_succeeded":
      if (event.artifact) {
        dest.artifact = { ...dest.artifact, ...event.artifact };
      }
      dest.artifact.remote_status = "published";
      dest.phase = "published";
      dest.last_error = null;
      break;
    case "publish_failed":
      dest.phase = event.unknown ? "unknown_outcome" : "failed";
      dest.last_error = event.error;
      break;
  }

  next.destinations[event.destination] = dest;
  return next;
}

export function buildPublicationContextPatch(
  publication: PublicationState
): Record<string, unknown> {
  const legacy = projectLegacyPublicationFields(publication);
  return {
    publication,
    publish_approvals: legacy.publish_approvals,
    published: legacy.published,
  };
}

export function containsProtectedPublicationKeys(
  patch: Record<string, unknown> | null | undefined
): string[] {
  if (!isRecord(patch)) return [];
  return PUBLICATION_PROTECTED_CONTEXT_KEYS.filter((key) => key in patch);
}

const PHASE_RANK: Record<PublicationPhase, number> = {
  awaiting_approval: 0,
  draft_pending: 1,
  draft_creating: 2,
  draft_ready: 3,
  media_pending: 4,
  media_processing: 5,
  validating: 6,
  review_required: 7,
  publish_pending: 8,
  publishing: 9,
  published: 10,
  failed: 11,
  unknown_outcome: 12,
  skipped: 13,
};

/**
 * Advances stuck machine phases using legacy `published` / `publish_approvals`
 * artifacts written by destination adapters. Idempotent.
 */
export function reconcilePublicationWithArtifacts(
  publication: PublicationState,
  context: Record<string, unknown> | null | undefined
): PublicationState {
  if (!isRecord(context)) return publication;
  let next = publication;
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const published = isRecord(context.published) ? context.published : {};
  const photoCount = countPhotos(context);

  for (const destination of PUBLICATION_DESTINATIONS) {
    const approval = approvalFromLegacy(approvals[destination]);
    const dest = next.destinations[destination];
    if (
      approval !== "pending" &&
      dest.approval === "pending" &&
      (approval === "approved" ||
        approval === "skipped" ||
        approval === "rejected")
    ) {
      next = applyPublicationEvent(next, {
        type: "approval_decided",
        destination,
        approval,
      });
    }

    const artifactRaw = isRecord(published[destination])
      ? published[destination]
      : null;
    if (!artifactRaw) continue;

    if (destination === "easybroker") {
      const listingId =
        typeof artifactRaw.listing_id === "string"
          ? artifactRaw.listing_id
          : typeof artifactRaw.public_id === "string"
            ? artifactRaw.public_id
            : null;
      const current = next.destinations.easybroker;
      if (
        listingId &&
        (current.phase === "draft_pending" ||
          current.phase === "draft_creating" ||
          current.phase === "unknown_outcome" ||
          current.phase === "failed" ||
          (!current.artifact.listing_id &&
            PHASE_RANK[current.phase] < PHASE_RANK.media_pending))
      ) {
        next = applyPublicationEvent(next, {
          type: "draft_created",
          destination: "easybroker",
          artifact: {
            listing_id: listingId,
            public_id:
              typeof artifactRaw.public_id === "string"
                ? artifactRaw.public_id
                : listingId,
            published_url:
              typeof artifactRaw.public_url === "string"
                ? artifactRaw.public_url
                : typeof artifactRaw.url === "string"
                  ? artifactRaw.url
                  : null,
            agent_url:
              typeof artifactRaw.agent_url === "string"
                ? artifactRaw.agent_url
                : null,
            remote_status:
              typeof artifactRaw.status === "string"
                ? artifactRaw.status
                : "not_published",
            image_count:
              typeof artifactRaw.image_count === "number"
                ? artifactRaw.image_count
                : null,
            images_uploaded: artifactRaw.images_uploaded === true,
            images_status:
              typeof artifactRaw.images_status === "string"
                ? artifactRaw.images_status
                : null,
          },
        });
      }

      const afterDraft = next.destinations.easybroker;
      const imagesOk =
        artifactRaw.images_uploaded === true ||
        artifactRaw.images_status === "submitted" ||
        (typeof artifactRaw.image_count === "number" &&
          artifactRaw.image_count > 0);
      if (
        imagesOk &&
        afterDraft.artifact.listing_id &&
        !afterDraft.media.submitted &&
        PHASE_RANK[afterDraft.phase] < PHASE_RANK.validating
      ) {
        const expected =
          typeof artifactRaw.image_count === "number" &&
          artifactRaw.image_count > 0
            ? artifactRaw.image_count
            : photoCount || afterDraft.media.expected_count || 0;
        next = applyPublicationEvent(next, {
          type: "media_submitted",
          destination: "easybroker",
          expected_count: expected,
        });
      }

      const afterMedia = next.destinations.easybroker;
      const remoteCount =
        typeof artifactRaw.image_count === "number"
          ? artifactRaw.image_count
          : afterMedia.media.expected_count;
      if (
        afterMedia.media.submitted &&
        !afterMedia.media.verified &&
        typeof remoteCount === "number" &&
        remoteCount > 0 &&
        artifactRaw.images_status === "verified"
      ) {
        next = applyPublicationEvent(next, {
          type: "media_verified",
          destination: "easybroker",
          remote_count: remoteCount,
        });
      }

      if (
        (artifactRaw.status === "published" ||
          artifactRaw.remote_status === "published") &&
        afterMedia.phase !== "published"
      ) {
        next = applyPublicationEvent(next, {
          type: "publish_succeeded",
          destination: "easybroker",
          artifact: {
            remote_status: "published",
            published_url:
              typeof artifactRaw.public_url === "string"
                ? artifactRaw.public_url
                : typeof artifactRaw.url === "string"
                  ? artifactRaw.url
                  : null,
          },
        });
      }
    }

    if (destination === "ungga") {
      const unggaId =
        typeof artifactRaw.ungga_property_id === "string"
          ? artifactRaw.ungga_property_id
          : null;
      const draftUrl =
        typeof artifactRaw.draft_url === "string" ? artifactRaw.draft_url : null;
      const current = next.destinations.ungga;
      if (
        (unggaId || draftUrl) &&
        (current.phase === "draft_pending" ||
          current.phase === "draft_creating" ||
          current.phase === "unknown_outcome" ||
          current.phase === "failed" ||
          (!current.artifact.ungga_property_id &&
            PHASE_RANK[current.phase] < PHASE_RANK.validating))
      ) {
        next = applyPublicationEvent(next, {
          type: "draft_created",
          destination: "ungga",
          artifact: {
            ungga_property_id: unggaId,
            draft_url: draftUrl,
            published_url:
              typeof artifactRaw.published_url === "string"
                ? artifactRaw.published_url
                : null,
            remote_status:
              typeof artifactRaw.status === "string"
                ? artifactRaw.status
                : "draft",
          },
        });
      }
      if (
        (artifactRaw.status === "published" ||
          typeof artifactRaw.published_url === "string") &&
        next.destinations.ungga.phase !== "published"
      ) {
        next = applyPublicationEvent(next, {
          type: "publish_succeeded",
          destination: "ungga",
          artifact: {
            ungga_property_id: unggaId,
            published_url:
              typeof artifactRaw.published_url === "string"
                ? artifactRaw.published_url
                : null,
            remote_status: "published",
          },
        });
      }
    }
  }

  return next;
}
