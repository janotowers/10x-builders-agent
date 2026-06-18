---
name: prepare-commission-contract
description: Genera el DOCX del contrato de comisión (exclusiva o no exclusiva) a partir de la plantilla del tenant, lo manda al inmobiliario para revisión y registra cuando se firma. Usado como sub-skill de property-optioning-coach durante el step `contract_pending`.
scope: business
allowed_tools:
  - generate_document_from_template
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - operational_case_list_documents
  - operational_case_extract_document_fields
  - telegram_send_message_to_contact
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  El contrato es un documento legal: NO modifiques el cuerpo de la
  plantilla. Solo rellena placeholders.
  El borrador SIEMPRE se entrega primero al inmobiliario para revisión
  (HITL). Solo después se manda al dueño.
  Cuando el contrato esté firmado, registra evento human_decision con el
  hash o nombre del archivo final, no el contenido.
  La titularidad debe estar verificada ANTES de generar el contrato. Esta es
  la transición donde la corroboración de identidad (INE/comprobante) es
  precondición real (a diferencia de comparables, donde solo es advertencia).
---

# Prepare commission contract

## Objetivo

1. Renderizar el DOCX del contrato con los datos del caso.
2. Entregarlo al inmobiliario para revisar.
3. Una vez aprobado, mandarlo al dueño por Telegram para firma.
4. Registrar la firma cuando llegue.

## Workflow

1. Lee del caso:
   - `context_jsonb.property_data` (dirección, m², tipo).
   - `context_jsonb.pricing_proposal` (debe estar `approval_status=approved`).
   - `external_contact_jsonb.display_name` (nombre del dueño).
   - `context_jsonb.commission_terms` (si no existe, usa defaults del tenant).

1b. **Gate de titularidad (HITL) antes de generar.** El contrato solo procede
   con la titularidad verificada. `generate_document_from_template` aplica este
   gate de forma determinística y puede devolver:
   - `owner_corroboration_extraction_incomplete`: corre
     `operational_case_extract_document_fields(force=true)` sobre los
     `pending_owner_corroboration_document_ids` (lista con
     `operational_case_list_documents`) y reintenta. Si tras intentarlo el
     documento sigue ilegible, trátalo como desajuste de titularidad abajo.
   - `titularidad_review_required`: NO generes el contrato. Levanta
     `notify_user(kind="titularidad_review")` con un texto accionable que
     explique el desajuste (nombre en boleta vs. INE/comprobante, usando
     `owner_consistency_note`/`owner_consistency_warning`) y pregunte si se
     procede igual o se corrige. Esta notificación llega al asesor por inbox
     web y Telegram. Mantén `current_step=contract_pending`,
     `status=waiting_internal`.
     - Si el asesor aprueba avanzar de todos modos, registra el override con
       `operational_case_update_state` poniendo
       `context.titularidad.override = { approved: true, by: <asesor>, reason: <texto> }`
       y reintenta `generate_document_from_template`.
     - Si el asesor pide corregir, solicita el documento correcto al dueño con
       `telegram_send_message_to_contact` y espera.

2. Llama `generate_document_from_template` exactamente una vez para este borrador:
   ```json
   {
     "template_slug": "commission_contract",
     "format": "docx",
     "case_id": "..."
   }
   ```
   Los placeholders del DOCX (`owner_name`, `property_address`, `property_type`,
   `area_m2`, `salida_price`, `minimum_price`, `commission_pct`, `exclusive`,
   `duration_months`) se rellenan **automáticamente** desde el caso. Solo pasa
   `data` si necesitas sobreescribir algún campo puntual.
   - Si la tool devuelve `status=not_configured`: notifica al inmobiliario
     que falta la plantilla DOCX cargada y pausa el caso (`status=paused`).
   - Si ya tienes `output_path` de esa llamada en este turno, reutilízalo; no vuelvas a generar el mismo contrato.

3. Notifica al inmobiliario sólo cuando tengas un borrador/link real:
   `notify_user(kind="contract_review", "Borrador del contrato listo para [propiedad]. Revísalo y dime si lo mando al dueño o necesita cambios.\n\nDescargar borrador del contrato: <URL>")`.
   Sustituye `<URL>` por el enlace estable del caso: `/api/operational-cases/{case_id}/documents/contract_draft/download` (URL absoluta con el dominio del sitio si la conoces). **No** pegues la `signed_url` larga de Supabase en el mensaje. Si no hay `output_path` renderizado o
   plantilla no se pudo generar, no pidas aprobación de contrato; explica
   qué configuración falta y pausa el caso.

4. Inserta evento `operational_case_add_event(human_decision, payload={kind: contract_drafted, doc_url: "<mismo enlace corto>", output_path, output_bucket})` usando `output_path`/`output_bucket` de la tool.
5. Mantén `current_step=contract_pending`, `status=waiting_internal` hasta
   que el inmobiliario revise. Esta espera es interna; `waiting_external` sólo
   aplica cuando ya se mandó algo al dueño/lead y esperamos su respuesta.

6. Cuando el inmobiliario aprueba (mensaje normal):
   - Manda al dueño por Telegram con
     `telegram_send_message_to_contact` y un texto del estilo:
     ```
     [nombre], te paso el contrato de comisión para que lo revises.
     Cuando estés conforme, fírmalo y mándame el PDF firmado por aquí.
     ```
     Adjunta el archivo (Telegram bot puede enviar `sendDocument`; si solo
     usamos sendMessage, manda el link al archivo).
   - Inserta `operational_case_add_event(reminder_sent, payload={purpose: contract_sent_to_owner})`.

7. Cuando llega `external_response` con el contrato firmado:
   - Verifica que el archivo está adjunto.
   - Mueve `current_step=photos_scheduled`, `status=active`.
   - Inserta `operational_case_add_event(step_completed, payload={kind: contract_signed, file_id: "..."})`.
   - Notifica al inmobiliario:
     `notify_user("Contrato firmado por el dueño. Empiezo a coordinar la sesión de fotos.")`.

## Antipatrones

- Mandar el contrato al dueño SIN aprobación previa del inmobiliario.
- Llenar campos del contrato con datos no verificados
  (`pricing_proposal.salida` debe estar `approved`).
- Continuar al siguiente paso con `human_decision(kind: contract_drafted)`
  sin `human_decision(kind: contract_signed)` posterior.
