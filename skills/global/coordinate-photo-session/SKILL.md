---
name: coordinate-photo-session
description: Coordina la sesión de fotos profesional de una propiedad: propone horarios, confirma con dueño y fotógrafo, crea el evento en calendar, recuerda 24h antes y 2h antes. Usado como sub-skill de property-optioning-coach durante el step `photos_scheduled`.
scope: business
allowed_tools:
  - calendar_list_events
  - calendar_create_event
  - calendar_update_event
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - telegram_send_message_to_contact
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Antes de proponer horarios, lee el calendario del inmobiliario y del
  fotógrafo (si está disponible) para no proponer horas con conflictos.
  El evento de calendar SIEMPRE pasa por HITL (calendar_create_event tiene
  risk=high).
  Recordatorios automáticos al dueño y al fotógrafo deben mandarse 24h
  antes y 2h antes; el cron es responsable de levantarlos por
  next_action_at.
---

# Coordinate photo session

## Objetivo

Concretar una sesión de fotos profesional para la propiedad y dejar
agendados los recordatorios.

## Workflow

1. Lee del caso:
   - `external_contact_jsonb.chat_id` (dueño).
   - `context_jsonb.photographer_contact` (si está, chat_id y nombre del
     fotógrafo asignado por la inmobiliaria).
   - `context_jsonb.property_data.address` (para incluir en el evento).
   - `context_jsonb.photo_session` (si ya existe parcialmente).

2. Si **aún no hay propuesta**:

   a. `calendar_list_events(time_min=mañana 8am, time_max=+5 días, calendar_id=primary)`
      para ver disponibilidad del inmobiliario.

   b. Sugiere 3 ventanas de 2h cada una en horario diurno (9am-5pm) que no
      choquen con eventos existentes.

   c. Manda al dueño un mensaje vía
      `telegram_send_message_to_contact(purpose=propose_photo_slots)` con
      las 3 opciones. Texto base:

      ```
      [nombre], el fotógrafo profesional puede ir a tomar las fotos en
      alguna de estas ventanas:

      1) [día y hora]
      2) [día y hora]
      3) [día y hora]

      Cada sesión dura ~2h. ¿Cuál te queda mejor?
      ```

   d. Inserta `operational_case_add_event(reminder_sent, payload={purpose: propose_photo_slots, options: [...]})`.

   e. Pon `status=waiting_external`, `next_action_at=now()+24h`.

3. Cuando el dueño elige una opción (`external_response`):

   a. Parsea la opción elegida.

   b. Llama `calendar_create_event` con:
      - `summary`: "Sesión fotos · [property address]"
      - `start_datetime`, `end_datetime`: la opción elegida.
      - `description`: incluye `case_id`, dueño, contacto del fotógrafo.

   c. Si hay `photographer_contact`:
      - Manda al fotógrafo por Telegram con detalles
        (`purpose=photographer_briefing`).

   d. Confirma al dueño:
      ```
      ¡Listo! Quedamos el [fecha y hora]. Te recuerdo 24h antes.
      Mientras tanto, deja la casa lista (luces, persianas abiertas,
      sin objetos personales muy a la vista).
      ```

   e. Persiste en `context_jsonb.photo_session = { scheduled_at, calendar_event_id, photographer }`.

   f. Mueve `next_action_at = scheduled_at - 24h` y mantén
      `current_step=photos_scheduled`, `status=waiting_external` hasta el
      recordatorio.

4. **Recordatorio 24h antes** (cuando el cron te invoca con
   `next_action_at` ≈ scheduled_at - 24h):
   - Manda recordatorio al dueño y al fotógrafo.
   - Reprograma `next_action_at = scheduled_at - 2h`.
   - Inserta evento `reminder_sent`.

5. **Recordatorio 2h antes**:
   - Manda recordatorio corto al dueño.
   - Mueve `next_action_at = scheduled_at + 3h` (margen para que sucedan
     las fotos).

6. **Después de la sesión** (cuando el cron levanta el caso post-fotos):
   - Pregunta al inmobiliario si las fotos ya están listas y dónde están.
   - Cuando confirme y suba las fotos a `context_jsonb.raw_photos[]`,
     mueve `current_step=package_ready`, `status=active`.

## Antipatrones

- Crear el evento de calendar antes de la confirmación explícita del dueño.
- Mandar 5 recordatorios cuando solo se acordaron 2.
- Llamar al fotógrafo a las 11pm con un recordatorio de "mañana 9am" sin
  filtrar por `quiet_hours` del usuario.
