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
| Modelo LLM            | OpenRouter (GPT-4o-mini por defecto, overrides por canal) | vía `@langchain/openai` con base URL |

### Proveedores de modelo (diseño previsto)

**Estado actual del código:** el LLM se invoca solo vía **OpenRouter** (`OPENROUTER_API_KEY`, `OPENROUTER_MAX_TOKENS`, modelo por defecto `openai/gpt-4o-mini` en `packages/agent/src/model.ts`). El runtime ya tiene configuración por canal: interacción web/Telegram, cron de tareas programadas y heartbeat (`HEARTBEAT_MODEL_ID`, `HEARTBEAT_MAX_TOKENS`, temperatura baja).

**Diseño acordado (implementación pendiente):** soportar además **Google Gemini** directo (AI Studio o Vertex) con una fachada única y configuración por canal (interactivo / cron / heartbeat), sin duplicar lógica en el grafo ni en las tools. Motivación, variables previstas, fallback y riesgos: **[docs/tools-design/model-providers.md](tools-design/model-providers.md)**.

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
│           │       ├── chat/confirm/   # POST → resume HITL (runAgent + resumeDecision)
│           │       ├── integrations/
│           │       │   ├── github/   # OAuth GitHub
│           │       │   └── google/   # OAuth Google Calendar
│           │       ├── calendar/
│           │       │   └── booking-link/  # POST — genera enlace de reserva (auth)
│           │       ├── public/
│           │       │   └── booking/[token]/ # GET/POST FreeBusy y reserva (sin auth)
│           │       ├── auth/signout/
│           │       ├── cron/
│           │       │   ├── scheduled-tasks/  # POST — runner externo (CRON_SECRET)
│           │       │   └── heartbeat/        # POST — runner Heartbeat (CRON_SECRET)
│           │       ├── scheduled-tasks/[id]/status/ # POST — pausar/reanudar tarea
│           │       └── telegram/
│           ├── lib/supabase/
│           └── middleware.ts
├── packages/
│   ├── agent/
│   │   └── src/tools/   # catalog, adapters, bashExec, fileTools, github-api, calendar-api, …
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
│   LangGraph Runtime + tools (GitHub, Calendar, bash→host…) │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│    Supabase Postgres (RLS)                          │
│  profiles | sessions | messages | tool_calls         │
│  user_tool_settings | user_integrations | telegram   │
│  calendar_booking_links | scheduled_tasks | scheduled_task_runs │
│  heartbeat_runs | user_skill_settings                       │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│  External: GitHub API | Google Calendar API | host OS (bash + file tools) │
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
6. Se cargan `user_skill_settings` y el registry global de skills cuando aplica.
7. Se filtran las tools disponibles (allowlist + integración activa; la tool `bash` además exige `BASH_TOOL_ENABLED=true` en el servidor, y `read_file`/`write_file`/`edit_file` exigen `FILE_TOOLS_ENABLED=true` + `FILE_TOOLS_ROOT`).
8. Se invoca `runAgent()` con `userTimezone` desde `profiles.timezone`. El runtime puede seleccionar una skill pre-graph antes de compilar el loop; el racional y trade-offs frente al enfoque Claude Code están documentados en [`docs/tools-design/skill-routing.md`](tools-design/skill-routing.md).
9. Si una tool tiene riesgo medio/alto → `interrupt()` en el grafo, `pendingConfirmation` persistido (incl. `checkpointThreadId` para resume); confirmación en web o Telegram vía `runAgent({ resumeDecision })`.

### Skills / playbooks

- Las skills globales viven como directorios `skills/global/<slug>/SKILL.md`, con frontmatter (`name`, `description`, `scope`, `allowed_tools`, `includes`, `requires_tenant_context`, `memory_extraction`) y referencias opcionales en `references/`.
- `packages/agent/src/skills/*` implementa parsing, registry lazy, resolución de composites (`includes`) y selección pre-graph. El selector elige **una skill dominante** o `none`; composites siguen siendo explícitos.
- Cuando una skill está activa, `runAgent` inyecta el playbook al system prompt, puede añadir `[Contexto de tenant]`, y `buildLangChainTools` intersecta la superficie de tools con `allowed_tools`.
- `read_skill_reference` permite leer un archivo de referencia de la skill activa o incluida, sin cargar todos los documentos en el prompt inicial.
- Settings muestra el catálogo global agrupado por `scope` y persiste overrides en `user_skill_settings`. El panel de chat muestra habilidades candidatas en "Contexto preparado" y la skill aplicada en "Habilidades del turno".
- El modelo detallado y sus trade-offs están en **[docs/tools-design/skill-routing.md](tools-design/skill-routing.md)** y el roadmap canónico en **[docs/business-brain-evolution-roadmap.md](business-brain-evolution-roadmap.md)**.

### Herramienta `bash` (host del servidor)

No es una API externa ni OAuth: ejecuta un comando en el **mismo proceso/host** que sirve Next.js. Útil en desarrollo o despliegues self-hosted con control total del servidor; en serverless multi-instancia no hay terminal persistente (el campo `terminal` en la tool es solo etiqueta para logs). Variables: `BASH_TOOL_ENABLED`, opcionalmente `BASH_TOOL_CWD` (véase `apps/web/.env.example`). Detalle: **[docs/tools-design/bash-tool.md](tools-design/bash-tool.md)**.

### Herramientas de archivos (`read_file`, `write_file`, `edit_file`)

Manipulan archivos de texto dentro de una **raíz configurada** (`FILE_TOOLS_ROOT`, ruta absoluta). Todas las rutas que pasa el modelo son **relativas** a esa raíz; `resolveSafePath` en `packages/agent/src/tools/fileTools.ts` rechaza rutas absolutas, `..` que escapen, y null bytes. Activación fail-closed: si `FILE_TOOLS_ENABLED !== "true"` o falta `FILE_TOOLS_ROOT`, las tres tools no se registran. `read_file` es `low` (sin HITL); `write_file` es `medium` (crea o sobrescribe, con confirmación); `edit_file` es `high` (reemplazo literal único, con confirmación). Detalle: **[docs/tools-design/files.md](tools-design/files.md)**.

### Tareas programadas (`schedule_task` + cron)

- La tool **`schedule_task`** (riesgo `medium`, HITL al **programar**) persiste filas en **`scheduled_tasks`** con `next_run_at` (one-time o recurrente vía `cron_expr` + zona IANA), `user_request` y `display_title` para UI legible.
- La tool **`manage_scheduled_tasks`** (riesgo `low`) permite **listar**, **pausar** y **reanudar** tareas del mismo usuario (`action=list|pause|resume`), sin borrar registros. Las acciones de cambio de estado validan ownership en DB por `task_id + user_id`.
- Para peticiones ambiguas tipo “pausa la de Hacker News”, el prompt obliga un flujo de desambiguación: `list` primero, pregunta corta, y `pause/resume` solo tras selección explícita del usuario.
- Un **runner externo** debe invocar periódicamente **`POST /api/cron/scheduled-tasks`** con cabecera **`Authorization: Bearer <CRON_SECRET>`** (variable en `apps/web`, no confundir con el webhook de Telegram). En producción puede ser **GCP Cloud Scheduler** o **Supabase `pg_cron` + `pg_net`** (`net.http_post`) llamando a la URL pública del despliegue; si el despliegue vive en GCP, Cloud Scheduler es el camino operativo recomendado. En local hace falta **HTTPS alcanzable** (p. ej. ngrok), porque un scheduler en la nube no puede abrir `localhost`.
- El handler en `apps/web/src/app/api/cron/scheduled-tasks/route.ts` usa **service role** contra Supabase, toma tareas vencidas, crea sesión **`agent_sessions.channel = cron`** y ejecuta **`runAgent({ ..., autoApproveTools: true })`**: el usuario ya aprobó al programar, así que las tools internas (p. ej. `bash`) no piden segunda confirmación. Auditoría en **`scheduled_task_runs`**; notificación por defecto por Telegram.
- La UI muestra tareas programadas en Settings y en la tarjeta "Actividad proactiva" del panel derecho. El endpoint autenticado `/api/scheduled-tasks/[id]/status` permite pausar/reanudar tareas propias desde Settings.
- El modelo usa **temperatura por canal**: interacción Web/Telegram `~0.3` y cron `~0.1` (más determinista). El cap `maxTokens` es configurable con `OPENROUTER_MAX_TOKENS` (default `2048`) para evitar rechazos por crédito insuficiente. Se prevé separar proveedor y topes por canal cuando exista la fachada multi-proveedor (ver **[docs/tools-design/model-providers.md](tools-design/model-providers.md)**).
- **Política de reintentos (migración `00004_scheduled_tasks_retry.sql`):** ante un run fallido el runner decide entre reintento acotado y auto-pausa. Errores "persistentes" (contiene `402`/`401`/`403`/`400`/`requires more credits`) se auto-pausan de inmediato para no quemar créditos. Errores transitorios reintentan hasta `MAX_CONSECUTIVE_FAILURES=3` con `RETRY_GAP_MINUTES=2` (acotado al próximo tick natural del cron si es recurrente). Alcanzado el cap → `status='paused'`, se persiste `last_failure_error` y se avisa al usuario por Telegram. Un run OK o un `manage_scheduled_tasks(action=resume)` resetea `consecutive_failures=0`.
- Detalle de diseño, HITL y operación: **[docs/tools-design/scheduled-tasks.md](tools-design/scheduled-tasks.md)** y **[docs/tools-design/runbook-scheduled-tasks.md](tools-design/runbook-scheduled-tasks.md)**.

### Heartbeat proactivo

- Heartbeat es un runner periódico por cuenta, distinto de `scheduled_tasks`: usa configuración en `profiles.business_brain.heartbeat` (`enabled`, `interval_minutes`, `checklist_markdown`, `last_run_at`) y registra auditoría en **`heartbeat_runs`**.
- Un **runner externo** invoca `POST /api/cron/heartbeat` con `Authorization: Bearer <CRON_SECRET>`. El patrón operativo es el mismo que scheduled tasks: en producción se recomienda GCP Cloud Scheduler si el despliegue vive en GCP; en local se puede usar ngrok o llamadas manuales.
- El endpoint selecciona usuarios vencidos según `interval_minutes`, crea sesión `agent_sessions.channel = heartbeat`, construye un prompt desde el checklist y ejecuta `runAgent({ channel: "heartbeat" })`.
- El canal `heartbeat` usa modelo/costos acotados (`HEARTBEAT_MODEL_ID`, `HEARTBEAT_MAX_TOKENS`, baja temperatura), no inyecta memoria de largo plazo como contexto conversacional y restringe tools a una allowlist de solo lectura.
- Settings permite activar/desactivar Heartbeat, editar intervalo/checklist, resetear al default y ver historial reciente. El panel derecho muestra presencia viva en "Actividad proactiva" y en el mini-dashboard superior ("Heartbeat" Activo/Inactivo).

## LangGraph: grafo, compaction (memoria corta) y HITL

- **StateGraph** con nodos **`compaction`**, **`agent`** y **`tools`**. Flujo: `__start__` → `compaction` → `agent` → (condicional) → `tools` o `__end__`; tras ejecutar tools, **`tools` → `compaction` → `agent`**. Así, cada lote de `ToolMessage` pasa por compaction antes del siguiente turno del modelo principal.
- **Memoria de corto plazo (compaction):** `packages/agent/src/nodes/compaction_node.ts` — (1) *microcompact*: ofusca resultados de tools antiguos (`[tool result cleared]`) conservando los últimos N intactos; (2) *LLM compaction*: si la ventana estimada supera el umbral (default 80%), resume con **Haiku** vía OpenRouter (`createCompactionModel` en `model.ts`) y reinyecta un `SystemMessage` `[CONTEXTO COMPACTADO]`; circuit breaker tras fallos consecutivos del compactador. Estado centralizado en `packages/agent/src/state.ts`: `messages` con **`messagesStateReducer`** (LangGraph) para soportar `RemoveMessage` y reemplazos por `id`, más `compactionCount` e **`iterationCount`**.
- **Límite de iteraciones de tools:** hasta **8** (`MAX_TOOL_ITERATIONS` en `graph.ts`). El guard **`shouldContinue`** usa **`state.iterationCount`** (incrementado en `agent` cuando hay `tool_calls`), no el recuento de `AIMessage` en el historial, para que el límite siga aplicando aunque compaction borre mensajes viejos.
- **Checkpointer:** `PostgresSaver` si existe `DATABASE_URL` (URI Postgres directa); si no, `MemorySaver` en memoria del proceso.
- **`thread_id`:** por mensaje nuevo se usa un id único por turno (`sessionId` + timestamp) para no mezclar checkpoints; el resume tras HITL reutiliza el `checkpointThreadId` guardado en `structured_payload`.
- **Diseño detallado de compaction:** **[docs/memory/short_memory_plan.md](memory/short_memory_plan.md)**. Plan de memoria larga (futuro): **[docs/memory/long_term_memory_plan.md](memory/long_term_memory_plan.md)**.
- Detalle de implementación, streaming, `__interrupt__` y regresiones evitadas: **[docs/tools-design/hitl.md](tools-design/hitl.md)** (sección *Implementación actual*).

## Herramientas: catálogo, ejecución y estilo de registro

- **`packages/agent/src/tools/catalog.ts`** — Definiciones de producto: `id`, descripción, `risk`, `requires_integration`, `parameters_schema`. No ejecuta llamadas externas. La tool **`bash`** (riesgo alto, sin OAuth) ejecuta un comando one-shot en el host del proceso Node si `BASH_TOOL_ENABLED=true` y el usuario la tiene habilitada en Ajustes; ver `packages/agent/src/tools/bashExec.ts` y `docs/tools-design/bash-tool.md`.
- **`packages/agent/src/tools/adapters.ts`** y módulos auxiliares (p. ej. `calendar-adapters.ts`, `github-api.ts`) — Ejecución real, esquemas Zod para LangChain, seguimiento en `tool_calls`, y `JSON.stringify` de resultados hacia el modelo. La confirmación humana (HITL) para riesgo medio/alto vive en **`graph.ts`** (`interrupt`), no en los adapters.

**Estilo de registro en el código actual:** `buildLangChainTools` construye la lista con bloques `if (isToolAvailable(...)) { tools.push(tool(...)) }`. Es válido y equivalente en robustez a otras formas de organizar el mismo comportamiento.

**Patrón alternativo (también válido):** un objeto **`TOOL_HANDLERS`**-style — mapa `toolId → async (input, ctx) => resultado` — y un **único bucle** sobre `TOOL_CATALOG` que envuelve cada handler (p. ej. con tracking compartido). Útil cuando quieres ver todos los handlers en una tabla o reducir repetición en el registro.

**Cuándo refactorizar:** no es obligatorio cambiar de estilo solo por preferencia. Tiene sentido **extraer helpers compartidos** (confirmación, `tool_call`, errores) y **dividir por dominio** en más archivos cuando `adapters.ts` crezca o añadas muchas tools nuevas; volver a un mapa de handlers por dominio es una opción razonable si mejora la lectura.

### Política del agente: system prompt vs. reglas en código

- **System prompt** — Texto base del perfil (`profiles.agent_system_prompt`) más **addendums** concatenados en `packages/agent/src/graph.ts` (GitHub, Calendar, saludos, etc.). Cubre muchas variantes de lenguaje natural con instrucciones claras y, si hace falta, ejemplos. El modelo **podría** ignorar parte del texto.
- **Reglas “duras” en código** — `isToolAvailable` en `adapters.ts` y heurísticas en módulos como `chat-greeting-intent.ts` o `calendar-period-intent.ts`: si una tool **no se registra** en LangChain ese turno, el modelo **no puede invocarla**, aunque el prompt diga lo contrario.
- **Recomendación práctica:** ampliar primero el **prompt** (instrucciones del usuario en Ajustes + addendums) para el comportamiento general; usar **filtros en código** cuando haya errores repetidos, costo alto (OAuth, creación de recursos) o ambigüedad que el modelo no respete solo con texto.
- **Trade-off:** muchos patrones regex o condiciones ad hoc implican **mantenimiento**; confiar solo en el prompt implica **menos garantías**. La combinación prompt + registro condicional de tools suele ser el equilibrio más fiable en producción.

## Modelo de datos

Migraciones en `packages/db/supabase/migrations/`:

- `00001_initial_schema.sql` — perfiles, integraciones, sesiones, mensajes, tools, telegram, etc.
- `00002_calendar_booking_links.sql` — enlaces de reserva (`token`, `user_id`, `calendar_id`).
- `00003_scheduled_tasks.sql` — `scheduled_tasks`, `scheduled_task_runs`; extensión del `CHECK` de `agent_sessions.channel` para incluir `cron`.
- `00004_scheduled_tasks_retry.sql` — añade `consecutive_failures` y `last_failure_error` a `scheduled_tasks` para soportar reintentos acotados + auto-pausa (ver sección *Tareas programadas*).
- `00005`–`00012` — memoria larga, user skill settings, assets de perfil y endurecimientos incrementales de Business Brain/memoria.
- `00013_agent_turn_correlation.sql` — agrega `turn_id` a `agent_messages` y `tool_calls` para correlación por turno en UI/logs.
- `00014_heartbeat_runs.sql` — extiende `agent_sessions.channel` con `heartbeat` y crea `heartbeat_runs` con RLS/índices.
- `00015_scheduled_tasks_display_fields.sql` — agrega `user_request` y `display_title` a `scheduled_tasks` para UI legible.

## Seguridad

- **RLS** en tablas con datos de usuario; `calendar_booking_links` solo gestionada por el dueño vía policies. APIs públicas usan **service role** solo en el servidor para resolver el token sin sesión del visitante.
- **Tokens OAuth** cifrados en aplicación (`ENCRYPTION_KEY`).
- **Enlaces /book/**: tratar el token como secreto; HTTPS en producción.

## Canales

- **Web:** POST `/api/chat`, confirmación `POST /api/chat/confirm`.
- **Telegram:** webhook; teclado inline con `✅ Aprobar` / `❌ Cancelar`; al pulsar, feedback inmediato (`answerCallbackQuery` + mensaje corto al chat) antes de reanudar el grafo con `runAgent({ resumeDecision })`.
- **Cron (tareas programadas):** `POST /api/cron/scheduled-tasks` — invocado por jobs programados (p. ej. Supabase `pg_cron`), no por el navegador; autenticación `CRON_SECRET`. Ver subsección *Tareas programadas* arriba.
- **Heartbeat:** `POST /api/cron/heartbeat` — invocado por scheduler externo, crea runs con `agent_sessions.channel='heartbeat'`, allowlist de solo lectura y auditoría en `heartbeat_runs`.
- **Reserva pública:** `GET /book/[token]`, APIs bajo `/api/public/booking/`.

## UI de chat (web)

- Al cargar `/chat`, el servidor trae de Supabase los **últimos 50** mensajes de la sesión web activa (`ORDER BY created_at DESC LIMIT 50`, luego se invierte el orden para mostrar cronológicamente de arriba abajo).
- Los mensajes del **usuario** se muestran como texto plano.
- Los mensajes del **asistente** se renderizan como **Markdown** (`react-markdown` en `apps/web/src/app/chat/chat-interface.tsx`), con estilos vía el plugin `@tailwindcss/typography` cargado en `apps/web/src/app/globals.css`. Los enlaces abren en nueva pestaña (`target="_blank"`, `rel="noopener noreferrer"`).
- El panel derecho "Colaborador en acción" muestra un mini-dashboard con métricas reales y no técnicas: **Heartbeat** (Activo/Inactivo desde `business_brain.heartbeat`), **Programadas** (conteo de `scheduled_tasks` activas) y **Por aprobar** (confirmación HITL pendiente en la vista).
- El panel derecho también muestra Flujo actual, Contexto preparado, Memoria del turno, Habilidades del turno, Herramientas del turno, Aprendizajes recientes y Actividad proactiva. La actividad proactiva combina historial de `heartbeat_runs` y resumen/lista expandible de `scheduled_tasks`.
- El primer incremento de eventos operativos usa SSE: `GET /api/chat/events?turnId=...` y fan-out en memoria (`apps/web/src/lib/agent-turn-events.ts`). La persistencia multi-instancia de eventos sigue pendiente.

## Zona horaria

- `profiles.timezone` almacena un identificador **IANA** (p. ej. `America/Mexico_City`). En el esquema SQL el valor por defecto es `UTC`; si el perfil sigue en `UTC`, las horas y la abreviatura de zona que ve el usuario pueden mostrarse como UTC aunque el evento en Google esté en otra zona.
- El usuario puede fijar la zona en **onboarding** y en **Ajustes** (`/settings`); conviene revisarla tras el primer login si el calendario no coincide con la región esperada.
- Ese campo se pasa a `runAgent()` como `userTimezone` y se usa para interpretar períodos en lenguaje natural, construir `time_min` / `time_max` y el `timeZone` en creación/actualización de eventos en la API de Google.
- La tool `calendar_list_events` devuelve `start_display` y `end_display` ya en la zona del perfil; la abreviatura al final (p. ej. CST) se obtiene con `Intl` en `packages/agent/src/tools/calendar-event-display.ts`.

## Calendario en el agente (reglas en código)

- **Ventana de listado:** `packages/agent/src/tools/calendar-list-window.ts` corrige rangos inválidos o solo pasados y orienta al modelo cuando falta período (`needs_period`).
- **Instrucciones al modelo:** en `packages/agent/src/graph.ts`, el addendum de calendario fija interpretaciones como “esta semana” = semana calendario (lunes–domingo) en la zona del perfil, no “desde ahora + 7 días”.
- **Evitar confusión con GitHub:** si el último mensaje del usuario parece solo una aclaración de período de calendario (`packages/agent/src/tools/calendar-period-intent.ts`), `packages/agent/src/tools/adapters.ts` puede ocultar temporalmente `github_list_repos` / `github_list_issues` para ese turno, de modo que no sustituyan a `calendar_list_events`.
- **Bash vs listado de repos:** si el mensaje indica archivos/carpeta del servidor (`local-shell-intent.ts`), se ocultan `github_list_repos` / `github_list_issues` ese turno para que el modelo use la tool `bash` (si está habilitada). El prompt incluye un addendum en `graph.ts` que lo refuerza.
- **Saludos / presencia:** mensajes como «¿sigues ahí?» o «hola» sin pedir datos (`chat-greeting-intent.ts`) desactivan **todas** las tools de GitHub visibles ese turno (listado y creación); reglas equivalentes en el addendum `GITHUB_SOCIAL_ADDENDUM` en `graph.ts`.
