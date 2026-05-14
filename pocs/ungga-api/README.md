# POC: Ungga internal API integration

Definición del contrato y cliente mínimo para probar `POST /v1/internal/listings`.
Comparar con `pocs/ungga-cli` (Playwright).

## Cliente

```bash
cd pocs/ungga-api
npm install
UNGGA_INTERNAL_API_BASE=https://app.ungga.com UNGGA_INTERNAL_API_TOKEN=... node src/client.mjs ./fixtures/listing.sample.json
```

Ver `openapi.yaml` para el cuerpo esperado.
