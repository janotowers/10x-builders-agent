# Few-shots — Mensajes / Conversaciones

> Referencias clave: `joins.md` (mensajes ↔ leads via `document_name`),
> `glossary.md` (autor humano vs Gu).

## Basic patterns

### B1. Total de mensajes en un período (de la inmobiliaria)

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
SELECT COUNT(*) AS mensajes
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date;
```

### B2. Mensajes por día (serie temporal)

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
  DATE(m.message_time, 'America/Mexico_City') AS dia,
  COUNT(*) AS mensajes
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
GROUP BY dia
ORDER BY dia;
```

### B3. Mensajes salientes (Gu) vs entrantes (humano)

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
  CASE WHEN LOWER(TRIM(m.author)) = 'gu' THEN 'gu_saliente' ELSE 'humano_entrante' END AS tipo,
  COUNT(*) AS mensajes
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
GROUP BY tipo
ORDER BY mensajes DESC;
```

### B4. Conversaciones únicas en un período

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
SELECT COUNT(DISTINCT REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/')) AS conversaciones
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date;
```

### B5. Últimos N mensajes de una conversación específica

> Pide al usuario `@lead_id` o resuélvelo por nombre/teléfono primero.

```sql
SELECT
  m.message_time,
  m.author,
  m.message
FROM `ungga-full.firestore_messages.messages_light` m
WHERE REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = @lead_id
ORDER BY m.message_time DESC
LIMIT @limit;
```

## Advanced analyses

### A1. Tasa de respuesta de Gu (mensajes-Gu / mensajes-humanos por lead)

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
mensajes_periodo AS (
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT
  lead_id,
  COUNTIF(author_norm  = 'gu') AS msgs_gu,
  COUNTIF(author_norm <> 'gu') AS msgs_humano,
  SAFE_DIVIDE(COUNTIF(author_norm = 'gu'), COUNTIF(author_norm <> 'gu')) AS ratio_gu_humano
FROM mensajes_periodo
WHERE lead_id IS NOT NULL
GROUP BY lead_id
ORDER BY ratio_gu_humano DESC NULLS LAST
LIMIT @limit;
```

### A2. Tiempo de primera respuesta del lead a Gu

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
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id,
    m.message_time,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT
  lead_id,
  MIN(IF(author_norm = 'gu', message_time, NULL)) AS first_gu,
  MIN(IF(author_norm <> 'gu', message_time, NULL)) AS first_humano,
  TIMESTAMP_DIFF(
    MIN(IF(author_norm <> 'gu', message_time, NULL)),
    MIN(IF(author_norm  = 'gu', message_time, NULL)),
    MINUTE
  ) AS minutos_a_primer_respuesta_humano
FROM msgs
WHERE lead_id IS NOT NULL
GROUP BY lead_id
HAVING minutos_a_primer_respuesta_humano IS NOT NULL
   AND minutos_a_primer_respuesta_humano >= 0
ORDER BY minutos_a_primer_respuesta_humano
LIMIT @limit;
```

### A3. Mensajes-a-leads por matching directo `lead_id`

> Cuando necesites datos del lead (nombre, teléfono) en cada mensaje:

```sql
SELECT
  REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id,
  l.name AS lead_name,
  l.phone_number AS lead_phone,
  m.message_time,
  m.author,
  m.message
FROM `ungga-full.firestore_messages.messages_light` m
JOIN `ungga-full.mongo_data.leads_light` l
  ON REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = l.lead_id
JOIN `ungga-full.firestore_users.users_light` u
  ON REPLACE(l.owner_firebase_id, 'users/', '') = u.document_id
WHERE u.organization_id = @organization_id
  AND DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
ORDER BY m.message_time DESC
LIMIT @limit;
```
