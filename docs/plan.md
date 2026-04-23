# Plan de Implementación — Agente Personal MVP

Construir un agente que permita a un usuario **gestionar tareas y ejecutar acciones útiles** desde chat: consultar calendario y correo, buscar documentos, disparar workflows internos, operar GitHub en casos acotados. El sistema debe priorizar **control, trazabilidad, seguridad y costos predecibles** por encima de "autonomía máxima".

## Fases y estado

### Fase 1: Fundaciones ✓

- [x] Monorepo Turborepo con npm workspaces
- [x] `apps/web` — Next.js con App Router + Tailwind
- [x] `packages/agent` — LangGraph JS + tools
- [x] `packages/db` — cliente Supabase + queries tipadas
- [x] `packages/types` — interfaces compartidas
- [x] `packages/config` — tsconfig compartido
- [x] `apps/web/.env.example` con variables necesarias
- [x] Migración SQL con RLS (`00001_initial_schema.sql`)

### Fase 2: Core agente ✓

- [x] Grafo LangGraph: `agent → tools → agent` con máx 6 iteraciones
- [x] Modelo vía OpenRouter (ChatOpenAI con baseURL)
- [x] Catálogo de tools con risk levels
- [x] Adapters LangChain `tool()` con policy (allowlist + integración)
- [x] Persistencia de mensajes en `agent_messages`
- [x] API route `/api/chat` que orquesta todo

### Fase 3: Onboarding y UI ✓

- [x] Login y signup con Supabase Auth
- [x] Middleware de protección de rutas
- [x] Wizard onboarding multi-paso (perfil → agente → tools → revisión)
- [x] Página de chat con interfaz de mensajes
- [x] Página de ajustes (editar perfil, agente, tools, vincular Telegram)
- [x] Redirect inteligente: `/` → `/onboarding` (si no completado) → `/chat`

### Fase 4: Tools con confirmación ✓

- [x] Tools internas: `get_user_preferences`, `list_enabled_tools`
- [x] Tabla `tool_calls` para tracking de estado

**4a. GitHub stubs (primera iteración, reemplazada):**

- [x] Tools GitHub stub: `github_list_repos`, `github_list_issues`, `github_create_issue`
- [x] `github_create_issue` con riesgo "medium" → genera `pending_confirmation`
- [x] Detección de confirmación vía string matching en `/api/chat` (provisional)

**4b. GitHub real con OAuth (segunda iteración, actual):**

- [x] Flujo OAuth completo: `/api/integrations/github/authorize` → GitHub → `/api/integrations/github/callback`
- [x] Protección CSRF con cookie `github_oauth_state` (httpOnly, sameSite, maxAge 600s)
- [x] Cifrado de tokens con AES-256-GCM (`packages/db/src/crypto.ts`)
- [x] Sección GitHub en Settings: conectar / ver estado / desconectar
- [x] Ruta `/api/integrations/github/disconnect` para revocar integración
- [x] Tools GitHub reales contra la API (`github_list_repos`, `github_list_issues`, `github_create_issue`, `github_create_repo`)
- [x] Helper compartido `githubApi()` en `packages/agent/src/tools/github-api.ts`
- [x] Confirmación estructurada: `PendingConfirmation` en `GraphState`, `AgentOutput`, y `shouldContinue`
- [x] El grafo se detiene inmediatamente al encontrar `pendingConfirmation` (sin string matching)
- [x] Ruta `/api/chat/confirm` para aprobar/rechazar desde web
- [x] Botones "Aprobar" / "Cancelar" en la interfaz de chat web
- [x] Descifrado del token GitHub en `/api/chat` y webhook Telegram antes de invocar `runAgent`
- [x] `github_create_repo` como tool nueva (riesgo "high", requiere confirmación)

**Env vars añadidas en esta fase:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXT_PUBLIC_SITE_URL`, `ENCRYPTION_KEY`

### Fase 5: Telegram ✓

- [x] Webhook en `/api/telegram/webhook`
- [x] Comando `/start` con instrucciones
- [x] Comando `/link CODE` para vincular cuenta
- [x] Tabla `telegram_link_codes` con expiración
- [x] Mismo `runAgent()` que web (con `githubToken` incluido)
- [x] Confirmaciones con botones inline (aprobar/rechazar) + ejecución real de la acción GitHub al aprobar
- [x] Setup endpoint `/api/telegram/setup` para registrar webhook

### Fase 6: Documentación ✓

- [x] `docs/architecture.md` — arquitectura técnica viva
- [x] `docs/plan.md` — este archivo

---

### Fase 7: Integraciones adicionales

#### 7.1 Google Calendar ✓

- [x] **7.1.1** OAuth + Settings (“Conectar / desconectar Google Calendar”) + env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, URIs en Google Cloud Console)
- [x] **7.1.2** Tokens en `user_integrations` (`provider: google_calendar`), cifrado JSON (`access_token`, `refresh_token`, `expires_at`), **refresh** automático del access token
- [x] **7.1.3** Tools: `calendar_list_calendars`, `calendar_list_events`, `calendar_create_event` (confirmación), `calendar_update_event`, `calendar_delete_event` (confirmación)
- [x] **7.1.4** Pasar `googleCalendarAccessToken` y `userTimezone` a `runAgent` desde `/api/chat` y Telegram
- [x] **7.1.5** Disponibilidad para terceros: tabla `calendar_booking_links`, `POST /api/calendar/booking-link`, página `/book/[token]`, `GET/POST /api/public/booking/[token]/*` (FreeBusy + reserva), rutas públicas en middleware; límites básicos de reserva

**Refinamientos UX / comportamiento (post-7.1):** Markdown en el chat web para mensajes del asistente; selector de zona horaria en Ajustes; horas locales y abreviatura de zona en listados de eventos; reglas de período y coerción de rangos en el agente (ver `docs/architecture.md`).

**Env vars:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (además de `NEXT_PUBLIC_SITE_URL`, `ENCRYPTION_KEY`)

#### 7.2 Bash en el servidor (opcional) ✓

- [x] Tool `bash` en el catálogo (riesgo alto → confirmación HITL como el resto de acciones sensibles)
- [x] Ejecución one-shot en el host del proceso Node (`bash -lc`), implementación en `packages/agent/src/tools/bashExec.ts`
- [x] Activación por servidor: `BASH_TOOL_ENABLED=true`; directorio de trabajo opcional `BASH_TOOL_CWD`; documentado en `apps/web/.env.example`
- [x] Toggle en onboarding y en Ajustes (misma allowlist que otras tools; no requiere OAuth)
- [x] Diseño y guardrails: **[docs/tools-design/bash-tool.md](tools-design/bash-tool.md)**

#### 7.3 Archivos en el servidor (workspace) ✓

- [x] Tools `read_file` (low), `write_file` (medium, HITL) y `edit_file` (high, HITL) en el catálogo
- [x] Implementación en `packages/agent/src/tools/fileTools.ts` con `resolveSafePath` (sin escape de raíz, sin rutas absolutas, sin null bytes)
- [x] Activación por servidor: `FILE_TOOLS_ENABLED=true` + `FILE_TOOLS_ROOT=<ruta absoluta>`; documentado en `apps/web/.env.example`
- [x] Toggles en onboarding y Ajustes; mensajes de confirmación específicos en `graph.ts`
- [x] Self-test `test:file-tools` (resolveSafePath) + diseño en **[docs/tools-design/files.md](tools-design/files.md)**

#### 7.4 Tareas programadas (schedule_task) ✓

- [x] Tool `schedule_task` (riesgo `medium`, HITL) en el catálogo y `adapters.ts` con validación de fechas/cron via **croner**
- [x] Tablas `scheduled_tasks` y `scheduled_task_runs` en migración `00003_scheduled_tasks.sql` (RLS + índice de runner)
- [x] Queries en `packages/db/src/queries/scheduled-tasks.ts`: crear, listar, lock atómico, run, reschedule/complete, Telegram chat_id
- [x] Endpoint cron `/api/cron/scheduled-tasks` — auth `CRON_SECRET`, executa `runAgent`, notifica Telegram (fallback `notified=false`)
- [x] `apps/web/src/lib/telegram/send-message.ts` — util compartido extraído del webhook
- [x] Middleware exento de auth para `/api/cron/`; `CRON_SECRET` en `.env.example` y `.env.local`
- [x] Toggle en onboarding y Ajustes; confirmación HITL legible; addendum `SCHEDULE_TASK_ADDENDUM` en `graph.ts`
- [x] **HITL único al programar**: `runAgent({ autoApproveTools: true })` desde el cron evita pedir una segunda aprobación al usuario al ejecutar la tarea (ver `toolExecutorNode` y `AgentInput.autoApproveTools` en `graph.ts`). Las llamadas auto-aprobadas se registran en `tool_calls` con `requires_confirmation = false` y `status = approved` para auditoría.
- [x] `agent_sessions.channel` extendido a `('web','telegram','cron')` en la misma migración 00003
- [x] Tool `manage_scheduled_tasks` (riesgo `low`, sin HITL) para `list`/`pause`/`resume` de tareas del propio usuario con validación de ownership en DB (`setScheduledTaskStatus(taskId, userId, newStatus)`).
- [x] Desambiguación segura para pausar/reanudar sin UUID explícito: primero listar, luego UNA pregunta corta, y solo ejecutar `pause/resume` tras selección/confirmación del usuario (addendum en `graph.ts`).
- [x] Temperatura por contexto en el modelo: interactivo (Web/Telegram) `~0.3`, cron (`autoApproveTools=true`) `~0.1` para más determinismo en ejecuciones programadas.
- [x] Política de reintentos + auto-pausa (migración `00004_scheduled_tasks_retry.sql`): hasta `MAX_CONSECUTIVE_FAILURES=3` intentos con `RETRY_GAP_MINUTES=2`, salto directo a auto-pausa para errores persistentes (`402`/`401`/`403`/`400`), aviso por Telegram y reset del contador al completar con éxito o al reanudar manualmente.
- [x] Diseño en **[docs/tools-design/scheduled-tasks.md](tools-design/scheduled-tasks.md)** + runbook en **[docs/tools-design/runbook-scheduled-tasks.md](tools-design/runbook-scheduled-tasks.md)**

#### 7.5 Outlook — pendiente

- [ ] Calendario Outlook / Microsoft Graph (misma estructura base que 7.1 cuando aplique)

#### 7.6 Correo — pendiente

- [ ] Gmail / Outlook — lectura de bandeja, envío con confirmación

#### 7.7 Documentos — pendiente

- [ ] Búsqueda en Google Drive / Notion

### Fase 8: Mejoras de agente

- [x] **Memoria de corto plazo (compaction):** nodo `compaction` en el grafo LangGraph (`__start__` → compaction → agent; tools → compaction → agent), `GraphState` en `packages/agent/src/state.ts` con `messagesStateReducer` (soporta `RemoveMessage`), microcompact de tool results viejos, compactación LLM con Haiku vía OpenRouter por encima de umbral configurable, circuit breaker y `iterationCount` en estado para preservar `MAX_TOOL_ITERATIONS` tras borrado de mensajes. Diseño y detalle: **[docs/memory/short_memory_plan.md](memory/short_memory_plan.md)**. **Memoria larga (v1, implementada):** `memory_injection_node` + RPC `match_memories` (piso de similitud; default `0.50`, env `MEMORY_MATCH_THRESHOLD`; migración `00008` alinea el default en SQL), `flushSessionMemory` y triggers en `/api/chat` y webhook de Telegram; logs en `packages/agent/logs/memory.log` y `turn_summary.log`. Plan, constantes y roadmap v2: **[docs/memory/long_term_memory_plan.md](memory/long_term_memory_plan.md)**.
- [ ] **Multi-proveedor LLM (diseño):** fachada `createChatModel` con elección por env entre OpenRouter y Google (AI Studio / Vertex), canales interactive vs cron, fallback opcional. Documento de diseño versionado: **[docs/tools-design/model-providers.md](tools-design/model-providers.md)**. Implementación pendiente (plan técnico en `.cursor/plans/` en la máquina de desarrollo).
- [ ] Refactor incremental de `packages/agent/src/tools/adapters.ts` cuando el número de tools lo justifique: helpers compartidos, módulos por dominio; opcionalmente mapa `toolId → handler` (ver `docs/architecture.md` — Herramientas)
- [ ] Streaming de respuestas (SSE / WebSocket) en vez de respuesta síncrona
- [ ] Historial de conversaciones múltiples (actualmente una sesión activa por canal)
- [ ] Métricas de uso de tokens LLM por sesión/usuario
- [x] Manejo de expiración y refresh de tokens OAuth (cubierto para Google Calendar; GitHub puede añadirse igual)
- [x] **Contexto de fecha/hora en el sistema**: en cada turno se inyecta automáticamente en el system prompt la fecha y hora del servidor (ISO), la zona IANA del perfil del usuario (`profiles.timezone`, e.g. `America/Mexico_City`), y la hora local formateada en español. Permite responder "¿qué hora es?" y calcular fechas relativas ("mañana", "la próxima semana") sin herramientas. El timezone se pasa desde web (`/api/chat`) y Telegram (`webhook`) vía `userTimezone` a `runAgent`. **Si el perfil tiene `UTC` en lugar de la zona local, la hora que ve el modelo es incorrecta** — ajustarlo en Ajustes → Perfil o en `profiles.timezone` en Supabase.

### Fase 9: Producción

- [ ] CI/CD (build, lint, type-check, deploy)
- [ ] Variables de entorno en plataforma de deploy (no solo `.env.local`)
- [ ] Monitoring y alertas (errores de agente, fallos de API GitHub)
- [ ] Rate limiting en API routes
