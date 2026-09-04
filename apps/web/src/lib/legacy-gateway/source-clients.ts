/**
 * Ports for the two bootstrap source stores.
 *
 * These interfaces are narrow on purpose. They expose exactly the reads the
 * four capabilities perform and nothing that could be composed into a generic
 * CRUD surface: there is no `query(collection, filter)`, no `list()`, no
 * `write()`. A new read shape means a new named method, reviewed against the
 * allowlist - which is the point.
 *
 * Capabilities depend on these interfaces rather than on the drivers, so the
 * whole capability layer is testable against recorded fixtures with no network,
 * and so the C6 handover replaces implementations without touching capability
 * code.
 */

/** A raw source document plus the path it came from, for provenance. */
export interface RawDocument {
  /** Document id as the store reports it. Opaque. */
  id: string;
  data: Record<string, unknown>;
}

export interface LegacyFirestoreReader {
  /** `leads/{legacyLeadId}` */
  getLead(legacyLeadId: string): Promise<RawDocument | null>;
  /** `users/{legacyUserId}` - owner resolution only. */
  getUser(legacyUserId: string): Promise<RawDocument | null>;
  /** `properties/{legacyPropertyId}` */
  getProperty(legacyPropertyId: string): Promise<RawDocument | null>;
  /**
   * `leads/{legacyLeadId}/wsp_messeges` - every thread document for the lead.
   * The whole set, because thread membership is part of what SA-1.3 asserts.
   */
  listConversationThreads(legacyLeadId: string): Promise<RawDocument[]>;
  /** `deals/{legacyDealId}/appointments` */
  listDealAppointments(legacyDealId: string): Promise<RawDocument[]>;
}

export interface LegacyMongoReader {
  /** `gu2.appointments` filtered to one deal. */
  findAppointmentsByDeal(legacyDealId: string): Promise<RawDocument[]>;
}

/**
 * What a capability is handed. Mongo is optional because only one capability
 * needs it, and a Mongo outage must not take down the three that do not.
 */
export interface LegacySourceReaders {
  firestore: LegacyFirestoreReader;
  mongo: LegacyMongoReader | null;
}
