# Few-Shots — Messages / Conversations

Use with `schema`, `joins`, and `conventions` for conversation lookup.

## Latest Messages For A Lead Phone

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
),
lead_target AS (
  SELECT
    l.lead_id,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm
  FROM `ungga-full.mongo_data.leads_light` l
  JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
  WHERE REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
        = REGEXP_REPLACE(@lead_phone, r'[^0-9]+', '')
),
msgs AS (
  SELECT
    m.message_time,
    LOWER(TRIM(m.author)) AS author,
    m.message,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
)
SELECT
  m.message_time,
  m.author,
  m.message
FROM msgs m
JOIN lead_target lt
  ON m.lead_path = lt.lead_id
  OR (
    REGEXP_CONTAINS(m.lead_path, r'^\d+$')
    AND STARTS_WITH(m.lead_path, lt.phone_norm)
  )
ORDER BY m.message_time DESC
LIMIT @limit
```

Params:

```json
{
  "organization_id": "<tenant organization_id>",
  "lead_phone": "<phone from user>",
  "limit": 10
}
```

## Latest Conversations For A Tenant

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
),
msgs AS (
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    m.document_id AS gu_phone,
    m.message_time,
    LOWER(TRIM(m.author)) AS author,
    m.message
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
)
SELECT
  lead_path,
  message_time,
  author,
  message
FROM msgs
QUALIFY ROW_NUMBER() OVER (PARTITION BY lead_path ORDER BY message_time DESC) = 1
ORDER BY message_time DESC
LIMIT @limit
```

## Author Definitions

- `author = 'user'`: inbound lead/human message.
- `author = 'gu'`: outbound Gu/bot message.
- Do not use `author <> 'gu'` for human traffic unless explicitly asked to include non-canonical labels.
