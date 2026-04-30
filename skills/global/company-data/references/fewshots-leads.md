# Few-shots — Leads

## Basic patterns

### B1. Leads creados en un período (de la inmobiliaria)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
leads_norm AS (
  SELECT
    l.lead_id,
    l.owner_firebase_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at),
             TIMESTAMP_SECONDS(SAFE_CAST(l.created_at AS INT64))) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
)
SELECT COUNT(DISTINCT l.lead_id) AS leads_creados
FROM leads_norm l
JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
WHERE DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
  AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date;
```

### B2. Leads creados por día (serie temporal)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
leads_norm AS (
  SELECT
    l.lead_id,
    l.owner_firebase_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at),
             TIMESTAMP_SECONDS(SAFE_CAST(l.created_at AS INT64))) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
)
SELECT
  DATE(l.created_at_norm, 'America/Mexico_City') AS dia,
  COUNT(DISTINCT l.lead_id)                       AS leads
FROM leads_norm l
JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
WHERE DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
  AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date
GROUP BY dia
ORDER BY dia;
```

### B3. Leads atendidos en el período (tienen al menos un mensaje)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
leads_scope AS (
  SELECT l.lead_id
  FROM `ungga-full.mongo_data.leads_light` l
  JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
),
mensajes_periodo AS (
  SELECT DISTINCT REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id
  FROM `ungga-full.firestore_messages.messages_light` m
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT COUNT(DISTINCT ls.lead_id) AS leads_atendidos
FROM leads_scope ls
JOIN mensajes_periodo mp ON ls.lead_id = mp.lead_id;
```

### B4. Leads que interactuaron (al menos un mensaje del lado humano)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id, u.phone_number AS owner_phone
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
leads_scope AS (
  SELECT l.lead_id, REPLACE(l.owner_firebase_id, 'users/', '') AS user_id
  FROM `ungga-full.mongo_data.leads_light` l
  JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
),
gu_phones AS (
  SELECT REPLACE(g.user_owner, 'users/', '') AS user_id, g.phone_number AS gu_phone
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
),
msgs_humanos AS (
  SELECT DISTINCT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id
  FROM `ungga-full.firestore_messages.messages_light` m
  WHERE LOWER(TRIM(m.author)) <> 'gu'
    AND DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
    AND m.author NOT IN (
      SELECT gu_phone FROM gu_phones
    )
)
SELECT COUNT(DISTINCT ls.lead_id) AS leads_que_interactuaron
FROM leads_scope ls
JOIN msgs_humanos mh ON ls.lead_id = mh.lead_id;
```

### B5. Listado de leads (cap 100)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  l.lead_id,
  l.name,
  l.phone_number,
  l.email,
  l.created_at,
  l.last_interaction
FROM `ungga-full.mongo_data.leads_light` l
JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
ORDER BY l.last_interaction DESC NULLS LAST
LIMIT @limit;
```

## Advanced analyses

### A1. Funnel: creados → atendidos → con cita → con deal

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
leads_norm AS (
  SELECT
    l.lead_id,
    REPLACE(l.owner_firebase_id, 'users/', '') AS user_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at),
             TIMESTAMP_SECONDS(SAFE_CAST(l.created_at AS INT64))) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
),
leads_periodo AS (
  SELECT l.lead_id, l.user_id
  FROM leads_norm l
  JOIN user_ids u ON l.user_id = u.user_id
  WHERE DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
    AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date
),
atendidos AS (
  SELECT DISTINCT REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id
  FROM `ungga-full.firestore_messages.messages_light` m
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
),
con_cita AS (
  SELECT DISTINCT REPLACE(a.lead_id, 'leads/', '') AS lead_id
  FROM `ungga-full.mongo_data.appointments_light` a
  WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
),
con_deal AS (
  SELECT DISTINCT REPLACE(d.lead_uid, 'leads/', '') AS lead_id
  FROM `ungga-full.firestore_deals.deals_light` d
  WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
)
SELECT
  COUNT(DISTINCT lp.lead_id)                                              AS creados,
  COUNT(DISTINCT IF(a.lead_id  IS NOT NULL, lp.lead_id, NULL))            AS atendidos,
  COUNT(DISTINCT IF(c.lead_id  IS NOT NULL, lp.lead_id, NULL))            AS con_cita,
  COUNT(DISTINCT IF(dl.lead_id IS NOT NULL, lp.lead_id, NULL))            AS con_deal
FROM leads_periodo lp
LEFT JOIN atendidos a ON lp.lead_id = a.lead_id
LEFT JOIN con_cita  c ON lp.lead_id = c.lead_id
LEFT JOIN con_deal dl ON lp.lead_id = dl.lead_id;
```

### A2. Distribución por portal/origen del lead

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  COALESCE(NULLIF(l.portal, ''), 'sin_portal') AS portal,
  COUNT(DISTINCT l.lead_id)                    AS leads
FROM `ungga-full.mongo_data.leads_light` l
JOIN user_ids u ON REPLACE(l.owner_firebase_id, 'users/', '') = u.user_id
GROUP BY portal
ORDER BY leads DESC
LIMIT @limit;
```
