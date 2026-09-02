/**
 * Pure helpers for the internal Markdown link validator.
 *
 * Split out from `scripts/validate-doc-links.mjs` so the enforcement semantics
 * can be selftested without a filesystem, the same way `legacy-manifest.mjs`
 * backs `validate-migrations.mjs`.
 *
 * Two rules carry the weight, and both come from real defects:
 *
 * 1. A link inside code formatting is NOT a link. During the reference repair
 *    (PR #5) 23 apparent links were written as `[text](target)` — backticks
 *    OUTSIDE the brackets — so Markdown rendered them as literal text in a code
 *    span and they never navigated anywhere. A validator that matches raw
 *    `[x](y)` character sequences would fail on documentation examples, so code
 *    spans and fenced blocks are masked before links are matched.
 *
 * 2. Code-span masking must follow CommonMark's matching-backtick-run rule and
 *    scan left to right without overlapping. The naive pattern
 *    /`[^`]*\[[^]]*\]\([^)]*\)[^`]*`/ appears to work but matches across two
 *    ADJACENT legitimate links — in "[`a`](a), [`b`](b)" it starts at the
 *    CLOSING backtick of the first link's text and would mask the second link
 *    out of existence. Every ADR header in this repo is written that way.
 *
 * Masking replaces code with spaces rather than deleting it, so byte offsets —
 * and therefore reported line numbers — stay exact.
 */

/** Link targets that are not repository paths and are deliberately unchecked. */
export const EXTERNAL_SCHEME = /^(https?|mailto|tel|data|ftp):/i;

/**
 * Markdown inline links and images: `[text](target)` / `![alt](target)`.
 *
 * The target excludes whitespace and parentheses. The corpus contains no
 * titled links (`[x](y "t")`), no angle-bracket destinations (`[x](<y>)`) and
 * no reference-style definitions (`[ref]: y`); this pattern is deliberately
 * narrow rather than speculatively general.
 */
export const LINK_RE = /(!?)\[([^\]]*)\]\(([^()\s]+)\)/g;

/**
 * Mask one line's inline code spans with spaces.
 *
 * CommonMark: a code span opens on a run of N backticks and closes on the next
 * run of EXACTLY N. Scanning is left to right and non-overlapping, so a closing
 * delimiter can never be mistaken for an opening one. An unmatched run is
 * literal text and is left alone.
 */
export function maskInlineCode(line) {
  const chars = [...line];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "`") {
      i += 1;
      continue;
    }
    let open = 0;
    while (chars[i + open] === "`") open += 1;

    let j = i + open;
    let closeAt = -1;
    while (j < chars.length) {
      if (chars[j] !== "`") {
        j += 1;
        continue;
      }
      let run = 0;
      while (chars[j + run] === "`") run += 1;
      if (run === open) {
        closeAt = j;
        break;
      }
      j += run;
    }
    if (closeAt === -1) {
      i += open; // unmatched opener — literal backticks
      continue;
    }
    for (let k = i; k < closeAt + open; k += 1) chars[k] = " ";
    i = closeAt + open;
  }
  return chars.join("");
}

/**
 * Return `text` with fenced code blocks and inline code spans replaced by
 * spaces. Length, and therefore every offset and line number, is preserved.
 *
 * A fence opens on ``` or ~~~ (any indentation, since fences also appear inside
 * list items here) and closes on a line containing only the same character,
 * repeated at least as many times. Deliberately NOT handled: four-space
 * indented code blocks. The corpus contains none carrying link-like text, and
 * distinguishing them from list continuation is exactly the kind of guesswork
 * that produces false failures.
 */
export function maskCode(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      if (fence) {
        const trimmed = line.trim();
        const isClose =
          trimmed.length >= fence.length && [...trimmed].every((c) => c === fence.char);
        if (isClose) fence = null;
        return " ".repeat(line.length);
      }
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) {
        fence = { char: open[1][0], length: open[1].length };
        return " ".repeat(line.length);
      }
      return maskInlineCode(line);
    })
    .join("\n");
}

/**
 * Why this target is out of the validator's scope, or null when it must be
 * checked against the filesystem.
 */
export function skipReason(target) {
  if (EXTERNAL_SCHEME.test(target)) return "external";
  if (target.startsWith("#")) return "anchor";
  if (target.includes("{{")) return "placeholder";
  return null;
}

/**
 * The filesystem-relevant part of a target: the fragment is removed and never
 * validated. Anchor correctness is a separate problem with different parsing
 * and false-positive characteristics.
 *
 * Percent-decoding is intentionally not applied: no target in the corpus is
 * percent-encoded, so decoding would only add a way to mis-resolve a path that
 * legitimately contains a `%`.
 */
export function targetPath(target) {
  return target.split("#")[0];
}

/** 1-based line number of a byte offset. */
export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Check every link in one Markdown document.
 *
 * `resolve(relativeTarget)` reports what the target is, from the perspective of
 * the directory holding this document: "file", "dir", or null when nothing is
 * there. Resolution is ALWAYS relative to the containing file — a target is
 * never treated as repo-root-relative because it happens to start with a
 * directory name like `packages/`. That assumption caused most of the links
 * repaired in PR #5.
 *
 * Returns `{ checked, skipped: {external, anchor, placeholder}, directories,
 * broken: [{ line, text, target, image }] }`.
 */
export function checkDocument(text, resolve) {
  const masked = maskCode(text);
  const result = {
    checked: 0,
    skipped: { external: 0, anchor: 0, placeholder: 0 },
    directories: 0,
    broken: [],
  };

  for (const match of masked.matchAll(LINK_RE)) {
    const [, bang, label, target] = match;
    const reason = skipReason(target);
    if (reason) {
      result.skipped[reason] += 1;
      continue;
    }
    const rel = targetPath(target);
    if (!rel) {
      result.skipped.anchor += 1;
      continue;
    }
    result.checked += 1;
    const kind = resolve(rel);
    if (kind === "dir") result.directories += 1;
    if (kind === null) {
      // Report the ORIGINAL text, not the masked label: masking blanks out
      // inline code inside link text, and `[`foo.md`](foo.md)` is the repo's
      // dominant link style.
      const original = text.slice(match.index, match.index + match[0].length);
      result.broken.push({
        line: lineOf(text, match.index),
        text: label,
        target,
        image: bang === "!",
        raw: original,
      });
    }
  }
  return result;
}
