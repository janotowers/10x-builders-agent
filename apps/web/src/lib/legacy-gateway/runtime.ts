/**
 * Credential resolution and reader construction - the seam between the
 * Organization-scoped credential store and the bootstrap adapters.
 *
 * Server-only. Credentials are resolved per Organization, per read, and are
 * never cached in a form that outlives the process or crosses an Organization
 * boundary.
 *
 * Fail-closed shape of this module: a missing Firestore credential is a refusal,
 * because three of the four capabilities cannot answer without it. A missing
 * Mongo credential is NOT a refusal - only `appointment_get` uses Mongo, and it
 * reports `storesConsulted.mongo = false` so a single-store answer is explicitly
 * incomplete rather than silently authoritative.
 */
import {
  getOrganizationToolSecretForRuntime,
  touchOrganizationToolSecretUsed,
  type DbClient,
  type TraditionalGuFirestoreConfig,
  type TraditionalGuFirestoreSecret,
  type TraditionalGuMongoConfig,
  type TraditionalGuMongoSecret,
} from "@agents/db";
import type { LegacyGatewayCapability } from "@agents/types";
import { createFirestoreReader, createMongoReader } from "./adapters";
import { LegacyReadRefusal } from "./errors";
import type { LegacySourceReaders } from "./source-clients";

export interface ResolveReadersInput {
  db: DbClient;
  organizationId: string;
  /** Named only so a refusal says which capability could not be served. */
  capability: LegacyGatewayCapability;
  externalId: string;
  /** Skip the Mongo credential entirely when the capability does not need it. */
  needsMongo?: boolean;
}

export async function resolveLegacySourceReaders(
  input: ResolveReadersInput
): Promise<LegacySourceReaders> {
  const firestoreSecret = await getOrganizationToolSecretForRuntime<
    TraditionalGuFirestoreSecret,
    TraditionalGuFirestoreConfig
  >(input.db, {
    organizationId: input.organizationId,
    provider: "traditional_gu_firestore",
  });
  if (!firestoreSecret) {
    throw new LegacyReadRefusal(
      "no_usable_credential",
      input.capability,
      input.externalId,
      "no usable traditional_gu_firestore credential for this Organization"
    );
  }
  const firestore = createFirestoreReader({
    organizationId: input.organizationId,
    credentials: {
      projectId: firestoreSecret.config.project_id,
      clientEmail: firestoreSecret.config.client_email,
      privateKey: firestoreSecret.secret.private_key,
    },
  });
  void touchOrganizationToolSecretUsed(input.db, {
    organizationId: input.organizationId,
    provider: "traditional_gu_firestore",
  }).catch((error: unknown) => {
    // Usage bookkeeping must never fail a read.
    console.error("[legacy-gateway] could not record credential use:", error);
  });

  let mongo: LegacySourceReaders["mongo"] = null;
  if (input.needsMongo) {
    const mongoSecret = await getOrganizationToolSecretForRuntime<
      TraditionalGuMongoSecret,
      TraditionalGuMongoConfig
    >(input.db, {
      organizationId: input.organizationId,
      provider: "traditional_gu_mongo",
    });
    if (mongoSecret) {
      mongo = createMongoReader({
        organizationId: input.organizationId,
        credentials: {
          uri: mongoSecret.secret.uri,
          database: mongoSecret.config.database,
        },
      });
      void touchOrganizationToolSecretUsed(input.db, {
        organizationId: input.organizationId,
        provider: "traditional_gu_mongo",
      }).catch(() => undefined);
    }
  }

  return { firestore, mongo };
}
