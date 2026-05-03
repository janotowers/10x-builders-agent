# Conventions — Ungga Warehouse Core

## Tenant Filter

For normal tenant mode, every business-data query must include:

```sql
u.organization_id = @organization_id
```

Pass `organization_id` via `params`. Never inline it.

## Timezone

Business reporting uses `America/Mexico_City`.

```sql
DATE(<timestamp>, 'America/Mexico_City')
DATE_TRUNC(DATE(<timestamp>, 'America/Mexico_City'), MONTH)
DATE_TRUNC(DATE(<timestamp>, 'America/Mexico_City'), WEEK(MONDAY))
```

Calculate `@start_date` and `@end_date` outside SQL and pass them as params. `bigquery_run_query` rejects scripting (`DECLARE`, `SET`, `BEGIN`).

## Canonical Filters

- Exclude test users: `(u.is_test IS NULL OR u.is_test = FALSE)`.
- Use `_light` views only.
- Prefer `ORDER BY <timestamp> DESC LIMIT @limit` for lists.
- Avoid `SELECT *` except one-row exploration.

## Parameterization

Use named params for user-provided or tenant-provided values:

```sql
WHERE u.organization_id = @organization_id
  AND REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
      = REGEXP_REPLACE(@lead_phone, r'[^0-9]+', '')
```

## PII

Names, phones, emails, addresses, message bodies, and public URLs can be sensitive. Return the minimum needed for the task. For drafting one lead follow-up, a single matching lead row plus recent messages is acceptable.
