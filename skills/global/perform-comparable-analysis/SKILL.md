---
name: perform-comparable-analysis
description: Construye un análisis de comparables (~3-8 propiedades) para una propiedad capturada, combinando EasyBroker (activas/publicadas y vendidas/rentadas como referencia histórica) con la base de operaciones cerradas en BigQuery. Usado como sub-skill de property-optioning-coach durante el step `comparables_in_progress`.
scope: business
allowed_tools:
  - bigquery_run_query
  - bigquery_lookup_local_comparables
  - easybroker_search_listings
  - easybroker_search_closed_deals
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Usa SIEMPRE la zona/colonia, operación y rango de m² del
  context_jsonb.property_data como filtros base. No metas comparables de
  otra colonia "porque hay más datos".
  El humano DEBE elegir cuáles comparables van al precio final (HITL en la
  sub-skill prepare-listing-price). Tu job aquí es entregar un set
  defendible, no decidir.
  Si los stubs (bigquery_lookup_local_comparables / easybroker_*) devuelven
  status="not_configured" o "stub", reporta al inmobiliario y pídele
  alternativa (consulta manual, datos cargados al case context, etc.).
---

# Perform comparable analysis

## Objetivo

Producir un objeto `context_jsonb.comparables_analysis`:

```json
{
  "filters_used": {
    "neighborhood": "...",
    "operation": "sale",
    "property_type": "departamento",
    "min_area_m2": 60,
    "max_area_m2": 90,
    "months_back": 12
  },
  "active_listings": [
    {"source": "easybroker", "id": "...", "price": 0, "area_m2": 0, "price_per_m2": 0, "url": "..."}
  ],
  "closed_deals": [
    {"source": "bigquery", "id": "...", "price": 0, "area_m2": 0, "price_per_m2": 0, "closed_at": "..."}
  ],
  "stats": {
    "active_count": 0,
    "closed_count": 0,
    "p25_price_per_m2": 0,
    "p50_price_per_m2": 0,
    "p75_price_per_m2": 0,
    "median_dom_days": 0
  },
  "notes": "..."
}
```

## Workflow

1. Lee `context_jsonb.property_data` y arma `filters_used`:
   - `neighborhood = address.neighborhood`
   - `operation = property_data.operation`
   - `property_type = property_data.property_type`
   - `min_area_m2 = area_total_m2 * 0.7`
   - `max_area_m2 = area_total_m2 * 1.3`
   - `months_back = 12` (subir a 24 si los resultados < 5).

2. Llama:
   - `easybroker_search_listings(filters)` para activas/publicadas en el mercado
     actual.
   - `easybroker_search_closed_deals(filters)` para propiedades marcadas como
     vendidas/rentadas en EasyBroker. Úsalas como referencia histórica; no
     asumas que el precio expuesto es el precio final real de cierre salvo que
     la cuenta lo capture así.
   - `bigquery_lookup_local_comparables(filters)` para warehouse propio y
     precios reales internos cuando exista esa fuente confiable.

3. Si alguna devuelve `status: "not_configured"`:
   - Reporta al inmobiliario via `notify_user` qué fuente falla y qué necesita
     configurar (API key, tabla del warehouse, etc.).
   - Continúa con las fuentes que sí funcionaron; no bloquees el caso.

4. Normaliza los resultados al shape de arriba (calcula `price_per_m2 =
   price / area_m2`). Filtra outliers (precio_per_m2 fuera del rango
   p10-p90) y guarda los buenos (~3-8).

5. Calcula `stats` con percentiles 25/50/75 sobre `price_per_m2` de los
   filtrados.

6. Guarda en `context_jsonb.comparables_analysis` y mueve el caso a
   `current_step=price_proposal_pending`, `status=active`,
   `next_action_at=now()`.

7. Notifica al inmobiliario:
   `notify_user("Análisis de comparables listo para [propiedad]. N activas, M cerradas. Mediana p/m²: $X. Reviso contigo el precio.")`.

## Antipatrones

- Mezclar venta y renta en la misma muestra.
- Promediar `price` cuando varían mucho los m² (usa siempre `price_per_m2`).
- Quedarte con 0-1 comparables y aún así reportar; mejor reporta "datos
  insuficientes en esta zona, necesitamos ampliar criterios" y pide
  decisión.
