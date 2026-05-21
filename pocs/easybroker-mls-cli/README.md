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
- `metrics[]`: login, apertura MLS, búsqueda/extracción

Nota: `closed_deals` sólo debe tratarse como cerrado histórico si la UI MLS
expone filtros/estados de vendida/rentada/cerrada. Si no, el adapter devuelve
caveat explícito.

## reCAPTCHA / anti-bot

EasyBroker bloquea `chromium` headless con 403/reCAPTCHA. Para evitarlo se usa
una sesión persistente:

```bash
npm --prefix pocs/easybroker-mls-cli run poc:login:assisted
```

Eso abre Chromium visible; haces login manualmente (resolviendo el reCAPTCHA si
aparece) y al llegar a `/agent/mls_properties` se guarda automáticamente
`storage-state.json`. Después, las búsquedas y el `Probar conexión` reutilizan
esa sesión.

Para apuntar a otra ruta, exporta `EASYBROKER_MLS_STORAGE_STATE=/ruta/a/state.json`.
