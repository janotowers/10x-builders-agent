# EasyBroker MLS CLI POC

POC Playwright para buscar propiedades en la bolsa inmobiliaria de EasyBroker:

`https://www.easybroker.com/agent/mls_properties`

## Uso

Crear `.env` local:

```env
EASYBROKER_WEB_URL=https://www.easybroker.com/mx/account/authentication/new
EASYBROKER_WEB_EMAIL=usuario@agencia.com
EASYBROKER_WEB_PASSWORD=...
EASYBROKER_MLS_HEADLESS=true
```

`EASYBROKER_WEB_URL` es opcional; Gu OS usa por default la URL fija de login
de EasyBroker México y después abre `/agent/mls_properties`.

Ejecutar:

```bash
npm --prefix pocs/easybroker-mls-cli run poc:search -- input.json
```

El CLI imprime JSON normalizado con:

- `mode`: `listings` o `closed_deals`
- `result.results[]`: cards normalizadas
- `result.status_filter`: `{ requested, applied, verified, selected_label }`
- `result.filters[]`: traza de filtros aplicados **después** de la verificación
  final (p. ej. `status:Solo cerradas` o `status:unverified`). El token de
  estatus se deriva del `status_filter` final, no de un snapshot intermedio
  previo al sync de URL.
- `metrics[]`: login, apertura MLS, búsqueda/extracción, `apply_status_filter`

## Filtros soportados

Los filtros son opcionales; el CLI sólo aplica los que recibe.

```json
{
  "mode": "listings",
  "zona": "Colomos Providencia, Guadalajara, Jalisco",
  "operation": "rent",
  "property_types": ["Casa", "Departamento"],
  "min_price": 18000,
  "max_price": 24000,
  "bedrooms": 2,
  "min_bathrooms": 2,
  "shared_commission_only": true,
  "limit": 50
}
```

- Valuación/comparables (flujo Gu OS): zona, operación, tipo y banda de m².
  Aliases como `house` se canonicalizan a `Casa` antes del click UI.
- `bedrooms`, `bathrooms`, `parking_spaces`: valor exacto. Útiles para
  **búsqueda de opciones** (comprador/rentador), no para valuación.
- `min_bedrooms`, `min_bathrooms`, `min_parking_spaces`: al menos ese valor.
- `shared_commission_only`: si es `true`, intenta activar el filtro de comisión
  compartida en `Más`.
- `mode: "closed_deals"`: aplica y **verifica** `Estatus = Solo cerradas`.
  Si no puede verificar el filtro, el CLI/adapter devuelve
  `status_filter_not_applied` / `filter_not_applied` con `results: []`
  (nunca etiqueta activas como históricas).

## reCAPTCHA / anti-bot

EasyBroker bloquea `chromium` headless con 403/reCAPTCHA. Para evitarlo se usa
una sesión persistente:

```bash
npm --prefix pocs/easybroker-mls-cli run poc:login:assisted
```

Eso abre Chromium visible; haces login manualmente (resolviendo el reCAPTCHA si
aparece) y al llegar a `/agent/mls_properties` se guarda automáticamente
`storage-state.json`. Después, las búsquedas y el `Probar conexión` reutilizan
esa sesión. Si el storage state existe pero ya no abre MLS, el CLI intenta
fallback con `EASYBROKER_WEB_EMAIL` / `EASYBROKER_WEB_PASSWORD` y vuelve a
guardar la sesión si el login funciona.

Para apuntar a otra ruta, exporta `EASYBROKER_MLS_STORAGE_STATE=/ruta/a/state.json`.

## Tests

```bash
npm --prefix pocs/easybroker-mls-cli run test:status-filter
```
