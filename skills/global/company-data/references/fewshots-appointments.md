# Few-shots — Citas (Appointments)

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
  COALESCE(NULLIF(TRIM(a.owner_appointment_status), ''),
           NULLIF(TRIM(a.appointment_status), ''),
           'Cita solicitada') AS estado,
  COUNT(DISTINCT a.appointment_id) AS citas
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
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
  COALESCE(NULLIF(TRIM(a.owner_appointment_status), ''),
           NULLIF(TRIM(a.appointment_status), ''),
           'Cita solicitada') AS estado,
  a.property_title
FROM `ungga-full.mongo_data.appointments_light` a
JOIN user_ids u ON REPLACE(a.user_owner, 'users/', '') = u.user_id
WHERE DATE(SAFE.PARSE_DATETIME('%Y-%m-%dT%H:%M:%S', a.date)) = @today
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
WHERE DATE(a.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(a.created_time, 'America/Mexico_City') <  @end_date
GROUP BY u.user_id, asesor
ORDER BY citas DESC
LIMIT @limit;
```
