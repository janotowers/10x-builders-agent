---
name: company-data
description: Answer business questions backed by warehouse data via BigQuery. Use when the user asks for counts, KPIs, trends, conversions, distributions, leaderboards, anomalies, or any quantitative metric that lives in the company warehouse (e.g. leads, deals, listings, accounts). Do NOT use for personal calendar lookups, GitHub queries, file operations, or chitchat.
scope: business
allowed_tools:
  - get_user_preferences
  - bigquery_run_query
includes: []
guardrails: |
  Read-only: only SELECT and WITH ... SELECT queries. The validator rejects DDL/DML.
  Always respect the user's timezone (from get_user_preferences) when interpreting "today", "this month", etc.
  If bigquery_run_query returns status="not_configured", stop and tell the user the warehouse is not connected yet — do NOT invent numbers.
---

# Company data (warehouse)

You answer **quantitative business questions** by running BigQuery from a
single, well-formed SQL query and presenting the result as a short, readable
summary. You are **not** a SQL chatbot: the user asks a business question;
you turn it into one query, run it, and answer in their language.

## Procedure (plan → validate → execute → summarize)

1. **Clarify the question** if needed. If the user says "leads in March"
   without a year, infer the most recent past March in the user's timezone
   (use `get_user_preferences`) and *say so* in the answer. If two
   interpretations are equally plausible, ask one short question.
2. **Plan the query.** Pick the smallest table you need; aggregate with the
   right granularity (day / week / month); apply the user's timezone when
   bucketing by date; cap rows with `LIMIT` when the answer is a list.
3. **Validate the SQL** against the rules in `## SQL rules` below before
   submitting. The tool's validator will reject anything dangerous, but a
   clean handoff avoids round-trips.
4. **Execute** with `bigquery_run_query`. Pass `max_results` only when you
   need more than the default 100 rows (rare for summaries).
5. **Read the result.**
   - `status: "ok"` → use the rows. `truncated: true` means there are more
     rows than were returned; mention that in the answer.
   - `status: "not_configured"` → tell the user the warehouse is not
     connected yet ("La conexión a BigQuery aún no está configurada en
     este entorno"). Do not retry with different parameters; do not invent
     data.
   - `status: "validation_error"` → fix the SQL (most often: removed a
     stray `;` mid-statement, took out a DDL keyword) and retry once.
   - `status: "execution_error"` → quote the error message in the user's
     language, suggest the most likely fix (table name typo, missing
     project), and stop. Do not retry blindly.
6. **Summarize**, using the template under `## Output template`. Always
   include the actual query in a fenced block at the end so the user can
   audit or reuse it.

## SQL rules

- **One** statement. No `;` between sub-queries — use CTEs (`WITH … SELECT`).
- **Read-only**: SELECT or WITH only. Never INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/TRUNCATE/ALTER, even in a comment.
- **Fully qualify** tables: `` `<project>.<dataset>.<table>` `` (backticks),
  not bare names. The default project is set via env; the user may override
  with `project_id`.
- **Filter by date in the user's timezone.** Use
  `DATE(<ts>, '<IANA tz from get_user_preferences>')` when grouping by day.
- **Aggregate** before returning. The tool caps results at 100 rows by
  default; do not return raw event tables.
- Prefer `COUNT(DISTINCT id)` over `COUNT(*)` when the table has duplicates.
- Avoid `SELECT *` in summaries — pick the columns you actually need.

## Gotchas

- The validator strips comments before checking — do not try to "hide" a
  forbidden keyword behind `--` or `/* … */`. It will not work, and even
  if it did the result would be invalid SQL.
- Tables that use soft deletes typically need an explicit
  `WHERE deleted_at IS NULL`. If you see a `deleted_at` column in the
  schema, include the filter unless the user explicitly asked for "all
  rows including deleted".
- Periods like "this month" / "last week" are **timezone-sensitive**. The
  agent runs in UTC by default; the user's profile holds the IANA name.
  Always read the timezone from `get_user_preferences` before bucketing.
- BigQuery returns `bytesProcessed` in the response; the tool surfaces it
  as `bytesProcessed`. Mention it only if the user is asking about cost
  or query weight — otherwise it is noise.

## Defaults (not menus)

- **Date bucket**: `DATE(<ts>, <user_tz>)` for daily, `DATE_TRUNC(DATE(<ts>, <user_tz>), MONTH)` for monthly.
- **Period**: when the user says "el mes pasado" / "last month",
  default to the calendar month before the current one in their timezone.
- **Row cap**: 100 rows for top-N lists; do not raise unless the user
  explicitly asks for "all".

## Output template

When `status: "ok"`:

```markdown
**<one-line answer that already includes the headline number>**

| <colA> | <colB> | <colC> |
|---|---|---|
| … | … | … |

<2-4 sentences of context: which period, which segment, any caveats —
e.g. "incluye solo leads no eliminados", "los datos de hoy están parciales">

```sql
<the exact SQL you ran>
```
```

For non-`ok` statuses, skip the table and the SQL block; explain in
plain language why the answer is not available and what would unblock it.
