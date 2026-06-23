import type { DbClient } from "../client";

export interface ExternalContactLinkToken {
  id: string;
  case_id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used: boolean;
  verified_chat_id: number | null;
  created_at: string;
  verified_at: string | null;
}

export async function createExternalContactLinkToken(
  db: DbClient,
  params: {
    caseId: string;
    userId: string;
    token: string;
    expiresAt: string;
  }
): Promise<ExternalContactLinkToken> {
  const { data, error } = await db
    .from("external_contact_link_tokens")
    .insert({
      case_id: params.caseId,
      user_id: params.userId,
      token: params.token,
      expires_at: params.expiresAt,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ExternalContactLinkToken;
}

export async function getExternalContactLinkTokenByToken(
  db: DbClient,
  token: string
): Promise<ExternalContactLinkToken | null> {
  const { data, error } = await db
    .from("external_contact_link_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  return (data as ExternalContactLinkToken | null) ?? null;
}

export async function markExternalContactLinkTokenUsed(
  db: DbClient,
  params: { id: string; verifiedChatId: number }
): Promise<ExternalContactLinkToken | null> {
  const { data, error } = await db
    .from("external_contact_link_tokens")
    .update({
      used: true,
      verified_chat_id: params.verifiedChatId,
      verified_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as ExternalContactLinkToken | null) ?? null;
}
