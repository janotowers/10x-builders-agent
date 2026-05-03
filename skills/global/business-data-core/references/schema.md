# Schema — Ungga Warehouse Core

Use only `_light` views. Never query `_raw_light`.

## Tenant Anchor

`ungga-full.firestore_users.users_light`

- `document_id` STRING: user id.
- `organization_id` STRING: canonical tenant id.
- `is_test` BOOL: exclude test users with `(is_test IS NULL OR is_test = FALSE)`.
- `org_name`, `display_name`, `email`, `phone_number`: PII; use carefully.

Canonical tenant CTE:

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
```

## Leads

`ungga-full.mongo_data.leads_light`

- `lead_id` STRING: canonical PK.
- `name`, `email`, `phone_number`: PII.
- `owner_firebase_id`: FK to `users_light.document_id`, usually prefixed as `users/<id>`.
- `current_property_id`, `current_question_property_id`: FK to `properties_light.document_id`, usually prefixed as `properties/<id>`.
- `created_at`, `last_interaction`: timestamps.
- `portal`, `from_ad`, `dialog_state`, `last_message`, `contact_method`, `contacted_by_gu`: context fields useful for drafting.

## Properties

`ungga-full.firestore_properties.properties_light`

- `document_id` STRING: property id.
- `user_owner`: FK to `users_light.document_id`, prefixed as `users/<id>`.
- `address`, `city`, `state`, `house_type`, `monetization_type_display`, `price_display`, `currency_display`, `public_url`: property context.
- `ad_status`: publication state.

## Gu Numbers

`ungga-full.firestore_gu_numbers.gu_numbers_light`

- `phone_number`: Gu WhatsApp number. Join to messages with `m.document_id = g.phone_number`.
- `user_owner`: FK to `users_light.document_id`, prefixed as `users/<id>`.
- `is_active_gu`, `bypass_bot`, `asign_date`: Gu state.

## Messages

`ungga-full.firestore_messages.messages_light`

- `document_id`: Gu phone number.
- `document_name`: Firestore path containing the conversation id under `/leads/<lead_path>/wsp_messeges/`.
- `author`: canonical values are `gu` for outbound bot and `user` for inbound lead.
- `message`: message body.
- `message_time`: timestamp.

`document_name` has two formats:

- Old: `/leads/<lead_phone><gu_phone><user_phone>/wsp_messeges/<msg_id>`.
- New: `/leads/<lead_id>/wsp_messeges/<gu_phone>`.

Use `joins.md` for the country-agnostic join to leads.
