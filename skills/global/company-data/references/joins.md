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
| `messages_light` → `gu_numbers_light` | `m.document_id` (es el `phone_number` del Gu) | `g.phone_number` | `m.document_id = g.phone_number` (sin REPLACE) |
| `messages_light` → `leads_light` | `m.document_name` (URI Firestore — **dual format**) | `l.lead_id` o `l.phone_number` | **Ver "Patrón canónico" abajo** — country-agnostic |

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

> **Modo ADMIN UNGGA**: omite el `WHERE u.organization_id = @organization_id`
> para queries cross-tenant, o reemplázalo por la resolución `org_name → organization_id`
> de `conventions.md` cuando el usuario nombra una inmobiliaria.

## Patrón canónico — mensajes ↔ leads (country-agnostic)

`messages_light.document_name` codifica la conversación en una ruta
Firestore que existe en **dos formatos** (ver `schema.md`):

```
Formato VIEJO (histórico, dominante hoy):
  …/leads/<lead_phone><gu_phone><user_phone>/wsp_messeges/<msg_id>
            └────── concatenated digits ──────┘
            (en MX cada teléfono = 13 dígitos → 39 dígitos totales,
             pero en otros países la longitud difiere)

Formato NUEVO:
  …/leads/<lead_id>/wsp_messeges/<gu_phone>
           └─ MongoDB ObjectId / Firestore ID alfanumérico
```

El patrón de extracción canónico saca **el "lead path id"** (lo que vaya
entre `/leads/` y `/wsp_messeges/`):

```sql
REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/')
```

Para JOINs contra `leads_light`, usa este patrón **country-agnostic** que
cubre AMBOS formatos:

```sql
WITH msgs AS (
  SELECT
    m.*,
    REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS lead_path
  FROM `ungga-full.firestore_messages.messages_light` m
)
SELECT …
FROM msgs m
JOIN `ungga-full.mongo_data.leads_light` l
  ON
    -- Rama formato NUEVO: el path es el lead_id directo (alfanumérico)
    m.lead_path = l.lead_id
    OR
    -- Rama formato VIEJO: el path es solo dígitos y empieza con el
    -- teléfono normalizado del lead. STARTS_WITH no asume longitud →
    -- funciona para MX (13d), US (11d), UK (12d), BR (13d), ES (11d), …
    (
      REGEXP_CONTAINS(m.lead_path, r'^\d+$')
      AND STARTS_WITH(
        m.lead_path,
        REGEXP_REPLACE(SAFE_CAST(l.phone_number AS STRING), r'[^0-9]+', '')
      )
    )
WHERE …
```

**Por qué es robusto:**

- `STARTS_WITH` no asume cuántos dígitos tiene cada teléfono → seguro para
  expansión internacional.
- `REGEXP_CONTAINS(...,r'^\d+$')` evita que la rama "viejo" matchee
  accidentalmente con un `lead_id` (que es alfanumérico).
- Cuando el backend converja a un solo formato, podrás eliminar la rama
  que ya no aplique sin tocar el resto.

### Cuándo NO necesitas tocar `leads_light`

Si la pregunta es solo "cuántas conversaciones únicas en febrero" o
"cuántos mensajes Gu vs user", el `lead_path` es ya el identificador
único de la conversación — agrúpalo directamente, sin join:

```sql
SELECT
  REGEXP_EXTRACT(m.document_name, r'/leads/([^/]+)/wsp_messeges/') AS conv_id,
  COUNTIF(LOWER(TRIM(m.author)) = 'user') AS user_msgs,
  COUNTIF(LOWER(TRIM(m.author)) = 'gu')   AS gu_msgs
FROM `ungga-full.firestore_messages.messages_light` m
WHERE DATE(m.message_time, 'America/Mexico_City') >= @start_date
  AND DATE(m.message_time, 'America/Mexico_City') <  @end_date
GROUP BY conv_id
HAVING user_msgs >= 1;   -- "atendidos" si quieres filtrar
```

### ❌ Anti-patrón — `SUBSTR(REGEXP_EXTRACT(...), 1, 13)`

Este patrón aparece en queries históricos y **no debe replicarse**:

```sql
-- NO USAR:
SUBSTR(REGEXP_EXTRACT(m.document_name, r'leads/(\d{39})/'), 1, 13) AS lead_phone
```

Razones:

- El regex `\d{39}` solo matchea cuando los teléfonos suman 39 dígitos
  (MX 13+13+13). En US (11+11+11=33), UK (12+12+12=36) o ES (11+11+11=33)
  no matchea — el resultado es `NULL` y la query devuelve cero filas
  silenciosamente.
- `SUBSTR(..., 1, 13)` asume que el primer teléfono es de 13 dígitos.
  Mismo problema country-specific.
- No matchea el formato NUEVO (lead_id alfanumérico).

Si encuentras un query existente con este patrón, **migrarlo** al patrón
canónico de arriba antes de reutilizarlo.

## Joins que multiplican filas (1→N) — usa `COUNT(DISTINCT)`

- `users_light` → `properties_light`: un usuario tiene N propiedades.
- `users_light` → `leads_light`: un usuario tiene N leads.
- `leads_light` → `appointments_light`: un lead puede tener N citas.
- `leads_light` → `messages_light`: un lead tiene muchos mensajes.

Cuando midas "cuántos X únicos", siempre `COUNT(DISTINCT x.document_id)`
(o `x.lead_id`, `x.appointment_id`).

## Heurística autor del mensaje (es humano del lado del cliente?)

Para detectar mensajes del lead (humano), prefiere **`= 'user'`** (la
etiqueta canónica que el bot escribe), no `<> 'gu'`:

```sql
-- ✅ Recomendado — definición canónica
WHERE LOWER(TRIM(m.author)) = 'user'

-- ⚠️  Tolerante (incluye etiquetas raras y MSISDNs) — usar solo si
-- explícitamente quieres "todo lo que no es Gu"
WHERE LOWER(TRIM(m.author)) <> 'gu'
```

Ver `glossary.md` para las definiciones de "atendidos" / "interactuaron".
