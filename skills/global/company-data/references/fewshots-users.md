# Few-shots — Usuarios / Cuentas

> **Modo**: estos patrones están escritos para **MODO OBLIGATORIO**
> (con `WHERE u.organization_id = @organization_id`). Para **MODO
> ADMIN UNGGA**: si la pregunta no nombra inmobiliaria, **quita el
> CTE `user_ids` filtrado y el WHERE de organization_id** para
> agregar cross-tenant. Si nombra una inmobiliaria, **reemplaza el
> filtro** con el helper `org_name → organization_id` de
> `conventions.md`.

## Basic patterns

### B1. Total de clientes Ungga (snapshot, multi-tenant)

> "¿Cuántos clientes hay en mi inmobiliaria?"

```sql
SELECT COUNT(DISTINCT u.document_id) AS clientes
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id;
```

### B2. Clientes con Gu activo (operando, no pausado) — snapshot HOY

> "¿Cuántos asesores tienen Gu activo y respondiendo?"

```sql
WITH snapshot AS (SELECT CURRENT_DATE('America/Mexico_City') AS today),
users AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
gu_last AS (
  SELECT
    REPLACE(g.user_owner,'users/','') AS user_id,
    ARRAY_AGG(STRUCT(
      g.asign_date  AS asign_date,
      g.is_active_gu AS is_active_gu,
      g.bypass_bot  AS bypass_bot
    ) ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)] AS last_gu
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  CROSS JOIN snapshot s
  WHERE DATE(g.asign_date, 'America/Mexico_City') <= s.today
  GROUP BY user_id
)
SELECT COUNT(DISTINCT u.user_id) AS asesores_con_gu_activo_hoy
FROM users u
JOIN gu_last gl ON u.user_id = gl.user_id
WHERE gl.last_gu.is_active_gu = TRUE
  AND COALESCE(gl.last_gu.bypass_bot, FALSE) = FALSE;
```

### B3. Asesores creados en un período (serie diaria)

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

### B5. Listado de usuarios con flags inventario / Gu activo / Gu pausado + categoría

> El `LEFT JOIN` con `MAX(IF(...))` produce booleans agregados en una sola fila por usuario.

```sql
WITH usuarios AS (
  SELECT
    u.document_id AS user_id,
    u.display_name,
    u.org_name,
    COALESCE(MAX(IF(p.document_id IS NOT NULL, TRUE, FALSE)), FALSE)                                                AS tiene_inventario,
    COALESCE(MAX(IF(g.is_active_gu = TRUE AND COALESCE(g.bypass_bot, FALSE) = FALSE, TRUE, FALSE)), FALSE)           AS tiene_gu_activo,
    COALESCE(MAX(IF(g.is_active_gu = TRUE AND COALESCE(g.bypass_bot, FALSE) = TRUE,  TRUE, FALSE)), FALSE)           AS tiene_gu_pausado
  FROM `ungga-full.firestore_users.users_light` u
  LEFT JOIN `ungga-full.firestore_properties.properties_light` p
    ON REPLACE(p.user_owner,'users/','') = u.document_id
  LEFT JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
    ON REPLACE(g.user_owner,'users/','') = u.document_id
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
  GROUP BY u.document_id, u.display_name, u.org_name
)
SELECT
  user_id, display_name, org_name,
  tiene_inventario, tiene_gu_activo, tiene_gu_pausado,
  CASE
    WHEN NOT tiene_inventario                       THEN 'solo_cuenta'
    WHEN tiene_inventario AND NOT tiene_gu_activo
                          AND NOT tiene_gu_pausado  THEN 'inventario_sin_gu'
    WHEN tiene_inventario AND tiene_gu_activo       THEN 'inventario_gu_activo'
    WHEN tiene_inventario AND tiene_gu_pausado      THEN 'inventario_gu_pausado'
  END AS categoria_usuario
FROM usuarios
ORDER BY org_name, display_name;
```

## Advanced analyses

### A1. MAU canónica (Gu hab al cierre del mes + ≥1 lead nuevo)

> Definición canónica de "usuarios usando Gu este mes" (ver `glossary.md`).
> Reemplaza la antigua aproximación basada en mensajes-Gu.

```sql
WITH bounds AS (
  SELECT
    DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), MONTH)                       AS start_month,
    DATE_ADD(DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), MONTH), INTERVAL 1 MONTH) AS next_month,
    DATE_SUB(DATE_ADD(DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), MONTH), INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end
),
users AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
gu_last AS (
  SELECT
    REPLACE(g.user_owner,'users/','') AS user_id,
    ARRAY_AGG(STRUCT(
      g.asign_date    AS asign_date,
      g.is_active_gu  AS is_active_gu,
      g.bypass_bot    AS bypass_bot
    ) ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)] AS last_gu
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  CROSS JOIN bounds b
  WHERE DATE(g.asign_date, 'America/Mexico_City') <= b.month_end
  GROUP BY user_id
),
leads_in_month AS (
  SELECT DISTINCT REPLACE(owner_firebase_id,'users/','') AS user_id
  FROM (
    SELECT
      owner_firebase_id,
      COALESCE(
        SAFE_CAST(created_at AS TIMESTAMP),
        SAFE.TIMESTAMP(CAST(created_at AS STRING)),
        SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', CAST(created_at AS STRING), 'America/Mexico_City'),
        TIMESTAMP_SECONDS(SAFE_CAST(CAST(created_at AS STRING) AS INT64))
      ) AS created_at_norm
    FROM `ungga-full.mongo_data.leads_light`
  ) l
  CROSS JOIN bounds b
  WHERE created_at_norm IS NOT NULL
    AND DATE(created_at_norm, 'America/Mexico_City') >= b.start_month
    AND DATE(created_at_norm, 'America/Mexico_City') <  b.next_month
)
SELECT COUNT(DISTINCT u.user_id) AS mau_gu
FROM users u
JOIN gu_last gl     ON u.user_id = gl.user_id
JOIN leads_in_month lm ON u.user_id = lm.user_id
WHERE gl.last_gu.is_active_gu = TRUE
  AND COALESCE(gl.last_gu.bypass_bot, FALSE) = FALSE;
```

### A2. 4-bucket categorización por mes (serie temporal)

```sql
WITH months AS (
  SELECT
    month_start,
    DATE_SUB(DATE_ADD(month_start, INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end
  FROM UNNEST(GENERATE_DATE_ARRAY(@start_date, @end_date, INTERVAL 1 MONTH)) AS month_start
),
users AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
flags AS (
  SELECT
    m.month_start,
    m.month_end,
    u.user_id,
    EXISTS (
      SELECT 1
      FROM `ungga-full.firestore_properties.properties_light` p
      WHERE REPLACE(p.user_owner,'users/','') = u.user_id
        AND DATE(p.created_time, 'America/Mexico_City') <= m.month_end
      LIMIT 1
    ) AS has_inventory,
    (
      SELECT ARRAY_AGG(STRUCT(
               g.asign_date AS asign_date,
               g.is_active_gu AS is_active_gu,
               g.bypass_bot AS bypass_bot
             ) ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)]
      FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
      WHERE REPLACE(g.user_owner,'users/','') = u.user_id
        AND DATE(g.asign_date, 'America/Mexico_City') <= m.month_end
    ) AS last_gu
  FROM months m
  CROSS JOIN users u
)
SELECT
  FORMAT_DATE('%Y-%m', month_start) AS mes,
  COUNTIF(NOT has_inventory) AS solo_cuenta,
  COUNTIF(has_inventory AND (last_gu IS NULL OR last_gu.is_active_gu = FALSE OR last_gu.is_active_gu IS NULL)) AS inventario_sin_gu,
  COUNTIF(has_inventory AND last_gu.is_active_gu = TRUE AND COALESCE(last_gu.bypass_bot, FALSE) = FALSE) AS inventario_gu_activo,
  COUNTIF(has_inventory AND last_gu.is_active_gu = TRUE AND COALESCE(last_gu.bypass_bot, FALSE) = TRUE)  AS inventario_gu_pausado
FROM flags
GROUP BY mes
ORDER BY mes;
```

### A3. Snapshot mensual de estado de Gu (activo / pausado / inactivo)

```sql
WITH months AS (
  SELECT
    month_start,
    DATE_SUB(DATE_ADD(month_start, INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end
  FROM UNNEST(GENERATE_DATE_ARRAY(@start_date, @end_date, INTERVAL 1 MONTH)) AS month_start
),
gu_last_per_month AS (
  SELECT
    m.month_start,
    REPLACE(g.user_owner,'users/','') AS user_id,
    ARRAY_AGG(STRUCT(
      g.asign_date AS asign_date,
      g.is_active_gu AS is_active_gu,
      g.bypass_bot  AS bypass_bot
    ) ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)] AS s
  FROM months m
  JOIN `ungga-full.firestore_gu_numbers.gu_numbers_light` g
    ON DATE(g.asign_date, 'America/Mexico_City') <= m.month_end
  JOIN `ungga-full.firestore_users.users_light` u
    ON REPLACE(g.user_owner,'users/','') = u.document_id
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
  GROUP BY 1, 2
)
SELECT
  FORMAT_DATE('%Y-%m', month_start) AS mes,
  COUNTIF(s.is_active_gu = TRUE AND COALESCE(s.bypass_bot, FALSE) = FALSE) AS gu_activo,
  COUNTIF(s.is_active_gu = TRUE AND COALESCE(s.bypass_bot, FALSE) = TRUE)  AS gu_pausado,
  COUNTIF(s.is_active_gu = FALSE OR s.is_active_gu IS NULL)               AS gu_inactivo
FROM gu_last_per_month
GROUP BY mes
ORDER BY mes;
```

### A4. Distribución por rol y país (snapshot)

```sql
SELECT
  COALESCE(NULLIF(u.role_user, ''),    'sin_rol')  AS role_user,
  COALESCE(NULLIF(u.country_user, ''), 'sin_pais') AS country_user,
  COUNT(DISTINCT u.document_id)                    AS asesores
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
  AND u.organization_id = @organization_id
GROUP BY role_user, country_user
ORDER BY asesores DESC;
```

## Cross-tenant (modo ADMIN UNGGA)

> Estos patrones **no** llevan filtro por `organization_id`. Aplícalos
> solo cuando el `[Contexto de tenant]` indique MODO ADMIN UNGGA.

### X1. Top inmobiliarias por número de cuentas

```sql
SELECT
  u.organization_id,
  ANY_VALUE(u.org_name)         AS org_name,
  COUNT(DISTINCT u.document_id) AS asesores
FROM `ungga-full.firestore_users.users_light` u
WHERE (u.is_test IS NULL OR u.is_test = FALSE)
GROUP BY u.organization_id
ORDER BY asesores DESC
LIMIT @limit;
```

### X2. Total de usuarios con buckets (snapshot HOY, cross-tenant)

```sql
WITH snapshot AS (SELECT CURRENT_DATE('America/Mexico_City') AS today),
users AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
),
inventory_flags AS (
  SELECT REPLACE(p.user_owner,'users/','') AS user_id, TRUE AS has_inventory
  FROM `ungga-full.firestore_properties.properties_light` p
  CROSS JOIN snapshot s
  WHERE DATE(p.created_time, 'America/Mexico_City') <= s.today
  GROUP BY user_id
),
gu_last AS (
  SELECT
    REPLACE(g.user_owner,'users/','') AS user_id,
    ARRAY_AGG(STRUCT(
      g.asign_date AS asign_date, g.is_active_gu AS is_active_gu, g.bypass_bot AS bypass_bot
    ) ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)] AS last_gu
  FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
  CROSS JOIN snapshot s
  WHERE DATE(g.asign_date, 'America/Mexico_City') <= s.today
  GROUP BY user_id
)
SELECT
  COUNTIF(NOT COALESCE(i.has_inventory, FALSE)) AS solo_cuenta,
  COUNTIF(COALESCE(i.has_inventory, FALSE) AND (gl.last_gu IS NULL OR gl.last_gu.is_active_gu = FALSE)) AS inventario_sin_gu,
  COUNTIF(COALESCE(i.has_inventory, FALSE) AND gl.last_gu.is_active_gu = TRUE AND COALESCE(gl.last_gu.bypass_bot, FALSE) = FALSE) AS inventario_gu_activo,
  COUNTIF(COALESCE(i.has_inventory, FALSE) AND gl.last_gu.is_active_gu = TRUE AND COALESCE(gl.last_gu.bypass_bot, FALSE) = TRUE)  AS inventario_gu_pausado,
  COUNT(*) AS total_usuarios
FROM users u
LEFT JOIN inventory_flags i ON u.user_id = i.user_id
LEFT JOIN gu_last gl       ON u.user_id = gl.user_id;
```

### X3. Usuarios MarketMeet (sub-producto via `gga` flag)

```sql
WITH users_mm AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND COALESCE(u.gga, FALSE) = TRUE
),
flags AS (
  SELECT
    u.user_id,
    EXISTS (SELECT 1 FROM `ungga-full.firestore_properties.properties_light` p
            WHERE REPLACE(p.user_owner,'users/','') = u.user_id LIMIT 1) AS has_inventory,
    (SELECT ARRAY_AGG(STRUCT(g.asign_date, g.is_active_gu, g.bypass_bot)
              ORDER BY g.asign_date DESC LIMIT 1)[OFFSET(0)]
     FROM `ungga-full.firestore_gu_numbers.gu_numbers_light` g
     WHERE REPLACE(g.user_owner,'users/','') = u.user_id) AS last_gu
  FROM users_mm u
)
SELECT
  COUNT(*) AS usuarios_marketmeet,
  COUNTIF(has_inventory) AS mm_con_inventario,
  COUNTIF(last_gu.is_active_gu = TRUE AND COALESCE(last_gu.bypass_bot, FALSE) = FALSE) AS mm_con_gu,
  COUNTIF(last_gu.is_active_gu = TRUE AND COALESCE(last_gu.bypass_bot, FALSE) = TRUE)  AS mm_gu_pausado
FROM flags;
```
