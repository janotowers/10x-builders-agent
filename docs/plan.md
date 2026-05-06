# Plan de Implementación — Colaborador Personal y de Negocio

Construir un agente IA que permita a un usuario **gestionar tareas y ejecutar acciones útiles** desde chat: consultar calendario y correo, buscar documentos, disparar workflows internos, operar GitHub en casos acotados. El sistema debe priorizar **control, trazabilidad, seguridad y costos predecibles** por encima de "autonomía máxima".

## Fases y estado

### Fase 1: Fundaciones ✓

- Monorepo Turborepo con npm workspaces
- `apps/web` — Next.js con App Router + Tailwind
- `packages/agent` — LangGraph JS + tools
- `packages/db` — cliente Supabase + queries tipadas
- `packages/types` — interfaces compartidas
- `packages/config` — tsconfig compartido
- `apps/web/.env.example` con variables necesarias
- Migración SQL con RLS (`00001_initial_schema.sql`)

### Fase 2: Core agente ✓

- Grafo LangGraph con compaction: `compaction → agent → tools → compaction → agent`, con máx 8 iteraciones de tools
- Modelo vía OpenRouter (ChatOpenAI con baseURL), con temperatura/topes por canal (interactivo, cron, heartbeat)
- Catálogo de tools con risk levels
- Adapters LangChain `tool()` con policy (allowlist + integración)
- Persistencia de mensajes en `agent_messages`
- API route `/api/chat` que orquesta todo

### Fase 3: Onboarding y UI ✓

- Login y signup con Supabase Auth
- Middleware de protección de rutas
- Wizard onboarding multi-paso (perfil → agente → tools → revisión)
- Página de chat con interfaz de mensajes y consola "Gu en acción" (panel derecho operativo)
- Página de ajustes (editar perfil, agente, tools, vincular Telegram)
- Redirect inteligente: `/` → `/onboarding` (si no completado) → `/chat`

### Fase 4: Tools con confirmación ✓

- Tools internas: `get_user_preferences`, `list_enabled_tools`
- Tabla `tool_calls` para tracking de estado

**4a. GitHub stubs (primera iteración, reemplazada):**

- Tools GitHub stub: `github_list_repos`, `github_list_issues`, `github_create_issue`
- `github_create_issue` con riesgo "medium" → genera `pending_confirmation`
- Detección de confirmación vía string matching en `/api/chat` (provisional)

**4b. GitHub real con OAuth (segunda iteración, actual):**

- Flujo OAuth completo: `/api/integrations/github/authorize` → GitHub → `/api/integrations/github/callback`
- Protección CSRF con cookie `github_oauth_state` (httpOnly, sameSite, maxAge 600s)
- Cifrado de tokens con AES-256-GCM (`packages/db/src/crypto.ts`)
- Sección GitHub en Settings: conectar / ver estado / desconectar
- Ruta `/api/integrations/github/disconnect` para revocar integración
- Tools GitHub reales contra la API (`github_list_repos`, `github_list_issues`, `github_create_issue`, `github_create_repo`)
- Helper compartido `githubApi()` en `packages/agent/src/tools/github-api.ts`
- Confirmación estructurada: `PendingConfirmation` en `GraphState`, `AgentOutput`, y `shouldContinue`
- El grafo se detiene inmediatamente al encontrar `pendingConfirmation` (sin string matching)
- Ruta `/api/chat/confirm` para aprobar/rechazar desde web
- Botones "Aprobar" / "Cancelar" en la interfaz de chat web
- Descifrado del token GitHub en `/api/chat` y webhook Telegram antes de invocar `runAgent`
- `github_create_repo` como tool nueva (riesgo "high", requiere confirmación)

**Env vars añadidas en esta fase:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXT_PUBLIC_SITE_URL`, `ENCRYPTION_KEY`

### Fase 5: Telegram ✓

- Webhook en `/api/telegram/webhook`
- Comando `/start` con instrucciones
- Comando `/link CODE` para vincular cuenta
- Tabla `telegram_link_codes` con expiración
- Mismo `runAgent()` que web (con `githubToken` incluido)
- Confirmaciones con botones inline (aprobar/rechazar) + ejecución real de la acción GitHub al aprobar
- Setup endpoint `/api/telegram/setup` para registrar webhook

### Fase 6: Documentación ✓

- `docs/architecture.md` — arquitectura técnica viva
- `docs/plan.md` — este archivo

---

### Fase 7: Integraciones adicionales

#### 7.1 Google Calendar ✓

- **7.1.1** OAuth + Settings (“Conectar / desconectar Google Calendar”) + env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, URIs en Google Cloud Console)
- **7.1.2** Tokens en `user_integrations` (`provider: google_calendar`), cifrado JSON (`access_token`, `refresh_token`, `expires_at`), **refresh** automático del access token
- **7.1.3** Tools: `calendar_list_calendars`, `calendar_list_events`, `calendar_create_event` (confirmación), `calendar_update_event`, `calendar_delete_event` (confirmación)
- **7.1.4** Pasar `googleCalendarAccessToken` y `userTimezone` a `runAgent` desde `/api/chat` y Telegram
- **7.1.5** Disponibilidad para terceros: tabla `calendar_booking_links`, `POST /api/calendar/booking-link`, página `/book/[token]`, `GET/POST /api/public/booking/[token]/`* (FreeBusy + reserva), rutas públicas en middleware; límites básicos de reserva

**Refinamientos UX / comportamiento (post-7.1):** Markdown en el chat web para mensajes del asistente; selector de zona horaria en Ajustes; horas locales y abreviatura de zona en listados de eventos; reglas de período y coerción de rangos en el agente (ver `docs/architecture.md`).

**Env vars:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (además de `NEXT_PUBLIC_SITE_URL`, `ENCRYPTION_KEY`)

#### 7.2 Bash en el servidor (opcional) ✓

- Tool `bash` en el catálogo (riesgo alto → confirmación HITL como el resto de acciones sensibles)
- Ejecución one-shot en el host del proceso Node (`bash -lc`), implementación en `packages/agent/src/tools/bashExec.ts`
- Activación por servidor: `BASH_TOOL_ENABLED=true`; directorio de trabajo opcional `BASH_TOOL_CWD`; documentado en `apps/web/.env.example`
- Toggle en onboarding y en Ajustes (misma allowlist que otras tools; no requiere OAuth)
- Diseño y guardrails: **[docs/tools-design/bash-tool.md](tools-design/bash-tool.md)**

#### 7.3 Archivos en el servidor (workspace) ✓

- Tools `read_file` (low), `write_file` (medium, HITL) y `edit_file` (high, HITL) en el catálogo
- Implementación en `packages/agent/src/tools/fileTools.ts` con `resolveSafePath` (sin escape de raíz, sin rutas absolutas, sin null bytes)
- Activación por servidor: `FILE_TOOLS_ENABLED=true` + `FILE_TOOLS_ROOT=<ruta absoluta>`; documentado en `apps/web/.env.example`
- Toggles en onboarding y Ajustes; mensajes de confirmación específicos en `graph.ts`
- Self-test `test:file-tools` (resolveSafePath) + diseño en **[docs/tools-design/files.md](tools-design/files.md)**

#### 7.4 Tareas programadas (schedule_task) ✓

- Tool `schedule_task` (riesgo `medium`, HITL) en el catálogo y `adapters.ts` con validación de fechas/cron via **croner**
- Tablas `scheduled_tasks` y `scheduled_task_runs` en migración `00003_scheduled_tasks.sql` (RLS + índice de runner)
- Campos de UI `user_request` y `display_title` en `scheduled_tasks` (migración `00015_scheduled_tasks_display_fields.sql`) para mostrar la intención original/friendly title en lugar del prompt crudo
- Queries en `packages/db/src/queries/scheduled-tasks.ts`: crear, listar, lock atómico, run, reschedule/complete, Telegram chat_id
- Endpoint cron `/api/cron/scheduled-tasks` — auth `CRON_SECRET`, executa `runAgent`, notifica Telegram (fallback `notified=false`)
- Endpoint autenticado `/api/scheduled-tasks/[id]/status` para pausar/reanudar tareas propias desde Settings
- `apps/web/src/lib/telegram/send-message.ts` — util compartido extraído del webhook
- Middleware exento de auth para `/api/cron/`; `CRON_SECRET` en `.env.example` y `.env.local`
- Toggle en onboarding y Ajustes; confirmación HITL legible; addendum `SCHEDULE_TASK_ADDENDUM` en `graph.ts`
- **HITL único al programar**: `runAgent({ autoApproveTools: true })` desde el cron evita pedir una segunda aprobación al usuario al ejecutar la tarea (ver `toolExecutorNode` y `AgentInput.autoApproveTools` en `graph.ts`). Las llamadas auto-aprobadas se registran en `tool_calls` con `requires_confirmation = false` y `status = approved` para auditoría.
- `agent_sessions.channel` extendido inicialmente a `('web','telegram','cron')` en la migración 00003; luego `00014_heartbeat_runs.sql` agrega `heartbeat`
- Tool `manage_scheduled_tasks` (riesgo `low`, sin HITL) para `list`/`pause`/`resume` de tareas del propio usuario con validación de ownership en DB (`setScheduledTaskStatus(taskId, userId, newStatus)`).
- Desambiguación segura para pausar/reanudar sin UUID explícito: primero listar, luego UNA pregunta corta, y solo ejecutar `pause/resume` tras selección/confirmación del usuario (addendum en `graph.ts`).
- Temperatura por contexto en el modelo: interactivo (Web/Telegram) `~0.3`, cron (`autoApproveTools=true`) `~0.1` para más determinismo en ejecuciones programadas.
- Política de reintentos + auto-pausa (migración `00004_scheduled_tasks_retry.sql`): hasta `MAX_CONSECUTIVE_FAILURES=3` intentos con `RETRY_GAP_MINUTES=2`, salto directo a auto-pausa para errores persistentes (`402`/`401`/`403`/`400`), aviso por Telegram y reset del contador al completar con éxito o al reanudar manualmente.
- Visibilidad en producto: Settings lista tareas activas/pausadas con acciones de pausa/reanudar; panel derecho muestra conteo, próxima ejecución y lista expandible en "Actividad proactiva".
- Diseño en **[docs/tools-design/scheduled-tasks.md](tools-design/scheduled-tasks.md)** + runbook en **[docs/tools-design/runbook-scheduled-tasks.md](tools-design/runbook-scheduled-tasks.md)**

#### 7.5 Skills / playbooks ✓

- Registry global file-based en `skills/global/*/SKILL.md`, con frontmatter validado (`name`, `description`, `scope`, `allowed_tools`, `includes`, `requires_tenant_context`, `memory_extraction`) y referencias opcionales.
- Parser, registry lazy y resolución de composites (`includes`) en `packages/agent/src/skills/`*.
- Selector pre-graph en `runAgent`: una skill dominante por turno o `none`, logging en `turn_summary.log`, y trade-offs documentados en **[docs/tools-design/skill-routing.md](tools-design/skill-routing.md)**.
- Skill activa inyecta playbook al system prompt, puede materializar contexto de tenant, estrecha tools por `allowed_tools`, y permite `read_skill_reference` para referencias progresivas.
- Settings muestra catálogo global agrupado por scope y persiste toggles por usuario en `user_skill_settings`.
- Panel derecho de chat muestra skills candidatas en "Contexto preparado" y skills aplicadas en "Habilidades del turno".

#### 7.6 Heartbeat proactivo ✓

- Configuración por cuenta en `profiles.business_brain.heartbeat`: `enabled`, `interval_minutes`, `checklist_markdown`, `last_run_at`.
- Checklist default versionado en `heartbeat/default-checklist.md`.
- Migración `00014_heartbeat_runs.sql`: canal `agent_sessions.channel='heartbeat'` y tabla `heartbeat_runs` con RLS/índices.
- Endpoint cron `POST /api/cron/heartbeat` con `CRON_SECRET`, selección de usuarios vencidos, ejecución de `runAgent({ channel: "heartbeat" })`, persistencia del resultado y actualización de `last_run_at`.
- Guardrails de runtime: modelo/costo por Heartbeat (`HEARTBEAT_MODEL_ID`, `HEARTBEAT_MAX_TOKENS`), baja temperatura, skip de memory injection y allowlist de tools de solo lectura.
- Settings permite activar/desactivar, configurar intervalo/checklist, resetear default y ver historial reciente.
- Panel derecho muestra Heartbeat en mini-dashboard y en "Actividad proactiva" con historial expandible.

#### 7.7 Outlook — pendiente

- Calendario Outlook / Microsoft Graph (misma estructura base que 7.1 cuando aplique)

#### 7.8 Correo — pendiente

- Gmail / Outlook — lectura de bandeja, envío con confirmación

#### 7.9 Documentos — pendiente

- Búsqueda en Google Drive / Notion

### Fase 8: Mejoras de agente

- **Memoria de corto plazo (compaction):** nodo `compaction` en el grafo LangGraph (`__start__` → compaction → agent; tools → compaction → agent), `GraphState` en `packages/agent/src/state.ts` con `messagesStateReducer` (soporta `RemoveMessage`), microcompact de tool results viejos, compactación LLM con Haiku vía OpenRouter por encima de umbral configurable, circuit breaker y `iterationCount` en estado para preservar `MAX_TOOL_ITERATIONS` tras borrado de mensajes. Diseño y detalle: **[docs/memory/short_memory_plan.md](memory/short_memory_plan.md)**. **Memoria larga (v1, implementada):** `memory_injection_node` + RPC `match_memories` (piso de similitud; default `0.50`, env `MEMORY_MATCH_THRESHOLD`; migración `00008` alinea el default en SQL), `flushSessionMemory` y triggers en `/api/chat` y webhook de Telegram; logs en `packages/agent/logs/memory.log` y `turn_summary.log`. Plan, constantes y roadmap v2: **[docs/memory/long_term_memory_plan.md](memory/long_term_memory_plan.md)**.
- **Multi-proveedor LLM (diseño):** fachada `createChatModel` con elección por env entre OpenRouter y Google (AI Studio / Vertex), canales interactive vs cron vs heartbeat, fallback opcional. Documento de diseño versionado: **[docs/tools-design/model-providers.md](tools-design/model-providers.md)**. Implementación pendiente (plan técnico en `.cursor/plans/` en la máquina de desarrollo).
- Refactor incremental de `packages/agent/src/tools/adapters.ts` cuando el número de tools lo justifique: helpers compartidos, módulos por dominio; opcionalmente mapa `toolId → handler` (ver `docs/architecture.md` — Herramientas)
- **SSE operativo del turno (primer incremento):** `/api/chat/events?turnId=...` + fan-out en memoria para mostrar timeline en vivo del turno en el panel derecho. Pendiente como evolución: persistencia/bus compartido multi-instancia y streaming token-a-token de la respuesta final.
- Historial de conversaciones múltiples (actualmente una sesión activa por canal)
- Métricas de uso de tokens LLM por sesión/usuario
- Manejo de expiración y refresh de tokens OAuth (cubierto para Google Calendar; GitHub puede añadirse igual)
- **Contexto de fecha/hora en el sistema**: en cada turno se inyecta automáticamente en el system prompt la fecha y hora del servidor (ISO), la zona IANA del perfil del usuario (`profiles.timezone`, e.g. `America/Mexico_City`), y la hora local formateada en español. Permite responder "¿qué hora es?" y calcular fechas relativas ("mañana", "la próxima semana") sin herramientas. El timezone se pasa desde web (`/api/chat`) y Telegram (`webhook`) vía `userTimezone` a `runAgent`. **Si el perfil tiene `UTC` en lugar de la zona local, la hora que ve el modelo es incorrecta** — ajustarlo en Ajustes → Perfil o en `profiles.timezone` en Supabase.

### Fase 9: Consola Gu / experiencia operativa ✓

- Shell visual de `/chat` con panel derecho "Colaborador en acción".
- Mini-dashboard superior con métricas reales: Heartbeat Activo/Inactivo, tareas programadas activas y confirmaciones por aprobar.
- Panel operativo con Flujo actual, Contexto preparado, Memoria del turno, Habilidades del turno, Herramientas del turno, Aprendizajes recientes y Actividad proactiva.
- "Actividad proactiva" separa Heartbeat (actividad del sistema) de scheduled tasks (trabajo programado por el usuario), con historiales/listas expandibles.
- Documentación de producto/UI en **[docs/ui/gu-console-plan.md](ui/gu-console-plan.md)**.

### Fase 10: Producción

- CI/CD (build, lint, type-check, deploy)
- Variables de entorno en plataforma de deploy (no solo `.env.local`)
- Monitoring y alertas (errores de agente, fallos de API GitHub)
- Rate limiting en API routes

