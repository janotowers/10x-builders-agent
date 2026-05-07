# Skills y política por herramienta en automatizaciones

## Contexto

Las tareas programadas (`scheduled_tasks`) y Heartbeat ejecutan turnos automáticos. Algunas automatizaciones necesitan más que una tool aislada: requieren un playbook/skill, varios pasos y varias herramientas. Un ejemplo claro es un brief diario, que debería poder usar `personal-day-briefing` para leer calendario, preferencias y producir una salida consistente.

El riesgo no es que una automatización use skills. El riesgo es que una autorización amplia convierta cualquier herramienta sensible en autoaprobada. Por eso el modelo correcto no es "solo read-only", sino una política explícita por herramienta y, cuando aplique, por operación.

## Política por herramienta

Cada tool en una automatización puede resolverse a uno de estos modos:

- `auto_execute`: se ejecuta sin HITL porque está preautorizada para esta automatización.
- `request_approval`: puede proponerse, pero debe crear una aprobación pendiente antes de ejecutarse.
- `deny`: no está disponible en este contexto.

Para tools multipropósito, la política puede ser más específica:

- `manage_scheduled_tasks:list`: `auto_execute`
- `manage_scheduled_tasks:pause`: `request_approval`
- `manage_scheduled_tasks:resume`: `request_approval`

Esto evita que un brief diario pida aprobación humana cada mañana solo por listar tareas programadas, sin abrir la puerta a pausarlas o reanudarlas automáticamente.

## Tareas programadas

Una tarea programada debe poder persistir:

- `skill_id`: skill asociada al prompt programado, si aplica.
- `tool_approval_policy`: mapa JSONB con la política por tool/operación.

Al programar una tarea:

1. Se ejecuta el selector de skills sobre el prompt que se guardará.
2. Si hay match y el skill está habilitado, se guarda `skill_id`.
3. Se construye una política inicial desde `allowed_tools`, riesgo de `TOOL_CATALOG` y reglas especiales de operación.

Política base recomendada:

- Tools low/read-only incluidas en el skill: `auto_execute`.
- Tools medium/high incluidas en el skill: `request_approval` salvo autorización explícita.
- Tools fuera del skill: `deny`.

## Heartbeat

Heartbeat debe ser más conservador que `scheduled_tasks` porque no nace de una instrucción concreta por corrida. Recomendación:

- Permitir skills solo si son `heartbeat-safe`.
- En el primer corte, un skill es heartbeat-safe si todas sus tools permitidas pasan la allowlist read-only del canal `heartbeat`.
- Acciones de escritura/envío desde Heartbeat deben quedar como `request_approval` o requerir una configuración explícita de comportamiento.

## Relación con HITL

HITL sigue siendo el mecanismo de mitigación para acciones sensibles. La diferencia es que en automatizaciones necesitamos decidir dónde aparece la interrupción:

- Si la tool está `auto_execute`, corre.
- Si está `request_approval`, se crea una confirmación pendiente en web/Telegram.
- Si está `deny`, el modelo recibe un resultado de tool indicando que esa acción no está permitida en ese contexto.

El booleano legacy `autoApproveTools` debe mantenerse solo como fallback mientras se migra a `tool_approval_policy`.

## Caso inicial: brief diario

Para `personal-day-briefing`:

- `get_user_preferences`: `auto_execute`
- `calendar_list_events`: `auto_execute`
- `manage_scheduled_tasks:list`: `auto_execute`
- `manage_scheduled_tasks:pause`: `request_approval`
- `manage_scheduled_tasks:resume`: `request_approval`
- Otras tools: `deny` salvo que el usuario las preautorice al programar.

