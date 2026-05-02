import assert from "node:assert/strict";
import { validateReadOnlySql, MAX_SQL_BYTES } from "./bigquery-sql";

function expectOk(sql: string, label: string): string {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, true, `${label}: expected ok, got error ${"error" in r ? r.error : ""}`);
  return r.ok ? r.normalized : "";
}

function expectErr(sql: unknown, fragment: string | RegExp, label: string): void {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, false, `${label}: expected error, got ok`);
  if (!r.ok) {
    if (typeof fragment === "string") {
      assert.ok(
        r.error.includes(fragment),
        `${label}: '${r.error}' does not include '${fragment}'`
      );
    } else {
      assert.match(r.error, fragment, label);
    }
  }
}

let passed = 0;

// ── Happy paths ────────────────────────────────────────────────

expectOk("SELECT 1", "minimal SELECT");
passed += 1;

expectOk(
  "  SELECT name, COUNT(*) AS n FROM `proj.ds.leads` WHERE created_at >= '2024-01-01' GROUP BY name ORDER BY n DESC LIMIT 100  ",
  "real SELECT with aggregates"
);
passed += 1;

expectOk("SELECT 1;", "trailing semicolon allowed");
passed += 1;

expectOk(
  "WITH recent AS (SELECT * FROM `proj.ds.leads` WHERE created_at >= CURRENT_DATE() - 30) SELECT COUNT(*) FROM recent",
  "WITH...SELECT CTE"
);
passed += 1;

expectOk(
  "SELECT '2024-01-01' AS ts, name FROM `proj.ds.leads` WHERE name = 'O''Brien'",
  "string literal with escaped quote"
);
passed += 1;

expectOk(
  `SELECT """multi\nline\nstring""" AS s, name FROM \`proj.ds.leads\``,
  "triple-quoted literal"
);
passed += 1;

expectOk(
  "SELECT name -- this is a comment\nFROM `proj.ds.leads`",
  "line comment is stripped"
);
passed += 1;

expectOk(
  "SELECT /* block\ncomment */ name FROM `proj.ds.leads`",
  "block comment is stripped"
);
passed += 1;

expectOk(
  "SELECT CASE WHEN status = 'active' THEN 1 ELSE 0 END AS active FROM `proj.ds.leads`",
  "CASE WHEN ... THEN ... END is allowed"
);
passed += 1;

expectOk(
  "SELECT IF(amount > 0, 'paid', 'pending') AS state FROM `proj.ds.invoices`",
  "IF() function is allowed"
);
passed += 1;

expectOk(
  "SELECT REPLACE(user_owner, 'users/', '') AS user_id FROM `proj.ds.properties`",
  "REPLACE() scalar function is allowed"
);
passed += 1;

// ── Reject DDL ─────────────────────────────────────────────────

expectErr("CREATE TABLE foo (a INT64)", /CREATE/, "CREATE TABLE");
passed += 1;
expectErr("DROP TABLE proj.ds.leads", /DROP/, "DROP TABLE");
passed += 1;
expectErr("ALTER TABLE proj.ds.leads ADD COLUMN x INT64", /ALTER/, "ALTER TABLE");
passed += 1;
expectErr("TRUNCATE TABLE proj.ds.leads", /TRUNCATE/, "TRUNCATE");
passed += 1;

// ── Reject DML ─────────────────────────────────────────────────

expectErr("INSERT INTO proj.ds.leads VALUES (1)", /INSERT/, "INSERT");
passed += 1;
expectErr("UPDATE proj.ds.leads SET name='x'", /UPDATE/, "UPDATE");
passed += 1;
expectErr("DELETE FROM proj.ds.leads WHERE id=1", /DELETE/, "DELETE");
passed += 1;
expectErr(
  "MERGE proj.ds.target T USING proj.ds.src S ON T.id=S.id WHEN MATCHED THEN UPDATE SET T.x = S.x",
  /forbidden keyword/,
  "MERGE/UPDATE"
);
passed += 1;

// ── Reject scripting / control ─────────────────────────────────

expectErr("BEGIN SELECT 1 END", /BEGIN/, "BEGIN block keyword");
passed += 1;
expectErr("DECLARE x INT64", /DECLARE/, "DECLARE");
passed += 1;
expectErr("SET x = 1", /SET/, "SET");
passed += 1;
expectErr("CALL proj.ds.proc()", /CALL/, "CALL procedure");
passed += 1;
expectErr("EXPORT DATA OPTIONS() AS SELECT 1", /EXPORT/, "EXPORT statement");
passed += 1;
expectErr("GRANT `roles/viewer` ON SCHEMA proj.ds TO 'a@b.c'", /GRANT/, "GRANT");
passed += 1;

// ── Reject multiple statements ─────────────────────────────────

expectErr("SELECT 1; SELECT 2", /single statement/, "two statements");
passed += 1;

// ── Reject by leading keyword ──────────────────────────────────

expectErr("EXPLAIN SELECT 1", /SELECT or WITH/, "non-allowed leading keyword");
passed += 1;

// ── Reject empty / non-string ──────────────────────────────────

expectErr("", "empty", "empty string");
passed += 1;
expectErr(null, "must be a string", "null");
passed += 1;
expectErr(123, "must be a string", "number");
passed += 1;
expectErr("   \n\t  ", "empty", "whitespace only");
passed += 1;

// ── Comment cannot hide DDL ────────────────────────────────────

expectOk(
  "SELECT 1 -- DROP TABLE evil",
  "DDL keyword inside line comment is ignored"
);
passed += 1;
expectOk(
  "SELECT 1 /* DROP TABLE evil */",
  "DDL keyword inside block comment is ignored"
);
passed += 1;

// ── String literal cannot smuggle DDL ──────────────────────────

expectOk(
  "SELECT 'DROP TABLE x' AS msg FROM `proj.ds.leads`",
  "DDL keyword inside string literal is ignored"
);
passed += 1;

// ── Size cap ───────────────────────────────────────────────────

expectErr("SELECT '" + "x".repeat(MAX_SQL_BYTES) + "'", /limit/, "oversize sql");
passed += 1;

// ── Parameterized queries pass through ─────────────────────────

expectOk(
  "SELECT * FROM `proj.ds.users` WHERE organization_id = @organization_id",
  "named parameter @organization_id"
);
passed += 1;

expectOk(
  "SELECT id FROM `proj.ds.t` WHERE created_at >= @from AND created_at < @to LIMIT @lim",
  "multiple named parameters"
);
passed += 1;

expectOk(
  "WITH x AS (SELECT * FROM `proj.ds.t` WHERE id = @id) SELECT COUNT(*) FROM x",
  "parameter inside CTE"
);
passed += 1;

console.log("tools/bigquery-sql.selftest: all", passed, "cases passed");
