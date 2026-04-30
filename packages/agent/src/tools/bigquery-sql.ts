/**
 * Read-only SQL guard for the `bigquery_run_query` tool (V1-B).
 *
 * V1 contract: the tool only accepts a SINGLE read-only statement (SELECT,
 * or a CTE chain `WITH … SELECT`). Anything else — DDL (`CREATE`, `DROP`,
 * `ALTER`, `TRUNCATE`), DML (`INSERT`, `UPDATE`, `DELETE`, `MERGE`), control
 * statements, scripting blocks, or multiple statements separated by `;` —
 * is rejected before the query reaches the BigQuery client.
 *
 * The validator is intentionally **lexical**, not a full SQL parser:
 *   - We strip comments first (`-- line`, `/* block * /`) so writers cannot
 *     hide a forbidden keyword behind a comment.
 *   - We then strip string literals (single and double quotes, including
 *     BigQuery's triple-quoted forms) and parameter placeholders.
 *   - On the resulting "code-only" view we look for:
 *       * a leading `SELECT` or `WITH … SELECT` keyword,
 *       * exactly one statement (zero or one trailing semicolons),
 *       * none of the forbidden top-level keywords.
 *
 * Risks the lexical approach does NOT cover (acceptable for V1-B):
 *   - Crafty injection via UDFs that mutate state (BigQuery does not allow
 *     side-effecting UDFs in standard SQL queries).
 *   - Permission elevation: that is enforced at the service-account level
 *     (read-only role + dataset allowlist).
 */

const FORBIDDEN_KEYWORDS = [
  // DDL
  "CREATE",
  "ALTER",
  "DROP",
  "RENAME",
  "TRUNCATE",
  // DML
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
  // Permission / data export
  "GRANT",
  "REVOKE",
  "EXPORT",
  "LOAD",
  "COPY",
  // Scripting block markers (any one of these implies a script, not a query;
  // the IF/WHEN/FOR/WHILE forms are intentionally NOT here because they can
  // appear as functions or as `CASE WHEN ... END` inside a SELECT — the
  // markers below are sufficient to flag a scripting block conclusively).
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "DECLARE",
  "SET",
  "CALL",
  "EXECUTE",
  "ASSERT",
  "RAISE",
] as const;

/** Maximum number of bytes allowed in a single query string. */
export const MAX_SQL_BYTES = 10_000;

export type SqlValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

/**
 * Validate a SQL string for the `bigquery_run_query` tool. Returns either
 * `{ ok: true, normalized }` (whitespace-collapsed, trailing `;` removed)
 * or `{ ok: false, error }` with a single-line, user-friendly explanation.
 */
export function validateReadOnlySql(raw: unknown): SqlValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "sql must be a string" };
  }

  const sql = raw.trim();
  if (sql === "") return { ok: false, error: "sql is empty" };
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    return {
      ok: false,
      error: `sql exceeds the ${MAX_SQL_BYTES}-byte limit; trim the query`,
    };
  }

  const stripped = stripCommentsAndLiterals(sql);

  // Single-statement check: at most one trailing `;` (allowed but optional).
  const trimmedSemicolon = stripped.replace(/;\s*$/, "");
  if (trimmedSemicolon.includes(";")) {
    return {
      ok: false,
      error:
        "only a single statement is allowed (no `;` between statements)",
    };
  }

  const codeNormalized = trimmedSemicolon.replace(/\s+/g, " ").trim();
  if (codeNormalized === "") {
    return {
      ok: false,
      error: "sql contains no executable code",
    };
  }

  const upper = codeNormalized.toUpperCase();

  // 1) Forbidden keywords first — more informative than the leading-keyword
  // fallback. Catches DDL/DML/scripting whether they appear at the start
  // (e.g. `INSERT INTO …`) or anywhere else (e.g. `… UNION ALL DELETE …`).
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(?:^|[^A-Z0-9_])${kw}(?=[^A-Z0-9_]|$)`);
    if (re.test(upper)) {
      return {
        ok: false,
        error: `forbidden keyword '${kw}' (only read-only SELECT/WITH queries are allowed)`,
      };
    }
  }

  // 2) Leading keyword: SELECT or WITH only.
  const firstWordMatch = upper.match(/^([A-Z][A-Z0-9_]*)/);
  if (!firstWordMatch) {
    return {
      ok: false,
      error: "sql must start with a SQL keyword (SELECT or WITH)",
    };
  }
  const firstWord = firstWordMatch[1];
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    return {
      ok: false,
      error: `sql must start with SELECT or WITH (got '${firstWord}')`,
    };
  }

  // Note: we do NOT verify that a WITH statement ends in a top-level SELECT
  // (a CTE body without a final SELECT is malformed SQL and BigQuery will
  // reject it at execution time). The validator's role here is safety, not
  // syntax checking; the forbidden-keywords pass already eliminated DML/DDL.

  // Normalized form: original whitespace collapsed, no trailing `;`.
  const normalized = sql.replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
  return { ok: true, normalized };
}

/**
 * Replace comments and string literals with spaces of equal length. Keeps
 * the input length stable so column numbers in error messages (if we ever
 * surface them) line up. Handles:
 *   - `--` line comments to end of line
 *   - `/* ... * /` block comments
 *   - `'...'` and `"..."` literals (with `''`/`""` escapes)
 *   - Triple-quoted literals (`'''...'''`, `"""..."""`)
 */
function stripCommentsAndLiterals(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? "";
    const next = s[i + 1] ?? "";

    if (ch === "-" && next === "-") {
      out.push(" ", " ");
      i += 2;
      while (i < s.length && s[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        out.push(s[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < s.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const triple = s.slice(i, i + 3) === quote.repeat(3);
      out.push(" ");
      i += 1;
      if (triple) {
        out.push(" ", " ");
        i += 2;
        while (i < s.length && s.slice(i, i + 3) !== quote.repeat(3)) {
          out.push(s[i] === "\n" ? "\n" : " ");
          i += 1;
        }
        if (i < s.length) {
          out.push(" ", " ", " ");
          i += 3;
        }
      } else {
        while (i < s.length) {
          if (s[i] === "\\" && i + 1 < s.length) {
            out.push(" ", " ");
            i += 2;
            continue;
          }
          if (s[i] === quote && s[i + 1] === quote) {
            out.push(" ", " ");
            i += 2;
            continue;
          }
          if (s[i] === quote) {
            out.push(" ");
            i += 1;
            break;
          }
          out.push(s[i] === "\n" ? "\n" : " ");
          i += 1;
        }
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join("");
}
