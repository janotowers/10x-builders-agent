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

#### 7.2 Outlook — pendiente

- [ ] Calendario Outlook / Microsoft Graph (misma estructura base que 7.1 cuando aplique)

#### 7.3 Correo — pendiente

- [ ] Gmail / Outlook — lectura de bandeja, envío con confirmación

#### 7.4 Documentos — pendiente

- [ ] Búsqueda en Google Drive / Notion

### Fase 8: Mejoras de agente

- [ ] Refactor incremental de `packages/agent/src/tools/adapters.ts` cuando el número de tools lo justifique: helpers compartidos, módulos por dominio; opcionalmente mapa `toolId → handler` (ver `docs/architecture.md` — Herramientas)
- [ ] Streaming de respuestas (SSE / WebSocket) en vez de respuesta síncrona
- [ ] Historial de conversaciones múltiples (actualmente una sesión activa por canal)
- [ ] Métricas de uso de tokens LLM por sesión/usuario
- [x] Manejo de expiración y refresh de tokens OAuth (cubierto para Google Calendar; GitHub puede añadirse igual)

### Fase 9: Producción

- [ ] CI/CD (build, lint, type-check, deploy)
- [ ] Variables de entorno en plataforma de deploy (no solo `.env.local`)
- [ ] Monitoring y alertas (errores de agente, fallos de API GitHub)
- [ ] Rate limiting en API routes
