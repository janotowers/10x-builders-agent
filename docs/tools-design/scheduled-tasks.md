---
name: scheduled-tasks-agent
overview: Agregar soporte de tareas programadas con un nuevo tool del agente, un endpoint cron en Next.js ejecutado cada minuto por Supabase Cron, y notificación por Telegram por defecto (con fallback a log si no hay Telegram vinculado).
todos:
  - id: db-schema-and-queries
    content: Diseñar migración para scheduled_tasks y scheduled_task_runs + queries de lectura/actualización atómica
    status: done
  - id: agent-tool
    content: Agregar tool schedule_task al catálogo, schema y adapter handler
    status: done
  - id: cron-endpoint
    content: Crear endpoint /api/cron/scheduled-tasks con auth CRON_SECRET y ejecución runAgent
    status: done
  - id: telegram-default-notify
    content: Reutilizar/extract util de envío Telegram y registrar fallback sin Telegram
    status: done
  - id: docs-and-env
    content: Actualizar .env.example y documentación de setup de Supabase Cron + pruebas manuales
    status: done
isProject: false
---

# Plan de implementación: tareas programadas del agente

## Objetivo

Implementar una primera versión productiva donde el agente pueda crear tareas programadas (one-time y recurrentes), un cron externo de Supabase ejecute pendientes cada minuto vía endpoint de Next.js, y cada ejecución notifique por Telegram por defecto.

## Diseño técnico propuesto

```mermaid
flowchart TD
  agent[Agent]
  scheduleTool[scheduleTaskTool]
  scheduledTasks[(scheduled_tasks)]
  cronRunner[/api/cron/scheduled-tasks]
  runAgentCall[runAgent]
  telegramAccounts[(telegram_accounts)]
  telegramApi[TelegramBotAPI]
  executionLogs[(scheduled_task_runs)]

  agent --> scheduleTool
  scheduleTool --> scheduledTasks
  cronRunner --> scheduledTasks
  cronRunner --> runAgentCall
  cronRunner --> executionLogs
  cronRunner --> telegramAccounts
  telegramAccounts --> telegramApi
```



## Cambios por capa

- **Base de datos (migraciones + queries)**
  - Crear tabla `scheduled_tasks` con campos mínimos: `id`, `user_id`, `prompt`, `schedule_type`, `run_at`, `cron_expr`, `timezone`, `status`, `last_run_at`, `next_run_at`, `created_at`, `updated_at`.
  - Crear tabla `scheduled_task_runs` para auditoría de ejecuciones: `task_id`, `status`, `started_at`, `finished_at`, `error`, `agent_session_id`.
  - Índices para lectura por minuto (`status`, `next_run_at`) y RLS alineada al patrón existente.
  - Añadir queries en [packages/db/src/queries](../../packages/db/src/queries) para: crear tarea, listar pendientes, bloquear/marcar running, completar/fallar, recalcular `next_run_at` para recurrentes.
- **Tool del agente (creación de tareas)**
  - Registrar nuevo tool en `packages/types/src/catalog.ts` con riesgo `medium` (requiere confirmación humana en el flujo HITL ya existente).
  - Definir schema Zod en `packages/agent/src/tools/schemas.ts` soportando:
    - one-time: `runAt`.
    - recurrente: `cronExpr` + `timezone`.
  - Implementar handler en [packages/agent/src/tools/adapters.ts](../../packages/agent/src/tools/adapters.ts) para persistir en `scheduled_tasks` y devolver resumen legible para el usuario.
- **Runner cron (cada minuto)**
  - Crear endpoint seguro en `apps/web/src/app/api/cron/scheduled-tasks/route.ts` con header secreto (`CRON_SECRET`) para invocación server-to-server desde Supabase Cron.
  - Flujo del endpoint:
    - leer tareas vencidas (`next_run_at <= now`, `status=active`),
    - crear registro de ejecución,
    - invocar `runAgent` por tarea con sesión dedicada de background,
    - marcar resultado y recalcular `next_run_at` (recurrente) o `completed` (one-time).
  - Asegurar idempotencia básica con actualización atómica a estado `running` antes de ejecutar.
  - **Middleware de autenticación**: el endpoint no lleva cookie de sesión de usuario, por lo que debe estar exento del middleware de login de Supabase. En [`apps/web/src/lib/supabase/middleware.ts`](../../apps/web/src/lib/supabase/middleware.ts) existe la variable `isPublicApi` para excluir cualquier ruta bajo `/api/cron/`. Si se agrega un nuevo endpoint cron con una ruta diferente, debe añadirse al mismo bloque:
    ```ts
    const isPublicApi =
      pathname.startsWith("/api/telegram/webhook") ||
      pathname.startsWith("/api/cron/");   // ← cubre todos los endpoints cron
    ```
- **Notificación Telegram por defecto**
  - Reutilizar integración existente de `telegram_accounts` en [packages/db/src/queries/telegram.ts](../../packages/db/src/queries/telegram.ts).
  - Extraer utilitario compartido de envío Telegram (hoy está acoplado al webhook) y usarlo desde el cron runner.
  - Política acordada: si no hay Telegram vinculado, **no falla**; se registra en `scheduled_task_runs` como `notified=false` con motivo `no_telegram_link`.
- **Configuración y documentación**
  - Agregar variables en [apps/web/.env.example](../../apps/web/.env.example): `CRON_SECRET` y cualquier valor adicional necesario para la ruta.
  - Documentar setup operativo en `docs/phase-2-tools-design/`:
    - SQL/migración,
    - creación del cron en Supabase (cada minuto),
    - endpoint y autenticación,
    - ejemplos de prompts para crear tareas.

## Archivos principales a tocar

- `packages/types/src/catalog.ts`
- `packages/agent/src/tools/schemas.ts`
- [packages/agent/src/tools/adapters.ts](../../packages/agent/src/tools/adapters.ts)
- [packages/db/supabase/migrations](../../packages/db/supabase/migrations)
- [packages/db/src/queries](../../packages/db/src/queries)
- `apps/web/src/app/api/cron/scheduled-tasks/route.ts` (nuevo)
- [apps/web/.env.example](../../apps/web/.env.example)
- [apps/web/src/lib/supabase/middleware.ts](../../apps/web/src/lib/supabase/middleware.ts) — añadir la ruta al bloque `isPublicApi` si difiere de `/api/cron/`
- (si aplica) util compartido Telegram en `apps/web/src/lib/telegram/` o `packages/*`

## Validación

- Crear tarea one-time desde chat y verificar fila en `scheduled_tasks`.
- Ejecutar endpoint cron manualmente y validar:
  - registro en `scheduled_task_runs`,
  - llamada a `runAgent`,
  - notificación Telegram enviada.
- Crear tarea recurrente y validar recomputo de `next_run_at` tras ejecución.
- Caso sin Telegram vinculado: ejecución exitosa + log de `notified=false` sin error global.

## HITL en tareas programadas (decisión de diseño)

El usuario ya aprueba la tarea **una sola vez al programarla** (porque `schedule_task` es de riesgo `medium` y dispara su propia tarjeta de confirmación). Si el `prompt` programado a su vez requiere herramientas riesgosas (p. ej. `bash`, `write_file`, `edit_file`, `calendar_create_event`), pedir una **segunda** aprobación al ejecutar rompe el propósito de "programado": el usuario podría no estar disponible a la hora de ejecución y la tarea se perdería en el timeout.

Por eso el endpoint cron invoca `runAgent({ ..., autoApproveTools: true })`. Esta bandera:

- Hace que `toolExecutorNode` en [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) **omita el `interrupt()`** y ejecute la herramienta directo.
- Crea el registro en `tool_calls` con `requires_confirmation = false` y lo marca `approved` para auditoría.
- Solo se activa desde el cron runner; la web y Telegram siguen disparando HITL como siempre.

Implicación de seguridad: cualquier acción que el usuario quiera evitar en ejecución diferida debe filtrarse **al programar**, no al ejecutar. Si en el futuro se quiere ser más conservador (por ejemplo, mantener HITL solo para `bash` o `edit_file`), basta con aceptar una lista de tools auto-aprobadas en lugar del booleano global.

## Gestión de tareas programadas (`manage_scheduled_tasks`)

Una vez que el usuario programa varias tareas, necesita poder revisarlas y
pausar/reanudar sin entrar a Supabase. Para eso existe la tool
`manage_scheduled_tasks` (riesgo `low`) en
[`packages/agent/src/tools/catalog.ts`](../../packages/agent/src/tools/catalog.ts)
y su handler en
[`packages/agent/src/tools/adapters.ts`](../../packages/agent/src/tools/adapters.ts).

Acciones soportadas:

- `action="list"` — devuelve las tareas con status `active` o `paused` del
  usuario autenticado, ordenadas por `next_run_at`. Incluye `id`, `status`,
  `schedule_type`, `cron_expr` o `run_at`, `next_run_at` (ISO) y
  `next_run_local` formateado en la zona horaria del usuario.
- `action="pause"` / `action="resume"` — cambian `status` entre `active` y
  `paused`. Requieren `task_id` (UUID). La DB valida que la tarea pertenezca al
  `user_id` actual (`setScheduledTaskStatus` en
  [`packages/db/src/queries/scheduled-tasks.ts`](../../packages/db/src/queries/scheduled-tasks.ts)),
  por lo que un usuario no puede tocar tareas de otro aunque adivine el id.

Esta tool **no** borra tareas: lo más destructivo es pasar a `paused` (y se
puede deshacer). Por eso no dispara tarjeta HITL. A cambio, el system prompt
(`MANAGE_SCHEDULED_TASKS_ADDENDUM` en `graph.ts`) fuerza al agente a
desambiguar en lenguaje natural antes de ejecutar `pause`/`resume`:

1. Si el usuario da una descripción difusa ("pausa la de Hacker News") y no un
   UUID, el agente llama primero a `list`.
2. Si hay 0 coincidencias, responde que no encontró nada y se detiene.
3. Si hay 1 coincidencia clara, hace UNA pregunta corta de confirmación en
   texto y espera la respuesta antes de actuar.
4. Si hay varias coincidencias, ofrece una lista numerada (con id corto) y
   pide que el usuario elija.

Ejemplos de uso esperados:

- "Muéstrame mis tareas programadas" → `list` y resumen en tabla.
- "Pausa la tarea de Hacker News" con 1 coincidencia → `list` → pregunta
  "¿Pauso esta tarea recurrente …?" → tras "sí" del usuario, `pause(task_id)`.
- "Reanuda la tarea `450b5f0c`" → `resume(task_id)` directo si el id basta
  para identificarla.

## Temperatura del modelo por canal

Las ejecuciones cron (`autoApproveTools=true`) usan `temperature=0.1` y las
interactivas Web/Telegram `0.3` (ver
[`packages/agent/src/model.ts`](../../packages/agent/src/model.ts) y el uso en
`graph.ts`).

Rationale: en cron no hay siguiente turno y el mensaje del agente se manda
directo a Telegram; bajar la temperatura reduce salidas narrativas tipo
"intentaré un enfoque diferente, un momento…" que empujaban al agente a
prometer un reintento que nunca ocurría. En chat interactivo preferimos
mantener `0.3` para respuestas más naturales al usuario. El cap de
`maxTokens` se lee de `OPENROUTER_MAX_TOKENS` (default `2048`) para no
rebotar contra OpenRouter cuando hay poco saldo.

## Política de reintentos y auto-pausa

Migración asociada:
[`00004_scheduled_tasks_retry.sql`](../../packages/db/supabase/migrations/00004_scheduled_tasks_retry.sql).
Añade dos columnas a `scheduled_tasks`:

- `consecutive_failures int default 0` — se incrementa en cada run fallido y
  se resetea a 0 cuando una run completa OK o el usuario reanuda la tarea.
- `last_failure_error text` — mensaje del último error.

Implementada en
[`apps/web/src/app/api/cron/scheduled-tasks/route.ts`](../../apps/web/src/app/api/cron/scheduled-tasks/route.ts)
con dos constantes (`MAX_CONSECUTIVE_FAILURES=3`, `RETRY_GAP_MINUTES=2`).

Flujo cuando una run falla:

1. Se clasifica el error:
   - **Persistente** (contiene `402`, `requires more credits`,
     `insufficient_quota`, `401`, `403`, `400 bad request`): reintentar no va
     a resolverlo y solo gasta créditos. Pasamos directo a auto-pausa.
   - **Transitorio** (cualquier otro): entra al ciclo de reintentos.
2. Si `consecutive_failures + 1 < MAX_CONSECUTIVE_FAILURES` y el error es
   transitorio → agenda `next_run_at = now + RETRY_GAP_MINUTES` y mantiene
   `status='active'`. Para tareas recurrentes, el `next_run_at` se acota al
   mínimo entre `now + gap` y el siguiente tick natural del `cron_expr`, para
   no reintentar "después" del siguiente turno legítimo.
3. Si se alcanza el cap o el error es persistente → `status='paused'`,
   guarda `last_failure_error` y envía un mensaje por Telegram al usuario:

   > ⏸️ Tarea programada pausada. Pausé automáticamente la tarea por
   > {motivo}. Prompt: «…». Cuando lo arregles, pídeme "reanuda la tarea".

4. Un run OK resetea `consecutive_failures=0` y limpia `last_failure_error`
   vía `rescheduleOrComplete`.
5. Cuando el usuario reanuda manualmente con `manage_scheduled_tasks`
   (`action=resume`), también se resetea `consecutive_failures=0` para dar a
   la tarea un "borrón y cuenta nueva" tras el fix.

Esto reemplaza el comportamiento anterior en el que un fallo persistente
dejaba la tarea en `active` sin mover `next_run_at`, generando un run fallido
cada minuto (un "retry storm" visible en `scheduled_task_runs`).
