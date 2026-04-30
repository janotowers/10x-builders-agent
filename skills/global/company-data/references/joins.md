# Joins — guía de cómo unir tablas correctamente

> Regla de oro: **siempre normaliza el lado con prefijo** (`users/`, `leads/`,
> `properties/`, `deals/`) **al `document_id` puro** antes de comparar.
> Usa `REPLACE(<col>, '<prefix>/', '')` o `SPLIT(<col>, '/')[OFFSET(1)]`.

## Tabla resumen

| Origen → Destino | Columna izquierda (con prefijo) | Columna derecha | Patrón ON |
|---|---|---|---|
| `properties_light` → `users_light` | `p.user_owner` (`users/<id>`) | `u.document_id` | `REPLACE(p.user_owner, 'users/', '') = u.document_id` |
| `gu_numbers_light` → `users_light` | `g.user_owner` (`users/<id>`) | `u.document_id` | `REPLACE(g.user_owner, 'users/', '') = u.document_id` |
| `leads_light` → `users_light` | `l.owner_firebase_id` (`users/<id>`) | `u.document_id` | `REPLACE(l.owner_firebase_id, 'users/', '') = u.document_id` |
| `appointments_light` → `users_light` | `a.user_owner` (`users/<id>`) | `u.document_id` | `REPLACE(a.user_owner, 'users/', '') = u.document_id` |
| `appointments_light` → `leads_light` | `a.lead_id` (`leads/<id>`) | `l.lead_id` | `REPLACE(a.lead_id, 'leads/', '') = l.lead_id` |
| `appointments_light` → `properties_light` | `a.property_id` (`properties/<id>`) | `p.document_id` | `REPLACE(a.property_id, 'properties/', '') = p.document_id` |
| `appointments_light` → `deals_light` | `a.deal_id` (`deals/<id>`) | `d.document_id` | `REPLACE(a.deal_id, 'deals/', '') = d.document_id` |
| `deals_light` → `users_light` | `d.asesor` (`users/<id>`) | `u.document_id` | `REPLACE(d.asesor, 'users/', '') = u.document_id` |
| `deals_light` → `leads_light` | `d.lead_uid` (`leads/<id>`) | `l.lead_id` | `REPLACE(d.lead_uid, 'leads/', '') = l.lead_id` |
| `deals_light` → `properties_light` | `d.property_uid` (`properties/<id>`) | `p.document_id` | `REPLACE(d.property_uid, 'properties/', '') = p.document_id` |
| `messages_light` → `gu_numbers_light` | `m.document_id` (es el `phone_number`) | `g.phone_number` | `m.document_id = g.phone_number` (sin REPLACE) |
| `messages_light` → `leads_light` | `m.document_name` (URI Firestore) | `l.lead_id` | `REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = l.lead_id` |

## Cadena multi-tenant canónica

Para casi cualquier métrica de una inmobiliaria, la "ancla" es
`users_light` filtrado por `organization_id`. Construye un CTE con los
`user_id`s del tenant primero, después haz JOINs hacia él:

```sql
WITH user_ids AS (
  SELECT u.document_id AS user_id
  FROM `ungga-full.firestore_users.users_light` u
  WHERE (u.is_test IS NULL OR u.is_test = FALSE)
    AND u.organization_id = @organization_id
)
SELECT …
FROM `ungga-full.firestore_<x>.<x>_light` x
JOIN user_ids u ON REPLACE(x.<owner_col>, '<prefix>/', '') = u.user_id
WHERE …
```

## Patrón de asociación (atención): mensajes ↔ lead

`messages_light` no tiene FK directa a `leads_light`. La forma robusta
es extraer el `lead_id` del `document_name` (que es la ruta Firestore
de la subcolección `wsp_messeges` debajo del lead):

```
projects/ungga-full/databases/(default)/documents/leads/<LEAD_ID>/wsp_messeges/<GU_PHONE>
                                                       ^^^^^^^^^
```

```sql
SELECT
  REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_id_from_doc,
  m.message_time, m.author, m.message
FROM `ungga-full.firestore_messages.messages_light` m
JOIN `ungga-full.mongo_data.leads_light` l
  ON REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') = l.lead_id
WHERE …
```

Esto reemplaza el patrón antiguo basado en `SUBSTR(REGEXP_EXTRACT(...), 1, 13)`
que matcheaba por teléfono normalizado: era frágil para países distintos
de México y a la longitud del número.

> **Limitar al tenant** una consulta de mensajes: anclar por
> `gu_numbers_light` (el Gu pertenece al usuario) o por `leads_light`
> (el lead tiene `owner_firebase_id`).

## Joins que multiplican filas (1→N) — usa `COUNT(DISTINCT)`

- `users_light` → `properties_light`: un usuario tiene N propiedades.
- `users_light` → `leads_light`: un usuario tiene N leads.
- `leads_light` → `appointments_light`: un lead puede tener N citas.
- `leads_light` → `messages_light`: un lead tiene muchos mensajes.

Cuando midas "cuántos X únicos", siempre `COUNT(DISTINCT x.document_id)`
(o `x.lead_id`, `x.appointment_id`).

## Heurística autor del mensaje (es humano del lado del cliente?)

Para identificar que el mensaje proviene del lead (humano), excluye:

- `LOWER(TRIM(m.author)) = 'gu'`
- `m.author = g.phone_number` (Gu del owner)
- `m.author = u.phone_number` (teléfono personal del owner — algunos
  inmobiliarios responden con su línea)

Para no normalizar siete formatos de teléfono distintos, en la práctica
basta con `LOWER(TRIM(m.author)) <> 'gu'` para detectar "no fue Gu".
Si necesitas ultra-precisión, intersecta contra una vista materializada
del usuario y sus números.
