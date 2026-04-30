# Conventions — formato, fechas, filtros canónicos

## Timezone

Todo el negocio reporta en **`America/Mexico_City`**. Para bucketing por
día, semana, mes:

```sql
DATE(<ts>, 'America/Mexico_City')                          -- día
DATE_TRUNC(DATE(<ts>, 'America/Mexico_City'), WEEK(MONDAY)) -- semana ISO
DATE_TRUNC(DATE(<ts>, 'America/Mexico_City'), MONTH)        -- mes
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
  SAFE.TIMESTAMP(l.created_at),
  SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at),
  TIMESTAMP_SECONDS(SAFE_CAST(l.created_at AS INT64))
) AS created_at_norm
```

Aplica esto en un CTE y usa `created_at_norm` en `WHERE`/`GROUP BY`.

## `appointments_light.date` (string ISO sin TZ)

`a.date` viene como `'2025-11-27T00:00:00'` y representa hora local CDMX.
Para comparar contra rangos:

```sql
SAFE.PARSE_DATETIME('%Y-%m-%dT%H:%M:%S', a.date) AS date_local
-- después
WHERE date_local >= @start_dt AND date_local < @end_dt
```

## Filtros canónicos (recordar siempre)

- **Excluir cuentas test:** `WHERE (u.is_test IS NULL OR u.is_test = FALSE)`
- **Solo Gu activado real:** `WHERE g.is_active_gu = TRUE` (no usar
  `pending_payment` como filtro — no es señal de "no cliente").
- **Estado de cita "solicitada":** cuando `appointment_status` y
  `owner_appointment_status` están vacíos / NULL, etiquetar como
  `'Cita solicitada'`. Patrón:
  ```sql
  COALESCE(NULLIF(TRIM(a.owner_appointment_status), ''),
           NULLIF(TRIM(a.appointment_status), ''),
           'Cita solicitada') AS estado
  ```

## Performance

- Para listas grandes, ordena y limita: `ORDER BY <ts> DESC LIMIT @limit`.
- Filtra **antes** del JOIN cuando puedas (CTE con `user_ids` de la
  inmobiliaria → JOINs salen acotados).
- Particiones: las tablas `_light` no garantizan partición — confía en
  que BigQuery use estadísticas y no escanées columnas que no necesitas.
- Evita `SELECT *` salvo en consultas exploratorias para una sola fila.
- Con joins 1→N, **siempre** `COUNT(DISTINCT pk)` para cardinalidad.

## Texto: matching tolerante de nombres / inmobiliarias

Cuando un admin Ungga pida "muéstrame los datos de Bricsa":

```sql
WITH candidatos AS (
  SELECT DISTINCT u.organization_id, u.org_name
  FROM `ungga-full.firestore_users.users_light` u
  WHERE LOWER(u.org_name) LIKE LOWER(@needle)
    AND (u.is_test IS NULL OR u.is_test = FALSE)
)
SELECT * FROM candidatos
```

con `@needle = '%bricsa%'`. Si retorna >1 resultado, enumera al usuario
para que confirme. **Nunca** uses el `org_name` directo como filtro de
métricas; siempre resuélvelo a `organization_id` primero.
