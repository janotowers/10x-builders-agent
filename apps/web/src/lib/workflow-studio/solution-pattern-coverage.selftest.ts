import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SOLUTION_PATTERNS } from "@agents/workflows";
import { OPERATIONAL_TEST_PATTERNS } from "../operational-cases/test-patterns-catalog";

const repoRoot = path.resolve(process.cwd(), "..", "..");
const matrixPath = path.join(
  repoRoot,
  "docs",
  "workflow-studio",
  "pattern-coverage-matrix.md"
);
assert.ok(existsSync(matrixPath), "pattern coverage matrix must exist");
const matrix = readFileSync(matrixPath, "utf8");

for (const pattern of SOLUTION_PATTERNS) {
  assert.match(
    matrix,
    new RegExp(`\\b${pattern.id}\\b`),
    `${pattern.id}: missing from coverage matrix`
  );
  for (const doc of pattern.evidenceDocs) {
    assert.ok(
      existsSync(path.join(repoRoot, doc)),
      `${pattern.id}: missing evidence doc ${doc}`
    );
  }
}

for (const pattern of OPERATIONAL_TEST_PATTERNS) {
  assert.match(
    matrix,
    new RegExp(`\\b${pattern.id}\\b`),
    `${pattern.id}: existing test pattern has no classified destination`
  );
}

console.log("solution-pattern-coverage.selftest: ok");
