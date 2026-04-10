# Arquitectura Técnica — Agente Personal MVP

## Stack

| Capa                  | Tecnología                           | Paquete                              |
| --------------------- | ------------------------------------ | ------------------------------------ |
| Monorepo              | Turborepo + npm workspaces           | raíz                                 |
| Frontend / API routes | Next.js (App Router)                 | `apps/web`                           |
| Agente runtime        | LangGraph JS + LangChain core        | `packages/agent`                     |
| Base de datos + Auth  | Supabase (Postgres + Auth + RLS)     | `packages/db`                        |
| Tipos compartidos     | TypeScript                           | `packages/types`                     |
| Config compartida     | tsconfig                             | `packages/config`                    |
| Modelo LLM            | OpenRouter (GPT-4o-mini por defecto) | vía `@langchain/openai` con base URL |

## Estructura del monorepo

```
agents/
├── apps/
│   └── web/                    # Next.js — UI + API routes
│       └── src/
│           ├── app/
│           │   ├── login/      # Autenticación
│           │   ├── signup/
│           │   ├── onboarding/ # Wizard multi-paso
│           │   ├── chat/       # Interfaz de chat
│           │   ├── book/       # Reserva pública (token en URL, sin login)
│           │   ├── settings/   # Ajustes post-onboarding
│           │   └── api/
│           │       ├── chat/           # POST → runAgent
│           │       ├── chat/confirm/   # POST → ejecuta tool aprobada
│           │       ├── integrations/
│           │       │   ├── github/   # OAuth GitHub
│           │       │   └── google/   # OAuth Google Calendar
│           │       ├── calendar/
│           │       │   └── booking-link/  # POST — genera enlace de reserva (auth)
│           │       ├── public/
│           │       │   └── booking/[token]/ # GET/POST FreeBusy y reserva (sin auth)
│           │       ├── auth/signout/
│           │       └── telegram/
│           ├── lib/supabase/
│           └── middleware.ts
├── packages/
│   ├── agent/
│   │   └── src/tools/   # catalog, adapters, github-api, calendar-api, github-intent, …
│   ├── db/
│   │   ├── src/google-calendar-oauth.ts  # refresh + getGoogleCalendarAccessToken
│   │   └── src/queries/booking-links.ts
│   └── types/
├── docs/
└── turbo.json
```

## Diagrama de componentes

```
┌─────────────┐    ┌──────────────┐    ┌────────────────┐
│  Next.js UI │    │ Telegram Bot │    │ Visitante /book│
│  (web chat) │    │  (webhook)   │    │ (token opaco)  │
└──────┬──────┘    └──────┬───────┘    └────────┬───────┘
       │                  │                     │
       ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────┐
│              Supabase Auth (JWT)                    │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│   LangGraph Runtime + tools (GitHub, Calendar, …)     │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│    Supabase Postgres (RLS)                          │
│  profiles | sessions | messages | tool_calls         │
│  user_tool_settings | user_integrations | telegram   │
│  calendar_booking_links                              │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│  External: GitHub API | Google Calendar API         │
└─────────────────────────────────────────────────────┘
```

## Integraciones OAuth (GitHub y Google Calendar)

- **Identidad del producto:** Supabase Auth (email/contraseña u otros proveedores de login).
- **GitHub / Google Calendar:** flujos OAuth **aparte**, iniciados desde Ajustes. Tokens cifrados en `user_integrations` (`encrypted_tokens`), `provider` = `github` | `google_calendar`.
- **GitHub:** se guarda el access token (texto cifrado).
- **Google Calendar:** se guarda JSON cifrado `{ access_token, refresh_token?, expires_at }`. `packages/db/src/google-calendar-oauth.ts` refresca el access token con `refresh_token` cuando está próximo a expirar y vuelve a persistir el blob.

### Disponibilidad para terceros (reservas)

Los visitantes **no** hacen OAuth con Google. Las rutas bajo `/api/public/booking/[token]` y la página `/book/[token]` usan un **token opaco** fila en `calendar_booking_links`. El servidor resuelve `user_id`, obtiene tokens del dueño con `getGoogleCalendarAccessToken`, y llama a la API de Google ([FreeBusy](https://developers.google.com/calendar/api/v3/reference/freebusy/query), crear evento) en su nombre.

## Flujo de un request de chat

1. Usuario envía mensaje (web POST `/api/chat` o Telegram webhook).
2. Se autentica al usuario (JWT en web, lookup `telegram_accounts` en Telegram).
3. Se carga o crea `agent_session` para el canal.
4. Se cargan `profile`, `user_tool_settings` e `integrations`.
5. Se obtiene `githubToken` (descifrado) y `googleCalendarAccessToken` (con refresh si aplica).
6. Se filtran las tools disponibles (allowlist + integración activa).
7. Se invoca `runAgent()` con `userTimezone` desde `profiles.timezone`.
8. Si una tool tiene riesgo medio/alto → `pendingConfirmation` estructurado; confirmación en web o Telegram.

## LangGraph: grafo simplificado

- **StateGraph** con nodos `agent` y `tools`.
- **MemorySaver** (thread_id = session_id).
- Máximo 6 iteraciones de tool.

## Herramientas: catálogo, ejecución y estilo de registro

- **`packages/agent/src/tools/catalog.ts`** — Definiciones de producto: `id`, descripción, `risk`, `requires_integration`, `parameters_schema`. No ejecuta llamadas externas.
- **`packages/agent/src/tools/adapters.ts`** y módulos auxiliares (p. ej. `calendar-adapters.ts`, `github-api.ts`) — Ejecución real, esquemas Zod para LangChain, seguimiento en `tool_calls`, confirmación cuando `toolRequiresConfirmation` aplica, y `JSON.stringify` de resultados hacia el modelo.

**Estilo de registro en el código actual:** `buildLangChainTools` construye la lista con bloques `if (isToolAvailable(...)) { tools.push(tool(...)) }`. Es válido y equivalente en robustez a otras formas de organizar el mismo comportamiento.

**Patrón alternativo (también válido):** un objeto **`TOOL_HANDLERS`**-style — mapa `toolId → async (input, ctx) => resultado` — y un **único bucle** sobre `TOOL_CATALOG` que envuelve cada handler (p. ej. con tracking compartido). Útil cuando quieres ver todos los handlers en una tabla o reducir repetición en el registro.

**Cuándo refactorizar:** no es obligatorio cambiar de estilo solo por preferencia. Tiene sentido **extraer helpers compartidos** (confirmación, `tool_call`, errores) y **dividir por dominio** en más archivos cuando `adapters.ts` crezca o añadas muchas tools nuevas; volver a un mapa de handlers por dominio es una opción razonable si mejora la lectura.

## Modelo de datos

Migraciones en `packages/db/supabase/migrations/`:

- `00001_initial_schema.sql` — perfiles, integraciones, sesiones, mensajes, tools, telegram, etc.
- `00002_calendar_booking_links.sql` — enlaces de reserva (`token`, `user_id`, `calendar_id`).

## Seguridad

- **RLS** en tablas con datos de usuario; `calendar_booking_links` solo gestionada por el dueño vía policies. APIs públicas usan **service role** solo en el servidor para resolver el token sin sesión del visitante.
- **Tokens OAuth** cifrados en aplicación (`ENCRYPTION_KEY`).
- **Enlaces /book/**: tratar el token como secreto; HTTPS en producción.

## Canales

- **Web:** POST `/api/chat`, confirmación `POST /api/chat/confirm`.
- **Telegram:** webhook, inline keyboards.
- **Reserva pública:** `GET /book/[token]`, APIs bajo `/api/public/booking/`.

## UI de chat (web)

- Los mensajes del **usuario** se muestran como texto plano.
- Los mensajes del **asistente** se renderizan como **Markdown** (`react-markdown` en `apps/web/src/app/chat/chat-interface.tsx`), con estilos vía el plugin `@tailwindcss/typography` cargado en `apps/web/src/app/globals.css`. Los enlaces abren en nueva pestaña (`target="_blank"`, `rel="noopener noreferrer"`).

## Zona horaria

- `profiles.timezone` almacena un identificador **IANA** (p. ej. `America/Mexico_City`). En el esquema SQL el valor por defecto es `UTC`; si el perfil sigue en `UTC`, las horas y la abreviatura de zona que ve el usuario pueden mostrarse como UTC aunque el evento en Google esté en otra zona.
- El usuario puede fijar la zona en **onboarding** y en **Ajustes** (`/settings`); conviene revisarla tras el primer login si el calendario no coincide con la región esperada.
- Ese campo se pasa a `runAgent()` como `userTimezone` y se usa para interpretar períodos en lenguaje natural, construir `time_min` / `time_max` y el `timeZone` en creación/actualización de eventos en la API de Google.
- La tool `calendar_list_events` devuelve `start_display` y `end_display` ya en la zona del perfil; la abreviatura al final (p. ej. CST) se obtiene con `Intl` en `packages/agent/src/tools/calendar-event-display.ts`.

## Calendario en el agente (reglas en código)

- **Ventana de listado:** `packages/agent/src/tools/calendar-list-window.ts` corrige rangos inválidos o solo pasados y orienta al modelo cuando falta período (`needs_period`).
- **Instrucciones al modelo:** en `packages/agent/src/graph.ts`, el addendum de calendario fija interpretaciones como “esta semana” = semana calendario (lunes–domingo) en la zona del perfil, no “desde ahora + 7 días”.
- **Evitar confusión con GitHub:** si el último mensaje del usuario parece solo una aclaración de período de calendario (`packages/agent/src/tools/calendar-period-intent.ts`), `packages/agent/src/tools/adapters.ts` puede ocultar temporalmente `github_list_repos` / `github_list_issues` para ese turno, de modo que no sustituyan a `calendar_list_events`.
