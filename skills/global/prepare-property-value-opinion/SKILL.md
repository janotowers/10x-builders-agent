---
name: prepare-property-value-opinion
description: |
  Obtiene una opinión digital de valor para una propiedad (venta/renta) usando Avaclick.
  Úsala cuando el usuario pida "avalúo", "opinión de valor", "cuánto vale esta propiedad"
  o equivalente en chat web/Telegram, con datos en texto o ficha técnica.
scope: business
allowed_tools:
  - geocode_property_address
  - get_avaclick_valuation
  - notify_user
  - operational_case_extract_document_fields
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  No llames get_avaclick_valuation hasta cumplir mínimos funcionales
  (coordenadas válidas, calle, m² construcción, y para casa/casa-condominio m² terreno,
  además de al menos una característica).
  No pidas latitud/longitud al usuario como primer recurso; usa geocoding interno.
  Si faltan datos, pregunta en bloques cortos (máx. 4 preguntas) con lenguaje comercial.
  Siempre incluye disclaimer: opinión digital de valor, no avalúo legal/fiscal/bancario.
---

# Prepare property value opinion

## Objetivo

Entregar al inmobiliario una opinión digital de valor usable para decisión comercial
sin exigirle campos técnicos innecesarios (como lat/lng manuales).

## Workflow recomendado

1. Identifica si el usuario ya compartió datos estructurados (texto/ficha técnica).
2. Si faltan componentes de dirección, pide los mínimos conversacionales:
   - calle y número aproximado,
   - colonia,
   - municipio/estado,
   - CP (si lo tiene).
3. Resuelve coordenadas con `geocode_property_address`.
   - Si `status="ambiguous"`, pide aclaración con opciones concretas.
4. Reúne mínimos de valuación:
   - `property_type`,
   - `construction_area_m2`,
   - `land_area_m2` para `house`/`condo_house`,
   - al menos una característica (edad, baños, recámaras, etc.).
5. Ejecuta `get_avaclick_valuation`.
6. Devuelve resultado con:
   - rango y promedio de venta/renta,
   - warning/disclaimer regulatorio,
   - próximos pasos sugeridos (comparables, validación interna, precio de salida).

## Estilo de preguntas al usuario

- Máximo 4 preguntas por turno.
- Prioriza datos con mayor impacto en éxito de API:
  1) ubicación geocodificable,
  2) m² construcción/terreno,
  3) tipo de inmueble,
  4) una característica mínima.
