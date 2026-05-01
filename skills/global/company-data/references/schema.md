# Schema — Ungga warehouse (`ungga-full`)

Solo se documentan las **vistas `_light`**. Las tablas `_raw_light` no se
deben consultar; existen solo como pre-agregación interna.

> Convención: PII = el campo contiene datos personales (nombres,
> teléfonos, emails). Evita devolverlos al modelo salvo que el usuario
> los pida explícitamente y para una sola fila.

## 1. `firestore_users.users_light` — Cuentas (asesores / inmobiliarias)

PK: `document_id` STRING.

| Column | Type | Notes |
|---|---|---|
| `document_id` | STRING | PK. Suele aparecer en otras tablas con prefijo `users/` (normalizar). |
| `organization_id` | STRING | **Identificador canónico de la inmobiliaria** — clave para multi-tenant filter. |
| `org_name` | STRING (PII) | Nombre comercial. Puede estar vacío/null; NO usar como filtro principal. |
| `display_name` | STRING (PII) | Nombre visible del usuario/persona. |
| `lastName` | STRING (PII) | Apellido. |
| `email` | STRING (PII) | Email del usuario. |
| `phone_number` | STRING (PII) | Teléfono personal del usuario (asesor/owner). |
| `role_user` | STRING | Rol; `super-admin` típicamente representa a la inmobiliaria. |
| `country_user` | STRING | País del usuario. |
| `created_time` | TIMESTAMP | Fecha de alta de la cuenta. |
| `is_test` | BOOL | **Excluir** de métricas: `WHERE (is_test IS NULL OR is_test = FALSE)`. |
| `gga` | BOOL | **MarketMeet flag** — `gga = TRUE` ⇒ el usuario pertenece al sub-producto MarketMeet. Útil para segmentar reportes (no es un flag interno aislado). |
| `uid` | STRING | ID alterno. |
| `web` | STRING | Sitio web (no PII). |
| `asked_properties` | INT64 | Contador propio del producto. |
| `popular_properties` | ARRAY<STRUCT<count INT64, title STRING>> | Pre-agregado de propiedades populares. |
| `waba_ids` | STRING (PII) | IDs WhatsApp Business Account. |
| `associations` | ARRAY<STRING> | Lista de asociaciones del usuario. |
| `crm_email`, `crm_name`, `crm_status`, `crm_update` | varios | Datos de CRM externo conectado. |
| `<broker>_email`, `<broker>_status` (alterstate, wiggot, tokko, brokerfy, inmoapp, exp, remax, alfa, upides, wasi) | STRING | Conectores con CRMs/portales inmobiliarios. |

## 2. `firestore_properties.properties_light` — Inventario

PK: `document_id` STRING.

| Column | Type | Notes |
|---|---|---|
| `document_id` | STRING | PK. |
| `user_owner` | STRING | FK → `users_light.document_id` (con prefijo `users/`, normalizar). |
| `assignedTo` | STRING | Usuario asignado distinto del owner. |
| `ad_status` | STRING | Borrador / Publicado / Archivado. |
| `address` | STRING (PII) | Dirección. |
| `city`, `state`, `country` | STRING | Ubicación administrativa. |
| `latitude`, `longitude` | FLOAT64 | Coordenadas (no PII per se). |
| `house_type` | STRING | Casa, Departamento, Oficina, Bodega/Nave Industrial, Terreno, etc. |
| `monetization_type_display` | STRING | Preventa / Venta / Renta. |
| `price_display`, `currency_display` | STRING | Precio mostrado (string formatado, no INT). |
| `bathroom`, `bedroom` | FLOAT64 | Cantidades. |
| `amenities` | STRING | Texto libre con amenidades. |
| `description` | STRING | Texto del anuncio. |
| `import_id`, `import_source`, `is_imported` | varios | Trazabilidad de importación. |
| `created_time` | TIMESTAMP | Alta de la propiedad. |
| `shared_commission_display` | STRING | Comisión compartida si aplica. |
| `public_url` | STRING | URL pública en la plataforma. |

## 3. `firestore_gu_numbers.gu_numbers_light` — Números de Gu (AI coworker WhatsApp)

PK: `document_id` STRING.

| Column | Type | Notes |
|---|---|---|
| `document_id` | STRING | PK. |
| `user_owner` | STRING | FK → `users_light.document_id` (prefijo `users/`). |
| `phone_number` | STRING | **Teléfono Gu** (el del bot). En joins con `messages_light`, `m.document_id = g.phone_number`. |
| `user_phone_number` | STRING (PII) | Teléfono personal del usuario dueño del Gu (debería coincidir con `users_light.phone_number`). |
| `asign_date` | TIMESTAMP | Fecha de asignación del número Gu. |
| `is_active_gu` | BOOL | TRUE = Gu activado. |
| `bypass_bot` | BOOL | TRUE = Gu pausado (activo pero no operando). |
| `pending_payment` | BOOL | Indicador interno; **no equivale a "no es cliente"**. |
| `from_whatsapp_business` | BOOL | Si el número viene de WBA. |

## 4. `mongo_data.leads_light` — Leads (interesados)

PK: `lead_id` STRING (canónica para joins). Existe también `_id` STRING residual de la migración Mongo; ignorar para joins.

| Column | Type | Notes |
|---|---|---|
| `lead_id` | STRING | **PK canónica** — usar siempre en joins. |
| `_id` | STRING | Residual; ignorar. |
| `name` | STRING (PII) | Nombre del lead. |
| `email` | STRING (PII) | Email del lead. |
| `phone_number` | STRING (PII) | Teléfono del lead (normalizable). |
| `bot_phone_number` | STRING (PII) | Teléfono Gu en el hilo con el lead (matching de mensajes). |
| `language` | STRING | Idioma preferido. |
| `birthdate` | STRING (PII) | (texto) |
| `country_iso`, `country_user` | STRING | País. |
| `portal` | STRING | Origen (Inmuebles24, etc.). |
| `from_ad` | STRING | ID de anuncio si aplica. |
| `created_at` | TIMESTAMP | **Fecha de alta del lead** (mixed types — usar `COALESCE(SAFE_CAST..., SAFE.TIMESTAMP..., SAFE.PARSE_TIMESTAMP..., TIMESTAMP_SECONDS...)`; ver `conventions.md`). |
| `last_interaction` | TIMESTAMP | Última interacción registrada. |
| `owner_firebase_id` | STRING | FK → `users_light.document_id` (prefijo `users/`). |
| `owner_name`, `owner_last_name` | STRING (PII) | Nombre del asesor dueño. |
| `owner_phone_number` | STRING (PII) | Teléfono del asesor dueño. |
| `current_property_id` | STRING | FK → `properties_light.document_id` (prefijo `properties/`). |
| `current_appointment_id` | STRING | FK → `appointments_light.appointment_id`. |
| `current_deal_id` | STRING | FK → `deals_light.document_id`. |
| `current_question_property_id` | STRING | FK → `properties_light.document_id`. |
| `real_state_firm` | STRING | Texto del nombre de inmobiliaria (no usar como FK primaria). |
| `is_agent` | STRING | "true"/"false" si el lead es a su vez un agente. |
| `has_appointment`, `chat_analyzed`, `contacted_by_gu`, `contact_method` | varios | Flags operativos. |
| `dialog_state`, `last_message`, `old_answer_question` | varios | Estado interno de Gu. |
| Otros (`oxylabs_scraper_runs`, `unknown_question_counter`, etc.) | varios | Internos. |

## 5. `mongo_data.appointments_light` — Citas

PK: `appointment_id` STRING.

| Column | Type | Notes |
|---|---|---|
| `appointment_id` | STRING | PK. |
| `lead_id` | STRING | FK → `leads_light.lead_id` (prefijo `leads/`). |
| `property_id` | STRING | FK → `properties_light.document_id` (prefijo `properties/`). |
| `user_owner` | STRING | FK → `users_light.document_id` (prefijo `users/`). |
| `deal_id` | STRING | FK → `deals_light.document_id` (prefijo `deals/`). |
| `date` | STRING | **ISO sin TZ** (`'2025-11-27T00:00:00'`), interpretar como hora local MX. Ver `conventions.md` para parseo seguro. |
| `hour` | STRING | Hora CDMX (texto). |
| `created_time` | TIMESTAMP | Fecha de alta de la cita. |
| `appointment_status` | STRING | Status principal. |
| `owner_appointment_status` | STRING | Status visto por el owner. **Si ambos NULL/'' → "Cita solicitada".** |
| `status` | STRING | Status genérico (verificar antes de usar). |
| `finished` | STRING | "true" si concluida. |
| `rescheduled` | STRING | Reagendada. |
| `property_title`, `property_price` | varios | Snapshot de la propiedad. |
| `name`, `email`, `phone_number` | (PII) | Datos del lead al momento de la cita. |
| `google_event_id` | STRING | Si se sincronizó con Google Calendar. |
| `want_to_acquire`, `property_was_visited`, `prospect_will_be_contacted`, `appointment_qualification`, `reason_for_cancellation` | varios | Telemetría/calificación. |

## 6. `firestore_deals.deals_light` — Oportunidades

PK: `document_id` STRING.

| Column | Type | Notes |
|---|---|---|
| `document_id` | STRING | PK. |
| `lead_uid` | STRING | FK → `leads_light.lead_id` (prefijo `leads/`). |
| `property_uid` | STRING | FK → `properties_light.document_id` (prefijo `properties/`). |
| `asesor` | STRING | FK → `users_light.document_id` (prefijo `users/`); **no es texto**. |
| `lead_name` | STRING (PII) | Nombre del lead snapshot. |
| `phone_number` | STRING (PII) | Teléfono snapshot. |
| `client_type` | STRING | Prospecto / Agente. |
| `monetization_type_display` | STRING | Preventa / Venta / Renta. |
| `house_type` | STRING | Tipo de propiedad. |
| `origin`, `portal` | STRING | Canal/origen. |
| `created_time` | TIMESTAMP | Alta del deal. |

## 7. `firestore_messages.messages_light` — Mensajes

PK: `document_id` STRING — **es el `phone_number` del Gu** (no un id arbitrario). Es decir, varios mensajes comparten `document_id` cuando son del mismo Gu.

| Column | Type | Notes |
|---|---|---|
| `document_id` | STRING | Igual al `phone_number` del Gu en `gu_numbers_light`. Para empatar mensajes con un Gu específico: `m.document_id = g.phone_number` (sin REPLACE). |
| `document_name` | STRING (PII parcial) | **Ruta Firestore** que codifica la conversación. **Coexisten dos formatos**:<br/>• **Formato viejo (dominante en histórico)**: `…/leads/<lead_phone><gu_phone><user_phone>/wsp_messeges/<msg_id>` — los teléfonos van concatenados como dígitos puros (en MX 13+13+13=39 dígitos; en otros países la longitud es distinta).<br/>• **Formato nuevo**: `…/leads/<lead_id>/wsp_messeges/<gu_phone>` — `<lead_id>` es la PK alfanumérica de `mongo_data.leads_light`.<br/>**Extracción country-agnostic**: `REGEXP_EXTRACT(document_name, r'/leads/([^/]+)/wsp_messeges/')` devuelve el "lead path id" (39 dígitos en formato viejo, lead_id en formato nuevo). El JOIN robusto contra `leads_light` cubre AMBOS formatos via `lead_id` directo o `STARTS_WITH(path, normalized_phone)` — ver `joins.md`. **Nunca uses `SUBSTR(...,1,13)`**: esa heurística asume teléfonos MX (13 dígitos) y se rompe en otros países. |
| `author` | STRING | **Definiciones canónicas** (ver `glossary.md`):<br/>• `LOWER(TRIM(author)) = 'gu'` ⇒ mensaje saliente del bot.<br/>• `LOWER(TRIM(author)) = 'user'` ⇒ mensaje entrante del lead (humano).<br/>• Otros valores (MSISDN, etiquetas) son raros — para conteos de tráfico humano siempre usa `= 'user'`, no `<> 'gu'`. |
| `message` | STRING | Contenido. |
| `message_time` | TIMESTAMP | Marca de tiempo del mensaje. |
