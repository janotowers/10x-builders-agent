# POC: Ungga CLI (Playwright)

## Objetivo

Validar la viabilidad de automatizar acciones contra Ungga usando Playwright,
**antes** de comprometer la tool `ungga_publish_listing` a este enfoque.

## Setup

```bash
cd pocs/ungga-cli
npm install
npx playwright install chromium
```

Variables de entorno: `pocs/ungga-cli/.env` (no se commitea; copia desde `.env.example` si existe).

```
UNGGA_STAGING_URL=https://app.ungga.com
UNGGA_STAGING_EMAIL=...
UNGGA_STAGING_PASSWORD=...
UNGGA_TEST_PROPERTY_TITLE=POC test - DELETE ME
UNGGA_TEST_CLEANUP=true
N=10
```

> Usa cuenta de prueba. Ajusta selectores en `src/steps.mjs` al DOM real de Ungga.

## Ejecutar

```bash
npm run poc:login
npm run poc:create
npm run poc:report
```

## Comparación con API

Ver `pocs/ungga-api/`. Si la API interna es viable, **preferir API**; este POC es plan B y aprendizaje.
