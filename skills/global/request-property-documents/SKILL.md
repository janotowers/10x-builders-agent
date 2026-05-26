---
name: request-property-documents
description: Solicita al dueño de una propiedad los documentos requeridos (predial, escritura, identificación, comprobante de domicilio) por Telegram, registra qué llegó, manda recordatorios y escala si no responde. Usado como sub-skill de property-optioning-coach durante el step `awaiting_documents`.
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
  El primer mensaje al dueño SIEMPRE pasa por HITL del inmobiliario
  (telegram_send_message_to_contact tiene risk=high → tarjeta de
  confirmación). Los recordatorios subsecuentes pueden ir sin HITL si la
  política del case_type lo permite, pero el TEXTO debe seguir la plantilla
  acordada (no improvisar).
  Marca cada mensaje enviado con `operational_case_add_event(reminder_sent)`
  para que el cron sepa cuándo fue el último intento.
  Cuando lleguen documentos via `external_response`, NO concluyas el paso
  hasta tener evidencia del documento bloqueante: la hoja de escritura donde
  esté la descripción de la propiedad. Los demás documentos son ideales por
  ahora y deben pedirse/recordarse, pero no bloquean el avance a extracción.
---

# Request property documents

## Objetivo

Obtener del dueño:

- **Escritura - hoja con la descripción de la propiedad** (bloqueante).
- **Predial** (último pago, ideal/no bloqueante).
- **Identificación oficial** del propietario (anverso/reverso, ideal/no bloqueante).
- **Comprobante de domicilio** (no mayor a 3 meses, ideal/no bloqueante).
- **Boleta registral** (ideal/no bloqueante).
- **Escritura - primera y última hoja** (ideal/no bloqueante).

Más cualquier documento extra que la cuenta exija (revisa
`operational_cases.context_jsonb.required_documents` si está definido).

## Workflow

1. Lee el caso. Identifica:
   - `external_contact_jsonb.chat_id` y `display_name` del dueño.
   - `context_jsonb.required_documents`: si no existe, usa la lista
     default de arriba.
   - documentos ya registrados vía `operational_case_list_documents` y/o
     `context_jsonb.documents_received`.

2. Si **aún no se ha mandado el primer mensaje** (no hay evento
   `reminder_sent` con `purpose=initial_request`):

   a. Compón un mensaje cordial en español pidiendo TODOS los documentos
      pendientes, formateado como bullet list. Señala que la hoja de escritura
      con descripción de la propiedad es la indispensable para avanzar y que
      lo demás ayuda a dejar el expediente completo. Incluye breve frase de
      tranquilidad (cómo se usan, no se comparten con nadie sin permiso).

   b. Llama `telegram_send_message_to_contact` con `purpose=initial_request`,
      `case_id` actual.

   c. Inserta `operational_case_add_event(reminder_sent, payload={purpose: initial_request})`.

   d. Mueve `status=waiting_external`, deja `current_step=awaiting_documents`,
      pon `next_action_at = now() + remind_after_h[0]` (default 24h).

3. Si **ya hay mensajes previos** y el cron te invocó porque venció
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

4. Si llegó respuesta del externo (`external_response`):

   a. Lee el payload del evento. Si vienen documentos (URLs/IDs de fotos),
      añádelos a `context_jsonb.documents_received[]`.

   b. Compara contra el checklist. Si ya está la hoja de escritura con
      descripción de la propiedad:
      - mueve `current_step=documents_received`, `status=active`,
        `next_action_at=now()` para que el cron pase a la siguiente
        sub-skill (`extract-property-characteristics`).
      - manda `notify_user("Documento clave recibido para caso X; paso a extraer características. Documentos ideales faltantes: ...")` si faltan ideales.

   c. Si falta la hoja de escritura con descripción: manda mensaje cortés
      agradeciendo lo que llegó y pidiendo específicamente ese documento.
      Mantén `waiting_external` y reprograma `next_action_at`.

## Plantillas (texto base; ajustar tono al perfil del agente)

### Mensaje inicial

```
Hola, [nombre]. Soy [agente] de [inmobiliaria]. Para preparar la
publicación de tu propiedad necesito estos documentos:

• Escritura: hoja donde esté la descripción de la propiedad (indispensable para avanzar)
• Último recibo de predial
• Identificación oficial (anverso y reverso)
• Comprobante de domicilio (≤ 3 meses)
• Boleta registral
• Escritura: primera y última hoja, si las tienes a la mano

Solo los uso para verificar la propiedad y armar el contrato; no los
comparto con nadie sin tu autorización. ¿Puedes mandarme las fotos por
aquí cuando puedas?
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
