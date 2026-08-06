/**
 * Reconciliación de casos de publicación existentes hacia
 * context_jsonb.publication v1 + dedupe de pendientes.
 */

import {
  getOperationalCase,
  listInternalUserNotifications,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import {
  buildPublicationContextPatch,
  applyPublicationEvent,
  emptyPublicationState,
  publicationFromContext,
  reconcilePublicationWithArtifacts,
  type PublicationState,
} from "@/lib/operational-cases/publication-workflow";
import {
  buildPhotoManifestFromRawPhotos,
  parsePhotoManifest,
} from "@/lib/operational-cases/photo-manifest";
import {
  compareEasyBrokerSnapshot,
  fetchEasyBrokerListingSnapshot,
  fetchUnggaListingSnapshot,
  isUnggaApiCredentialsMissingError,
} from "@/lib/operational-cases/publication-remote-snapshot";
import type { PublicationRolloutMode } from "@/lib/operational-cases/publication-rollout";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type PublicationReconcileResult = {
  ok: boolean;
  case_id: string;
  publication: PublicationState;
  changes: string[];
  message?: string;
};

/**
 * Recovery note for legacy case 97d9ba19-687d-4fd6-8b7d-75be29b5f285:
 * its existing EB-WL4498 identifier must be preserved. This generic reconcile
 * path reads that listing, requires the five remote images/titles and internal
 * id to match the corrected manifest, and otherwise moves to unknown_outcome.
 * Ungga is never retried from absence of GU-ID. No case-specific DB mutation is
 * embedded here; the same safe path is also the migration test for clean cases.
 */

const PUBLICATION_PENDING_KINDS = new Set([
  "easybroker_publish_approval",
  "ungga_publish_approval",
  "publication_review_required",
]);

/**
 * Rebuilds publication state from legacy context. Remote truth is applied by
 * reconcilePublicationCaseRecord so this pure function remains self-testable.
 */
export function rebuildPublicationStateFromCaseContext(
  context: Record<string, unknown>,
  options?: {
    featureEnabled?: boolean;
  }
): { publication: PublicationState; changes: string[] } {
  const changes: string[] = [];
  const hadPublication = isRecord(context.publication);
  let publication = reconcilePublicationWithArtifacts(
    publicationFromContext(context),
    context
  );

  if (!hadPublication) {
    changes.push("seeded_publication_from_legacy");
  }

  if (options?.featureEnabled === false) {
    publication = { ...publication, feature_enabled: false };
    changes.push("feature_disabled");
  } else if (options?.featureEnabled === true && publication.feature_enabled === false) {
    publication = { ...publication, feature_enabled: true };
    changes.push("feature_enabled");
  }

  const photoManifest = buildPhotoManifestFromRawPhotos(
    context.raw_photos,
    parsePhotoManifest(context.photo_manifest)
  );
  if (photoManifest.length > 0) {
    for (const destination of ["easybroker", "ungga"] as const) {
      const media = publication.destinations[destination].media;
      if (media.expected_count !== photoManifest.length) {
        publication.destinations[destination] = {
          ...publication.destinations[destination],
          media: {
            ...media,
            required: true,
            expected_count: photoManifest.length,
          },
        };
        changes.push(`${destination}_media_expected_count`);
      }
    }
  }

  // Never infer that a failed/unknown Ungga prepare_draft is safe to retry just
  // because GU-ID is absent. The process may have been killed after the remote
  // write; only a remote lookup or explicit human recovery may clear it.

  return { publication, changes };
}

/**
 * Persists reconciled publication for a case. Optionally resolves duplicate
 * unread notification kinds (keeps newest).
 */
export async function reconcilePublicationCase(
  db: DbClient,
  caseId: string,
  options?: {
    featureEnabled?: boolean;
    publicationMode?: PublicationRolloutMode;
    verifyRemote?: boolean;
    dedupePendingNotifications?: boolean;
  }
): Promise<PublicationReconcileResult> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) {
    return {
      ok: false,
      case_id: caseId,
      publication: emptyPublicationState(),
      changes: [],
      message: "case_not_found",
    };
  }
  return reconcilePublicationCaseRecord(db, opCase, options);
}

export async function reconcilePublicationCaseRecord(
  db: DbClient,
  opCase: OperationalCase,
  options?: {
    featureEnabled?: boolean;
    publicationMode?: PublicationRolloutMode;
    verifyRemote?: boolean;
    dedupePendingNotifications?: boolean;
  }
): Promise<PublicationReconcileResult> {
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const rebuilt = rebuildPublicationStateFromCaseContext(context, options);
  let publication = rebuilt.publication;
  const { changes } = rebuilt;
  const photoManifest = buildPhotoManifestFromRawPhotos(
    context.raw_photos,
    parsePhotoManifest(context.photo_manifest)
  );
  if (options?.verifyRemote !== false) {
    const easybroker = publication.destinations.easybroker;
    const expectedTitles = photoManifest.map(
      (entry) => entry.title ?? entry.space_label ?? null
    );
    if (
      easybroker.artifact.listing_id ||
      easybroker.approval === "approved"
    ) {
      try {
      const snapshot = await fetchEasyBrokerListingSnapshot(db, {
        userId: opCase.user_id,
        listingId: easybroker.artifact.listing_id,
        internalId: opCase.id,
      });
      if (snapshot) {
        const mismatches = compareEasyBrokerSnapshot({
          snapshot,
          expectedInternalId: opCase.id,
          expectedImageCount:
            photoManifest.length > 0 ? photoManifest.length : null,
          expectedImageTitles:
            expectedTitles.some(Boolean) ? expectedTitles : undefined,
        });
        publication = applyPublicationEvent(publication, {
          type: "draft_created",
          destination: "easybroker",
          artifact: {
            listing_id: snapshot.listing_id,
            public_id: snapshot.public_id,
            remote_status: snapshot.status,
          },
        });
        if (photoManifest.length > 0) {
          publication = applyPublicationEvent(publication, {
            type: "media_submitted",
            destination: "easybroker",
            expected_count: photoManifest.length,
          });
        }
        if (mismatches.length === 0 && photoManifest.length > 0) {
          publication = applyPublicationEvent(publication, {
            type: "media_verified",
            destination: "easybroker",
            remote_count: snapshot.image_count,
          });
          changes.push("easybroker_remote_media_verified");
        } else if (mismatches.length > 0) {
          publication = applyPublicationEvent(publication, {
            type: "draft_failed",
            destination: "easybroker",
            error: `remote_mismatch:${mismatches.join(",")}`,
            unknown: true,
          });
          changes.push(`easybroker_remote_ambiguous:${mismatches.join(",")}`);
        }
        if (snapshot.status === "published" && mismatches.length === 0) {
          publication = applyPublicationEvent(publication, {
            type: "publish_succeeded",
            destination: "easybroker",
            artifact: {
              listing_id: snapshot.listing_id,
              public_id: snapshot.public_id,
              remote_status: "published",
            },
          });
          changes.push("easybroker_remote_published");
        }
      } else if (easybroker.artifact.listing_id) {
        publication = applyPublicationEvent(publication, {
          type: "draft_failed",
          destination: "easybroker",
          error: "remote_listing_not_found",
          unknown: true,
        });
        changes.push("easybroker_remote_missing");
      }
      } catch (error) {
        publication = applyPublicationEvent(publication, {
          type: "draft_failed",
          destination: "easybroker",
          error: `remote_read_failed:${
            error instanceof Error ? error.message : String(error)
          }`,
          unknown: true,
        });
        changes.push("easybroker_remote_read_failed");
      }
    }

    const ungga = publication.destinations.ungga;
    if (ungga.artifact.ungga_property_id) {
      try {
        const snapshot = await fetchUnggaListingSnapshot(db, {
          userId: opCase.user_id,
          unggaPropertyId: ungga.artifact.ungga_property_id,
        });
        if (!snapshot) {
          publication = applyPublicationEvent(publication, {
            type: "draft_failed",
            destination: "ungga",
            error: "remote_draft_not_found",
            unknown: true,
          });
          changes.push("ungga_remote_missing");
        } else {
          publication = applyPublicationEvent(publication, {
            type: "draft_created",
            destination: "ungga",
            artifact: {
              ungga_property_id: snapshot.ungga_property_id,
              draft_url: snapshot.draft_url,
              published_url: snapshot.published_url,
              remote_status: snapshot.status,
            },
          });
          if (snapshot.status === "published") {
            publication = applyPublicationEvent(publication, {
              type: "publish_succeeded",
              destination: "ungga",
              artifact: {
                ungga_property_id: snapshot.ungga_property_id,
                published_url: snapshot.published_url,
                remote_status: "published",
              },
            });
            changes.push("ungga_remote_published");
          } else {
            changes.push("ungga_remote_draft_verified");
          }
        }
      } catch (error) {
        if (isUnggaApiCredentialsMissingError(error)) {
          // CLI-only accounts: leave destination as-is; runner uses CLI evidence.
          changes.push("ungga_api_credentials_missing_skipped");
        } else {
          publication = applyPublicationEvent(publication, {
            type: "draft_failed",
            destination: "ungga",
            error: `remote_read_failed:${
              error instanceof Error ? error.message : String(error)
            }`,
            unknown: true,
          });
          changes.push("ungga_remote_read_failed");
        }
      }
    }
  }

  const patch = buildPublicationContextPatch(publication);
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: {
      ...context,
      ...patch,
      photo_manifest:
        Array.isArray(context.photo_manifest) && context.photo_manifest.length > 0
          ? context.photo_manifest
          : photoManifest,
      publication_workflow_v1:
        options?.featureEnabled === false ? false : context.publication_workflow_v1,
      // Do not materialize the rollout default "off" into the case — that made
      // an unset mode look intentional and blocked post-approval enablement.
      ...(options?.publicationMode != null || context.publication_mode != null
        ? {
            publication_mode:
              options?.publicationMode ?? context.publication_mode,
          }
        : {}),
      publication_reconciled_at: new Date().toISOString(),
    },
  });

  if (options?.dedupePendingNotifications !== false) {
    const deduped = await dedupePublicationPendingNotifications(
      db,
      opCase.user_id,
      opCase.id
    );
    if (deduped > 0) changes.push(`deduped_pending_notifications:${deduped}`);
  }

  return {
    ok: Boolean(updated),
    case_id: opCase.id,
    publication,
    changes,
    message: updated ? "reconciled" : "version_conflict",
  };
}

async function dedupePublicationPendingNotifications(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<number> {
  const unread = await listInternalUserNotifications(db, userId, {
    statuses: ["unread"],
    limit: 100,
  }).catch(() => []);
  const relevant = unread.filter((row) => {
    if (!PUBLICATION_PENDING_KINDS.has(row.kind)) return false;
    if (row.case_id === caseId) return true;
    const metadata = isRecord(row.metadata_jsonb) ? row.metadata_jsonb : {};
    return metadata.case_id === caseId;
  });
  const byKind = new Map<string, typeof relevant>();
  for (const row of relevant) {
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  let resolved = 0;
  for (const [, rows] of byKind) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at))
    );
    for (const duplicate of sorted.slice(1)) {
      await resolveInternalNotificationWithReminders(db, {
        id: duplicate.id,
        userId,
        status: "dismissed",
      }).catch(() => null);
      resolved += 1;
    }
  }
  return resolved;
}
