# Few-shots — Deals

## Basic patterns

### B1. Deals creados en un período

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT COUNT(DISTINCT d.document_id) AS deals_creados
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date;
```

### B2. Deals por mes (serie temporal)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  DATE_TRUNC(DATE(d.created_time, 'America/Mexico_City'), MONTH) AS mes,
  COUNT(DISTINCT d.document_id) AS deals
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
GROUP BY mes
ORDER BY mes;
```

### B3. Listado de deals (cap N)

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  d.document_id,
  d.lead_name,
  d.client_type,
  d.house_type,
  d.monetization_type_display,
  d.created_time
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
ORDER BY d.created_time DESC
LIMIT @limit;
```

### B4. Deals por tipo de propiedad y monetización

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT
  d.house_type,
  d.monetization_type_display,
  COUNT(DISTINCT d.document_id) AS deals
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
GROUP BY d.house_type, d.monetization_type_display
ORDER BY deals DESC;
```

### B5. Deals por asesor (ranking)

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
  COUNT(DISTINCT d.document_id) AS deals
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date
GROUP BY u.user_id, asesor
ORDER BY deals DESC
LIMIT @limit;
```

## Advanced analyses

### A1. Conversión leads → deals por origen

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
    l.portal,
    REPLACE(l.owner_firebase_id, 'users/', '') AS user_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at)) AS created_at_norm
  FROM `ungga-full.mongo_data.leads_light` l
),
leads_periodo AS (
  SELECT l.lead_id, COALESCE(NULLIF(l.portal, ''), 'sin_portal') AS portal
  FROM leads_norm l
  JOIN user_ids u ON l.user_id = u.user_id
  WHERE DATE(l.created_at_norm, 'America/Mexico_City') >= @start_date
    AND DATE(l.created_at_norm, 'America/Mexico_City') <  @end_date
),
deals_periodo AS (
  SELECT DISTINCT REPLACE(d.lead_uid, 'leads/', '') AS lead_id
  FROM `ungga-full.firestore_deals.deals_light` d
  JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
)
SELECT
  lp.portal,
  COUNT(DISTINCT lp.lead_id)                                                   AS leads,
  COUNT(DISTINCT IF(dp.lead_id IS NOT NULL, lp.lead_id, NULL))                  AS leads_con_deal,
  SAFE_DIVIDE(
    COUNT(DISTINCT IF(dp.lead_id IS NOT NULL, lp.lead_id, NULL)),
    COUNT(DISTINCT lp.lead_id)
  ) AS conv
FROM leads_periodo lp
LEFT JOIN deals_periodo dp ON lp.lead_id = dp.lead_id
GROUP BY lp.portal
ORDER BY conv DESC;
```

### A2. Tiempo medio lead → deal (lead time)

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
    REPLACE(l.owner_firebase_id, 'users/', '') AS user_id,
    COALESCE(SAFE_CAST(l.created_at AS TIMESTAMP),
             SAFE.TIMESTAMP(l.created_at),
             SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', l.created_at)) AS lead_at
  FROM `ungga-full.mongo_data.leads_light` l
)
SELECT
  AVG(TIMESTAMP_DIFF(d.created_time, ln.lead_at, HOUR)) AS horas_promedio_lead_a_deal,
  COUNT(DISTINCT d.document_id) AS deals
FROM `ungga-full.firestore_deals.deals_light` d
JOIN user_ids u ON REPLACE(d.asesor, 'users/', '') = u.user_id
JOIN leads_norm ln ON REPLACE(d.lead_uid, 'leads/', '') = ln.lead_id
WHERE DATE(d.created_time, 'America/Mexico_City') >= @start_date
  AND DATE(d.created_time, 'America/Mexico_City') <  @end_date;
```
