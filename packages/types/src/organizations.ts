/**
 * Organization-native tenancy (ADR-106 / Technical Plan TD-1, TD-2b).
 *
 * Two rules shape everything here:
 *   * identity is not authorization — a membership row proves who belongs,
 *     `status: "active"` decides what they may do, and that is re-checked at
 *     action time, never cached into a binding or a claim;
 *   * external identifiers are opaque — stored and compared whole, never parsed.
 */

export type OrganizationStatus = "active" | "inactive";

/**
 * Initial role vocabulary, mapped at migration time from the legacy
 * super-admin / admin / vendedor triple. This is the R1 migration vocabulary,
 * NOT the permanent authorization model (R3 owns that).
 */
export type OrganizationRole = "owner" | "org_admin" | "advisor";

/**
 * Soft lifecycle: membership rows are never hard-deleted so historical identity
 * and provenance references stay resolvable. Deactivation flips this instead.
 */
export type MembershipStatus = "active" | "inactive";

export interface Organization {
  id: string;
  name: string;
  status: OrganizationStatus;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMembership {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  status: MembershipStatus;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  organization_id: string;
  display_name: string | null;
  primary_phone_hint: string | null;
  /** Contact-scoped preferences, each entry carrying its own provenance (S2). */
  preferences_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================================
// External identity bindings
// ============================================================

export type ExternalSourceSystem = "traditional_gu";

export type ExternalBindingKind =
  | "legacy_organization_key"
  | "legacy_user"
  | "gu_whatsapp_number"
  | "advisor_whatsapp_endpoint"
  | "legacy_lead"
  | "prospect_channel";

/**
 * `global_routing` kinds must resolve to exactly ONE Organization across the
 * whole platform, because inbound event routing cannot be ambiguous — they
 * carry an extra global partial unique index. Kinds that the source system does
 * not guarantee to be Organization-exclusive stay `organization_scoped`.
 *
 * This registry mirrors the partial unique index in the bindings migration;
 * changing one without the other is a bug.
 */
export type ExternalBindingUniqueness = "global_routing" | "organization_scoped";

export const EXTERNAL_BINDING_KINDS: Record<
  ExternalBindingKind,
  ExternalBindingUniqueness
> = {
  legacy_organization_key: "global_routing",
  legacy_user: "global_routing",
  gu_whatsapp_number: "global_routing",
  legacy_lead: "global_routing",
  advisor_whatsapp_endpoint: "organization_scoped",
  prospect_channel: "organization_scoped",
};

export interface ExternalIdentityBinding {
  id: string;
  organization_id: string;
  source_system: ExternalSourceSystem;
  binding_kind: ExternalBindingKind;
  /** Opaque. Composite legacy identities are stored and compared whole. */
  external_id: string;
  ref_organization_id: string | null;
  ref_membership_id: string | null;
  ref_contact_id: string | null;
  ref_case_id: string | null;
  verification_jsonb: Record<string, unknown>;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Organization-scoped rollout flags (TD-2b)
// ============================================================

/**
 * Every authority-bearing R1 flag resolves at Organization scope only — never
 * per member and never with a per-user fallback, so two advisors of the same
 * Organization can never observe conflicting authority behavior.
 * `account_feature_flags` remains for genuinely user-scoped features; env vars
 * remain global kill-switches.
 */
export const ORGANIZATION_FLAG_KEYS = {
  relationshipOps: "relationship_ops",
  admissionMode: "relationship_admission_mode",
  sendEffects: "relationship_send_effects",
  appointmentEffects: "relationship_appointment_effects",
  runtimeAuthorityTransfer: "relationship_runtime_authority_transfer",
  legacyEventIngestion: "legacy_event_ingestion",
} as const;

export type OrganizationFlagKey =
  (typeof ORGANIZATION_FLAG_KEYS)[keyof typeof ORGANIZATION_FLAG_KEYS];

export type RelationshipAdmissionMode = "shadow" | "assisted" | "live";
export type RelationshipEffectMode = "off" | "approval_only" | "policy";
export type RuntimeAuthorityTransferMode = "off" | "selected";
export type LegacyEventIngestionMode = "poll" | "webhook";

export interface OrganizationFeatureFlag {
  id: string;
  organization_id: string;
  flag_key: string;
  enabled: boolean;
  value_text: string | null;
  created_at: string;
  updated_at: string;
}

export type OrganizationToolSecretStatus =
  | "pending_test"
  | "active"
  | "invalid"
  | "disconnected";

export interface OrganizationToolSecret {
  id: string;
  organization_id: string;
  provider: string;
  config_jsonb: Record<string, unknown>;
  encrypted_secret_jsonb: string;
  status: OrganizationToolSecretStatus;
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Runtime authority (ADR-107 / TD-3)
// ============================================================

/**
 * Per-Opportunity runtime decision authority. Set only by an authorized
 * governed operation — never implied by Case creation.
 */
export type RuntimeAuthority = "legacy" | "gu_os";
