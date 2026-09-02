/**
 * Selftests for the internal-link validator's enforcement semantics.
 *
 * `validate-doc-links.mjs` is a blocking CI control, so the rules that decide
 * pass/fail are pinned here. The filesystem is injected, so these are pure
 * functions with no I/O: `resolve()` below is a fake tree.
 *
 * This is not a CommonMark conformance suite. It covers what the validator
 * actually relies on, plus the two mistakes that produced real defects: masking
 * code before matching links, and never treating a relative target as
 * repo-root-relative.
 */
import assert from "node:assert/strict";
import { checkDocument, maskCode, maskInlineCode } from "./doc-links.mjs";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** Fake tree, seen from the directory of the document under test. */
const TREE = {
  "real.md": "file",
  "sub/real.md": "file",
  "../up.md": "file",
  "adr/": "dir",
  adr: "dir",
  "image.png": "file",
};
const resolve = (target) => TREE[target] ?? null;
const check = (text) => checkDocument(text, resolve);

// ------------------------------------------------------------------ PASSING
{
  const r = check("See [the doc](real.md) for details.");
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 1);
  ok("an existing relative file passes");
}
{
  const r = check("Records live in [`adr/`](adr/).");
  assert.deepEqual(r.broken, []);
  assert.equal(r.directories, 1);
  ok("an existing relative DIRECTORY passes, with no README.md required");
}
{
  const r = check("See [section](real.md#a-heading) and [top](sub/real.md#x).");
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 2);
  ok("a #fragment is stripped before the target is resolved");
}
{
  const r = check("[site](https://example.com) [mail](mailto:a@b.c) [call](tel:+1) [d](data:x) [f](ftp://h/p)");
  assert.deepEqual(r.broken, []);
  assert.equal(r.skipped.external, 5);
  assert.equal(r.checked, 0);
  ok("absolute/external URLs are skipped, not resolved");
}
{
  const r = check("Jump to [section 3](#section-3).");
  assert.deepEqual(r.broken, []);
  assert.equal(r.skipped.anchor, 1);
  ok("a pure anchor is skipped");
}
{
  const r = check("Copy to [the spec]({{initiative}}/spec.md).");
  assert.deepEqual(r.broken, []);
  assert.equal(r.skipped.placeholder, 1);
  ok("a {{placeholder}} target is skipped, so templates do not fail CI");
}
{
  const r = check("Historical: `[toolRequiresConfirmation](packages/types/src/catalog.ts)` is gone.");
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 0);
  ok("a link-shaped string inside an inline code span is not a link");
}
{
  const r = check(
    ["Template:", "", "```markdown", "- Pattern: [catalogue](does-not-exist.md)", "```", "", "End."].join("\n")
  );
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 0);
  ok("a link-shaped string inside a fenced code block is not a link");
}
{
  const r = check("![architecture](image.png)");
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 1);
  ok("a relative image link is validated");
}

// ------------------------------------------------------------------ FAILING
{
  const r = check("See [the doc](missing.md).");
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].target, "missing.md");
  assert.equal(r.broken[0].line, 1);
  ok("a missing relative file fails");
}
{
  const r = check("Records live in [`nope/`](nope/).");
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].target, "nope/");
  ok("a missing relative directory fails");
}
{
  const r = check("![diagram](missing.png)");
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].image, true);
  ok("a missing image target fails");
}

// --------------------------------------------------- semantics that matter
{
  // The defect class behind most of PR #5: a path written as if it were
  // repo-root-relative resolves against the DOCUMENT's directory and must fail.
  const r = check("Queries live in [packages/db/src/queries](packages/db/src/queries).");
  assert.equal(r.broken.length, 1);
  ok("a repo-root-style path is resolved relative to the document, and fails");
}
{
  // The bug a naive /`[^`]*\[..\]\(..\)[^`]*`/ rule introduces: it starts at the
  // CLOSING backtick of the first link's text and swallows the second link.
  // Every ADR header in this repo is written in this style.
  const r = check("Sources: [`real.md`](real.md), [`missing.md`](missing.md) §1.");
  assert.equal(r.checked, 2, "both links must be seen");
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].target, "missing.md");
  ok("adjacent links with code-formatted labels are both parsed, not merged");
}
{
  const r = check("Broken across lines:\n\n- one [a](real.md)\n- two [b](missing.md)\n");
  assert.equal(r.broken[0].line, 4);
  ok("the reported line number survives code masking");
}
{
  const r = check("- [ ] N0 complete\n- [x] N1 complete\n");
  assert.equal(r.checked, 0);
  assert.deepEqual(r.broken, []);
  ok("task-list checkboxes are not mistaken for links");
}
{
  assert.equal(maskInlineCode("a `b` c"), "a     c");

  // A double-backtick span may contain a single backtick; the whole span goes,
  // and only the span. Asserted structurally so the case cannot be "fixed" by
  // miscounting spaces.
  const double = maskInlineCode("``a ` b`` c");
  assert.equal(double.length, "``a ` b`` c".length, "length preserved");
  assert.match(double, /^ +c$/, "the whole span is masked and only the trailing text survives");

  assert.equal(maskInlineCode("unmatched ` backtick"), "unmatched ` backtick");
  ok("inline code masking preserves length and leaves unmatched backticks literal");
}
{
  const masked = maskCode(["before", "```", "[x](y)", "```", "after"].join("\n"));
  assert.equal(masked.split("\n")[2].trim(), "");
  assert.equal(masked.split("\n")[0], "before");
  assert.equal(masked.split("\n")[4], "after");
  ok("fence masking blanks the block and leaves surrounding prose intact");
}
{
  // An info string means the line is an OPENING fence, never a closing one.
  const masked = maskCode(["```markdown", "[x](y)", "```", "[keep](real.md)"].join("\n"));
  assert.equal(masked.split("\n")[3], "[keep](real.md)");
  ok("a fence with an info string closes only on a bare fence");
}

console.log(`doc-links selftest: ${passed} checks passed`);
