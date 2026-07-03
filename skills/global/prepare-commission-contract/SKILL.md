---
name: prepare-commission-contract
description: Genera el DOCX del contrato de comisión (exclusiva o no exclusiva) a partir de la plantilla del tenant y lo entrega al inmobiliario para revisión (HITL). El envío al propietario por email y el avance del caso los ejecuta la app cuando el inmobiliario decide; el agente NO envía el contrato al dueño. Usado como sub-skill de property-optioning-coach durante el step `contract_pending`.
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
  (HITL) con notify_user(kind="contract_review"). El agente NO manda el
  contrato al dueño: el envío al propietario por email (con la cuenta Gmail
  conectada del asesor) y el avance del caso a `photos_requested` los ejecuta
  la app cuando el inmobiliario aprueba desde la bandeja/Telegram ("Enviar por
  email" o "Subir contrato corregido y enviar"). No uses
  telegram_send_message_to_contact para enviar el contrato.
  La titularidad debe estar verificada ANTES de generar el contrato. Esta es
  la transición donde la corroboración de identidad (INE/comprobante) es
  precondición real (a diferencia de comparables, donde solo es advertencia).
---

# Prepare commission contract

## Objetivo

1. Renderizar el DOCX del contrato con los datos del caso.
2. Entregarlo al inmobiliario para revisión (HITL) con
   `notify_user(kind="contract_review")` y un enlace de descarga estable.
3. Detenerte ahí: el inmobiliario decide desde la bandeja/Telegram ("Enviar
   por email" o "Subir contrato corregido y enviar"). El envío al propietario
   por email y el avance del caso a `photos_requested` los ejecuta la app, no
   el agente.
4. Tratar la firma del propietario fuera de este flujo por ahora (no bloquear
   el avance operativo a fotos/publicación desde esta skill).

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
5. Mantén `current_step=contract_pending`, `status=waiting_internal` y
   **termina tu turno**. Esta espera es interna: el inmobiliario revisa y
   decide. El agente NO envía el contrato al dueño ni avanza el caso.

6. Decisión humana (HITL), la ejecuta la app — no el agente:
   - Si el inmobiliario elige **"Enviar por email"**, la app manda el
     contrato al `owner_email` del caso desde la cuenta **Gmail** conectada
     del asesor, registra los eventos
     (`contract_approved_for_email_send`, `reminder_sent`,
    `step_completed`) y avanza el caso a `current_step=photos_requested`.
   - Si elige **"Subir contrato corregido y enviar"**, la app espera el DOCX/PDF
     corregido, lo envía por email al propietario y avanza igual a
    `photos_requested`.
   - Requisitos del envío: que exista **Gmail conectado** (cuenta remitente del
     asesor, en Ajustes) y `owner_email` (destinatario) en el contexto del
     caso. Si falta `owner_email`, el dato se solicita por el HITL de datos
     contractuales, no por el agente desde aquí.

## Antipatrones

- Enviar el contrato al dueño desde el agente (por Telegram o email): el envío
  al propietario es una decisión humana (HITL) que ejecuta la app tras la
  aprobación del inmobiliario.
- Avanzar el caso a `photos_requested` desde el agente: ese avance lo hace la
  app cuando se confirma el envío por email.
- Mandar el contrato al dueño SIN aprobación previa del inmobiliario.
- Llenar campos del contrato con datos no verificados
  (`pricing_proposal.salida` debe estar `approved`).
- Usar `telegram_send_message_to_contact` para mandar el contrato (solo es
  válido para pedir documentos al dueño, p. ej. corregir titularidad).
