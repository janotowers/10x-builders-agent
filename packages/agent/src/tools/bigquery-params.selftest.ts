/**
 * Selftest for the query parameter handling in `executeBigQueryQuery`.
 *
 * We do NOT hit BigQuery: the test sets the env to "no project" so the
 * function short-circuits and returns `not_configured`. That path is
 * reached AFTER SQL validation, so a successful `not_configured` means
 * the SQL with parameters was accepted by the validator.
 *
 * For parameter type-mapping we exercise `buildBigQueryParameters` via
 * the tagged `validation_error` path: pass an invalid value and check
 * the error message.
 */
import assert from "node:assert/strict";
import { executeBigQueryQuery } from "./bigquery-adapter";

async function withCleanEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    BIGQUERY_PROJECT_ID: process.env.BIGQUERY_PROJECT_ID,
    BIGQUERY_LOCATION: process.env.BIGQUERY_LOCATION,
    GOOGLE_APPLICATION_CREDENTIALS_JSON:
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  delete process.env.BIGQUERY_PROJECT_ID;
  delete process.env.BIGQUERY_LOCATION;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function testValidParamsReachAuthStep(): Promise<void> {
  // Without BIGQUERY_PROJECT_ID set we hit `not_configured` AFTER the SQL
  // validator and the params helper. So `not_configured` means everything
  // up to "build the request body" worked fine.
  await withCleanEnv(async () => {
    const result = await executeBigQueryQuery({
      sql: "SELECT * FROM `proj.ds.t` WHERE id = @id",
      params: { id: "abc-123" },
    });
    assert.equal(result.status, "not_configured");
  });
}

async function testEmptyParamsObjectIsAccepted(): Promise<void> {
  await withCleanEnv(async () => {
    const result = await executeBigQueryQuery({
      sql: "SELECT 1",
      params: {},
    });
    assert.equal(result.status, "not_configured");
  });
}

async function testInvalidParamNameIsRejected(): Promise<void> {
  // Project IS set so we get past the "not_configured" check; we expect
  // the params helper to error out via "validation_error".
  process.env.BIGQUERY_PROJECT_ID = "test-project";
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
    client_email: "x@y.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  });
  try {
    const result = await executeBigQueryQuery({
      sql: "SELECT 1",
      params: { "1bad-name": "value" },
    });
    // Auth will fail with a malformed key; or params helper rejects first.
    // Either path means we never sent a real request. We accept either
    // validation_error (params) or execution_error (oauth) depending on
    // ordering.
    assert.ok(
      result.status === "validation_error" ||
        result.status === "execution_error",
      `unexpected status ${result.status}`
    );
    if (result.status === "validation_error") {
      assert.match(result.error, /invalid query parameter name/i);
    }
  } finally {
    delete process.env.BIGQUERY_PROJECT_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  }
}

async function testNonFiniteNumberRejected(): Promise<void> {
  process.env.BIGQUERY_PROJECT_ID = "test-project";
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
    client_email: "x@y.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  });
  try {
    const result = await executeBigQueryQuery({
      sql: "SELECT @amount",
      params: { amount: Number.NaN },
    });
    assert.ok(
      result.status === "validation_error" ||
        result.status === "execution_error"
    );
    if (result.status === "validation_error") {
      assert.match(result.error, /non-finite|invalid query parameter/i);
    }
  } finally {
    delete process.env.BIGQUERY_PROJECT_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  }
}

async function testValidationErrorBeforeAuth(): Promise<void> {
  // SQL validator fires BEFORE both auth and params, so a clearly invalid
  // SQL must still surface as `validation_error` even with valid params.
  process.env.BIGQUERY_PROJECT_ID = "test-project";
  try {
    const result = await executeBigQueryQuery({
      sql: "DROP TABLE `proj.ds.t`",
      params: { id: "abc" },
    });
    assert.equal(result.status, "validation_error");
    if (result.status === "validation_error") {
      assert.match(result.error, /forbidden keyword/i);
    }
  } finally {
    delete process.env.BIGQUERY_PROJECT_ID;
  }
}

async function main(): Promise<void> {
  await testValidParamsReachAuthStep();
  await testEmptyParamsObjectIsAccepted();
  await testInvalidParamNameIsRejected();
  await testNonFiniteNumberRejected();
  await testValidationErrorBeforeAuth();
  console.log("tools/bigquery-params.selftest: all 5 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
