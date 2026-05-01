# Few-shots — Citas (Appointments)

> **Modo**: estos patrones están escritos para **MODO OBLIGATORIO**
> (con `WHERE u.organization_id = @organization_id`). Para **MODO
> ADMIN UNGGA**: si la pregunta no nombra inmobiliaria, **quita el
> CTE `user_ids` filtrado y el WHERE de organization_id** para
> agregar cross-tenant. Si nombra una inmobiliaria, **reemplaza el
> filtro** con el helper `org_name → organization_id` de
> `conventions.md`.
>
> **Status normalizado**: usa siempre el normalizer canónico de
> `conventions.md` para mapear NULL/`''`/`'null'`/`'"null"'` →
> `'Cita solicitada'`.

## Basic patterns

### B1. Citas creadas en un período

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT COUNT(DISTINCT a.appointment_id) AS citas_creadas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(a.created_time, 'America/Mexico_City') <  @end_date;
```

### B2. Citas por estatus (con etiqueta "Cita solicitada")

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  COALESCE(
    NULLIF(LOWER(TRIM(TRIM(a.owner_appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.owner_appointment_status, '"')), ''),
    NULLIF(LOWER(TRIM(TRIM(a.appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.appointment_status, '"')), ''),
    'Cita solicitada'
  ) AS estado,
  COUNT(DISTINCT a.appointment_id) AS citas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') >= @start_date
  AND DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') <  @end_date
GROUP BY estado
ORDER BY citas DESC;
```

### B3. Citas para hoy (por su `date` ISO sin TZ → CDMX)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  a.appointment_id,
  a.name,
  a.phone_number,
  a.hour,
  COALESCE(
    NULLIF(LOWER(TRIM(TRIM(a.owner_appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.owner_appointment_status, '"')), ''),
    NULLIF(LOWER(TRIM(TRIM(a.appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.appointment_status, '"')), ''),
    'Cita solicitada'
  ) AS estado,
  a.property_title
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(
        SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', a.date, 'America/Mexico_City'),
        'America/Mexico_City'
      ) = @today
ORDER BY a.hour
LIMIT @limit;
```

### B4. Citas por mes (serie temporal)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  DATE_TRUNC(DATE(a.created_time, 'America/Mexico_City'), MONTH) AS mes,
  COUNT(DISTINCT a.appointment_id) AS citas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
GROUP BY mes
ORDER BY mes;
```

### B5. Citas finalizadas vs. canceladas vs. reagendadas

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  CASE
    WHEN a.finished     = 'true' THEN 'finalizada'
    WHEN a.rescheduled  = 'true' THEN 'reagendada'
    WHEN LOWER(COALESCE(a.appointment_status, '')) LIKE '%cancel%' THEN 'cancelada'
    ELSE 'otra'
  END AS bucket,
  COUNT(DISTINCT a.appointment_id) AS citas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
GROUP BY bucket
ORDER BY citas DESC;
```

## Advanced analyses

### A1. Tasa de "show" (citas que terminaron en visita real)

> Heurística: `property_was_visited = 'true'` (textual). Excluye las
> rescheduled.

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
citas_periodo AS (
  SELECT a.*
  FROM `ungga-full.mongo_data.appointments_light` a
  JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
  WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
    AND (a.rescheduled IS NULL OR a.rescheduled <> 'true')
)
SELECT
  COUNT(DISTINCT appointment_id) AS total,
  COUNT(DISTINCT IF(property_was_visited = 'true', appointment_id, NULL)) AS visitadas,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(property_was_visited = 'true', appointment_id, NULL)),
    COUNT(DISTINCT appointment_id)
  ) AS tasa_show
FROM citas_periodo;
```

### A2. Citas por asesor (ranking)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id, u.display_name, u.lastName
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  u.user_id,
  CONCAT(u.display_name, ' ', COALESCE(u.lastName, '')) AS asesor,
  COUNT(DISTINCT a.appointment_id) AS citas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') >= @start_date
  AND DATE(SAFE_CAST(a.created_time AS TIMESTAMP), 'America/Mexico_City') <  @end_date
GROUP BY u.user_id, asesor
ORDER BY citas DESC
LIMIT @limit;
```

### A3. Citas agendadas por Gu (Gu activo y NO pausado al momento de la cita)

> Atribuye una cita a Gu solo si en la fecha de la cita el asesor tenía
> Gu activo y no pausado. Status normalizado canónicamente.

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
citas AS (
  SELECT
    a.appointment_id,
    REPLACE(a.user_owner, 'users/', '') AS user_id,
    DATE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', a.date, 'America/Mexico_City'),
      'America/Mexico_City'
    ) AS appt_date,
    COALESCE(
      NULLIF(LOWER(TRIM(TRIM(a.owner_appointment_status, '"'))), 'null'),
      NULLIF(TRIM(TRIM(a.owner_appointment_status, '"')), ''),
      NULLIF(LOWER(TRIM(TRIM(a.appointment_status, '"'))), 'null'),
      NULLIF(TRIM(TRIM(a.appointment_status, '"')), ''),
      'Cita solicitada'
    ) AS estado
  FROM `ungga-full.mongo_data.appointments_light` a
  JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
  WHERE DATE(
          SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', a.date, 'America/Mexico_City'),
          'America/Mexico_City'
        ) BETWEEN @start_date AND @end_date
),
citas_gu_estado AS (
  SELECT
    c.appointment_id,
    c.estado,
    g.is_active_gu,
    g.bypass_bot,
    ROW_NUMBER() OVER (
      PARTITION BY c.appointment_id
      ORDER BY DATE(g.asign_date, 'America/Mexico_City') DESC
    ) AS rn
  FROM citas c
  JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
    ON REPLACE(g.user_owner, 'users/', '') = c.user_id
   AND DATE(g.asign_date, 'America/Mexico_City') <= c.appt_date
)
SELECT
  estado,
  COUNT(*) AS citas
FROM citas_gu_estado
WHERE rn = 1
  AND is_active_gu = TRUE
  AND COALESCE(bypass_bot, FALSE) = FALSE
GROUP BY estado
ORDER BY citas DESC;
```

## Cross-tenant (modo ADMIN UNGGA)

### X1. Citas creadas por mes (cross-tenant)

```sql
SELECT
  FORMAT_DATE('%Y-%m', DATE(SAFE_CAST(created_time AS TIMESTAMP), 'America/Mexico_City')) AS mes,
  COUNT(*) AS citas
FROM `ungga-full.mongo_data.appointments_light`
WHERE DATE(SAFE_CAST(created_time AS TIMESTAMP), 'America/Mexico_City')
        BETWEEN @start_date AND @end_date
GROUP BY mes
ORDER BY mes;
```

### X2. Citas de hoy para una inmobiliaria por NOMBRE

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
)
SELECT COUNT(*) AS citas_hoy
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids uid ON REPLACE(a.user_owner,'users/','') = uid.document_id
WHERE DATE(
        SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', a.date, 'America/Mexico_City'),
        'America/Mexico_City'
      ) = CURRENT_DATE('America/Mexico_City');
```
