/**
 * BigQuery query adapter (V1-B).
 *
 * Implements the `bigquery_run_query` tool's runtime: validate the SQL
 * with the read-only guard (`bigquery-sql.ts`), authenticate against
 * Google's OAuth using a service-account key (JWT bearer flow, RFC 7523),
 * and execute via the BigQuery REST API `jobs.query` endpoint.
 *
 * No external dependency on `@google-cloud/bigquery` or `google-auth-library`
 * — auth is implemented with `node:crypto` (RS256 sign) + `fetch`. This
 * keeps the agent package lean (the project deliberately ships with very
 * few runtime deps) at the cost of writing ~150 lines of auth glue.
 *
 * Configuration (V1-B; superseded by `business_brain.bigquery` in V1-C):
 *   BIGQUERY_PROJECT_ID                  - default project for queries
 *   BIGQUERY_LOCATION                    - default location (e.g. "US")
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON  - service-account JSON inline
 *                                          (preferred for serverless / Vercel)
 *   GOOGLE_APPLICATION_CREDENTIALS       - path to service-account JSON
 *                                          (used when the env above is empty)
 *
 * Returns a tagged union so tool callers can render "not configured" without
 * surfacing a stack trace to the user when ops simply hasn't wired BQ yet.
 */
import { promises as fs } from "node:fs";
import { createPrivateKey, createSign } from "node:crypto";
import { validateReadOnlySql } from "./bigquery-sql";

/** Default cap on rows returned to the model. Override per-call. */
export const DEFAULT_MAX_RESULTS = 100;
/** Hard cap to keep the LLM response budget sane. */
export const MAX_RESULTS_HARD_CAP = 1000;
/** OAuth scope required to read BigQuery data. */
const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
/** Tokens are valid for 1h; refresh slightly earlier to dodge clock skew. */
const TOKEN_TTL_SAFETY_MARGIN_SEC = 60;
const BIGQUERY_FETCH_MAX_ATTEMPTS = 3;
const BIGQUERY_FETCH_BACKOFF_MS = [500, 1500];

/**
 * Allowed types for parameterized queries (`@name` placeholders in SQL).
 * Mapping to BigQuery `parameterType.type`:
 *   - string  → STRING
 *   - number  → INT64 if integer, FLOAT64 otherwise
 *   - boolean → BOOL
 * For DATE/TIMESTAMP literals, callers can pass a string and use the
 * appropriate cast in the SQL (e.g. `DATE(@day)`).
 */
export type BigQueryParamValue = string | number | boolean;

export interface BigQueryRunArgs {
  readonly sql: string;
  readonly projectId?: string;
  readonly location?: string;
  readonly maxResults?: number;
  /**
   * Named parameters injected via BigQuery's parameterized-query mechanism.
   * Keys are the parameter names (without the `@`); values must be
   * primitives. The skill should USE parameters for any value derived from
   * user input or business_brain (e.g. `organization_id`) — never inline
   * them as string literals.
   */
  readonly params?: Readonly<Record<string, BigQueryParamValue>>;
}

export type BigQueryRunResult =
  | {
      readonly status: "ok";
      readonly rowCount: number;
      readonly truncated: boolean;
      readonly schema: ReadonlyArray<{ readonly name: string; readonly type: string }>;
      readonly rows: ReadonlyArray<Record<string, unknown>>;
      readonly bytesProcessed?: number | null;
      readonly cacheHit?: boolean;
    }
  | {
      readonly status: "not_configured";
      readonly missing: ReadonlyArray<string>;
      readonly message: string;
    }
  | {
      readonly status: "validation_error";
      readonly error: string;
    }
  | {
      readonly status: "execution_error";
      readonly error: string;
      readonly httpStatus?: number;
    };

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/**
 * Run a read-only BigQuery query. Always validates the SQL first; never
 * throws — failures funnel into a tagged result so the tool layer can
 * surface a clean message to the model.
 */
export async function executeBigQueryQuery(
  args: BigQueryRunArgs
): Promise<BigQueryRunResult> {
  const validated = validateReadOnlySql(args.sql);
  if (!validated.ok) {
    return { status: "validation_error", error: validated.error };
  }

  const projectId = args.projectId?.trim() || process.env.BIGQUERY_PROJECT_ID?.trim();
  if (!projectId) {
    return {
      status: "not_configured",
      missing: ["BIGQUERY_PROJECT_ID"],
      message:
        "BigQuery is not configured: set BIGQUERY_PROJECT_ID and a service-account credential (GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS).",
    };
  }

  let serviceAccount: ServiceAccountKey;
  try {
    serviceAccount = await loadServiceAccount();
  } catch (err) {
    return {
      status: "not_configured",
      missing: [
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
        "GOOGLE_APPLICATION_CREDENTIALS",
      ],
      message:
        err instanceof Error
          ? err.message
          : "BigQuery credentials are not available.",
    };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(serviceAccount);
  } catch (err) {
    return {
      status: "execution_error",
      error: `OAuth exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const location = args.location?.trim() || process.env.BIGQUERY_LOCATION?.trim();
  const maxResults = clampMaxResults(args.maxResults);

  const requestBody: Record<string, unknown> = {
    query: validated.normalized,
    useLegacySql: false,
    maxResults,
  };
  if (location) requestBody.location = location;

  if (args.params && Object.keys(args.params).length > 0) {
    let queryParameters: Array<Record<string, unknown>>;
    try {
      queryParameters = buildBigQueryParameters(args.params);
    } catch (err) {
      return {
        status: "validation_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    requestBody.parameterMode = "NAMED";
    requestBody.queryParameters = queryParameters;
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      { label: "jobs.query" }
    );
  } catch (err) {
    return {
      status: "execution_error",
      error: `network error contacting BigQuery: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const summary = extractErrorSummary(text);
    return {
      status: "execution_error",
      error: `BigQuery returned HTTP ${response.status}: ${summary}`,
      httpStatus: response.status,
    };
  }

  let payload: BigQueryQueryResponse;
  try {
    payload = (await response.json()) as BigQueryQueryResponse;
  } catch (err) {
    return {
      status: "execution_error",
      error: `failed to parse BigQuery response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const schema =
    payload.schema?.fields?.map((f) => ({
      name: f.name,
      type: f.type ?? "STRING",
    })) ?? [];
  const rows = (payload.rows ?? []).map((r) => projectRow(r, schema));
  const truncated = !payload.jobComplete || rows.length >= maxResults;

  return {
    status: "ok",
    rowCount: rows.length,
    truncated,
    schema,
    rows,
    bytesProcessed: parseNumericString(payload.totalBytesProcessed),
    cacheHit: payload.cacheHit ?? false,
  };
}

/* ──────────────────── query parameters helpers ─────────────────────── */

const PARAM_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Soft cap on the count of named parameters per query (BigQuery limit is 10k). */
const MAX_QUERY_PARAMS = 64;

function buildBigQueryParameters(
  params: Readonly<Record<string, BigQueryParamValue>>
): Array<Record<string, unknown>> {
  const names = Object.keys(params);
  if (names.length > MAX_QUERY_PARAMS) {
    throw new Error(
      `too many query parameters: ${names.length} (max ${MAX_QUERY_PARAMS})`
    );
  }
  return names.map((name) => {
    if (!PARAM_NAME_REGEX.test(name)) {
      throw new Error(
        `invalid query parameter name '${name}': must match ${PARAM_NAME_REGEX} (no '@' prefix)`
      );
    }
    const raw = params[name];
    if (typeof raw === "string") {
      return {
        name,
        parameterType: { type: "STRING" },
        parameterValue: { value: raw },
      };
    }
    if (typeof raw === "boolean") {
      return {
        name,
        parameterType: { type: "BOOL" },
        parameterValue: { value: String(raw) },
      };
    }
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) {
        throw new Error(
          `invalid query parameter '${name}': non-finite numbers are not supported`
        );
      }
      const isInt = Number.isInteger(raw);
      return {
        name,
        parameterType: { type: isInt ? "INT64" : "FLOAT64" },
        parameterValue: { value: String(raw) },
      };
    }
    throw new Error(
      `invalid query parameter '${name}': value must be string|number|boolean, got ${typeof raw}`
    );
  });
}

/* ─────────────────────────── auth + helpers ──────────────────────────── */

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(sa: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt - TOKEN_TTL_SAFETY_MARGIN_SEC > now) {
    return cached.token;
  }

  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const claim = {
    iss: sa.client_email,
    scope: BQ_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = b64url(JSON.stringify(header));
  const claimB64 = b64url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;

  const key = createPrivateKey(sa.private_key);
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(key).toString("base64url");
  const jwt = `${unsigned}.${signature}`;

  const response = await fetchWithRetry(
    tokenUri,
    {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    },
    { label: "oauth.token" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${extractErrorSummary(text)}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("OAuth response missing access_token");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  tokenCache.set(sa.client_email, {
    token: json.access_token,
    expiresAt: now + expiresIn,
  });
  return json.access_token;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: { label?: string }
): Promise<Response> {
  const label = options?.label ?? "fetch";
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BIGQUERY_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (
        attempt < BIGQUERY_FETCH_MAX_ATTEMPTS &&
        isRetriableHttpStatus(response.status)
      ) {
        await sleep(BIGQUERY_FETCH_BACKOFF_MS[attempt - 1] ?? 1500);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (
        attempt < BIGQUERY_FETCH_MAX_ATTEMPTS &&
        isRetriableNetworkError(err)
      ) {
        await sleep(BIGQUERY_FETCH_BACKOFF_MS[attempt - 1] ?? 1500);
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `BigQuery ${label} failed after ${BIGQUERY_FETCH_MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetriableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("timeout") ||
    msg.includes("socket") ||
    msg.includes("econnreset") ||
    msg.includes("und_err")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadServiceAccount(): Promise<ServiceAccountKey> {
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (inline) {
    return parseServiceAccount(inline, "GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (filePath) {
    const text = await fs.readFile(filePath, "utf8").catch(() => null);
    if (text === null) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS points to ${filePath} but the file could not be read`
      );
    }
    return parseServiceAccount(text, filePath);
  }
  throw new Error(
    "BigQuery credentials are not available: set GOOGLE_APPLICATION_CREDENTIALS_JSON (inline) or GOOGLE_APPLICATION_CREDENTIALS (file path)"
  );
}

function parseServiceAccount(text: string, source: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid service-account JSON in ${source}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`service-account JSON in ${source} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.client_email !== "string" || obj.client_email === "") {
    throw new Error(
      `service-account JSON in ${source} is missing client_email`
    );
  }
  if (typeof obj.private_key !== "string" || obj.private_key === "") {
    throw new Error(
      `service-account JSON in ${source} is missing private_key`
    );
  }
  return {
    client_email: obj.client_email,
    private_key: obj.private_key,
    token_uri: typeof obj.token_uri === "string" ? obj.token_uri : undefined,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function clampMaxResults(raw: number | undefined): number {
  if (raw == null) return DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(raw), MAX_RESULTS_HARD_CAP);
}

function extractErrorSummary(text: string): string {
  if (!text) return "<empty body>";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* fall through */
  }
  return text.slice(0, 300);
}

interface BigQueryQueryResponse {
  schema?: { fields?: Array<{ name: string; type?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  jobComplete?: boolean;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
}

function projectRow(
  row: { f?: Array<{ v?: unknown }> },
  schema: ReadonlyArray<{ name: string; type: string }>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cells = row.f ?? [];
  for (let i = 0; i < schema.length; i += 1) {
    const colName = schema[i]?.name ?? `col_${i}`;
    const cellVal = cells[i]?.v;
    out[colName] = cellVal;
  }
  return out;
}

function parseNumericString(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────── for tests ─────────────────────── */

/** Test helper to clear the OAuth token cache between cases. */
export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}
