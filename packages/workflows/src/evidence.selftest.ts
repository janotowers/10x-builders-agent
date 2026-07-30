import assert from "node:assert/strict";
import {
  resetEvidenceScrubberCacheForTests,
  scrubEvidenceDetail,
} from "./evidence";

// Seed a fake secret in the env-derived redaction list.
process.env.TEST_FAKE_API_KEY = "sk-super-secret-value-123456";
resetEvidenceScrubberCacheForTests();

// 1. Key-based redaction (nested, case-insensitive).
const scrubbed = scrubEvidenceDetail({
  gate: "transition_matrix",
  api_key: "abc",
  nested: { Authorization: "Bearer xyz", ok: 1, SERVICE_ROLE: "zzz" },
  list: [{ password: "hunter2" }, "plain"],
});
assert.equal(scrubbed.api_key, "[redacted]");
assert.deepEqual(scrubbed.nested, {
  Authorization: "[redacted]",
  ok: 1,
  SERVICE_ROLE: "[redacted]",
});
assert.deepEqual(scrubbed.list, [{ password: "[redacted]" }, "plain"]);
assert.equal(scrubbed.gate, "transition_matrix");

// 2. Value-based redaction: env secret value redacted under any key.
const valueScrub = scrubEvidenceDetail({
  note: "sk-super-secret-value-123456",
  safe: "hello",
});
assert.equal(valueScrub.note, "[redacted]");
assert.equal(valueScrub.safe, "hello");

// 3. Extra secret values are honored; short values ignored (false positives).
const extra = scrubEvidenceDetail(
  { leaked: "another-secret-value", tiny: "abc" },
  { extraSecretValues: ["another-secret-value", "abc"] }
);
assert.equal(extra.leaked, "[redacted]");
assert.equal(extra.tiny, "abc");

// 4. Null/undefined → empty object; non-objects preserved.
assert.deepEqual(scrubEvidenceDetail(null), {});
assert.deepEqual(scrubEvidenceDetail({ n: 5, b: true, x: null }), {
  n: 5,
  b: true,
  x: null,
});

console.log("evidence.selftest: OK");
