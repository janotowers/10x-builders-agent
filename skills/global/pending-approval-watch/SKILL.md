---
name: pending-approval-watch
description: Detect pending human approvals, failed automations, paused scheduled tasks, or recurring jobs that need intervention. Use in Heartbeat/proactive checks when the checklist mentions approvals, automation failures, scheduled tasks, retries, blocked workflows, or operational maintenance.
scope: shared
allowed_tools:
  - get_user_preferences
  - list_enabled_tools
  - manage_scheduled_tasks
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: native
guardrails: |
  Read-only by default. Only list scheduled tasks; do not pause, resume, cancel, or create tasks automatically.
  Mention only items requiring a concrete decision or repair.
  Paused tasks are not actionable by themselves, especially if they are old, intentionally paused, or already visible in Settings.
  Do not list task IDs, prompts, schedules, or stale paused tasks in the no-action path.
  If no approval or automation crosses the threshold, return only a compact OK/no-action response.
---

# Pending Approval Watch

Use this playbook to detect automation issues that need human attention.

## Workflow

1. List scheduled tasks only when the checklist asks about automation health.
2. Look for:
   - failed or repeatedly failing scheduled tasks;
   - paused tasks only when there is evidence they unintentionally block a current workflow;
   - active tasks with stale next run metadata;
   - human approvals mentioned in the run context.
3. Ignore:
   - old paused tasks with past next-run dates;
   - intentionally paused tasks;
   - informational scheduled tasks that do not block a current workflow;
   - tasks that are merely visible in Settings.
4. Do not mutate task state.
5. If action is needed, ask the user to approve or inspect in Settings.

## Output

- **Automatización**
- **Estado**
- **Por qué requiere atención**
- **Siguiente paso**

If nothing is blocked, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```
