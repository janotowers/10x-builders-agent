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
9. Model selection for new agentic workers uses Technical Plan §9.1 (`model_policy_jsonb` + role `*_MODEL_ID` env defaults). Do not hardcode vendor model strings in workflow definitions.
10. Workflow customization is **fork-with-lineage**, never silent shadow of a published global (mirrors `account_skills` ownership, not its collision semantics for published defs).
11. AI usage metering is internal observability, not billing: capture one append-only event per model call; do not add customer prices, credits, quotas, balances, invoices, billable-usage rules, or broker-facing usage UI.
12. Cross-channel continuity follows [Gu OS Cross-channel Continuity Architecture](./gu-os-cross-channel-continuity-architecture.md): cases own operational continuity, notifications own pending decisions, and general antecedents use evidence-gated turn artifacts; do not invent a universal conversation thread.

**Verification commands:** `cd apps/web && npm run test:business-decisions` · `npm run test:readiness-test-ui` · `npm run test:publication-workflow` · `npm run test:step-decision` (etc. per `apps/web/package.json` L11–20); root `npm run type-check && npm run lint`.

---

## PHASE 0 — Instrument & fix

### Slice 0.1 — Residual-intent preservation

**Status:** [x] done (2026-07-29)
**Objective:** a gate that claims a turn reports the text it did not consume; the composed response acknowledges it. Silent loss → visible loss.

**Tasks (ordered):**
- [x] 1. Read `pending-decision-router.ts` L78–120 and map every `handled: true` return site (L347, 438, 463, 520, 586, 616, 657, 769).
- [x] 2. Extend the handled branch of `PendingDecisionTurn` (L97) with `residual?: { text: string; reason: "unparsed_remainder" | "unmatched_intent" } | null`.
- [x] 3. In each deterministic parser that claims a prefix/pattern (`parsePriceApprovalDecision` and the gate-3+ handlers), compute the unconsumed remainder (text minus the matched decision segment, trimmed; empty ⇒ `null`). *(New shared module `apps/web/src/lib/business-decisions/residual-intent.ts`.)*
- [x] 4. Populate `residual` at every `handled: true` return site.
- [x] 5. In the channel adapters that render the handler `message` (web chat + Telegram paths that consume `resolvePendingDecisionTurn`), append a fixed-format acknowledgment line when `residual` is non-empty: "No actué sobre: “…”". *(Shared `appendResidualAcknowledgment`.)*
- [x] 6. Append a case event when residual is non-empty and a case is bound. *(Implemented as `event_type: "human_decision"` with `payload.kind: "residual_reported"` — the `operational_case_events.event_type` CHECK constraint closes the vocabulary; the payload discriminator is the repo pattern.)*

**Modify:** `apps/web/src/lib/business-decisions/pending-decision-router.ts`, `price-approval.ts`, gate handlers in `business-decisions/`, the adapter call sites (locate via grep for `resolvePendingDecisionTurn`). **Create:** none. **Migrations:** none. **Types:** the union-branch extension only. **UI:** message text only. **Tests:** extend `pending-decision-router.selftest.ts` + `price-approval.selftest.ts` — mixed-intent fixture asserts `residual` non-empty and message contains the acknowledgment; single-intent fixture asserts `residual` null. **Flags:** none (additive field; absence = current behavior). **Security:** none new. **Evidence:** selftests green; a Scenario-B fixture shows the acknowledgment string. **Rollback:** revert commit. **Depends on:** nothing.

### Slice 0.2 — Price-approval amount binding (Finding 3)

**Status:** [x] done (2026-07-29)
**Objective:** a bare approval that names an amount different from the proposal on record clarifies instead of approving.

**Tasks:**
- [x] 1. In `price-approval.ts`, add an amount extractor for the approval branch (reuse the existing `adjust`-branch amount parsing for `salida=`/`ideal=`/`minimo=` as the pattern base; add bare `$X` / `X millones` forms). *(`extractApprovalAmount` + `approvalAmountCandidates`.)*
- [x] 2. In the handler (approval path around L176–200): if the parsed text names an amount and it differs from `context.pricing_proposal`, return a clarification `message` and **do not** call `updateOperationalCase`. *(A bare approval amount matches if it equals **either** `salida` or `ideal` — resolves the [A]: both are proposal-record amounts, so naming either is consistent. Mismatch event uses `event_type: "human_decision"` + `payload.kind: "price_approval_amount_mismatch"`, same constraint rationale as 0.1-6.)*
- [x] 3. Tolerance rule: exact-match after normalization (thousands separators, "millones" scaling); no fuzzy tolerance in this slice.

**Modify:** `apps/web/src/lib/business-decisions/price-approval.ts`. **Tests:** extend `price-approval.selftest.ts`: "Aprobar $4.8 millones" vs proposal 5.2M ⇒ no approval + clarification; "Aprobar" bare ⇒ approves as today; "Aprobar $5.2 millones" matching ⇒ approves. **Flags:** none — this is a correctness fix. **Rollback:** revert. **Acceptance:** the three fixtures above; router selftest unaffected. **Depends on:** 0.1 (shares parser edits; do 0.1 first to avoid rebase).

### Slice 0.3 — Scheduled-task tool-risk allowlist (Finding 15)

**Status:** [x] done (2026-07-29)
**Objective:** no medium/high-risk tool executes from a scheduled task without an explicit allowlist entry.

**Tasks:**
- [x] 1. Read `apps/web/src/app/api/cron/scheduled-tasks/route.ts` L200–260 and `apps/web/src/lib/operational-cases/operational-case-cron-tool-policy.ts` (+ its selftest) — the operational-case cron's narrow policy is the model.
- [x] 2. Create `apps/web/src/lib/scheduled-tasks/scheduled-task-tool-policy.ts` [D]: risk-scoped allowlist defaulting to the low-risk set; per-task `toolApprovalPolicy` may *narrow*, never widen.
- [x] 3. Replace `autoApproveTools: true` (L242) with the policy object; non-allowlisted tool calls route to the pending inbox (existing HITL path) instead of auto-executing. *(Pending confirmations send a `tool_confirmation_pending` notification via `notify` and skip the normal Telegram result.)*
- [x] 4. Add `scheduled-task-tool-policy.selftest.ts` and wire an npm script (`test:scheduled-task-policy`).

**Modify:** `scheduled-tasks/route.ts`. **Create:** policy module + selftest. **Flags/compat:** env escape hatch `SCHEDULED_TASKS_LEGACY_AUTOAPPROVE=true` for one release [D], default off. **Risks (expected, per plan):** tasks that silently depended on auto-approval start landing in the inbox — information, not regression; log each occurrence. **Evidence:** selftest proves `calendar_delete_event` / `telegram_send_message_to_contact` / `easybroker_publish_listing` are not auto-approved; a seeded task run shows inbox routing. **Rollback:** env flag on → prior behavior. **Depends on:** nothing.

### Slice 0.4 — Instrumentation and metrics

**Status:** [x] done (2026-07-29) — observation window now accumulating once `AI_USAGE_METERING_ENABLED=true` is set per environment after the migration is applied
**Objective:** establish the measurements the go/no-go thresholds need and close the existing predictable-cost gap with tenant-scoped, call-level AI usage attribution before new workers are introduced.

**Tasks:**
- [x] 1. Derive step durations and volumes from existing data first: `operational_case_events` already timestamps `state_changed` — write read-only queries in `packages/db/src/queries/operational-case-metrics.ts` [D] (all take `userId` or an explicit admin-wide flag gated on `is_ungga_admin`). *(Note: `step_key` lives inside `payload_jsonb`, not as a column.)*
- [x] 2. Migration `00064_ai_usage_events.sql` [D]: create append-only `ai_usage_events` per Technical Plan §23.1 with required `user_id`, `provider`, `resource_type='ai_model'`, `operation`, `model_id`, `model_role`, token-category columns, reported/estimated cost in integer micro-USD, `currency`, `pricing_version`, latency/status/retry/provider-request fields, and nullable correlation IDs (`session_id`, `turn_id`, `operational_case_id`, future workflow/work IDs). Add indexes for `(user_id, occurred_at)`, `(user_id, turn_id)`, `(user_id, operational_case_id)`, and future attempt correlation. Do not add FKs to future tables. Add update/delete rejection trigger; RLS denies ordinary user reads/writes and follows the existing service-role + `is_ungga_admin` pattern for internal rollups.
- [x] 3. Add `AiUsageEventInput`, `AiUsageContext`, token/cost breakdown types in `packages/types/src/ai-usage.ts`; export from `packages/types/src/index.ts`. Add service-write and admin/tenant-rollup queries in `packages/db/src/queries/ai-usage.ts`, exported from `packages/db/src/index.ts`. `agent_sessions.budget_tokens_used` remains non-authoritative (left untouched; no derived counter added).
- [x] 4. Create `packages/agent/src/usage/ai-usage-meter.ts` [D]: normalize LangChain/OpenRouter usage metadata, preserve reported and estimated cost separately, use a versioned model-price catalog only when provider cost is absent, and persist best-effort. Unknown token categories stay `null`. A metering write failure logs a structured error and increments a dropped-meter counter but never fails the user turn.
- [x] 5. Instrument the shared model boundary and inventory every bypass: model factories/callbacks in `packages/agent/src/model.ts` (main/compaction/selector/reviewer via LangChain callbacks); direct OpenRouter calls in `embeddings.ts`, `tools/realestate-adapters.ts` (`callOpenRouterJsonTool`: vision + listing copy), `tools/operational-cases-adapters.ts` (predial vision extraction); and the five model-backed classifiers/extractors under `apps/web/src/lib/` (pending-decision-unclear, operational-conversation, listing-description-change, contract-commercial, owner-characteristics). Attribution is **ambient** (`AsyncLocalStorage` in `usage/ai-usage-context.ts`) rather than explicit parameter threading: web chat and Telegram webhook bind at the route entry (covers pre-agent classifiers); `runAgent` binds/enriches for graph, cron, scheduled-task and Heartbeat paths. Direct calls now send `usage: { include: true }` so OpenRouter returns billed cost. **Deliberately unmetered:** `tools/predial-extraction-probe.ts` — standalone CLI dev harness (reads `.env.local` directly, hardcoded local PDF), never runs in a tenant context.
- [x] 6. Add correction detection: `detectIntakeFactOverwrites` in `operational-cases-adapters.ts` appends `event_type: "state_changed"` + `payload.kind: "fact_overwritten"` with the overwritten key names (same CHECK-constraint rationale as 0.1-6) — no behavior change.
- [x] 7. Add rollups by day, tenant, model, role, channel, turn, case, and workflow definition (pure helpers in `packages/db/src/queries/ai-usage.ts`). Internal/admin UI at `/settings/ai-usage` (metering is global, not case-only; sidebar link for `is_ungga_admin`). Tokens/cost by day, cost per case, model/role/channel/tenant distribution, most expensive calls, reported-vs-estimated coverage, errors/retries and dropped-meter count. No broker-facing usage view.
- [x] 8. Wire the remaining §23 counters skeleton (work retry counts arrive in Phase 2; TODO markers referencing Slice 2.3 at the bottom of `ai-usage-meter.ts`).

**Files:** modify the call sites in task 5 and the relevant API/cron adapters; create migration, types, DB queries, usage meter, price-catalog fixture, and selftests. **Tests:** usage normalization fixtures for provider-reported usage/cost, estimated-cost fallback, cache/reasoning tokens, missing metadata, retry attribution, and persistence failure; tenant-isolation SQL/query selftest; overwrite-detection helper; representative main-agent, classifier, embedding, vision/copy, cron, and Gu OS Heartbeat calls each produce an attributable event. Assert no prompt/response/tool arguments enter `metadata_jsonb`. **Flags/compat:** `AI_USAGE_METERING_ENABLED` [D], off locally/test unless a fixture recorder is injected; enable per environment after migration. Metering failure never changes model-call behavior. **Security:** required `user_id`; service writes only; admin-wide reads gated; allowlisted metadata; no user content or secrets. **Evidence:** internal dashboard explains tokens/cost by model/function/channel/execution/case; reported-vs-estimated coverage and dropped-meter count visible; volume + correction rates accumulate. **Rollback:** disable flag; append-only rows remain inert audit data; revert UI/query consumers before dropping nothing. **Depends on:** nothing. **Scope:** AI-model usage only; explicitly no billing or customer pricing. **Note:** the 1–2 week observation window runs in parallel with Phase 1.

### Slice 0.4.1 — Metering reliability (LangChain cost + auditable catalog)

**Status:** [x] done (2026-07-29)
**Objective:** close the production gap where LangChain roles (`main_agent`, `skill_selector`, …) fell back to catalog estimates while direct-fetch call sites already stored OpenRouter `usage.cost`; make catalog estimates auditable and keep dashboard semantics unambiguous.

**Tasks:**
- [x] 1. Capture OpenRouter billed cost on the LangChain path: keep `__includeRawResponse: true`, extract `provider_request_id` + `usage.cost` from message metadata/`__raw_response`, and add a shared `configuration.fetch` interceptor (`openrouter-usage-capture.ts`) that stashes `{id, usage}` from non-streaming `/chat/completions` JSON before LangChain reshapes the payload. Apply to all OpenRouter ChatOpenAI factories in `model.ts`.
- [x] 2. Dual-cost persistence: always stamp `estimated_cost_micro_usd` + `pricing_version` when tokens + catalog allow, even when reported cost exists. Accounted cost remains `reported ?? estimated ?? 0` (never sum both for one event).
- [x] 3. Immutable catalog snapshots under `packages/agent/src/usage/catalogs/`: preserve historical `2026-07-29.1`; active `2026-07-29.2` generated from OpenRouter public model APIs (corrects GPT-5.4 Mini to $0.75 / $4.50 per 1M). Scripts: `generate-model-price-catalog.mjs`, `validate-model-price-catalog.mjs` (CI/prebuild), optional `check-model-price-catalog-drift.mjs` (manual/scheduled, not CI).
- [x] 4. Rollups/dashboard (baseline): bucket `effectiveCostMicroUsd` summed per event; coverage shown as `N de M (pct)` plus money coverage; **Costo contabilizado** as the accounted total; **Reportado por proveedor** / **Estimado de catálogo** as components with per-bucket event counts; dual-cost Δ when both present; truncation warning at 10k rows.
- [x] 5. Tests: extended meter/catalog/db selftests (stash fallback, dual-cost, no double-count in rollups, historical snapshot replay); opt-in live probe `AI_USAGE_OPENROUTER_PROBE=true` (`test:ai-usage-openrouter-probe`).

**Evidence:** new LangChain events should carry `reported_cost_micro_usd` + `provider_request_id`; dashboard accounted total matches Σ reported when coverage is 100%; estimates remain for comparison only. **Limitation:** append-only historical rows from before this slice may still lack reported cost on LangChain roles — do not rewrite them. **Depends on:** 0.4. **Blocks:** trusting metering as go/no-go evidence before Phase 1.

### Slice 0.4.2 — Admin exploration dashboard

**Status:** [x] done (2026-07-29)
**Objective:** make internal AI usage explorable and reconcilable without broker-facing billing UI; provider-neutral copy; one canonical URL.

**Tasks:**
- [x] 1. **Canonical URL** `/settings/ai-usage` only (removed legacy `/operational-cases/usage` redirect). Sidebar entry **Configuración → Uso de IA** visible when `profiles.is_ungga_admin = true`.
- [x] 2. **Interactive client** (`apps/web/src/app/settings/ai-usage/ai-usage-dashboard-client.tsx`): server loads ledger window via `?days=7|30|90`; client filters (cuenta, proveedor, canal, función de IA, modelo, estado); KPIs and tables recalc on filtered set; period reload is server-side.
- [x] 3. **Exploration views** (same costs, not additive): global rollups (día, proveedor, modelo, función, canal); nested **Por cuenta** with **Por ejecución** (`turn_id`, expandable desglose por función de IA), **Por caso operacional**, and **Sin ejecución correlacionada** (`turn_id` null); paginated tables (10/25/50).
- [x] 4. **Terminology:** provider-neutral labels (**Reportado por proveedor**, **Estimado de catálogo**, **Por función de IA**, **Por ejecución**); dynamic `event.provider` in data columns; admin timezone from `profiles.timezone`.
- [x] 5. **Coverage hygiene:** `recordAiUsageEvent` always runs `enrichWithCatalogEstimate`; dashboard alerts when tokens exist but catalog estimate is missing; extended db selftests for executions, uncorrelated reconciliation, provider rollup, pagination helpers.

**Evidence:** admins can reconcile reported vs estimated coverage; execution duration visible via second-precision timestamps; filter options derive from loaded events (e.g. Telegram appears once metered). **Scope:** observability only — explicitly no billing. **Depends on:** 0.4, 0.4.1.

### Slice 0.5 — Repository validations and hygiene (Technical Plan §29)

**Status:** [x] done (2026-07-29)
**Objective:** answer the [A] items that size Phase 1; clean known hygiene issues.

**Tasks:**
- [x] 1. **Flow vs SKILL.md diff** (§29.1): done — findings note in §X.1. Sizes the S1.2 transformation.
- [x] 2. **Harness fork investigation** (§29.2): done — findings note + S1.6 parity work list in §X.2.
- [x] 3. **Duplicate migrations** (§29.3): documented as immutable history (the Supabase CLI orders lexicographically by full filename, so within each duplicated number the `_name` suffix decided order; renumbering would desync `schema_migrations` on deployed environments). Guard added: `scripts/validate-migrations.mjs` (freezes the 00036/00044/00045 pairs, fails prebuild on any NEW duplicate or malformed name), wired into root `prebuild` and `validate:migrations`.
- [x] 4. **Flag mechanism** (§29.5): decision recorded in §X (finding 7): per-tenant boolean rows in a new `account_feature_flags` table (`user_id`, `flag_key`, `enabled`, service-role writes, user reads own row — same tenancy pattern as 0.5-5); env vars only for global kill-switches (e.g. `AI_USAGE_METERING_ENABLED`, `SCHEDULED_TASKS_LEGACY_AUTOAPPROVE`). Migration ships with S1.4 (its first consumer).
- [x] 5. **Child-table tenancy convention** (§29.6): `operational_case_documents` (00037) pattern confirmed and adopted for all new child tables: denormalized `user_id uuid not null references profiles(id) on delete cascade` alongside the parent FK; composite indexes lead with `user_id`; RLS = user `select using (auth.uid() = user_id)` + service-role manage-all. `00064_ai_usage_events` already follows it (stricter: no user read policy — internal-only ledger).
- [x] 6. **Terminology sweep** (§29 / plan §3.8): clean — every runtime `heartbeat` reference is the Gu OS Heartbeat product feature (channel enum value, `api/cron/heartbeat`, prefetchers/checklist/skill `heartbeat:` mode) or Telegram's typing-indicator helper (`withTypingHeartbeat`, UX keepalive, unrelated to claims). The case lease (`markCaseProcessing`) never uses the word. No renames needed.
- [x] 7. **CI seed:** root `test:selftests` chains `apps/web` business-decisions / scheduled-task-policy / intake-extraction plus `@agents/agent` ai-usage-meter; `.github/workflows/ci.yml` runs `validate:skills`, `validate:migrations`, `type-check`, `lint` (non-blocking until the pre-existing lint errors in §X finding 10 are burned down) and `test:selftests` on PR + main.

**Evidence:** findings notes in §X; CI workflow runs green on a no-op PR. **Depends on:** nothing. **Blocks:** S1.2 (needs 1), S1.6 (needs 2), all Phase ≥1 migrations (needs 3), S1.4 (needs 4).

---

## PHASE 1 — Make the definition executable

### Slice 1.1 — `workflow_definitions` schema + case pinning

**Status:** [x] done (2026-07-29)
**Objective:** versioned definitions exist; every case is pinned; ownership/catalog fields leave room for private forks and multi-industry catalogs.

**Tasks:**
- [x] 1. Migration `00065_workflow_definitions.sql` [D]: table per Technical Plan §5.1 con `owner_scope`, `user_id`, reserved `organization_id`, `workflow_key`, `industry`, `domain_tags`, lineage, `visibility`, `definition_hash`, ownership CHECK, los dos partial unique indexes (finding 5) y RLS (globals legibles; privados solo del dueño). Extra: triggers que hacen inmutables las filas `published` (única mutación permitida: `status → deprecated`) y prohíben DELETE de published/deprecated.
- [x] 2. Migration `00066_operational_cases_definition_pin.sql` [D]: columnas `workflow_definition_id` + `workflow_definition_version` (nullable) + índice parcial.
- [x] 3. Backfill inside `00066`: se ejecutó S1.2 primero, así que el backfill embebe el **output real del transformer** (grafo + `definition_hash` sha256 generados con `scripts/generate-workflow-definition-seeds.ts` contra los flows globales vivos): `property_optioning` v1 (10 estados) y `lead_follow_up` v1 (1 estado terminal). Casos de tipos privados sin definición global quedan sin pin (el evaluator los salta). Verificado en DB: 2 definiciones, 120/120 casos pinned.
- [x] 4. `packages/db/src/queries/workflow-definitions.ts` [D]: `getWorkflowDefinitionById`, `getPublishedDefinition(id, version)`, `getLatestPublishedDefinitionForUser` (privado publicado > global publicado), `insertDraftDefinition`, `forkDefinition` (lineage + siguiente versión privada), `publishDefinition` (solo desde draft/validated; inmutabilidad la garantiza el trigger), `listWorkflowDefinitionsForCaseType` (admin).
- [x] 5. Pin at creation en `createOperationalCase`: resuelve `getLatestPublishedDefinitionForUser` y estampa ambas columnas (null si no hay definición).

**Types:** `packages/types/src/workflow-definitions.ts` (`WorkflowDefinition`, `WorkflowGraph`, `WorkflowOwnerScope`, `WorkflowEnforcementMode`, …) exportado desde el índice; `OperationalCase` ganó los dos campos de pin. **Tests:** unicidad global/privada y la inmutabilidad de publish las garantizan índices/triggers en SQL (sin selftest DB-less posible); resolución y fork cubiertos por revisión + uso en replay real. **Evidence:** backfill verificado (120/120 pinned). **Rollback:** columnas nullable; el evaluator con flag `off` no las lee.

### Slice 1.2 — `packages/workflows` package: graph schema + flow→graph transformer

**Status:** [x] done (2026-07-29)
**Objective:** the executable `graph_jsonb` contract exists and v1 graphs are generated from existing flows.

**Tasks:**
- [x] 1. Scaffold `packages/workflows` [D] (patrón `packages/types`: source-only, `main`/`types` → `src/index.ts`, `tsx` selftests; deps: `@agents/types` + zod).
- [x] 2. `src/graph-schema.ts`: zod schema del shape §5.2 + `validateWorkflowGraph` con gates estructurales (schema, estados únicos/conocidos, aciclicidad, reachability desde el estado inicial, sin dead-ends no terminales, guards registrados). Nota: se exporta el validador ejecutable en vez de una derivación JSON-schema — mismo propósito de gate, sin dependencia extra.
- [x] 3. `src/transform-flow.ts`: transformer con las decisiones D1–D6 de §X.1 como decisiones explícitas comentadas en el código: `property_data_review` y `published` promovidos a estados de primera clase; cadena adyacente + skip declarado `documents_received→comparables_in_progress` (D6); guard `external_response_exists` portado tal cual (D4 se difiere a v2 por paridad de replay); umbral de comparables `defensible_comparables_sample` (D5). `approval_required` queda null en v1 (aprobaciones evidence-bound llegan en Fase 3); proposers permisivos en v1 (estrechar es decisión v2 post-advisory).
- [x] 4. `src/hash.ts`: JSON canónico (orden de claves recursivo) + `definition_hash = sha256:<hex>` — estable ante reordenamiento de claves jsonb.
- [x] 5. Selftests (`test:hash`, `test:transform-flow`): orden de estados = `PROPERTY_OPTIONING_STEP_ORDER`, gates estructurales verdes, guards en las transiciones correctas, bindings con `bigquery_context`, estabilidad/sensibilidad del hash, flujo genérico lineal (lead_follow_up).

**Create:** `packages/workflows/*`. **Modify:** nada en root (`packages/*` glob) ni turbo.json (tareas estándar).

### Slice 1.3 — Transition evaluator + guard registry

**Status:** [x] done (2026-07-29)
**Objective:** `TransitionEvaluator` (Technical Plan §20) exists and the four hardcoded guard families are ported into named registry guards.

**Tasks:**
- [x] 1. `packages/workflows/src/guards/registry.ts` [D]: `registerGuard(name, fn)` + lookup; guards puros sobre `{ caseType, caseState, proposal, facts, stateOrder }`.
- [x] 2. Guards portados (originales intactos — el evaluator duplica durante advisory; retiran en S1.7+):
  - [x] `step_order_no_regression` — rango desde el orden de estados del grafo pinned (= `PROPERTY_OPTIONING_STEP_ORDER` en v1);
  - [x] `external_response_exists` — gate de awaiting-documents portado tal cual (D4 documentado);
  - [x] `publication_keys_protected` — la lista canónica ahora vive en `@agents/workflows` y `publication-workflow.ts` la re-exporta (una sola fuente, sin drift);
  - [x] `completion_pairing` — pareja `published`/`completed` (el summary gate rico sigue en el adapter durante advisory);
  - [x] extra: `defensible_comparables_sample` (consumo §X.1 punto 4: `unique_comparable_count >= 3`).
- [x] 3. `src/transition-evaluator.ts`: `evaluateTransition(...)` → `legal | illegal | requires_approval` + resultados por guard; corre guards globales (regresión, claves protegidas, pairing) en toda propuesta y los guards de la transición declarada; razones estructuradas (`undeclared_transition`, `unauthorized_proposer`, `unknown_guard`, `guard_failed`).
- [x] 4. Selftests (`test:transition-evaluator`): matriz completa de transiciones declaradas legal desde su `from`; muestra de no declaradas illegal; unit tests de los 5 guards con fixtures (regresión, sin external_response, 2 vs 3 comparables, claves protegidas, pairing, caso sin paso inicial, guard desconocido).

**Evidence:** selftests enumeran la matriz completa v1 (10 transiciones declaradas).

### Slice 1.4 — Advisory wiring at the three proposal sites

**Status:** [x] done (2026-07-29) — ventana advisory iniciada
**Objective:** every proposed transition is evaluated; divergences are logged as events; behavior unchanged (advisory).

**Tasks:**
- [x] 1. Flag `workflow_enforcement_mode`: migración `00067_account_feature_flags.sql` (finding 7, con columna extra `value_text` para flags enum) + `getWorkflowEnforcementMode` en `@agents/db` — sin fila = `advisory` (default tras este slice); `value_text` `off`/`enforcing` para los otros modos.
- [x] 2. Site 1 — model proposals: `operational_case_update_state` llama `adviseCaseTransition` (nuevo `packages/agent/src/workflows/transition-advisor.ts`) antes de los guards existentes; en advisory registra y continúa; en enforcing devuelve `{ ok:false, error:"workflow_transition_rejected", ... }` estructurado al modelo (S1.7-2 ya implementado, inerte hasta el flip).
- [x] 3. Site 2 — decision handlers: los 10 handlers de `business-decisions/` pasan por `advisedUpdateCase` (`apps/web/src/lib/operational-cases/advised-case-update.ts`), proposer `decision_handler`.
- [x] 4. Site 3 — runtime: clausura del publication runner (`published`/`completed`) y sucesor de intake (`conversational-intake-orchestrator`) pasan por `advisedRuntimeCaseUpdate`, proposer `runtime`. Además el wrapper registra `state_changed`/`workflow_step_transition` en cambios de paso exitosos (cierra el hueco de instrumentación que reveló el replay — finding 13). Otros paths de runtime que escriben pasos (`property-optioning-post-agent-invariants`, `document/photo-batch-completion`, `characteristics-response`) quedan como candidatos de expansión de la ventana advisory.
- [x] 5. Loader cacheado `packages/workflows/src/load.ts` por `(definitionId, version)` con fetcher inyectado (las definiciones publicadas son inmutables; errores no se cachean).

**Divergencias:** evento `state_changed` + `payload.kind = "transition_divergence"` (patrón finding 9) con verdict, guards fallidos, from/to, proposer, site y pin de definición (id/version/hash); `transition_rejected` cuando enforcing rechaza. La evaluación advisory nunca rompe el path (try/catch + log). **Observability pendiente:** conteo de divergencias/día en el dashboard 0.4. **Rollback:** flag `off` por tenant.

### Slice 1.5 — Minimal evidence records

**Status:** [x] done (2026-07-29)
**Objective:** gate runs produce persisted, hash-pinned evidence.

**Tasks:**
- [x] 1. Migration `00068_evidence_records.sql` [D] per §13: `subject_kind`/`subject_id`/`gate`/`artifact_hash`/`result`/`detail_jsonb`, tenancy 00037 (user_id denormalizado, RLS user-select + service manage), triggers append-only. Scrubber en `packages/workflows/src/evidence.ts`: redacción por nombre de clave (patrón secret/token/key/…) + por valor sembrado de los env vars con nombre secreto; selftest `test:evidence`.
- [x] 2. `packages/db/src/queries/evidence-records.ts`: `insertEvidenceRecord` (pasa SIEMPRE por el scrubber — no bypasseable) + `listEvidenceForSubject` (userId requerido). `@agents/db` ahora depende de `@agents/workflows` (sin ciclo: workflows solo depende de types).
- [x] 3. Emisión: los replay runs (S1.6) insertan evidencia `gate="historical_replay"` pinneada al `definition_hash` — 30 registros reales creados en la primera corrida. Emisión desde checks del lab queda con S1.6-2 (pendiente).

**Rollback:** tabla inerte.

### Slice 1.6 — Lab re-anchor: pinned versions + production evaluator (parity)

**Status:** [~] parcial (2026-07-29) — replay + evidencia hechos; selector de versión y swap del lab pendientes
**Objective:** lab runs are pinned to a definition version and demonstrably execute the production evaluator; the 0.5-2 fork findings are closed or explicitly ticketed.

**Tasks:**
- [ ] 1. Add a definition-version selector to the readiness lab (`apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx` + `page.tsx`): default = latest published; drafts selectable.
- [ ] 2. Replace lab-side transition logic with calls into `packages/workflows` evaluator (work list from 0.5-2 — every reimplemented function either imports the production primitive or is deleted).
- [x] 3. Historical replay harness: núcleo puro en `packages/workflows/src/replay.ts` (selftest `test:replay` en el paquete) + `apps/web/src/lib/operational-cases/replay-definition.ts` [D] + driver `apps/web/scripts/replay-definitions.ts` (npm `test:replay` en `@agents/web`). Recorre el stream de eventos, reevalúa cada transición grabada con el evaluator de producción contra la definición pinned, se re-ancla en `payload.from` cuando el stream saltó transiciones (contador `unrecordedGaps` — finding 13) y verifica el estado terminal.
- [x] 4. Cada replay inserta evidencia `historical_replay` pinneada a `definition_hash`. Corrida real (30 casos): 17 replays exactos sin divergencias, 1 divergencia real de guard (`defensible_comparables_sample` en un avance histórico de comparables), 13 con historia incompleta (transiciones nunca grabadas como eventos — no bugs del evaluator; el wrapper de S1.4 ya graba `workflow_step_transition` hacia adelante).

**Pendiente (tickets explícitos):** 1.6-1 selector UI; 1.6-2 swap del lab al evaluator + assert por identidad de módulo; la lista de paridad P0/P1/P2 de §X.2 sigue vigente.

### Slice 1.7 — Enforcement flip

**Status:** [ ] pending — código del flip ya implementado e inerte; falta la ventana advisory y el triage
**Objective:** the definition is the transition authority for at least one tenant.

**Preparación (hecha con S1.4):** los tres sitios ya rechazan en modo enforcing — el adapter devuelve `{ ok:false, error:"workflow_transition_rejected", reason, failed_guards, hint }` al modelo y los wrappers devuelven null (el handler muestra su mensaje de reintento); el evento `transition_rejected` (payload.kind) queda registrado. **El flip es solo datos:** `setAccountFeatureFlag(userId, "workflow_enforcement_mode", true, "enforcing")` para el tenant piloto. Rollback: borrar la fila o `value_text` a `advisory`/`off`.

**Tasks:**
- [ ] 1. Triage the advisory window's divergences to zero-or-explained — consulta: eventos `state_changed` con `payload.kind='transition_divergence'` agrupados por `site` + from/to (candidato a card en el dashboard 0.4).
- [ ] 2. Flip `workflow_enforcement_mode = "enforcing"` for the pilot tenant.
- [ ] 3. After one clean week: mark the duplicated hardcoded guard call sites with removal TODOs (actual removal is Phase 2+ cleanup, after soak).

**Phase 1 exit checks (Technical Plan §30):** [x] every active case pinned (120/120 + pin-on-create) · [ ] illegal transition rejected with event (enforcing, ≥1 tenant — código listo, flip pendiente de triage) · [~] historical replay identical terminal states (17/30 exactos; 13 con historia de eventos incompleta pre-instrumentación — finding 13; hacia adelante el wrapper graba las transiciones) · [ ] ≥1 lab check on production evaluator against a pinned draft (S1.6-2) · [x] minimal evidence records exist (30 `historical_replay`).

---

## PHASE 2 — Work plane

### Slice 2.1 — Work-plane schema

**Status:** [ ] pending
**Objective:** `work_items`, `work_item_attempts`, `work_item_dependencies`, `work_item_events` exist per Technical Plan §7/§10.

**Tasks:**
- [ ] 1. Migration `00069_work_plane.sql` [D]: four tables exactly as Technical Plan §7/§10 (attempt-scoped claim/liveness fields; `last_liveness_at` comment "Unrelated to the Gu OS Heartbeat proactive-execution feature"; seven statuses; `unique (case_id, idempotency_key)`; deferred FK `work_items.current_attempt_id`).
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
- [ ] 1. Migration `00070_impact_plane.sql` [D]: `case_facts` (append-only + trigger), `case_artifacts`, `artifact_inputs`, `case_approvals` per Technical Plan §11 / analysis §7.3; RLS convention.
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

### Slice 3.4 — Worker profiles + first three workers + model policy

**Status:** [ ] pending
- [ ] 1. Migration `00071_worker_profiles.sql` [D] per Technical Plan §9; queries module with required `userId`; no credentials fields.
- [ ] 2. Register deterministic services: `publication_reconciliation` (wrap `publication-reconcile.ts` + `publication-remote-snapshot.ts`) and `extraction_consolidation` (extract the consolidation section of `property-optioning-post-agent-invariants.ts` behind an explicit input/output contract — refactor, not rewrite; keep the original callable until v2 owns it). Deterministic profiles have empty/ignored `model_policy_jsonb`.
- [ ] 3. Valuation verifier as `specialized_agent` [D]: isolated context = comparable set + property facts **only** (never the recommendation's reasoning); output pass/fail + findings; read-only tool surface; evidence gates the price-recommendation artifact. Seed `model_policy_jsonb` with `role: valuation_verifier`, `model_alias: reasoning_high` (or `reasoning_standard` until upgrade criteria trip).
- [ ] 4. Implement `ModelPolicyResolver` in `packages/workflows` (or `packages/agent/src/model.ts` extension) per Technical Plan §9.1: profile policy → role env (`WORKFLOW_VERIFIER_MODEL_ID`, etc.) → `MAIN_AGENT_MODEL_ID`. Add defaults/exports next to existing `DEFAULT_*_MODEL_ID` constants; document in `.env.example` / architecture notes (do not commit secrets).
- [ ] 5. Runtime scope enforcement: executor selection checks `allowed_tools`/`allowed_data_scopes` before dispatch (deny + `blocked_reason` on mismatch).
- [ ] 6. Reuse the Phase 0 `ai_usage_events` ledger; populate `workflow_definition_id`, `work_item_id`, `work_item_attempt_id`, worker profile in allowlisted metadata, and the **resolved model id** for every model-backed attempt. Do not create a second worker-cost event store. Record verifier false-accept/reject counters for the §9.1 upgrade criteria.

**Depends on:** 2.4, 3.2. **Security:** scopes enforced at selection, not prompt; tenant inheritance from work item's `user_id`; model allowlist cannot point outside configured OpenRouter roles.

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
- [ ] 1. `apps/web/src/lib/business-decisions/intent-decomposer.ts` [D]: model-backed splitter (zod schema following `operational-conversation-classifier.ts` conventions) with confidence floor; below floor ⇒ single intent = whole turn. Resolve model via `WORKFLOW_INTENT_DECOMPOSER_MODEL_ID` → `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID` → `MAIN_AGENT_MODEL_ID` (§9.1).
- [ ] 2. Run before the gate chain; each intent flows through the existing chain independently; results composed into one response (composition helper + selftest).
- [ ] 3. Residual from 0.1 remains the safety net for anything the decomposer misses.
- [ ] 4. Scenario selftests: A1/A2/B1/B2/D from Technical Plan §12 as fixtures (LLM-dependent assertions follow the existing classifier-selftest pattern for mocking/live-key gating [A — confirm how classifier selftests handle the API key]). Instrument residual/mis-split rates for model-upgrade criteria.

**Depends on:** 0.1, 0.2; C-intents need 3.2 to land effects.

### Slice 4.2 — Compiler artifacts + gates + studio + publication

**Status:** [ ] pending
- [ ] 1. Spec artifacts: business spec + implementation spec + capability map schemas in `packages/workflows/src/compiler/` [D]; capability map resolves against skills catalog, `TOOL_CATALOG`, and worker profiles; unresolved = explicit gap list. Compiler LLM uses `WORKFLOW_COMPILER_MODEL_ID` (§9.1).
- [ ] 2. Validation gates: schema, acyclicity, reachability, capability resolution, permission validation, credential-shape rejection — each emits evidence records.
- [ ] 3. Simulation gate: replay harness (1.6) + scenario suite against the draft definition.
- [ ] 4. Studio UI (route family per §16 decision [H]): describe → clarify (bounded) → spec views → capability/gap panel → validation findings → simulation results → publish/reject. Support **fork from global template** into a private definition (Technical Plan §5.1.1) and show `industry` / `domain_tags` as catalog fields (not runtime switches).
- [ ] 5. Retire `/settings/operational-case-types` authoring after the studio covers it (keep capability-lab diagnostics; redirect + deprecation notice first release).

**Phase 4 exit checks:** [ ] A1/A2/B1/B2/D selftests pass · [ ] a non-engineer creates/forks, validates, simulates, and publishes a simple workflow that runs on a synthetic case · [ ] publication is evidence-gated + human-approved · [ ] settings lab authoring retired · [ ] if Slice 4.4 was activated, its cross-channel scenarios pass without silent/cross-tenant association.

### Slice 4.3 — Skill package interoperability (deferred foundation; not a Phase 0–2 blocker)

**Status:** [ ] pending · **Depends on:** Phase 4 compiler landing; ADR-011 draft accepted.
**Objective:** document and, when prioritized, implement import-with-adaptation toward the portable skill package shape without allowing download-and-run scripts.

**Tasks (when scheduled):**
- [ ] 1. Write ADR-011 from Technical Plan §9.2 (portable core vs Gu extensions; quarantine; no silent activation).
- [ ] 2. Design `account_skill_files` **or** object-storage bundle + manifest hash so private skills can carry `references/` / `assets/` (closes the `body_md`-only gap vs globals).
- [ ] 3. Import pipeline stub: validate `SKILL.md` → map Gu fields → capability/gap report → human activation as `account_skills` (private) or global PR path.
- [ ] 4. Scripts: accept into quarantine only; promotion path is “register deterministic_service”, never model-chosen arbitrary execution.
- [ ] 5. Optional frontmatter `industry` / `domains` on Gu skills after parser schema bump (catalog only).

**Do not** block Phases 0–3 on this slice.

### Slice 4.4 — Cross-channel antecedent resolution (deferred; evidence-gated)

**Status:** [ ] deferred · **Activation gate:** Technical Plan §28.11. Do not schedule solely because a future channel is imaginable.
**Objective:** let an internal user safely continue a recent non-case result across web and Telegram (for example, “of the ten leads you showed me in web…”) without merging all channel histories or promoting transient results to memory.

**Tasks (only when activated):**
- [ ] 1. Baseline current behavior with fixtures: web→Telegram and Telegram→web for (a) unique recent result, (b) two ambiguous result sets, (c) missing/expired antecedent, (d) cross-tenant attempt, and (e) operational-case follow-up that must stay on existing case routing.
- [ ] 2. Define `TurnArtifact` in `packages/types` and first try a bounded, allowlisted representation in existing `agent_messages.structured_payload` / `tool_calls.result_json`; create a new `turn_artifacts` table only if retention/query/security requirements cannot be met safely. Required fields follow the cross-channel architecture §5 (`user_id`, `turn_id`, channel/session, type, source tool, normalized scope, stable entity refs, provenance, TTL).
- [ ] 3. Add `cross-channel-antecedent-resolver.ts` [D] before skill selection/per-intent dispatch: trigger only on referential language; search recent interactive sessions for the same `user_id`; rank by structural compatibility, entity/count/filter match and recency; return `resolved | clarify | missing`, never an unconstrained model guess.
- [ ] 4. For dynamic warehouse results, re-query current data using the recovered entity/filter scope; disclose refresh/staleness. Do not reconstruct exact members from model prose or personal memory.
- [ ] 5. Compose channel-neutral UX: “Retomando la lista consultada hoy en web…” on one high-confidence match; concise date/filter/channel options on ambiguity; request missing context otherwise.
- [ ] 6. Instrument candidate count, auto-resolution, clarification, user correction, missing/expired and cross-channel direction. A wrong-association report disables auto-resolution by feature flag while clarification-only mode remains.
- [ ] 7. Tests: tenant isolation, artifact expiry, no prompts/secrets in artifact metadata, no authority widening after channel switch, case/HITL routing precedence, exact ten-lead scenario in both directions.

**Flags/compat:** `CROSS_CHANNEL_ANTECEDENTS_MODE=off|clarify_only|resolve` [D], default `off`; rollout per tenant after replay. **Security:** required tenant scope; verified internal Telegram account only; external-contact messages excluded; bounded artifact payload and retention. **Rollback:** set flag `off`; artifacts remain inert until retention cleanup. **Depends on:** 4.1; may reuse Phase 0 metrics and model policy. **Non-goals:** unified transcript UI, universal `conversation_id`, automatic channel-switch commands, durable-memory ingestion of every answer. **Phase impact:** optional unless the activation gate is taken.

---

## X. Contradiction log and findings

> Record here any material contradiction between repository reality and the Technical Plan, with a proposed decision. Do not resolve architectural contradictions unilaterally.

| # | Date | Finding | Impact | Decision needed / taken |
|---|---|---|---|---|
| 1 | 2026-07-26 | No CI and no root test aggregator exist (plan §25 assumes wiring is possible; it is — task 0.5-7) | Low | Taken: add `test:selftests` + GitHub Actions in 0.5-7 |
| 2 | 2026-07-26 | No feature-flag framework (plan §24 [A] confirmed) | Medium | Needed: 0.5-4 mechanism decision |
| 3 | 2026-07-26 | **Valuation methodology verified in repo** (closes former [H] on valuation inputs). Hard search filters for comparables are: `zona`/`neighborhood`, `operation`, `property_type`, area band from `area_construida_m2` (else `area_total_m2`) with residential strict −15%/+85% (`deriveComparableAreaBand` / `buildComparableSearchFilters` in `packages/agent/src/operational-cases/comparable-search-contract.ts`). Skill `perform-comparable-analysis` L100–101: "No uses recámaras/baños/estacionamientos ni topes de precio inventados como filtros duros." `sanitizeComparableSearchFilters` drops bedrooms/bathrooms/parking; selftest L57–58 and L164–168 assert they stay undefined. Pricing (`prepare-listing-price` / `pricing-proposal.ts`) prefers `price_per_m2` p25/p50 × subject area. Fallback ladder: `expanded` → `wide` → `location_only` (drops area, still not bedrooms). Avaclick is contrast/informational for casas/depto. | High (unlocks 3.2-3) | **Taken:** encode impact edges as in slice 3.2 task 3; C1/C2 acceptance criteria remain correct |
| 4 | 2026-07-27 | Model selection for workers was only implied by empty `model_policy_jsonb`. | Medium | **Taken:** Technical Plan §9.1 + slices 3.4 / 4.1 / 4.2 — role env vars + resolver + evidence-based upgrades; main agent stays cheap |
| 5 | 2026-07-27 | `UNIQUE (user_id, case_type, version)` would allow duplicate global definitions (NULL uniqueness). Private customization must not silently shadow published globals. | High | **Taken:** partial unique indexes + explicit `forkDefinition` lineage (Technical Plan §5.1 / §5.1.1; slice 1.1) |
| 6 | 2026-07-27 | `account_skills` is body-only; globals already use Anthropic-like package dirs (`references/`, reserved `scripts/`). Marketplace import needs adaptation, not download-and-run. | Medium (Phase 4+) | **Taken:** Technical Plan §9.2 + ADR-011 + deferred slice 4.3; Phases 0–3 unblocked |
| 7 | 2026-07-29 | Flag mechanism (0.5-4): no framework exists; existing per-user surfaces (`user_tool_settings`, `user_skill_settings`) are entity-scoped, not free-form flags. | Medium | **Taken:** new `account_feature_flags` table — `user_id uuid not null` (00037 tenancy pattern), `flag_key text`, `enabled boolean`, `unique (user_id, flag_key)`; service-role writes, user reads own rows. Env vars only for global kill-switches. Migration lands with S1.4 (first consumer). |
| 8 | 2026-07-29 | Duplicate migration numbers 00036/00044/00045 (0.5-3) are deployed history; Supabase CLI ordered them lexicographically by full filename. | Low | **Taken:** frozen as immutable; `scripts/validate-migrations.mjs` allowlists exactly those pairs and fails prebuild/CI on any new duplicate. |
| 9 | 2026-07-29 | `operational_case_events.event_type` has a closed CHECK constraint; plan tasks named new event types (`residual_reported`, `price_approval_amount_mismatch`, `fact_overwritten`). | Low | **Taken:** repo pattern — reuse an allowed `event_type` and discriminate with `payload.kind`. Used by 0.1-6 (`human_decision`/`residual_reported`), 0.2-2 (`human_decision`/`price_approval_amount_mismatch`), 0.4-6 (`state_changed`/`fact_overwritten`). |
| 10 | 2026-07-29 | Pre-existing lint errors (8) unrelated to Phase 0 work: `app-shell.tsx` (setState-in-effect), `publication-review.ts` / `publication-reconcile.ts` / `publication-runner.ts` (prefer-const), `telegram/webhook/route.ts` L~2890 (prefer-const), `scripts/lab/retry-ungga-publish-case.ts` (2× no-explicit-any). One selftest regex flag error (`publish-destination-approval.selftest.ts` `/s` flag vs tsc target) was fixed in Phase 0. | Low | Needed: burn down, then flip the CI lint step from `continue-on-error` to blocking. |
| 11 | 2026-07-29 | LangChain `@langchain/openai@0.4.9` only copies `usage` into `response_metadata` when `system_fingerprint` is present; OpenRouter often omits it. Early Slice 0.4 smokes showed `main_agent` / `skill_selector` with estimated-only cost despite OpenRouter returning `usage.cost` on direct-fetch paths. Hardcoded catalog also understated GPT-5.4 Mini ($0.60/$2.40 vs live $0.75/$4.50). | High (metering trust) | **Taken:** Slice 0.4.1 — HTTP fetch stash + dual-cost + immutable OpenRouter-sourced catalog snapshots; dashboard “Costo contabilizado”. |
| 12 | 2026-07-29 | Decisiones del transformer v1 (S1.2, consume §X.1): D1/D2/D3 resueltos promoviendo `property_data_review` y `published` a estados de primera clase; D6 como transición skip declarada; D5 codificado como `defensible_comparables_sample` (>=3). **D4 se porta tal cual** (`external_response_exists`) para que el replay histórico sea paridad exacta con runtime — arreglar la rama `internal_user` es decisión v2 explícita. `approval_required` queda null en v1 (aprobaciones evidence-bound = Fase 3) y los proposers quedan permisivos (estrechar = decisión v2 post-advisory). Desviación menor de finding 7: `account_feature_flags` ganó columna `value_text` para flags enum (primer consumidor: `workflow_enforcement_mode`). | Medium | **Taken:** codificado en `transform-flow.ts` con comentarios D1–D6; revisar D4 y proposers al preparar v2. |
| 13 | 2026-07-29 | El replay histórico (S1.6) contra 30 casos reales mostró que **el stream de eventos no captura todas las transiciones de paso**: los pasos tempranos (intake→awaiting_documents→documents_received vía orchestrator/batch-completion) y la clausura del publication runner no grababan eventos con `from/to.current_step` — 13/30 casos con historia incompleta (0 transiciones grabadas o cierre ausente). No son bugs del evaluator. | Medium (calidad del advisory/replay) | **Taken:** el replay se re-ancla en `payload.from` y reporta `unrecordedGaps` en vez de falsas divergencias; `advisedUpdateCase` ahora graba `state_changed`/`workflow_step_transition` en todo cambio de paso exitoso (sitios 2 y 3). Candidatos de expansión: `property-optioning-post-agent-invariants`, `document/photo-batch-completion`, `characteristics-response`. |
| — | | *(append as found)* | | |

**Open [H] gates blocking specific tasks:** ~~valuation-methodology inputs~~ (resolved — finding 3); route/IA naming (blocks 2.5-2, 4.2-4 final names — interim names acceptable behind role gate); dual-dispatch tolerance (informs 2.6 soak length); approval re-derivation vs immediate surfacing (informs 3.3-2 UX); organization-owned workflows (default: global+user only until asked); skill-import timing (slice 4.3).

### X.1 Findings note — Flow vs SKILL.md diff (§29.1, feeds S1.2)

**Verdict: three sources of truth disagree on the step inventory.** `operational_flow_jsonb` for `property_optioning` has **8 step_keys** ending at `package_ready`; runtime/guards additionally use **`property_data_review`** and **`published`** as `current_step` values; the coach SKILL map omits both.

**Reconstructed final step order** (migrations `00025` seed → `00027`, `00038`, `00039`, `00043`–`00046`, `00050`, `00051` [rename `photos_scheduled`→`photos_requested`], `00053`–`00056`, `00058`–`00061` [branches/`step_decision`]; `00048` intake-schema only; `00062`/`00063` don't touch the flow):

1. `intake` — tools `operational_case_create`/`operational_case_update_state`; no step skill; no `step_decision`.
2. `awaiting_documents` — skill `request-property-documents`; branch `document_request_target`: `internal_user` → `waiting_internal` + `notify_user`; `external_contact` → `waiting_external` + Telegram.
3. `documents_received` — skill `extract-property-characteristics`; branch `critical_property_data`: `complete` → notify + "avanza a `property_data_review`" (named in branch prose only); `pending_external` / `pending_internal` → stay.
4. `comparables_in_progress` — skill `perform-comparable-analysis`; branch `defensible_comparables_sample`: `defensible` (`usable_count > 0`) → `price_proposal_pending`; `insufficient` → stay + notify.
5. `price_proposal_pending` — `prepare-listing-price`.
6. `contract_pending` — `prepare-commission-contract`.
7. `photos_requested` — `request-property-photos`.
8. `package_ready` — `publish-listing-package` (last element; no `published` step_key).

**Divergences (flow jsonb × SKILL prose × hardcoded guards):**

| # | Topic | Divergence |
|---|---|---|
| D1 | Step inventory | Flow: 8 keys. Coach map (`property-optioning-coach/SKILL.md` L118–134): same 8, omits `property_data_review`/`published`. `PROPERTY_OPTIONING_STEP_ORDER` (`operational-cases-adapters.ts` L3729–3740): inserts **both**. Triple mismatch. |
| D2 | `property_data_review` | Only named in branch *description* (00060/00061), not a flow step → step-bound skill resolution returns null there; guards/notify gates set it as a real `current_step`. |
| D3 | `published` | Absent from flow + coach map; `publish-listing-package` prose L166–167 and completion gate (L4396–4415) both require `published`/`completed` pairing. |
| D4 | Awaiting-docs guard | `blockedAwaitingDocumentsTransitionReason` (L3713–3727) requires a recent `external_response` with **no internal exception**, contradicting the `internal_user` branch (flow + request skill advance on internal upload/"listo"). |
| D5 | Comparables threshold | Flow branch metadata says `usable_count > 0`; guards require persist + `defensible_sample` / `unique_comparable_count >= 3` (`MIN_DEFENSIBLE_UNIQUE_COMPARABLES`, `comparables-analysis.ts` L93). Flow understates the runtime threshold. |
| D6 | Post-docs next step | `extract-property-characteristics` prose L155–156 jumps to `comparables_in_progress`, skipping the intermediate `property_data_review` rank that guards enforce. |
| D7 | Intake tools | Flow intake `step_tools` (00039) omit `operational_case_update_intake`; coach prose and runtime complete intake with exactly that tool. |
| D8 | HITL wording | Coach guardrails say the human approves price, not comparable rows; adapters implement comparables-expansion/Avaclick HITL kinds. Soft copy mismatch. |
| D9 | Missing steps → skill fallback | Ticks on `property_data_review`/`published`/`intake` fall through to `default_skill_slug` (coach composite) instead of a step-bound skill. |

**S1.2 consumption:** (1) promote `property_data_review` and `published` to first-class graph states (or stop using them as `current_step`); (2) align coach map + extract prose with that choice; (3) fix the awaiting-documents guard for the `internal_user` branch; (4) encode the comparables transition as `unique_comparable_count >= 3` / `defensible_sample`, not `usable_count > 0`. Each becomes an explicit `transitions` decision in the transformer, not a silent choice.

### X.2 Findings note — Harness fork investigation (§29.2, feeds S1.6)

**Verdict:** `runSettingsTestCaseAgentTick` (lab harness) and cron `processCase` are **forked tick implementations with an inverted dependency**: the cron route imports `applyPostAgentContractHandling` and `createPublicationRunnerOwnedAgentTick` *from the harness file*, and production `package_ready` publication ticks actually execute **through the harness** via `createPublicationRunnerOwnedAgentTick` → `runSettingsTestCaseAgentTick`. The cron also carries a dead import of `runSettingsTestCaseAgentTick` (route.ts L98).

**Key divergences by phase** (cron `apps/web/src/app/api/cron/operational-cases/route.ts` vs harness `apps/web/src/lib/operational-cases/run-settings-test-case-tick.ts`):

- **Claim/lease:** same `markCaseProcessing` primitive, divergent policy — cron 5-min lease, no retry; harness 1-min lease, up to 4 retries for controlled E2E.
- **Tool policy:** cron uses `buildOperationalCaseCronToolApprovalPolicy` (bookkeeping-only auto-exec); harness uses `buildPublicationAwareE2EToolApprovalPolicy` + `SETTINGS_TEST_AUTO_EXECUTE_TOOLS` (much wider). `toolCallSource` set only by harness (`"agent_e2e"`).
- **Tick message:** cron `buildCaseTickMessage` (short trigger) vs harness `buildCaseE2ETickMessage` (L1206–1523, step-scripted prose).
- **Cron-only phases the harness skips:** media-group ack flush, pending-HITL short-circuit + advisor notice, stale tool-confirmation cleanup, `syncContractDraftFromToolCalls`, `stabilizeInternalDocumentWait`, error event + `+10min` backoff, stuck `+5min` re-arm.
- **Harness-only phases:** `healStalePublishFlowBlockers`, document-extraction preflight, deterministic agent bypass for `documents_received`/`price_proposal_pending`, large owned `package_ready` remediation block (L2060–2400), `package_ready` entry gated on `listingDescriptionIsApproved` (cron always enters `requestPublicationProgress`).
- **Weaker reimplementations in harness:** incomplete-intake skip returns a message without clearing `nextActionAt` or inserting the skip event (cron does both).
- **Correctly shared already:** DB primitives (`markCaseProcessing`, case CRUD, events, sessions), `runAgent`, `ensureAgentToolDepsWired`, `applyPropertyOptioningPostAgentInvariants`, `requestPublicationProgress`, intake-successor/step-order guards (agent adapters), suppress/settings-test predicates.

**S1.6 parity work list (priority order):** P0 — extract one shared `runOperationalCaseAgentTick` (claim → HITL skip → message → `runAgent` → invariants → contract → schedule) with lab behaviors as flags; unify tick message, tool policy (one production policy + explicit lab wideners), and claim/lease policy (`claimCaseForTick({ leaseMinutes, retries })`); move `applyPostAgentContractHandling` + `createPublicationRunnerOwnedAgentTick` out of the lab file and delete the dead cron import. P1 — share incomplete-intake skip side effects, HITL short-circuit/advisor notice, `stabilizeInternalDocumentWait`, `syncContractDraftFromToolCalls`, stuck/error scheduling policy, and align the `package_ready` entry gate. P2 — keep deterministic bypasses/doc-extraction preflight/`healStalePublishFlowBlockers` as explicitly lab-only hooks (or promote deliberately); relocate `classifyPublicationExecutionFromToolCalls` next to `publication-runner.ts`; extract a shared `listTurnToolCalls` helper.

---

## Y. Standing per-slice exit ritual

Before marking any slice done: `npm run type-check` · `npm run lint` · affected `apps/web` test scripts · new selftests wired to an npm script (and CI once 0.5-7 lands) · terminology check (no `heartbeat` for liveness) · tenancy check (every new query requires `userId`) · this document's checkboxes and Status lines updated.
