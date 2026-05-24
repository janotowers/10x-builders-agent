---
name: perform-comparable-analysis
description: Construye un análisis de comparables (~3-8 propiedades) para una propiedad capturada, combinando EasyBroker (activas/publicadas y vendidas/rentadas como referencia histórica) con inventario interno publicado de BigQuery cuando esté disponible. Usado como sub-skill de property-optioning-coach durante el step `comparables_in_progress`.
scope: business
allowed_tools:
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
  BigQuery interno aporta inventario publicado / asking prices, NO precios de
  cierre, salvo que la tool indique explícitamente is_closed_price=true.
  Si alguna fuente devuelve status="not_configured" o error, reporta al
  inmobiliario y continúa con las fuentes disponibles.
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
  "internal_inventory": [
    {"source": "bigquery_internal_inventory", "id": "...", "price": 0, "price_basis": "asking_price", "url": "..."}
  ],
  "stats": {
    "active_count": 0,
    "historical_reference_count": 0,
    "internal_inventory_count": 0,
    "price": {
      "p25": 0,
      "p50": 0,
      "p75": 0,
      "sample_size": 0,
      "sources": []
    },
    "price_per_m2": {
      "available": false,
      "p25": null,
      "p50": null,
      "p75": null,
      "sample_size": 0,
      "sources": []
    }
  },
  "data_quality": {
    "usable_count": 0,
    "incomplete_count": 0,
    "warnings": []
  },
  "notes": "..."
}
```

## Workflow

1. Lee `context_jsonb.property_data` y arma `filters_used`:
   - `neighborhood = address.neighborhood`
   - `operation = property_data.operation`
   - `property_type = property_data.property_type`
   - `min_area_m2 = area_total_m2 * 0.7` si existe área confiable.
   - `max_area_m2 = area_total_m2 * 1.3` si existe área confiable.
   - `months_back = 12` (subir a 24 si los resultados < 5).

2. Llama:
   - `easybroker_search_listings(filters)` para activas/publicadas en el mercado
     actual.
   - `easybroker_search_closed_deals(filters)` para propiedades marcadas como
     vendidas/rentadas en EasyBroker. Úsalas como referencia histórica; no
     asumas que el precio expuesto es el precio final real de cierre salvo que
     la cuenta lo capture así.
   - `bigquery_lookup_local_comparables(filters)` para inventario interno
     publicado en BigQuery. Trátalo como `asking_price`, no como precio de
     cierre, salvo que la respuesta diga `is_closed_price=true`.

3. Si alguna devuelve `status: "not_configured"`:
   - Reporta al inmobiliario via `notify_user` qué fuente falla y qué necesita
     configurar (API key, tabla del warehouse, etc.).
   - Continúa con las fuentes que sí funcionaron; no bloquees el caso.

4. Normaliza los resultados al shape de arriba. Si una fuente trae área
   confiable, calcula `price_per_m2 = price / area_m2`; si no, usa precio
   publicado y conserva la limitación en `notes`. Filtra outliers sólo sobre
   métricas disponibles y guarda los buenos (~3-8).

5. Calcula o consolida `stats` en dos niveles:
   - `stats.price`: percentiles 25/50/75 sobre precio total publicado, usando
     filas `usable_as_comparable=true`.
   - `stats.price_per_m2`: percentiles 25/50/75 sobre precio/m² sólo cuando la
     fuente trae precio y área confiables. EasyBroker puede alimentar esta
     métrica; BigQuery interno no debe hacerlo hasta confirmar campo de área.
   No presentes precio/m² como métrica principal si
   `stats.price_per_m2.available=false` o `sample_size < 3`.

6. Guarda en `context_jsonb.comparables_analysis` y mueve el caso a
   `current_step=price_proposal_pending`, `status=active`,
   `next_action_at=now()`.

7. Notifica al inmobiliario:
   `notify_user("Análisis de comparables listo para [propiedad]. N activas, M referencias históricas y K internas. Mediana de precio publicado: $X. Reviso contigo el precio.")`.

## Antipatrones

- Mezclar venta y renta en la misma muestra.
- Promediar `price` cuando varían mucho los m² si sí existe área confiable; en
  ese caso usa `price_per_m2`.
- Presentar inventario interno de BigQuery como cierres reales si la respuesta
  dice `is_closed_price=false`.
- Quedarte con 0-1 comparables y aún así reportar; mejor reporta "datos
  insuficientes en esta zona, necesitamos ampliar criterios" y pide
  decisión.
