/**
 * Organization-scoped provider credentials (`organization_tool_secrets`,
 * migration 00080; Technical Plan TD-1 / TD-5, R1 SL-1).
 *
 * The table landed with SL-0 but had no code path at all. This module is the
 * whole Organization-scoped half of the credential boundary, and it is
 * deliberately NOT a copy of `account-tool-secrets.ts`: that one is
 * **user-scoped** and readable by its owner's JWT. This one is service-role
 * only in both directions, so nothing here has a browser or user-JWT caller.
 *
 * Rules the shapes below enforce:
 *   * **Explicit `organizationId` on every function.** Never inferred from a
 *     session, a binding row or an ambient tenant.
 *   * **The secret never leaves the server.** `PUBLIC_COLUMNS` cannot select
 *     `encrypted_secret_jsonb`, and the one function that decrypts refuses to
 *     run anywhere a `window` exists.
 *   * **Providers are a closed vocabulary with validated shapes.** An unknown
 *     provider, or a known provider with material that does not parse, is
 *     rejected at write time rather than discovered at read time by an adapter.
 *   * **`pending_test -> active` is an explicit transition**, driven by a real
 *     connection check. A stored credential is never assumed usable.
 */
import type {
  OrganizationToolSecret,
  OrganizationToolSecretProvider,
  OrganizationToolSecretStatus,
} from "@agents/types";
import { ORGANIZATION_TOOL_SECRET_PROVIDERS } from "@agents/types";
import type { DbClient } from "../client";
import { decryptJson, encryptJson } from "../crypto";

/**
 * Everything except `encrypted_secret_jsonb`. Kept as a literal so a future
 * `select("*")` cannot quietly widen what a caller receives.
 */
const PUBLIC_COLUMNS =
  "id,organization_id,provider,config_jsonb,status,last_checked_at,last_used_at,last_error,created_at,updated_at";

export type OrganizationToolSecretPublic = Omit<
  OrganizationToolSecret,
  "encrypted_secret_jsonb"
>;

// ============================================================
// Provider contracts
// ============================================================

/**
 * Firestore bootstrap identity. The service-account private key is the only
 * secret component; the project and the client email are identity metadata and
 * live in `config_jsonb`, because knowing *which* identity is bound is an
 * operational question that must be answerable without decrypting anything.
 */
export interface TraditionalGuFirestoreSecret {
  private_key: string;
}

export interface TraditionalGuFirestoreConfig {
  project_id: string;
  client_email: string;
}

/**
 * Mongo bootstrap identity. The connection string carries the password, so the
 * whole URI is secret and `config_jsonb` keeps only the redacted host and the
 * database the SL-1 appointment capability is scoped to.
 */
export interface TraditionalGuMongoSecret {
  uri: string;
}

export interface TraditionalGuMongoConfig {
  database: string;
  /** Host only, no credentials. Recorded so the cluster is identifiable. */
  host: string;
}

export class OrganizationToolSecretValidationError extends Error {
  constructor(
    readonly provider: string,
    readonly problem: string
  ) {
    super(`invalid ${provider} credential material: ${problem}`);
    this.name = "OrganizationToolSecretValidationError";
  }
}

export function isOrganizationToolSecretProvider(
  value: string
): value is OrganizationToolSecretProvider {
  return (ORGANIZATION_TOOL_SECRET_PROVIDERS as readonly string[]).includes(
    value
  );
}

function requireString(
  provider: string,
  source: Record<string, unknown>,
  key: string
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new OrganizationToolSecretValidationError(
      provider,
      `${key} is missing or empty`
    );
  }
  return value.trim();
}

/**
 * Parses a Google service-account JSON into the split config/secret pair.
 *
 * Takes the already-parsed object rather than a path: reading the file is the
 * caller's business, and keeping I/O out of here means the validation is
 * testable without ever touching real key material.
 */
export function parseTraditionalGuFirestoreMaterial(material: unknown): {
  config: TraditionalGuFirestoreConfig;
  secret: TraditionalGuFirestoreSecret;
} {
  const provider = "traditional_gu_firestore";
  if (!material || typeof material !== "object" || Array.isArray(material)) {
    throw new OrganizationToolSecretValidationError(
      provider,
      "expected a service-account JSON object"
    );
  }
  const source = material as Record<string, unknown>;
  if (source.type !== "service_account") {
    throw new OrganizationToolSecretValidationError(
      provider,
      `expected type "service_account", got ${JSON.stringify(source.type ?? null)}`
    );
  }
  const privateKey = requireString(provider, source, "private_key");
  if (!privateKey.includes("PRIVATE KEY")) {
    // Never echo the value; say only what is wrong with its shape.
    throw new OrganizationToolSecretValidationError(
      provider,
      "private_key does not look like a PEM private key"
    );
  }
  return {
    config: {
      project_id: requireString(provider, source, "project_id"),
      client_email: requireString(provider, source, "client_email"),
    },
    secret: { private_key: privateKey },
  };
}

/**
 * Validates a Mongo connection string and derives its redacted metadata.
 *
 * The database is supplied explicitly rather than parsed out of the URI path:
 * SL-1 reads exactly one database, and an operator pointing the URI elsewhere
 * should fail a comparison, not silently redefine the scope.
 */
export function parseTraditionalGuMongoMaterial(material: {
  uri: unknown;
  database: unknown;
}): {
  config: TraditionalGuMongoConfig;
  secret: TraditionalGuMongoSecret;
} {
  const provider = "traditional_gu_mongo";
  const uri = requireString(provider, { uri: material.uri }, "uri");
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new OrganizationToolSecretValidationError(
      provider,
      "uri must start with mongodb:// or mongodb+srv://"
    );
  }
  const database = requireString(
    provider,
    { database: material.database },
    "database"
  );
  let host: string;
  try {
    // `mongodb+srv://user:pass@host/...` parses as a URL; the password never
    // leaves this scope because only the host is kept.
    host = new URL(uri).host;
  } catch {
    throw new OrganizationToolSecretValidationError(
      provider,
      "uri is not parseable"
    );
  }
  if (!host) {
    throw new OrganizationToolSecretValidationError(
      provider,
      "uri carries no host"
    );
  }
  return { config: { database, host }, secret: { uri } };
}

// ============================================================
// Reads (metadata only)
// ============================================================

export async function listOrganizationToolSecretsPublic(
  db: DbClient,
  organizationId: string
): Promise<OrganizationToolSecretPublic[]> {
  const { data, error } = await db
    .from("organization_tool_secrets")
    .select(PUBLIC_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrganizationToolSecretPublic[];
}

export async function getOrganizationToolSecretPublic(
  db: DbClient,
  params: { organizationId: string; provider: OrganizationToolSecretProvider }
): Promise<OrganizationToolSecretPublic | null> {
  const { data, error } = await db
    .from("organization_tool_secrets")
    .select(PUBLIC_COLUMNS)
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationToolSecretPublic | null) ?? null;
}

// ============================================================
// Writes
// ============================================================

export interface UpsertOrganizationToolSecretInput {
  organizationId: string;
  provider: OrganizationToolSecretProvider;
  /** Non-sensitive metadata. Readable without decrypting anything. */
  config: Record<string, unknown>;
  /** Plain secret material; encrypted here and never stored in the clear. */
  secret: Record<string, unknown>;
}

/**
 * Stores or replaces a provider credential.
 *
 * Always lands as `pending_test`, including on replacement: new material has
 * not been proven to work, and inheriting `active` from the row it replaced
 * would assert exactly what has not been checked.
 */
export async function upsertOrganizationToolSecret(
  db: DbClient,
  input: UpsertOrganizationToolSecretInput
): Promise<OrganizationToolSecretPublic> {
  if (!input.organizationId?.trim()) {
    throw new Error(
      "upsertOrganizationToolSecret: organizationId is required (never inferred)"
    );
  }
  if (!isOrganizationToolSecretProvider(input.provider)) {
    throw new OrganizationToolSecretValidationError(
      String(input.provider),
      "unknown provider"
    );
  }
  if (!input.secret || Object.keys(input.secret).length === 0) {
    throw new OrganizationToolSecretValidationError(
      input.provider,
      "refusing to store an empty secret"
    );
  }
  const row = {
    organization_id: input.organizationId,
    provider: input.provider,
    config_jsonb: input.config ?? {},
    encrypted_secret_jsonb: encryptJson(input.secret),
    status: "pending_test" as OrganizationToolSecretStatus,
    last_error: null,
    last_checked_at: null,
  };
  const { data, error } = await db
    .from("organization_tool_secrets")
    .upsert(row, { onConflict: "organization_id,provider" })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw error;
  return data as OrganizationToolSecretPublic;
}

/**
 * The `pending_test -> active` transition, and its failure counterpart.
 *
 * Called only by a caller that actually reached the provider. `ok: false`
 * records `invalid` with the reason, so a broken credential is visible as
 * broken instead of retried blindly by every adapter that touches it.
 */
export async function markOrganizationToolSecretTested(
  db: DbClient,
  params: {
    organizationId: string;
    provider: OrganizationToolSecretProvider;
    ok: boolean;
    error?: string | null;
  }
): Promise<OrganizationToolSecretPublic | null> {
  const { data, error } = await db
    .from("organization_tool_secrets")
    .update({
      status: params.ok ? "active" : "invalid",
      last_error: params.ok ? null : (params.error ?? "connection check failed"),
      last_checked_at: new Date().toISOString(),
    })
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationToolSecretPublic | null) ?? null;
}

/** Records a successful use without changing status. */
export async function touchOrganizationToolSecretUsed(
  db: DbClient,
  params: { organizationId: string; provider: OrganizationToolSecretProvider }
): Promise<void> {
  const { error } = await db
    .from("organization_tool_secrets")
    .update({ last_used_at: new Date().toISOString() })
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider);
  if (error) throw error;
}

/**
 * Retirement path. Blanks the ciphertext rather than deleting the row, so the
 * provenance of what was once bound survives while no material stays at rest.
 *
 * This is how the TD-5 bootstrap credentials retire at the C6 transition.
 */
export async function disconnectOrganizationToolSecret(
  db: DbClient,
  params: { organizationId: string; provider: OrganizationToolSecretProvider }
): Promise<OrganizationToolSecretPublic | null> {
  const { data, error } = await db
    .from("organization_tool_secrets")
    .update({
      status: "disconnected",
      encrypted_secret_jsonb: "",
      last_error: null,
    })
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationToolSecretPublic | null) ?? null;
}

// ============================================================
// Runtime (server-only)
// ============================================================

export interface OrganizationToolSecretRuntime<
  TSecret = Record<string, unknown>,
  TConfig = Record<string, unknown>,
> {
  config: TConfig;
  secret: TSecret;
  status: OrganizationToolSecretStatus;
}

/**
 * Decrypts a credential for an adapter. The only function here that can produce
 * secret material, and the only one that must never be reachable from a browser
 * bundle - hence the explicit environment assertion rather than a comment.
 *
 * Returns `null` (rather than throwing) when the credential is absent,
 * disconnected, blank or undecryptable: from an adapter's point of view all
 * four mean "no usable credential", and the caller fails closed the same way.
 */
export async function getOrganizationToolSecretForRuntime<
  TSecret = Record<string, unknown>,
  TConfig = Record<string, unknown>,
>(
  db: DbClient,
  params: {
    organizationId: string;
    provider: OrganizationToolSecretProvider;
    /** Refuse anything but `active`. Default allows `pending_test` too, so a
     *  connection check can use the credential it is about to validate. */
    requireActive?: boolean;
  }
): Promise<OrganizationToolSecretRuntime<TSecret, TConfig> | null> {
  if (typeof window !== "undefined") {
    throw new Error(
      "getOrganizationToolSecretForRuntime is server-only: organization credentials must never be resolved in a browser context"
    );
  }
  if (!params.organizationId?.trim()) {
    throw new Error(
      "getOrganizationToolSecretForRuntime: organizationId is required (never inferred)"
    );
  }
  const { data, error } = await db
    .from("organization_tool_secrets")
    .select("config_jsonb,encrypted_secret_jsonb,status")
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const status = data.status as OrganizationToolSecretStatus;
  if (status === "disconnected" || status === "invalid") return null;
  if (params.requireActive && status !== "active") return null;
  if (!data.encrypted_secret_jsonb) return null;
  let secret: TSecret;
  try {
    secret = decryptJson<TSecret>(data.encrypted_secret_jsonb);
  } catch {
    // Rotated key or corrupt payload: treat as absent so the credential is
    // reconfigured rather than half-used.
    return null;
  }
  return {
    config: (data.config_jsonb ?? {}) as TConfig,
    secret,
    status,
  };
}

/** Presence/identity summary safe to log. Never includes secret material. */
export function describeOrganizationToolSecret(
  row: OrganizationToolSecretPublic
): string {
  return (
    `provider=${row.provider} org=${row.organization_id} status=${row.status} ` +
    `checked=${row.last_checked_at ? "yes" : "never"}`
  );
}
