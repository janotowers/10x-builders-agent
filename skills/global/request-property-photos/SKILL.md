---
name: request-property-photos
description: Solicita fotos del inmueble al asesor interno, da seguimiento hasta recibirlas y deja el caso listo para preparar la publicación. Usado como sub-skill de property-optioning-coach durante el step `photos_requested`.
scope: business
allowed_tools:
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - operational_case_register_document
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Este paso es exclusivamente interno. NO contactes al propietario externo
  ni uses herramientas de calendario.
  La meta es dejar evidencia clara de solicitud de fotos y mantener
  `waiting_internal` hasta que el asesor confirme con «listo» y existan
  al menos 5 fotos en `raw_photos`.
---

# Request property photos

## Objetivo

Solicitar y consolidar fotos del inmueble por el asesor interno para avanzar
al paso de publicación.

## Workflow

1. Lee del caso:
   - `context_jsonb.raw_photos` (si ya hay fotos cargadas).
   - `context_jsonb.property_data` para personalizar la solicitud.

2. Si hay menos de 5 fotos confirmadas con «listo»:
   - Llama `notify_user(kind=photos_upload_requested)` con el copy estructurado
     (mínimo 5, checklist sugerida, instrucción de responder **«listo»** al
     terminar; canal-neutral: «aquí»).
   - Inserta `operational_case_add_event(reminder_sent, payload={purpose: photos_upload_requested})`.
   - Mantén `current_step=photos_requested`, `status=waiting_internal`.

3. La subida y el cierre del lote los hace la app de forma determinística
   (web/Telegram): cada foto se agrega a `raw_photos`; cuando el asesor escribe
   «listo», el sistema valida `raw_photos.length >= 5` y avanza a
   `package_ready` si cumple.

4. Si el asesor escribe «listo» con menos de 5 fotos, el sistema responde cuántas
   faltan y conserva `waiting_internal`. No avances manualmente en ese caso.

## Copy sugerido para notify_user

Usa este esquema (adapta la dirección desde `property_data`). En el texto del
`notify_user` escribe exactamente `**«listo»**` (negrita markdown) para que
Telegram/web lo resalten:

```
Solicitud de fotos — {dirección o título}

Sube al menos 5 fotos del inmueble aquí (puedes enviar más).

Fotos sugeridas:
• Fachada
• Sala / comedor
• Cocina
• Recámara principal
• Baño principal
• Extras opcionales: jardín, estacionamiento, amenidades, detalles

Cuando termines de subir todas las fotos, responde **«listo»**.
```

No incluyas «Referencia del caso», enlaces al panel ni menciones de canal
específico («por web o por Telegram»).

## Antipatrones

- Contactar al dueño externo en este paso.
- Intentar calendarizar sesiones o usar tools de calendario.
- Avanzar a `package_ready` sin «listo» del asesor y sin >= 5 fotos en `raw_photos`.
- Mensajes genéricos sin checklist ni instrucción de **«listo»**.
- Mencionar panel, laboratorio o «Referencia del caso» en el copy.
