# Gu OS — Flexible Workflows Technical Plan

**Status:** Implementation-oriented technical plan. Derived from and subordinate to `docs/manuals/gu-os-flexible-workflows-architecture-analysis.md` (the architecture analysis, latest revision 2026-07-26), which is the architectural source of truth. Where this plan and the analysis disagree, the analysis wins and this plan must be corrected.

**Supersedes:** `Gu_OS_Flexible_Workflows_Tentative_Technical_Plan.md` (the pre-analysis hypothesis document). Structure and still-valid details were recovered from it; nothing was preserved merely because it appeared there.

**Scope of this task:** documentation only. No production code, migration, UI code, skill, tool, or test was modified to produce this plan.

## Evidence-status legend (used throughout)

| Tag | Meaning |
|---|---|
| **[V]** | Verified current repository behavior (file/line citations refer to the repo at the analysis snapshot) |
| **[T]** | Accepted target architecture (decided in the architecture analysis; not re-litigated here) |
| **[D]** | Tentative technical design — names, types, routes, and interfaces are proposals, not existing artifacts |
| **[A]** | Assumption requiring repository validation before implementation |
| **[H]** | Product or domain decision still requiring human confirmation |

Nothing tagged [D] exists in the repository today. Schema names such as `workflow_definitions`, `work_items`, `work_item_attempts`, `case_facts`, and `worker_profiles` are proposals.

---

## 1. Purpose and scope

This plan translates the architecture analysis into a design detailed enough to drive: specifications and ADRs, database design, runtime changes, UI/UX work, tests, and a phased implementation. It covers the evolution from the current operational-case architecture to:

- versioned executable workflow definitions that are the **transition authority** at runtime;
- a **work plane** (durable work items, explicit dependency DAG, claims/leases/attempts) separate from the case plane;
- **capability-based executor selection** with a minimal multi-worker substrate (no general multi-agent system now);
- a **fact/artifact/approval impact model** with selective invalidation and minimum repair;
- **multi-intent conversational routing** with residual preservation;
- a **spec-driven workflow lifecycle** with failure classification and evidence-gated verification;
- **governed publication** of workflow definitions;
- **shared runtime primitives** used identically by production execution, simulation, replay, and testing.

Out of scope: rewriting the existing case engine (the strategy is brownfield and additive), building a general multi-agent system, generated production code executing from any runtime path, and Temporal or equivalent external engines (rejected at current volume with explicit revisit thresholds — analysis §6.9(6)).

---

## 2. Current-state summary [V]

Condensed from the analysis §3–§4; citations are in the analysis. These are the verified facts the design must respect.

**Engine.** `operational_cases` holds one `current_step` string per case, a status machine, `context_jsonb`, and optimistic locking (`version` + lease via `next_action_at`); `operational_case_events` is append-only with trigger enforcement. A cron route drains due cases (batch 100, concurrency 5, no priority ordering). The lease is the only executor-liveness mechanism; there is no mid-execution liveness update, no attempt counter, and abandonment is silent.

**Workflow definition.** `operational_case_types.operational_flow_jsonb` **is** read at runtime — for per-step skill binding, the intake-completion successor step, and per-step BigQuery context injection — but it is **not** the transition authority. Post-intake transitions are model-proposed via `operational_case_update_state` and validated against hardcoded per-case-type guards (`PROPERTY_OPTIONING_STEP_ORDER`, awaiting-documents gate, publication key protection, completion pairing). The transition topology therefore lives in three unsynchronized places: SKILL.md prose, hardcoded guards, and the flow JSON. Branch metadata (`step_decision`) is declared and explicitly not read.

**Versioning.** None. Case types have no version column; ~25 `property_optioning_*` flow migrations each mutated behavior under running cases with no record on the case.

**Work plane.** Does not exist. No work items, no dependency edges anywhere in `packages/`. The publication runner simulates multi-step work inside `context_jsonb` with its own serialized sub-state machine — the strongest internal evidence the need is real.

**Impact model.** Document-level provenance is good (`operational_case_documents` with supersession, source scoring, extraction lineage). Two real staleness detectors exist (`property-identity-signature.ts`; `photo-analysis-staleness.ts`) but run only as warnings in the tool-readiness lab. No fact→artifact edges; corrections overwrite `context_jsonb` in place; approvals are JSON strings with no evidence link and no suspension path once approved.

**Conversation.** A deterministic gate chain (`resolvePendingDecisionTurn`, seven gates) claims turns whole. `PendingDecisionTurn`'s handled branch carries a single `message` and no residual field, so mixed-intent turns silently discard intents (executed evidence [C] in the analysis). `parsePriceApprovalDecision` approves the proposal on record even when the user states a different amount (Finding 3). The operational conversation classifier emits exactly one route/intent.

**Security posture.** Server paths use the service-role client, so RLS is a backstop, not the active guard; isolation depends on application code passing `user_id`. The scheduled-task runner uses `autoApproveTools: true` (Finding 15); the operational-case cron correctly does not. Secrets handling (`account_tool_secrets`, AES-256-GCM; `user_integrations.encrypted_tokens`) is sound.

**Testing.** 74 self-tests in the operational-cases module; an N0–N5 readiness lab at `/settings/operational-case-types`; a 104 KB controlled-tick harness (`run-settings-test-case-tick.ts`) that may have forked from the runtime tick (Inference 3 — unresolved [A]). No CI pipeline. No role model beyond `profiles.is_ungga_admin`.

---

## 3. Architectural principles [T]

1. **The versioned workflow definition is the runtime authority** for legal transitions, branch conditions, guards, approval requirements, work-item templates, postconditions, verification contracts, and completion criteria. The model interprets context and proposes; the runtime validates and authorizes against the definition.
2. **Case plane ≠ work plane.** Business truth and executable work never share tables, status vocabulary, or UI surfaces. `operational_cases.current_step` and `context_jsonb` are not overloaded with the work graph.
3. **Additive, flagged, brownfield.** Every change is a new table or nullable column behind a flag; v1 keeps running; rollback is flag-off, never history mutation.
4. **Capabilities, not executors.** Definitions and work items request a capability; the runtime selects an allowed executor via worker profiles. "Subagent" is one execution mode, not the architecture.
5. **Agent assertions are claims; evidence rows are evidence.** Every gate produces a mechanically admissible evidence record pinned to the artifact version/hash it tested; artifact change invalidates evidence.
6. **Selective impact from declared dependencies.** Dependency edges reflect the workflow's actual business methodology; universal domain dependencies are never inferred from field names.
7. **Tenant isolation is an application obligation.** New query helpers take `userId` as a required parameter; every new table carries `user_id` + RLS as defense in depth.
8. **Terminology: `Gu OS Heartbeat` is reserved** for the proactive periodic execution capability. Worker claim liveness uses *executor liveness / liveness update / lease renewal / stale claim / stale-claim recovery* (§10).
9. **One set of runtime primitives.** Production execution, the verification studio, simulation, and replay invoke the same transition evaluator, dispatcher, guards, and verifiers. No lab-only reimplementation.
10. **HITL is risk-justified, not blanket.** Gates that require a human are enumerated with thresholds (analysis §10.5); everything else is protected by boundaries (validation, allowlists, evidence), because habituated approval is not a control.

---

## 4. Target architecture [T]

Eight planes, each owning one question (diagram and full rationale: analysis §6):

| Plane | Question owned | Backing (tentative) |
|---|---|---|
| Case | What is commercially true? | existing tables + `case_facts`, `case_approvals`, version pin |
| Work | What executable work remains, what blocks what? | `work_items`, `work_item_attempts`, dependencies, events |
| Worker | Who can execute this capability? | `worker_profiles` + executor adapters |
| Impact | What becomes stale when an input changes? | `artifact_inputs`, input hashes, invalidation events, repair templates |
| Verification / evidence | Is "done" actually done? | verification contracts + `evidence_records` |
| Conversational multiplexer | What intents does this turn contain, where does each go? | decomposer + per-intent dispatch + composition |
| Compiler | How does natural language become a versioned definition? | business spec + implementation spec + capability map |
| UI | How is each plane seen without re-merging them? | §16 |

---

## 5. Workflow-definition model [D]

### 5.1 Storage

```sql
-- Tentative. Names illustrative.
create table workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  -- Ownership mirrors account_skills: null user_id = global template;
  -- non-null = private to that user. owner_scope leaves room for organization later.
  owner_scope text not null default 'global'
    check (owner_scope in ('global','user','organization')),
  user_id uuid references profiles(id),        -- null when owner_scope = global
  organization_id uuid,                        -- reserved; unused until org-owned defs ship
  case_type text not null,                     -- slug, e.g. property_optioning
  workflow_key text not null,                  -- stable key within owner (often = case_type)
  version integer not null,
  status text not null check (status in ('draft','validated','published','deprecated')),
  -- Catalog metadata only — never drives runtime semantics by itself.
  industry text,                               -- e.g. real_estate | legal | insurance | automotive | education
  domain_tags text[] not null default '{}',
  business_spec_jsonb jsonb not null default '{}',
  implementation_spec_jsonb jsonb not null default '{}',
  graph_jsonb jsonb not null,                  -- the executable artifact
  definition_hash text not null,               -- content hash; evidence pins to this
  -- Explicit fork lineage (do not silently shadow a live global definition).
  derived_from_definition_id uuid references workflow_definitions(id),
  derived_from_version integer,
  visibility text not null default 'private'
    check (visibility in ('private','shared_template')),
  published_at timestamptz,
  published_by uuid references profiles(id),
  provenance_jsonb jsonb not null default '{}',-- compiler run, source text, approvals
  created_at timestamptz not null default now(),
  check (
    (owner_scope = 'global' and user_id is null) or
    (owner_scope = 'user' and user_id is not null) or
    (owner_scope = 'organization' and organization_id is not null)
  )
);

-- Postgres UNIQUE treats NULLs as distinct, so a single UNIQUE (user_id, …)
-- would allow duplicate globals. Use partial unique indexes instead.
create unique index workflow_definitions_global_uniq
  on workflow_definitions (case_type, version)
  where user_id is null and owner_scope = 'global';
create unique index workflow_definitions_user_uniq
  on workflow_definitions (user_id, case_type, version)
  where user_id is not null;
```

`graph_jsonb` deliberately does **not** reuse the name `operational_flow_jsonb`: the existing column's own comment declares it non-runtime, and the rename prevents that ambiguity from carrying forward. Migration for v1 is a mechanical transformation of the existing flow JSON plus a version-1 row per case type. `industry` / `domain_tags` are catalog filters only; methodology and impact edges stay inside `graph_jsonb` per workflow.

### 5.1.1 Global templates vs private customizations [T/D]

Skills already have this pattern: `skills/global/*` ∪ `account_skills` with account winning on slug collision (`packages/agent/src/skills/runtime.ts`, migration `00020`). Workflows follow the same ownership idea, but **customization is by explicit fork, not silent shadow of a published global**:

```text
Global property_optioning v3
        ↓ fork (copy + lineage)
Private property_optioning-custom v1
  owner_scope = user, user_id = X
  derived_from_definition_id = <global v3 id>
```

Rules: a published global is immutable; private forks pin their lineage and do not auto-adopt later global versions; adopting upstream changes is an explicit merge/rebase with human approval and a new private version; RLS / required `userId` keep private definitions invisible to other users. Organization-scoped definitions are reserved in the schema (`owner_scope = organization`) but not implemented until product decides whether brokerage-level sharing is required [H]. Resolution order when starting a case: user's latest published private definition for `case_type` if any, else latest published global.

### 5.2 Executable graph shape (tentative JSON contract)

```jsonc
{
  "states": [{ "key": "awaiting_documents", "label": "…", "kind": "operational" }],
  "transitions": [{
    "from": "awaiting_documents", "to": "documents_received",
    "guards": ["external_response_exists"],              // named, code-registered guards
    "authorized_proposers": ["model", "decision_handler"],
    "approval_required": null
  }],
  "step_bindings": [{ "state": "comparables_in_progress", "skill": "…", "bigquery_context": true }],
  "work_templates": [{
    "on_enter_state": "contract_pending",
    "work_type": "prepare_contract",
    "required_capability": "contract_drafting",
    "depends_on": [], "verification_contract": { "…": "…" }
  }],
  "postconditions": [{ "state": "package_ready", "checks": ["publication_preflight"] }],
  "approvals": [{ "kind": "price", "evidence_inputs": ["valuation", "price_recommendation"] }],
  "impact_dependencies": {
    "valuation": ["property.location", "property.construction_area", "comparable_set", "methodology"],
    "listing_description": ["property.bedrooms", "property.bathrooms", "property.parking", "property.location"]
  },
  "completion": { "terminal_states": ["completed"], "required_evidence": ["publication_reconciled"] }
}
```

Guards and postconditions are **names resolved against a code registry**, never inline code. Generated definitions can therefore only compose vetted checks. [T]

### 5.3 Authority rule

The runner consults the definition on every proposed transition: `operational_case_update_state` (or a decision handler) proposes; the transition evaluator answers *legal / illegal / requires-approval*. Illegal proposals are rejected with an appended case event. During migration the evaluator runs **advisory-only behind a flag** (log divergence, allow) before it becomes enforcing (§24). Existing hardcoded guards are ported into named registry guards and then retired from their hardcoded call sites.

### 5.4 Validation gates before publication [T]

JSON-schema validity; DAG acyclicity; state reachability (no orphan, no dead-end without terminal); every referenced skill/tool/capability existing and permitted for the tenant; no credential-shaped content; deterministic transition tests; simulation of acceptance scenarios. Publication is a §10.5-gated human act; published definitions are immutable (edits create version *n+1*).

---

## 6. Case-plane design [T/D]

Keep unchanged: the case row, append-only events with trigger enforcement, optimistic locking with lease. Add (nullable, backfilled): `workflow_definition_id uuid`, `workflow_definition_version integer` — every case pinned at creation; in-flight cases backfilled to version 1.

Facts and approvals graduate from `context_jsonb` keys to rows (§11). `context_jsonb` remains for presentation and non-load-bearing state during transition; facts of record migrate incrementally starting with the pilot's price chain. [D]

The case plane must not learn about work items beyond a summary (count/blocked indicator). If `operational_cases` starts carrying execution detail, the separation has failed. Case advancement is driven by the definition's advancement predicate, not by work completion directly (§8.4).

---

## 7. Work-plane design [D]

Statuses (seven, generic, deliberately different from case vocabulary): `todo`, `ready`, `running`, `blocked`, `review`, `done`, `cancelled`. `ready` is computed from dependency satisfaction, never set by hand. Hermes's `triage` is dropped (work is born classified by the definition) and `archived` is dropped (retention policy on `done`/`cancelled` instead).

```sql
-- Tentative. Claim-scoped fields live on attempts, not on the item (see §10).
create table work_items (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references operational_cases(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  workflow_definition_version integer not null,
  work_type text not null,
  status text not null default 'todo' check (status in
    ('todo','ready','running','blocked','review','done','cancelled')),
  priority integer not null default 100,
  required_capability text not null,
  assigned_worker_profile_id uuid references worker_profiles(id),
  not_before timestamptz,
  due_at timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  current_attempt_id uuid,                     -- FK added after work_item_attempts exists
  blocked_reason text,
  input_contract_jsonb jsonb not null default '{}',
  output_contract_jsonb jsonb not null default '{}',
  verification_contract_jsonb jsonb not null default '{}',
  result_jsonb jsonb,
  idempotency_key text,
  version integer not null default 1,          -- optimistic locking, same pattern as cases
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, idempotency_key)
);

create table work_item_dependencies (
  work_item_id uuid not null references work_items(id) on delete cascade,
  depends_on_id uuid not null references work_items(id) on delete cascade,
  dependency_kind text not null default 'finish_to_start',
  primary key (work_item_id, depends_on_id),
  check (work_item_id <> depends_on_id)
);

create table work_item_events (                -- append-only, trigger-enforced like case events
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id) on delete cascade,
  attempt_id uuid references work_item_attempts(id),
  event_type text not null,                    -- claimed, claim_renewed, liveness_updated,
                                               -- claim_expired, verified, blocked, done, …
  actor text not null,
  payload_jsonb jsonb not null default '{}',
  created_at timestamptz not null default now()
);
```

Indexes: partial `(status, not_before, priority) where status = 'ready'` (dispatch); `(case_id, status)` (work view); `(claim_expires_at) where status = 'running'` on attempts (stale-claim recovery); `(depends_on_id)` (readiness propagation). Cycle rejection happens at definition compile time; the self-reference check catches trivial cycles at insert. [D]

---

## 8. Dependency and scheduling model [D]

**8.1 Readiness propagation.** Set-based SQL on each tick: any `todo` item whose dependencies are all `done` and whose `not_before` has passed becomes `ready`. No per-item loop.

**8.2 Dispatch.** The existing cron route generalizes (it is not replaced): tick = propagate readiness → claim ready items in priority order → dispatch by capability. Claim logic shares `markCaseProcessing`'s compare-and-swap shape so the team maintains one concurrency pattern. [T]

**8.3 Fan-out / fan-in.** Both fall out of the edge table: several items depending on one predecessor (fan-out), one item depending on several (fan-in). No special mechanism.

**8.4 Case advancement predicate.** Work completion never sets `current_step` directly. The definition declares, per case state, which work items must reach `done` (and which evidence must exist) for the case to advance; on item completion the runtime evaluates the predicate and, if satisfied, advances the case through the existing `updateOperationalCase` optimistic-locking path with a case event. Business truth changes only through business rules. [T]

**8.5 Failure containment.** `attempt_count >= max_attempts` moves the item to `blocked` with `blocked_reason` and notifies the case. Nothing silently disappears and nothing retries forever — this closes Findings 9/12 at the work level; the case-level terminal-failure question remains a Phase 0/1 hardening item (reachable `failed` or drop it from the CHECK).

---

## 9. Executor and worker architecture [T/D]

**Executor kinds** (conceptual, all first-class): main agent · deterministic service · specialized agent · ephemeral subagent · durable worker · external service · human. Work items request a `required_capability`; the runtime resolves it to a worker profile and enforces the profile's tool and data scopes at selection time, not via prompts.

```sql
-- Tentative
create table worker_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),        -- null = global profile; execution is always tenant-scoped
  slug text not null,
  capabilities text[] not null default '{}',
  execution_mode text not null check (execution_mode in
    ('main_agent','deterministic_service','specialized_agent','ephemeral_subagent',
     'durable_worker','external_service','human')),
  allowed_tools text[] not null default '{}',
  allowed_data_scopes text[] not null default '{}',
  model_policy_jsonb jsonb not null default '{}',
  approval_policy_jsonb jsonb not null default '{}',
  timeout_seconds integer not null default 300,
  retry_policy_jsonb jsonb not null default '{}',
  verification_contract_jsonb jsonb not null default '{}',
  max_concurrency integer not null default 1,
  cost_ceiling_cents integer,
  unique (user_id, slug)
);
```

**Activation bar** [T]: a specialized worker requires at least two of — sustained parallelism, context isolation, materially different model/modality, independent verification, different tool permission set, long-running execution, failure isolation. **Introduce now:** the valuation/comparables verifier (independent verification + context isolation; read-only, cannot damage anything) and two deterministic services lifted from existing code (publication reconciliation; document-extraction consolidation). **Defer:** document extraction as worker, durable worker processes (hosting question), independent case-completion verification (define completion evidence first). Profiles never embed credentials (§21).

### 9.1 Model policy: cheap default, stronger where evidence justifies it [T/D]

Do **not** change the main-agent default to a frontier model. Gu OS keeps dense scaffolding around cheap models (`MAIN_AGENT_MODEL_ID`, today defaulting to `openai/gpt-5.4-mini`). Stronger models are selected **per worker role**, not as a global upgrade.

**Resolution order** (first hit wins):

1. `worker_profiles.model_policy_jsonb` (logical alias + budgets for that profile);
2. Role env default (mirrors existing `*_MODEL_ID` pattern in `packages/agent/src/model.ts`);
3. `MAIN_AGENT_MODEL_ID` as last resort for agentic modes only (never for deterministic services).

**Role env vars to add** (alongside existing ones; names tentative):

| Env var | Role | Typical use |
|---|---|---|
| `MAIN_AGENT_MODEL_ID` | main / case runner | keep cheap unless measured failure demands otherwise |
| `WORKFLOW_VERIFIER_MODEL_ID` | valuation / independent verifiers | candidate for a stronger or different model |
| `WORKFLOW_INTENT_DECOMPOSER_MODEL_ID` | multi-intent splitter | start on mini; upgrade only if A2/B/D fail |
| `WORKFLOW_COMPILER_MODEL_ID` | NL → spec / clarify | higher judgment, low volume |

**Tentative `model_policy_jsonb` shape:**

```json
{
  "role": "valuation_verifier",
  "model_alias": "reasoning_high",
  "fallback_aliases": ["reasoning_standard"],
  "max_output_tokens": 3000,
  "temperature": 0,
  "max_cost_cents_per_run": 8
}
```

Aliases resolve through a central map in code (OpenRouter model ids), so definitions do not hardcode vendor strings. Tenant overrides are allowed only inside the global allowlist and the profile's `cost_ceiling_cents`.

**Upgrade criteria (evidence, not preference):** false-accept / false-reject rate of the verifier; decomposer residual / mis-split rate on A2/B/D; human correction rate on compiler drafts; cost and latency per case. Promote a stronger model only when a metric crosses a stated threshold and a side-by-side replay shows improvement.

### 9.2 Skills packaging: Gu contract vs portable ecosystem format [T/D]

Gu OS skills are **not** limited to prose, and the plans do **not** require inventing a proprietary skill shape from scratch. The registry already follows the common package layout (`packages/agent/src/skills/registry.ts`):

```text
skills/global/<slug>/
  SKILL.md          required
  references/       optional — progressive disclosure via read_skill_reference
  assets/           optional — ignored at load today
  scripts/          reserved for V2+, ignored at load today
```

Slugs already follow the Anthropic Skills convention. Gu adds multi-tenant metadata the portable core does not know about: `scope`, `allowed_tools`, `includes`, `requires_tenant_context`, `memory_extraction`, `heartbeat`, `guardrails` (see `skills/global/skill-authoring/references/skill-contract.md`). Optional catalog metadata `industry` / `domains` may be added later to frontmatter the same way — parser is `.strict()`, so any new field needs an explicit schema bump.

**Layering (do not collapse):**

| Layer | Role |
|---|---|
| `SKILL.md` + `references/` | Policy, routing, progressive disclosure |
| Tools / adapters (`packages/agent`) | Governed executable code (tenancy, HITL, audit) |
| Deterministic / specialized workers | Capability-bound execution with verification contracts |
| Workflow definition | Orchestrates skills/workers; never embeds inline code |

Anthropic-style “skill with scripts the agent runs as black boxes” maps in Gu OS to **tools and registered deterministic services**, not to unrestricted `scripts/` execution. That is deliberate for multi-tenant SaaS: downloaded scripts are supply-chain code.

**Interoperability target:** adapt toward the emerging package standard so external skills are *importable with adaptation*, never *executable on download*.

```text
Import package → identify format/license/provenance
→ validate portable SKILL.md
→ map into Gu extensions (tools, tenant, HITL, heartbeat)
→ resolve capabilities / gap list
→ quarantine scripts (no credentials, no free network)
→ evals + human review
→ activate as account_skill (private) or global template
```

**Private skill gap [V]:** `account_skills` stores only `body_md` + `metadata_jsonb` today — no `references/` / `assets/` / `scripts/` package. True import parity needs either `account_skill_files` or object-storage bundles with a manifest hash. That work is **Phase 4+ / post-compiler**, not a Phase 0–2 blocker; until then private skills remain single-file markdown (current product behavior). Scripts, if ever enabled, enter only as quarantined candidates that promote into registered deterministic services after review — never as model-chosen arbitrary execution.

---

## 10. Claims, leases, liveness, attempts, and recovery [D]

Execution-specific state lives on **attempts**, because one item may be processed by several executors across retries; storing claim fields on `work_items` would overwrite attempt 1's stale claim when attempt 2 starts.

```sql
-- Tentative
create table work_item_attempts (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id) on delete cascade,
  attempt_number integer not null,
  executor_kind text not null,
  executor_ref text,                            -- runner id / profile id / external correlation id
  worker_profile_id uuid references worker_profiles(id),
  status text not null check (status in
    ('running','succeeded','failed','claim_expired','cancelled')),
  claimed_at timestamptz not null default now(),
  claim_expires_at timestamptz not null,
  -- Most recent liveness update from the executor processing this attempt.
  -- Unrelated to the Gu OS Heartbeat proactive-execution feature.
  last_liveness_at timestamptz,
  last_progress_at timestamptz,                 -- optional: alive vs actually advancing
  completed_at timestamptz,
  error_jsonb jsonb,
  evidence_jsonb jsonb,
  created_at timestamptz not null default now(),
  unique (work_item_id, attempt_number)
);
```

**Semantics (keep separate):** `last_liveness_at` records when the executor last demonstrated activity. `claim_expires_at` records until when the claim is valid. A valid liveness update *may* perform **lease renewal** (extend `claim_expires_at`), recorded as an append-only `claim_renewed` / `lease_extended` event — never collapse liveness and renewal into one timestamp.

**Claim:** insert attempt row + CAS on the parent (`status='running'`, `current_attempt_id`, `attempt_count+1` where `id=? and version=?`); skip on mismatch. **Stale-claim recovery:** `running` attempt with `claim_expires_at < now()` → attempt `claim_expired`, parent back to `ready`, `current_attempt_id` cleared, nothing incremented, visible `claim_expired` event. **Bounds:** `max_attempts` as in §8.5.

> **Developer note (terminology).** This mechanism is analogous to the worker-heartbeat/liveness pattern in Hermes and other distributed work systems. Gu OS deliberately does not use the word "heartbeat" for it: **Gu OS Heartbeat** is reserved for the product's proactive periodic execution capability (OpenClaw-inspired). The Hermes analogy is developer context only — Hermes is not a runtime dependency, an architectural authority, or a user-facing term. UI copy uses: *Executor active · Last liveness update · Claim expires · Execution appears stalled · Claim expired · Work reassigned.*

---

## 11. Fact / artifact / approval impact model [T/D]

**Principle:** *Dependencies must reflect the actual business methodology of the workflow; the system must not infer universal domain dependencies merely from field names.* Under Gu OS's valuation methodology, valuation inputs are location/zone, relevant construction area, the comparable set, and price-per-m² — **not** bedroom count. Bedroom count feeds listing description, publication payload fields, brochure/commercial copy, filters, and matching. Edges are declared per workflow definition (`impact_dependencies` in §5.2).

```sql
-- Tentative (full DDL in analysis §7.3)
case_facts        -- append-only; fact_key, value, source_kind, source_ref, confidence, superseded_by
case_artifacts    -- artifact_type, artifact status, input_hash, produced_by_work_item_id
artifact_inputs   -- edges: (artifact_id, input_kind fact|artifact, input_id)
case_approvals    -- approval_kind, decision approved|rejected|suspended|revoked,
                  -- evidence_hash, evidence_snapshot_jsonb, superseded_by, rationale
```

**Mechanism:** on any changed input (fact correction, changed decision/preference, changed scope/instruction) recompute the input hash of every artifact whose declared edges include it; where the hash differs → `stale` + invalidation event + minimum repair template; approvals whose `evidence_hash` no longer matches → `suspended` (mechanical), never auto-`revoked` (business act). Artifacts with unchanged hashes stay `current` — that is the whole selectivity guarantee.

**Status vocabulary:** `current` / `stale` / `suspended` / `invalid` / `superseded` (definitions in analysis §6.5 — keep distinct).

**Acceptance scenarios (normative, from analysis §12.5):**

- **C1 — non-valuation correction:** bedrooms 2→3 ⇒ new fact row with provenance + supersession; listing description, publication fields, brochure, matching filters → `stale` + repair work; comparable set, valuation, price recommendation, price approval stay `current` unless the configured methodology declares bedrooms as an input (Gu OS's current one does not); unaffected contract work stays valid; impact view shows affected *and* unaffected.
- **C2 — valuation-impacting correction:** construction area 165→185 m², or corrected location ⇒ comparable set, valuation, price recommendation → `stale`; mismatched-evidence approvals → `suspended`; revaluation + re-approval repair work; unrelated artifacts stay `current`.

Existing seeds to reuse, not replace [V]: `property-identity-signature.ts` (the input-hash pattern over identity fields), document supersession, and source scoring in extraction consolidation.

---

## 12. Conversational intent decomposition [T/D]

Target pipeline: **decompose → resolve referents → dispatch per intent → compose**. Two hard constraints: decomposition is **conservative** (below a confidence floor it degrades to today's single-claim behavior), and unconsumed intents are **recorded even when not executed** ("I did X; I did not act on Y").

Shippable steps, each independent:

1. **Residual field** (Phase 0): extend `PendingDecisionTurn` with `residual` so a claiming gate reports unconsumed text; composed response acknowledges it. Silent loss → visible loss for one field. [D]
2. **Amount binding** (Phase 0): bare-approval parser compares any stated amount to the proposal on record; mismatch → clarify, never approve (Finding 3).
3. **Conservative decomposer** (Phase 4): pre-gate split into candidate intents with confidence floor.
4. **Per-intent gate chain + composition** (Phase 4): Scenarios B and D pass; C-corrections reach the impact plane instead of overwriting JSON.

Normative acceptance criteria: A1/A2 (side questions, including during sticky gates, must not depend on phrasing luck and must be recorded as released), B1/B2 (split effects; mismatch clarifies), D (no silent discard; partial success composed) — full text in analysis §12.5.

---

## 13. Verification and evidence architecture [T/D]

**Contracts.** Every work item carries a `verification_contract_jsonb` naming registered checks (never inline code): schema checks on outputs, reconciliation queries for external effects, domain postconditions (lifted incrementally from `applyPropertyOptioningPostAgentInvariants`), model-graded checks only where declared and never as sole evidence for release gates.

**Evidence records** [D]:

```sql
create table evidence_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  subject_kind text not null,        -- work_item_attempt | workflow_definition | case_artifact | release
  subject_id uuid not null,
  gate text not null,
  artifact_hash text not null,       -- what was tested; freshness = hash still current
  result text not null check (result in ('pass','fail')),
  detail_jsonb jsonb not null default '{}',   -- scrubbed of secrets before persistence
  created_at timestamptz not null default now()
);
```

**Rules** [T]: a worker's "done" is a claim; the runtime executes the contract before accepting `done`; failing evidence returns the item to `blocked` with evidence attached and **does not increment attempts** (a rejected claim is not a failed attempt); artifact change invalidates prior evidence automatically via the hash; evidence is preserved for release review and audit.

---

## 14. SDD and loop-engineering lifecycle [T]

```text
Policy/Constitution → Describe → Clarify → Business Specification → Validate Spec
→ Technical Plan → Contracts, Tasks & Acceptance Tests → Cross-Artifact Analysis
→ Implement → Verify → Classify Failure → Repair the OWNING artifact → repeat
→ Release Candidate → Governed Publication → Observe → Evolve
```

Acceptance scenarios and verification contracts originate in the **specification**, before implementation. Verification failure routes to the smallest responsible artifact (failure-classification table recovered from the prior plan, still consistent with the analysis):

| Failure source | Repair target |
|---|---|
| Wrong/ambiguous expected behavior; missing actor/state/rule/approval | Specification |
| Unsound architecture or integration choice | Plan |
| Missing/misordered work | Tasks/contracts |
| Code defect | Implementation |
| Weak or wrong test | Verification contract |
| Environment/configuration | Environment plan |
| Security or tenant violation | Policy/specification |
| Repeated non-convergence | Human escalation |

Terminal states and limits (analysis §10.2): `needs_clarification` (≤3 clarification rounds), `spec_invalid` (≤2 spec revisions), `non_convergent` (≤3 implement→verify cycles per classification; ≤5 total iterations), plus `awaiting_human_decision`, `release_candidate`, `published`, `rejected`, `rolled_back`. Alternating classifications escalate faster than repeated identical ones. Note: Spec Kit's `/speckit.converge` validates the re-assessment half of this; the classification-to-owning-artifact half is this plan's extension (analysis §2.4/§10.1).

---

## 15. Workflow compiler architecture [T/D]

The compiler is an **instance of the §14 lifecycle**, inheriting its gates and governance — no bespoke process. Pipeline: natural-language description → clarification dialogue (bounded) → **business specification** (versioned and preserved even when unimplementable) → capability map against existing skills/tools/workers → **implementation specification** with an explicit gap list (the gap list is customer-worded backlog, not a dead end) → draft `graph_jsonb` → §5.4 validation gates → simulation against synthetic cases → §10.5-gated publication as `workflow_definitions` version *n+1*.

Generated definitions compose only registry-vetted guards/checks. Generated *code* never executes from a runtime path; it follows the isolated development path (draft → isolated branch → tests → security checks → independent verification → human promotion). [T]

---

## 16. UI/UX and information architecture [T/D/H]

Eight distinct concepts, never re-merged: **Case View** (business truth; brokers never see `ready`/`running`/`blocked`), **Work View** (execution; operator-first, role-gated), **Impact View** (changes, staleness, repair), **Timeline** (events + provenance), **Evidence View** (verification results), **Workflow Studio** (spec + authoring), **Verification Studio** (tests + simulation), **Release View** (publication decision + rollback).

**Information architecture** [D/H]: workflow definitions are governed artifacts with draft/publish/rollback lifecycles — not "settings." The authoring/verification surfaces belong under a dedicated route family (e.g. `/workflows` — name tentative), with `/settings/operational-case-types` retiring after Phase 4. Final route names require examining existing navigation and the role question first [H].

**Prerequisite** [V]: no role model exists beyond `profiles.is_ungga_admin`; navigation is identical for all users. Role-based UI gating must be scoped into Phase 2 (work view) explicitly, not discovered mid-phase.

Liveness copy per §10's note. Inbox differentiates five ask-kinds (business decisions, blocked work, tool approvals, release approvals, compiler clarifications) rather than one undifferentiated pending list.

---

## 17. Capability Lab and Workflow Verification Studio [T/D]

The current readiness lab is **architecturally transitional** (analysis §11.8). Evolution into four concerns, delivered incrementally — not four upfront products:

| Concern | Purpose | Delivery |
|---|---|---|
| **Capability Lab** | Tools, skills, deterministic services, worker profiles tested in isolation: I/O contracts, permissions, integration diagnostics, latency/cost | Successor of today's per-step testing; persists indefinitely as diagnostics |
| **Workflow Verification Studio** | §5.4 static + behavioral gates over a **pinned definition version**, per-gate results (not one "ready" boolean) | Initially the re-anchored lab; absorbed by the compiler studio in Phase 4 |
| **Scenario Simulation & Replay** | Synthetic + historical cases, corrections mid-flight, mixed-intent turns, external waits, failure injection, retry/reconciliation, v1/v2 comparison, shadow execution | A tab of the Verification Studio, not a separate surface |
| **Release Evidence View** | "Why may this version publish": spec version, definition hash, gate results, unresolved findings, approvals, rollback target | A tab of the definition object |

**Preserved assets** [V]: fixtures, self-tests, tool/skill diagnostics, controlled test data, staleness detectors (promoted to production in Phase 3), pattern catalogue, replayable scenarios.

**Non-negotiable parity rule** [T]: all of the above execute the *production* transition evaluator, dispatcher, guards, and verifiers. Whether `run-settings-test-case-tick.ts` duplicates or diverges from the production tick is an open investigation [A] that must be resolved (and any fork closed) **before** lab results count as release evidence — scheduled as a Phase 1 deliverable. Manual execution remains for diagnostics and exploratory UX evaluation; it is never sufficient evidence for publication.

---

## 18. Property-optioning-v2 pilot design [T]

Brownfield, feature-flagged, parallel. v1 untouched and serving all existing cases; v2 is a separate workflow-definition version taking **only new pilot cases** behind a per-tenant flag; every case pinned to its definition version.

**Order of proof:** (1) equivalence before new behavior — identical input sequences replayed through v1 and v2 must produce the same terminal status, business-state sequence (timing may differ), human decision points in order, external effects, and artifacts by content; work-item granularity and event counts may differ. (2) Then one real parallel branch: contract preparation + photo coordination concurrent with comparables analysis (neither depends on price — domain confirmation pending [H]). (3) Then selective repair: C1 and C2 pass with unaffected work staying valid and evidence-bound approvals suspending on relevant input changes. (4) The valuation verifier joins only with a declared verification contract (inputs: comparable set + property facts; explicitly excluded: the reasoning that produced the recommendation; output: pass/fail + findings; read-only).

**Rollback:** flag off; in-flight v2 cases complete on v2 or are completed manually per an explicit operator runbook; v1 cases are never rewritten.

**End-of-pilot comparison:** calendar time to listing, human touches, silent-loss incidents, staleness caught vs missed, operator interventions, cost per case.

---

## 19. Data-model proposal (consolidated) [D]

All additive; nothing alters existing tables beyond nullable columns on `operational_cases`.

| Table | Plane | Introduced |
|---|---|---|
| `workflow_definitions` (incl. ownership, industry/domain_tags, fork lineage) | Definition | Phase 1 |
| `operational_cases` + `workflow_definition_id/_version` | Case | Phase 1 |
| `work_items`, `work_item_attempts`, `work_item_dependencies`, `work_item_events` | Work | Phase 2 |
| `worker_profiles` | Worker | Phase 2 (rows in Phase 3) |
| `case_facts`, `case_artifacts`, `artifact_inputs`, `case_approvals` | Case/Impact | Phase 3 |
| `evidence_records` | Verification | Phase 1 (minimal) → Phase 3 (full) |

Conventions: `user_id` + RLS on every table (owner read, service-role write — matching the existing pattern); append-only streams (`work_item_events`, invalidation events, `case_facts`) get the same UPDATE/DELETE-raising triggers as `operational_case_events`; optimistic-locking `version` columns follow the case pattern; child tables inherit tenant scope via denormalized `user_id` (join-based RLS avoided) [A — confirm against existing child-table convention].

---

## 20. Runtime interfaces and contracts [D]

Tentative TypeScript seams — names illustrative; the point is that these are the *shared primitives* of principle 9:

```typescript
interface TransitionEvaluator {
  evaluate(input: {
    definition: WorkflowDefinitionVersion;
    caseState: { currentStep: string; status: string };
    proposal: { toStep?: string; toStatus?: string; proposer: "model" | "decision_handler" | "runtime" };
    context: CaseFactsSnapshot;
  }): { verdict: "legal" | "illegal" | "requires_approval"; guardResults: GuardResult[] };
}

interface WorkDispatcher {
  propagateReadiness(userId: string, caseId?: string): Promise<number>;
  claimNext(userId: string, runnerRef: string, lease: Duration): Promise<ClaimedWorkItem | null>;
  reportLiveness(attemptId: string, opts?: { renewLease?: boolean; progress?: boolean }): Promise<void>;
  recoverStaleClaims(userId: string): Promise<RecoveredClaim[]>;
}

interface ExecutorAdapter {           // one per execution_mode
  execute(item: ClaimedWorkItem, profile: WorkerProfile): Promise<ExecutorReport>; // report = claim, not truth
}

interface VerificationRunner {
  verify(item: WorkItem, report: ExecutorReport): Promise<EvidenceRecord>;         // decides done vs blocked
}

interface ImpactEngine {
  applyInputChange(change: FactChange | DecisionChange | ScopeChange):
    Promise<{ staled: ArtifactRef[]; suspended: ApprovalRef[]; repairWork: WorkItemRef[]; unaffected: ArtifactRef[] }>;
}

interface IntentDecomposer {
  decompose(turn: InboundTurn): Promise<{ intents: Intent[]; confidence: number; residual: string }>;
}
```

Contract rules: all take/carry tenant identity as **required** parameters; all emit append-only events; `TransitionEvaluator` and `VerificationRunner` are the exact objects invoked by the lab/studio (§17).

---

## 21. Security and tenant isolation [T]

- **Tenancy:** service-role clients bypass RLS [V], so every new query helper takes `userId` as a required parameter (omission = type error); RLS on all new tables as defense in depth; tenant-isolation fixtures in the automated gates (cross-tenant read attempts must fail).
- **Worker scopes:** `allowed_tools` / `allowed_data_scopes` enforced by the runtime at executor selection, never by prompt. No global worker with global data access — only global *profiles* executing within a tenant's scope. Cost ceilings per profile.
- **External participant content** is the primary injection vector and already flows in via Telegram [V]. Facts from external sources carry a distinct source class (source scoring already models this); **no external-sourced fact may satisfy an approval postcondition without a human in the loop**.
- **Generated artifacts:** definitions validated per §5.4 and rejected if credential-shaped content appears; generated code never executes from runtime paths; isolated development path with human promotion is mandatory.
- **Secrets:** reuse `account_tool_secrets` + `user_integrations.encrypted_tokens` exclusively [V]; worker profiles and definitions never embed credentials; evidence records scrubbed before persistence (they are long-lived and append-only).
- **Unattended execution:** the scheduled-task runner's blanket `autoApproveTools: true` is replaced with a risk-scoped allowlist modelled on the operational-case cron policy (Finding 15; Phase 0).
- **Retention:** explicit policy for invalidation events and evidence records required before Phase 3 ships (append-only growth + personal data).

---

## 22. Idempotency and external-effect reconciliation [T]

Work-item creation is idempotent via `idempotency_key` unique per case (safe under retry). External effects need more: any work item with external effects declares a **reconciliation query** in its verification contract; on retry the runtime reconciles first, and if the effect already exists remotely the item completes without re-executing. This generalizes `publication-reconcile.ts` / `publication-remote-snapshot.ts` [V] into the contract mechanism — a refactor of working code, not new invention. At-least-once + idempotency is the accepted guarantee level; exactly-once via an external engine is rejected at current volume (§6.9 thresholds).

---

## 23. Observability and metrics [T/D]

Phase 0 instrumentation (the measurements the go/no-go thresholds depend on): case volume; step durations; correction frequency and which facts; retry counts; verified- vs fluent-completion on unattended channels. Ongoing: per-attempt executor events with profile, model, tokens, duration (cost attribution); claim-contention and stale-claim counters; invalidation/repair counts and over-invalidation ratio (staled-but-repair-found-unnecessary); decomposer confidence distribution and residual rates; Temporal-revisit thresholds tracked explicitly (≈10k transitions/day; ≈500 concurrent cases; >15-min items; >20 definitions; exactly-once compliance need — any two ⇒ revisit).

### 23.1 AI usage metering and cost attribution [T/D]

Cost attribution starts in **Phase 0**, before the work plane exists. Waiting for Phase 3 worker profiles would leave the current main agent, selectors, classifiers, compaction, vision/copy models, cron, and Gu OS Heartbeat unmeasured. The atomic unit is one provider/model call — **not one turn** — because one turn can cause several calls and retries.

Add an append-only `ai_usage_events` ledger [D; migration number fixed in the detailed plan]. Minimum fields:

```text
id, user_id, occurred_at
provider, resource_type='ai_model', operation, model_id, model_role, channel
session_id?, turn_id?, operational_case_id?
workflow_definition_id?, workflow_definition_version?
work_item_id?, work_item_attempt_id?
input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?, total_tokens
reported_cost_microusd?, estimated_cost_microusd?, currency='USD', pricing_version?
latency_ms, status, retry_ordinal, provider_request_id?, metadata_jsonb
```

The Phase 0 migration stores future workflow/work identifiers as nullable correlation UUIDs without foreign keys; their tables do not exist yet and usage retention must not be coupled to deletion of operational entities. Phase 1–3 runtimes populate those fields when available. `agent_sessions.budget_tokens_used` is not the accounting source of truth; it may become a derived convenience counter.

**Capture rules:**

1. Prefer provider-reported usage and cost from OpenRouter/LangChain response metadata. Preserve `reported_cost_microusd` separately from `estimated_cost_microusd`; never overwrite one with the other.
2. If cost is absent, estimate from a versioned model-price catalog captured by `pricing_version`. Historical events are never repriced using today's rates.
3. Capture token categories separately where supplied (input, output, cache read/write, reasoning); unknown values remain `null`, never fabricated as zero.
4. Instrument the shared model boundary/callback and inventory direct OpenRouter/raw-fetch paths so specialized calls do not bypass metering. Persistence failure is observable but does not fail the user turn; use bounded best-effort delivery and an explicit dropped-meter counter.
5. Store no prompts, responses, tool arguments, credentials, or user content in usage events. `metadata_jsonb` is allowlisted operational metadata only.
6. Every event is tenant-scoped by required `user_id`. Writes are service-role only; cross-tenant and ordinary end-user reads are denied. Admin-wide rollups require the existing `is_ungga_admin` gate.

Daily rollups support internal views by tenant, model, role, channel, case, and workflow definition. Required diagnostics: tokens/cost by day; cost per case; distribution by model/role; most expensive calls; reported-vs-estimated coverage; retries/errors; dropped-meter count. Raw events remain the audit source.

**Scope boundary:** this is internal AI observability and cost measurement, **not billing**. No customer prices, credits, quotas, balances, invoices, billable-usage rules, or broker-facing consumption UI enter this plan. The ledger uses `resource_type='ai_model'` plus an operation (`chat_completion`, `embedding`, `vision`, etc.) so later non-model provider costs can be added without redesign, but only AI-model usage is implemented now.

Dashboards are hours of build; trustworthy rates need the observation window (§26).

---

## 24. Feature flags, migration, and rollback [T/A]

- **Flag mechanism** [A]: no dedicated feature-flag framework was found in `apps/web`; flags will follow the existing env-var / per-tenant settings pattern — confirm the concrete mechanism before Phase 1.
- **Advisory → enforcing:** the transition evaluator ships advisory-only (log divergences as events, allow) and flips to enforcing per tenant after a clean observation window.
- **v2 flag:** per-tenant; v2 takes only new cases; dual dispatch paths coexist during the flag period (accepted risk, monitored via §23).
- **Version migration:** published definitions immutable; active cases pin; migrating an active case is explicit (step-key mapping + human approval + audit events on case and work items); no mapping ⇒ case finishes on its version. Rollback = deprecate *n+1*, republish *n* as *n+2*; never mutate history.
- **Data rollback:** every phase's tables are additive; flag-off leaves them as inert audit data with no consumer.

---

## 25. Testing, replay, and acceptance strategy [T]

Layers: (1) self-tests in the existing `*.selftest.ts` style for every new primitive (evaluator verdicts, readiness propagation, CAS claim contention, stale-claim recovery, fan-in/fan-out, advancement predicates, impact selectivity, evidence freshness); (2) deterministic transition tests generated from the definition; (3) scenario tests A1/A2/B1/B2/C1/C2/D as synthetic cases in the harness; (4) historical + synthetic **replay** for v1/v2 equivalence; (5) concurrency **soak** under the v2 flag (real contention, not single-run tests); (6) tenant-isolation fixtures; (7) manual exploratory testing for UX questions only.

All layers run against production primitives (§17 parity). Wiring the suite into a CI gate is a prerequisite deliverable — no CI exists today [V].

---

## 26. Phased implementation plan [T]

Phases exit on **evidence**, not elapsed time. Two clocks per phase: *build effort* (AI-assisted, compressible) and *calendar/observation* (world-bound; compressible only where replay substitutes for real waiting). Observation windows overlap the next phase's build. Durations are tentative estimates, not commitments.

| Phase | Content (dependency-ordered) | Build effort | Calendar / observation |
|---|---|---|---|
| **0 — Instrument & fix** | Metrics (§23), including per-model-call AI usage ledger + internal cost rollups; residual-intent field; price-approval amount mismatch; scheduled-task tool-risk allowlist; duplicate-migration cleanup; terminology cleanup (no "heartbeat" for liveness in code/docs/UI); §29 validation tasks | 2–4 days | 1–2 weeks metrics collection (parallel with Phase 1 build) |
| **1 — Definition executable** | `workflow_definitions` + hash; flow→graph transformation to v1; case pinning; transition evaluator advisory→enforcing; historical replay; minimal `evidence_records`; lab re-anchored to pinned versions + production evaluator (fork closed) | 2–5 days | days–1 week advisory validation on real cases |
| **2 — Work plane** | Work items/attempts/dependencies/events; readiness propagation; claims/leases/executor liveness/stale-claim recovery; attempt limits; dispatch generalization; advancement predicate; operator work view (+ first role gating) | 3–7 days | days of concurrency soak under flag |
| **3 — Impact & workers** | Facts/artifacts/edges/evidence-bound approvals; selective invalidation + repair templates; worker profiles; valuation verifier + two deterministic services; impact view | 3–7 days | enough real corrections to calibrate over/under-invalidation |
| **4 — Multiplexer & compiler** | Conservative decomposition; per-intent dispatch; composition; business/implementation specs; capability mapping; simulation gates; governed publication; compiler studio absorbing verification/release surfaces; `/settings` lab retirement | multiplexer 2–5 days; compiler days–weeks (product-shaped) | UX iteration with the intended author [H] |

Definition of done per phase: §30.

---

## 27. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Definition diverges from SKILL.md prose on port | Diff first (§29.1); treat divergence as findings; advisory window before enforcement |
| Concurrency bugs in claim/dispatch | Share `markCaseProcessing`'s CAS shape; contention self-tests; soak under flag; `claim_expired` events make abandonment visible |
| Over-invalidation trains operators to ignore staleness | Methodology-declared edges, start too-narrow; over-invalidation ratio in §23; human override with rationale |
| Decomposition regression on currently-working turns | Confidence floor degrades to single-claim behavior; residual field guarantees visibility either way |
| Harness/runtime fork invalidates lab evidence | Parity is a Phase 1 deliverable, verified by a check that demonstrably executes the production evaluator |
| Dual dispatch paths during flag period | Time-box the overlap; equivalence-by-replay reduces reliance on parallel operation; explicit tolerance decision [H] |
| Compiler emits valid-but-operationally-wrong definitions | Simulation gate + human publication approval; unimplementable business specs preserved as gap lists, not force-fitted |
| Approval fatigue / habituation | Risk-justified gate list only (§3.10); differentiated inbox; boundaries over prompts |
| Cost runaway or unexplainable AI spend | `cost_ceiling_cents` per profile; attempt limits; Phase 0 call-level usage ledger; reported-vs-estimated cost coverage; anomaly diagnostics |
| Append-only growth with personal data | Retention policy before Phase 3 (§21) |

---

## 28. Open product and domain decisions [H]

1. **Correction frequency and targets** — most affects Phase 3 scope (a no-edge-table "invalidate everything downstream" variant suffices if corrections are rare and early).
2. **Is the pilot's parallel branch real?** Do brokers ever want photos scheduled before price agreement? Determines the pilot branch choice.
3. **Who authors compiled workflows** — operator, brokerage admin, or broker? Changes validation strictness, gates, UI, and cross-tenant sharing.
4. **Broker visibility of work items** — none, embedded per-case summary, or board? Changes Phase 2 UI scope.
5. **Tolerance for dual dispatch paths** during the flag period vs a riskier cutover with replay-only equivalence.
6. **Approval whose evidence changed:** re-derive then re-approve, or surface immediately and let the human decide? Determines whether repair work is automatic or human-triggered.
7. ~~**Valuation methodology declaration**~~ — **Resolved 2026-07-26 [V]** from `perform-comparable-analysis` SKILL.md, `comparable-search-contract.ts` (`buildComparableSearchFilters` / `deriveComparableAreaBand` / `sanitizeComparableSearchFilters`), and `comparable-search-contract.selftest.ts`: hard inputs are zona, operation, property_type, and area band (`area_construida_m2` preferred, else `area_total_m2`; residential strict −15%/+85%); bedrooms/bathrooms/parking are explicitly not hard filters; pricing prefers `price_per_m2` × subject area. See detailed implementation plan §X finding 3.
8. **Route/IA naming** for the workflow studio family (after navigation/role examination).
9. **Owner of shared brokerage workflows** — user-private only for Phase 1–3, or implement `owner_scope = organization` earlier? Default: user + global only until brokerage multi-seat sharing is a real ask.
10. **Skill import / marketplace** — when to build the import pipeline and `account_skill_files` storage; deferred past Phase 4 compiler unless a concrete partner skill pack appears sooner.

---

## 29. Repository assumptions requiring validation [A]

1. **Flow vs SKILL.md agreement** for `property_optioning` — diff them; ~an hour; sizes Phase 1's port.
2. **`run-settings-test-case-tick.ts` duplication/divergence** from the production tick — must be resolved before lab evidence counts (Inference 3).
3. **Duplicate migration numbers** (`00036`, `00044`, `00045`) — runner behavior unverified; resolve in Phase 0.
4. **Production volume** — case counts, step durations, correction rates are unmeasured; §23 instruments them.
5. **Feature-flag mechanism** — no framework found; confirm env-var/settings pattern per tenant.
6. **Child-table tenancy convention** — denormalized `user_id` vs join-based RLS in existing child tables; match it.
7. **Model-mediated transition failure rate** (Inference 1) — measures how much the evaluator will actually reject.
8. **Existing navigation and role wiring** — required before route decisions (§16) and work-view gating.

---

## 30. Definition of done by phase

**Phase 0 done when:** a mixed-intent message produces a response acknowledging the unhandled part; an approval naming a different amount than the proposal clarifies instead of approving; no medium/high-risk tool executes from a scheduled task without an allowlist entry; volume/correction dashboards exist (rates accumulate in parallel); representative main-agent, classifier, compaction, vision/copy, cron, and Gu OS Heartbeat model calls persist tenant-scoped usage events or are explicitly proven inapplicable; internal rollups explain tokens and cost by model/role/channel/turn/case with reported-vs-estimated coverage and dropped-meter visibility; no billing semantics or customer-facing usage UI is introduced; no `heartbeat` terminology remains for claim liveness in docs/plan/UI copy; §29 items 1, 3, 5, 6 answered.

**Phase 1 done when:** every active case is pinned to a definition version; global uniqueness prevents duplicate `(case_type, version)` globals; private fork + lineage works and resolution prefers private over global; an illegal proposed transition is rejected with an appended event (enforcing mode, at least one tenant); historical replay of v1 cases through the evaluator produces identical terminal states; at least one lab check demonstrably executes the production evaluator against a pinned draft version; minimal evidence records exist for gate runs.

**Phase 2 done when:** a v2 case completes end to end with at least one parallel branch; §12.2-style equivalence holds against v1 on replay; claim contention and stale-claim recovery pass self-tests and a soak period with zero silent double-claims; abandoned attempts appear as `claim_expired` events; an item at `max_attempts` lands in `blocked` with a case notification; the operator work view is role-gated and uses the §10 liveness vocabulary.

**Phase 3 done when:** C1 passes (listing artifacts `stale`, valuation/price approval `current`, contract work valid); C2 passes (valuation chain `stale`, approval `suspended`, revaluation work created); the valuation verifier runs read-only under its contract and its evidence gates the price recommendation; publication reconciliation and extraction consolidation execute as deterministic-service workers; over-invalidation ratio is measured.

**Phase 4 done when:** Scenarios A1/A2/B1/B2/D pass as self-tests; a non-engineer creates, validates, simulates, and publishes a simple workflow that runs correctly on a synthetic case; publication is evidence-gated and human-approved; the readiness lab's authoring/verification concerns live in the studio and `/settings/operational-case-types` is retired.

---

## Closing annexes

### A. Accepted architectural decisions (from the analysis; not re-litigated)

1. Workflow definition becomes transition authority before becoming authorable (Decision 1).
2. Work plane as new tables, never as case-table overloading (Decision 2).
3. Approvals bound to evidence hashes (Decision 3).
4. Recommended substrate: Postgres work-item tables + existing lease pattern (alternative 2/7); Temporal rejected with explicit revisit thresholds; LangGraph subgraphs and ephemeral-subagents-as-architecture rejected.
5. Statuses: seven generic work statuses; case vocabulary never shared with work vocabulary.
6. Liveness terminology reserved; `Gu OS Heartbeat` is the product capability only.
7. Impact dependencies declared per methodology; selective invalidation; suspension ≠ revocation.
8. SDD loop with failure classification to the owning artifact; evidence-gated states; bounded iterations.
9. Lab evolution per analysis §11.8; production-primitive parity is non-negotiable.
10. Pilot: brownfield, flagged, equivalence-first, new-cases-only, rollback by flag.
11. Main agent stays on cheap models by default; stronger models are role/profile-scoped via env defaults + `model_policy_jsonb`, promoted only on evidence (§9.1).
12. Workflow ownership mirrors skills: global templates + per-user private defs; customization is **explicit fork with lineage**, not silent shadow of a published global; partial unique indexes for NULL-safe global uniqueness (§5.1 / §5.1.1).
13. `industry` / `domain_tags` are optional catalog metadata on definitions (and optionally skills later); they never invent runtime semantics.
14. Skills stay on the portable package shape (`SKILL.md` + `references/` + reserved `scripts/`); Gu extensions carry tenancy/HITL/tools; external skills are imported with adaptation, never executed as downloaded scripts (§9.2).
15. AI cost measurement is call-level, tenant-scoped, append-only, and begins in Phase 0; it is internal observability, not customer billing (§23.1).

### B. Unresolved decisions

The [H] items in §28 (including owner_scope for organizations and skill-import timing).

### C. Repository validations still required

The eight [A] items in §29.

### D. Assumptions

Vercel-style serverless constraints persist (durable workers deferred on hosting grounds); Supabase Postgres remains the single state store; team size stays small (one focused builder or a pair per phase); pilot volume is low enough for manual runbook rollback; the OpenRouter gateway and model tiering remain as documented.

### E. Recommended ADRs

1. **ADR-001** Workflow definition as runtime transition authority (advisory→enforcing rollout).
2. **ADR-002** Work plane as separate tables; attempt-scoped claim/liveness fields.
3. **ADR-003** Executor-liveness terminology and the `Gu OS Heartbeat` reservation.
4. **ADR-004** Capability-based executor selection; worker profiles; activation bar; model-policy resolution (§9.1).
5. **ADR-005** Evidence-bound approvals and suspension semantics.
6. **ADR-006** Methodology-declared impact dependencies (no field-name inference).
7. **ADR-007** Verification contracts as registry-composed checks; claims vs evidence.
8. **ADR-008** Lab/testing parity: shared production primitives for execution, simulation, replay.
9. **ADR-009** Definition versioning, active-case pinning, migration, rollback; global vs private ownership and fork lineage (§5.1.1).
10. **ADR-010** Tenant scoping as required parameters + RLS defense in depth on new planes.
11. **ADR-011** Skill package interoperability: portable core + Gu extensions; import-with-adaptation; scripts quarantine; account skill file storage when import ships (§9.2).

### F. Proposed technical contracts (first drafts to write)

`TransitionEvaluator`, `WorkDispatcher`, `ExecutorAdapter` (per execution mode), `VerificationRunner`, `ImpactEngine`, `IntentDecomposer` (§20); the `graph_jsonb` JSON Schema (§5.2); the verification-contract and reconciliation-query schemas (§13, §22); the evidence-record shape (§13); `ModelPolicyResolver` (alias → OpenRouter id from env role defaults + `model_policy_jsonb`, §9.1); `forkWorkflowDefinition` / resolution order private-over-global (§5.1.1).

### G. Next specification package to create

For **Phase 0 + Phase 1** (the smallest shippable slice with standalone value):

1. Business spec: "the declared workflow governs transitions" — expected behaviors, divergence handling, operator communication.
2. `graph_jsonb` JSON Schema + the flow→graph transformation spec for `property_optioning` v1 (including the §29.1 diff findings).
3. Transition-evaluator contract + guard-registry spec (porting the four hardcoded guard families).
4. Acceptance tests: transition legality, replay equivalence, pinning, advisory-mode divergence logging.
5. Phase 0 defect specs: residual field, amount-mismatch clarification, scheduled-task allowlist.
6. ADR-001, ADR-003, ADR-009 drafts.
