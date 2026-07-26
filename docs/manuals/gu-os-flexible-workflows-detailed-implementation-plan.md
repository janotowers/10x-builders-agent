# Gu OS — Flexible Workflows: Detailed Implementation Plan (Executable Checklist)

**Governing source:** `docs/manuals/gu-os-flexible-workflows-technical-plan.md` (the Technical Plan), itself subordinate to `docs/manuals/gu-os-flexible-workflows-architecture-analysis.md`. This document translates — it does not redesign. If implementation reveals a material contradiction with the Technical Plan, record it in **§X Contradiction log** and request a decision; do not silently redesign.

**How to use this document:** work top-to-bottom within a slice; slices within a phase may interleave only where *Depends on* allows. Update checkboxes and the per-slice **Status** line as you go. `[ ]` pending · `[x]` done · `[~]` in progress · `[!]` blocked (add note).

---

## 0. Global conventions (read once, apply everywhere)

**Repository facts this plan is grounded on (verified 2026-07-26):**

- Latest migration: `packages/db/supabase/migrations/00063_publication_operations_and_notification_uniqueness.sql`. New migrations start at **`00064`**. Known duplicate numbers `00036`/`00044`/`00045` exist and are a Phase 0 task.
- Selftests run via `tsx` npm scripts inside `apps/web` (e.g. `cd apps/web && npm run test:business-decisions`). There is **no root test aggregator and no CI** — root scripts are `build`, `dev`, `lint`, `type-check` (turbo).
- Key modules: `packages/db/src/queries/operational-cases.ts` (exports incl. `getDueOperationalCases` L290, `markCaseProcessing` L318, `updateOperationalCase` L363, `insertOperationalCaseEvent` L416, `associateExternalResponseWithCase` L526); `apps/web/src/lib/business-decisions/pending-decision-router.ts` (`PendingDecisionTurn` L97); `apps/web/src/lib/business-decisions/price-approval.ts`; `apps/web/src/app/api/cron/operational-cases/route.ts`; `apps/web/src/app/api/cron/scheduled-tasks/route.ts` (`autoApproveTools: true` L242); `packages/agent/src/graph.ts` (step-bound skill L1194–1206; per-step BigQuery L380–398); `packages/agent/src/tools/operational-cases-adapters.ts` (guards, `PROPERTY_OPTIONING_STEP_ORDER`, intake successor); lab at `apps/web/src/app/settings/operational-case-types/` and `apps/web/src/app/api/tool-readiness/`.

**Standing rules (from the Technical Plan; enforced on every slice):**

1. Everything is **additive and flagged**; v1 behavior unchanged when flags are off.
2. Every new table: `user_id` + RLS (owner read / service-role write) + append-only triggers for event streams (copy the `operational_case_events` trigger pattern from `00019`).
3. Every new query helper takes `userId: string` as a **required** parameter.
4. Terminology: never `heartbeat` for claim liveness — use *executor liveness / liveness update / lease renewal / stale claim / stale-claim recovery*. `Gu OS Heartbeat` = proactive feature only (`api/cron/heartbeat` remains correctly named).
5. Agent assertions are claims; gates emit **evidence records** pinned to artifact hashes.
6. Case vocabulary and work vocabulary never mix (UI or schema).
7. New shared runtime primitives live in a new **`packages/workflows`** package [D — name tentative] so `apps/web` and `packages/agent` consume the *same* evaluator/dispatcher/verifier objects (parity rule).
8. Per-slice definition of done always includes: `npm run type-check` and `npm run lint` clean at root; affected selftest scripts green; new selftests wired into an npm script.

**Verification commands:** `cd apps/web && npm run test:business-decisions` · `npm run test:readiness-test-ui` · `npm run test:publication-workflow` · `npm run test:step-decision` (etc. per `apps/web/package.json` L11–20); root `npm run type-check && npm run lint`.

---

## PHASE 0 — Instrument & fix

### Slice 0.1 — Residual-intent preservation

**Status:** [ ] pending
**Objective:** a gate that claims a turn reports the text it did not consume; the composed response acknowledges it. Silent loss → visible loss.

**Tasks (ordered):**
- [ ] 1. Read `pending-decision-router.ts` L78–120 and map every `handled: true` return site (L347, 438, 463, 520, 586, 616, 657, 769).
- [ ] 2. Extend the handled branch of `PendingDecisionTurn` (L97) with `residual?: { text: string; reason: "unparsed_remainder" | "unmatched_intent" } | null`.
- [ ] 3. In each deterministic parser that claims a prefix/pattern (`parsePriceApprovalDecision` and the gate-3+ handlers), compute the unconsumed remainder (text minus the matched decision segment, trimmed; empty ⇒ `null`).
- [ ] 4. Populate `residual` at every `handled: true` return site.
- [ ] 5. In the channel adapters that render the handler `message` (web chat + Telegram paths that consume `resolvePendingDecisionTurn`), append a fixed-format acknowledgment line when `residual` is non-empty: "No actué sobre: “…”".
- [ ] 6. Append a case event (`insertOperationalCaseEvent`, `event_type: "residual_reported"` [D]) when residual is non-empty and a case is bound.

**Modify:** `apps/web/src/lib/business-decisions/pending-decision-router.ts`, `price-approval.ts`, gate handlers in `business-decisions/`, the adapter call sites (locate via grep for `resolvePendingDecisionTurn`). **Create:** none. **Migrations:** none. **Types:** the union-branch extension only. **UI:** message text only. **Tests:** extend `pending-decision-router.selftest.ts` + `price-approval.selftest.ts` — mixed-intent fixture asserts `residual` non-empty and message contains the acknowledgment; single-intent fixture asserts `residual` null. **Flags:** none (additive field; absence = current behavior). **Security:** none new. **Evidence:** selftests green; a Scenario-B fixture shows the acknowledgment string. **Rollback:** revert commit. **Depends on:** nothing.

### Slice 0.2 — Price-approval amount binding (Finding 3)

**Status:** [ ] pending
**Objective:** a bare approval that names an amount different from the proposal on record clarifies instead of approving.

**Tasks:**
- [ ] 1. In `price-approval.ts`, add an amount extractor for the approval branch (reuse the existing `adjust`-branch amount parsing for `salida=`/`ideal=`/`minimo=` as the pattern base; add bare `$X` / `X millones` forms).
- [ ] 2. In the handler (approval path around L176–200): if the parsed text names an amount and it differs from `context.pricing_proposal` (compare against `salida`/`ideal` per the proposal's own semantics — confirm which field a bare approval targets [A, ask if ambiguous]), return a clarification `message` and **do not** call `updateOperationalCase`; append event `price_approval_amount_mismatch` [D].
- [ ] 3. Tolerance rule: exact-match after normalization (thousands separators, "millones" scaling); no fuzzy tolerance in this slice.

**Modify:** `apps/web/src/lib/business-decisions/price-approval.ts`. **Tests:** extend `price-approval.selftest.ts`: "Aprobar $4.8 millones" vs proposal 5.2M ⇒ no approval + clarification; "Aprobar" bare ⇒ approves as today; "Aprobar $5.2 millones" matching ⇒ approves. **Flags:** none — this is a correctness fix. **Rollback:** revert. **Acceptance:** the three fixtures above; router selftest unaffected. **Depends on:** 0.1 (shares parser edits; do 0.1 first to avoid rebase).

### Slice 0.3 — Scheduled-task tool-risk allowlist (Finding 15)

**Status:** [ ] pending
**Objective:** no medium/high-risk tool executes from a scheduled task without an explicit allowlist entry.

**Tasks:**
- [ ] 1. Read `apps/web/src/app/api/cron/scheduled-tasks/route.ts` L200–260 and `apps/web/src/lib/operational-cases/operational-case-cron-tool-policy.ts` (+ its selftest) — the operational-case cron's narrow policy is the model.
- [ ] 2. Create `apps/web/src/lib/scheduled-tasks/scheduled-task-tool-policy.ts` [D]: risk-scoped allowlist defaulting to the low-risk set; per-task `toolApprovalPolicy` may *narrow*, never widen.
- [ ] 3. Replace `autoApproveTools: true` (L242) with the policy object; non-allowlisted tool calls route to the pending inbox (existing HITL path) instead of auto-executing.
- [ ] 4. Add `scheduled-task-tool-policy.selftest.ts` and wire an npm script (`test:scheduled-task-policy`).

**Modify:** `scheduled-tasks/route.ts`. **Create:** policy module + selftest. **Flags/compat:** env escape hatch `SCHEDULED_TASKS_LEGACY_AUTOAPPROVE=true` for one release [D], default off. **Risks (expected, per plan):** tasks that silently depended on auto-approval start landing in the inbox — information, not regression; log each occurrence. **Evidence:** selftest proves `calendar_delete_event` / `telegram_send_message_to_contact` / `easybroker_publish_listing` are not auto-approved; a seeded task run shows inbox routing. **Rollback:** env flag on → prior behavior. **Depends on:** nothing.

### Slice 0.4 — Instrumentation and metrics

**Status:** [ ] pending
**Objective:** the measurements the go/no-go thresholds need: case volume, step durations, correction frequency/targets, retry counts.

**Tasks:**
- [ ] 1. Derive step durations and volumes from existing data first: `operational_case_events` already timestamps `state_changed` — write read-only queries in `packages/db/src/queries/operational-case-metrics.ts` [D] (all take `userId` or an explicit admin-wide flag gated on `is_ungga_admin`).
- [ ] 2. Add correction detection: count `operational_case_update_intake` writes that overwrite an existing non-null key (instrument at the adapter in `packages/agent/src/tools/operational-cases-adapters.ts` by appending event `fact_overwritten` [D] with key name — no behavior change).
- [ ] 3. Minimal dashboard: extend the existing operational-cases admin page or add a settings section rendering the metrics queries (server component; no new client state). Keep it crude — the numbers matter, not the chrome.
- [ ] 4. Wire the §23 counters skeleton (retry counts come with Phase 2; leave TODO markers referencing slice 2.3).

**Migrations:** none (event-based). **Tests:** selftest for the overwrite-detection helper. **Evidence:** dashboard shows volume + correction rate after the observation window; numbers recorded into the analysis's [E] gaps. **Rollback:** revert; events are inert. **Depends on:** nothing. **Note:** the *window* (1–2 weeks) runs in parallel with Phase 1 — do not block on it.

### Slice 0.5 — Repository validations and hygiene (Technical Plan §29)

**Status:** [ ] pending
**Objective:** answer the [A] items that size Phase 1; clean known hygiene issues.

**Tasks:**
- [ ] 1. **Flow vs SKILL.md diff** (§29.1): extract `operational_flow_jsonb` for `property_optioning` and diff step order/branches against the SKILL.md prose the runtime injects. Output: a findings note appended to this document under §X. Sizes the S1.2 transformation.
- [ ] 2. **Harness fork investigation** (§29.2): compare `run-settings-test-case-tick.ts` against the cron route's tick path; list every divergence (functions reimplemented vs imported). Output: findings note + the S1.6 parity work list.
- [ ] 3. **Duplicate migrations** (§29.3): inspect `00036`/`00044`/`00045` duplicates; verify how the Supabase migration runner ordered them in the deployed DB; renumber or document as immutable history per findings. Prefer documenting + guarding future numbering (add `scripts/validate-migrations.mjs` invoked from `prebuild` alongside `validate-skills.mjs`).
- [ ] 4. **Flag mechanism** (§29.5): confirmed — no flag framework exists. Decide and document the mechanism now [D proposal]: per-tenant boolean in a new `account_feature_flags` table **or** reuse of an existing per-user settings surface; env var only for global kill-switches. Record decision in §X; S1.4 consumes it.
- [ ] 5. **Child-table tenancy convention** (§29.6): inspect `operational_case_documents` (00037) RLS/`user_id` pattern; adopt the same for all new child tables; record.
- [ ] 6. **Terminology sweep** (§29 / plan §3.8): grep repo docs + UI copy for `heartbeat` used for claim liveness (runtime code currently has none — the lease is the only mechanism; keep it that way in names).
- [ ] 7. **CI seed:** add a root npm script `test:selftests` that chains the existing `apps/web` test scripts, and a GitHub Actions workflow running `type-check`, `lint`, `validate:skills`, and `test:selftests` on PR [D — file `.github/workflows/ci.yml`]. This is the §25 prerequisite.

**Evidence:** findings notes in §X; CI workflow runs green on a no-op PR. **Depends on:** nothing. **Blocks:** S1.2 (needs 1), S1.6 (needs 2), all Phase ≥1 migrations (needs 3), S1.4 (needs 4).

---

## PHASE 1 — Make the definition executable

### Slice 1.1 — `workflow_definitions` schema + case pinning

**Status:** [ ] pending
**Objective:** versioned definitions exist; every case is pinned.

**Tasks:**
- [ ] 1. Migration `00064_workflow_definitions.sql` [D]: table per Technical Plan §5.1 (incl. `definition_hash`, `status` check, `unique (user_id, case_type, version)`), RLS per 0.5-5 convention.
- [ ] 2. Migration `00065_operational_cases_definition_pin.sql` [D]: add nullable `workflow_definition_id uuid references workflow_definitions(id)`, `workflow_definition_version integer` to `operational_cases`.
- [ ] 3. Backfill inside `00065`: for each `operational_case_types` row, insert a `workflow_definitions` v1 row with `graph_jsonb` = placeholder transformation marker (real transform lands in S1.2 — see ordering note below) — **or** sequence `00064`+transform+`00065` so the backfill writes real graphs. Decide at implementation: preferred order is S1.2 transformer built first, then one migration pass; if migrations must land earlier, backfill in a follow-up migration `00066`.
- [ ] 4. `packages/db/src/queries/workflow-definitions.ts` [D]: `getPublishedDefinition(userId, caseType, version)`, `getLatestPublishedDefinition(userId, caseType)`, `insertDraftDefinition(...)`, `publishDefinition(...)` (immutability enforced: published rows never updated — publish = status flip of a `validated` row), all with required `userId`.
- [ ] 5. Set pin at creation in `createOperationalCase` (`packages/db/src/queries/operational-cases.ts` L194): resolve latest published definition for the case type and stamp both columns.

**Types:** add `WorkflowDefinition`, `WorkflowGraph` to `packages/types/src/` (new file `workflow-definitions.ts`, exported from `index.ts`). **Tests:** query selftest (insert draft → validate → publish → immutable), pin-on-create selftest. **Flags:** none — pinning is inert until the evaluator reads it. **Security:** RLS + required `userId`; service-role writes only. **Evidence:** every existing case backfilled to v1 (SQL count check); new case gets a pin. **Rollback:** columns nullable and unread; flag-off world unchanged. **Depends on:** 0.5-3, 0.5-5.

### Slice 1.2 — `packages/workflows` package: graph schema + flow→graph transformer

**Status:** [ ] pending
**Objective:** the executable `graph_jsonb` contract exists and v1 graphs are generated from existing flows.

**Tasks:**
- [ ] 1. Scaffold `packages/workflows` [D] (mirror `packages/types` build setup; add to root workspaces automatically via `packages/*`).
- [ ] 2. `src/graph-schema.ts`: zod schema for the §5.2 graph shape (states, transitions with named guards, step_bindings, work_templates, postconditions, approvals, impact_dependencies, completion). Export JSON-schema derivation for validation gates.
- [ ] 3. `src/transform-flow.ts`: transformer `operational_flow_jsonb` → `graph_jsonb` for `property_optioning`, encoding transitions from **both** the flow order and the hardcoded guard families (this is where the 0.5-1 diff findings are consumed; divergences become explicit `transitions` decisions logged in §X, not silent choices).
- [ ] 4. `src/hash.ts`: canonical JSON hash for `definition_hash` (stable key order; reuse the canonicalization approach of `property-identity-signature.ts` as the pattern).
- [ ] 5. Selftests: schema round-trip; transformer produces an acyclic, reachable graph for the real v1 flow; hash stability.

**Create:** `packages/workflows/*`. **Modify:** root `package.json` nothing (workspaces glob covers it); `turbo.json` if per-package tasks need registering [A — check existing turbo.json task shape]. **Depends on:** 0.5-1. **Blocks:** 1.1-3 backfill (real graphs), 1.3.

### Slice 1.3 — Transition evaluator + guard registry

**Status:** [ ] pending
**Objective:** `TransitionEvaluator` (Technical Plan §20) exists and the four hardcoded guard families are ported into named registry guards.

**Tasks:**
- [ ] 1. `packages/workflows/src/guards/registry.ts` [D]: `registerGuard(name, fn)` + lookup; guards are pure functions over `{ caseState, proposal, factsSnapshot }`.
- [ ] 2. Port guards (keep originals in place — the evaluator *duplicates* enforcement during advisory mode; originals retire in S1.7):
  - [ ] `step_order_no_regression` — from `PROPERTY_OPTIONING_STEP_ORDER` logic in `operational-cases-adapters.ts`;
  - [ ] `external_response_exists` — awaiting-documents gate;
  - [ ] `publication_keys_protected` — protected publication context keys;
  - [ ] `completion_pairing` — `published`/`completed` pairing rule.
- [ ] 3. `src/transition-evaluator.ts`: `evaluate(...)` per §20 returning `legal | illegal | requires_approval` + per-guard results; consults the pinned definition's `transitions`.
- [ ] 4. Deterministic transition selftests generated from the v1 graph: every declared transition legal from its `from`; a sample of undeclared ones illegal; guard unit tests with fixtures lifted from existing adapter selftests.

**Depends on:** 1.2. **Evidence:** selftests enumerate the full transition matrix for v1. **Rollback:** package unused until wired.

### Slice 1.4 — Advisory wiring at the three proposal sites

**Status:** [ ] pending
**Objective:** every proposed transition is evaluated; divergences are logged as events; behavior unchanged (advisory).

**Tasks:**
- [ ] 1. Implement the flag decided in 0.5-4: `workflow_enforcement_mode: "off" | "advisory" | "enforcing"` per tenant, default `advisory` after this slice ships [D].
- [ ] 2. Wire site 1 — model proposals: in the `operational_case_update_state` adapter (`packages/agent/src/tools/operational-cases-adapters.ts`), before the existing guards run, call the evaluator with the case's pinned definition; on `illegal` in advisory mode append event `transition_divergence` [D] and continue.
- [ ] 3. Wire site 2 — decision handlers: in `price-approval.ts` and sibling handlers where `updateOperationalCase` sets `currentStep`, evaluate + log likewise.
- [ ] 4. Wire site 3 — runtime transitions: cron route paths that set steps (publication runner closure, intake successor) evaluate + log.
- [ ] 5. Definition loading: small cached loader in `packages/workflows/src/load.ts` keyed by `(definitionId, version)` — definitions are immutable, cache freely.

**Modify:** adapters, handlers, cron route. **Security:** loader takes `userId`; no cross-tenant definition reads. **Observability:** count of `transition_divergence` events per day (add to 0.4 dashboard). **Evidence:** advisory window shows divergence rate; each divergence triaged to (a) transformer bug, (b) real prose/guard mismatch, (c) missing transition. **Rollback:** flag `off`. **Depends on:** 1.1, 1.3, 0.5-4.

### Slice 1.5 — Minimal evidence records

**Status:** [ ] pending
**Objective:** gate runs produce persisted, hash-pinned evidence.

**Tasks:**
- [ ] 1. Migration `00066_evidence_records.sql` [D] per Technical Plan §13 (scrub rule: `detail_jsonb` passes through a secret-scrubber before insert — implement `packages/workflows/src/evidence.ts` with a redaction list seeded from env-var names).
- [ ] 2. `packages/db/src/queries/evidence-records.ts`: `insertEvidenceRecord`, `listEvidenceForSubject` (required `userId`).
- [ ] 3. Emit evidence from: transition selftest runs (S1.3) when executed via the lab, and replay runs (S1.6).

**Depends on:** 1.1 (numbering), 1.3. **Rollback:** table inert.

### Slice 1.6 — Lab re-anchor: pinned versions + production evaluator (parity)

**Status:** [ ] pending
**Objective:** lab runs are pinned to a definition version and demonstrably execute the production evaluator; the 0.5-2 fork findings are closed or explicitly ticketed.

**Tasks:**
- [ ] 1. Add a definition-version selector to the readiness lab (`apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx` + `page.tsx`): default = latest published; drafts selectable.
- [ ] 2. Replace lab-side transition logic with calls into `packages/workflows` evaluator (work list from 0.5-2 — every reimplemented function either imports the production primitive or is deleted).
- [ ] 3. Historical replay harness: `apps/web/src/lib/operational-cases/replay-definition.ts` [D] — replays a case's event sequence through the evaluator asserting identical terminal state; wire into an npm script `test:replay`.
- [ ] 4. Each lab/replay run inserts an evidence record pinned to `definition_hash`.

**Tests:** `run-settings-test-case-tick.selftest.ts` still green; new `replay-definition.selftest.ts`. **Evidence:** one lab check demonstrably invoking the production evaluator (assert by module identity in test); replay of N historical cases identical. **Rollback:** lab selector defaults keep old behavior. **Depends on:** 1.3, 1.5, 0.5-2.

### Slice 1.7 — Enforcement flip

**Status:** [ ] pending
**Objective:** the definition is the transition authority for at least one tenant.

**Tasks:**
- [ ] 1. Triage the advisory window's divergences to zero-or-explained (0.4 dashboard).
- [ ] 2. Flip `workflow_enforcement_mode = "enforcing"` for the pilot tenant; illegal proposals now rejected with event `transition_rejected` [D] + the model receives the rejection as tool output (adapter returns a structured error string, matching existing adapter error style).
- [ ] 3. After one clean week: mark the duplicated hardcoded guard call sites with removal TODOs (actual removal is Phase 2+ cleanup, after soak).

**Phase 1 exit checks (Technical Plan §30):** [ ] every active case pinned · [ ] illegal transition rejected with event (enforcing, ≥1 tenant) · [ ] historical replay identical terminal states · [ ] ≥1 lab check on production evaluator against a pinned draft · [ ] minimal evidence records exist.

---

## PHASE 2 — Work plane

### Slice 2.1 — Work-plane schema

**Status:** [ ] pending
**Objective:** `work_items`, `work_item_attempts`, `work_item_dependencies`, `work_item_events` exist per Technical Plan §7/§10.

**Tasks:**
- [ ] 1. Migration `00067_work_plane.sql` [D]: four tables exactly as Technical Plan §7/§10 (attempt-scoped claim/liveness fields; `last_liveness_at` comment "Unrelated to the Gu OS Heartbeat proactive-execution feature"; seven statuses; `unique (case_id, idempotency_key)`; deferred FK `work_items.current_attempt_id`).
- [ ] 2. Indexes: partial ready-dispatch, `(case_id, status)`, running-attempt `claim_expires_at`, `(depends_on_id)`.
- [ ] 3. Append-only trigger on `work_item_events` (00019 pattern).
- [ ] 4. RLS per 0.5-5 convention on all four.

**Depends on:** Phase 1 complete (definition drives templates). **Rollback:** tables inert behind the v2 flag.

### Slice 2.2 — Work-item queries module

**Status:** [ ] pending
**Objective:** typed DB layer mirroring the operational-cases query style.

**Tasks:**
- [ ] 1. `packages/db/src/queries/work-items.ts` [D]: `createWorkItemsFromTemplates(userId, caseId, defVersion, templates[])` (idempotent via keys), `propagateReadiness(userId, caseId?)` (set-based UPDATE), `claimNextReady(userId, runnerRef, leaseMs)` (attempt insert + CAS on parent, `markCaseProcessing` shape), `reportLiveness(userId, attemptId, { renewLease })`, `recoverStaleClaims(userId)`, `completeAttempt(...)`, `blockItem(...)`, plus event insert helper.
- [ ] 2. Types in `packages/types/src/work-items.ts` (statuses, attempt statuses, event types incl. `claimed`, `liveness_updated`, `claim_renewed`, `claim_expired`, `verified`, `blocked`, `done`).
- [ ] 3. Selftests: CAS contention (two claimers, one wins), stale-claim recovery (expired attempt → `claim_expired` event + parent `ready` + nothing incremented), max-attempts → `blocked` + reason, readiness propagation incl. fan-in/fan-out fixtures. Wire `test:work-plane` npm script.

**Depends on:** 2.1.

### Slice 2.3 — Dispatcher: cron generalization

**Status:** [ ] pending
**Objective:** each cron tick advances readiness → claiming → execution without touching the v1 path.

**Tasks:**
- [ ] 1. `packages/workflows/src/dispatcher.ts` [D] implementing §20 `WorkDispatcher` over the 2.2 queries.
- [ ] 2. In `api/cron/operational-cases/route.ts`: after the existing v1 case loop, for v2-flagged tenants run `recoverStaleClaims` → `propagateReadiness` → claim/dispatch loop (bounded batch, priority order). Two paths coexist; **no shared mutable state** between them.
- [ ] 3. Work-template instantiation: on case state entry (evaluator-authorized transitions), create items from the definition's `work_templates` (`on_enter_state`).
- [ ] 4. Advancement predicate: on `completeAttempt` success, evaluate the definition's per-state completion requirements; if satisfied, advance the case via `updateOperationalCase` + case event (never set `current_step` from work code directly — single call site in the dispatcher).
- [ ] 5. Retry counters into the 0.4 dashboard (close the TODO from 0.4-4).

**Depends on:** 2.2, 1.4 (evaluator), v2 flag from 0.5-4. **Evidence:** synthetic v2 case runs a two-item chain end to end in the lab. **Rollback:** v2 flag off; v1 loop untouched.

### Slice 2.4 — Executor adapters (three modes)

**Status:** [ ] pending
**Objective:** `main_agent`, `deterministic_service`, and `human` execution modes work; others stay declared-but-unimplemented.

**Tasks:**
- [ ] 1. `packages/workflows/src/executors/` [D]: adapter interface per §20; `main-agent.ts` invokes the existing `runAgent` case-runner path with the work item's input contract in the case context block; `deterministic-service.ts` invokes a registered function by name; `human.ts` moves the item to `review` and creates an internal notification (reuse `internal-notifications` registry).
- [ ] 2. Executor reports are claims: all three return `ExecutorReport`; the dispatcher passes reports to the verification step (minimal in Phase 2: output-contract zod check; full contracts in Phase 3).
- [ ] 3. Long-running main-agent executions call `reportLiveness` between tool iterations [A — confirm a safe hook point in `graph.ts`'s tool loop; if none exists cleanly, lease length covers the turn and liveness lands with durable workers later — document choice in §X].

**Depends on:** 2.3. **Security:** deterministic registry is code-defined; no dynamic dispatch from DB strings to arbitrary functions — registry lookup only.

### Slice 2.5 — Operator work view + first role gating

**Status:** [ ] pending
**Objective:** operators see execution state; brokers do not.

**Tasks:**
- [ ] 1. Role gate: reuse `profiles.is_ungga_admin` as the interim operator role [D — the Technical Plan's role question §16 stays open; do not invent a role system in this slice]. Navigation entry hidden otherwise.
- [ ] 2. New route `apps/web/src/app/operations/work/page.tsx` [D — route name tentative per §16]: columns Todo/Ready/Running/Blocked/Review/Done; cards show work type, case, executor, due, dependency count, retry state, verification status; liveness cues use §10 vocabulary (*Executor active · Last liveness update · Claim expires · Execution appears stalled · Claim expired · Work reassigned*). No drag-and-drop in v1 of the view (manual transitions only via explained-action buttons where legal).
- [ ] 3. Case view: summary chip only (n items, blocked indicator) — no work statuses on the broker surface.
- [ ] 4. UI selftest in the existing `*-ui.selftest.ts` style for the status/label mapping (assert the word "heartbeat" never renders).

**Depends on:** 2.2. **Rollback:** route behind role check + flag.

### Slice 2.6 — Soak and Phase 2 exit

**Status:** [ ] pending
- [ ] 1. Seed pilot-tenant synthetic cases exercising claim contention (two runners via repeated cron invocations).
- [ ] 2. Monitor: zero silent double-claims (assert via events), `claim_expired` visibility, backlog drain.
- [ ] 3. Replay equivalence v1 vs v2 (§12.2 criteria) on the synthetic suite.

**Phase 2 exit checks:** [ ] v2 case end-to-end with ≥1 parallel branch · [ ] equivalence holds on replay · [ ] contention + stale-claim selftests and soak clean · [ ] `claim_expired` events visible · [ ] max-attempts → `blocked` + notification · [ ] work view role-gated with correct vocabulary.

---

## PHASE 3 — Impact plane and workers

### Slice 3.1 — Facts/artifacts/approvals schema

**Status:** [ ] pending
- [ ] 1. Migration `00068_impact_plane.sql` [D]: `case_facts` (append-only + trigger), `case_artifacts`, `artifact_inputs`, `case_approvals` per Technical Plan §11 / analysis §7.3; RLS convention.
- [ ] 2. Queries `packages/db/src/queries/case-facts.ts`, `case-artifacts.ts`, `case-approvals.ts` [D] (required `userId`; fact insert supersedes prior via `superseded_by`, never updates).
- [ ] 3. Types in `packages/types/src/impact.ts` (status vocab `current|stale|suspended|invalid|superseded`).

**Depends on:** Phase 2 (repair items need the work plane).

### Slice 3.2 — Impact engine + methodology-declared edges

**Status:** [ ] pending
- [ ] 1. `packages/workflows/src/impact-engine.ts` [D] per §20: `applyInputChange` recomputes input hashes for artifacts whose **declared** edges (definition `impact_dependencies`) include the changed input; stale + invalidation event + minimum repair template; approvals with mismatched `evidence_hash` → `suspended` (never auto-revoked). Unchanged hashes untouched.
- [ ] 2. Input-hash function: generalize `property-identity-signature.ts`'s canonicalization (import/extract, don't reimplement).
- [ ] 3. Encode `property_optioning` v2 `impact_dependencies` from the **verified methodology** (§X finding 3 — no longer an [H] gate):
  - **valuation / comparable_set / price_recommendation** depend on: `property.location` (zona/colonia), `property.operation`, `property.property_type`, subject area (`area_construida_m2` preferred, else `area_total_m2`), methodology/band policy, and the comparable set itself.
  - **price_approval** depends on evidence hash of valuation inputs + recommendation (and Avaclick contrast is informational, not a hard filter).
  - **Do not** declare bedrooms, bathrooms, or parking as valuation inputs (skill + `sanitizeComparableSearchFilters` strip them; selftest asserts `min_bedrooms`/`bedrooms` undefined).
  - **listing_description / listing_payload / commercial copy / matching filters** declare bedrooms, bathrooms, parking, amenities, location as inputs.
- [ ] 4. Wire fact writes: the intake-update adapter path writes `case_facts` rows (with source class incl. `external_contact`) alongside the existing `context_jsonb` write, then calls the impact engine (v2 cases only).
- [ ] 5. Selftests: C1 fixture (bedrooms → listing artifacts stale; valuation/approval current), C2 fixture (area/location → valuation chain stale + approval suspended + revaluation work), unaffected-work-stays-valid, over-invalidation guard (an edge-less artifact never stales).

**Depends on:** 3.1, definition schema field from 1.2. **Security:** no external-sourced fact satisfies an approval postcondition without HITL (enforce in engine: approval re-grant requires human decision event).

### Slice 3.3 — Evidence-bound approvals in the price chain

**Status:** [ ] pending
- [ ] 1. Price approval (v2 path) writes a `case_approvals` row with `evidence_hash` + snapshot at decision time (handler in `price-approval.ts` branches on case v2 pin).
- [ ] 2. Suspension surfaces: pending-inbox entry kind `approval_suspended` [D] with old/new basis; human decision re-approves (new row, supersedes) or revokes.
- [ ] 3. Selftests for grant → suspend (C2) → re-approve chain.

**Depends on:** 3.2.

### Slice 3.4 — Worker profiles + first three workers

**Status:** [ ] pending
- [ ] 1. Migration `00069_worker_profiles.sql` [D] per §9; queries module with required `userId`; no credentials fields.
- [ ] 2. Register deterministic services: `publication_reconciliation` (wrap `publication-reconcile.ts` + `publication-remote-snapshot.ts`) and `extraction_consolidation` (extract the consolidation section of `property-optioning-post-agent-invariants.ts` behind an explicit input/output contract — refactor, not rewrite; keep the original callable until v2 owns it).
- [ ] 3. Valuation verifier as `specialized_agent` [D]: isolated context = comparable set + property facts **only** (never the recommendation's reasoning); output pass/fail + findings; read-only tool surface (empty `allowed_tools` beyond read adapters); its evidence gates the price-recommendation artifact.
- [ ] 4. Runtime scope enforcement: executor selection checks `allowed_tools`/`allowed_data_scopes` before dispatch (deny + `blocked_reason` on mismatch).
- [ ] 5. Cost attribution events per attempt (profile, model, tokens, duration).

**Depends on:** 2.4, 3.2. **Security:** scopes enforced at selection, not prompt; tenant inheritance from work item's `user_id` with no exceptions.

### Slice 3.5 — Impact view + case-view staleness indicators

**Status:** [ ] pending
- [ ] 1. Impact view (route under the operations family [D]): triggered from a fact change — old/new values with sources, affected artifacts, suspended approvals, repair work created, unaffected artifacts listed explicitly, human override with required rationale.
- [ ] 2. Case view: stale-artifact and contested-fact indicators (broker-safe wording; no plane vocabulary leakage).
- [ ] 3. UI selftests for label mapping.

**Phase 3 exit checks:** [ ] C1 passes · [ ] C2 passes · [ ] verifier runs read-only under contract and gates the recommendation · [ ] two deterministic services dispatch through the work plane · [ ] over-invalidation ratio measured on the dashboard.

---

## PHASE 4 — Multiplexer and compiler

### Slice 4.1 — Conservative intent decomposition

**Status:** [ ] pending
- [ ] 1. `apps/web/src/lib/business-decisions/intent-decomposer.ts` [D]: model-backed splitter (model role + zod schema following `operational-conversation-classifier.ts` conventions) with confidence floor; below floor ⇒ single intent = whole turn (today's behavior).
- [ ] 2. Run before the gate chain; each intent flows through the existing chain independently; results composed into one response (composition helper + selftest).
- [ ] 3. Residual from 0.1 remains the safety net for anything the decomposer misses.
- [ ] 4. Scenario selftests: A1/A2/B1/B2/D from Technical Plan §12 as fixtures (LLM-dependent assertions follow the existing classifier-selftest pattern for mocking/live-key gating [A — confirm how classifier selftests handle the API key]).

**Depends on:** 0.1, 0.2; C-intents need 3.2 to land effects.

### Slice 4.2 — Compiler artifacts + gates + studio + publication

**Status:** [ ] pending
- [ ] 1. Spec artifacts: business spec + implementation spec + capability map schemas in `packages/workflows/src/compiler/` [D]; capability map resolves against skills catalog, `TOOL_CATALOG`, and worker profiles; unresolved = explicit gap list.
- [ ] 2. Validation gates: schema, acyclicity, reachability, capability resolution, permission validation, credential-shape rejection — each emits evidence records.
- [ ] 3. Simulation gate: replay harness (1.6) + scenario suite against the draft definition.
- [ ] 4. Studio UI (route family per §16 decision [H]): describe → clarify (bounded) → spec views → capability/gap panel → validation findings → simulation results → publish/reject (publication = §10.5-gated human approval; draft → validated → published).
- [ ] 5. Retire `/settings/operational-case-types` authoring after the studio covers it (keep capability-lab diagnostics; redirect + deprecation notice first release).

**Phase 4 exit checks:** [ ] A1/A2/B1/B2/D selftests pass · [ ] a non-engineer publishes a simple workflow that runs on a synthetic case · [ ] publication is evidence-gated + human-approved · [ ] settings lab authoring retired.

---

## X. Contradiction log and findings

> Record here any material contradiction between repository reality and the Technical Plan, with a proposed decision. Do not resolve architectural contradictions unilaterally.

| # | Date | Finding | Impact | Decision needed / taken |
|---|---|---|---|---|
| 1 | 2026-07-26 | No CI and no root test aggregator exist (plan §25 assumes wiring is possible; it is — task 0.5-7) | Low | Taken: add `test:selftests` + GitHub Actions in 0.5-7 |
| 2 | 2026-07-26 | No feature-flag framework (plan §24 [A] confirmed) | Medium | Needed: 0.5-4 mechanism decision |
| 3 | 2026-07-26 | **Valuation methodology verified in repo** (closes former [H] on valuation inputs). Hard search filters for comparables are: `zona`/`neighborhood`, `operation`, `property_type`, area band from `area_construida_m2` (else `area_total_m2`) with residential strict −15%/+85% (`deriveComparableAreaBand` / `buildComparableSearchFilters` in `packages/agent/src/operational-cases/comparable-search-contract.ts`). Skill `perform-comparable-analysis` L100–101: "No uses recámaras/baños/estacionamientos ni topes de precio inventados como filtros duros." `sanitizeComparableSearchFilters` drops bedrooms/bathrooms/parking; selftest L57–58 and L164–168 assert they stay undefined. Pricing (`prepare-listing-price` / `pricing-proposal.ts`) prefers `price_per_m2` p25/p50 × subject area. Fallback ladder: `expanded` → `wide` → `location_only` (drops area, still not bedrooms). Avaclick is contrast/informational for casas/depto. | High (unlocks 3.2-3) | **Taken:** encode impact edges as in slice 3.2 task 3; C1/C2 acceptance criteria remain correct |
| — | | *(append as found)* | | |

**Open [H] gates blocking specific tasks:** ~~valuation-methodology inputs~~ (resolved — finding 3); route/IA naming (blocks 2.5-2, 4.2-4 final names — interim names acceptable behind role gate); dual-dispatch tolerance (informs 2.6 soak length); approval re-derivation vs immediate surfacing (informs 3.3-2 UX).

---

## Y. Standing per-slice exit ritual

Before marking any slice done: `npm run type-check` · `npm run lint` · affected `apps/web` test scripts · new selftests wired to an npm script (and CI once 0.5-7 lands) · terminology check (no `heartbeat` for liveness) · tenancy check (every new query requires `userId`) · this document's checkboxes and Status lines updated.
