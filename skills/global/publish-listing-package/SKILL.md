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
  - easybroker_publish_listing
  - ungga_publish_listing
  - operational_case_update_state
  - operational_case_add_event
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Este es el último paso. Una vez completado, mover a status=completed.
  La orquestación de publicación es dueña del sistema (publication runner):
  el agente NO escribe `publication`, `published`, `publish_approvals` ni
  `photo_manifest` vía operational_case_update_state.
  Cada destino: aprobación de negocio → draft → media → preflight condicional
  → publish automático si pass; review humana solo si hay omisiones,
  discrepancias o baja confianza.
  EasyBroker: create(not_published) → upload images → publish_listing.
  Ungga: prepare_draft → (preflight) → publish_draft.
  Nunca publiques sin confirmar que `pricing_proposal.approval_status=approved`
  y que el contrato ya fue enviado por email al propietario.
  Nunca publiques sin `listing_description_approved`.
  No inventes image_titles desde visible_spaces; usa photo_manifest por archivo.
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
     `bedrooms`, `bathrooms`, `parking_spaces` y m2 (construcción o total).
     Para terreno/lote exige `area_total_m2`.
   Si falla algún gate, `notify_user` al inmobiliario explicando qué falta y
   `status=paused`.

2. **Análisis de imágenes**: llama `analyze_property_images` con
   `image_paths=context_jsonb.raw_photos` (todas; sin truncar a 8).
   Clasifica **por archivo** (path/sha256), no por índice del modelo.
   Persiste `context_jsonb.photo_analysis` (agregado para copy) y
   `context_jsonb.photo_manifest` 1:1. Si una foto falla al cargar, deja
   `uncertain=true` / `space_label=null` en esa entrada; no desplaces etiquetas.

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
   **Política anti-mobiliario movible (venta y renta):** no afirmes que la
   propiedad se entrega amueblada ni menciones sofás, camas, mesas, sillas,
   refrigerador, microondas, TV u otros objetos portátiles solo porque aparecen
   en fotos. Esas observaciones deben quedar en `photo_analysis.do_not_claim`,
   no en `copy_safe_phrases`. Excepción: solo si el asesor lo confirma de forma
   explícita en `property_data`, highlights, instrucciones de copy o feedback
   HITL (p. ej. «se renta amueblada», «incluye refrigerador»). Sí puedes
   mencionar elementos fijos verificables (cocina integral, clósets empotrados,
   canceles, A/C instalado). No preguntes de forma obligatoria si está amueblada
   en el intake.

5. **HITL de descripción**:
   - Envía `notify_user(kind=listing_description_review)` con borrador,
     información faltante relevante para el asesor. No expongas slugs técnicos.
   - Espera decisión explícita del asesor:
     `approved | request_changes`. Los cambios pueden incluir ajustes
     editoriales, puntos clave nuevos o texto exacto de reemplazo.
   - Si el asesor pide cambios, regenera el borrador con
     `prepare_listing_description_draft` usando
     `context_jsonb.listing_description_review.change_classification`,
     `context_jsonb.listing_highlights` y, si existe,
     `context_jsonb.listing_description_replacement_candidate`.
     Luego vuelve a enviar `notify_user(kind=listing_description_review)`.
   - Solo cuando exista `context_jsonb.listing_description_approved`
     puedes continuar a publicación.

6. **Watermark + manifest**: llama `image_watermark(case_id, input_paths=raw_photos)`.
   Persiste `watermarked_photos` y actualiza `photo_manifest` 1:1.
   `analyze_property_images` debe llenar `photo_manifest[].space_label` por archivo;
   nunca derives títulos desde `visible_spaces` agregados.

7. **Aprobación por destino (negocio)**:
   - Solicita aprobación one-by-one (EasyBroker, luego Ungga).
   - El publication runner persiste `context.publication` + proyecciones
     `publish_approvals` / `published`. No las escribas a mano.

8. **EasyBroker (dos pasos técnicos)**:
   - `easybroker_create_listing` → status `not_published` + listing_id.
     Colaboración se mapea desde `commission_terms.collaboration` en el
     adapter: `enabled` → `share_commission` aunque el % canónico (p. ej. 40)
     no sea representable; el detalle incompatible se omite con warning y
     **no** muta el canónico. `commission_terms.commission_pct` →
     `operations[].commission = { type: "percentage", value }`.
   - `easybroker_upload_images` con `case_id` + `listing_id`.
     El adapter aplica watermark solo si hay asset de marca y deriva pares
     desde `photo_manifest` (nunca inventes `upload_path`).
   - Preflight condicional (watermark/manifest/remoto): si pass →
     `easybroker_publish_listing`.
   - Si review_required → notificación `publication_review_required`.
   - Watermark: obligatorio solo cuando existe asset de marca; sin asset,
     sube originales.

9. **Ungga (dos fases)**:
   - Solo tras EasyBroker remotamente publicado u omisión explícita.
   - `ungga_publish_listing(action=prepare_draft, case_id)` — pasa **solo**
     `action` + `case_id` (omitir strings vacíos). El adapter enriquece título,
     precio, comisión e `image_urls` desde el caso / `photo_manifest`; **no**
     copies ni inventes URLs de fotos.
     `commission_pct` (desde el caso) llena **Comisión (%)** en el modal
     Operación; el % opcional al colaborador no se envía a Ungga.
   - Preflight condicional sobre el draft (GU-ID real, no dry-run).
   - Si pass → `ungga_publish_listing(action=publish_draft, ungga_property_id)`.
   - Timeout/kill → `unknown_outcome` (ledger + revisión); nunca auto-reintentar
     `prepare_draft`.
   - Nunca `publish_draft` sin GU-ID persistido.
   - Si `publish_draft` falla como `open_modal_guid_mismatch` o botón
     PUBLICAR deshabilitado (error `ungga_publish_button_disabled:*`), son
     fallos **pre-side-effect** (no se publicó nada): reintenta
     `ungga_publish_listing(action=publish_draft, ungga_property_id)` (retry
     seguro) o detente y espera revisión humana / reconciliación. **Nunca**
     intentes "arreglar" el estado con `operational_case_update_state` sobre
     `publication`/`published`/`publish_approvals`/`photo_manifest`: el runner
     los rechaza (`protected_context_keys`) y repetir ese update_state solo
     genera un loop.

   La orquestación entra **solo** por el publication runner
   (`requestPublicationProgress`) con modo explícito `off|shadow|active`
   (default `off`; precedencia de caso). Shadow calcula sin side effects.

10. **Paquete para portales sin API** (Inmuebles24, Vivanuncios):
   - Genera `context_jsonb.manual_publish_package` tras aprobación manual.
   - Notifica al inmobiliario; NO automatices con browser.

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
- Afirmar mobiliario/equipamiento movible por evidencia fotográfica sola
  (venta o renta) sin confirmación explícita del asesor.
- Inventar automatizaciones Playwright ad hoc contra portales externos
  (Inmuebles24, etc.). Excepciones soportadas con adaptadores oficiales,
  credenciales y guardrails: Ungga CLI (`ungga_publish_listing`) y EasyBroker
  MLS (`easybroker_search_listings` / `easybroker_search_closed_deals`). Ver
  docs/operational-cases/future-considerations.md sección 4.
- Marcar `completed` antes de tener al menos UN destino publicado o
  paquete manual entregado.
- Reintentar `operational_case_update_state` con claves protegidas
  (`publication`, `published`, `publish_approvals`, `photo_manifest`) tras un
  fallo de publicación. Reintenta la herramienta de publicación (retry seguro)
  o espera revisión humana; el runner es dueño de ese estado.
