import type { Contact } from "@agents/types";
import type { DbClient } from "../client";

/**
 * Organization-scoped contacts (Technical Plan TD-1).
 *
 * Contact truth stays referential: there are no legacy-lead mirror fields here.
 * One contact may carry n `legacy_lead` bindings and participate in n
 * Opportunities, so external identity lives in `external_identity_bindings` and
 * this table stays a minimal, stable anchor.
 */

export async function getContactById(
  db: DbClient,
  organizationId: string,
  contactId: string
): Promise<Contact | null> {
  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  return (data as Contact) ?? null;
}

export async function listContactsForOrganization(
  db: DbClient,
  organizationId: string
): Promise<Contact[]> {
  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Contact[];
}

export async function createContact(
  db: DbClient,
  params: {
    organizationId: string;
    displayName?: string | null;
    primaryPhoneHint?: string | null;
    preferences?: Record<string, unknown>;
  }
): Promise<Contact> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      organization_id: params.organizationId,
      display_name: params.displayName ?? null,
      primary_phone_hint: params.primaryPhoneHint ?? null,
      preferences_jsonb: params.preferences ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Contact;
}

/**
 * Merges preference entries, preserving existing ones that are not named in the
 * patch. Preferences carry their own provenance per entry (S2), so callers pass
 * whole entries rather than bare values.
 */
export async function updateContactPreferences(
  db: DbClient,
  params: {
    organizationId: string;
    contactId: string;
    patch: Record<string, unknown>;
  }
): Promise<Contact> {
  const current = await getContactById(db, params.organizationId, params.contactId);
  if (!current) {
    throw new Error(
      `updateContactPreferences: contact ${params.contactId} not found in organization`
    );
  }
  const { data, error } = await db
    .from("contacts")
    .update({
      preferences_jsonb: { ...current.preferences_jsonb, ...params.patch },
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", params.organizationId)
    .eq("id", params.contactId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Contact;
}
