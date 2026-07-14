import { getAccountToolSecretForRuntime, type DbClient } from "@agents/db";

export type EasyBrokerListingSnapshot = {
  listing_id: string | null;
  public_id: string | null;
  internal_id: string | null;
  status: string | null;
  title: string | null;
  description: string | null;
  image_count: number;
  image_titles: Array<string | null>;
  fields: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type UnggaListingSnapshot = {
  ungga_property_id: string;
  status: string | null;
  draft_url: string | null;
  published_url: string | null;
  image_count: number | null;
  raw: Record<string, unknown>;
};

export class AmbiguousRemoteListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousRemoteListingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function easyBrokerApiKey(db: DbClient, userId: string): Promise<string | null> {
  try {
    const account = await getAccountToolSecretForRuntime<{ api_key?: string }>(
      db,
      { userId, provider: "easybroker" }
    );
    const key = account?.secret?.api_key?.trim();
    if (key) return key;
  } catch {
    // Environment fallback preserves legacy accounts.
  }
  return process.env.EASYBROKER_API_KEY?.trim() || null;
}

async function unggaApiCredentials(
  db: DbClient,
  userId: string
): Promise<{ base: string; token: string } | null> {
  try {
    const account = await getAccountToolSecretForRuntime<{ api_token?: string }>(
      db,
      { userId, provider: "ungga_api" }
    );
    const base =
      typeof account?.config?.api_base === "string"
        ? account.config.api_base.trim()
        : "";
    const token = account?.secret?.api_token?.trim() ?? "";
    if (base && token) return { base, token };
  } catch {
    // Environment fallback preserves legacy accounts.
  }
  const base = process.env.UNGGA_INTERNAL_API_BASE?.trim() ?? "";
  const token = process.env.UNGGA_INTERNAL_API_TOKEN?.trim() ?? "";
  return base && token ? { base, token } : null;
}

export function easyBrokerSnapshot(
  payload: Record<string, unknown>
): EasyBrokerListingSnapshot {
  const images = Array.isArray(payload.images)
    ? payload.images.filter(isRecord)
    : [];
  const location = isRecord(payload.location) ? payload.location : {};
  const operations = Array.isArray(payload.operations)
    ? payload.operations.filter(isRecord)
    : [];
  return {
    listing_id:
      stringValue(payload.public_id) ??
      stringValue(payload.id) ??
      stringValue(payload.property_id),
    public_id: stringValue(payload.public_id),
    internal_id: stringValue(payload.internal_id),
    status:
      stringValue(payload.status) ??
      (stringValue(payload.published_at) ? "published" : "not_published"),
    title: stringValue(payload.title),
    description: stringValue(payload.description),
    image_count: images.length,
    image_titles: images.map((image) => stringValue(image.title)),
    fields: {
      property_type: payload.property_type ?? null,
      operations,
      location,
      bedrooms: payload.bedrooms ?? null,
      bathrooms: payload.bathrooms ?? null,
      parking_spaces: payload.parking_spaces ?? null,
      construction_size: payload.construction_size ?? null,
      lot_size: payload.lot_size ?? null,
    },
    raw: payload,
  };
}

async function easyBrokerGet(
  apiKey: string,
  pathname: string,
  query?: Record<string, string>
): Promise<Record<string, unknown>> {
  const base =
    process.env.EASYBROKER_API_BASE?.trim() || "https://api.easybroker.com";
  const url = new URL(pathname, base.replace(/\/$/, ""));
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "Country-Code": "MX",
      "X-Authorization": apiKey,
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(`easybroker_remote_read_${response.status}`);
  }
  return payload;
}

/**
 * Authoritative EasyBroker read used by media wait, preflight and reconciliation.
 * Internal-id lookup is intentionally exact and ambiguity is never auto-healed.
 */
export async function fetchEasyBrokerListingSnapshot(
  db: DbClient,
  params: {
    userId: string;
    listingId?: string | null;
    internalId?: string | null;
  }
): Promise<EasyBrokerListingSnapshot | null> {
  const apiKey = await easyBrokerApiKey(db, params.userId);
  if (!apiKey) throw new Error("easybroker_credentials_missing");
  if (params.listingId?.trim()) {
    const payload = await easyBrokerGet(
      apiKey,
      `/v1/properties/${encodeURIComponent(params.listingId.trim())}`
    );
    return easyBrokerSnapshot(payload);
  }
  const internalId = params.internalId?.trim();
  if (!internalId) return null;
  const payload = await easyBrokerGet(apiKey, "/v1/properties", {
    internal_id: internalId,
    limit: "100",
  });
  const rows = Array.isArray(payload.content)
    ? payload.content.filter(isRecord)
    : Array.isArray(payload.data)
      ? payload.data.filter(isRecord)
      : [];
  const exact = rows.filter((row) => stringValue(row.internal_id) === internalId);
  if (exact.length > 1) {
    throw new AmbiguousRemoteListingError(
      `multiple_easybroker_listings_for_internal_id:${internalId}`
    );
  }
  return exact[0] ? easyBrokerSnapshot(exact[0]) : null;
}

export function isUnggaApiCredentialsMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === "ungga_api_credentials_missing" ||
    message.includes("ungga_api_credentials_missing")
  );
}

/**
 * CLI-only Ungga accounts have no internal API. When prepare_draft already
 * verified the GU-ID + media, use that artifact as adapter-tier remote evidence.
 */
export function unggaSnapshotFromCliEvidence(params: {
  unggaPropertyId: string;
  draftUrl?: string | null;
  publishedUrl?: string | null;
  remoteStatus?: string | null;
  imageCount?: number | null;
}): UnggaListingSnapshot {
  const id = params.unggaPropertyId.trim();
  return {
    ungga_property_id: id,
    status: params.remoteStatus?.trim() || "draft",
    draft_url: params.draftUrl?.trim() || null,
    published_url: params.publishedUrl?.trim() || null,
    image_count:
      typeof params.imageCount === "number" && Number.isFinite(params.imageCount)
        ? params.imageCount
        : null,
    raw: { source: "cli_evidence", ungga_property_id: id },
  };
}

export function canUseUnggaCliEvidence(params: {
  unggaPropertyId?: string | null;
  mediaRequired: boolean;
  mediaVerified: boolean;
}): boolean {
  const id =
    typeof params.unggaPropertyId === "string"
      ? params.unggaPropertyId.trim()
      : "";
  if (!id) return false;
  return !params.mediaRequired || params.mediaVerified;
}

/** Ungga often shows extra thumbs (cover + uploads); accept remote >= expected. */
export function unggaMediaCountSatisfied(
  remoteCount: number | null | undefined,
  expectedCount: number
): boolean {
  if (!(expectedCount > 0)) return true;
  return typeof remoteCount === "number" && remoteCount >= expectedCount;
}

export async function fetchUnggaListingSnapshot(
  db: DbClient,
  params: { userId: string; unggaPropertyId: string }
): Promise<UnggaListingSnapshot | null> {
  const credentials = await unggaApiCredentials(db, params.userId);
  if (!credentials) throw new Error("ungga_api_credentials_missing");
  const id = params.unggaPropertyId.trim();
  const url = new URL(
    `/v1/internal/listings/${encodeURIComponent(id)}`,
    credentials.base.replace(/\/$/, "")
  );
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
    },
    cache: "no-store",
  });
  if (response.status === 404) return null;
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) throw new Error(`ungga_remote_read_${response.status}`);
  const images = Array.isArray(payload.images) ? payload.images : null;
  return {
    ungga_property_id:
      stringValue(payload.id) ??
      stringValue(payload.ungga_property_id) ??
      id,
    status: stringValue(payload.status),
    draft_url: stringValue(payload.draft_url),
    published_url:
      stringValue(payload.published_url) ?? stringValue(payload.public_url),
    image_count: images ? images.length : null,
    raw: payload,
  };
}

export function compareEasyBrokerSnapshot(params: {
  snapshot: EasyBrokerListingSnapshot;
  expectedInternalId?: string | null;
  expectedImageCount?: number | null;
  expectedImageTitles?: Array<string | null>;
  expectedFields?: Record<string, unknown>;
}): string[] {
  const mismatches: string[] = [];
  const expectedInternalId = params.expectedInternalId
    ?.replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 15)
    .toUpperCase();
  const actualInternalId = params.snapshot.internal_id
    ?.replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 15)
    .toUpperCase();
  if (
    expectedInternalId &&
    actualInternalId !== expectedInternalId
  ) {
    mismatches.push("internal_id_mismatch");
  }
  if (
    typeof params.expectedImageCount === "number" &&
    params.snapshot.image_count !== params.expectedImageCount
  ) {
    mismatches.push("image_count_mismatch");
  }
  if (params.expectedImageTitles?.length) {
    const expected = params.expectedImageTitles.map((title) => title ?? null);
    const actual = params.snapshot.image_titles.slice(0, expected.length);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push("image_titles_mismatch");
    }
  }
  for (const [field, expected] of Object.entries(params.expectedFields ?? {})) {
    if (expected === undefined || expected === null || expected === "") continue;
    const canonicalExpected =
      field === "title" && typeof expected === "string"
        ? canonicalEasyBrokerTitle(expected)
        : expected;
    const actual =
      field === "title" || field === "description"
        ? params.snapshot[field]
        : params.snapshot.fields[field];
    if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) {
      mismatches.push(`critical_field_mismatch:${field}`);
    }
  }
  return mismatches;
}

function canonicalEasyBrokerTitle(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= 80) return clean;
  const sliced = clean.slice(0, 80);
  const lastSpace = sliced.lastIndexOf(" ");
  const shortened = lastSpace >= 56 ? sliced.slice(0, lastSpace) : sliced;
  return shortened.replace(/[\s,;:.-]+$/g, "");
}
