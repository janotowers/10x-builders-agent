---
name: personal-day-briefing
description: Prepare a concise personal day briefing from the user's calendar and known preferences, or schedule a recurring brief that runs automatically. Use when the user asks for today's agenda, daily briefing, morning briefing, what they have today, how to plan the day, a personal/work mixed overview of the day, OR explicitly asks to program/schedule a daily/recurring brief. Do not use for warehouse metrics or file/document processing.
scope: personal
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - manage_scheduled_tasks
  - schedule_task
includes: []
requires_tenant_context: false
guardrails: |
  Read-only by default. Do not create, update, or delete anything unless the user explicitly asks for it.
  `schedule_task` is allowed only when the user explicitly asks to program or schedule the brief (e.g. "programa un brief diario", "agenda el brief cada mañana"); never schedule on your own initiative.
  Do not create calendar events to simulate scheduling — use `schedule_task` for recurring agent runs.
  Distinguish confirmed calendar events from suggestions.
---

# Personal Day Briefing

You either create a compact briefing for the user's day right now, or schedule one to run automatically on a recurring basis.

## Workflow

1. Detect intent first:
   - "give me today's brief / what do I have today / agenda" → produce the brief now (steps 2-5).
   - "program / schedule / set up a daily brief / brief every X" → use `schedule_task` to register a recurring task whose `prompt` describes the brief you would produce (steps 6-7). Do NOT create a calendar event in this case.
   - **If the current turn is the automatic execution of an already-scheduled task** (the runner injects a "Nota de ejecución" reminder), produce the brief NOW (steps 2-5). Do NOT call `schedule_task` again — the task is already programmed.
2. Determine the target date. If the user says "today", use the system-provided local date and timezone.
3. Use `calendar_list_events` when available to inspect the relevant day.
4. Optionally use `manage_scheduled_tasks` only to list existing scheduled tasks if the user asks about reminders or recurring agent tasks.
5. Summarize the day in a useful order:
   - fixed events and meetings;
   - travel/prep gaps if obvious;
   - important reminders or follow-ups mentioned by the user;
   - suggested focus blocks.
6. When scheduling a recurring brief: build a `cron_expr` from the user's natural-language frequency (e.g. "cada 10 minutos" → `*/10 * * * *`, "todos los días a las 7" → `0 7 * * *`) and call `schedule_task` with `schedule_type: "recurring"`. Use the user's timezone.
7. The `prompt` you persist for the scheduled task must instruct future runs to produce a brief: list today's calendar events, key pending items from preferences/memory, and a practical recommendation. Keep it self-contained so a future automated turn can execute it without conversational context.

## Briefing style

- Keep it short and scannable.
- Use local times.
- Do not over-plan empty time unless the user asks for a detailed plan.
- If calendar access is unavailable, say so and offer to draft a plan from user-provided commitments.

## Output template

Use Spanish unless the user asks otherwise:

- **Agenda:** key events with times.
- **Preparacion:** what to review or bring.
- **Sugerencia:** one practical recommendation for the day.
