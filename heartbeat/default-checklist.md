# Heartbeat checklist (legacy reference)

> Deprecated as a runtime source.
>
> The canonical built-in Heartbeat templates now live in
> `packages/agent/src/heartbeat/checklist.ts` as `HEARTBEAT_CHECKLIST_TEMPLATES`.
> Settings uses those templates for the user-facing reset/template flow. Keep
> this file only as historical context for the original MVP checklist.

## Original MVP checklist

- Revisa agenda de hoy y próximos compromisos.
- Resume pendientes clave, decisiones abiertas y riesgos accionables del día.
- Detecta bloqueos operativos solo si hay algo concreto que impide avanzar, requiere intervención o tiene urgencia clara.
- No clasifiques preferencias generales, datos de perfil, estilo de comunicación o contexto del negocio como bloqueos.
- Si no hay bloqueos reales, dilo explícitamente y no rellenes la sección con información incidental.
