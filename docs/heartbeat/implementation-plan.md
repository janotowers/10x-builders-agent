# Heartbeat Implementation Plan

Execution plan to deliver proactive Heartbeat end-to-end and keep status updated as implementation progresses.

Last updated: 2026-05-05 (PR-5 in progress)
Owner: Agent team (web + agent + db)
Status: In progress (PR-5 started)

---

## Goal

Ship a production-ready Heartbeat that runs proactively per account, safely and cost-effectively, with clear visibility in product UI.

Definition of done:

- Users can enable/disable Heartbeat and configure interval/checklist in Settings.
- Cron runs Heartbeat automatically for due users.
- Runs are persisted in `heartbeat_runs` and visible to users.
- Heartbeat tool execution is restricted to read-only allowlisted tools.
- Runtime and model settings are cost-controlled and channel-aware.

---

## Scope

In scope (V1):

- New channel `heartbeat` for agent sessions.
- New DB table `heartbeat_runs`.
- New cron endpoint `POST /api/cron/heartbeat`.
- Checklist-driven execution using `business_brain.heartbeat`.
- Settings UI for heartbeat toggle, interval, checklist markdown.
- Basic run history in Settings.

Out of scope (later):

- Multi-instance durable turn-events stream for full timeline replay.
- Voice and multimodal presence.
- Autonomous write actions without explicit approvals.

---

## Work Plan By Phase

## Phase 1 - DB and channel foundation

Objective: add schema support for channel-aware heartbeat execution and audit logging.

Tasks:

- [x] Add migration extending `agent_sessions.channel` CHECK with `'heartbeat'`.
- [x] Add migration for `heartbeat_runs` table:
  - [x] `id`, `user_id`, `session_id`, `started_at`, `finished_at`, `status`, `payload`, `error`.
  - [x] indexes for user/time queries.
- [x] Add/verify RLS:
  - [x] user can read own runs.
  - [x] service role can write/read for cron processing.
- [x] Update shared DB/types package exports for `heartbeat_runs`.

Exit criteria:

- Migrations apply cleanly in local/staging.
- Type-check passes with new channel/type usage.

---

## Phase 2 - Runtime heartbeat cron endpoint

Objective: execute proactive heartbeat runs from cron using existing scheduled-task cron patterns.

Tasks:

- [x] Create `apps/web/src/app/api/cron/heartbeat/route.ts`.
- [x] Reuse cron auth pattern (`CRON_SECRET`) from scheduled tasks.
- [x] Select due users from `profiles.business_brain.heartbeat`:
  - [x] `enabled === true`
  - [x] due by `interval_minutes` (default 30)
- [x] For each due user:
  - [x] load profile/context/tools/skills/integrations.
  - [x] get/create session with `channel='heartbeat'`.
  - [x] build synthetic message from checklist markdown.
  - [x] run `runAgent(...)` with heartbeat channel.
  - [x] write run result into `heartbeat_runs`.
  - [x] update heartbeat `last_run_at`.
- [x] Add bounded concurrency and robust per-user error handling.

Exit criteria:

- Cron route processes due users and stores run records.
- Partial failures do not stop the whole batch.

Operational note:

- The route does not self-trigger. Each environment must configure an external scheduler that calls `POST /api/cron/heartbeat` with `Authorization: Bearer <CRON_SECRET>`.
- For production on GCP, use Cloud Scheduler. For local end-to-end testing, expose `localhost:3000` with ngrok or call the endpoint manually.
- Keep this aligned with `POST /api/cron/scheduled-tasks`: same secret and scheduler pattern, separate endpoints and audit tables.

---

## Phase 3 - Safety and cost controls

Objective: guarantee heartbeat stays safe/read-only and cost-bounded.

Tasks:

- [x] Extend runtime channel typing (`web | telegram | cron | heartbeat`) in agent inputs/state.
- [x] Apply channel-aware behavior in `runAgent`:
  - [x] heartbeat model override via `HEARTBEAT_MODEL_ID`.
  - [x] low temperature and bounded output tokens.
- [x] Enforce heartbeat tool allowlist in tool availability checks.
- [x] Explicitly block risky tools on heartbeat (`bash`, writes, creates/sends, scheduling mutation).
- [x] Keep memory policies channel-aware per roadmap intent (cron/heartbeat behavior consistent).

Exit criteria:

- Heartbeat cannot execute blocked risky tools.
- Runtime logs show expected channel/model/allowlist decisions.

---

## Phase 4 - Settings UI (MVP operator-ready)

Objective: let users configure heartbeat without SQL edits.

Tasks:

- [x] Add bundled template file `heartbeat/default-checklist.md`.
- [x] Add Heartbeat section to Settings:
  - [x] Enable/disable toggle.
  - [x] Interval minutes input (default 30).
  - [x] Checklist markdown editor.
  - [x] Reset-to-default checklist action.
- [x] Persist to `profiles.business_brain.heartbeat`.
- [x] Validate and normalize inputs:
  - [x] minimum/maximum interval guardrails.
  - [x] checklist max length guardrail.

Exit criteria:

- User can enable heartbeat, save checklist/interval, and route reads this configuration.

---

## Phase 5 - Product visibility and operator UX

Objective: expose heartbeat outcomes and presence in product.

Tasks:

- [x] Add heartbeat history list in Settings using `heartbeat_runs`.
- [x] Show last run status/time/summary.
- [x] Add lightweight heartbeat status indicators in Gu panel where appropriate.
- [x] Keep wording explicit about best-effort live vs durable data.

Exit criteria:

- User can verify heartbeat is running and inspect recent outcomes without logs/SQL.
- User can see a lightweight Heartbeat presence indicator in the Gu operational panel.

---

## Phase 6 - Optional integrations and hardening

Objective: improve operator confidence and reliability for broader rollout.

Tasks:

- [ ] Optional Telegram digest for linked accounts (best-effort; non-blocking).
- [ ] Add run metrics and alert-friendly logs.
- [ ] Add retry/backoff policy for persistent user-level failures.
- [ ] Add tests:
  - [ ] unit tests for due-user selection and guardrails.
  - [ ] integration tests for cron route + DB writes.

Exit criteria:

- Stable behavior under errors and predictable operation at expected scale.

---

## Delivery slices (PR sequence)

1. PR-1: DB migrations + channel/type plumbing.
2. PR-2: `/api/cron/heartbeat` runner and persistence.
3. PR-3: tool/model guardrails for heartbeat channel.
4. PR-4: Settings heartbeat controls + default checklist seed.
5. PR-5: heartbeat history/presence UI.
6. PR-6: optional Telegram digest + hardening/tests.

---

## Tracking rules for this document

When implementation starts, update this file in each PR:

- change task checkboxes `[ ] -> [x]` for completed work.
- add "Status updates" entries with date + PR reference.
- keep "Last updated" current.
- record any scope changes under "Decisions log".

### Status updates

- 2026-05-05: Plan created. No implementation started yet.
- 2026-05-05: PR-1 started. Added migration `00014_heartbeat_runs.sql` with `agent_sessions.channel` extended to include `heartbeat`, plus `heartbeat_runs` table, indexes, and RLS policies.
- 2026-05-05: Channel type plumbing started (`@agents/types`, `@agents/db`, `@agents/agent`) to accept `heartbeat`.
- 2026-05-05: Added initial DB query helpers for heartbeat runs (`createHeartbeatRun`, `finishHeartbeatRun`, `listHeartbeatRuns`) and exported them from `@agents/db`.
- 2026-05-05: PR-2 implemented `POST /api/cron/heartbeat` with due-user selection from `business_brain.heartbeat`, per-user heartbeat run execution (`runAgent` with `channel='heartbeat'`), persistence in `heartbeat_runs`, and `last_run_at` updates.
- 2026-05-05: PR-3 implemented heartbeat guardrails: strict read-only allowlist in tool availability, runtime channel propagation into graph state, memory-injection skip for heartbeat, and model-by-channel support (`HEARTBEAT_MODEL_ID`, optional `HEARTBEAT_MAX_TOKENS`).
- 2026-05-05: PR-4 implemented Settings controls for heartbeat (`enabled`, `interval_minutes`, `checklist_markdown`) persisted via `/api/business-brain`, with reset-to-default and input guardrails.
- 2026-05-05: PR-5 started. Added Settings visibility for latest heartbeat run and recent `heartbeat_runs` history, and tightened the default checklist/prompt so generic preferences are not classified as operational blockers.
- 2026-05-05: PR-5 expanded to the Gu panel: Heartbeat is shown as proactive presence, while scheduled tasks are shown separately as user-programmed automations.
- 2026-05-05: Refined the Gu panel copy to "Actividad proactiva", added a heartbeat-style pulse indicator, localized statuses, and removed redundant live-status copy from that block.

### Decisions log

- 2026-05-05: Heartbeat remains distinct from `scheduled_tasks`; both reuse cron infrastructure but have different data models and product semantics.
