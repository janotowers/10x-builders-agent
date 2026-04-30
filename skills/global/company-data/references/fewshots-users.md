# Few-shots — Usuarios / Cuentas

## Basic patterns

### B1. Total de clientes Ungga (snapshot, multi-tenant)

> "¿Cuántos clientes hay en mi inmobiliaria?"

```sql
SELECT COUNT(DISTINCT u.document_id) AS clientes
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id;
```

### B2. Clientes con Gu activado y operando

> "¿Cuántos asesores tienen Gu activo y respondiendo?"

```sql
SELECT COUNT(DISTINCT u.document_id) AS asesores_con_gu_operando
FROM `ungga-full.firestore_users.users_light` u
JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  ON REPLACE(g.user_owner, 'users/', '') = u.document_id
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id
  AND g.is_active_gu = TRUE
  AND (g.bypass_bot IS NULL OR g.bypass_bot = FALSE);
```

### B3. Asesores creados en un período

```sql
SELECT
  DATE(u.created_time, 'America/Mexico_City') AS dia,
  COUNT(DISTINCT u.document_id)               AS altas
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id
  AND DATE(u.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(u.created_time, 'America/Mexico_City') <  @end_date
GROUP BY dia
ORDER BY dia;
```

### B4. Listado de asesores con sus contactos (cap 100)

```sql
SELECT
  u.document_id  AS user_id,
  u.display_name,
  u.lastName,
  u.email,
  u.phone_number,
  u.role_user
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id
ORDER BY u.created_time DESC
LIMIT 100;
```

### B5. (Admin Ungga) Top inmobiliarias por total de cuentas

> Solo aplica en MODO ADMIN UNGGA. Filtrar `organization_id` solo si el
> admin pidió una en particular.

```sql
SELECT
  u.organization_id,
  ANY_VALUE(u.org_name)        AS org_name,
  COUNT(DISTINCT u.document_id) AS asesores
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
GROUP BY u.organization_id
ORDER BY asesores DESC
LIMIT @limit;
```

## Advanced analyses

### A1. MAU de Gu (asesores que enviaron al menos 1 mensaje en el mes)

> "¿Cuántos asesores tuvieron Gu efectivamente operando este mes?"

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
gu_phones AS (
  SELECT
    REPLACE(g.user_owner, 'users/', '') AS user_id,
    g.phone_number                       AS gu_phone
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  WHERE g.is_active_gu = TRUE
    AND (g.bypass_bot IS NULL OR g.bypass_bot = FALSE)
),
mensajes_gu AS (
  SELECT DISTINCT m.document_id AS gu_phone
  FROM `ungga-full.firestore_messages.messages_light` m
  WHERE LOWER(TRIM(m.author)) = 'gu'
    AND DATE(m.message_time, 'America/Mexico_City') >= @start_date
    AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
)
SELECT COUNT(DISTINCT gp.user_id) AS mau_gu
FROM gu_phones gp
JOIN user_ids u ON gp.user_id = u.user_id
JOIN mensajes_gu m ON gp.gu_phone = m.gu_phone;
```

### A2. Distribución por rol y país (snapshot)

```sql
SELECT
  COALESCE(NULLIF(u.role_user, ''), 'sin_rol')      AS role_user,
  COALESCE(NULLIF(u.country_user, ''), 'sin_pais')  AS country_user,
  COUNT(DISTINCT u.document_id)                     AS asesores
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id
GROUP BY role_user, country_user
ORDER BY asesores DESC;
```

### A3. Comparativa mes vs. mes anterior (altas de asesores)

```sql
WITH altas AS (
  SELECT
    DATE_TRUNC(DATE(u.created_time, 'America/Mexico_City'), MONTH) AS mes,
    COUNT(DISTINCT u.document_id)                                  AS altas
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
    AND DATE(u.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(u.created_time, 'America/Mexico_City') <  @end_date
  GROUP BY mes
)
SELECT
  mes,
  altas,
  LAG(altas) OVER (ORDER BY mes)                                                                      AS altas_mes_prev,
  SAFE_DIVIDE(altas - LAG(altas) OVER (ORDER BY mes), LAG(altas) OVER (ORDER BY mes))                  AS delta_pct
FROM altas
ORDER BY mes;
```
