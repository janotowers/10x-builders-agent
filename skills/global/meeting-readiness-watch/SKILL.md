---
name: meeting-readiness-watch
description: Detect upcoming meetings that require a timely reminder, preparation, logistics check, or context brief. Use only in Heartbeat/proactive checklist checks for meeting readiness, calendar conflicts, prep gaps, or reminder windows. Do not produce daily agenda briefs.
scope: personal
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - calendar_list_tasks
  - list_user_memories
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
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
guardrails: |
  Read-only. Never create, update, or delete calendar events, tasks, reminders, or messages.
  Treat calendar events as signals to evaluate, not as content to summarize.
  Notify only when there is a concrete action, timing reminder, conflict, missing prep, or missing context.
  A meeting or Google Calendar task inside the checklist reminder window (for example 60, 30, or 15 minutes) is actionable as a timing reminder.
  A normal upcoming meeting or task outside the reminder window is not actionable by itself. Do not list meetings or tasks just because they exist.
  If nothing crosses the checklist threshold, return only a compact OK/no-action response.
---

# Meeting Readiness Watch

Use this playbook when Heartbeat needs to monitor upcoming meetings without creating periodic agenda noise.

## Workflow

1. Read the checklist threshold and `notify_when` before calling tools.
2. Use `calendar_list_events` and `calendar_list_tasks` only for the narrow window needed by the checklist:
   - reminder windows such as 60, 30, or 15 minutes before a meeting;
   - the next 24 hours for conflict or prep-gap detection;
   - today only when the checklist explicitly asks for day-level readiness.
3. Evaluate only actionable meeting signals:
   - meeting starts inside the configured reminder window and the user likely needs a timely reminder;
   - Google Calendar task is due inside the configured reminder window and the user likely needs a timely reminder;
   - overlapping events or impossible transitions;
   - missing agenda, link, location, attendee, or preparation context;
   - prospect/client meeting where a mini brief would reduce friction;
   - decision or material required before the meeting.
4. Ignore normal calendar facts:
   - do not list today's agenda;
   - do not mention meetings or tasks outside the configured reminder window that have no required action;
   - do not report event/task names, times, links, or duration in the no-action path;
   - do not create "preparation gaps" from generic uncertainty.
5. If a mini brief is useful, keep it to the smallest helpful context and label unknowns clearly.

## Output

If action is needed, use the user's language and include only:

- **Señal**
- **Por qué importa ahora**
- **Acción recomendada**

If no item crosses the threshold, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```

