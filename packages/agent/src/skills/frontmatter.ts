/**
 * Minimal YAML-frontmatter parser tailored to the SKILL.md schema.
 *
 * We deliberately do **not** depend on a full YAML library. Skills follow a
 * constrained format documented in the roadmap (§ V1-A); anything outside
 * that subset is rejected as a `FrontmatterError` so authors get a clear
 * signal instead of silently-misparsed metadata.
 *
 * Supported syntax (everything else throws):
 *   - `key: value`            string scalar (trimmed)
 *   - `key: 'value'` / `"value"`  single/double quoted string scalar
 *   - `key: []`               empty array
 *   - `key: [a, b, c]`        inline array of unquoted/quoted strings
 *   - `key:` then indented `  - item` lines  (block array of strings)
 *   - `key: |` then indented multi-line text (literal block scalar)
 *   - `# comment` lines and blank lines are ignored
 *
 * The result is a `Record<string, string | string[]>` — Zod takes over for
 * the schema-level validation in `parse.ts`.
 */

export class FrontmatterError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line != null ? `frontmatter line ${line}: ${message}` : message);
    this.name = "FrontmatterError";
  }
}

export interface SplitResult {
  /** Raw frontmatter text (between the two `---` fences); empty if none. */
  readonly frontmatter: string;
  /** Markdown body after the closing `---` fence (or the whole file if no fences). */
  readonly body: string;
  /** True if a valid `---\n...\n---\n` block was detected at the start. */
  readonly hasFrontmatter: boolean;
}

/**
 * Split a SKILL.md source into its frontmatter block and body. Tolerates
 * BOM and CRLF line endings; the closing fence may end the file with no
 * trailing newline.
 */
export function splitFrontmatter(raw: string): SplitResult {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  const startFence = /^---[ \t]*\n/;
  const startMatch = text.match(startFence);
  if (!startMatch) {
    return { frontmatter: "", body: text, hasFrontmatter: false };
  }

  const after = text.slice(startMatch[0].length);
  const endMatch = after.match(/\n---[ \t]*(?:\n|$)/);
  if (!endMatch) {
    throw new FrontmatterError(
      "opening '---' fence found but closing '---' is missing"
    );
  }
  const fmEnd = endMatch.index ?? 0;
  const frontmatter = after.slice(0, fmEnd);
  const body = after.slice(fmEnd + endMatch[0].length);
  return { frontmatter, body, hasFrontmatter: true };
}

type RawValue = string | string[] | boolean;

/**
 * Parse the YAML-ish frontmatter block into a flat record. The caller
 * (`parse.ts`) is responsible for schema validation via Zod.
 *
 * Scalar coercion: bare `true` / `false` (unquoted) are returned as
 * actual booleans so Zod fields declared as `z.boolean()` can read them
 * without an extra `z.preprocess`. Quoted forms (`"true"`, `'false'`)
 * are kept as strings, matching YAML 1.2 semantics.
 */
export function parseFrontmatterBlock(
  source: string
): Record<string, RawValue> {
  const lines = source.split("\n");
  const out: Record<string, RawValue> = {};

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine ?? "";

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }

    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new FrontmatterError(
        "unexpected indentation outside of a block value",
        i + 1
      );
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) {
      throw new FrontmatterError(
        `expected 'key: value' (got: ${JSON.stringify(line)})`,
        i + 1
      );
    }

    const key = line.slice(0, colonIdx).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
      throw new FrontmatterError(`invalid key '${key}'`, i + 1);
    }

    const rest = stripInlineComment(line.slice(colonIdx + 1)).trimEnd();
    const restTrim = rest.trim();

    if (restTrim === "") {
      const block = readIndentedBlock(lines, i + 1);
      out[key] = parseBlockArray(block.lines, i + 1);
      i = block.nextIndex;
      continue;
    }

    if (restTrim === "|") {
      const block = readIndentedBlock(lines, i + 1);
      out[key] = block.lines.join("\n").replace(/\s+$/, "");
      i = block.nextIndex;
      continue;
    }

    if (restTrim.startsWith("[")) {
      out[key] = parseInlineArray(restTrim, i + 1);
      i += 1;
      continue;
    }

    out[key] = parseScalar(restTrim, i + 1);
    i += 1;
  }

  return out;
}

function stripInlineComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < s.length; j += 1) {
    const ch = s[j];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return s.slice(0, j);
  }
  return s;
}

function parseScalar(raw: string, lineNo: number): string | boolean {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    throw new FrontmatterError("unterminated quoted string", lineNo);
  }
  // Bare booleans (YAML 1.2 lowercase form). Quoted forms above stayed
  // strings, so authors who really need a literal "true" still can.
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function parseInlineArray(raw: string, lineNo: number): string[] {
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    throw new FrontmatterError(
      "inline array must start with '[' and end with ']'",
      lineNo
    );
  }
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];

  const items: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < inner.length; j += 1) {
    const ch = inner[j];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
    } else if (ch === "," && !inSingle && !inDouble) {
      items.push(scalarAsString(parseScalar(buf.trim(), lineNo)));
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (inSingle || inDouble) {
    throw new FrontmatterError("unterminated quoted string in array", lineNo);
  }
  const last = buf.trim();
  if (last !== "") items.push(scalarAsString(parseScalar(last, lineNo)));
  return items;
}

/** Coerce a parsed scalar back to string for array contexts. Bare booleans
 *  inside arrays are uncommon and ambiguous; we render them as "true"/"false"
 *  so Zod schemas declared as `array(z.string())` don't throw. */
function scalarAsString(s: string | boolean): string {
  return typeof s === "boolean" ? String(s) : s;
}

interface BlockSlice {
  lines: string[];
  nextIndex: number;
}

function readIndentedBlock(lines: string[], startIdx: number): BlockSlice {
  const collected: string[] = [];
  let indent: number | null = null;
  let j = startIdx;

  while (j < lines.length) {
    const line = lines[j] ?? "";
    if (line.trim() === "") {
      collected.push("");
      j += 1;
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    if (indent === null) indent = lead;
    if (lead < indent) break;
    collected.push(line.slice(indent));
    j += 1;
  }

  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }
  return { lines: collected, nextIndex: j };
}

function parseBlockArray(lines: string[], startLineNo: number): string[] {
  const items: string[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    const line = (lines[k] ?? "").trimEnd();
    if (line === "") continue;
    if (!line.startsWith("- ") && line !== "-") {
      throw new FrontmatterError(
        "expected list item starting with '- ' in block array",
        startLineNo + k
      );
    }
    const item = line === "-" ? "" : line.slice(2).trim();
    items.push(scalarAsString(parseScalar(item, startLineNo + k)));
  }
  return items;
}
