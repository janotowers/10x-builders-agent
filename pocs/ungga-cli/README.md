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

Variables de entorno: `pocs/ungga-cli/.env` (no se commitea; copia desde
`.env.example`). Las credenciales son sólo para el POC local; en operación real
deberían vivir como secretos por cuenta en Supabase, no como variables globales
del repo.

```dotenv
UNGGA_STAGING_URL=https://ungga.com/login
UNGGA_STAGING_EMAIL=...
UNGGA_STAGING_PASSWORD=...
UNGGA_CLI_DRY_RUN=true
# Opcional en desarrollo local; requerido en producción si se usa el fallback.
# UNGGA_CLI_ENABLED=true
UNGGA_CLI_HEADLESS=true
UNGGA_CLI_SCREENSHOTS=true
UNGGA_CLI_TIMEOUT_MS=60000
UNGGA_CLI_PUBLISH_PATH=https://ungga.com/app/propiedades/nueva
```

> Usa cuenta de prueba. Ajusta selectores en `src/steps.mjs` al DOM real de Ungga.

## Ejecutar

```bash
npm run poc:login
npm run poc:create
npm run poc:inspect            # mapea campos del wizard a artifacts/wizard-map.json
npm run poc:publish -- fixtures/listing.sample.json
npm run poc:report
```

También puedes enviar JSON por stdin:

```bash
echo '{"title":"POC test - DELETE ME","operation":"sale","property_type":"Departamento","price":5500000}' | npm run poc:publish
```

Para inspeccionar el wizard completo (llenando GENERAL y avanzando tabs durante
el mapeo):

```bash
UNGGA_CLI_INSPECT_FIXTURE=fixtures/listing.sample.json npm run poc:inspect
```

`poc:publish` corre en `UNGGA_CLI_DRY_RUN=true` por defecto: llena los campos
obligatorios de la pestaña GENERAL y captura evidencia, pero no presiona ningún
botón de guardado. Con `UNGGA_CLI_DRY_RUN=false` el script presiona **"Guardar
como borrador"** (no publica): la ficha queda en la pestaña *Borrador* de Ungga
para que un humano la revise, complete el resto del wizard y publique
manualmente (HITL). Esto encaja con el riesgo "high" de
`ungga_publish_listing`.

Cuando el adapter `ungga_publish_listing` usa este POC como fallback, ejecuta
`src/publish-listing.mjs` en este directorio. En desarrollo local puede cargar
este `.env` directamente vía `dotenv/config`; en producción debe habilitarse de
forma explícita con `UNGGA_CLI_ENABLED=true` y credenciales administradas como
secretos del runtime.

Campos que el script llena automáticamente:

- **GENERAL**: `property_type`, `title`, `description`, `construction_m2`,
  `land_m2` (+ `land_unit`), `condition`, `age_range`, `country`, `address`
  (autocomplete de Google Places).
- **DETALLES**: `bedrooms`, `bathrooms_full`, `bathrooms_half`,
  `parking_spaces`, `covered_parking`, `floor`, `location_type`,
  `current_status`, `amenities[]`.
- **MEDIA**: `video_url`, `tour_url` (opcionales).
- **OPERACIÓN**: por cada entrada de `operations[]` abre el modal "Elije el
  tipo de operación", selecciona el tab (`sale`/`rent`/`rent_temporary`/
  `presale`), llena `price` + `currency` y confirma con el botón ✓.

En `prepare_draft` el POC no presiona `PUBLICAR`; guarda borrador con
"Guardar como borrador". Preferir `UNGGA_CLI_PUBLISH_PATH` apuntando al wizard
(`/app/propiedades/nueva`). Si apunta al catálogo, el script intenta abrir
"Nueva propiedad" y, si no abre el formulario, hace fallback a `/nueva`.

Tras aprobación HITL, `publish_draft` publica el borrador existente:

```bash
echo '{"action":"publish_draft","ungga_property_id":"GU-ID_AQUI","title":"…"}' | npm run poc:publish
```

Flujo real: guardar cambios en el editor → catálogo (pestaña Borrador) → abrir
la ficha cuyo modal muestra el **GU-ID** objetivo → **PUBLICAR** (y diálogo de
confirmación si aparece) → verificar estado PUBLICADO. No usa la primera ficha
por título: hay gemelas importadas (p. ej. EasyBroker) con PUBLICAR
deshabilitado ("gestiona desde tu portal o CRM"); el CLI exige match de GU-ID
antes de hacer click.

Con `UNGGA_CLI_DRY_RUN=true` no confirma la publicación remota.

La tool `ungga_publish_listing` usa el mismo contrato (`action`: `prepare_draft` |
`publish_draft`) y mantiene HITL entre fases.

Mapa de pestañas en `artifacts/wizard-map.json` y `artifacts/wizard-map-full.json`
(generado con `npm run poc:inspect`, opcionalmente con
`UNGGA_CLI_INSPECT_FIXTURE=fixtures/listing.sample.json` para llenar GENERAL y
avanzar el wizard durante la inspección).

## Comparación con API

Ver `pocs/ungga-api/`. Si la API interna es viable, **preferir API**; este POC es plan B y aprendizaje.
