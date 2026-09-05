/**
 * The direct bootstrap adapters (TD-5 option (c), shadow/bootstrap only).
 *
 * TD-5 sanctions these **only** for shadow stages, and sets their retirement
 * boundary: at cross-repo contract C6, before any prospect-facing effect, the
 * capability layer switches to bounded legacy-side read APIs and these are
 * retired from effect-serving paths. Nothing above this file knows which of the
 * two is answering - that is the point of the port.
 *
 * Two properties this file must keep:
 *
 *   * **read-only by construction.** Neither adapter exposes a write, and
 *     neither driver object escapes the module - a caller receives the narrow
 *     reader port, not a `Firestore` or a `MongoClient` it could write with.
 *   * **loaded lazily.** The drivers are imported at first use, so a build that
 *     never enables the gateway never pulls them in, and `flags off => inert`
 *     stays true down to the module graph.
 */
import {
  APPOINTMENT_SCAN_LIMIT,
  type LegacyFirestoreReader,
  type LegacyMongoReader,
  type RawDocument,
} from "./source-clients";

// Structural types for the two drivers. Declared here rather than imported so
// this module type-checks without the drivers present, and so nothing wider
// than these calls is reachable through them.
interface FirestoreDocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface FirestoreQuerySnapshot {
  docs: FirestoreDocumentSnapshot[];
}
interface FirestoreQueryRef {
  get(): Promise<FirestoreQuerySnapshot>;
}
interface FirestoreCollectionRef {
  doc(id: string): FirestoreDocumentRef;
  limit(n: number): FirestoreQueryRef;
  get(): Promise<FirestoreQuerySnapshot>;
}
interface FirestoreDocumentRef {
  get(): Promise<FirestoreDocumentSnapshot>;
  collection(id: string): FirestoreCollectionRef;
}
interface FirestoreLike {
  collection(id: string): FirestoreCollectionRef;
}

interface MongoCollectionLike {
  find(filter: Record<string, unknown>): {
    limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> };
  };
}
interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): { collection(name: string): MongoCollectionLike };
  close(): Promise<void>;
}

/**
 * Every adapter credential carries a `fingerprint`: a non-secret digest of the
 * effective material, produced by the credential store.
 *
 * It is what makes rotation work. Driver instances are expensive and hold
 * connection pools, so they are cached - but a cache keyed on the Organization
 * alone would keep serving reads through the OLD client after a credential was
 * replaced and re-proven, until someone restarted the process. Keying on the
 * fingerprint too means a replaced credential simply does not match the cached
 * client, and the stale one is evicted.
 */
export interface FirestoreAdapterCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  fingerprint: string;
}

export interface MongoAdapterCredentials {
  uri: string;
  database: string;
  fingerprint: string;
}

export interface CacheEntry<T> {
  fingerprint: string;
  client: T;
}

/**
 * One entry per Organization, holding the fingerprint it was built from. Never
 * the credential material, and the fingerprint stays internal to this map - it
 * is a one-way digest, but it belongs in a cache key, not in a log line.
 */
const firestoreCache = new Map<string, CacheEntry<FirestoreLike>>();
const mongoCache = new Map<string, CacheEntry<MongoClientLike>>();

/**
 * The one place cache reuse and rotation are decided, shared by both adapters.
 *
 * Reuse when the fingerprint matches; otherwise retire the stale client —
 * disposing it first where the driver owns resources — and build a new one.
 * Both loaders go through this, so rotation cannot be correct for one store and
 * quietly wrong for the other.
 *
 * Exported for the rotation selftest, which drives it with instrumented fakes
 * so the contract is proven without constructing a real driver or opening a
 * socket. Not re-exported from the module index.
 */
export async function withRotationAwareCache<T>(
  cache: Map<string, CacheEntry<T>>,
  params: {
    organizationId: string;
    fingerprint: string;
    label: string;
    create: () => Promise<T>;
    dispose?: (client: T) => Promise<void>;
  }
): Promise<T> {
  const cached = cache.get(params.organizationId);
  if (cached) {
    if (cached.fingerprint === params.fingerprint) return cached.client;
    cache.delete(params.organizationId);
    console.warn(
      `[legacy-gateway] ${params.label} credential rotated for organization ` +
        `${params.organizationId}; the cached client is retired`
    );
    if (params.dispose) {
      await params.dispose(cached.client).catch((error: unknown) => {
        console.error(
          `[legacy-gateway] disposing the rotated ${params.label} client failed:`,
          error
        );
      });
    }
  }
  const client = await params.create();
  cache.set(params.organizationId, { fingerprint: params.fingerprint, client });
  return client;
}

async function loadFirestore(
  organizationId: string,
  credentials: FirestoreAdapterCredentials
): Promise<FirestoreLike> {
  return withRotationAwareCache(firestoreCache, {
    organizationId,
    fingerprint: credentials.fingerprint,
    label: "firestore",
    // Firestore clients hold HTTP/2 channels rather than a pool this module
    // owns, and the driver exposes no close on the surface used here, so a
    // retired instance is dropped for garbage collection. What matters is that
    // it stops serving reads.
    create: async () => {
      const moduleName = "@google-cloud/firestore";
      const imported = (await import(/* webpackIgnore: true */ moduleName)) as {
        Firestore: new (options: Record<string, unknown>) => FirestoreLike;
      };
      return new imported.Firestore({
        projectId: credentials.projectId,
        credentials: {
          client_email: credentials.clientEmail,
          // Key material arrives with escaped newlines when it round-trips
          // through an environment variable; the driver needs the real ones.
          private_key: credentials.privateKey.replace(/\\n/g, "\n"),
        },
      });
    },
  });
}

async function loadMongo(
  organizationId: string,
  credentials: MongoAdapterCredentials
): Promise<MongoClientLike> {
  return withRotationAwareCache(mongoCache, {
    organizationId,
    fingerprint: credentials.fingerprint,
    label: "mongo",
    // A Mongo client owns a real connection pool, so a retired one is CLOSED
    // rather than abandoned — dropping it would leak sockets that still
    // authenticate with the retired credential.
    dispose: (client) => client.close(),
    create: async () => {
      const moduleName = "mongodb";
      const imported = (await import(/* webpackIgnore: true */ moduleName)) as {
        MongoClient: new (
          uri: string,
          options?: Record<string, unknown>
        ) => MongoClientLike;
      };
      const client = new imported.MongoClient(credentials.uri, {
        serverSelectionTimeoutMS: 15000,
        // The bootstrap identity is read-only at the provider; asking for a
        // secondary keeps the read off the primary's back as well.
        readPreference: "secondaryPreferred",
      });
      await client.connect();
      return client;
    },
  });
}

function toRawDocument(snapshot: FirestoreDocumentSnapshot): RawDocument | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!data) return null;
  return { id: snapshot.id, data };
}

/**
 * Firestore reader. Every method names one allowlisted path; there is
 * deliberately no method that accepts a collection name.
 */
export function createFirestoreReader(params: {
  organizationId: string;
  credentials: FirestoreAdapterCredentials;
}): LegacyFirestoreReader {
  const db = () => loadFirestore(params.organizationId, params.credentials);
  return {
    async getLead(legacyLeadId) {
      const snapshot = await (await db()).collection("leads").doc(legacyLeadId).get();
      return toRawDocument(snapshot);
    },
    async getUser(legacyUserId) {
      const snapshot = await (await db()).collection("users").doc(legacyUserId).get();
      return toRawDocument(snapshot);
    },
    async getProperty(legacyPropertyId) {
      const snapshot = await (await db())
        .collection("properties")
        .doc(legacyPropertyId)
        .get();
      return toRawDocument(snapshot);
    },
    async listConversationThreads(legacyLeadId) {
      const snapshot = await (await db())
        .collection("leads")
        .doc(legacyLeadId)
        .collection("wsp_messeges")
        .get();
      return snapshot.docs
        .map(toRawDocument)
        .filter((document): document is RawDocument => document !== null);
    },
    async listDealAppointments(legacyDealId) {
      // Bounded, and deliberately one past the bound: the capability needs to
      // be able to tell "complete" from "there are more than we support".
      const snapshot = await (await db())
        .collection("deals")
        .doc(legacyDealId)
        .collection("appointments")
        .limit(APPOINTMENT_SCAN_LIMIT + 1)
        .get();
      return snapshot.docs
        .map(toRawDocument)
        .filter((document): document is RawDocument => document !== null);
    },
  };
}

export function createMongoReader(params: {
  organizationId: string;
  credentials: MongoAdapterCredentials;
}): LegacyMongoReader {
  return {
    async findAppointmentsByDeal(legacyDealId) {
      const client = await loadMongo(params.organizationId, params.credentials);
      const documents = await client
        .db(params.credentials.database)
        .collection("appointments")
        .find({ deal_id: legacyDealId })
        // One past the bound, for the same reason as the Firestore side.
        .limit(APPOINTMENT_SCAN_LIMIT + 1)
        .toArray();
      return documents.map((document) => ({
        id: String(document._id),
        data: document,
      }));
    },
  };
}

/** Closes cached driver connections. For scripts and tests, not request paths. */
export async function closeLegacySourceConnections(): Promise<void> {
  firestoreCache.clear();
  const entries = [...mongoCache.values()];
  mongoCache.clear();
  await Promise.all(
    entries.map((entry) =>
      entry.client.close().catch((error: unknown) => {
        console.error("[legacy-gateway] mongo close failed:", error);
      })
    )
  );
}

/**
 * Test seam: what the caches currently hold, by fingerprint. Exposed so the
 * rotation contract can be asserted deterministically without reaching into
 * module internals, and deliberately not exported from the module index.
 */
export function inspectAdapterCaches(): {
  firestore: Array<{ organizationId: string; fingerprint: string }>;
  mongo: Array<{ organizationId: string; fingerprint: string }>;
} {
  return {
    firestore: [...firestoreCache.entries()].map(([organizationId, entry]) => ({
      organizationId,
      fingerprint: entry.fingerprint,
    })),
    mongo: [...mongoCache.entries()].map(([organizationId, entry]) => ({
      organizationId,
      fingerprint: entry.fingerprint,
    })),
  };
}
