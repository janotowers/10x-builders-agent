# Few-shots — Leads

> **Modo**: estos patrones están escritos para **MODO OBLIGATORIO**
> (con `WHERE u.organization_id = @organization_id`). Para **MODO
> ADMIN UNGGA**: si la pregunta no nombra inmobiliaria, **quita el
> CTE `user_ids` filtrado y el WHERE de organization_id** para
> agregar cross-tenant. Si nombra una inmobiliaria, **reemplaza el
> filtro** con el helper `org_name → organization_id` de
> `conventions.md`.
>
> **Definiciones canónicas** (ver `glossary.md`):
> - **atendido** = `≥ 1 mensaje con author='user'` en el período.
> - **interactuó** = `> 1 mensaje con author='user'` en el período.
> - El match canónico mensajes ↔ leads es **country-agnostic** (ver
>   `joins.md`); usa `STARTS_WITH(lead_path, normalized_phone)` o
>   `lead_path = lead_id`.

## Basic patterns

### B1. Leads creados en un período

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
    COALESCE(
      SAFE_CAST(l.created_at AS TIMESTAMP),
      SAFE.TIMESTAMP(CAST(l.created_at AS STRING)),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', CAST(l.created_at AS STRING), 'America/Mexico_City'),
      TIMESTAMP_SECONDS(SAFE_CAST(CAST(l.created_at AS STRING) AS INT64))
    ) AS created_at_norm
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
    COALESCE(
      SAFE_CAST(l.created_at AS TIMESTAMP),
      SAFE.TIMESTAMP(CAST(l.created_at AS STRING)),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', CAST(l.created_at AS STRING), 'America/Mexico_City'),
      TIMESTAMP_SECONDS(SAFE_CAST(CAST(l.created_at AS STRING) AS INT64))
    ) AS created_at_norm
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

### B3. Leads atendidos en el período (≥1 mensaje del lead, definición canónica)

> **Atendido** = ≥ 1 mensaje con `author = 'user'`. Captura cualquier
> conversación donde el humano respondió al menos una vez (incluyendo
> el mensaje inicial pre-establecido para arrancar el chat).

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
gu_phones AS (
  SELECT g.phone_number AS gu_phone, REPLACE(g.user_owner,'users/','') AS user_id
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  JOIN user_ids u ON REPLACE(g.user_owner,'users/','') = u.user_id
),
mensajes_periodo AS (
  -- Solo mensajes que pasen por un Gu de la inmobiliaria;
  -- contamos por lead_path (id de la conversación) → country-agnostic.
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT
  COUNT(DISTINCT IF(lead_path IS NOT NULL, lead_path, NULL)) AS leads_atendidos
FROM (
  SELECT lead_path
  FROM mensajes_periodo
  WHERE lead_path IS NOT NULL AND lead_path != ''
  GROUP BY lead_path
  HAVING COUNTIF(author_norm = 'user') >= 1
);
```

### B4. Leads que interactuaron (>1 mensaje del lead, definición canónica)

```sql
-- Misma estructura que B3 cambiando el HAVING:
HAVING COUNTIF(author_norm = 'user') > 1
```

(Sustituye solo esa línea en el query de B3.)

### B5. Listado de leads (cap N)

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

### B6. Listado de leads atendidos en período (con datos del lead)

> Aquí sí necesitas joinear a `leads_light` para devolver nombre,
> teléfono, portal, etc. Usa el patrón canónico country-agnostic.

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
  JOIN user_ids u ON REPLACE(g.user_owner,'users/','') = u.user_id
),
msgs AS (
  SELECT
    m.*,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
),
attended AS (
  SELECT lead_path, MAX(message_time) AS last_msg_in_period, COUNT(*) AS msgs_in_period
  FROM msgs
  WHERE lead_path IS NOT NULL
  GROUP BY lead_path
  HAVING COUNTIF(LOWER(TRIM(author)) = 'user') >= 1
)
SELECT
  l.lead_id,
  l.name,
  l.phone_number,
  l.portal,
  l.created_at,
  a.msgs_in_period,
  a.last_msg_in_period
FROM attended a
JOIN `ungga-full.mongo_data.leads_light` l
  ON
    -- Country-agnostic match (ver joins.md)
    a.lead_path = l.lead_id
    OR (REGEXP_CONTAINS(a.lead_path, r'^\d+$')
        AND STARTS_WITH(a.lead_path,
                        REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')))
ORDER BY a.last_msg_in_period DESC
LIMIT @limit;
```

## Advanced analyses

### A1. Funnel canónico: creados → atendidos → interactuaron → con cita → con deal

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
  JOIN user_ids u ON REPLACE(g.user_owner,'users/','') = u.user_id
),
leads_norm AS (
  SELECT
    l.lead_id,
    REPLACE(l.owner_firebase_id, 'users/', '') AS user_id,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm,
    COALESCE(
      SAFE_CAST(l.created_at AS TIMESTAMP),
      SAFE.TIMESTAMP(CAST(l.created_at AS STRING)),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', CAST(l.created_at AS STRING), 'America/Mexico_City'),
      TIMESTAMP_SECONDS(SAFE_CAST(CAST(l.created_at AS STRING) AS INT64))
    ) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
),
leads_periodo AS (
  SELECT l.lead_id, l.user_id, l.phone_norm
  FROM leads_norm l
  JOIN user_ids u ON l.user_id = u.user_id
  WHERE DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
    AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date
),
msgs AS (
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
),
conv_stats AS (
  SELECT
    lead_path,
    COUNTIF(author_norm = 'user') AS user_msgs
  FROM msgs
  WHERE lead_path IS NOT NULL
  GROUP BY lead_path
),
attended AS (
  SELECT lp.lead_id
  FROM leads_periodo lp
  JOIN conv_stats cs
    ON cs.lead_path = lp.lead_id
    OR (REGEXP_CONTAINS(cs.lead_path, r'^\d+$') AND STARTS_WITH(cs.lead_path, lp.phone_norm))
  WHERE cs.user_msgs >= 1
),
interacted AS (
  SELECT lp.lead_id
  FROM leads_periodo lp
  JOIN conv_stats cs
    ON cs.lead_path = lp.lead_id
    OR (REGEXP_CONTAINS(cs.lead_path, r'^\d+$') AND STARTS_WITH(cs.lead_path, lp.phone_norm))
  WHERE cs.user_msgs > 1
),
con_cita AS (
  SELECT DISTINCT REPLACE(a.lead_id, 'leads/', '') AS lead_id
  FROM `ungga-full.mongo_data.appointments_light` a
  WHERE DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') >= @start_date
    AND DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') <  @end_date
),
con_deal AS (
  SELECT DISTINCT REPLACE(d.lead_uid, 'leads/', '') AS lead_id
  FROM `ungga-full.firestore_deals.deals_light` d
  WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
)
SELECT
  COUNT(DISTINCT lp.lead_id)                                          AS creados,
  COUNT(DISTINCT IF(at.lead_id IS NOT NULL, lp.lead_id, NULL))         AS atendidos,
  COUNT(DISTINCT IF(it.lead_id IS NOT NULL, lp.lead_id, NULL))         AS interactuaron,
  COUNT(DISTINCT IF(c.lead_id  IS NOT NULL, lp.lead_id, NULL))         AS con_cita,
  COUNT(DISTINCT IF(dl.lead_id IS NOT NULL, lp.lead_id, NULL))         AS con_deal
FROM leads_periodo lp
LEFT JOIN attended    at ON lp.lead_id = at.lead_id
LEFT JOIN interacted  it ON lp.lead_id = it.lead_id
LEFT JOIN con_cita    c  ON lp.lead_id = c.lead_id
LEFT JOIN con_deal    dl ON lp.lead_id = dl.lead_id;
```

### A2. Atendidos / interactuaron / atendidos-sin-interactuar / nuevos / viejos en período

> Investigación combinada: la imagen completa de un mes para un tenant.
> Útil cuando el usuario pide *"de Garios en enero, dame todo"*.

```sql
-- Reusa los CTE leads_norm, gu_phones, msgs, conv_stats de A1.
-- Añade clasificación nuevo/viejo:
WITH leads_t AS (
  SELECT
    l.lead_id,
    l.phone_norm,
    DATE(l.created_at_norm, 'America/Mexico_City') AS created_date_mx,
    -- NUEVO en período
    (l.created_at_norm IS NOT NULL
     AND DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
     AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date) AS is_new,
    -- VIEJO o sin fecha
    (l.created_at_norm IS NULL
     OR DATE(l.created_at_norm, 'America/Mexico_City') < @start_date)  AS is_old
  FROM leads_norm l
  JOIN user_ids u ON l.user_id = u.user_id
)
SELECT
  COUNT(DISTINCT IF(cs.user_msgs >= 1,                lt.lead_id, NULL)) AS atendidos,
  COUNT(DISTINCT IF(cs.user_msgs >  1,                lt.lead_id, NULL)) AS interactuaron,
  COUNT(DISTINCT IF(cs.user_msgs  = 1,                lt.lead_id, NULL)) AS atendidos_sin_interactuar,
  COUNT(DISTINCT IF(cs.user_msgs >= 1 AND lt.is_new,  lt.lead_id, NULL)) AS atendidos_nuevos,
  COUNT(DISTINCT IF(cs.user_msgs >= 1 AND lt.is_old,  lt.lead_id, NULL)) AS atendidos_viejos
FROM leads_t lt
LEFT JOIN conv_stats cs
  ON cs.lead_path = lt.lead_id
  OR (REGEXP_CONTAINS(cs.lead_path, r'^\d+$') AND STARTS_WITH(cs.lead_path, lt.phone_norm));
```

### A3. Distribución por portal/origen del lead

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

### A4. Solicitudes de visita en período

> "Solicitudes de visita" = nuevas filas en `appointments_light` con
> `appointment_id` no nulo, filtradas por `created_time` parseado.

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  COUNT(DISTINCT a.appointment_id) AS visit_requests
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') >= @start_date
  AND DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') <  @end_date
  AND a.appointment_id IS NOT NULL;
```

### A5. De los leads que interactuaron en período, cuántos solicitaron visita

```sql
-- Combina A2 (interactuaron) con A4 (solicitudes) intersectando lead_id.
-- Nota: appointments_light.lead_id viene con prefijo 'leads/' →
-- normalizar antes de comparar contra leads_periodo.lead_id.
WITH appts_periodo AS (
  SELECT DISTINCT REPLACE(a.lead_id, 'leads/', '') AS lead_id
  FROM `ungga-full.mongo_data.appointments_light` a
  JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
  WHERE DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') >= @start_date
    AND DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') <  @end_date
    AND a.appointment_id IS NOT NULL
    AND a.lead_id IS NOT NULL
)
SELECT
  COUNT(DISTINCT lt.lead_id) AS interactuaron_y_solicitaron_visita
FROM leads_t lt   -- de A2: leads del tenant
JOIN conv_stats cs
  ON cs.lead_path = lt.lead_id
  OR (REGEXP_CONTAINS(cs.lead_path, r'^\d+$') AND STARTS_WITH(cs.lead_path, lt.phone_norm))
JOIN appts_periodo ap ON ap.lead_id = lt.lead_id
WHERE cs.user_msgs > 1;
```

## Cross-tenant (modo ADMIN UNGGA)

### X1. Top 10 usuarios con más leads que interactuaron en últimos 30 días

> Patrón cross-tenant: el ranking lista todas las inmobiliarias.
> Usa el patrón canónico `STARTS_WITH/lead_id` para empatar mensajes
> con leads.

```sql
WITH bounds AS (
  SELECT DATE_SUB(CURRENT_DATE('America/Mexico_City'), INTERVAL 30 DAY) AS start_date,
         CURRENT_DATE('America/Mexico_City') AS end_date
),
msgs AS (
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  CROSS JOIN bounds b
  WHERE DATE(m.message_time, 'America/Mexico_City') >= b.start_date
    AND DATE(m.message_time, 'America/Mexico_City') <= b.end_date
),
interacted_paths AS (
  SELECT lead_path
  FROM msgs
  WHERE lead_path IS NOT NULL
  GROUP BY lead_path
  HAVING COUNTIF(author_norm = 'user') > 1
),
leads_aug AS (
  SELECT
    l.lead_id,
    REPLACE(l.owner_firebase_id, 'users/', '') AS user_id,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm
  FROM `ungga-full.mongo_data.leads_light` l
),
users AS (
  SELECT u.document_id AS user_id, COALESCE(u.org_name, u.display_name) AS usuario
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
)
SELECT
  u.usuario,
  COUNT(DISTINCT la.lead_id) AS leads_que_interactuaron_30d
FROM interacted_paths ip
JOIN leads_aug la
  ON la.lead_id = ip.lead_path
  OR (REGEXP_CONTAINS(ip.lead_path, r'^\d+$') AND STARTS_WITH(ip.lead_path, la.phone_norm))
JOIN users u ON u.user_id = la.user_id
GROUP BY u.usuario
ORDER BY leads_que_interactuaron_30d DESC
LIMIT 10;
```
