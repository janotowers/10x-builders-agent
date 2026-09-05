import {
  EXTERNAL_BINDING_KINDS,
  type ExternalBindingKind,
  type ExternalIdentityBinding,
  type ExternalSourceSystem,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * The Traditional Gu ↔ Gu OS identity bridge (ADR-106 / Technical Plan TD-1).
 *
 * Three invariants this module keeps:
 *   * external ids are OPAQUE — compared whole, never parsed into components;
 *   * a binding is routing/identity/provenance data and NEVER an authority
 *     grant, so resolving one only tells you which Organization to authorize
 *     against; the caller still runs the membership/authority/policy gates;
 *   * exactly one typed reference per row, checked here as well as by the
 *     database, so a malformed binding fails before it reaches the constraint.
 */

export type BindingReference =
  | { kind: "organization"; id: string }
  | { kind: "membership"; id: string }
  | { kind: "contact"; id: string }
  | { kind: "case"; id: string };

function referenceColumns(ref: BindingReference): Record<string, string> {
  switch (ref.kind) {
    case "organization":
      return { ref_organization_id: ref.id };
    case "membership":
      return { ref_membership_id: ref.id };
    case "contact":
      return { ref_contact_id: ref.id };
    case "case":
      return { ref_case_id: ref.id };
  }
}

/**
 * Resolves the Organization that owns a routing-critical external identifier.
 *
 * Only defined for `global_routing` kinds: inbound event routing must map an
 * external id to exactly one Organization, and those kinds carry a global
 * partial unique index that guarantees it. Calling this with an
 * Organization-scoped kind is a programming error, because the answer would be
 * ambiguous across tenants.
 */
export async function resolveOrganizationByExternalId(
  db: DbClient,
  params: {
    sourceSystem: ExternalSourceSystem;
    bindingKind: ExternalBindingKind;
    externalId: string;
  }
): Promise<ExternalIdentityBinding | null> {
  if (EXTERNAL_BINDING_KINDS[params.bindingKind] !== "global_routing") {
    throw new Error(
      `resolveOrganizationByExternalId: ${params.bindingKind} is Organization-scoped; ` +
        "resolve it within a known Organization instead."
    );
  }
  const { data, error } = await db
    .from("external_identity_bindings")
    .select("*")
    .eq("source_system", params.sourceSystem)
    .eq("binding_kind", params.bindingKind)
    .eq("external_id", params.externalId)
    .maybeSingle();
  if (error) throw error;
  return (data as ExternalIdentityBinding) ?? null;
}

export async function findBindingInOrganization(
  db: DbClient,
  params: {
    organizationId: string;
    sourceSystem: ExternalSourceSystem;
    bindingKind: ExternalBindingKind;
    externalId: string;
  }
): Promise<ExternalIdentityBinding | null> {
  const { data, error } = await db
    .from("external_identity_bindings")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("source_system", params.sourceSystem)
    .eq("binding_kind", params.bindingKind)
    .eq("external_id", params.externalId)
    .maybeSingle();
  if (error) throw error;
  return (data as ExternalIdentityBinding) ?? null;
}

export async function listBindingsForCase(
  db: DbClient,
  caseId: string
): Promise<ExternalIdentityBinding[]> {
  const { data, error } = await db
    .from("external_identity_bindings")
    .select("*")
    .eq("ref_case_id", caseId);
  if (error) throw error;
  return (data ?? []) as ExternalIdentityBinding[];
}

export async function listBindingsForContact(
  db: DbClient,
  contactId: string
): Promise<ExternalIdentityBinding[]> {
  const { data, error } = await db
    .from("external_identity_bindings")
    .select("*")
    .eq("ref_contact_id", contactId);
  if (error) throw error;
  return (data ?? []) as ExternalIdentityBinding[];
}

/**
 * Idempotent attach: re-discovering the same external identity is a no-op, not
 * an error, so ingestion can replay safely. Cross-tenant references are
 * impossible by construction — the composite foreign keys reject a reference to
 * another Organization's contact, membership or Case.
 */
export async function attachExternalIdentityBinding(
  db: DbClient,
  params: {
    organizationId: string;
    sourceSystem: ExternalSourceSystem;
    bindingKind: ExternalBindingKind;
    externalId: string;
    reference: BindingReference;
    verification?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  }
): Promise<ExternalIdentityBinding | null> {
  const externalId = params.externalId?.trim();
  if (!externalId) {
    throw new Error("attachExternalIdentityBinding: externalId is required");
  }

  const { error } = await db.from("external_identity_bindings").upsert(
    {
      organization_id: params.organizationId,
      source_system: params.sourceSystem,
      binding_kind: params.bindingKind,
      external_id: externalId,
      ...referenceColumns(params.reference),
      verification_jsonb: params.verification ?? {},
      provenance_jsonb: params.provenance ?? {},
    },
    {
      onConflict: "organization_id,source_system,binding_kind,external_id",
      ignoreDuplicates: true,
    }
  );
  if (error) throw error;

  return findBindingInOrganization(db, {
    organizationId: params.organizationId,
    sourceSystem: params.sourceSystem,
    bindingKind: params.bindingKind,
    externalId,
  });
}

/**
 * Every binding of one kind held by an Organization.
 *
 * Added for the SL-1 gateway's pre-read gate: before any legacy source is
 * touched, the gateway must establish that the calling Organization is bound to
 * that source system at all. That question is asked Organization-first, so it
 * cannot be answered by `findBindingInOrganization`, which needs the external id
 * up front.
 *
 * Organization-scoped by construction, and never an authority grant: it tells
 * you which external identities an Organization owns, not what may be done with
 * them.
 */
export async function listOrganizationBindingsOfKind(
  db: DbClient,
  params: {
    organizationId: string;
    sourceSystem: ExternalSourceSystem;
    bindingKind: ExternalBindingKind;
  }
): Promise<ExternalIdentityBinding[]> {
  const { data, error } = await db
    .from("external_identity_bindings")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("source_system", params.sourceSystem)
    .eq("binding_kind", params.bindingKind);
  if (error) throw error;
  return (data ?? []) as ExternalIdentityBinding[];
}
