# Conventions — formato, fechas, filtros canónicos

## Timezone

Todo el negocio reporta en **`America/Mexico_City`**. Para bucketing por
día, semana, mes:

```sql
DATE(<ts>, 'America/Mexico_City')                            -- día
DATE_TRUNC(DATE(<ts>, 'America/Mexico_City'), WEEK(MONDAY))  -- semana ISO
DATE_TRUNC(DATE(<ts>, 'America/Mexico_City'), MONTH)         -- mes
```

Cuando el usuario diga "hoy", "ayer", "esta semana", "este mes",
**parametriza** con `@start_date` / `@end_date` y resuélvelas en CDMX:

```sql
-- Hoy CDMX
SET start_date = CURRENT_DATE('America/Mexico_City');
-- Esta semana (lunes 00:00 CDMX → siguiente lunes 00:00 CDMX)
SET start_date = DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY));
SET end_date   = DATE_ADD(start_date, INTERVAL 7 DAY);
```

> Como `bigquery_run_query` rechaza scripting (`SET`/`DECLARE`/`BEGIN`),
> calcula los bounds en TypeScript y pásalos como parámetros literales:
>
> ```js
> { start_date: '2026-04-29', end_date: '2026-04-30' }
> ```

## `created_at` mixto en `leads_light` (Mongo)

`mongo_data.leads_light.created_at` puede aparecer como TIMESTAMP, número
de epoch (segundos), o string ISO según el batch. Patrón seguro:

```sql
COALESCE(
  SAFE_CAST(l.created_at AS TIMESTAMP),
  SAFE.TIMESTAMP(CAST(l.created_at AS STRING)),
  SAFE.PARSE_TIMESTAMP(
    '%Y-%m-%d %H:%M:%E*S',
    CAST(l.created_at AS STRING),
    'America/Mexico_City'
  ),
  SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', CAST(l.created_at AS STRING)),
  TIMESTAMP_SECONDS(SAFE_CAST(CAST(l.created_at AS STRING) AS INT64))
) AS created_at_norm
```

Aplica esto en un CTE y usa `created_at_norm` en `WHERE`/`GROUP BY`.

## `appointments_light.created_time` mixto

`appointments_light.created_time` también puede llegar como string en
algunos lotes. Para período-comparisons usa `SAFE_CAST` y luego
`DATE(...)`:

```sql
DATE(
  SAFE_CAST(a.created_time AS TIMESTAMP),
  'America/Mexico_City'
)
```

## `appointments_light.date` (string ISO sin TZ)

`a.date` viene como `'2025-11-27T00:00:00'` y representa hora local CDMX.
Para comparar contra rangos hay dos formas equivalentes:

```sql
-- Forma A: PARSE_TIMESTAMP con TZ explícita (preferida — devuelve TIMESTAMP)
SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', a.date, 'America/Mexico_City') AS date_ts

-- Forma B: PARSE_DATETIME (sin TZ — devuelve DATETIME, asume local)
SAFE.PARSE_DATETIME('%Y-%m-%dT%H:%M:%E*S', a.date) AS date_local
```

Después:

```sql
WHERE DATE(date_ts, 'America/Mexico_City') = @today
-- o, con DATETIME:
WHERE DATE(date_local) = @today
```

Forma A es más segura cuando combinas con otros TIMESTAMPS.

## Filtros canónicos (recordar siempre)

- **Excluir cuentas test:** `WHERE (u.is_test IS NULL OR u.is_test = FALSE)`
- **Solo Gu activado real:** `WHERE g.is_active_gu = TRUE` (no usar
  `pending_payment` como filtro — no es señal de "no cliente").
- **Estado de cita "solicitada"** — normalizer canónico que cubre NULL,
  string vacío, y los artefactos `'null'` / `'"null"'` que aparecen en
  los datos migrados:

  ```sql
  WITH a_norm AS (
    SELECT
      a.*,
      TRIM(TRIM(COALESCE(a.owner_appointment_status, '')), '"') AS owner_clean,
      TRIM(TRIM(COALESCE(a.appointment_status, '')), '"')       AS gen_clean
    FROM `ungga-full.mongo_data.appointments_light` a
  )
  SELECT
    CASE
      WHEN owner_clean IS NULL OR owner_clean = '' OR LOWER(owner_clean) = 'null'
        THEN
          CASE
            WHEN gen_clean IS NULL OR gen_clean = '' OR LOWER(gen_clean) = 'null'
              THEN 'Cita solicitada'
            ELSE gen_clean
          END
      ELSE owner_clean
    END AS estado
  FROM a_norm;
  ```

  Versión compacta cuando solo necesitas un campo (sin CTE):

  ```sql
  COALESCE(
    NULLIF(LOWER(TRIM(TRIM(a.owner_appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.owner_appointment_status, '"')), ''),
    NULLIF(LOWER(TRIM(TRIM(a.appointment_status, '"'))), 'null'),
    NULLIF(TRIM(TRIM(a.appointment_status, '"')), ''),
    'Cita solicitada'
  ) AS estado
  ```

## Helper canónico — `org_name → organization_id` (ADMIN UNGGA)

Cuando estás en MODO ADMIN UNGGA y el usuario pide datos de "Inmobiliaria
Garios" / "Garios" / "Inmobiliaria Ruz" / etc., resuelve el nombre a
`organization_id` con este helper. Es tolerante a:

- Mayúsculas / minúsculas
- Espacios
- Prefijo o sufijo "Inmobiliaria"

```sql
WITH org AS (
  SELECT
    u.organization_id,
    u.org_name
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.role_user = 'super-admin'
    AND REPLACE(
          REPLACE(LOWER(TRIM(u.org_name)), ' ', ''),
          'inmobiliaria',
          ''
        ) LIKE CONCAT(
          '%',
          REPLACE(
            REPLACE(LOWER(TRIM(@org_needle)), ' ', ''),
            'inmobiliaria',
            ''
          ),
          '%'
        )
  LIMIT 1   -- o quita el LIMIT y enumera al usuario para confirmar
)
```

Después usa `(SELECT organization_id FROM org)` o un JOIN a `org` para
filtrar el resto del query. Si la búsqueda devuelve más de una
inmobiliaria, **enumera al usuario y pide confirmación** antes de correr
la métrica.

## Performance

- Para listas grandes, ordena y limita: `ORDER BY <ts> DESC LIMIT @limit`.
- Filtra **antes** del JOIN cuando puedas (CTE con `user_ids` de la
  inmobiliaria → JOINs salen acotados).
- Particiones: las tablas `_light` no garantizan partición — confía en
  que BigQuery use estadísticas y no escanées columnas que no necesitas.
- Evita `SELECT *` salvo en consultas exploratorias para una sola fila.
- Con joins 1→N, **siempre** `COUNT(DISTINCT pk)` para cardinalidad.

## Por mes / serie temporal — `GENERATE_DATE_ARRAY`

Cuando el usuario pide una serie mensual con cutoffs al cierre de cada mes:

```sql
WITH months AS (
  SELECT
    month_start,
    DATE_SUB(DATE_ADD(month_start, INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end
  FROM UNNEST(GENERATE_DATE_ARRAY(@start, @end, INTERVAL 1 MONTH)) AS month_start
)
SELECT FORMAT_DATE('%Y-%m', month_start) AS mes, …
```

Combinado con `ARRAY_AGG(STRUCT(...) ORDER BY asign_date DESC LIMIT 1)[OFFSET(0)]`
es el patrón canónico para snapshots de Gu por mes — ver
`fewshots-users.md` Advanced.
