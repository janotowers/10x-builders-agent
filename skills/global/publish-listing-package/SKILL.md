---
name: publish-listing-package
description: Ensambla el paquete final de publicación (fotos con marca de agua, descripción optimizada, datos canónicos) y publica donde haya API (EasyBroker, Ungga). Para portales sin API (Inmuebles24 etc.) entrega un paquete listo para subida manual. Usado como sub-skill de property-optioning-coach durante el step `package_ready`.
scope: business
allowed_tools:
  - image_watermark
  - easybroker_create_listing
  - easybroker_upload_images
  - ungga_publish_listing
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - generate_document_from_template
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Este es el último paso. Una vez completado, mover a status=completed.
  Cada PUBLICACIÓN externa (easybroker_create_listing, ungga_publish_listing)
  pasa por HITL: el inmobiliario aprueba "publicar en X" antes de cada
  destino, no en bloque.
  Nunca publiques sin confirmar que `pricing_proposal.approval_status=approved`
  y que el contrato ya fue enviado por email al propietario
  (`context_jsonb.contract_review.status=sent_by_email` o evento
  `step_completed(kind: contract_sent_to_owner_email)` en timeline).
  Para portales sin API, NO automatices con browser; entrega el paquete
  formateado y pide al inmobiliario que suba manualmente.
---

# Publish listing package

## Objetivo

Producir y entregar:

1. Fotos finales (marcadas con watermark del tenant).
2. Descripción comercial (markdown / DOCX).
3. Datos canónicos para upload (precio, ubicación, atributos).
4. Publicación efectiva en EasyBroker y Ungga (con HITL por destino).
5. Paquete "listo para upload manual" para portales sin API.

## Workflow

1. **Preflight**: verifica gates legales/comerciales:
   - `context_jsonb.pricing_proposal.approval_status === "approved"`.
   - Existe evidencia de contrato enviado por email al propietario:
     `context_jsonb.contract_review.status === "sent_by_email"` **o**
     evento `step_completed(kind=contract_sent_to_owner_email)` en timeline.
   - `context_jsonb.raw_photos[].length >= 5`.
   Si falla algún gate, `notify_user` al inmobiliario explicando qué falta y
   `status=paused`.

2. **Watermark**: llama `image_watermark` con `input_paths=context_jsonb.raw_photos`,
   posición y opacidad por defecto del tenant. Persiste outputs en
   `context_jsonb.watermarked_photos`.

3. **Descripción comercial**: llama `generate_document_from_template`
   con `template_slug=listing_description, format=docx, data=...`. Si la
   plantilla no está, genera la descripción inline en markdown y persístela
   en `context_jsonb.listing_description_md`.

4. **HITL: publicar en EasyBroker**:
   - Notifica al inmobiliario con un resumen completo del paquete.
   - Cuando confirma, llama `easybroker_create_listing(...)`. Captura el
     `listing_id` retornado en `context_jsonb.published.easybroker.listing_id`.
   - Llama `easybroker_upload_images(listing_id, image_paths=watermarked_photos)`.
   - Inserta `operational_case_add_event(step_completed, payload={destination: "easybroker", listing_id})`.

5. **HITL: publicar en Ungga**:
   - Si la tool `ungga_publish_listing` devuelve `status=not_configured`,
     notifica al inmobiliario y deja `published.ungga = "pending_manual"`.
   - Si devuelve OK, persiste `ungga_listing_id`.

6. **Paquete para portales sin API** (Inmuebles24, Vivanuncios):
   - Genera `context_jsonb.manual_publish_package`:
     ```json
     {
       "headline": "...",
       "description": "...",
       "price": 0,
       "currency": "MXN",
       "address_summary": "...",
       "image_paths_zip": "..."
     }
     ```
   - Notifica al inmobiliario con instrucciones claras de cómo subir
     manualmente; NO intentes automatizar con browser.

7. Mueve `status=completed`, `current_step=published`. Inserta
   `operational_case_add_event(step_completed, payload={kind: case_completed})`.

8. Notifica al inmobiliario: resumen del caso completado, links a las
   publicaciones, paquete manual adjunto.

## Antipatrones

- Saltar el preflight y publicar antes de tener contrato firmado.
- Publicar en todos los destinos en una sola aprobación HITL ("¿publico
  en todos?"); cada destino merece confirmación específica.
- Automatizar con Playwright contra portales externos (ver
  docs/operational-cases/future-considerations.md sección 4).
- Marcar `completed` antes de tener al menos UN destino publicado o
  paquete manual entregado.
