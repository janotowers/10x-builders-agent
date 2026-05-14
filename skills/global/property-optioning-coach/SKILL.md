---
name: property-optioning-coach
description: End-to-end coach for the "opcionar propiedad" workflow used by real estate agencies. Use when the case_type is `property_optioning`. Walks the inmobiliario through capturing the property, building comparables, agreeing the listing price, signing the commission contract, coordinating photos, and assembling the final publication package. Composite skill — orchestrates atomic sub-skills via includes.
scope: business
allowed_tools:
  - get_user_preferences
  - read_skill_reference
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - telegram_send_message_to_contact
  - bigquery_run_query
  - bigquery_lookup_local_comparables
  - easybroker_search_listings
  - easybroker_search_closed_deals
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

## Mapa de pasos (`current_step`)

| Step | Sub-skill principal | Tools clave |
|---|---|---|
| `awaiting_documents` | `request-property-documents` | `telegram_send_message_to_contact`, `notify_user` |
| `documents_received` | `extract-property-characteristics` | `notify_user` |
| `comparables_in_progress` | `perform-comparable-analysis` | `easybroker_search_*`, `bigquery_lookup_local_comparables` |
| `price_proposal_pending` | `prepare-listing-price` | `notify_user` (HITL) |
| `contract_pending` | `prepare-commission-contract` | `generate_document_from_template`, `notify_user` |
| `photos_scheduled` | `coordinate-photo-session` | `calendar_create_event`, `telegram_send_message_to_contact` |
| `package_ready` | `publish-listing-package` | `image_watermark`, `easybroker_create_listing`, `ungga_publish_listing` |

## Workflow (alto nivel)

1. **Lee el bloque `[Caso operacional activo]`** que viene en el system prompt
   y obtén `case_id`, `current_step`, `version`, `external_contact_jsonb`
   y `context_jsonb`. Si falta `case_id`, este turno NO es del cron — pide
   al usuario que abra o seleccione el caso.
2. **Para el `current_step`** elige la sub-skill correspondiente del mapa
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
6. **HITL en juicio comercial**: precio (mínimo y de salida), selección
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
