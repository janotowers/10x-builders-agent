# Glossary — vocabulario de negocio Ungga

Mapeo de términos que el usuario suele usar a su definición operativa /
SQL. Cuando una pregunta contenga alguno de estos términos, **usa la
definición de aquí** y no inventes una propia.

## Identidad / cuentas

- **Inmobiliaria** = una organización (`organization_id`). Una inmobiliaria
  agrupa a varios usuarios (asesores). Es la unidad de tenant en multi-tenant
  filtering.
- **Cliente Ungga / cliente** = un usuario (`firestore_users.users_light`)
  cuyo registro **no es de prueba** — `WHERE (is_test IS NULL OR is_test = FALSE)`.
- **Asesor** = un usuario individual dentro de una inmobiliaria.
  Equivalente operativo a "agente" o "broker".
- **Super-admin** = `users_light.role_user = 'super-admin'`. En la práctica
  representa a la inmobiliaria como entidad (cuenta dueña).

## Activación de Gu

- **Cliente con Gu activado** = un usuario cuyo registro de
  `firestore_gu_numbers.gu_numbers_light` cumple `is_active_gu = TRUE`.
- **Cliente con Gu pausado** = `is_active_gu = TRUE AND bypass_bot = TRUE`.
- **Gu operando** (heurística "mensual"): `is_active_gu = TRUE AND
  bypass_bot = FALSE`. (Esto es el "MAU" de Gu: clientes para los que
  Gu efectivamente atiende leads.)

## Leads

- **Lead** = registro en `mongo_data.leads_light`.
- **Lead "no eliminado"** = `is_deleted IS NULL OR is_deleted = FALSE`
  (en `leads_light` el campo puede no existir; si la consulta no lo usa,
  asumir todo lead presente está vivo a menos que el cliente lo borre).
- **Lead nuevo en período** = `created_at` dentro del período.
- **Lead atendido** = lead con al menos un mensaje en `messages_light`
  ligado por `document_name` → `leads_light.lead_id`.
- **Lead que interactuó** = lead con al menos un mensaje del autor
  humano (no `'gu'`) en el período.
- **Owner del lead** = el asesor dueño, vía `owner_firebase_id` →
  `users_light.document_id`.

## Citas (appointments)

- **Cita** = `mongo_data.appointments_light`.
- **Cita solicitada** = caso especial cuando `appointment_status` y
  `owner_appointment_status` son ambos NULL/''. Reportar ese estado como
  `"Cita solicitada"`.
- **Cita finalizada** = `finished = 'true'` (texto, no boolean).
- **Cita reagendada** = `rescheduled = 'true'`.

## Deals

- **Deal** = oportunidad creada en `firestore_deals.deals_light`.
  Un deal **no es** un cierre — es una etapa avanzada del lead.

## Mensajes

- **Mensaje saliente / de Gu** = `LOWER(TRIM(author)) = 'gu'`.
- **Mensaje entrante / del lead** = author distinto de `'gu'` y distinto
  de los teléfonos del owner / Gu (filtrar lo que coincida con
  `gu_numbers_light.phone_number` o `users_light.phone_number`).
- **Conversación** = todos los mensajes con el mismo `lead_id`
  (extraído del `document_name`). Una conversación es 1:1 lead↔Gu.

## Inventario

- **Propiedad** = `firestore_properties.properties_light`.
- **Publicada** = `ad_status = 'Publicado'`.
- **Tipos** (`house_type`): `Casa`, `Departamento`, `Oficina`, `Local Comercial`,
  `Bodega/Nave Industrial`, `Terreno`, `Edificio`, `Hotel`, `Casa con Local`,
  `Lote en Plaza Comercial`, `Casa en Coto`, `Departamento en Coto`. Si el
  usuario dice "departamento", "depas", etc., normalizar a `'Departamento'`.
- **Monetización** (`monetization_type_display`): `Preventa`, `Venta`, `Renta`.
  Mapear "vender / venta" → `'Venta'`; "rentar / alquilar / arrendar" →
  `'Renta'`; "preventa" → `'Preventa'`.

## Tiempo

- **Hoy / hoy CDMX** = `CURRENT_DATE('America/Mexico_City')`.
- **Ayer** = ese - 1 día.
- **Esta semana** = lunes 00:00 CDMX a domingo 23:59 CDMX.
- **Este mes / mes en curso** = del primer día del mes (CDMX) al fin de mes (CDMX).
- **Cierre / cerrar el día** = corte 23:59:59 CDMX del día indicado.

> Para todas las comparaciones temporales, usa `DATE(<ts>, 'America/Mexico_City')`
> y compara contra `@start_date` / `@end_date` parametrizadas. Ver
> `conventions.md` para los anti-patrones a evitar.

## Términos compuestos / KPIs comunes

- **MAU de Gu** ≈ usuarios distintos con `is_active_gu = TRUE AND
  bypass_bot = FALSE` que tuvieron al menos un mensaje saliente
  (`author = 'gu'`) en el mes.
- **Funnel** (en orden): lead creado → lead interactuó → cita →
  deal. Cada paso filtrado por la `users_light` del tenant.
- **Tasa de respuesta de Gu** = `COUNT(mensajes con author='gu') /
  COUNT(mensajes con author del lead)` en el período, por lead.
- **Top inmobiliarias** (solo modo admin Ungga) = ranking por una
  métrica del funnel agrupado por `organization_id`.
