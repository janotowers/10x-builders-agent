# Joins — Ungga Warehouse Core

## General Rules

- Normalize prefixed FKs before comparing: `REPLACE(col, 'users/', '')`, `REPLACE(col, 'properties/', '')`, etc.
- Anchor tenant-scoped queries through `users_light.organization_id`.
- Use `COUNT(DISTINCT pk)` when joins can multiply rows.

## Common Joins

| From | To | Pattern |
|---|---|---|
| `leads_light.owner_firebase_id` | `users_light.document_id` | `REPLACE(l.owner_firebase_id, 'users/', '') = u.document_id` |
| `properties_light.user_owner` | `users_light.document_id` | `REPLACE(p.user_owner, 'users/', '') = u.document_id` |
| `gu_numbers_light.user_owner` | `users_light.document_id` | `REPLACE(g.user_owner, 'users/', '') = u.document_id` |
| `messages_light.document_id` | `gu_numbers_light.phone_number` | `m.document_id = g.phone_number` |
| `leads_light.current_property_id` | `properties_light.document_id` | `REPLACE(l.current_property_id, 'properties/', '') = p.document_id` |
| `leads_light.current_question_property_id` | `properties_light.document_id` | `REPLACE(l.current_question_property_id, 'properties/', '') = p.document_id` |

## Messages To Leads — Country-Agnostic Pattern

Extract the lead path from messages:

```sql
REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
```

Join to leads using both supported path formats:

```sql
WITH msgs AS (
  SELECT
    m.*,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
)
SELECT ...
FROM msgs m
JOIN `ungga-full.mongo_data.leads_light` l
  ON m.lead_path = l.lead_id
  OR (
    REGEXP_CONTAINS(m.lead_path, r'^\d+$')
    AND STARTS_WITH(
      m.lead_path,
      REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
    )
  )
```

Never use `SUBSTR(..., 1, 13)` or regexes that assume MX phone length.

## Messages Scoped To Tenant

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
gu_phones AS (
  SELECT g.phone_number AS gu_phone
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  JOIN user_ids u ON REPLACE(g.user_owner, 'users/', '') = u.user_id
)
SELECT
  REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
  m.message_time,
  LOWER(TRIM(m.author)) AS author,
  m.message
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
```
