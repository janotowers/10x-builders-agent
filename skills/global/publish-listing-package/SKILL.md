---
name: publish-listing-package
description: Ensambla el paquete final de publicación (fotos con marca de agua, descripción optimizada, datos canónicos) y publica donde haya API (EasyBroker, Ungga). Para portales sin API (Inmuebles24 etc.) entrega un paquete listo para subida manual. Usado como sub-skill de property-optioning-coach durante el step `package_ready`.
scope: business
allowed_tools:
  - analyze_property_images
  - lookup_property_surroundings
  - prepare_listing_description_draft
  - notify_user
  - image_watermark
  - easybroker_create_listing
  - easybroker_upload_images
  - ungga_publish_listing
  - operational_case_update_state
  - operational_case_add_event
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Este es el último paso. Una vez completado, mover a status=completed.
  Cada publicación externa pasa por doble control:
  (1) aprobación de negocio por destino (`publish_approvals`) y
  (2) confirmación técnica HITL de la tool write.
  No uses una sola aprobación para todos los destinos.
  Nunca publiques sin confirmar que `pricing_proposal.approval_status=approved`
  y que el contrato ya fue enviado por email al propietario
  (`context_jsonb.contract_review.status=sent_by_email` o evento
  `step_completed(kind: contract_sent_to_owner_email)` en timeline).
  Nunca publiques sin `listing_description_approved`.
  Para portales sin API, NO automatices con browser; entrega el paquete
  formateado y pide al inmobiliario que suba manualmente.
---

# Publish listing package

## Objetivo

Producir y entregar:

1. Fotos finales (marcadas con watermark del tenant).
2. Descripción comercial aprobada por el asesor.
3. Datos canónicos para upload (precio, ubicación, atributos).
4. Publicación efectiva en EasyBroker y Ungga (con aprobación por destino).
5. Paquete "listo para upload manual" para portales sin API.

## Workflow

1. **Preflight**: verifica gates legales/comerciales:
   - `context_jsonb.pricing_proposal.approval_status === "approved"`.
   - Existe evidencia de contrato enviado por email al propietario:
     `context_jsonb.contract_review.status === "sent_by_email"` **o**
     evento `step_completed(kind=contract_sent_to_owner_email)` en timeline.
   - `context_jsonb.raw_photos[].length >= 5`.
   - Campos mínimos de ficha EasyBroker: `property_type`, `operation_type`,
     `target_price > 0`, `currency`, dirección usable (`municipality`, `state`
     y calle o dirección legal). Para casa/departamento exige también
     `bedrooms`, `bathrooms`, `parking_spots` y m2 (construcción o total).
     Para terreno/lote exige `area_total_m2`.
   Si falla algún gate, `notify_user` al inmobiliario explicando qué falta y
   `status=paused`.

2. **Análisis de imágenes**: llama `analyze_property_images` con
   `image_paths=context_jsonb.raw_photos` y persiste en
   `context_jsonb.photo_analysis`.
   - Regla crítica: "no visible" no implica "no existe".
   - Expresa cobertura visual como evidencia, no como verdad absoluta.

3. **Enriquecer entorno**: llama `lookup_property_surroundings` usando
   dirección/coordenadas de `property_data` y persiste en
   `context_jsonb.zone_context`.
   - Usa solo POIs verificables con fuente.

4. **Borrador de descripción comercial**: llama `prepare_listing_description_draft`.
   Persiste:
   - `context_jsonb.listing_copy_ingredients`
   - `context_jsonb.listing_description_draft`
   - (opcional) `context_jsonb.listing_highlights`
   Usa solo ingredientes verificados: `property_data`, `photo_analysis`,
   `zone_context` y highlights del asesor. No inventes amenidades ni cercanías.

5. **HITL de descripción**:
   - Envía `notify_user(kind=listing_description_review)` con borrador,
     ingredientes usados y faltantes.
   - Espera decisión explícita del asesor:
     `approved | request_changes | add_highlights`.
   - Solo cuando exista `context_jsonb.listing_description_approved`
     puedes continuar a publicación.

6. **Watermark**: llama `image_watermark` con `input_paths=context_jsonb.raw_photos`,
   posición y opacidad por defecto del tenant. Persiste outputs en
   `context_jsonb.watermarked_photos`.

7. **Aprobación por destino (negocio)**:
   - Solicita y persiste aprobación por destino en
     `context_jsonb.publish_approvals`:
     - `easybroker`: approved/pending/skipped/rejected
     - `ungga`: approved/pending/skipped/rejected
     - `manual`: approved/pending/skipped/rejected
   - No publiques en un destino si su estado no es `approved`.

8. **Publicar en EasyBroker**:
   - Solo cuando `publish_approvals.easybroker=approved`, llama
     `easybroker_create_listing(...)` con `listing_description_approved`.
     Captura el `listing_id` retornado en
     `context_jsonb.published.easybroker.listing_id`.
   - Llama `easybroker_upload_images(listing_id, image_paths=watermarked_photos)`.
   - Inserta `operational_case_add_event(step_completed, payload={destination: "easybroker", listing_id})`.

9. **Publicar en Ungga**:
   - Si la tool `ungga_publish_listing` devuelve `status=not_configured`,
     notifica al inmobiliario y deja `published.ungga = "pending_manual"`.
   - Si devuelve OK, persiste `ungga_listing_id`.

10. **Paquete para portales sin API** (Inmuebles24, Vivanuncios):
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

11. Mueve `status=completed`, `current_step=published`. Inserta
   `operational_case_add_event(step_completed, payload={kind: case_completed})`.

12. Notifica al inmobiliario con
   `notify_user(kind=listing_published_summary)`: resumen del caso completado,
   links a publicaciones y estado del paquete manual. Este cierre es
   idempotente; si ya se envió, no se duplica.

## Antipatrones

- Saltar el preflight y publicar antes de tener contrato firmado.
- Publicar en todos los destinos con una sola aprobación ("¿publico en todos?").
  Cada destino merece confirmación específica.
- Publicar sin `listing_description_approved`.
- Automatizar con Playwright contra portales externos (ver
  docs/operational-cases/future-considerations.md sección 4).
- Marcar `completed` antes de tener al menos UN destino publicado o
  paquete manual entregado.
