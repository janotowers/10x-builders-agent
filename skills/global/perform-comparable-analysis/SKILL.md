---
name: perform-comparable-analysis
description: Construye un análisis de comparables (~3-8 propiedades) para una propiedad capturada, combinando EasyBroker (activas/publicadas y vendidas/rentadas como referencia histórica) con inventario interno publicado de BigQuery cuando esté disponible. Usado como sub-skill de property-optioning-coach durante el step `comparables_in_progress`.
scope: business
allowed_tools:
  - geocode_property_address
  - bigquery_lookup_local_comparables
  - easybroker_search_listings
  - easybroker_search_closed_deals
  - get_avaclick_valuation
  - operational_case_persist_comparables_analysis
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
  En este step NO abras conversación para pedir faltantes de Avaclick. Si faltan
  mínimos, registra warning y continúa con las demás fuentes.
  Si alguna fuente devuelve status="not_configured" o error, reporta al
  inmobiliario y continúa con las fuentes disponibles.
  Si EasyBroker devuelve status="needs_manual_login" (sesión web expirada o
  CAPTCHA/MFA tras los reintentos automáticos), trátalo como estado recuperable:
  continúa con las demás fuentes. La notificación `integration_reconnect` se usa
  como CTA fuerte sólo cuando no hay muestra defendible total; si sí hay muestra
  defendible, usa aviso no bloqueante y avanza.
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

2. Llama (siempre con **objeto plano de argumentos**, sin anidar en `filters: {...}`):
   - `easybroker_search_listings({...filters})` para activas/publicadas en el mercado
     actual.
   - `easybroker_search_closed_deals({...filters})` para propiedades marcadas como
     vendidas/rentadas en EasyBroker. Úsalas como referencia histórica; no
     asumas que el precio expuesto es el precio final real de cierre salvo que
     la cuenta lo capture así.
  - `get_avaclick_valuation({...})` para opinión digital externa de valor cuando
    `property_type` sea casa/departamento en condominio.
    - En ese tipo compatible, la llamada es esperada en este paso (no la
      omitas silenciosamente): ejecútala antes de persistir comparables.
    - Si faltan lat/lng, resuelve primero `geocode_property_address` con la
      dirección canónica del inmueble (boleta/predial/intake).
    - Si Avaclick devuelve `status="geocode_unresolved"`, NO trates eso como
      fallo del proveedor: deja warning de geocoding y continúa con EasyBroker/BigQuery.
    - Si el tipo no es compatible o la cuenta no está configurada, continúa con
      las demás fuentes.
   - `bigquery_lookup_local_comparables({...filters})` para inventario interno
     publicado en BigQuery. Trátalo como `asking_price`, no como precio de
     cierre, salvo que la respuesta diga `is_closed_price=true`.

   Antes de ejecutar búsquedas, valida que `property_data.area_construida_m2` sea
   confiable para tipo `casa/departamento`:
   - si detectas valor implausible (ej. corrimiento decimal sospechado) y no hay
     corroboración documental clara, NO sigas como si fuera dato válido.
   - deja el caso en `comparables_in_progress` + `waiting_internal` y notifica
     `notify_user(kind="property_data_quality_review")` para confirmación humana.

3. Usa filtros canónicos del contrato determinístico (runtime), no placeholders:
   - No envíes `0` en `min_area_m2`, `max_area_m2`, `min_price`, `max_price`,
     `parking_spaces` como “default”.
   - Con `area_construida_m2` confiable, el primer intento debe usar banda
     canónica estricta (±15%, mínimo absoluto 20 m²), aunque el modelo proponga
     otro rango.
   - Si faltan rangos, reintenta con los filtros derivados desde `property_data`
     (banda inicial ±15%, mínimo 20 m²; fallback automático ±25% antes de pedir decisión).

4. Si alguna devuelve `status: "not_configured"` o `status: "validation_error"` por
   faltantes mínimos:
   - Reporta al inmobiliario via `notify_user` qué fuente falla y qué necesita
     configurar (API key, tabla del warehouse, etc.).
   - Continúa con las fuentes que sí funcionaron; no bloquees el caso.

   Si EasyBroker devuelve `status: "needs_manual_login"` (la sesión web expiró o
   EasyBroker pidió CAPTCHA/MFA aun después de los reintentos automáticos del
   adapter):
   - Es un estado **recuperable**, no un error técnico. Continúa con BigQuery/Avaclick.
   - Revisa `assisted_login` en el `result_json` para saber si el login asistido se
     intentó o se omitió (y por qué). Si `attempted=false`, sigue la razón/hint.
   - No decidas severidad todavía; persiste primero y decide con base en
     `defensible_sample` / `usable_count`.
   - Tras persistir, `operational_case_persist_comparables_analysis` reflejará
     `data_quality.needs_user_reauth=true` y `data_quality.integration_issues`.

5. No escribas `comparables_analysis` manualmente. Después de ejecutar las tres
   búsquedas, llama `operational_case_persist_comparables_analysis`. Esa tool
   construye el artefacto determinísticamente desde los `tool_calls` del turno:
   deduplica resultados, normaliza listas, calcula `stats`, `price`,
   `price_per_m2` y `data_quality.usable_count`.

6. Lee el resultado de `operational_case_persist_comparables_analysis`
   (`defensible_sample`, `usable_count`, `stats`, `data_quality`) para decidir
   el siguiente estado.

7. La tool ya guarda `context_jsonb.comparables_analysis` (incluye
   `data_quality.usable_count` contando usables de **todas** las fuentes:
   EasyBroker activas, EasyBroker cerradas/referencia histórica e inventario
   BigQuery).

   - Si `usable_count > 0` (muestra defendible): usa la ruta determinística
     (`operational_case_persist_comparables_analysis` + invariantes post-agent).
     No uses `operational_case_update_state` para saltar directo a
     `price_proposal_pending`.
   - Si `usable_count === 0` en **todas** las fuentes: **no** avances a
     `price_proposal_pending`. Deja `current_step=comparables_in_progress`,
     `status=waiting_internal` y pasa al paso 7 (notificación de datos
     insuficientes).

8. Notifica al inmobiliario:
   - Con muestra defendible:
     - No envíes resumen libre de comparables ni `kind=comparables_analysis` cuando
       ya exista `pricing_proposal`.
     - Usa el mensaje canónico de `price_approval` (con `salida/ideal/mínimo`,
       desglose por fuente, **Contraste Avaclick** informativo y **Advertencia**
       sólo si `data_quality.source_conflict` ≥30%) para abrir la decisión humana del precio.
     - `source_conflict` compara la mediana de mercado por m² y el **total implícito**
       del sujeto (p50 × m²) contra Avaclick — no la mediana de precio total de comparables más grandes.
   - Sin comparables usables con `data_quality.search_validity="insufficient_market_data"`:
    si el caso quedará en `waiting_internal`, pide decisión concreta con
    `notify_user(kind="comparables_search_expansion_decision")` y opciones
    accionables dentro del flujo. Usa `comparables_insufficient_data` solo para
    resumen informativo no bloqueante.
  - Si `data_quality.search_validity="invalid_filters"`:
    no uses `comparables_insufficient_data`; corrige y reintenta búsqueda con filtros canónicos.
  - Si Avaclick falla por cuota/no recuperable:
    no levantes `property_data_quality_review` (ese kind es solo para m² predial).
    Persiste comparables con warning de integración y continúa con fuentes de mercado.
  - Si se requiere decisión humana para ampliar más allá del fallback moderado:
    usa `notify_user(kind="comparables_search_expansion_decision")` con pregunta resoluble
    dentro del flujo (ej. ampliar a ±35% o colonias adyacentes).
     - Si `data_quality.needs_user_reauth=true`, usa
       `notify_user(kind="integration_reconnect")` con CTA claro:
       reconectar EasyBroker MLS en **Credenciales API → "Probar conexión"** y luego
       reintentar comparables.

## Pruebas en Preparación operativa (N3 / N4)

En Ajustes → **Paso 3 · Análisis de comparables** (`comparables_in_progress`):

| Nivel | Acción | Escenario |
|-------|--------|-----------|
| N1 | Probar cada tool de integración (EB activas, EB cerradas, BQ) | Recetas del catálogo; pill **Probada** por tool |
| N3 | **Probar habilidad** (`perform-comparable-analysis`) | **Análisis completo y avance a precio** — `usable_count > 0`, persistencia determinística, avance a `price_proposal_pending` |
| N3 | Misma habilidad | **Sin comparables usables — no avanzar a precio** — permanece en paso + `waiting_internal` + `notify_user` |
| N4 | **Probar paso** (habilidad raíz) | Mismos escenarios; valida cierre del hito, no sustituye N3 |

Si N1 está en verde pero el pill del paso dice **Falló N3/N4**, revisa el panel del último run (tools faltantes, `persist` sin ejecutar, transición bloqueada por gate). Ver `PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE` y [`testing-framework.md`](../../docs/operational-cases/testing-framework.md) §7.

## Antipatrones

- Mezclar venta y renta en la misma muestra.
- Promediar `price` cuando varían mucho los m² si sí existe área confiable; en
  ese caso usa `price_per_m2`.
- Presentar inventario interno de BigQuery como cierres reales si la respuesta
  dice `is_closed_price=false`.
- Quedarte con 0 comparables usables (en ninguna fuente) y aún así avanzar a
  `price_proposal_pending`; reporta "datos insuficientes", permanece en
  `comparables_in_progress` y pide decisión al asesor interno.
- Usar una colonia distinta a `property_data` / `property_zone` del caso solo
  porque hay más listados en otra zona.
