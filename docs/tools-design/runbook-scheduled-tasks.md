# Tareas programadas (Scheduled Tasks)

## Arquitectura

```
Usuario (chat)
    │  "Recuérdame revisar mis issues el lunes a las 9 AM"
    ▼
Agente  ──[schedule_task tool]──► scheduled_tasks (DB)
                                        │
                              (next_run_at <= now)
                                        │
Supabase Cron ──► POST /api/cron/scheduled-tasks
                        │
                        ├──► runAgent(prompt del usuario)
                        ├──► scheduled_task_runs (audit)
                        └──► Telegram sendMessage (por defecto)
```

## Tablas nuevas

### `scheduled_tasks`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `user_id` | uuid | FK → profiles |
| `prompt` | text | Instrucción ejecutable que se enviará al agente |
| `user_request` | text | Texto original del usuario cuando se programó la tarea (migración `00015`) |
| `display_title` | text | Título corto amigable para UI (migración `00015`) |
| `schedule_type` | text | `one_time` o `recurring` |
| `run_at` | timestamptz | Para one_time: cuándo ejecutar |
| `cron_expr` | text | Para recurring: expresión cron de 5 campos |
| `timezone` | text | IANA timezone (ej. `America/Bogota`) |
| `status` | text | `active`, `paused`, `completed`, `failed` |
| `last_run_at` | timestamptz | Última ejecución |
| `next_run_at` | timestamptz | Próxima ejecución (índice para el runner) |

### `scheduled_task_runs`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `task_id` | uuid | FK → scheduled_tasks |
| `status` | text | `running`, `completed`, `failed` |
| `started_at` | timestamptz | Inicio de ejecución |
| `finished_at` | timestamptz | Fin de ejecución |
| `error` | text | Mensaje de error si falló |
| `agent_session_id` | uuid | Sesión del agente usada (canal `cron`) |
| `notified` | boolean | Si se envió notificación Telegram |
| `notification_error` | text | Razón si no se notificó |

## Setup

### 1. Aplicar la migración SQL

En el panel de Supabase → SQL Editor, ejecuta el contenido de:

```
packages/db/supabase/migrations/00003_scheduled_tasks.sql
```

O con la CLI de Supabase:
```bash
supabase db push
```

### 2. Variables de entorno

Agrega a tu `apps/web/.env.local`:

```bash
# Secreto compartido con el scheduler externo (Supabase pg_cron, Cloud Scheduler, etc.).
# Debe coincidir con Authorization: Bearer <CRON_SECRET> en cada POST /api/cron/*.
CRON_SECRET=un-token-secreto-largo-y-aleatorio

# Límite de tareas programadas vencidas que el cron procesa en paralelo por tick.
# Default 5, mínimo 1, máximo 20. Evita ráfagas de runAgent si muchas tareas vencen a la vez.
# SCHEDULED_TASKS_CONCURRENCY=5

# Límite de casos operacionales procesados en paralelo por tick del cron de casos.
# Default 5, mínimo 1, máximo 20. Ver docs/operational-cases/architecture.md §4.
# OPERATIONAL_CASES_CONCURRENCY=5
```

Generar un secreto seguro: `openssl rand -hex 32`.

### 3. Configurar el runner cron

Los endpoints `/api/cron/*` comparten el mismo patrón operativo: un scheduler externo hace `POST` a una URL pública de Next.js con `Authorization: Bearer <CRON_SECRET>`. Cada handler valida el secreto, toma registros vencidos y ejecuta el agente con el canal correspondiente.

| Endpoint | Propósito | Concurrencia en código |
|----------|-----------|------------------------|
| `POST /api/cron/scheduled-tasks` | Tareas que el usuario programó (`schedule_task`) | `SCHEDULED_TASKS_CONCURRENCY` (default 5) |
| `POST /api/cron/heartbeat` | Pulso proactivo por checklist | `HEARTBEAT_CONCURRENCY` = 5 (fijo) |
| `POST /api/cron/operational-cases` | Casos operacionales vencidos + recordatorios | `OPERATIONAL_CASES_CONCURRENCY` (default 5) |

En despliegues GCP, la opción recomendada es **Cloud Scheduler**. En Supabase, **pg_cron + pg_net**.

Headers comunes en todos los jobs:

- `Authorization: Bearer TU_CRON_SECRET`
- `Content-Type: application/json`
- Body: `{}`

#### Stagger de schedules (recomendado)

Los tres runners son subsistemas distintos y deben seguir separados. El problema a evitar no es que coexistan, sino que **disparen exactamente al mismo segundo** y generen picos de CPU, LLM y DB.

`pg_cron` usa cron de 5 campos (sin segundos). Desfasa por **minuto**:

| Job | Expresión pg_cron | Frecuencia efectiva |
|-----|-------------------|---------------------|
| `run-scheduled-tasks` | `* * * * *` | Cada minuto (prioridad: puntualidad de tareas one-time) |
| `run-operational-cases` | `1-59/2 * * * *` | Cada minuto impar (:01, :03, :05…) — latencia máx. ~1 min extra, aceptable para casos multi-día |
| `run-heartbeat` | `2-57/5 * * * *` | Cada 5 min en :02, :07, :12… — el handler filtra usuarios vencidos por `interval_minutes` |

En **GCP Cloud Scheduler** puedes usar las mismas expresiones de minuto o, si tu job admite cron de 6 campos, desfasar por segundo (`20 * * * * *`, `40 * * * * *`, etc.).

Si ya tienes jobs en `* * * * *` para los tres, no es incorrecto funcionalmente; solo aumenta la probabilidad de picos. Al migrar, desactiva el job viejo antes de crear el nuevo (`SELECT cron.unschedule('nombre-viejo');`).

#### Supabase Cron (`pg_cron + pg_net`)

En el panel de Supabase → **Database → Extensions**, activa `pg_cron` y `pg_net`.

Luego en **Database → Cron Jobs** (o SQL Editor):

```sql
-- Tareas programadas: cada minuto
SELECT cron.schedule(
  'run-scheduled-tasks',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://TU_DOMINIO/api/cron/scheduled-tasks',
      headers := '{"Authorization": "Bearer TU_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);

-- Casos operacionales: minutos impares (stagger respecto a scheduled-tasks)
SELECT cron.schedule(
  'run-operational-cases',
  '1-59/2 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://TU_DOMINIO/api/cron/operational-cases',
      headers := '{"Authorization": "Bearer TU_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);

-- Heartbeat: cada 5 min con offset :02 (handler decide usuarios vencidos)
SELECT cron.schedule(
  'run-heartbeat',
  '2-57/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://TU_DOMINIO/api/cron/heartbeat',
      headers := '{"Authorization": "Bearer TU_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);
```

> Reemplaza `TU_DOMINIO` con tu dominio de producción y `TU_CRON_SECRET` con el valor de `CRON_SECRET`.

> El intervalo por usuario de Heartbeat vive en `profiles.business_brain.heartbeat.interval_minutes`. El scheduler solo hace un tick global; el endpoint decide qué usuarios están vencidos usando `last_run_at + interval_minutes`.

#### GCP Cloud Scheduler (resumen)

Crea tres jobs HTTP `POST` con el mismo `CRON_SECRET` y las URLs anteriores. Usa las mismas expresiones de stagger o equivalentes en la zona horaria del despliegue.

### Desarrollo local

Los schedulers en la nube no pueden llamar `http://localhost:3000`.

**Desarrollo normal (UI, chat, settings):**

- Usa `http://localhost:3000` directamente.
- **No dejes ngrok + jobs de Supabase apuntando a tu máquina** salvo que estés probando cron/Telegram/webhooks en ese momento. Si el scheduler externo sigue activo mientras desarrollas, tu `next dev` recibirá `POST /api/cron/*` cada minuto y competirá con compilación/HMR.

**Pruebas de integraciones externas:**

- **Telegram / webhooks:** expón con ngrok solo mientras pruebas; registra el webhook y apágalo al terminar si no lo necesitas.
- **Cron:** expón con ngrok **temporalmente** o dispara a mano con `curl` (ver abajo) después de la hora en `next_run_at`.
- **Alternativa robusta en local:** usa un `CRON_SECRET` distinto al de producción/Supabase para que los jobs en la nube no autoricen contra tu `.env.local` aunque el túnel siga abierto.

El servidor Next debe estar en marcha en el momento en que se dispare el POST.

**Alternativa con Supabase Edge Functions:**
Crea una Edge Function que haga el `fetch` al endpoint cada minuto usando `Deno.cron`. Mantén la misma separación de endpoints y el mismo `CRON_SECRET`.

### 4. Habilitar los tools para el usuario

En Ajustes → Herramientas, habilita para el usuario:

- `schedule_task` (riesgo `medium`) — necesario para que el agente pueda crear tareas programadas.
- `manage_scheduled_tasks` (riesgo `low`) — necesario para que el usuario pueda **listar**, **pausar** o **reanudar** sus tareas desde el chat. Si no está habilitado, el agente solo sabrá crear tareas pero no podrá mostrarlas ni pausarlas.

## Uso desde el chat

### Tarea de una sola vez
```
Recuérdame el viernes 11 de abril a las 9 AM revisar el estado de los issues de GitHub del repo lab10/agents
```
El agente llamará a `schedule_task` con:
- `schedule_type: "one_time"`
- `run_at: "2026-04-11T09:00:00-05:00"`
- `prompt: "Revisa el estado de los issues de GitHub del repo lab10/agents"`

### Tarea recurrente
```
Todos los lunes a las 8 AM quiero que me des un resumen de los issues abiertos de mi repo principal
```
El agente llamará a `schedule_task` con:
- `schedule_type: "recurring"`
- `cron_expr: "0 8 * * 1"`
- `timezone: "America/Bogota"` (si está configurado en el perfil)

### Listar, pausar y reanudar tareas (`manage_scheduled_tasks`)

Ejemplos conversacionales una vez que el tool `manage_scheduled_tasks` esté habilitado:

```
Muéstrame mis tareas programadas
```
Responde con la lista de tareas `active` + `paused` del usuario, incluyendo
id, schedule_type, `cron_expr` / `run_at`, y el próximo `next_run_local` en
la zona horaria del perfil.

```
Pausa la tarea de Hacker News
```

Flujo esperado (sin auto-match silencioso):
1. Si el agente no tiene un `task_id` UUID, llama primero a
   `manage_scheduled_tasks(action=list)`.
2. Si hay varias tareas que podrían encajar, ofrece opciones numeradas y
   pregunta cuál.
3. Si hay una sola coincidencia clara, hace UNA pregunta corta de
   confirmación ("¿Pauso esta tarea? …resumen…") y espera "sí" antes de
   actuar.
4. Solo después de la confirmación explícita ejecuta
   `manage_scheduled_tasks(action=pause, task_id=<UUID>)` y responde con el
   nuevo estado.

```
Reanuda la tarea 450b5f0c
```
Si el fragmento es suficiente para identificar la tarea, el agente puede
listar primero para obtener el UUID completo y después llamar `resume`.

Nota: `manage_scheduled_tasks` **no** dispara tarjeta HITL porque el cambio
es reversible (pause ↔ resume) y está aislado a tareas del mismo usuario
(validado por `user_id` en la query). Toda la protección está en el prompt
(`MANAGE_SCHEDULED_TASKS_ADDENDUM` en
[`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts)) que
exige confirmación en lenguaje natural antes de pausar/reanudar.

### Visibilidad en producto

Las tareas programadas tienen dos superficies:

- **Settings:** lista de tareas `active` y `paused`, próxima corrida, último error y controles de pausar/reanudar.
- **Panel "Gu en acción":** resumen operativo de automatizaciones programadas por el usuario: próxima tarea, conteo activas/pausadas y último fallo si aplica.

Esto se mantiene separado de Heartbeat: Heartbeat es actividad proactiva del sistema desde `heartbeat_runs`; scheduled tasks son instrucciones explícitas del usuario en `scheduled_tasks` con auditoría en `scheduled_task_runs`.

### Referencia de expresiones cron
| Expresión | Significado |
|-----------|-------------|
| `0 9 * * 1` | Cada lunes a las 9 AM |
| `0 8 * * 1-5` | Lunes a viernes a las 8 AM |
| `0 */6 * * *` | Cada 6 horas |
| `0 9 1 * *` | El 1ro de cada mes a las 9 AM |
| `*/15 * * * *` | Cada 15 minutos |

## Notificaciones Telegram

Por defecto, cada ejecución envía el resultado al chat de Telegram vinculado. El mensaje empieza por **«📬 Resultado automático (tarea programada)»** para distinguirlo del mensaje anterior del bot («He programado…») cuando el usuario aprobó la tarea.

Si el usuario **no tiene Telegram vinculado**, la ejecución continúa normalmente y se registra `notified=false` con motivo `no_telegram_link` en `scheduled_task_runs`. No se lanza error.

## HITL en ejecución del cron

El usuario aprueba la tarea **una sola vez** al programarla (la tarjeta de confirmación de `schedule_task` ya cubre el riesgo). Cuando el cron ejecuta la tarea, llama a `runAgent({ ..., autoApproveTools: true })`, lo que **omite el `interrupt()` de las herramientas internas**, incluso si son de riesgo medio/alto (`bash`, `write_file`, `edit_file`, `calendar_create_event`, etc.).

Razón: una tarea programada que requiere reaprobación a la hora de ejecución no es realmente "programada" — si el usuario está dormido o lejos del teléfono, la tarea se pierde. Toda decisión de seguridad debe tomarse al programar, no al ejecutar.

Para auditoría, las llamadas auto-aprobadas se registran igualmente en `tool_calls` con `requires_confirmation = false` y `status = approved` antes de ejecutarse.

## Temperatura del modelo por canal

`createChatModel()` en [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts) acepta `temperature`. `graph.ts` selecciona:

- `temperature = 0.3` para ejecuciones interactivas (Web / Telegram).
- `temperature = 0.1` para ejecuciones **cron** (`autoApproveTools=true`).

Motivación: en cron no hay "siguiente turno" para recuperarse — el texto que el modelo genere se envía tal cual a Telegram. Con temperatura alta el modelo tiende a producir frases tipo *"intentaré un enfoque diferente, un momento por favor"* como si fuese a retomar después, cuando en realidad el turno ya terminó. Bajándola a 0.1 se reducen esas salidas narrativas y el modelo prefiere devolver resúmenes concretos (aunque sean parciales). En chat interactivo seguimos en 0.3 para que las respuestas suenen naturales.

El cap `maxTokens` se lee de `OPENROUTER_MAX_TOKENS` (default `2048`) para evitar el rechazo `402 This request requires more credits` de OpenRouter cuando el saldo es bajo.

## Retries y auto-pausa de tareas que fallan

Tras la migración
[`00004_scheduled_tasks_retry.sql`](../../packages/db/supabase/migrations/00004_scheduled_tasks_retry.sql)
las tareas programadas llevan dos campos extra:

| Columna                | Uso                                                                   |
| ---------------------- | --------------------------------------------------------------------- |
| `consecutive_failures` | Nº de runs fallidos seguidos. Se resetea a 0 en OK o al reanudar.     |
| `last_failure_error`   | Texto del último error (expuesto al usuario cuando se auto-pausa).    |

**Política (hardcoded en el runner, fácil de ajustar):**

- `MAX_CONSECUTIVE_FAILURES = 3` intentos seguidos.
- `RETRY_GAP_MINUTES = 2` minutos entre reintentos.

**Flujo cuando una run falla:**

1. Si el error parece persistente (contiene `402`, `requires more credits`,
   `401`, `403`, `400 bad request`, `insufficient_quota`) → auto-pausa
   inmediata, sin quemar los 3 intentos. Reintentar no va a arreglar crédito
   o credenciales.
2. Si es transitorio y `consecutive_failures + 1 < 3` → agenda
   `next_run_at = now + 2 min` y sigue `active`. Para recurrentes, acota al
   mínimo entre `now + 2 min` y el siguiente tick natural del cron, para no
   reintentar "después" del próximo turno legítimo.
3. Si el contador llega al cap → pasa a `paused` y manda por Telegram un
   aviso con el último error y el prompt afectado ("⏸️ Tarea programada
   pausada…"). El usuario puede inspeccionar `scheduled_tasks.last_failure_error` y luego pedir
   "reanuda la tarea" en chat.

**Efecto en `scheduled_task_runs`:** antes una tarea con error persistente
generaba un run fallido por minuto (p. ej. un `402` de OpenRouter). Con esta
política, genera como máximo 1 run (si es persistente) o 3 runs espaciados
~2 min (si es transitorio) y luego se auto-pausa hasta intervención
humana.

**Resetear una tarea pausada:** pedirle al agente "reanuda la tarea X" o el
UUID; `manage_scheduled_tasks(action=resume)` pone la tarea en `active` y
resetea `consecutive_failures` a 0 (borrón y cuenta nueva).

## Pruebas manuales

### Verificar que el tool funciona
1. Habilita `schedule_task` en Ajustes → Herramientas.
2. En el chat escribe: "Programa una tarea para dentro de 2 minutos que me diga hola".
3. Confirma la acción cuando el agente la solicite.
4. Revisa la tabla `scheduled_tasks` en Supabase.

### Disparar el cron manualmente
```bash
curl -X POST https://TU_DOMINIO/api/cron/scheduled-tasks \
  -H "Authorization: Bearer TU_CRON_SECRET" \
  -H "Content-Type: application/json"
```

Respuesta esperada:
```json
{
  "processed": 1,
  "results": [{ "task_id": "...", "status": "ok" }]
}
```

### Verificar ejecución
Revisa en Supabase:
- `scheduled_task_runs`: debe haber un registro con `status=completed`
- `agent_sessions`: debe existir una sesión con `channel=cron`
- `agent_messages`: debe tener los mensajes de esa sesión
- Si tienes Telegram vinculado, debes recibir el mensaje
