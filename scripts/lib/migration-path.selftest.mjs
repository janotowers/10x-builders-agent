/**
 * Selftests for the B′ migration mechanisms themselves.
 *
 * These cover the guarantees the release path depends on: the frozen legacy set
 * really is frozen (additions, removals, renames and edits all fail), and the
 * forward era really does enforce the uniqueness/ordering the Supabase history
 * table requires. Pure functions, no filesystem or database needed.
 */
import assert from "node:assert/strict";
import { diffAgainstManifest, buildManifest, sha256 } from "./legacy-manifest.mjs";
import { validateForwardSet, newVersion, FORWARD_FILENAME_RE } from "./forward-migrations.mjs";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- frozen set
const chain = [
  { file: "00001_initial_schema.sql", sha256: "a".repeat(64) },
  { file: "00036_notification_engagement_policy_overrides.sql", sha256: "b".repeat(64) },
  { file: "00036_waiting_internal_status.sql", sha256: "c".repeat(64) },
  { file: "00084_bootstrap_organization_provenance.sql", sha256: "d".repeat(64) },
];
const manifest = buildManifest(chain);

{
  const r = diffAgainstManifest(chain, manifest);
  assert.equal(r.ok, true, r.errors.join("; "));
  ok("an unchanged frozen chain validates");
}
{
  // The gap this whole mechanism exists to close: a NEW unique prefix passed
  // the old duplicate-only rule.
  const withNew = [...chain, { file: "00085_sneaky_addition.sql", sha256: "e".repeat(64) }];
  const r = diffAgainstManifest(withNew, manifest);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /new file added to the FROZEN legacy directory: 00085_sneaky_addition\.sql/);
  ok("a new unique legacy migration is rejected");
}
{
  const removed = chain.filter((f) => !f.file.startsWith("00036_waiting"));
  const r = diffAgainstManifest(removed, manifest);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /removed or renamed: 00036_waiting_internal_status\.sql/);
  ok("removing a frozen migration is rejected (incl. one of a duplicate pair)");
}
{
  const renamed = chain.map((f) =>
    f.file === "00001_initial_schema.sql" ? { ...f, file: "00001_initial.sql" } : f
  );
  const r = diffAgainstManifest(renamed, manifest);
  assert.equal(r.ok, false);
  ok("renaming a frozen migration is rejected");
}
{
  const edited = chain.map((f) =>
    f.file === "00084_bootstrap_organization_provenance.sql" ? { ...f, sha256: "f".repeat(64) } : f
  );
  const r = diffAgainstManifest(edited, manifest);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /modified: 00084_bootstrap_organization_provenance\.sql/);
  ok("editing an already-applied frozen migration is rejected");
}
{
  // CRLF/LF must not be a false positive: the repo is edited on Windows and
  // verified on Linux CI.
  assert.equal(sha256("a\r\nb\r\n"), sha256("a\nb\n"));
  ok("hashing is line-ending independent");
}

// -------------------------------------------------------------- forward era
const legacyNames = chain.map((f) => f.file);
{
  const r = validateForwardSet(["20260901120000_add_widget.sql"], legacyNames);
  assert.equal(r.ok, true, r.errors.join("; "));
  ok("a well-formed forward migration validates");
}
{
  const r = validateForwardSet([], legacyNames);
  assert.equal(r.ok, true);
  ok("an empty forward era is valid (no artificial baseline)");
}
{
  const r = validateForwardSet(["00085_wrong_era.sql"], legacyNames);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /14-digit-timestamp/);
  ok("a legacy-style filename in the forward era is rejected");
}
{
  // Two files sharing a version can never both be recorded — the exact defect
  // that froze the legacy era.
  const r = validateForwardSet(
    ["20260901120000_a.sql", "20260901120000_b.sql"],
    legacyNames
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /duplicate forward migration version 20260901120000/);
  ok("duplicate forward versions are rejected");
}
{
  const r = validateForwardSet(["00001_collision.sql"], legacyNames);
  assert.equal(r.ok, false);
  ok("a forward migration reusing a legacy version is rejected");
}
{
  assert.match(`${newVersion(new Date(Date.UTC(2026, 8, 1, 12, 0, 0)))}_x.sql`, FORWARD_FILENAME_RE);
  assert.equal(newVersion(new Date(Date.UTC(2026, 8, 1, 12, 0, 0))), "20260901120000");
  ok("generated versions are 14-digit UTC and match the CLI convention");
}
{
  // The single total order across both eras.
  const merged = ["00084_z.sql", "20260901120000_a.sql", "00001_a.sql"].sort();
  assert.deepEqual(merged, ["00001_a.sql", "00084_z.sql", "20260901120000_a.sql"]);
  ok("legacy sorts before forward under one lexicographic order");
}

console.log(`migration-path selftest: ${passed} checks passed`);
