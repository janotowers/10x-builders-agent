# R1 Relationship Operations — Concept → Shared Kernel Mapping

> **Version:** v0.9  
> **Status:** Discovery / architecture input — aligned with R1 Architecture Analysis v0.12, completed Generic Case↔Case audit, accepted ADR-109/ADR-110 and completed minimum Traditional Gu legacy source audit; not an ADR or Technical Plan  
> **Initiative:** R1 — Relationship Operations v1  
> **Companion Brief:** `docs/product/initiatives/relationship-operations/brief.md` — v0.9 approved for Feature / Business Spec and Architecture Analysis  
> **Repository reviewed:** `janotowers/10x-builders-agent`, `main`  
> **Legacy source audit:** `docs/product/initiatives/relationship-operations/legacy-source-audit.md` — v0.1 complete for R1 Technical-Plan entry  
> **Purpose:** Map the approved R1 product concepts to the Gu OS durable-work primitives that already exist, identify genuine gaps, and prevent Relationship Operations from becoming a domain-specific mini-runtime.

## 1. Decision this mapping supports

The question is not “what tables should Relationship Operations create?” The question is:

> **Which R1 concepts are already representable by the shared Gu OS operating kernel, which require only Relationship-specific semantics, and which reveal a missing cross-domain primitive or architecture decision?**

The governing constraint is:

> **Relationship Operations must be implemented as a specialization of Gu OS's shared durable-work kernel, not as a domain-specific runtime or mini-application.**

The desired shape is:

```text
                         GU OS SHARED OPERATING KERNEL

   Case root / truth          Work Plane             Impact / authority
   -----------------          ----------             ------------------
   operational_cases          work_items             case_facts
   case events                attempts               case_artifacts
   workflow definitions       dependencies           case_approvals
   definition pinning         work events            provenance
   scheduling / wake-up       verification contracts impact repair

                               +

              shared notification / engagement policy
              shared conversation binding / routing seams
              shared tools / Skills / adapters / guards
              shared AI usage / economic telemetry seam

                               ↓

                    RELATIONSHIP OPERATIONS
          Lead Opportunity semantics + domain policies
          visit progression + source/evidence semantics
          matching/follow-up/reconciliation capabilities

                               ↓

       Traditional Gu / WhatsApp / Mongo / Firebase / CRM / inventory
```

This mapping deliberately does **not** approve exact schemas, new migrations, API shapes, enum names, or repo-specific implementation plans.

## 2. Source-status discipline

Every statement in this mapping should be read under one of these labels:

- **CURRENT — REPO VERIFIED:** observed in the current Gu OS repository/migrations/docs reviewed for this mapping.
- **CURRENT — DOMAIN CONFIRMED:** current Traditional Gu behavior/data topology confirmed by product/domain leadership but not source-verified in the legacy repository for the specific statement.
- **CURRENT — LEGACY SOURCE VERIFIED:** observed directly in the audited Traditional Gu production repositories/branches recorded in `legacy-source-audit.md`.
- **TARGET — PRODUCT APPROVED:** direction approved in Relationship Operations P0-1 through P0-8.
- **OPEN — ARCHITECTURE:** a durable technical choice or missing contract that must be resolved through Architecture Analysis / ADR after fuller source inspection.
- **OPEN — SPEC:** exact externally meaningful behavior or domain vocabulary to define in a Feature / Business Spec.
- **OPEN — TECHNICAL DESIGN:** architecture/source contract is sufficiently known, but exact implementation mechanics remain downstream.

Absence from the reviewed files is **not proof that a capability is absent from the entire repo**. Where this mapping says “not found,” it means “not established by the evidence reviewed here.”

> **v0.9 status-reading note:** classifications such as **ARCHITECTURE DECISION**, **GENERIC EXTENSION CANDIDATE**, **OPEN — ARCHITECTURE** and the A1–A9 queue below record what this discovery mapping identified/escalated at the time it was produced. They are not, by themselves, the current unresolved-status register after Architecture Analysis v0.12. Current architecture resolution is governed by `architecture-analysis.md` and the accepted ADRs. Traditional Gu source-audit questions that blocked Technical-Plan entry are now governed by `legacy-source-audit.md`; remaining exact adapter/schema/reconciliation mechanics are Technical Design.

## 3. Shared kernel inventory verified in the current repo

| Shared primitive / contract | Current verified role | R1 implication |
|---|---|---|
| `operational_case_types` | Catalog of Case types with root Skill, default reminder policy, activation metadata/flow metadata. | Relationship should register/specialize a Case type; it should not create a separate Case engine. |
| `operational_cases` | Multi-day commercial Case instance with `case_type`, generic `status`, `current_step`, `next_action_at`, `due_at`, `context_jsonb`, assignment and optimistic `version`. | Natural durable root for a Lead Opportunity. Runtime state remains generic rather than becoming a CRM funnel. |
| `operational_case_events` | Append-only Case timeline. Initial schema has a deliberately small/closed event vocabulary. | Useful audit/timeline primitive, but R1 should not force every domain fact/event into this field set or create a second timeline without architecture review. |
| Case runner / deterministic due scanner | Processes due `active` / waiting Cases, re-reads state, uses optimistic locking and invokes the root Skill through `case_runner`. | Reuse for durable reconsideration; no Relationship-specific cron/scheduler. |
| `workflow_definitions` | Versioned executable workflow artifact (`graph_jsonb`), owner scope, business/implementation spec payloads, definition hash, lineage and immutable published versions. | R1 behavioral structure that truly belongs to workflow definition should use this versioned contract. |
| Case definition pinning | `operational_cases` can pin `workflow_definition_id` + version. | Existing Cases can remain reproducible while definitions evolve; no hidden prompt-only behavior drift. |
| Transition/evaluator/guard model | Workflow definitions contain states, transitions, guards, authorized proposers, approvals, postconditions, work templates, impact dependencies and completion contract. | Relationship should reuse guards/postconditions where deterministic guarantees are needed, while avoiding a rigid stage funnel. |
| `work_items` | Generic executable units owned by a Case (or later a Work Run), with work type, capability, status, priority, `not_before`, `due_at`, idempotency, I/O/verification contracts and result. | Strong fit for follow-up/reconciliation/coordination units that must persist, retry and close with evidence. |
| `work_item_attempts` | Per-attempt execution, claims/leases, liveness/progress, result/error/evidence. | Reuse execution/recovery semantics; no Relationship-specific retry machinery. |
| `work_item_dependencies` | Generic dependency graph; readiness derives from dependencies. | Available if R1 work genuinely has dependency edges; do not manufacture a procedural DAG for ordinary opportunistic relationship work. |
| `work_item_events` | Append-only Work timeline with open event vocabulary. | Useful for execution trace independent of business truth. |
| `case_facts` | Append-oriented commercial facts with `fact_key`, value, source kind/ref, confidence and explicit supersession. | Direct fit for durable requirements, interpreted prospect facts, accepted visit outcomes and other Opportunity truth with provenance. |
| `case_artifacts` + `artifact_inputs` | Generated outputs pinned to declared inputs; staleness can be computed. | Available for material generated artifacts; most Relationship state should remain facts/work, not gratuitous artifacts. |
| `case_approvals` | Human decisions pinned to evidence hash/snapshot; supports approve/reject/suspend/revoke/supersede semantics. | Direct fit for consequential human gates such as protected commercial/contractual decisions, when a true approval is required. |
| `evidence_records` | Append-only pass/fail evidence for workflow/release/gate verification subjects. | **Not the current business-evidence store for visit facts.** Do not map `visit_attended` evidence here by name alone; use Case fact provenance unless architecture generalizes this primitive. |
| `default_reminder_policy_jsonb` + Case reminder overrides | Shared reminder/escalation policy at Case type and user/case override levels. | Reuse for waiting/reminder behavior where applicable. |
| `engagement_policy_overrides_jsonb` | User-level engagement policy seam explicitly covering cooldowns, escalation and delivery windows by audience/kind. | Confirms the shared policy concept already exists. Exact prospect-facing WhatsApp applicability/resolution must be verified before R1 depends on it. |
| `operational_case_conversation_bindings` | Durable conversation ↔ Case binding for late replies, interruptions and ambiguity; current DB channel constraint is `web` / `telegram`. | Reuse the pattern; WhatsApp/external prospect-channel support needs a generic extension or different existing binding found in further audit. |
| `durable_tasks` + `work_runs` | Independent durable root for work that is not a commercial Case; Work Items attach to exactly one Case or Work Run. | Confirms a Lead Opportunity belongs as a Case, while unrelated batch/recurrent jobs should not create phantom Opportunities. |
| `ai_usage_events` | Append-only internal AI-model usage ledger with provider/model role, tokens, reported/estimated micro-USD cost, `pricing_version`, retries and correlation seams for session/turn/Case/workflow/Work Item/Attempt. Explicitly **not billing**. | Strong existing base for AI cost-to-serve. R1 must propagate correlation consistently; non-AI resource usage and shared-cost allocation need a generic cross-domain design rather than Relationship-only tables. |

### 3.1 Important kernel separation already encoded in the repo

The Work Plane migration explicitly states that **business truth stays on `operational_cases`; executable work lives in the Work Plane; Case vocabulary and Work vocabulary never mix**. The Durable Task root likewise states the conceptual distinction: **Case = commercial truth/file of responsibility; Durable Task = execution/result of independent work**.

That distinction should be preserved in R1:

```text
Lead Opportunity
    = commercial responsibility / Case

"Ask advisor whether yesterday's visit happened"
    = executable reconciliation work / Work Item

"Recompute a batch inventory digest every night"
    = potentially Durable Task / Work Run, not a Lead Opportunity
```

### 3.2 Economic telemetry seam already exists, but is narrower than the target

`ai_usage_events` already encodes several important cross-domain design choices: append-only usage events, provider-reported vs locally estimated cost, versioned pricing, retries as additional cost-bearing events, and correlation to `operational_case_id`, `workflow_definition_id`, `work_item_id` and `work_item_attempt_id`. Its schema is deliberately restricted to `resource_type = ai_model` and explicitly says it is **internal observability, not billing**.

R1 should therefore **extend the economic-observability direction, not replace it**:

```text
resource usage observed
        ↓
resource/provider cost determined
        ↓
direct attribution OR shared-cost allocation
        ↓
Case / Work Item / Attempt / Durable Task / account-level economics
        ↓
aggregate cost-to-date and final cost by business activity/outcome

SEPARATE PLANE:
customer price / credits / balance / recharge
```

This mapping treats non-AI resource metering and multi-object cost allocation as a generic platform seam to resolve in A9.

## 4. R1 Concept → Shared Kernel Mapping

The classification is intentionally conservative:

- **REUSE** — existing shared primitive appears to fit the approved product concept.
- **DOMAIN SEMANTIC** — use shared primitive(s), but Relationship defines the business meaning/rules.
- **GENERIC EXTENSION CANDIDATE** — current primitive exists but does not yet clearly satisfy the cross-domain contract.
- **ARCHITECTURE DECISION** — needs source/architecture work before choosing the mechanism.
- **SPEC DECISION** — product direction is approved, but exact behavior/vocabulary still belongs in the Feature / Business Spec.

| R1 concept | Proposed kernel mapping | Classification | What is already supported | Remaining question / guardrail |
|---|---|---|---|---|
| **Lead Opportunity durable root** | `operational_cases` + Relationship `case_type` + pinned `workflow_definition` | **REUSE** | Generic commercial Case root, scheduling, status, assignment, events, versioning, definition pinning. | Do not create `lead_opportunity_cases` as a parallel runtime unless an architecture analysis proves a separate domain entity store is necessary for non-runtime querying; Case remains the durable responsibility root. |
| **Opportunity Admission** | Domain admission capability → create/attach Case using generic Case creation contract | **DOMAIN SEMANTIC + SPEC** | Generic Case creation exists. | Define commercial admission policy and dedup/identity checks. Traditional Gu should not become the owner of the admission judgment. |
| **Admission policy hierarchy** | Platform hard bounds + configurable policy + Case context | **GENERIC EXTENSION / ARCHITECTURE** | User/case reminder policy, engagement policy and workflow owner scopes exist. | Approved target requires platform → organization → Case/context precedence. Current organization-owned workflow field is reserved/unused in reviewed migration; verify broader org-policy infrastructure before designing R1-local policy fields. |
| **Opportunity objective** | `case_facts` for durable objective claims; possibly a stable Case summary/projection for retrieval | **DOMAIN SEMANTIC** | Commercial fact primitive with provenance/supersession. | Decide canonical fact keys and whether one small denormalized projection is justified for supervision/query performance. Do not hide sole truth in prompt/transcript. |
| **Current requirements / profile constraints** | `case_facts` sourced from messages, advisor input, integration or derived interpretation | **REUSE + DOMAIN SEMANTIC** | `source_kind`, `source_ref`, `confidence`, supersession. | Spec must define when semantic interpretation is admissible and when explicit confirmation is required. |
| **One contact → multiple Opportunities** | Multiple Case instances referencing one operational contact identity | **DOMAIN SEMANTIC** | Multiple Case instances are supported. | Canonical contact/reference binding and duplicate detection need identity architecture; contact data should not be fully mirrored into each Case. |
| **Opportunity continuity vs new Opportunity** | Domain decision using objective continuity; result creates/retains Cases | **DOMAIN SEMANTIC + SPEC** | Shared Case roots/facts can represent either result. | Exact judgment criteria, audit trail and operator correction behavior. |
| **Opportunity merge / split / supersession** | Shared generic Case Relationship / Lineage contract; preserve facts/events/provenance | **GENERIC SHARED PRIMITIVE — ADR-109** | Full-repo audit confirmed no adequate first-class generic Case-to-Case primitive in current Gu OS; ADR-109 now establishes the cross-domain contract. | Exact persistence/API mechanics and initial typed relationship vocabulary remain Technical Design; do not create a Relationship-only merge table. |
| **Commercial viability** | `case_facts` / derived current projection, not generic Case `status` | **DOMAIN SEMANTIC** | Facts can hold current claims with provenance. | Spec vocabulary and evidence/decision rules. `status=active` must not be equated to commercial viability. |
| **Commercial temporary hold** | Business fact + `next_action_at` / Work `not_before` / engagement policy as appropriate | **REUSE + DOMAIN SEMANTIC** | Shared wake-up and deferred-work primitives exist. | Exact mapping depends on cause. Do **not** mechanically set runtime `paused` when the Case must wake automatically. |
| **Runtime Case status** | Existing `operational_cases.status` | **REUSE AS-IS** | Generic modes: `active`, waiting states, `paused`, `completed`, `failed`. | Relationship should not add `lost`, `qualified`, `visit_scheduled`, etc. to runtime status merely to model business lifecycle. |
| **Closure outcome** | `case_facts` / completion outcome projection + Case completion transition when durable responsibility truly ends | **DOMAIN SEMANTIC + SPEC** | Facts + completion contract exist. | Final vocabulary (`objective_achieved`, `lost`, `invalid`, `duplicate`, `superseded`, etc.) and the predicate for completing the Case. Business `lost` ≠ runtime `failed`. |
| **Progression milestones** | Evidence-backed `case_facts`, possibly derived projection; only use `current_step` when a true durable procedural milestone exists | **DOMAIN SEMANTIC + ARCHITECTURE FIT** | Facts and workflow states both exist. | Avoid rigid CRM funnel. Decide which, if any, Relationship milestones deserve `current_step`; `visit_requested` etc. need not automatically be steps. |
| **`current_step` in Relationship Ops** | Keep as shared durable procedural pointer if the workflow needs a meaningful current state | **REUSE WITH RESTRAINT** | Kernel explicitly defines it as a durable business/procedural milestone, not a Skill/substate. | Relationship may be less linear than Property Optioning. Do not force all simultaneous facts/events into one step pointer. |
| **`visit_requested`** | Current operational appointment creation → accepted `case_fact` / progression event with integration provenance | **REUSE + DOMAIN SEMANTIC** | `case_facts` supports integration evidence. | Legacy source audit confirms appointment creation is a strong positive signal but legacy persistence can partially succeed across stores. Exact Case Fact acceptance/reconciliation rules remain Technical Design/Spec work. |
| **`visit_scheduled` / rescheduled / cancelled / attended / no-show** | Evidence candidates from appointment source/messages/advisor/prospect → accepted Case facts; unresolved outcome → reconciliation work | **DOMAIN SEMANTIC + SPEC** | Facts + Work support accepted truth and reconciliation. | Legacy audit confirms appointment status and explicit post-visit attendance evidence are distinct, and missing attendance evidence remains unknown. Exact source-admissibility rules remain Spec/Technical Design. |
| **Business evidence provenance** | `case_facts.source_kind`, `source_ref`, `confidence`, supersession; approval snapshots for protected decisions | **REUSE** | Current Impact Plane directly represents commercial facts with provenance. | If R1 needs richer multi-evidence bundles/contradictions than one `source_ref`/confidence can express, prefer a generic provenance extension after architecture analysis. |
| **Evidence gap** | Unresolved/expected outcome represented in Case facts/context as needed + durable reconciliation `work_item` with `not_before`/`due_at`/verification contract | **REUSE FIRST; GENERIC EXTENSION ONLY IF NEEDED** | Work Plane gives durable work, timing, attempts, result and verification. | **Do not create `relationship_evidence_gaps` by default.** Determine whether an explicit generic “expected evidence/obligation” primitive adds cross-domain value beyond facts + Work. |
| **Conflicting evidence** | Preserve both source claims/provenance; create reconciliation work; accepted current fact supersedes prior claim only under domain rule | **REUSE + DOMAIN SEMANTIC** | `case_facts` preserves historical claims and supersession. | Need Spec/Architecture rule for contradiction handling; never generic last-write-wins. |
| **Follow-up / re-engagement / matching work** | `work_items` invoking bounded Skills/capabilities; Case/root Skill chooses work situationally | **REUSE** | Work Plane, capabilities, attempts, verification and current lead Skills exist. | Avoid pre-generating an inflexible queue of future messages. Timer/work eligibility wakes reconsideration; model/policy decides useful next work. |
| **`next_action_at` / Case wake-up** | Existing Case scheduling + event wake-up | **REUSE** | `next_action_at`, deterministic due scanner, external wake-up pattern. | Exact event ingestion from Traditional Gu is A2. Waking does not imply a predetermined send. |
| **Cooldowns / delivery windows / frequency policy** | Shared engagement-policy resolver / overrides + work scheduling eligibility | **REUSE CONCEPT; VERIFY IMPLEMENTATION SCOPE** | DB seam explicitly includes cooldowns, escalation and delivery windows. | Audit resolver and transport integration. If current implementation is advisor-notification-only or lacks WhatsApp audience semantics, extend the shared policy layer rather than create lead-specific cooldown fields. |
| **Advisor notification** | Existing `notify()` / notification preferences + domain trigger/urgency | **REUSE** | Channel priority and internal-user notification preferences exist. | WhatsApp advisor channel in Traditional Gu may remain legacy capability during migration; do not confuse advisor notification channel with prospect interaction channel. |
| **Human approval** | `case_approvals` + workflow approval/guard contracts | **REUSE + DOMAIN SEMANTIC** | Evidence-pinned approvals and deterministic transition contracts. | P0-7/Spec decides which actions truly require approval. Do not turn all relationship ambiguity into HITL. |
| **Human takeover / speaking suppression** | Conversation-authority state + channel routing/suppression; Case continues observing | **ARCHITECTURE DECISION (A6)** | Conversation binding exists; Traditional Gu same-thread takeover/resume behavior is now source-verified. | Preserve proven behavior conceptually. Exact Gu OS authority state/policy/routing implementation remains Technical Design. |
| **Runtime decision authority (`LEGACY` vs `GU_OS`)** | Explicit authority-resolution contract external to channel-specific agent logic | **ARCHITECTURE DECISION (A6)** | No verified generic primitive in reviewed Gu OS migrations. | Exactly one authoritative decision-maker per interaction. Case existence alone must not route/cut over. Prefer bounded resolver over legacy direct DB inference. |
| **Conversation ↔ Case correlation** | `operational_case_conversation_bindings` pattern | **GENERIC EXTENSION CANDIDATE** | Durable binding exists for web/Telegram. | Current DB CHECK does not include WhatsApp. Extend generically using the source-verified legacy identifiers; do not create Relationship-only conversation correlation. |
| **Off-platform advisor action capture** | Ingest normalized interaction/evidence when observable; otherwise evidence-gap reconciliation Work | **ARCHITECTURE + INTEGRATION** | Case facts/Work can consume normalized evidence. | Separate WhatsApp/phone capture remains partially unobservable; future transcript/capture should feed shared evidence semantics. |
| **Property matching / current inventory reads** | Bounded inventory/domain capabilities → source-aware operational adapters | **REUSE PATTERN; INTEGRATION WORK** | Gu OS Skills/tools architecture supports bounded capabilities. | Do not persist a full property mirror in the Lead Opportunity. Re-read current property facts before consequential actions. |
| **Appointment operational writes** | Bounded appointment capability with idempotency/evidence → legacy operational source; Case records accepted outcome | **ARCHITECTURE + INTEGRATION** | Shared Work/idempotency/evidence contracts are available. | Legacy audit confirms partial Firestore/Mongo persistence is possible. Exact adapter/read precedence/reconciliation and field authority remain Technical Design. |
| **Cross-system write reconciliation** | Work Item attempts + idempotency + accepted Case facts; architecture defines outbox/retry/reconciliation | **ARCHITECTURE DECISION (A4)** | Shared Work Plane already has idempotency/attempt/recovery seams. | No distributed-ACID assumption. Case truth and operational synchronization outcome must remain distinguishable. |
| **Lead/contact Source of Record** | Existing operational lead source; Case stores reference + necessary durable facts | **P0-8 DOMAIN OWNERSHIP** | Shared Case can reference external context. | Identity mapping A3; no wholesale Gu OS lead mirror. |
| **Message Source of Record** | Messaging/channel source; Case stores references/derived facts | **P0-8 DOMAIN OWNERSHIP** | Facts support source refs. | Message transport/persistence contract remains source-specific during migration; source roles are documented in `legacy-source-audit.md`. |
| **Property Source of Record** | Source-aware operational inventory / upstream CRM where authoritative | **P0-8 DOMAIN OWNERSHIP** | Case can consume capabilities and preserve provenance. | No Relationship-owned property truth store. Firestore-vs-serving-layer legacy roles are source-verified. |
| **Visit progression Source of Truth** | Gu OS accepted, evidence-backed Opportunity fact; operational appointment remains its own object/SOR | **P0-8 DOMAIN OWNERSHIP** | Case facts can hold accepted progression truth. | Selective write-back if operational appointment must know the reconciled fact. |
| **Transaction handoff** | Link Lead Opportunity Case to Transaction Case; shift primary responsibility, keep lineage | **ARCHITECTURE DECISION + SPEC** | Generic Case roots exist; ADR-109 establishes the generic Case relationship contract. | Exact Transaction boundary and primary-responsibility semantics remain Transaction/Relationship Spec + Technical Design work. |
| **Transaction failure → Relationship resume** | Linked Case relationship + event/fact/wake-up | **ARCHITECTURE + DOMAIN SEMANTIC** | Shared Case wake-up/facts available; ADR-109 covers the relationship seam. | Exact product handoff semantics remain downstream Spec work. |
| **Work Portfolio** | Human supervisory read model/projection over Cases, Work Items, facts, approvals, evidence gaps, outcomes and priority signals; primary `Needs Attention`, secondary `In Motion` and lightweight outcomes | **P1-9 APPROVED + REUSE PRINCIPLE** | Shared underlying data planes exist and can support cross-Case supervision without a new durable root. | Do not make Work Portfolio a second SOR/pipeline. Rank explainable human attention rather than merely lead attractiveness. Reserve `Supervisor` terminology for agentic/runtime roles such as Case Supervisor. |
| **Organization / brokerage identity** | Generic Gu OS organization identity mapped initially to the legacy principal-`super-admin`/`organization_id` representation | **P1-10 APPROVED + GENERIC EXTENSION / A3** | Legacy business semantics and mixed `organization_id` representation are source-verified. | Do not canonize the principal user id as the permanent organization id. Introduce/map a first-class organization abstraction sufficient for R1 and preserve legacy provenance. |
| **Organization membership / advisor role** | Membership relation between organization and authenticated human identity; legacy roles `super-admin`, `admin`, `vendedor` are migration inputs | **P1-10 APPROVED + GENERIC EXTENSION / A3** | Traditional Gu multi-advisor model and legacy Firebase identity/role bridge are source-verified. | Role names are migration semantics, not the permanent Gu OS authorization model. |
| **Assigned advisor / DRI** | Opportunity-level business assignment distinct from Case tenant ownership and actor/approver identity | **P1-10 APPROVED + DOMAIN SEMANTIC / A3** | `operational_cases.assigned_to_user_id` shows an existing assignment seam; legacy sticky assignment behavior is source-verified. | Do not infer that `case.user_id` or legacy principal is the advisor, approver or human contact. Exact Gu OS↔legacy advisor mapping remains Technical Design. |
| **Advisor human contact endpoint** | Per-advisor WhatsApp/contact identity for notifications, input and takeover, separate from Gu's prospect-facing business-number identity | **P1-10 APPROVED + A3/A6 INTEGRATION** | Traditional Gu same-thread owner/advisor intervention and Gu business-number routing are source-verified. | Exact Gu OS routing/linkage remains Technical Design. Do not collapse advisor phone, Gu business number, authenticated user and conversation authority into one identifier. |
| **Cost-to-Serve / material resource usage** | Existing `ai_usage_events` for AI + generic future resource-usage/cost primitive for messaging, voice, document processing, geocoding/search, specialized providers and other paid resources | **REUSE AI SEAM + GENERIC EXTENSION CANDIDATE (A9)** | AI ledger already captures reported/estimated cost, pricing version, retries and Case/Work correlation seams. | Ensure every R1 execution path propagates correlation. Do not create Relationship-only cost tables. Non-AI resource taxonomy/unit/cost semantics need generic architecture. |
| **Direct cost attribution** | Resource event correlated directly to Case / Work Item / Attempt / Work Run when causal ownership is known | **REUSE/EXTEND CORRELATION** | Current AI ledger can directly correlate to Case/Work objects. | Account/organization aggregation and all execution paths must be verified. Knowledge that a Case benefited is not enough unless correlation is causally defensible. |
| **Shared/batch cost allocation** | Preserve original shared resource event + explicit allocation records/policy using a documented cost driver | **ARCHITECTURE DECISION (A9)** | Durable Task / Work Run provides a natural root for some batch work; AI ledger does not currently model many-to-many cost allocations. | Prefer direct attribution first; otherwise use Activity-Based Costing driver such as opportunities processed, attributable tokens/context, messages, properties, pages, minutes or API calls. If no defensible driver exists, retain shared/account/platform cost rather than invent per-Case precision. |
| **Ungga-admin economic observability** | Authorized internal read surface / rollups over shared resource usage, costs and allocations with drill-down from global/resource → account → durable root/Case → Work Item/Attempt → activity/outcome → underlying ledger records | **CROSS-CUTTING FEATURE REQUIREMENT + A9** | Current `ai_usage_events` explicitly uses service-role/admin access and references `profiles.is_ungga_admin` for internal rollups. | Preserve reconciliability: total recorded resource cost = direct + allocated shared + explicit unallocated/shared/overhead. Exact UI/query/read-model design is downstream; do not create a second cost SOR merely for dashboards. |
| **Customer pricing / credits / wallet** | Separate future Pricing/Credits/Billing contract consuming business outcome + economic telemetry; interoperate with Traditional Gu credit ledger | **OUT OF R1 BILLING SCOPE / SEPARATE INITIATIVE** | Current `ai_usage_events` explicitly excludes billing. | Do not derive customer credit charge 1:1 from internal cost. Preserve separate provider-price version and future customer credit-policy version. |
| **Analytics / Visit Rate / outcomes** | Emit selected Case/Work/outcome facts to BigQuery analytical plane | **R2 / A5** | BigQuery read-only analytical Skills exist; operational Case data is separate. | No operational decision should depend on ~8h warehouse freshness. Define outbound analytical feed later. |

## 5. P0 decisions viewed through the shared-kernel lens

### P0-1 Admission

**Product semantic:** Relationship decides whether durable commercial responsibility exists.  
**Kernel fit:** Case creation is generic.  
**Do not build:** a legacy-only admission state machine or a second “lead opportunity engine.”  
**Open:** organization-policy representation/precedence and identity/dedup contract.

### P0-2 Progression / Transaction boundary

**Product semantic:** visit is milestone; concrete transaction is domain boundary.  
**Kernel fit:** accepted progression can live as provenance-bearing Case facts while Work drives execution.  
**Do not build:** a forced linear `current_step` funnel merely to make Relationship look like Property Optioning.  
**Open:** which durable procedural states, if any, deserve `current_step`; generic Case linkage to Transaction.

### P0-3 Authority

**Product semantic:** action authority, runtime authority and conversation authority are distinct.  
**Kernel fit:** approvals cover consequential human decisions; conversation bindings cover some durable correlation.  
**Do not build:** `lead_opportunity.gu_os_owns_whatsapp` as the hidden source of a permanent split-brain migration.  
**Open:** A6 authority resolver, WhatsApp routing, suppression/fallback and human takeover state.

### P0-4 Cardinality

**Product semantic:** one contact may have multiple independently progressing objectives; default continuity.  
**Kernel fit:** multiple Case roots are natural.  
**Do not build:** a Case per property or per criteria change.  
**Open:** generic lineage/merge/split relationship contract.

### P0-5 Viability / Closure

**Product semantic:** commercial viability, progression, runtime, delivery policy and closure outcome are distinct.  
**Kernel fit:** generic runtime status remains untouched; commercial facts/outcomes sit above it.  
**Do not build:** Relationship-specific runtime statuses such as `lost`, `qualified`, `visit_scheduled`.  
**Open:** exact outcome vocabulary and completion predicate.

### P0-6 Visit evidence

**Product semantic:** positive evidence establishes milestones; missing evidence remains unknown and creates reconciliation work when material.  
**Kernel fit:** `case_facts` + Work Items are strong primitives; release-oriented `evidence_records` is not the same thing.  
**Do not build:** a clean Relationship visit-state table that blindly mirrors unreliable legacy statuses.  
**Open:** exact source-admissibility matrix and Case Fact acceptance/reconciliation rules; legacy appointment/visit evidence semantics are now source-verified in `legacy-source-audit.md`.

### P0-7 Human gates

**Product semantic:** involvement proportional to consequence/authority/ambiguity/recoverability.  
**Kernel fit:** `case_approvals`, workflow guards and shared notification mechanisms.  
**Do not build:** manual approval for every uncertain conversational decision.  
**Open:** exact positive gate rules/action taxonomy and A6 Gu OS takeover mechanics.

### P0-8 Source of Record / write-back

**Product semantic:** fact-level ownership + selective write-back.  
**Kernel fit:** Case facts preserve durable interpreted truth; Work/attempts can execute/reconcile writes.  
**Do not build:** bidirectional full-database mirroring between legacy and Gu OS.  
**Open:** A1/A3/A4 exact adapter contracts, field-level authority matrix and idempotent write path.

### Cross-cutting — Cost-to-Serve / Resource Usage

**Product/platform requirement:** R1 must preserve full variable-resource economic observability, not only LLM cost.  
**Kernel fit:** `ai_usage_events` already provides a strong append-only AI cost ledger and Case/Work correlation seams; Work Items/Attempts and Durable Task/Work Run roots provide natural attribution anchors.  
**Do not build:** `relationship_case_costs`, lead-specific WhatsApp cost ledgers, or a credit/billing implementation hidden inside Relationship Operations.  
**Open:** A9 generic non-AI usage taxonomy/metering, direct/shared allocation contract, cost-driver/version provenance, account/organization aggregation and boundary with the future legacy-integrated credits/billing initiative.

## 6. Anti-mini-app constraints for R1

The following should be treated as architecture smells unless a cross-domain analysis explicitly justifies them:

1. A new `relationship_cases` runtime table duplicating `operational_cases`.
2. A Relationship-only cron/scheduler despite `next_action_at`, Work `not_before` and the Case runner.
3. A Relationship-only retry/claim system despite Work Items / attempts.
4. A Relationship-specific approval table despite `case_approvals`.
5. A `relationship_evidence_records` table merely because visit evidence exists; first test `case_facts` + Work/provenance.
6. A Lead Opportunity status enum that mixes runtime (`waiting_external`) with business outcomes (`lost`) and progression (`visit_scheduled`).
7. A forced linear `current_step` funnel for a relationship that can branch, regress and have multiple simultaneous obligations.
8. A generic Mongo/Firestore CRUD Tool exposed to the model instead of bounded domain capabilities.
9. A full Lead/Property/Appointment mirror in Supabase just to make Relationship Operations “self-contained.”
10. A permanent architecture where Traditional Gu owns inbound/reactive reasoning and Gu OS owns proactive reasoning for the same admitted Opportunity.
11. A Work Portfolio database that becomes a second pipeline/SOR rather than a projection over the operating kernel.
12. Hard-coded lead-only cooldowns/notification windows without first extending/reusing the shared engagement-policy contract.
13. Relationship-specific resource/cost tables that bypass a shared economic-telemetry ledger/correlation contract.
14. Treating internal provider/resource cost as the customer credit charge or mutating historical cost when customer pricing changes.
15. Arbitrarily spreading shared batch cost across Cases without preserving the allocation method and causal cost driver.
16. Building an admin economics dashboard backed by its own mutable cost totals instead of reconciliable projections over auditable usage/cost/allocation records.

## 7. Architecture decision queue produced by this mapping

> **Discovery-time queue:** this section preserves the architecture questions produced by the mapping. Architecture Analysis v0.12 subsequently resolved AC-1 through AC-10 at architecture-direction level, the Generic Case↔Case audit resolved ADR-109, and `legacy-source-audit.md` resolved the minimum Traditional Gu source-contract questions required for Technical-Plan entry. Use §10 for the current unresolved boundary. The queue remains useful as provenance for why each cross-cutting decision/audit exists.

The mapping strengthens the existing A1–A6 queue and adds three cross-kernel questions.

### A1 — Real-time operational data access boundary

Legacy service/API vs new gateway vs encapsulated direct adapters; freshness, tenant isolation, reuse and migration path.

### A2 — Event ingestion / wake-up strategy

How inbound messages, appointment changes, property changes and human actions wake the right Case without an always-on LLM scan.

### A3 — Identity mapping

Organization/tenant, legacy principal `super-admin`, membership (`admin` / `vendedor`), authenticated Gu OS user, assigned advisor/DRI, prospect/contact, advisor human WhatsApp endpoint, Gu business-number/channel identity, conversation, lead id, property/source id and appointment/deal identifiers. Preserve explicit legacy↔Gu OS mappings rather than equating these identities.

### A4 — Cross-system write consistency

Idempotency, attempts, evidence, partial failures, reconciliation and write ownership across Gu OS + legacy operational systems.

### A5 — Analytics feed evolution

How Gu OS outcomes feed BigQuery later without making BigQuery an operational dependency.

### A6 — Interaction authority / migration

One authoritative runtime per prospect interaction; Gu vs human speaking authority; shadow/live routing; legacy suppression; fallback; and routing human input/takeover to the correct organization member/advisor without conflating the advisor's own WhatsApp endpoint with the Gu business-number identity.

### A7 — Shared-kernel fit / generic extension contract

Resolve any R1 need that the current Case/Work/Impact/policy/conversation primitives do not cleanly cover. Extensions must be generic when the need is cross-domain.

Priority subquestions:

- Are `case_facts` + Work Items sufficient to represent material evidence gaps, or is a generic expected-evidence/obligation primitive justified?
- Does the current engagement-policy resolver safely support prospect-facing WhatsApp audiences/kinds, or only internal notifications/current channels?
- Does the current Case event vocabulary need a generic evolution before R1 emits richer domain events?
- How should less-linear Relationship progression coexist with `current_step` without abusing it?

### A8 — Case relationship / lineage and transaction handoff

ADR-109 establishes the generic relationship/lineage contract. Technical Design still defines exact persistence/API mechanics for:

- related Cases;
- parent/child or predecessor/successor where meaningful;
- merge/split/supersession lineage;
- Opportunity → Transaction linkage;
- primary-responsibility transfer and reactivation.

### A9 — Resource Usage, Cost Attribution & Economic Telemetry

Define a generic cross-domain contract for **cost-to-serve** that builds on `ai_usage_events` and covers material non-AI metered resources without becoming a customer billing system.

Architecture questions:

- resource taxonomy, units and provider-cost capture for AI, messaging, voice, document processing, geocoding/search, specialized providers and other paid APIs;
- propagation of Case / Work Item / Attempt / Durable Task / Work Run / user-account correlation;
- direct attribution semantics;
- many-to-many shared-cost allocation when one run serves multiple Cases/business objects;
- documented cost-driver selection and allocation policy/version (Activity-Based Costing), including when equal count is justified vs weighted usage;
- explicit shared/account/platform cost when no defensible per-object driver exists;
- provider reported vs estimated cost and provider-pricing version history;
- cost-to-date and final cost aggregation by business activity/outcome;
- an authorized Ungga-admin internal economics surface with drill-down from global/resource spend to account, durable root, Case, Work Item/Attempt, activity/outcome and auditable underlying ledger/allocation records;
- reconciliable rollups where total recorded resource/provider cost is fully explainable as direct attribution + allocated shared variable cost + explicit unallocated/shared/overhead cost;
- strict separation from future customer Pricing / Credits / Wallet/Billing and its Traditional Gu integration.

## 8. Feature / Business Spec implications

The mapping supports the existing candidate decomposition, with one important discipline: **Specs should define domain behavior against shared primitives without prescribing domain-local infrastructure.**

### Spec A — Lead Opportunity Responsibility & Lifecycle

Should define:

- admission behavior and dispositions;
- opportunity objective/cardinality/continuity;
- merge/split product semantics;
- business viability / hold / closure outcome;
- responsibility boundary and Transaction linkage behavior;
- durable facts required for the business contract.

It should **not** redefine generic Case runtime status or Work execution statuses.

### Spec B — Situational Progression, Next Work & Human Authority

Should define:

- what causes reconsideration;
- how Gu chooses useful next work rather than timer-driven sends;
- action authority / act+inform / approval / takeover semantics;
- evidence-gap reconciliation behavior;
- delivery-policy behavior from the user's/business perspective;
- freshness requirements.

It should **not** prescribe a Relationship-only scheduler, retry engine or approval store.

### Spec C — Visit Progression & Outcome Evidence

Should define:

- visit milestone/event semantics;
- admissible source/evidence hierarchy;
- unknown/conflict/reconciliation behavior;
- source-verified current positive evidence and known blind spots;
- how visit outcomes update the Opportunity and later analytics.

It should **not** assume every legacy appointment field is authoritative; use the source roles and partial-persistence behavior documented in `legacy-source-audit.md`.

### Spec D — Portfolio Supervision & Operator Control

Should define the minimum operator experience, prioritization/reasons, pending human actions and intervention/correction controls.

It should **not** create a second operational pipeline or SOR.

### Cross-cutting requirement — Economic telemetry / Cost-to-Serve

All R1 Specs that authorize material work should expose enough business/work semantics for economic telemetry to group cost by meaningful activity (for example qualification/conversation, matching, follow-up, visit coordination, reconciliation) and business outcome. They should require propagation of shared metering correlation but should **not** prescribe Relationship-only metering tables or customer credit pricing. A9 owns the generic architecture seam.

## 9. P1 interaction with the mapping

### P1-9 — Minimum Work Portfolio — DIRECTION APPROVED

The minimum R1 human-supervision experience is an **exception-first Work Portfolio**, not a CRM pipeline. `Needs Attention` is primary and should rank explainable human attention based on consequence, authority, urgency, blockage and relationship risk; `In Motion` makes Gu's autonomous work visible; a lightweight `Outcomes` view shows evidence-backed commercial progression; and concise Case drill-down exposes objective, current facts, progression, next work, evidence and human decisions. The same supervisory model should be queryable conversationally through Gu.

`Work Portfolio` is explicitly a **human-facing read/projection surface** over the existing Case + Work + Fact + Approval + evidence-gap/outcome information. `Supervisor` terminology is reserved for agentic/runtime roles such as the planned **Case Supervisor**. This is a strong reason **not** to duplicate state or create a second pipeline/SOR for the UI. Exact ranking bands/formula, projection/query implementation and visual design remain downstream Spec/Architecture work.

### P1-10 — Minimum organization / multi-seat slice — DIRECTION APPROVED

Traditional Gu already has **multi-advisor business semantics**: a principal `super-admin` user represents the brokerage in the legacy model, `admin` and `vendedor` users can be associated through `organization_id` / `org_name`, and leads/appointments/properties/deals/Gu-number records reference specific legacy users. The source audit further confirms that `organization_id` has mixed historical representation and is intertwined with principal-user context; it must therefore be treated as a **legacy organization key/bridge**, not as the permanent Gu OS organization identity.

R1 should pull forward the **minimum viable organization/multi-seat foundation** needed by Relationship Operations: organization identity, membership/authenticated advisor identity, Opportunity assignment/DRI, role-appropriate visibility, human routing/contact identity and enough authority semantics for protected decisions. The R1 target must support multiple authenticated advisors as a first-class near-term requirement even if the first operational slice begins with one seat.

The architecture must keep these dimensions distinct: tenant/account ownership, organization, membership, assigned advisor/DRI, actor, approver/decision authority, advisor WhatsApp endpoint and Gu business-number/channel identity. Current user-centric RLS/ownership and reserved organization workflow scope mean this is a **generic platform extension**, not a Relationship-only workaround. A3 and A6 now form a tightly coupled identity/routing cluster for this slice.

Later R3 should be reframed as **organization/team maturity and expansion**, not the first introduction of organization/multi-seat.

### P1-11 — Shared Inventory — DIRECTION APPROVED

Shared Inventory is an **authorized extension of the candidate inventory universe**, not a second Relationship runtime or pipeline. A materially new or materially changed authorized match can act as a business event/signal that wakes the Lead Opportunity and causes situational re-evaluation.

Kernel/architecture implications:

- use the same Lead Opportunity Case and shared Work/Fact primitives regardless of whether a candidate property originates in the brokerage's own inventory or permitted Shared Inventory;
- preserve property/inventory provenance and eligibility through bounded inventory/network capabilities rather than creating a Relationship-owned inventory mirror;
- model the match/event as an **input to reasoning**, not a progression milestone and not a predetermined outbound action;
- re-read prior property reactions, current requirements, freshness/availability and delivery/authority constraints before work is selected;
- retain Network/Inventory authority for representation, collaboration permissions, cross-brokerage routing, attribution and commission/economic rights;
- do not infer authority to disclose prospect identity/data to another brokerage merely because an authorized match exists;
- a materially changed property (for example price/availability) may become newly actionable even if previously rejected, provided the Opportunity context supports reconsideration.

**Guardrail:** a new match wakes/reconsiders; it does not mechanically send.

### P1-12 — Production-representative pilot environment — DIRECTION APPROVED

R1 should be validated in a **production-representative but operationally bounded** brokerage environment with real continuous lead flow, multiple advisors, current inventory access, observable visit progression and enough willingness to delegate bounded work to exercise the actual Relationship Operations contract.

The pilot should progress authority through **shadow observation → assisted execution → selective live autonomy → broader situational responsibility** as evidence supports it. Verification must cover both:

- **operating-contract evidence:** admission, event/scheduled wake-up, situational next-work selection, delivery/authority compliance, advisor routing, retries/recovery and evidence reconciliation across multi-day Opportunities; and
- **business/economic evidence:** evidence-backed progression toward visits/transactions plus end-to-end Cost-to-Serve attribution.

Exact numeric volume thresholds belong in the Pilot / Verification Plan, not this mapping. Prefer repeated, information-rich journeys over a nominal lead-count target. **Select for learning density, not merely size or convenience.**

Architecture implication: the pilot environment must expose enough real organizational identity/routing, WhatsApp/legacy interaction, inventory/matching and visit-evidence behavior to test the A1/A2/A3/A4/A6/A9 seams without requiring the full later organization/team or Network-domain maturity.

## 10. Current conclusions

### 10.1 Strong fit with the existing Gu OS direction

R1 does **not** appear to require a second durable engine. The current repo already contains the core abstractions needed to represent the initiative coherently:

```text
Commercial responsibility    → Operational Case
Versioned behavior contract  → Workflow Definition + Case pin
Durable executable work      → Work Item + Attempt
Commercial truth/provenance  → Case Fact
Consequential human decision → Case Approval
Generated dependent output   → Case Artifact
Independent non-Case work    → Durable Task / Work Run
Wake-up / waiting             → Case scheduling + events
Delivery constraints         → Shared reminder/engagement policy seams
AI usage / model cost        → ai_usage_events
Economic attribution anchors → Case / Work / Attempt / Work Run correlation
```

This is exactly the architecture we wanted to preserve: **shared operating primitives, domain-specific semantics.**

### 10.2 Cross-cutting seams after Architecture Analysis v0.12

Architecture Analysis v0.12 records AC-1 through AC-10 as accepted, the Generic Case↔Case audit as complete, ADR-109 / ADR-110 as accepted, and the minimum Traditional Gu production-source audit as complete for Technical-Plan entry. The remaining uncertainty is therefore no longer whether R1 should create Relationship-specific infrastructure or whether the basic legacy contracts exist; it should not, and the relevant brownfield contracts are now documented. Remaining work is to translate accepted cross-domain directions and source-verified contracts into exact Specs / Technical Design.

Important remaining seams include:

- exact real-time legacy operational gateway and normalized event-ingestion implementation over source-verified contracts;
- exact identity-bridge implementation and organization/membership/RLS mechanics under ADR-106;
- exact cross-system write/idempotency/reconciliation mechanics for the accepted fact-level SOR direction;
- exact Gu OS runtime/conversation-authority state/resolver and WhatsApp wrapper under ADR-107, using the source-verified takeover/resume/provider-ID behavior;
- exact external-conversation binding extension and engagement-policy behavior for prospect-facing delivery;
- exact Generic Case Relationship / Lineage persistence, typed vocabulary, authorization and mutation mechanics under ADR-109;
- exact organization-policy storage/resolution mechanics under ADR-108;
- exact appointment read precedence/reconciliation and visit Fact source-admissibility rules;
- exact generic resource-usage ledger / valuation / allocation migration under ADR-110 Resource Usage & Cost Attribution;
- future interoperability with customer Pricing / Credits / Billing while preserving the accepted cost-vs-price separation.

These remain cross-cutting platform seams or Technical Design work—not reasons to build a Relationship-specific mini-runtime.

### 10.3 Recommended next gate

With the Brief, S1, Architecture Analysis and minimum legacy source audit now approved/aligned, the current sequence is:

```text
Initiative Brief v0.9
+ S1 Lead Opportunity Lifecycle v0.3
+ this mapping v0.9
+ Architecture Analysis v0.12
+ Traditional Gu Legacy Source Audit v0.1
+ ADR-106 / ADR-107 / ADR-108
+ ADR-109 Generic Case Relationships / Lineage
+ ADR-110 Resource Usage & Cost Attribution
          ↓
remaining Feature / Business Specs (S2 / S3 / S4 as needed)
          ↓
repo-specific Technical Plans / Technical Design
          ↓
Tasks / Slices / Verification / Pilot evidence
```

ADR-106, ADR-107, ADR-108, ADR-109 and ADR-110 are accepted cross-cutting decisions. The mapping itself remains **not an ADR** and does not authorize implementation by itself.

## Appendix — v0.5 update note

v0.5 records the approved P1-11 Shared Inventory direction:

- Shared Inventory is consumed through the same Relationship Opportunity model as own inventory;
- materially new/changed authorized matches can wake/re-evaluate a Case;
- match discovery is not itself progression and does not automatically authorize messaging or cross-brokerage data sharing;
- Relationship decides whether/how a match advances the relationship, while Network/Inventory retains eligibility, provenance, representation, routing, attribution and commission/economic authority;
- prior exposure/reaction and material property changes are part of re-evaluation semantics;
- no Relationship-specific inventory mirror or shared-inventory workflow engine should be introduced.


## Appendix 0 — v0.4 update note

v0.4 records the approved P1-10 minimum organization/multi-seat direction:

- Traditional Gu's confirmed multi-advisor model (`super-admin`, `admin`, `vendedor`, `organization_id`, `org_name`) becomes an explicit migration input;
- `user-admin` is corrected to `super-admin`;
- legacy `organization_id` is treated as a principal-user-based legacy organization key, not the future Gu OS organization identity;
- R1 now requires a minimum generic organization/membership/assignment/visibility/routing foundation and multiple authenticated advisors are a first-class near-term target;
- advisor human WhatsApp endpoints are explicitly separated from the Gu business-number/channel identity;
- A3 Identity Mapping and A6 Interaction Authority are strengthened as a coupled architecture cluster;
- later R3 is reframed as organization/team maturity and expansion.

## Appendix A — v0.3 update note

v0.3 incorporates the approved P1-9 terminology/product direction and strengthens A9 economic observability:

- **Work Portfolio** replaces **Portfolio Supervisor** for the human-facing supervisory surface, while `Supervisor` is reserved for agentic/runtime roles such as Case Supervisor;
- P1-9 is direction-approved as an exception-first projection over the shared operating kernel with `Needs Attention`, `In Motion`, lightweight outcomes, concise Case drill-down and conversational access through Gu;
- the Work Portfolio ranking target is explainable **human attention priority**, distinct from lead/opportunity attractiveness;
- A9 now includes an authorized **Ungga-admin economics surface** with reconciliable drill-down from global/resource spend through account/Case/Work/activity/outcome to auditable ledger/allocation records;
- reconciliation must expose direct, allocated-shared and explicit unallocated/shared/overhead cost so rollups tie back to recorded resource/provider cost.

## Appendix B — Repo evidence reviewed for v0.3

### Durable Case / authoring

- `docs/operational-cases/architecture.md`
- `docs/operational-cases/authoring-playbook.md`
- `packages/db/supabase/migrations/00019_operational_cases.sql`
- `packages/db/supabase/migrations/00025_operational_case_flow.sql`
- `packages/db/supabase/migrations/00065_workflow_definitions.sql`
- `packages/db/supabase/migrations/00066_operational_cases_definition_pin.sql`

### Policy / conversation

- `packages/db/supabase/migrations/00021_user_notification_preferences.sql`
- `packages/db/supabase/migrations/00029_operational_case_activation_policy.sql`
- `packages/db/supabase/migrations/00036_notification_engagement_policy_overrides.sql`
- `packages/db/supabase/migrations/00044_operational_case_conversation_bindings.sql`

### Economic telemetry

- `packages/db/supabase/migrations/00064_ai_usage_events.sql`

### Evidence / Work / Impact

- `packages/db/supabase/migrations/00068_evidence_records.sql`
- `packages/db/supabase/migrations/00069_work_plane.sql`
- `packages/db/supabase/migrations/00070_impact_plane.sql`

### Other durable root

- `packages/db/supabase/migrations/00074_durable_task_roots.sql`

### Important current-source caveats

- The minimum Traditional Gu production-source audit required for R1 Technical-Plan entry is now complete and recorded in `legacy-source-audit.md`.
- Legacy appointment persistence, post-visit evidence, Legacy Deal semantics, property source/search roles, assignment, `lead_id`, same-thread takeover/resumption and outbound provider correlation are source-verified at the audited production revisions. Exact Gu OS adapter/reconciliation mechanics remain Technical Design.
- The current Gu OS database migration proves that engagement-policy overrides can represent cooldowns/escalation/delivery windows; this mapping has **not** yet proved that the current Gu OS runtime resolver applies those semantics to prospect-facing WhatsApp delivery.
- The full-repo Generic Case↔Case audit confirmed that the current repo has no adequate first-class generic Case relationship/lineage primitive; ADR-109 therefore establishes the new shared cross-domain contract.
- `evidence_records` is currently verification/release evidence with constrained subject kinds; it should not be silently repurposed as business-event evidence without a deliberate architecture decision.
- `ai_usage_events` currently meters only `ai_model` resource usage and is explicitly internal observability, not billing. This mapping has **not** established a current generic ledger for WhatsApp/voice/external-provider costs or a many-to-many cost-allocation primitive.
- The current AI ledger has direct `user_id` and Case/Work correlation seams; organization/account-level aggregation and exact tenant semantics must be verified rather than assumed.


## Appendix D — v0.6 update note

v0.6 closes **P1-12 — Pilot environment** and aligns the mapping with Relationship Operations Brief v0.9. The P0/P1 Brief-level product framing is now closed; remaining open items are Spec, source-audit, Architecture Analysis/ADR, Technical Plan and verification decisions rather than additional P1 product framing.


## Appendix E — v0.7 alignment note

v0.7 is a documentation-maintenance alignment update after completion of R1 Architecture Analysis v0.10. It does not reopen or change the approved product/mapping semantics. Relative to v0.6 it:

- records that AC-1 through AC-10 are now accepted architecture direction;
- updates the next-gate sequence so Architecture Analysis is no longer shown as pending;
- distinguishes accepted architecture direction from the source audits and Technical Design mechanics that remain unresolved;
- records ADR-106, ADR-107 and ADR-108 as accepted and Resource Usage & Cost Attribution as accepted under provisional numbering;
- keeps ADR-109 conditional on the full-repo Generic Case Relationships audit.

## Appendix F — v0.8 alignment note

v0.8 is a documentation-maintenance alignment update after completion of the full-repo Generic Case↔Case audit and ADR packaging. It does not reopen or change the approved mapping/product semantics. Relative to v0.7 it:

- records that the audit found no adequate first-class generic Case↔Case relationship/lineage primitive;
- records ADR-109 as the accepted shared Generic Case Relationship / Lineage contract;
- finalizes Resource Usage & Cost Attribution as ADR-110;
- removes the now-resolved audit/numbering gate from the next-step sequence;
- leaves exact relationship persistence/API mechanics, economic-ledger mechanics and remaining legacy source audits to downstream Technical Design/source audit.

## Appendix G — v0.9 alignment note

v0.9 is a documentation-maintenance and source-status alignment update after completion of the minimum Traditional Gu production-source audit. It does not reopen or change approved mapping/product semantics. Relative to v0.8 it:

- links `legacy-source-audit.md` v0.1 as the canonical source-verified brownfield contract for R1;
- upgrades relevant identity, `lead_id`, assignment, human takeover/resumption, appointment/visit evidence, Legacy Deal, property and outbound-provider statements from audit-pending/domain-confirmed to source-verified;
- updates Architecture Analysis references to v0.12;
- removes the minimum legacy source audit from the Technical-Plan-entry gate;
- leaves exact adapter/schema/event/reconciliation mechanics to downstream Technical Design.
