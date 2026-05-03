# Lead Context Lookup

Use this reference when the user provides a lead identifier and asks for a follow-up WhatsApp or email.

For general schema, joins, conventions, or reusable message/lead patterns, load the shared `business-data-core` references via `read_skill_reference("schema")`, `read_skill_reference("joins")`, `read_skill_reference("fewshots-messages")`, or `read_skill_reference("fewshots-leads")`.

## Goal

Fetch just enough context to draft a personalized follow-up:

- Lead name, phone/email, portal/source, last interaction, contact status.
- Current property or question property, including address/title-like fields when present.
- Recent messages in the conversation, newest first.

Do not expose raw phone/email back to the user unless they explicitly ask. Use PII only to identify the correct row and personalize the draft.

## Contract With `bigquery_run_query` (READ THIS FIRST)

You MUST use named parameters (`@name`) for every value derived from the user. The tool input has TWO fields you must populate together:

```jsonc
{
  "sql":   "<SQL with @placeholders>",
  "params": {
    "lead_name":  "<value from user>",   // REQUIRED when SQL uses @lead_name
    "lead_phone": "<value from user>",   // REQUIRED when SQL uses @lead_phone
    "lead_email": "<value from user>"    // REQUIRED when SQL uses @lead_email
  }
}
```

Hard rules:

- If your SQL contains `@lead_phone`, you MUST include `lead_phone` in `params`. Same for `@lead_name` and `@lead_email`. Forgetting this returns `Query parameter 'X' not found at [...]` and the call fails.
- `@organization_id` is the ONE exception: the agent auto-injects it from the trusted tenant context if your SQL uses `@organization_id` and you didn't pass it. Still, including it explicitly in `params` is fine and recommended for clarity.
- NEVER inline raw values in the SQL (e.g. `WHERE phone = '521…'` is wrong). Always parameterize.
- NEVER quote the parameter placeholder. Use `@lead_phone`, never `'@lead_phone'`.

## Allowed Tables (fully qualified)

Use ONLY these names verbatim. Do not invent shorter aliases like `` `ungga-full.leads_light` `` (no dataset → `Dataset 'ungga-full' was not found`).

| Purpose | Fully-qualified name |
|---|---|
| Tenant anchor (users) | `` `ungga-full.firestore_users.users_light` `` |
| Leads | `` `ungga-full.mongo_data.leads_light` `` |
| Properties | `` `ungga-full.firestore_properties.properties_light` `` |
| Messages | `` `ungga-full.firestore_messages.messages_light` `` |
| Gu numbers (asesor phone → user) | `` `ungga-full.firestore_gu_numbers.gu_numbers_light` `` |

If you need any other table, STOP and load `read_skill_reference("schema")` from `business-data-core` instead of guessing.

## Tenant Rules

The active skill requires tenant context. In normal mode, every query must filter to the tenant using:

```sql
u.organization_id = @organization_id
```

Pass `organization_id` via `params`; never inline it.

## Name Lookup With Recent Messages

Use this when the user gives a name, such as "Su nombre es Julieta Evelia". It returns up to 5 matching leads and recent conversation snippets. If exactly one row comes back with useful context, draft from it. If multiple rows come back, ask the user to choose.

Important:

- Copy the full query shape through the final `SELECT`. Do not simplify it to only `name`, `lead_id`, `last_message`, or `last_interaction`; that causes generic drafts.
- The final result must include `property_id`, `address`, `city`, `house_type`, `monetization_type_display`, `public_url`, and `recent_messages`.
- If these context fields are null/empty, tell the user the lead was found but there is not enough property/conversation context to personalize the message.
- **Name matching is tolerant**: the `WHERE` clause normalizes punctuation/case on BOTH sides (`Julieta Evelia` will match `Julieta. Evelia`, `JULIETA  EVELIA`, etc.). Do NOT replace it with a plain `LIKE '%X%'` over `l.name`.
- The matching SQL is `LIKE '%X%'`, so passing the FULL name the user gave (first + last) is fine; the normalizer collapses whitespace and removes punctuation.

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
lead_matches AS (
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
    l.current_property_id,
    l.current_question_property_id,
    l.owner_name,
    l.owner_last_name,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm
  FROM `ungga-full.mongo_data.leads_light` l
  JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
  WHERE REGEXP_REPLACE(LOWER(TRIM(l.name)), r'[^a-z0-9]+', ' ')
        LIKE CONCAT(
          '%',
          REGEXP_REPLACE(LOWER(TRIM(@lead_name)), r'[^a-z0-9]+', ' '),
          '%'
        )
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY l.lead_id
    ORDER BY l.last_interaction DESC NULLS LAST, l.created_at DESC NULLS LAST
  ) = 1
  ORDER BY l.last_interaction DESC NULLS LAST, l.created_at DESC NULLS LAST
  LIMIT 5
),
messages_scoped AS (
  SELECT
    m.message_time,
    LOWER(TRIM(m.author)) AS author,
    m.message,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
    ON m.document_id = g.phone_number
  JOIN user_ids u ON REPLACE(g.user_owner, 'users/', '') = u.user_id
  WHERE m.message_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
),
lead_messages AS (
  SELECT
    lm.lead_id,
    ARRAY_AGG(
      IF(
        ms.message_time IS NULL,
        NULL,
        STRUCT(ms.message_time, ms.author, ms.message)
      ) IGNORE NULLS
      ORDER BY ms.message_time DESC
      LIMIT 8
    ) AS recent_messages
  FROM lead_matches lm
  LEFT JOIN messages_scoped ms
    ON ms.lead_path = lm.lead_id
    OR (
      REGEXP_CONTAINS(ms.lead_path, r'^\d+$')
      AND lm.phone_norm IS NOT NULL
      AND lm.phone_norm != ''
      AND STARTS_WITH(ms.lead_path, lm.phone_norm)
    )
  GROUP BY lm.lead_id
),
property_context AS (
  SELECT
    lm.lead_id,
    p.document_id AS property_id,
    p.address,
    p.city,
    p.state,
    p.house_type,
    p.monetization_type_display,
    p.price_display,
    p.currency_display,
    p.public_url
  FROM lead_matches lm
  LEFT JOIN `ungga-full.firestore_properties.properties_light` p
    ON p.document_id = REPLACE(
      COALESCE(lm.current_question_property_id, lm.current_property_id),
      'properties/',
      ''
    )
)
SELECT
  lm.lead_id,
  lm.name,
  lm.portal,
  lm.from_ad,
  lm.created_at,
  lm.last_interaction,
  lm.dialog_state,
  lm.last_message,
  lm.contact_method,
  lm.contacted_by_gu,
  CONCAT(COALESCE(lm.owner_name, ''), ' ', COALESCE(lm.owner_last_name, '')) AS owner_name,
  pc.property_id,
  pc.address,
  pc.city,
  pc.state,
  pc.house_type,
  pc.monetization_type_display,
  pc.price_display,
  pc.currency_display,
  pc.public_url,
  lmsg.recent_messages AS recent_messages
FROM lead_matches lm
LEFT JOIN property_context pc ON pc.lead_id = lm.lead_id
LEFT JOIN lead_messages lmsg ON lmsg.lead_id = lm.lead_id
ORDER BY lm.last_interaction DESC NULLS LAST, lm.created_at DESC NULLS LAST
```

Concrete `bigquery_run_query` input (replace the placeholder values; do NOT change the keys or skip `params`):

```jsonc
{
  "sql": "WITH user_ids AS (...) ... ORDER BY ...",   // the full SQL block above, verbatim
  "params": {
    "organization_id": "users/abc123…",   // from [Contexto de tenant]
    "lead_name": "Julieta Evelia"          // from the user's current turn
  },
  "max_results": 5,
  "project_id": "ungga-full",
  "location": "US"
}
```

## Phone Lookup

When the user provides a phone number, use the same full query above and replace only the `lead_matches` `WHERE` clause with:

```sql
  WHERE REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
        = REGEXP_REPLACE(@lead_phone, r'[^0-9]+', '')
```

Keep every CTE after `lead_matches` exactly the same (`messages_scoped`, `lead_messages`, `property_context`, and the full final `SELECT`). Do not return only identity fields.

Concrete `bigquery_run_query` input:

```jsonc
{
  "sql": "WITH user_ids AS (...) ... ORDER BY ...",   // the full block, with the WHERE swapped as shown above
  "params": {
    "organization_id": "users/abc123…",
    "lead_phone": "5216688255676"
  },
  "max_results": 5,
  "project_id": "ungga-full",
  "location": "US"
}
```

## Email Lookup

When the user provides email, use the same full query above and replace only the `lead_matches` `WHERE` clause with:

```sql
  WHERE LOWER(TRIM(l.email)) = LOWER(TRIM(@lead_email))
```

Keep every CTE after `lead_matches` exactly the same.

Concrete `bigquery_run_query` input:

```jsonc
{
  "sql": "WITH user_ids AS (...) ... ORDER BY ...",   // full block with the email WHERE swapped
  "params": {
    "organization_id": "users/abc123…",
    "lead_email": "julieta@example.com"
  },
  "max_results": 5,
  "project_id": "ungga-full",
  "location": "US"
}
```

## Drafting Guidance

Use the last few messages to infer the next best step. Examples:

- If the conversation mentions a property, reference it naturally.
- If the lead asked for price, availability, financing, or a visit, follow up on that topic.
- If the last message is old, write a reactivation-style message.
- If the data is inconclusive but includes at least one useful context field, keep the message concise and avoid pretending to know details.
- If the row only proves identity (name/lead_id/phone/email) and has no recent messages, property, `last_message`, `last_interaction`, or `dialog_state`, do not draft. Ask for the property or last interaction.

Never claim current availability, discounts, or financing terms unless they appear in the query result.
