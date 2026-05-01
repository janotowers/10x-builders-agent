# Few-shots — Propiedades / Inventario

> **Modo**: estos patrones están escritos para **MODO OBLIGATORIO**
> (con `WHERE u.organization_id = @organization_id`). Para **MODO
> ADMIN UNGGA**: si la pregunta no nombra inmobiliaria, **quita el
> CTE `user_ids` filtrado y el WHERE de organization_id** para
> agregar cross-tenant. Si nombra una inmobiliaria, **reemplaza el
> filtro** con el helper `org_name → organization_id` de
> `conventions.md`.

## Basic patterns

### B1. Propiedades publicadas hoy

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT COUNT(DISTINCT p.document_id) AS publicadas_hoy
FROM `ungga-full.firestore_properties.properties_light` p
JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
WHERE p.ad_status = 'Publicado'
  AND DATE(p.created_time, 'America/Mexico_City') = @today;
```

### B2. Inventario actual por tipo y monetización

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  p.house_type,
  p.monetization_type_display,
  COUNT(DISTINCT p.document_id) AS publicadas
FROM `ungga-full.firestore_properties.properties_light` p
JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
WHERE p.ad_status = 'Publicado'
GROUP BY p.house_type, p.monetization_type_display
ORDER BY publicadas DESC;
```

### B3. Última propiedad publicada por asesor

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
  p.document_id,
  p.address,
  p.created_time,
  p.public_url
FROM `ungga-full.firestore_properties.properties_light` p
JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
WHERE p.ad_status = 'Publicado'
QUALIFY ROW_NUMBER() OVER (PARTITION BY u.user_id ORDER BY p.created_time DESC) = 1
ORDER BY p.created_time DESC
LIMIT 100;
```

### B4. Propiedades en un período por estatus

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  COALESCE(NULLIF(p.ad_status, ''), 'sin_estatus') AS ad_status,
  COUNT(DISTINCT p.document_id) AS propiedades
FROM `ungga-full.firestore_properties.properties_light` p
JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
WHERE DATE(p.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(p.created_time, 'America/Mexico_City') <  @end_date
GROUP BY ad_status
ORDER BY propiedades DESC;
```

### B5. Listado paginado de propiedades publicadas

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  p.document_id,
  p.address,
  p.city,
  p.house_type,
  p.monetization_type_display,
  p.price_display,
  p.public_url,
  p.created_time
FROM `ungga-full.firestore_properties.properties_light` p
JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
WHERE p.ad_status = 'Publicado'
QUALIFY ROW_NUMBER() OVER (PARTITION BY p.document_id ORDER BY p.created_time DESC) = 1
ORDER BY p.created_time DESC
LIMIT @limit;
```

## Advanced analyses

### A1. Funnel decay por propiedad (interés / mensajes / citas / deals)

> "¿De mis propiedades publicadas en el último mes, cuántas tienen al
> menos un lead, una conversación, una cita y un deal?"

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
props AS (
  SELECT p.document_id AS property_id, p.house_type, p.monetization_type_display
  FROM `ungga-full.firestore_properties.properties_light` p
  JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
  WHERE p.ad_status = 'Publicado'
    AND DATE(p.created_time, 'America/Mexico_City') >= @start_date
    AND DATE(p.created_time, 'America/Mexico_City') <  @end_date
),
leads_x_prop AS (
  SELECT
    REPLACE(l.current_property_id, 'properties/', '') AS property_id,
    COUNT(DISTINCT l.lead_id) AS leads_count
  FROM `ungga-full.mongo_data.leads_light` l
  WHERE l.current_property_id IS NOT NULL
  GROUP BY property_id
),
appts_x_prop AS (
  SELECT
    REPLACE(a.property_id, 'properties/', '') AS property_id,
    COUNT(DISTINCT a.appointment_id) AS citas_count
  FROM `ungga-full.mongo_data.appointments_light` a
  GROUP BY property_id
),
deals_x_prop AS (
  SELECT
    REPLACE(d.property_uid, 'properties/', '') AS property_id,
    COUNT(DISTINCT d.document_id) AS deals_count
  FROM `ungga-full.firestore_deals.deals_light` d
  GROUP BY property_id
)
SELECT
  COUNT(DISTINCT p.property_id)                                                  AS publicadas,
  COUNT(DISTINCT IF(IFNULL(lp.leads_count, 0)  > 0, p.property_id, NULL))         AS con_leads,
  COUNT(DISTINCT IF(IFNULL(ap.citas_count, 0)  > 0, p.property_id, NULL))         AS con_citas,
  COUNT(DISTINCT IF(IFNULL(dp.deals_count, 0)  > 0, p.property_id, NULL))         AS con_deals
FROM props p
LEFT JOIN leads_x_prop  lp ON p.property_id = lp.property_id
LEFT JOIN appts_x_prop  ap ON p.property_id = ap.property_id
LEFT JOIN deals_x_prop  dp ON p.property_id = dp.property_id;
```

### A2. Top N propiedades por leads en el período

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
props AS (
  SELECT p.document_id AS property_id, p.address, p.public_url
  FROM `ungga-full.firestore_properties.properties_light` p
  JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
  WHERE p.ad_status = 'Publicado'
),
leads_norm AS (
  SELECT
    REPLACE(l.current_property_id, 'properties/', '') AS property_id,
    l.lead_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at),
             TIMESTAMP_SECONDS(SAFE_CAST(l.created_at AS INT64))) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
  WHERE l.current_property_id IS NOT NULL
)
SELECT
  p.property_id,
  ANY_VALUE(p.address)    AS address,
  ANY_VALUE(p.public_url) AS public_url,
  COUNT(DISTINCT ln.lead_id) AS leads
FROM props p
JOIN leads_norm ln ON p.property_id = ln.property_id
WHERE DATE(ln.created_at_norm, 'America/Mexico_City') >= @start_date
  AND DATE(ln.created_at_norm, 'America/Mexico_City') <  @end_date
GROUP BY p.property_id
ORDER BY leads DESC
LIMIT @limit;
```

### A3. Tiempo promedio entre publicación y primer lead

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
props AS (
  SELECT p.document_id AS property_id, p.created_time
  FROM `ungga-full.firestore_properties.properties_light` p
  JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
  WHERE p.ad_status = 'Publicado'
),
first_lead AS (
  SELECT
    REPLACE(l.current_property_id, 'properties/', '') AS property_id,
    MIN(COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
                 SAFE.TIMESTAMP(l.created_at),
                 SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at))) AS first_lead_at
  FROM `ungga-full.mongo_data.leads_light` l
  WHERE l.current_property_id IS NOT NULL
  GROUP BY property_id
)
SELECT
  AVG(TIMESTAMP_DIFF(fl.first_lead_at, p.created_time, HOUR)) AS horas_promedio_a_primer_lead,
  COUNT(DISTINCT p.property_id)                               AS propiedades_con_lead
FROM props p
JOIN first_lead fl ON p.property_id = fl.property_id;
```

### A4. Análisis de caída de leads entre dos meses (anchor / sustituta / archivada)

> Investigación: dado un descenso en leads de un mes a otro, identifica
> las propiedades que más explican el cambio — anclas que perdieron
> tracción, sustitutas que la ganaron, y archivadas con impacto.
>
> Atribución: la propiedad origen del lead se toma del **primer deal**
> del lead. Cambia la fuente si tu modelo de atribución es distinto.

```sql
WITH bounds AS (
  SELECT @start_prev AS start_prev, @start_curr AS start_curr, @next_curr AS next_curr
),
user_ids AS (
  SELECT u.document_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
),
first_deal_per_lead AS (
  SELECT
    REPLACE(d.lead_uid, 'leads/', '')         AS lead_id,
    REPLACE(d.property_uid, 'properties/', '') AS property_id,
    d.created_time                             AS first_deal_time
  FROM `ungga-full.firestore_deals.deals_light` d
  JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.document_id
  WHERE d.lead_uid IS NOT NULL AND d.property_uid IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY REPLACE(d.lead_uid, 'leads/', '')
    ORDER BY d.created_time ASC
  ) = 1
),
property_dim AS (
  SELECT p.document_id AS property_id, p.address, p.city, p.house_type,
         p.monetization_type_display, p.price_display, p.currency_display,
         p.ad_status, p.public_url
  FROM `ungga-full.firestore_properties.properties_light` p
),
monthly_by_property AS (
  SELECT
    f.property_id,
    COUNT(DISTINCT IF(DATE(f.first_deal_time, 'America/Mexico_City') >= b.start_prev
                  AND DATE(f.first_deal_time, 'America/Mexico_City') <  b.start_curr,
                  f.lead_id, NULL)) AS leads_prev,
    COUNT(DISTINCT IF(DATE(f.first_deal_time, 'America/Mexico_City') >= b.start_curr
                  AND DATE(f.first_deal_time, 'America/Mexico_City') <  b.next_curr,
                  f.lead_id, NULL)) AS leads_curr
  FROM first_deal_per_lead f
  CROSS JOIN bounds b
  GROUP BY f.property_id
),
totals AS (
  SELECT SUM(leads_prev) AS total_prev, SUM(leads_curr) AS total_curr
  FROM monthly_by_property
),
detail AS (
  SELECT
    m.property_id, p.address, p.city, p.house_type,
    p.monetization_type_display, p.price_display, p.currency_display,
    p.ad_status AS estatus_actual,
    p.public_url,
    m.leads_prev, m.leads_curr, (m.leads_curr - m.leads_prev) AS delta_abs,
    SAFE_DIVIDE(m.leads_prev, t.total_prev) * 100 AS pct_prev,
    SAFE_DIVIDE(m.leads_curr, t.total_curr) * 100 AS pct_curr,
    (SAFE_DIVIDE(m.leads_curr, t.total_curr) - SAFE_DIVIDE(m.leads_prev, t.total_prev)) * 100 AS delta_share_pts,
    -- Ancla perdida: tenía ≥30% del share previo y cae a ≤10% en el curr
    (SAFE_DIVIDE(m.leads_prev, t.total_prev) >= 0.30
     AND SAFE_DIVIDE(m.leads_curr, t.total_curr) <= 0.10
     AND m.leads_curr < m.leads_prev) AS propiedad_ancla_perdida,
    -- Sustituta: alcanza ≥30% en el curr y crece >+20pp en share
    (SAFE_DIVIDE(m.leads_curr, t.total_curr) >= 0.30
     AND (SAFE_DIVIDE(m.leads_curr, t.total_curr) - SAFE_DIVIDE(m.leads_prev, t.total_prev)) >= 0.20) AS propiedad_sustituta,
    -- Archivada relevante: ya no está publicada y aportaba leads en el prev
    (COALESCE(p.ad_status, '') != 'Publicado'
     AND m.leads_prev > 0 AND m.leads_curr = 0) AS propiedad_archivada_relevante
  FROM monthly_by_property m
  LEFT JOIN property_dim p ON p.property_id = m.property_id
  CROSS JOIN totals t
)
SELECT
  d.*,
  t.total_prev, t.total_curr, (t.total_curr - t.total_prev) AS delta_total
FROM detail d
CROSS JOIN totals t
ORDER BY d.leads_prev DESC, d.property_id;
```

## Cross-tenant (modo ADMIN UNGGA)

### X1. Top inmobiliarias con más propiedades activas

```sql
SELECT
  COALESCE(u.org_name, u.display_name) AS inmobiliaria,
  COUNT(DISTINCT p.document_id)         AS propiedades_activas
FROM `ungga-full.firestore_properties.properties_light` p
JOIN `ungga-full.firestore_users.users_light` u
  ON REPLACE(p.user_owner,'users/','') = u.document_id
WHERE p.ad_status = 'Publicado'
  AND (u.is_test IS NULL OR u.is_test = FALSE)
GROUP BY inmobiliaria
ORDER BY propiedades_activas DESC
LIMIT @limit;
```

### X2. Lista global de propiedades con más leads en el sistema

```sql
WITH prop_leads AS (
  SELECT
    REPLACE(l.current_property_id, 'properties/', '') AS property_id,
    COUNT(*) AS total_leads
  FROM `ungga-full.mongo_data.leads_light` l
  WHERE l.current_property_id IS NOT NULL
  GROUP BY property_id
)
SELECT
  p.document_id, p.address, p.city, p.house_type,
  p.monetization_type_display, p.price_display, p.currency_display,
  p.ad_status, p.created_time, p.public_url,
  pl.total_leads
FROM `ungga-full.firestore_properties.properties_light` p
JOIN prop_leads pl ON p.document_id = pl.property_id
WHERE p.ad_status = 'Publicado'
ORDER BY pl.total_leads DESC
LIMIT @limit;
```

### X3. Análisis de caída anchor/substitute/archived para una inmobiliaria por NOMBRE

> Combina el helper `org_name → organization_id` de `conventions.md` con
> el patrón de A4. Pasa `@org_needle` (ej. `'Garios'`) en lugar de
> `@organization_id`.

```sql
WITH org AS (
  SELECT u.organization_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.role_user = 'super-admin'
    AND REPLACE(REPLACE(LOWER(TRIM(u.org_name)), ' ', ''), 'inmobiliaria', '') LIKE
        CONCAT('%', REPLACE(REPLACE(LOWER(TRIM(@org_needle)), ' ', ''), 'inmobiliaria', ''), '%')
  LIMIT 1
)
-- Después aplica el resto del query A4 sustituyendo
-- "u.organization_id = @organization_id"
-- por
-- "u.organization_id = (SELECT organization_id FROM org)"
SELECT 1;  -- placeholder; reemplazar con el cuerpo del A4 ajustado
```
