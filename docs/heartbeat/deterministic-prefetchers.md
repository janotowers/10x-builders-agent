# Heartbeat Deterministic Prefetchers

Heartbeat is an exception-first monitor. For signals that must not depend on the model choosing the right tool at the right time, Heartbeat can run deterministic prefetchers before invoking the LLM.

This capability is scoped to the `heartbeat` channel and to skills marked `heartbeat: native`.

## Why This Exists

Some checks are boolean-like and time-sensitive:

- Is there a calendar event inside the reminder window?
- Is there a Google Task due inside the reminder window?
- In the future: is there a lead, approval, inventory, or system state that crosses a configured threshold?

Those reads should be reliable and visible. A deterministic prefetcher performs the read server-side, records it as a tool call, then injects the resulting signal into the Heartbeat prompt so the model only has to explain the action, not discover the fact.

## Runtime Flow

1. `POST /api/cron/heartbeat` selects due users from `profiles.business_brain.heartbeat`.
2. The route validates the checklist and selects heartbeat-safe skills.
3. Selected skills with `heartbeat: native` may declare `heartbeat_signals` in `SKILL.md`.
4. `runHeartbeatPrefetchers()` groups those signals by `kind`.
5. For each registered kind, the runner checks integration availability and runs the prefetcher once.
6. The prefetcher result is persisted in `tool_calls` with `executor_kind = 'deterministic'`.
7. The same generated `turn_id` is passed to `runAgent()`, so deterministic and LLM-issued tool calls show together in the chat panel.
8. If any deterministic signal crossed a threshold, a compact signal block is injected into the Heartbeat prompt.
9. If the model still collapses to `Pulso OK`, the route falls back to a deterministic response generated from the prefetch output.

## Skill Contract

Heartbeat-native skills declare deterministic signals in frontmatter:

```yaml
heartbeat: native
heartbeat_signals:
  - id: meeting-reminder-window
    kind: calendar_events
    reminder_window_minutes: 60
    description: Upcoming Google Calendar event inside the reminder window.
  - id: task-reminder-window
    kind: calendar_tasks
    reminder_window_minutes: 60
    description: Google Calendar task whose due date falls inside the reminder window.
```

Fields:

- `id`: stable slug within the skill.
- `kind`: registered signal family. Current values: `calendar_events`, `calendar_tasks`.
- `reminder_window_minutes`: default lookahead window for the prefetcher.
- `description`: optional author-facing explanation.

The parser validates this in `packages/agent/src/skills/parse.ts`, stores it in `SkillMetadata.heartbeatSignals`, and `resolveSkill()` aggregates it into `ResolvedSkill.heartbeatSignals`.

## Checklist Thresholds

Checklist items can override the skill default using structured metadata:

```md
- Detectar reuniones próximas; Umbral: reunión dentro de 30 minutos; Avisar cuando: hay acción concreta; Ventana_minutos: 30.
```

`packages/agent/src/heartbeat/checklist.ts` parses this into `HeartbeatChecklistItem.reminderWindowMinutes`.

If `Ventana_minutos` / `reminder_window` is missing, the parser tries to infer a window from the threshold text, e.g. `60 minutos`, `30 min`, `2 horas`, `90 minutes`, `1 hour`.

The runner uses the largest applicable window across matching checklist items and the skill default, so one broader checklist item is not accidentally under-fetched.

## Prefetcher Registry

The registry lives in:

- `packages/agent/src/heartbeat/prefetchers/types.ts`
- `packages/agent/src/heartbeat/prefetchers/registry.ts`

Current implementations:

- `calendar_events` -> `calendar_list_events`
- `calendar_tasks` -> `calendar_list_tasks`

A prefetcher implements:

- `kind`: signal kind it handles.
- `toolName`: persisted tool name, matching the user-visible tool.
- `isAvailable(env)`: integration/scope/token check.
- `run(env, input)`: deterministic read returning arguments, result, status, and prompt-ready signals.

## Persistence and UI

Deterministic prefetchers are persisted in `tool_calls`, not in a separate Heartbeat-only UI structure.

`tool_calls.executor_kind` distinguishes:

- `agent`: the LLM issued the tool call.
- `deterministic`: the system issued the read before the LLM as part of Heartbeat.

The chat panel renders both inside **Herramientas del turno**. Rows are differentiated by an `IA` or `Determinístico` badge. There is intentionally no separate "Señales del pulso" panel.

`heartbeat_runs.payload` keeps traceability fields:

- `deterministicToolCallIds`
- `deterministicSkipped`

The actual fetched data lives in `tool_calls.result_json`.

## Adding a New Prefetcher

1. Add a new `HeartbeatSignalKind` in `packages/agent/src/skills/types.ts`.
2. Add a prefetcher under `packages/agent/src/heartbeat/prefetchers/`.
3. Register it in `packages/agent/src/heartbeat/prefetchers/registry.ts`.
4. Ensure the equivalent user-facing tool exists in `TOOL_CATALOG` if it should appear as a normal tool.
5. Add `heartbeat_signals` to the relevant `heartbeat: native` skill.
6. Add tests for parsing, signal aggregation, and checklist threshold handling.

## Non-Goals

- This is not a general replacement for LLM tool use.
- Not every Heartbeat tool needs a prefetcher.
- Prefetchers should be used for threshold-like signals where reliability, latency, or observability matters.
- Write actions remain out of scope for Heartbeat unless explicitly approved through a future HITL design.
