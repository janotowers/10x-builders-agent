# Few-Shots — Leads

Use `mongo_data.leads_light` as the canonical leads table. There is no `firestore_leads.leads_light`.

## Lead Lookup By Name, Phone, Or Email With Property Context

This is the preferred shape when a skill needs enough context to personalize a lead response.

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
lead_candidates AS (
  SELECT
    l.lead_id,
    l.name,
    l.email,
    l.phone_number,
    l.portal,
    l.from_ad,
    l.created_at,
    l.last_interaction,
    l.dialog_state,
    l.last_message,
    l.contact_method,
    l.contacted_by_gu,
    REPLACE(l.owner_firebase_id, 'users/', '') AS owner_user_id,
    COALESCE(
      REPLACE(l.current_property_id, 'properties/', ''),
      REPLACE(l.current_question_property_id, 'properties/', '')
    ) AS property_id,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm
  FROM `ungga-full.mongo_data.leads_light` l
  JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
  WHERE (
    @lead_id IS NOT NULL AND l.lead_id = @lead_id
  ) OR (
    @lead_phone IS NOT NULL
    AND REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
        = REGEXP_REPLACE(@lead_phone, r'[^0-9]+', '')
  ) OR (
    @lead_email IS NOT NULL
    AND LOWER(TRIM(l.email)) = LOWER(TRIM(@lead_email))
  ) OR (
    @lead_name IS NOT NULL
    AND REGEXP_REPLACE(LOWER(TRIM(l.name)), r'[^a-z0-9áéíóúüñ ]+', '')
        LIKE CONCAT('%', REGEXP_REPLACE(LOWER(TRIM(@lead_name)), r'[^a-z0-9áéíóúüñ ]+', ''), '%')
  )
),
property_context AS (
  SELECT
    p.document_id AS property_id,
    p.address,
    p.city,
    p.state,
    p.house_type,
    p.monetization_type_display,
    p.price_display,
    p.currency_display,
    p.public_url,
    p.ad_status
  FROM `ungga-full.firestore_properties.properties_light` p
),
recent_messages AS (
  SELECT
    lc.lead_id,
    ARRAY_AGG(STRUCT(
      m.message_time AS message_time,
      LOWER(TRIM(m.author)) AS author,
      m.message AS message
    ) ORDER BY m.message_time DESC LIMIT 8) AS recent_messages
  FROM lead_candidates lc
  JOIN `ungga-full.firestore_messages.messages_light` m
    ON REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = lc.lead_id
    OR (
      REGEXP_CONTAINS(REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/'), r'^\d+$')
      AND STARTS_WITH(
        REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/'),
        lc.phone_norm
      )
    )
  GROUP BY lc.lead_id
)
SELECT
  lc.lead_id,
  lc.name,
  lc.email,
  lc.phone_number,
  lc.portal,
  lc.created_at,
  lc.last_interaction,
  lc.dialog_state,
  lc.last_message,
  lc.contact_method,
  lc.contacted_by_gu,
  lc.property_id,
  pc.address,
  pc.city,
  pc.state,
  pc.house_type,
  pc.monetization_type_display,
  pc.price_display,
  pc.currency_display,
  pc.public_url,
  pc.ad_status,
  rm.recent_messages
FROM lead_candidates lc
LEFT JOIN property_context pc ON lc.property_id = pc.property_id
LEFT JOIN recent_messages rm ON lc.lead_id = rm.lead_id
ORDER BY lc.last_interaction DESC NULLS LAST, lc.created_at DESC NULLS LAST
LIMIT @limit
```

For name-only lookups, use `limit` greater than 1 and disambiguate if more than one row returns.

## Lead Counts By Period

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT COUNT(DISTINCT l.lead_id) AS leads_creados
FROM `ungga-full.mongo_data.leads_light` l
JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
WHERE DATE(l.created_at, 'America/Mexico_City') >= @start_date
  AND DATE(l.created_at, 'America/Mexico_City') <  @end_date
```
