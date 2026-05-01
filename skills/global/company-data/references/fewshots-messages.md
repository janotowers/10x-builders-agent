# Few-shots — Mensajes / Conversaciones

> **Modo**: estos patrones están escritos para **MODO OBLIGATORIO**
> (con `WHERE u.organization_id = @organization_id`). Para **MODO
> ADMIN UNGGA**: si la pregunta no nombra inmobiliaria, **quita el
> CTE `gu_phones` filtrado y el WHERE de organization_id** para
> agregar cross-tenant. Si nombra una inmobiliaria, **reemplaza el
> filtro** con el helper `org_name → organization_id` de
> `conventions.md`.
>
> **Definiciones canónicas** (ver `glossary.md`):
> - Mensaje del lead (humano) = `LOWER(TRIM(author)) = 'user'`.
> - Mensaje de Gu = `LOWER(TRIM(author)) = 'gu'`.
> - Match mensajes ↔ leads: country-agnostic con `STARTS_WITH/lead_id`
>   (ver `joins.md`).

## Basic patterns

### B1. Total de mensajes en período (de la inmobiliaria)

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

### B3. Mensajes Gu vs lead-humano (definiciones canónicas)

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
  CASE
    WHEN LOWER(TRIM(m.author)) = 'gu'   THEN 'gu_saliente'
    WHEN LOWER(TRIM(m.author)) = 'user' THEN 'humano_entrante'
    ELSE 'otro'
  END AS tipo,
  COUNT(*) AS mensajes
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
GROUP BY tipo
ORDER BY mensajes DESC;
```

### B4. Conversaciones únicas en período (sin necesidad de joinear leads)

> El `lead_path` (lo que viene entre `/leads/` y `/wsp_messeges/`) es ya
> un identificador único de conversación, independiente del formato.

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
SELECT COUNT(DISTINCT
  REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/')
) AS conversaciones
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g ON m.document_id = g.gu_phone
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date;
```

### B5. Últimos N mensajes de una conversación específica (por `lead_id`)

> Si tienes el `lead_id` (ej. del listado de leads), úsalo directo.

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

### B6. Mensajes del lead con un teléfono específico (country-agnostic)

> Cuando el usuario te da el **teléfono del lead** (ej. "5215532214418" o
> "+44 7700 900123"), no asumas longitud. Normaliza, joinea a
> `leads_light.phone_number` para obtener su `lead_id`/path, y usa el
> patrón canónico.

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
  -- Normaliza el teléfono del usuario y de la columna a solo dígitos
  SELECT
    l.lead_id,
    REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '') AS phone_norm
  FROM `ungga-full.mongo_data.leads_light` l
  WHERE REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
        = REGEXP_REPLACE(@lead_phone, r'[^0-9]+', '')
)
SELECT
  m.message_time,
  m.author,
  m.message
FROM `ungga-full.firestore_messages.messages_light` m
JOIN gu_phones g    ON m.document_id = g.gu_phone
JOIN lead_target lt
  ON
    -- Country-agnostic match
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = lt.lead_id
    OR (
      REGEXP_CONTAINS(REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/'), r'^\d+$')
      AND STARTS_WITH(
        REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/'),
        lt.phone_norm
      )
    )
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
ORDER BY m.message_time;
```

## Advanced analyses

### A1. Tasa de respuesta de Gu por lead

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
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT
  lead_path,
  COUNTIF(author_norm = 'gu')   AS msgs_gu,
  COUNTIF(author_norm = 'user') AS msgs_humano,
  SAFE_DIVIDE(COUNTIF(author_norm = 'gu'), COUNTIF(author_norm = 'user')) AS ratio_gu_humano
FROM mensajes_periodo
WHERE lead_path IS NOT NULL
GROUP BY lead_path
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
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path,
    m.message_time,
    LOWER(TRIM(m.author)) AS author_norm
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
  WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT
  lead_path,
  MIN(IF(author_norm = 'gu',   message_time, NULL)) AS first_gu,
  MIN(IF(author_norm = 'user', message_time, NULL)) AS first_humano,
  TIMESTAMP_DIFF(
    MIN(IF(author_norm = 'user', message_time, NULL)),
    MIN(IF(author_norm = 'gu',   message_time, NULL)),
    MINUTE
  ) AS minutos_a_primer_respuesta_humano
FROM msgs
WHERE lead_path IS NOT NULL
GROUP BY lead_path
HAVING minutos_a_primer_respuesta_humano IS NOT NULL
   AND minutos_a_primer_respuesta_humano >= 0
ORDER BY minutos_a_primer_respuesta_humano
LIMIT @limit;
```

### A3. Mensajes con datos del lead (para listados ricos)

> Cuando necesitas devolver `lead.name`, `lead.phone_number`, etc.
> en cada fila — usa el patrón country-agnostic completo.

```sql
WITH msgs AS (
  SELECT
    m.*,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
)
SELECT
  l.lead_id,
  l.name        AS lead_name,
  l.phone_number AS lead_phone,
  m.message_time,
  m.author,
  m.message
FROM msgs m
JOIN `ungga-full.mongo_data.leads_light` l
  ON
    m.lead_path = l.lead_id
    OR (REGEXP_CONTAINS(m.lead_path, r'^\d+$')
        AND STARTS_WITH(m.lead_path,
                        REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')))
JOIN `ungga-full.firestore_users.users_light` u
  ON REPLACE(l.owner_firebase_id, 'users/', '') = u.document_id
WHERE u.organization_id = @organization_id
  AND DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
ORDER BY m.message_time DESC
LIMIT @limit;
```

## Cross-tenant (modo ADMIN UNGGA)

### X1. Mensajes Gu vs humano en período (sin filtro de tenant)

```sql
SELECT
  DATE(m.message_time, 'America/Mexico_City') AS fecha,
  COUNTIF(LOWER(TRIM(m.author)) = 'gu')   AS mensajes_de_gu,
  COUNTIF(LOWER(TRIM(m.author)) = 'user') AS mensajes_de_humano
FROM `ungga-full.firestore_messages.messages_light` m
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
GROUP BY fecha
ORDER BY fecha;
```

### X2. Conversaciones activas por usuario (cross-tenant)

```sql
SELECT
  u.display_name AS usuario,
  COALESCE(u.org_name, '') AS inmobiliaria,
  COUNT(DISTINCT REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/')) AS conversaciones
FROM `ungga-full.firestore_users.users_light` u
JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  ON REPLACE(g.user_owner,'users/','') = u.document_id
JOIN `ungga-full.firestore_messages.messages_light` m
  ON m.document_id = g.phone_number
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
GROUP BY usuario, inmobiliaria
ORDER BY conversaciones DESC
LIMIT @limit;
```

### X3. Últimas N conversaciones de una inmobiliaria por NOMBRE

> Combina con el helper `org_name → organization_id` de `conventions.md`.

```sql
WITH org AS (
  SELECT u.organization_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.role_user = 'super-admin'
    AND REPLACE(REPLACE(LOWER(TRIM(u.org_name)), ' ', ''), 'inmobiliaria', '') LIKE
        CONCAT('%', REPLACE(REPLACE(LOWER(TRIM(@org_needle)), ' ', ''), 'inmobiliaria', ''), '%')
  LIMIT 1
),
user_ids AS (
  SELECT u.document_id
  FROM `ungga-full.firestore_users.users_light` u
  JOIN org o ON u.organization_id = o.organization_id
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
),
gu_phones AS (
  SELECT g.phone_number AS gu_phone
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  JOIN user_ids u ON REPLACE(g.user_owner,'users/','') = u.document_id
),
mensajes AS (
  SELECT
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS conversacion,
    m.document_id AS gu_number,
    m.message_time,
    m.author,
    m.message
  FROM `ungga-full.firestore_messages.messages_light` m
  JOIN gu_phones g ON m.document_id = g.gu_phone
)
SELECT
  conversacion,
  gu_number,
  message_time,
  author,
  message
FROM mensajes
QUALIFY ROW_NUMBER() OVER (PARTITION BY conversacion ORDER BY message_time DESC) = 1
ORDER BY message_time DESC
LIMIT @limit;
```
