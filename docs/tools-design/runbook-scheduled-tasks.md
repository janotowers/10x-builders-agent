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
| `prompt` | text | Instrucción que se enviará al agente |
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

Agrega a tu `.env.local`:
```
CRON_SECRET=un-token-secreto-largo-y-aleatorio
```

### 3. Configurar Supabase Cron

En el panel de Supabase → **Database → Extensions**, activa `pg_cron`.

Luego en **Database → Cron Jobs**, crea un nuevo job:

```sql
SELECT cron.schedule(
  'run-scheduled-tasks',          -- nombre del job
  '* * * * *',                    -- cada minuto
  $$
    SELECT net.http_post(
      url := 'https://TU_DOMINIO/api/cron/scheduled-tasks',
      headers := '{"Authorization": "Bearer TU_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);
```

> Reemplaza `TU_DOMINIO` con tu dominio de producción y `TU_CRON_SECRET` con el valor de `CRON_SECRET`.

### Desarrollo local

`pg_cron` en Supabase solo puede llamar a URLs **públicas**. No alcanza `http://localhost:3000`. Opciones:

- Exponer el dev server con **ngrok** (u otro túnel) y usar en el job `url := 'https://TU_SUBDOMINIO.ngrok-free.app/api/cron/scheduled-tasks'`.
- O, cuando quieras probar sin cron, llamar el endpoint a mano con `curl` (ver más abajo) **después** de la hora en `next_run_at`.

El servidor Next debe estar en marcha en el momento en que se dispare el POST.

**Alternativa con Supabase Edge Functions:**
Crea una Edge Function que haga el `fetch` al endpoint cada minuto usando `Deno.cron`.

### 4. Habilitar el tool para el usuario

El tool `schedule_task` tiene riesgo `medium`, por lo que requiere que el usuario lo habilite en Ajustes → Herramientas.

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
