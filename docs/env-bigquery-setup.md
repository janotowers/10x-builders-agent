# BigQuery — variables de entorno (`bigquery_run_query`)

La herramienta `bigquery_run_query` corre en el **servidor** de Next.js (rutas como `/api/chat`). Lee la configuración desde **`process.env`**, que Next carga desde **`apps/web/.env.local`** (no uses la raíz del monorepo salvo que dupliques variables ahí a propósito).

Implementación: [`packages/agent/src/tools/bigquery-adapter.ts`](../packages/agent/src/tools/bigquery-adapter.ts).

---

## Qué pegar en `apps/web/.env.local`

Copia el bloque siguiente al final de tu `.env.local` y **sustituye** los valores marcados. No subas este archivo a git (está en `.gitignore`).

```env
# --- Google BigQuery (skill company-data / bigquery_run_query) ---
# Proyecto y región por defecto (API jobs.query).
BIGQUERY_PROJECT_ID=ungga-full
BIGQUERY_LOCATION=US

# Autenticación: elige UNA de las dos opciones (A o B).

# (A) Archivo JSON de cuenta de servicio — recomendado en desarrollo local.
#     Windows (ruta absoluta, barras invertidas o escapadas):
GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\absoluta\bigquery-readonly-sa.json
#
#     macOS / Linux:
# GOOGLE_APPLICATION_CREDENTIALS=/home/tuusuario/keys/bigquery-readonly-sa.json

# (B) Mismo JSON en una sola línea — útil en Vercel u otros hosts sin disco persistente.
#     Minifica el JSON (sin saltos de línea) o escapa comillas dobles como \".
# GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account","project_id":"..."}
```

Si usas **solo la opción (B)**, puedes omitir `GOOGLE_APPLICATION_CREDENTIALS`. Si usas **(A)**, no hace falta `GOOGLE_APPLICATION_CREDENTIALS_JSON`.

---

## Requisitos de la cuenta de servicio (GCP)

- Crea una **cuenta de servicio** en el proyecto que consultas (o en uno con permisos delegados).
- Asigna roles suficientes para **ejecutar jobs de solo lectura** y **leer tablas/vistas**, por ejemplo:
  - `roles/bigquery.dataViewer` sobre el proyecto o datasets concretos, y
  - `roles/bigquery.jobUser` en el proyecto donde corre el query (típicamente el mismo que `BIGQUERY_PROJECT_ID`).
- Descarga la clave JSON y guárdala **fuera del repo**; referencia su ruta con `GOOGLE_APPLICATION_CREDENTIALS` o pégame la clave en el gestor de secretos del proveedor como `GOOGLE_APPLICATION_CREDENTIALS_JSON`.

---

## Relación con Supabase (`business_brain`)

- El bloque **`[Contexto de tenant]`** que inyecta `runAgent` puede mostrar `project_id` y `location` desde `profiles.business_brain.bigquery` **o**, si faltan, desde **`BIGQUERY_PROJECT_ID`** y **`BIGQUERY_LOCATION`**.
- La **ejecución** de la query sigue usando `executeBigQueryQuery`, que toma el proyecto por defecto del **entorno** (`BIGQUERY_PROJECT_ID`) salvo que el tool reciba otro `projectId` en el futuro. Por tanto, para que funcione hoy hay que tener **`BIGQUERY_PROJECT_ID` + credenciales** en `.env.local`.

---

## Habilitar la herramienta en la UI

En **Ajustes** activa la herramienta `bigquery_run_query` (y `read_skill_reference` si usas la skill global `company-data`).

---

## Usuario regular vs admin Ungga

- **Usuario regular:** en Supabase, `profiles.business_brain` debe incluir `identity.organization_id` con el valor real de BigQuery (`users_light.organization_id`). Ver migración [`00009_business_brain.sql`](../packages/db/supabase/migrations/00009_business_brain.sql) y el roadmap en [`business-brain-evolution-roadmap.md`](business-brain-evolution-roadmap.md).
- **Admin Ungga:** `profiles.is_ungga_admin = true` permite el modo cross-tenant descrito en la skill; el `organization_id` en Business Brain deja de ser obligatorio para el bloque de contexto.

---

## Diagnóstico rápido

| Síntoma | Causa probable |
|---------|----------------|
| Respuesta del tool `not_configured` con `missing: ["BIGQUERY_PROJECT_ID"]` | Falta `BIGQUERY_PROJECT_ID` en `apps/web/.env.local` o no reiniciaste `npm run dev`. |
| `not_configured` mencionando credenciales | Falta tanto `GOOGLE_APPLICATION_CREDENTIALS` como `GOOGLE_APPLICATION_CREDENTIALS_JSON`, o la ruta al archivo es inválida. |
| `execution_error` / 403 tras autenticar | La cuenta de servicio no tiene permisos sobre el dataset o el proyecto. |
| El modelo dice «inmobiliaria no configurada» | Usuario regular sin `business_brain.identity.organization_id` en Supabase. |

Tras cambiar `.env.local`, **reinicia** el servidor de desarrollo.
