# Heartbeat Deterministic Prefetchers

Heartbeat is an exception-first monitor. For signals that must not depend on the model choosing the right tool at the right time, Heartbeat can run deterministic prefetchers before invoking the LLM.

This capability is scoped to the `heartbeat` channel and to skills marked `heartbeat: native`.

## Why This Exists

Some checks are boolean-like and time-sensitive:

- Is there a calendar event inside the reminder window?
- Is there a calendar event already in progress?
- Is there a Google Task due inside the reminder window?
- In the future: is there a lead, approval, inventory, or system state that crosses a configured threshold?

Those reads should be reliable and visible. A deterministic prefetcher performs the read server-side, records it as a tool call, then injects the resulting signal into the Heartbeat prompt so the model only has to explain the action, not discover the fact.

### Calendar event semantics: upcoming + in progress

The `calendar_events` prefetcher emits a signal in two cases:

1. The event starts inside the lookahead window (with a 60-second backward grace for the "just started" case).
2. The event already started but has not ended yet (in progress).

Case (2) is included on purpose. Without it the prefetcher's count and the LLM-issued `calendar_list_events` disagreed: Google returns events that overlap the requested time window, so the model would surface in-progress meetings while the deterministic block reported zero. That mismatch produced misleading copy ("starts in less than 60 minutes" for a meeting that had already begun) and a confusing `Determinístico 0 / IA N` row in **Herramientas del turno**.

In-progress signals carry two fields callers and the prompt formatter rely on:

- `details.is_in_progress = "yes"` when the event has already started and not yet ended.
- `details.starts_in_minutes` is signed: positive for upcoming starts, **negative** for in-progress events (minutes elapsed since start). `signal.minutesAhead` stays clamped to `>= 0` to preserve the existing sort/threshold contract.

The prompt block prefixes in-progress bullets with `(in progress)` and the deterministic fallback response uses dedicated copy so the LLM (and the fallback path) never describe an in-progress meeting as upcoming.

### Suppression: do not repeat the same meeting every tick

In-progress events are useful once, but can become noisy if Heartbeat runs every few minutes while the user is already in the meeting. The `calendar_events` prefetcher therefore suppresses repeat signals for the same event occurrence when a recent deterministic Heartbeat already surfaced it.

The occurrence key is:

- Google event `id` + event start boundary (`start.dateTime` or `start.date`) when `id` is present.
- Event summary + start boundary as a fallback for events without an id.

The lookup is intentionally lightweight and uses existing state:

- Query recent `tool_calls` in the same heartbeat session.
- Filter `tool_name = 'calendar_list_events'`, `executor_kind = 'deterministic'`, `status = 'executed'`.
- Read emitted events from prior `result_json.events`.
- No new table or migration.

Suppressed items are still written to the new row under `result_json.suppressed_events` with `suppression_reason = 'same_event_occurrence_already_emitted_recently'` for debugging, but they are not returned as active `signals` and do not trigger the deterministic fallback.

To keep the LLM from re-mentioning those items through a fresh tool call, `runHeartbeatPrefetchers()` injects a hidden `[SUPPRESSED HEARTBEAT SIGNALS - DO NOT REPEAT]` block. The model must treat those items as already surfaced and answer the compact no-action response if nothing else crossed a threshold.

This policy is conservative: if an event was already mentioned as upcoming, it should not be mentioned again later merely because it is now in progress. New occurrences of recurring events are unaffected because their start boundary changes.

## Runtime Flow

1. `POST /api/cron/heartbeat` selects due users from `profiles.business_brain.heartbeat`.
2. The route validates the checklist and selects heartbeat-safe skills.
3. Selected skills with `heartbeat: native` may declare `heartbeat_signals` in `SKILL.md`.
4. `runHeartbeatPrefetchers()` groups those signals by `kind`.
5. For each registered kind, the runner checks integration availability and runs the prefetcher once.
6. The prefetcher result is persisted in `tool_calls` with `executor_kind = 'deterministic'`.
7. The same generated `turn_id` is passed to `runAgent()`, so deterministic and LLM-issued tool calls show together in the chat panel.
8. If any deterministic signal crossed a threshold, a compact signal block is injected into the Heartbeat prompt. If signals were detected but suppressed as repeats, a hidden do-not-repeat block is injected instead.
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

## Considered Alternative: Suppress the LLM's Redundant Read (deferred)

Today a Heartbeat tick can produce **two** rows of `calendar_list_events` for the same window: one deterministic prefetch and one issued by the LLM after seeing the prompt. After the in-progress alignment above, both reads agree on what counts as a signal, but the second call still costs an extra Google API request and an additional tool-roundtrip in the LLM step.

A future optimisation ("Option B" in design notes) would:

1. After `runHeartbeatPrefetchers` returns with `status=executed` for a given `kind`, hide the equivalent LLM tool from the heartbeat tool set for that tick (e.g. via a flag in `ToolContext` consumed by `calendarToolEnabled`).
2. Enrich the deterministic prompt block with the **full** event list (not only signals that crossed the threshold), labelled as authoritative for the configured window.

Trade-offs:

- Pro: removes one Google API call and one LLM tool roundtrip per tick per user; eliminates the duplicated `Determinístico` + `IA` row for the same tool.
- Pro: a single source of truth for what the tick "saw".
- Con: loses the model's flexibility to query a different window than the prefetch ran with. Mitigation: only suppress when the prefetch window covers what the active skill requested.
- Con: another conditional path in the tool gate; needs targeted tests for skills without prefetcher coverage and for prefetcher failures (we should NOT hide the tool when the deterministic read failed).

Defer until the doubled API cost or latency becomes a measurable problem (more users, shorter intervals, quota pressure on Google Calendar). When implemented, this section should move from "considered alternative" to "behaviour", and the suppression rule should live next to `calendarToolEnabled` in `packages/agent/src/tools/calendar-adapters.ts` so it stays close to the tool gate it modifies.
