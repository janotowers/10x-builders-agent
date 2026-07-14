---
name: request-property-documents
description: |
  Reúne el expediente documental del inmueble en el step `awaiting_documents`
  (boleta indispensable en copy + ideales). Según `document_request_target`, pide
  la subida al equipo interno (`notify_user`) o solicita al contacto externo por
  Telegram; registra qué llegó, manda recordatorios y escala si no responde.
  Sub-skill de property-optioning-coach.
scope: business
allowed_tools:
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - operational_case_list_documents
  - telegram_send_message_to_contact
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Respeta document_request_target: si es internal_user, NUNCA uses
  telegram_send_message_to_contact; usa notify_user al asesor.
  El primer mensaje al dueño (rama externa) SIEMPRE pasa por HITL del
  inmobiliario (telegram_send_message_to_contact tiene risk=high → tarjeta de
  confirmación). Los recordatorios subsecuentes pueden ir sin HITL si la
  política del case_type lo permite, pero el TEXTO debe seguir la plantilla
  acordada (no improvisar).
  Marca cada solicitud/recordatorio con `operational_case_add_event(reminder_sent)`
  para que el cron sepa cuándo fue el último intento.
  Cuando lleguen documentos via `external_response` o subida interna, NO
  improvises el checklist: usa el orden canónico (boleta primero como
  indispensable en copy). El avance por «listo» lo resuelve el runtime con al
  menos un documento recibido; no inventes gates distintos.
---

# Request property documents

## Objetivo

Reunir el expediente (quien aporte depende de la rama):

- **Boleta registral** (indispensable en copy / metadata de checklist).
- **Escritura** — primera hoja o sección con la descripción de la propiedad, y última hoja si la tiene a la mano (ideal).
- **Predial** (último pago, ideal).
- **Identificación oficial** del propietario (anverso/reverso, ideal).
- **Comprobante de domicilio** (no mayor a 3 meses, ideal).

Más cualquier documento extra que la cuenta exija (revisa
`operational_cases.context_jsonb.required_documents` si está definido).

## Workflow

1. Lee el caso. Identifica:
   - `context_jsonb.document_request_target` (**decisión de rama**):
     - `internal_user` — el asesor/equipo sube documentos.
     - `external_contact` — se solicita al dueño/contacto (default sólo si hay
       contacto verificado y no hay elección explícita interna).
   - `context_jsonb.external_contact_setup_status`: si es `pending`, el asesor
     eligió «externo» pero el contacto **aún no** abrió el deep link de
     vinculación. **NO** uses `telegram_send_message_to_contact` hasta que
     `hasOperationalCaseVerifiedExternalContact` sea verdadero
     (`external_contact_status=verified` y `chat_id` presente).
   - `external_contact_jsonb.chat_id` y `display_name` del dueño.
   - `context_jsonb.required_documents`: si no existe, usa la lista
     default de arriba.
   - documentos ya registrados vía `operational_case_list_documents` y/o
     `context_jsonb.documents_received`.

2. **Rama interna** — Si `document_request_target === internal_user`:

   a. NO uses `telegram_send_message_to_contact`.

   b. Revisa eventos recientes. Si ya existe `reminder_sent` con
      `purpose=internal_request` y no hay documento/respuesta interna posterior,
      **no vuelvas a notificar**: conserva la espera event-driven.

   c. Solo en la solicitud inicial (o si hubo nueva evidencia y cambió el
      checklist), llama `notify_user` al asesor con documentos pendientes y
      la instrucción explícita de enviarlos **aquí en el chat** y confirmar con
      “listo” cuando termine. No menciones panel ni URLs de panel.

   d. Deja `status=waiting_internal`, `current_step=awaiting_documents` y
      `next_action_at=null`. La continuación la despierta la carga de un
      documento o la respuesta “listo”; el cron no debe sondear esta espera.

   e. Si enviaste una solicitud, registra
      `operational_case_add_event(reminder_sent, payload={purpose: internal_request})`.

3. **Rama externa** — Si `document_request_target !== internal_user` y **aún no se ha mandado el primer mensaje** (no hay evento
   `reminder_sent` con `purpose=initial_request`):

   a. Compón un mensaje cordial en español pidiendo TODOS los documentos
      pendientes, formateado como bullet list. Señala que la **boleta registral**
      es la indispensable y que lo demás ayuda a dejar el expediente completo.
      Incluye breve frase de tranquilidad (cómo se usan, no se comparten con
      nadie sin permiso).

   b. Llama `telegram_send_message_to_contact` con `purpose=initial_request`,
      `case_id` actual.

   c. Inserta `operational_case_add_event(reminder_sent, payload={purpose: initial_request})`.

   d. Mueve `status=waiting_external`, deja `current_step=awaiting_documents`,
      pon `next_action_at = now() + remind_after_h[0]` (default 24h).

4. **Rama externa (recordatorios)** — Si `document_request_target !== internal_user` y **ya hay mensajes previos** y el cron te invocó porque venció
   `next_action_at`:

   a. Revisa últimos eventos: ¿hay `external_response` posterior al último
      `reminder_sent`? Si sí, ve al paso 4.

   b. Si no hubo respuesta y aún no agotaste los `remind_after_h`,
      manda recordatorio cortés (más breve que el inicial) y registra el
      evento. Programa el siguiente `next_action_at` con la próxima hora
      del array.

   c. Si agotaste los recordatorios y/o pasaste `escalate_after_h`,
      escala al inmobiliario con
      `notify_user(urgency=high, kind=case_escalation)` y mueve
      `status=paused` con un evento `escalated`.

5. Si llegó respuesta del externo (`external_response`):

   a. Lee el payload del evento. Si vienen documentos (URLs/IDs de archivos
      o documentos recibidos),
      añádelos a `context_jsonb.documents_received[]`.

   b. Compara contra el checklist. Si ya hay documentos recibidos y el runtime
      marcó el lote (p. ej. «listo») o hay evidencia suficiente para continuar:
      - mueve `current_step=documents_received`, `status=active`,
        `next_action_at=now()` para que el cron pase a la siguiente
        sub-skill (`extract-property-characteristics`).
      - manda `notify_user("Documento(s) recibido(s) para caso X; paso a extraer características. Documentos ideales faltantes: ...")` si faltan ideales.

   c. Si aún no hay material usable: manda mensaje cortés agradeciendo lo que
      llegó y pidiendo lo pendiente (prioriza boleta). Mantén `waiting_external`
      y reprograma `next_action_at`.

## Plantillas (texto base; ajustar tono al perfil del agente)

### Mensaje inicial

```
Hola, [nombre]. Soy [agente] de [inmobiliaria]. Para preparar la
publicación de tu propiedad necesito estos documentos:

• Boleta registral (indispensable)
• Escritura: primera hoja o sección donde esté la descripción de la propiedad, y última hoja si la tienes a la mano
• Último recibo de predial
• Identificación oficial (anverso y reverso)
• Comprobante de domicilio (≤ 3 meses)

Solo los uso para verificar la propiedad y armar el contrato; no los
comparto con nadie sin tu autorización. ¿Puedes enviarme esos documentos
por aquí cuando puedas?
```

### Recordatorio (24-72h)

```
Hola, [nombre], retomo el mensaje anterior. ¿Cómo vas con los documentos
de la propiedad? Si necesitas que te eche una mano para ubicar alguno,
dime.
```

### Escalación al humano interno

```
[case_id] El dueño de [propiedad] no ha mandado los documentos pese a N
recordatorios desde [fecha]. Te paso el caso para que decidas si llamas
o lo cerramos.
```
