---
name: extract-property-characteristics
description: Captura las características estructuradas de una propiedad (tipo, m², recámaras, baños, estacionamientos, ubicación, amenidades) preguntando al dueño por Telegram solo lo que falta. Usado como sub-skill de property-optioning-coach durante el step `documents_received`.
scope: business
allowed_tools:
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
  - operational_case_list_documents
  - operational_case_extract_document_fields
  - telegram_send_message_to_contact
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Pregunta SOLO lo que aún no esté en `context_jsonb.property_data`. No
  repitas datos que ya proporcionó el dueño.
  Mensajes al externo SIEMPRE cortos (≤ 4 preguntas por mensaje) para no
  saturar.
  Antes de pasar a comparables, solicita validación interna del inmobiliario
  con `notify_user(kind="property_data_review")`. No avances si hay conflicto
  evidente entre intake, documentos y respuesta del dueño.
---

# Extract property characteristics

## Objetivo

Llenar `context_jsonb.property_data` con un objeto canónico:

```json
{
  "operation": "sale" | "rent",
  "property_type": "casa" | "departamento" | "terreno" | "...",
  "address": {
    "street": "...",
    "exterior_number": "...",
    "interior_number": "...",
    "neighborhood": "...",
    "city": "...",
    "state": "...",
    "country": "MX",
    "postal_code": "...",
    "latitude": 0,
    "longitude": 0
  },
  "area_total_m2": 0,
  "area_construida_m2": 0,
  "bedrooms": 0,
  "bathrooms": 0,
  "half_bathrooms": 0,
  "parking_spots": 0,
  "year_built": 0,
  "amenities": ["alberca", "gimnasio", "..."],
  "current_state": "habitable" | "remodelar" | "obra_nueva",
  "owner_constraints": {
    "min_price_hint": 0,
    "preferred_close_date": "..."
  }
}
```

## Workflow

1. Lee `context_jsonb.property_data` (puede no existir; trata como `{}`) y
   lista documentos con `operational_case_list_documents`.
2. Para documentos relevantes (especialmente `escritura_descripcion`,
   `predial`, `boleta_registral`), corre
   `operational_case_extract_document_fields` si la extracción no existe. La
   tool acepta PDFs e imágenes y decide internamente si extraer texto, renderizar
   una página o usar visión directa. Usa **exactamente** el `id` UUID real
   devuelto por `operational_case_list_documents`; nunca uses placeholders como
   `<document_id>` ni IDs abreviados.
   Usa esos datos como fuente, no como verdad absoluta.
3. Consolida primero `context_jsonb.property_data` con los datos extraídos de
   documentos de propiedad (`escritura_descripcion`, `predial`,
   `boleta_registral`): titulares, dirección legal y superficie/metraje. No
   uses la dirección de IFE/comprobante de domicilio como dirección del
   inmueble salvo que el documento lo indique explícitamente.
4. Calcula los campos faltantes contra el shape canónico de arriba y la matriz
   mínima por tipo de inmueble.
5. Si quedan **campos mínimos** sin responder, pregunta al dueño antes de crear
   `property_data_review`.
   - Para todos los tipos: nombre(s) de dueño/titulares, dirección de la
     propiedad y superficie/metraje total.
   - Casa: m² de terreno/superficie, m² de construcción, número de
     plantas/pisos, recámaras, baños completos, medios baños y si tiene cocina
     integral.
   - Departamento: recámaras, baños completos, medios baños, cajones, piso,
     elevador sí/no y amenidades.
   - Terreno/lote: metraje m² y si está en coto/condominio/parque industrial o
     es independiente. NO preguntes recámaras, baños ni estacionamientos salvo
     que exista construcción.
   - Bodega/nave industrial: m² de bodega/nave, altura, m² de oficinas si
     aplica, baños, cajones/estacionamientos, KVA y transformador sí/no.
   - Compón un mensaje al dueño con **máximo 4 preguntas** específicas, en
     formato bullet o numerado para fácil lectura.
   - `telegram_send_message_to_contact` con
     `purpose=characteristics_pending`.
   - Si intentaste `notify_user(kind="property_data_review")` y la tool devolvió
     `property_data_minimums_missing`, usa exactamente
     `suggested_external_message` como texto al contacto externo. Ese mensaje ya
     separa datos conocidos y faltantes reales.
   - Inserta `operational_case_add_event(reminder_sent)`.
   - Pon `status=waiting_external`, `next_action_at=now()+24h`.
6. Si llegó `external_response`:
   - Parsea las respuestas y mergea en `property_data`.
   - Conserva como canónicos los campos ya confirmados en intake
     (`property_title`, `property_zone`, `operation_type`, `property_type`).
     Los documentos pueden aportar dirección legal, superficie, folio, titular,
     medidas y colindancias, pero no deben reemplazar `property_type="Terreno"`
     por etiquetas notariales como "Unidad Privativa" salvo que lo marques como
     conflicto/duda para revisión.
   - Si todos los críticos están llenos, llama `notify_user` con
     `kind="property_data_review"` y `status=waiting_internal` para que el
     asesor confirme/corrija antes de comparables.
   - El texto de `notify_user` DEBE ser accionable y auto-contenido: incluye
     un resumen compacto de lo extraído y un bloque de faltantes/advertencias.
     Formato recomendado:
     - "Datos confirmados por intake:" con `operation_type`, `property_type`,
       `property_zone` y `property_title`.
     - "Datos encontrados en documentos:" solo con información que venga de los
       documentos o sus extracciones (dirección legal, `area_total_m2`,
       titular/folio/predial, etc.). No repitas tipo/operación/zona aquí si
       solo vienen del intake.
     - Para terrenos/lotes, recámaras, baños y estacionamientos son "No aplica"
       salvo que exista construcción; no los trates como faltantes críticos.
     - "Faltantes o dudas:" con bullets (o "ninguno").
     - Cierre: "Confirma si es correcto o indícame correcciones puntuales."
   - Si aún faltan algunos críticos, repite paso 3 con los que faltan.
7. Sólo cuando exista confirmación interna de datos básicos, mueve
   `current_step=comparables_in_progress`, `status=active`, `next_action_at=now()`.

## Buenas prácticas de redacción de preguntas

- Una unidad por pregunta (no "¿cuántos baños y estacionamientos?").
- Usa lenguaje del dueño, no jerga inmobiliaria
  ("¿Cuántas recámaras tiene?" mejor que "¿Cuántas habitaciones nominales?").
- Si tienes `address.neighborhood`, no preguntes ciudad/estado de nuevo;
  asume y confirma al final con un resumen ("Entonces es en La Roma,
  CDMX, ¿correcto?").
