# POCs (proof of concept)

Utilidades y experimentos fuera del runtime del agente. **No** confundir con
`packages/agent/src/tools` (herramientas LangChain del modelo).

| POC | Rol |
|-----|-----|
| **easybroker-mls-cli** | Playwright contra la bolsa MLS de EasyBroker (`/agent/mls_properties`). Usado en producción por `easybroker_search_listings` y `easybroker_search_closed_deals` (provider `easybroker_web`). |
| **ungga-cli** | Playwright contra la UI de Ungga (staging); fallback de `ungga_publish_listing`. |
| **ungga-api** | Cliente + OpenAPI para el endpoint interno propuesto. |

## Setup local

Desde la raíz del monorepo:

```bash
npm run setup:pocs
```

Instala dependencias de `pocs/easybroker-mls-cli` y `pocs/ungga-cli` y descarga
Chromium para Playwright. Cada POC tiene su `.env` local (ver README del POC);
no versionar `.env` ni `storage-state.json`.
