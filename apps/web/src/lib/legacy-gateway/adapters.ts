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
import type {
  LegacyFirestoreReader,
  LegacyMongoReader,
  RawDocument,
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
interface FirestoreCollectionRef {
  doc(id: string): FirestoreDocumentRef;
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

export interface FirestoreAdapterCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface MongoAdapterCredentials {
  uri: string;
  database: string;
}

/**
 * Driver instances are expensive and hold connection pools, so they are cached
 * per Organization for the process lifetime. The cache key is the Organization
 * id, never credential material.
 */
const firestoreCache = new Map<string, FirestoreLike>();
const mongoCache = new Map<string, MongoClientLike>();

async function loadFirestore(
  organizationId: string,
  credentials: FirestoreAdapterCredentials
): Promise<FirestoreLike> {
  const cached = firestoreCache.get(organizationId);
  if (cached) return cached;
  const moduleName = "@google-cloud/firestore";
  const imported = (await import(/* webpackIgnore: true */ moduleName)) as {
    Firestore: new (options: Record<string, unknown>) => FirestoreLike;
  };
  const instance = new imported.Firestore({
    projectId: credentials.projectId,
    credentials: {
      client_email: credentials.clientEmail,
      // Key material arrives with escaped newlines when it round-trips through
      // an environment variable; the driver needs the real ones.
      private_key: credentials.privateKey.replace(/\\n/g, "\n"),
    },
  });
  firestoreCache.set(organizationId, instance);
  return instance;
}

async function loadMongo(
  organizationId: string,
  credentials: MongoAdapterCredentials
): Promise<MongoClientLike> {
  const cached = mongoCache.get(organizationId);
  if (cached) return cached;
  const moduleName = "mongodb";
  const imported = (await import(/* webpackIgnore: true */ moduleName)) as {
    MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike;
  };
  const client = new imported.MongoClient(credentials.uri, {
    serverSelectionTimeoutMS: 15000,
    // The bootstrap identity is read-only at the provider; asking for a
    // secondary keeps the read off the primary's back as well.
    readPreference: "secondaryPreferred",
  });
  await client.connect();
  mongoCache.set(organizationId, client);
  return client;
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
      const snapshot = await (await db())
        .collection("deals")
        .doc(legacyDealId)
        .collection("appointments")
        .get();
      return snapshot.docs
        .map(toRawDocument)
        .filter((document): document is RawDocument => document !== null);
    },
  };
}

const MONGO_APPOINTMENT_SCAN_LIMIT = 200;

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
        .limit(MONGO_APPOINTMENT_SCAN_LIMIT)
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
  const clients = [...mongoCache.values()];
  mongoCache.clear();
  await Promise.all(
    clients.map((client) =>
      client.close().catch((error: unknown) => {
        console.error("[legacy-gateway] mongo close failed:", error);
      })
    )
  );
}
