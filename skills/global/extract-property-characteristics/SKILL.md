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
   una página o usar visión directa.
   Usa esos datos como fuente, no como verdad absoluta.
3. Calcula los campos faltantes contra el shape canónico de arriba.
4. Si quedan **campos críticos** sin responder
   (operation, property_type, address.{street, neighborhood, city},
   area_total_m2, bedrooms, bathrooms):
   - Compón un mensaje al dueño con **máximo 4 preguntas** específicas, en
     formato bullet o numerado para fácil lectura.
   - `telegram_send_message_to_contact` con
     `purpose=characteristics_pending`.
   - Inserta `operational_case_add_event(reminder_sent)`.
   - Pon `status=waiting_external`, `next_action_at=now()+24h`.
5. Si llegó `external_response`:
   - Parsea las respuestas y mergea en `property_data`.
   - Si todos los críticos están llenos, llama `notify_user` con
     `kind="property_data_review"` y `status=waiting_internal` para que el
     asesor confirme/corrija antes de comparables.
   - Si aún faltan algunos críticos, repite paso 3 con los que faltan.
6. Sólo cuando exista confirmación interna de datos básicos, mueve
   `current_step=comparables_in_progress`, `status=active`, `next_action_at=now()`.

## Buenas prácticas de redacción de preguntas

- Una unidad por pregunta (no "¿cuántos baños y estacionamientos?").
- Usa lenguaje del dueño, no jerga inmobiliaria
  ("¿Cuántas recámaras tiene?" mejor que "¿Cuántas habitaciones nominales?").
- Si tienes `address.neighborhood`, no preguntes ciudad/estado de nuevo;
  asume y confirma al final con un resumen ("Entonces es en La Roma,
  CDMX, ¿correcto?").
