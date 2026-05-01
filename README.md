# Agente personal (MVP)

Monorepo con **Next.js**, **Supabase**, **LangGraph** y **OpenRouter**. Incluye chat web, onboarding, ajustes y bot de **Telegram** (opcional).

## Requisitos previos

- **Node.js** 20 o superior (recomendado LTS).
- **npm** 10+ (incluido con Node.js 20+).
- Cuenta en **[Supabase](https://supabase.com)** (gratis).
- Cuenta en **[OpenRouter](https://openrouter.ai)** para la API del modelo (clave de API).
- *(Opcional)* Bot de Telegram creado con [@BotFather](https://t.me/BotFather) y una URL **HTTPS** pública para el webhook (en local suele usarse **ngrok** o similar).

---

## Paso 1 — Clonar e instalar dependencias

```bash
cd agents
npm install
```

---

## Paso 2 — Crear proyecto en Supabase

1. Entra en el [dashboard de Supabase](https://supabase.com/dashboard) y crea un **nuevo proyecto**.
2. Espera a que termine el aprovisionamiento.
3. En **Project Settings → API** anota:
   - **Project URL** → será `NEXT_PUBLIC_SUPABASE_URL`
   - **`anon` public** → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **`service_role` secret** → será `SUPABASE_SERVICE_ROLE_KEY` (no la expongas al cliente ni la subas a repositorios públicos).

---

## Paso 3 — Aplicar el esquema SQL (tablas + RLS)

1. En Supabase, abre **SQL Editor**.
2. Abre el archivo del repo:

   `packages/db/supabase/migrations/00001_initial_schema.sql`

3. Copia **todo** el contenido y pégalo en el editor.
4. Ejecuta el script (**Run**).

Si algo falla (por ejemplo, el trigger `on_auth_user_created` en un proyecto ya modificado), revisa el mensaje de error; en la mayoría de proyectos nuevos el script aplica de una vez.

5. **Enlaces de reserva pública (Google Calendar):** en el mismo **SQL Editor**, ejecuta también el contenido de:

   `packages/db/supabase/migrations/00002_calendar_booking_links.sql`

   Sin esta tabla, **Ajustes → Generar enlace de reserva pública** devolverá error (`calendar_booking_links` no encontrada).

6. **Tareas programadas (`schedule_task` + `manage_scheduled_tasks`):** si vas a usarlas, ejecuta también (en orden):

   - `packages/db/supabase/migrations/00003_scheduled_tasks.sql`
   - `packages/db/supabase/migrations/00004_scheduled_tasks_retry.sql` (reintentos acotados + auto-pausa tras fallos consecutivos)

   Configura `CRON_SECRET` en `apps/web/.env.local` y el job en Supabase según [docs/tools-design/runbook-scheduled-tasks.md](docs/tools-design/runbook-scheduled-tasks.md).
   Con esto habilitas tanto **programar** tareas (`schedule_task`) como **listar/pausar/reanudar** tareas existentes (`manage_scheduled_tasks`) desde chat, más la política de reintentos (hasta 3 intentos con 2 min de gap antes de auto-pausar y avisar por Telegram).

7. **Business Brain + columnas de tenant (Skills `company-data`, bloque `[Contexto de tenant]`):** ejecuta en el **SQL Editor** el contenido de:

   `packages/db/supabase/migrations/00009_business_brain.sql`

   Añade `profiles.business_brain` (JSONB) y asegura `profiles.is_ungga_admin`. Después, rellena `business_brain.identity.organization_id` (y opcionalmente `bigquery`) por usuario vía SQL o la UI cuando exista (ver [docs/env-bigquery-setup.md](docs/env-bigquery-setup.md)).

---

## Paso 4 — Configurar autenticación (email)

1. En Supabase: **Authentication → Providers** → habilita **Email** (por defecto suele estar activo).
2. **Authentication → URL configuration**:
   - **Site URL**: para desarrollo local usa `http://localhost:3000`
   - **Redirect URLs**: añade al menos:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/**` (o la variante que permita tu versión del dashboard para desarrollo)
   - Si accedes por **túnel ngrok** (p. ej. `https://xxxx.ngrok-free.dev`), añade también esa base con comodín, por ejemplo `https://xxxx.ngrok-free.dev/**` (o el patrón que permita tu proyecto en Supabase). Sin eso, el login puede fallar o no redirigir aunque la UI cargue.

Así el flujo de login/signup y el intercambio de código en `/auth/callback` funcionan en local y detrás de ngrok.

---

## Paso 5 — Variables de entorno

Next.js carga `.env*` desde el directorio de la app **`apps/web`**, no desde la raíz del monorepo.

1. Copia el ejemplo:

   Desde la **raíz** del repo:

   ```bash
   cp apps/web/.env.example apps/web/.env.local
   ```

   O desde `apps/web`:

   ```bash
   cp .env.example .env.local
   ```

   *(Si ya tienes `.env.local` en la raíz, mueve o copia ese archivo a `apps/web/.env.local`.)*

2. Edita `apps/web/.env.local` y completa:

   | Variable | Descripción |
   |----------|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave `anon` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (solo servidor; la usa la API del agente y Telegram contra Postgres) |
   | `DATABASE_URL` | *(Opcional)* URI Postgres directa para checkpoints de LangGraph; ver comentarios en `.env.example` |
   | `CRON_SECRET` | *(Opcional)* Secreto compartido con el job `pg_cron` que llama a `POST /api/cron/scheduled-tasks` (herramienta `schedule_task`); debe coincidir con el `Bearer` del SQL en Supabase. Runbook: [docs/tools-design/runbook-scheduled-tasks.md](docs/tools-design/runbook-scheduled-tasks.md) |
   | `NEXT_PUBLIC_SITE_URL` | URL pública base **sin barra final** (OAuth redirect y enlaces de reserva). Ej.: `http://localhost:3000` o `https://tu-dominio.com` |
   | `OPENROUTER_API_KEY` | Clave de OpenRouter |
   | `OPENROUTER_MAX_TOKENS` | *(Opcional)* Cap de `max_tokens` de salida por llamada. OpenRouter lo reserva contra tu saldo antes de ejecutar, así que con poco crédito conviene bajarlo. Default: `2048` |
   | `ENCRYPTION_KEY` | 64 caracteres hexadecimales (32 bytes) para cifrar tokens de integraciones en base de datos. Generar: `openssl rand -hex 32` |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | *(Opcional)* OAuth GitHub; redirect `{NEXT_PUBLIC_SITE_URL}/api/integrations/github/callback` |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(Opcional)* OAuth Google Calendar; redirect `{NEXT_PUBLIC_SITE_URL}/api/integrations/google/callback` |
   | `TELEGRAM_BOT_TOKEN` | *(Opcional)* Token del bot |
   | `TELEGRAM_WEBHOOK_SECRET` | *(Opcional)* Secreto que Telegram enviará en cabecera; debe coincidir con el configurado al registrar el webhook |
   | `TELEGRAM_WEBHOOK_BASE_URL` | *(Opcional)* URL HTTPS pública para `setWebhook` (p. ej. ngrok); a veces innecesaria si el proxy envía `x-forwarded-host` |
   | `BIGQUERY_PROJECT_ID` | *(Opcional)* Proyecto GCP por defecto para `bigquery_run_query` (p. ej. `ungga-full`). Sin esto, la herramienta responde `not_configured`. |
   | `BIGQUERY_LOCATION` | *(Opcional)* Ubicación del job (`US`, `EU`, región concreta). Mejora determinismo con datasets multi-región. |
   | `GOOGLE_APPLICATION_CREDENTIALS` | *(Opcional)* Ruta **absoluta** al JSON de cuenta de servicio con lectura BigQuery. Recomendado en local. |
   | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | *(Opcional)* Mismo JSON en **una línea**; alternativa a la ruta (típico en serverless). |

Referencia de nombres: [apps/web/.env.example](apps/web/.env.example). Guía detallada (plantilla para `.env.local`, permisos IAM, encadenamiento con `business_brain`): [docs/env-bigquery-setup.md](docs/env-bigquery-setup.md).

---

## BigQuery y skill `company-data` (opcional)

Para preguntas de negocio contra el almacén BigQuery de Ungga:

1. Variables en **`apps/web/.env.local`** — ver tabla arriba y [docs/env-bigquery-setup.md](docs/env-bigquery-setup.md).
2. Herramienta **`bigquery_run_query`** habilitada en Ajustes para tu usuario.
3. Migración **`00009_business_brain.sql`** aplicada en Supabase y, para usuarios **no** admin, `business_brain.identity.organization_id` relleno con el id real de la inmobiliaria en BigQuery (`users_light.organization_id`).

Sin (1), el modelo recibe `not_configured`. Sin (3), el bloque `[Contexto de tenant]` puede quedar en modo “inmobiliaria no configurada” para usuarios regulares.

---

## Paso 6 — Arrancar la aplicación web

Desde la **raíz** del repo:

```bash
npm run dev
```

Por defecto Turbo ejecuta el `dev` de cada paquete; la app suele quedar en **http://localhost:3000**.

Flujo esperado:

1. **Registro** en `/signup` o **login** en `/login`.
2. **Onboarding** (perfil, agente, herramientas, revisión).
3. **Chat** en `/chat` y **ajustes** en `/settings`.

En **Ajustes**, configura la **zona horaria** para que los eventos del calendario y las etiquetas de hora coincidan con tu región (el valor por defecto en base de datos puede ser `UTC` si no lo cambiaste en onboarding).

---

## Paso 7 — Probar el chat con el modelo

1. Confirma que `OPENROUTER_API_KEY` está en `apps/web/.env.local`.
2. En el onboarding, activa al menos las herramientas básicas (`get_user_preferences`, `list_enabled_tools`) si quieres probar *tool calling*.
3. Escribe un mensaje en `/chat`. Si la clave o el modelo fallan, revisa la consola del servidor (terminal donde corre `npm run dev`).

El modelo por defecto está definido en `packages/agent/src/model.ts` (OpenRouter, `openai/gpt-4o-mini`). Puedes cambiarlo ahí si lo necesitas.

---

## Paso 8 — Telegram (opcional)

Telegram **exige HTTPS** para webhooks. En local:

1. Crea el bot con BotFather y copia el token → `TELEGRAM_BOT_TOKEN` en `apps/web/.env.local`.
2. Elige un secreto aleatorio → `TELEGRAM_WEBHOOK_SECRET` (mismo valor usarás al registrar el webhook).
3. Expón tu app local con un túnel HTTPS, por ejemplo:

   ```bash
   ngrok http 3000
   ```

   Usa la URL HTTPS que te dé ngrok (p. ej. `https://abc123.ngrok-free.app` o `https://abc123.ngrok-free.dev`; el proyecto ya permite ambos en `allowedDevOrigins` de Next).

4. Con la app en marcha, visita en el navegador (sustituye la URL base):

   `https://TU_URL_NGROK/api/telegram/setup`

   El middleware de la app **solo deja sin login** el webhook (`/api/telegram/webhook`); **`/api/telegram/setup` exige sesión**. Si ves la pantalla de login, entra primero con la **misma** URL base (p. ej. si usas ngrok, inicia sesión en `https://TU_URL_NGROK`, no solo en `localhost`).

   Eso llama a `setWebhook` de Telegram apuntando a `/api/telegram/webhook` y, si definiste secreto, lo asocia al webhook.

5. En la web, entra a **Ajustes** → **Telegram** → **Generar código de vinculación**.
6. En Telegram, envía al bot: `/link TU_CODIGO` (el código que te muestra la web).

Después de vincular, los mensajes al bot usan el mismo pipeline que el chat web.

---

## Comandos útiles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Desarrollo (monorepo) |
| `npm run build` | Build de todos los paquetes que definan `build` |
| `npm run lint` | Lint |
| `cd apps/web && npx next build` | Build solo de la app Next (útil para comprobar tipos antes de desplegar) |

---

## Documentación adicional

- [docs/brief.md](docs/brief.md) — visión y brief original.
- [docs/architecture.md](docs/architecture.md) — arquitectura técnica del MVP.
- [docs/plan.md](docs/plan.md) — fases y decisiones de implementación.
- [docs/business-brain-evolution-roadmap.md](docs/business-brain-evolution-roadmap.md) — evolución hacia Business Brain (Skills, Heartbeat, contexto por cuenta); roadmap producto + ingeniería.
- [docs/env-bigquery-setup.md](docs/env-bigquery-setup.md) — variables `BIGQUERY_*` y credenciales GCP para `bigquery_run_query` en local y producción.
- [docs/tools-design/runbook-scheduled-tasks.md](docs/tools-design/runbook-scheduled-tasks.md) — despliegue y prueba del cron de tareas programadas (`pg_cron`, ngrok, `CRON_SECRET`).

---

## Problemas frecuentes

- **Redirecciones infinitas o “no auth”**: revisa `Site URL` y `Redirect URLs` en Supabase y que `.env.local` esté en **`apps/web`**.
- **Errores al guardar perfil o mensajes**: confirma que ejecutaste la migración SQL y que RLS no bloquea por falta de sesión (debes estar logueado con el mismo usuario).
- **Chat sin respuesta / 500 en `/api/chat`**: `OPENROUTER_API_KEY`, cuota en OpenRouter o modelo en `model.ts`.
- **Telegram no responde**: webhook debe ser HTTPS; token y secreto correctos; visita de nuevo `/api/telegram/setup` si cambias la URL pública.
- **`/api/telegram/setup` me manda a login**: inicia sesión en el mismo origen (ngrok o localhost) y vuelve a abrir la URL; solo el path `/api/telegram/webhook` es público para Telegram.
- **BigQuery devuelve `not_configured`**: revisa `BIGQUERY_PROJECT_ID` y credenciales en **`apps/web/.env.local`**, reinicia `npm run dev`, y la guía [docs/env-bigquery-setup.md](docs/env-bigquery-setup.md).

Si quieres, el siguiente paso natural es desplegar **Vercel** (o similar) para `apps/web`, definir las mismas variables de entorno en el panel del proveedor y usar la URL de producción en Supabase y en el webhook de Telegram.
