# Few-shots — Propiedades / Inventario

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
