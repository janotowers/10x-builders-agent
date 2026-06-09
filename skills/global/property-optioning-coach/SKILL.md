---
name: property-optioning-coach
description: |
  Coach end-to-end del flujo "opcionar propiedad" para inmobiliarios.
  Composite skill que orquesta sub-skills vía includes.
  Use when the user (inmobiliario) wants to start or continue capturing a
  property to list, including intents en español como: "necesito opcionar
  una propiedad / una casa / un depto", "conseguir la exclusiva",
  "firmar contrato de comisión", "nueva captación", "pedir documentos al
  dueño", "preparar precio de salida", "hacer análisis de comparables",
  "coordinar sesión de fotos", "publicar la propiedad en EasyBroker", o
  cualquier continuación de una conversación donde el usuario ya está
  capturando una propiedad. También úsala cuando el cron la dispare vía
  case binding porque el case_type es `property_optioning` (verás un
  bloque [Caso operacional activo] en el system prompt).
scope: business
allowed_tools:
  - get_user_preferences
  - read_skill_reference
  - notify_user
  - operational_case_create
  - operational_case_update_intake
  - operational_case_update_state
  - operational_case_add_event
  - operational_case_list_documents
  - operational_case_extract_document_fields
  - telegram_send_message_to_contact
  - bigquery_lookup_local_comparables
  - easybroker_search_listings
  - easybroker_search_closed_deals
  - operational_case_persist_comparables_analysis
  - generate_document_from_template
  - image_watermark
  - easybroker_create_listing
  - easybroker_upload_images
  - ungga_publish_listing
  - calendar_list_events
  - calendar_create_event
includes:
  - request-property-documents
  - extract-property-characteristics
  - perform-comparable-analysis
  - prepare-listing-price
  - prepare-commission-contract
  - coordinate-photo-session
  - publish-listing-package
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Decisiones de juicio comercial (precio mínimo, comparables seleccionados,
  contrato final, publicación) SIEMPRE pasan por HITL: el agente prepara,
  el humano aprueba.
  El cron del subsistema operational-cases te invoca sin mensaje del
  usuario. Lee el bloque [Caso operacional activo] del system prompt y
  decide la siguiente acción a partir del current_step.
  Nunca asumas que el dueño respondió: si waiting_external sigue activo
  y no hay external_response reciente en eventos, la acción correcta es
  recordatorio o escalación, no avanzar el paso.
---

# Property Optioning Coach

Esta skill orquesta el procedimiento end-to-end "opcionar propiedad" para
una inmobiliaria. Se aplica cuando el caso operacional es de tipo
`property_optioning`. Combina siete sub-skills atómicas (vía `includes`).

## Completar registro del caso (`intake`) — no es un paso operativo numerado

- **En settings (N0):** el configurador usa la tarjeta **Preparar caso de prueba**
  (formulario del `intake_schema`, crear/regenerar fixture, prueba segura). No
  cuenta como “Paso operativo 1” en readiness.
- El caso nace con `current_step=intake` (formulario web, caso de prueba en
  settings o `operational_case_create` en chat).
- Valida `context_jsonb` contra el `intake_schema_jsonb` del case_type. Si
  falta un campo **required**, no avances: pregunta en chat o `notify_user` al
  inmobiliario (vía `allowed_tools`; no es requisito del grid de intake en
  settings).
- Cuando los required estén cubiertos, usa `operational_case_update_intake`
  (siempre con `expected_version`) para persistir los campos de intake. Esa
  tool limpia `missing_required` y mueve el caso al primer paso operativo
  configurado (`awaiting_documents` en `property_optioning`). La **primera
  acción operativa** es `request-property-documents` (Paso operativo 1), que se
  ejecuta en el siguiente tick del caso.

## Camino conversacional (sin `case_id` en contexto)

- Si el usuario pide iniciar "opcionar propiedad" por chat/Telegram y no hay
  caso en el prompt, llama `operational_case_create` con `case_type:
  property_optioning`, el `context` disponible y `allow_incomplete_intake: true`.
  Esto persiste un draft en `current_step=intake` aunque falten campos required.
- Si la tool devuelve `missing_required`, pregunta esos campos en el mismo chat.
  En turnos posteriores con `[Caso operacional]`, actualiza ese mismo caso; no
  crees casos duplicados.
- Si el usuario responde horas después o intercala preguntas no relacionadas,
  trata el bloque `[Caso operacional]`/binding conversacional como continuidad
  durable del caso. Sólo crea un caso nuevo si hay intención explícita de iniciar
  otro recorrido o si el usuario confirma una aclaración en ese sentido.
- Cuando tengas nuevos datos de intake, llama `operational_case_update_intake`
  con `intake_patch` sólo para los campos declarados en el schema. Si aún faltan
  required, la tool devolverá `missing_required` actualizado. Si ya están todos,
  dejará el caso listo en el primer paso operativo. No envíes mensaje al externo
  en este paso.
- Al cerrar el intake, confirma al inmobiliario con una frase corta: la
  propiedad quedó **registrada** en el caso (nunca «opcional» ni «opcionada»).
  No menciones documentos ni adjuntos en esa confirmación; la solicitud de
  documentos es un paso operativo aparte.
- Usa el `case_id` y `version` devueltos y aplica la misma transición desde
  `intake` descrita arriba.

## Mapa de pasos (`current_step`)

**Preparación (no numerada en UI de readiness):**

| Step | Rol | Tools clave |
|---|---|---|
| `intake` | Completar registro (datos mínimos) | `operational_case_create` (inicio), `operational_case_update_intake` (merge/validación determinística); `notify_user` solo en runtime incompleto |

**Flujo operativo (desde Paso operativo 1):**

| Step | Sub-skill principal | Tools clave (N1 / integración) |
|---|---|---|
| `awaiting_documents` | `request-property-documents` | `telegram_send_message_to_contact`, `notify_user` |
| `documents_received` | `extract-property-characteristics` | `operational_case_list_documents`, `operational_case_extract_document_fields`, `telegram_send_message_to_contact`, `notify_user` |
| `comparables_in_progress` | `perform-comparable-analysis` | `easybroker_search_*`, `bigquery_lookup_local_comparables` (N1); `operational_case_persist_comparables_analysis` y `operational_case_update_state` son **internas** (N3/N4, no N1) |
| `price_proposal_pending` | `prepare-listing-price` | `notify_user` (HITL) |
| `contract_pending` | `prepare-commission-contract` | `generate_document_from_template`, `notify_user` |
| `photos_scheduled` | `coordinate-photo-session` | `calendar_create_event`, `telegram_send_message_to_contact` |
| `package_ready` | `publish-listing-package` | `image_watermark`, `easybroker_create_listing`, `ungga_publish_listing` |

## Workflow (alto nivel)

1. **Lee el bloque `[Caso operacional activo]`** si está en el system prompt:
   obtén `case_id`, `current_step`, `version`, `external_contact_jsonb` y
   `context_jsonb`. Si **no** hay bloque (turno conversacional), ejecuta la
   sección **Camino conversacional** hasta tener `case_id`, luego continúa.
2. **Para el `current_step`** elige la sub-skill o rama correspondiente del mapa
   anterior y lee su SKILL.md (vía `read_skill_reference` si quieres ver
   detalles que no quepan aquí).
3. **Re-sincroniza antes de actuar**: si `status=waiting_external`, revisa
   los últimos eventos en busca de `external_response` no procesado. Si lo
   hay, integra la información en `context_jsonb` y avanza el paso, en vez
   de mandar otro recordatorio.
4. **Mueve el caso** con `operational_case_update_state` (siempre con
   `expected_version`). Inserta eventos descriptivos con
   `operational_case_add_event` cuando algo notable pasa fuera de un
   cambio de estado.
5. **Comunica**:
   - al **inmobiliario** (humano interno): siempre `notify_user`.
   - al **dueño/lead** (humano externo): siempre
     `telegram_send_message_to_contact` (HITL antes de mandar texto nuevo
     no plantillado).
6. **Validación por artefactos de negocio**: cada paso se considera probado
   cuando la sub-skill genera el artefacto esperado en `context_jsonb`
   (`comparables_analysis`, `pricing_proposal`, paquete de publicación, etc.),
   no sólo porque una tool respondió técnicamente.
7. **HITL en juicio comercial**: precio (mínimo y de salida), selección
   final de comparables, contrato firmado, decisión de publicar. Tú
   preparas, el humano decide.

## Recordatorios (lo decide el cron + esta skill)

- Si `current_step=awaiting_documents` y han pasado las horas declaradas en
  `[Política de recordatorios]` desde el último `reminder_sent`, manda otro
  recordatorio al externo (ver atómica `request-property-documents`).
- Si superaste `escalate_after_h`, **escala** al inmobiliario con
  `notify_user(urgency=high)` y deja el caso en `paused` hasta que el
  humano reactive.

## Antipatrones

- Pasar de `awaiting_documents` a `documents_received` sin un evento
  `external_response` que confirme que el dueño mandó algo.
- Llamar `easybroker_create_listing` antes de tener precio aprobado vía
  HITL (`human_decision` con `payload.kind=price_approved`).
- Mandar `telegram_send_message_to_contact` con un texto inventado en
  lugar de una plantilla acordada para los recordatorios.
