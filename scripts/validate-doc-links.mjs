#!/usr/bin/env node
/**
 * Guards internal Markdown link integrity across tracked documentation.
 *
 * Documentation authority in this repo is expressed as links: `docs/README.md`
 * routes every question to its owning artifact, and a link that silently stops
 * resolving turns that map into a confident wrong answer. PR #5 repaired 39
 * broken internal links; this check is what stops them coming back.
 *
 * A relative target is valid when it resolves — relative to the file holding
 * the link — to an existing file OR an existing directory. Directory links are
 * valid: GitHub renders a listing, and requiring a README.md inside produced
 * six false positives in the scratch checker that preceded this script.
 *
 * Fragments are stripped and never validated; anchor correctness is a separate
 * problem. Parsing semantics, and why code must be masked before links are
 * matched, live in `lib/doc-links.mjs`.
 *
 * Dependency-free on purpose so it runs in CI next to the other validators.
 * Deliberately NOT part of `prebuild`: documentation reference integrity is a
 * CI concern, not a product build concern.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocument } from "./lib/doc-links.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked Markdown files, so untracked scratch notes never fail CI. */
function trackedMarkdown() {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "*.md"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

/** "file" | "dir" | null, resolved from the directory holding the document. */
function makeResolver(fromDir) {
  return (relativeTarget) => {
    const absolute = path.resolve(REPO_ROOT, fromDir, relativeTarget);
    try {
      return statSync(absolute).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };
}

function main() {
  const files = trackedMarkdown();
  const totals = { checked: 0, directories: 0, external: 0, anchor: 0, placeholder: 0 };
  const broken = [];

  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const result = checkDocument(text, makeResolver(path.dirname(file)));
    totals.checked += result.checked;
    totals.directories += result.directories;
    totals.external += result.skipped.external;
    totals.anchor += result.skipped.anchor;
    totals.placeholder += result.skipped.placeholder;
    for (const item of result.broken) broken.push({ file, ...item });
  }

  if (broken.length > 0) {
    console.error("validate-doc-links: FAILED");
    for (const item of broken) {
      console.error(`  - ${item.file}:${item.line}  ${item.raw}`);
      console.error(`      target does not exist relative to ${path.dirname(item.file)}/`);
    }
    console.error(
      `\n${broken.length} broken internal link(s) in ${new Set(broken.map((b) => b.file)).size} file(s). ` +
        "A target may be an existing file or an existing directory; fragments are not checked."
    );
    process.exit(1);
  }

  console.log(
    `validate-doc-links: ok (${files.length} tracked markdown files, ` +
      `${totals.checked} internal relative links, ${totals.directories} to directories; ` +
      `skipped ${totals.external} external, ${totals.anchor} anchors, ${totals.placeholder} placeholders)`
  );
}

try {
  main();
} catch (error) {
  console.error("validate-doc-links: unexpected failure", error);
  process.exit(1);
}
