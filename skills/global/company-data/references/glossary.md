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
  representa a la inmobiliaria como entidad (cuenta dueña de la organización).
- **MarketMeet** = sub-producto identificado por la columna `users_light.gga`.
  `gga = TRUE` ⇒ el usuario es de MarketMeet. Útil cuando el usuario admin
  pregunta *"cuántos usuarios de MarketMeet…"*.

## Activación de Gu

- **Cliente con Gu activado / Gu habilitado** = un usuario cuyo último
  registro en `firestore_gu_numbers.gu_numbers_light` (ordenado por
  `asign_date DESC`) cumple `is_active_gu = TRUE`. **Importante**: hay
  N filas por usuario; usa siempre el **último estado** vía
  `ARRAY_AGG(STRUCT(...) ORDER BY asign_date DESC LIMIT 1)[OFFSET(0)]`.
- **Gu pausado** = último estado `is_active_gu = TRUE AND COALESCE(bypass_bot, FALSE) = TRUE`.
- **Gu activo** (operando, no pausado) = último estado
  `is_active_gu = TRUE AND COALESCE(bypass_bot, FALSE) = FALSE`.
- **Gu inactivo** = último estado `is_active_gu = FALSE OR is_active_gu IS NULL`.

## Definiciones canónicas para mensajes / leads

> **Estas definiciones son las que debes seguir para cualquier query**.
> Reemplazan heurísticas anteriores como `author <> 'gu'`, que toleran
> ruido (MSISDNs, etiquetas raras) y dan números inflados.

- **Mensaje del lead (humano)** = `LOWER(TRIM(author)) = 'user'`.
- **Mensaje de Gu** = `LOWER(TRIM(author)) = 'gu'`.

- **Lead atendido en período** = lead con **≥ 1 mensaje del lead**
  (`author = 'user'`) en el período. Captura cualquier conversación que
  haya recibido al menos una respuesta del humano (incluyendo el mensaje
  inicial pre-establecido que arranca el chat de WhatsApp).

- **Lead que interactuó en período** = lead con **> 1 mensaje del lead**
  (`COUNTIF(author = 'user') > 1`) en el período. Es estrictamente más
  restrictivo: implica conversación bidireccional sostenida.

- **Lead atendido sin interacción** = atendido pero no llegó a interactuar
  (exactamente 1 mensaje del lead en el período).

- **Lead nuevo en período** = `created_at` (normalizado, ver
  `conventions.md`) cae dentro del período.

- **Lead viejo (en contexto de un período)** = `created_at` previo al
  inicio del período, o `created_at` NULL.

## MAU canónica de Gu

- **MAU de Gu** = usuarios que cumplen **ambas** condiciones para el mes:
  1. Su último estado de Gu **al cierre del mes** es activo y no pausado:
     `last_gu.is_active_gu = TRUE AND COALESCE(last_gu.bypass_bot, FALSE) = FALSE`.
  2. Tienen **≥ 1 lead nuevo creado en el mes**.

  El conteo final es `COUNT(DISTINCT user_id)` que cumpla ambas. Esta es
  la definición que usa el equipo para el reporte MAU; **no la
  reemplaces** por "usuarios con mensajes Gu en el mes" — es una
  aproximación que da números distintos.

## 4-bucket categorización de usuarios

Para un período (snapshot al cierre del mes / hoy), cada usuario cae en
**uno** de estos 4 buckets exclusivos. Útil para el reporte de adopción:

1. `solo_cuenta` — sin inventario.
2. `cuenta_inventario_sin_gu` — con ≥ 1 propiedad (creada antes del cutoff)
   pero sin Gu habilitado al cutoff.
3. `cuenta_inventario_con_gu_activo` — con inventario + último Gu
   `is_active_gu = TRUE AND bypass_bot = FALSE`.
4. `cuenta_inventario_con_gu_pausado` — con inventario + último Gu
   `is_active_gu = TRUE AND bypass_bot = TRUE`.

Todos los conteos derivados del bucketing **deben** apoyarse en
`fewshots-users.md` Advanced para no reinventar la lógica.

## Citas (appointments)

- **Cita** = registro en `mongo_data.appointments_light`.
- **Cita solicitada** = caso especial cuando `appointment_status` y
  `owner_appointment_status` están **NULL, vacío, o el string literal
  `'null'` / `'"null"'`** (artefactos de migración Mongo). Reportar ese
  estado como `'Cita solicitada'` (ver `conventions.md` para el
  normalizer canónico).
- **Cita finalizada** = `finished = 'true'` (texto, no boolean).
- **Cita reagendada** = `rescheduled = 'true'`.
- **Cita agendada por Gu** = cita cuyo asesor (`user_owner`) tenía Gu
  habilitado y NO pausado (`is_active_gu = TRUE AND bypass_bot = FALSE`)
  al momento de la cita (`a.date` parseado a TIMESTAMP). El query típico
  vive en `fewshots-appointments.md` Advanced.

## Deals

- **Deal** = oportunidad creada en `firestore_deals.deals_light`.
  Un deal **no es** un cierre — es una etapa avanzada del lead.

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
- **Cierre del mes** = el último día del mes (`DATE_SUB(DATE_ADD(month_start, INTERVAL 1 MONTH), INTERVAL 1 DAY)`)
  evaluado en CDMX. Para "estado al cierre de mes", el cutoff es ese último día.

> Para todas las comparaciones temporales, usa `DATE(<ts>, 'America/Mexico_City')`
> y compara contra `@start_date` / `@end_date` parametrizadas. Ver
> `conventions.md` para los anti-patrones a evitar.

## Términos compuestos / KPIs comunes

- **Funnel** (en orden): lead nuevo → atendido → interactuó → cita →
  deal. Cada paso filtrado por la `users_light` del tenant en MODO
  OBLIGATORIO; sin filtro en MODO ADMIN UNGGA.
- **Tasa de respuesta de Gu** = `COUNTIF(author='gu') / COUNTIF(author='user')`
  en el período, por lead.
- **Top inmobiliarias** (solo modo ADMIN UNGGA) = ranking por una
  métrica del funnel agrupado por `organization_id`.
- **Solicitudes de visita** = registros nuevos en `appointments_light`
  con `appointment_id IS NOT NULL` en el período (filtra por
  `created_time` parseado).
