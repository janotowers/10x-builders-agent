# Relationship Operations — Initiative Brief

> **Version:** v0.9  
> **Status:** Draft — P0 and P1-9 through P1-12 product directions approved; Feature / Business Spec and Architecture Analysis next  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/brief.md`  
> **Roadmap increment:** R1 — Relationship Operations v1  
> **Parent product intent:** [`../../PRD.md`](../../PRD.md)  
> **Roadmap:** [`../../../roadmap/gu-os-evolution-roadmap.md`](../../../roadmap/gu-os-evolution-roadmap.md) — R1  
> **Doctrine:** [`../../../principles/gu-os-principles-and-design-doctrine.md`](../../../principles/gu-os-principles-and-design-doctrine.md)  
> **Development method:** [`../../../development/agentic-product-software-development-methodology.md`](../../../development/agentic-product-software-development-methodology.md)  
> **Artifact role:** Initiative framing only. This Brief does not own exact feature behavior, durable architecture decisions or implementation design.

## 1. Decision this Brief asks for

Approve, refine or reject the framing of **Relationship Operations** as the next primary product initiative after the current Gu OS foundation closure, with **R1 — Relationship Operations v1** as the first roadmap increment inside that enduring domain.

The proposed responsibility is:

> **Keep a viable buyer/renter opportunity moving toward the best achievable outcome, with visit progression as the first measurable commercial milestone.**

Approval of this Brief does **not** approve a specific state machine, messaging-policy schema, database migration, autonomous-outreach implementation, source-of-record adapter, migration mechanism or UI. P0 product directions are now recorded as approved at the Initiative Brief level; exact behavioral contracts, shared-kernel mappings that require extension, Architecture Decisions and implementation mechanics belong in the Feature / Business Spec(s), Architecture Analysis / ADRs and Technical Plan.

### Why the directory is not versioned

The repo path intentionally uses:

`docs/product/initiatives/relationship-operations/`

rather than:

`docs/product/initiatives/relationship-operations-v1/`

because **Relationship Operations is the enduring product/domain responsibility**, while `v1`, `v2`, etc. describe evolving product increments and maturity. Git history plus document/version metadata should carry routine evolution. A versioned path would be more appropriate only if materially incompatible versions had to coexist as separate contracts for a meaningful period.

## 2. Why this initiative exists

The Product PRD identifies Gu's current wedge as moving a buyer or renter from initial inquiry toward a property visit. It states that Traditional Gu already engages prospects, understands requirements, profiles constraints, matches brokerage and permitted Shared Inventory, follows up and coordinates visits. It also states that current follow-up remains limited and partly pre-programmed, and that the next product leap is **situational operation**: understand opportunity state, detect events, decide when to act, choose appropriate work and involve the professional when needed.

The PRD also makes the durable-work distinction explicit: caring for an opportunity across days/weeks, systems, waits, humans, changed facts and evidence is different from a bounded conversation. Conversation may guide the work; Gu OS must hold the durable truth about the delegated responsibility.

The canonical Roadmap therefore selects R1 Relationship Operations v1 as the next primary product increment and defines graduation in terms of Gu keeping an opportunity alive across sessions/events, choosing and executing allowed next work, escalating appropriately and linking progression to visit evidence without requiring manual pipeline operation.

**Discovery conclusion:** the initiative is justified. The unresolved question is not whether Relationship Operations belongs in Gu OS; it is the exact behavioral contract for its first increment and the safe brownfield boundary with the currently operating Traditional Gu system.

## 3. Source-status discipline for this Brief

This initiative currently spans more than one system and repository. The Brief therefore distinguishes three evidence classes:

1. **Canonical Gu / Gu OS product intent** — PRD, Roadmap, Doctrine and Methodology in this repo.
2. **Repo-verified Gu OS behavior** — code/docs/Skills currently present in `10x-builders-agent`.
3. **Domain-confirmed Traditional Gu current behavior** — current production behavior and data topology confirmed by product/domain leadership but not yet source-audited in the legacy repo.

Implementation planning must not silently convert a domain-confirmed statement into a low-level technical fact if the legacy source has not yet been audited.

## 4. Verified and domain-confirmed current baseline

### 4.1 Canonical product baseline

Current product intent establishes:

- Relationship Operations is responsible for keeping relationships/opportunities alive and moving toward the best achievable outcome.
- The same Gu and the same Gu OS operating core should support this domain; Relationship Operations must not become a separate application/workflow engine.
- The migration from Traditional Gu should preserve proven lead engagement, intent/requirement understanding, property-search/matching knowledge, CRM/property integrations, visit-oriented behavior and WhatsApp-first prospect semantics while progressively moving durable responsibility into Gu OS.
- The target is situational responsibility, not more timer-driven follow-up activity.
- Relationship Operations and CRM/record systems are not the same responsibility: systems may continue to store business records while Gu assumes the responsibility of advancing the opportunity.

### 4.2 Domain-confirmed Traditional Gu operating context

Traditional Gu is a separate, already-operating system with a different architecture and repository. It currently serves prospects/leads and real-estate users primarily through WhatsApp.

Traditional Gu now also supports a **multi-advisor brokerage model** in its Firebase user representation. The current domain-confirmed semantics are:

- `users.document_id` is the canonical legacy user identifier used by lead, appointment, property, deal and Gu-number references; `uid` should not be treated as the primary business key.
- `role_user = super-admin` identifies the principal user that represents the brokerage in the current legacy model. The previously documented `user-admin` wording was a documentation error; the intended value is `super-admin`.
- `role_user = admin` represents a user granted account-administration authority by the principal user.
- `role_user = vendedor` represents an advisor/sales user to whom responsibility for selected leads can be delegated.
- `organization_id` and `org_name` associate subusers/advisors with the brokerage, but there is **no separate first-class Organization table in the current legacy model**. `organization_id` is effectively a reference to the principal/super-admin user and should therefore be treated as a **legacy organization key**, not as the permanent Gu OS organization model.
- each advisor has their own human WhatsApp number/contact endpoint, while the principal legacy account is directly associated with the Gu WhatsApp API/business-number identity. The exact production routing/linkage between advisor numbers, the principal account and the Gu business number remains a source-audit item.

This means R1 must distinguish **organization identity, Gu OS authenticated seat, principal/admin identity, assigned advisor/DRI, approver/authority and channel/contact identity** even when some of those roles resolve to the same person in an early pilot.

Current domain-confirmed data topology:

#### Firebase

1. **Real-estate users / Ungga account users**  
   BigQuery mirror: `firestore_users.users_light`

2. **Gu numbers / enabled-active users**  
   BigQuery mirror: `firestore_gu_numbers.gu_numbers_light`

3. **Properties / unified Ungga inventory representation**  
   BigQuery mirror: `firestore_properties.properties_light`

4. **Deals**  
   BigQuery mirror: `firestore_deals.deals_light`

5. **Messages / WhatsApp conversations**  
   BigQuery mirror: `firestore_messages.messages_light`

#### Mongo

6. **Leads**  
   BigQuery mirror: `mongo_data.leads_light`

7. **Appointments**  
   BigQuery mirror: `mongo_data.appointments_light`

The exact physical Mongo collection that contains leads may have a historically misleading name similar to `users`. That physical name must remain an integration detail. Gu OS product/domain semantics should call these records **leads/prospects**, not propagate the legacy physical name.

Traditional Gu also has an existing **human takeover** behavior in the same WhatsApp conversation: when the real-estate advisor intervenes, Gu stops taking the conversational lead but continues reading/observing the thread. After roughly ten minutes without a new advisor message, Traditional Gu resumes the ability to respond. The behavior is valuable and should be preserved conceptually; the exact timeout is a legacy implementation/default to validate rather than a universal Gu OS product invariant.

### 4.3 Property inventory is an Ungga operational hub, not merely a CRM cache

The Firebase properties store is a unified Ungga operational inventory representation.

Properties can arrive from:

- external real-estate CRMs / systems such as EasyBroker and other connected providers, through API or other import mechanisms;
- direct property capture in Ungga for real-estate professionals who do not use an external CRM or prefer native entry.

For CRM-originated properties, Traditional Gu/Ungga keeps the representation synchronized incrementally, approximately hourly, processing changed external records rather than treating each sync as a full rebuild.

Therefore the authority model is **source-aware**:

- for an externally sourced property, the upstream CRM may remain authoritative for some source fields/actions;
- for a property created natively in Ungga, the Ungga operational inventory may be the primary authority;
- Gu OS should consume a stable property/inventory capability and preserve provenance rather than hard-code assumptions that every property is owned by an external CRM.

The exact field-level authority, provenance and write-back model belongs in Architecture Analysis / Technical Plan, not this Brief.

### 4.4 Current BigQuery role in Gu OS

The current Gu OS repo uses BigQuery as a **read-only analytical/warehouse access layer**.

Relevant verified repo capabilities include:

| Current capability | Verified behavior | Relationship Ops implication |
|---|---|---|
| [`company-data`](../../../../skills/global/company-data/SKILL.md) | Answers quantitative business questions from the Ungga BigQuery warehouse across users, properties, leads, appointments, deals and messages. Read-only. | Keep for analytics/KPIs/historical questions. Do not treat it as the operational action plane for R1. |
| [`business-data-core`](../../../../skills/global/business-data-core/) | Provides reusable schemas, joins, conventions and few-shot analytical patterns for warehouse access. | Useful analytical contract; not the canonical interface for fresh operational decisions. |
| [`lead-follow-up-draft`](../../../../skills/global/lead-follow-up-draft/SKILL.md) | Drafts personalized follow-up from tenant-scoped warehouse context and explicitly does not send automatically. | Useful behavior/procedure can be reused or adapted, but its BigQuery dependency and draft-only authority are not automatically the target R1 runtime contract. |
| [`lead-momentum-watch`](../../../../skills/global/lead-momentum-watch/SKILL.md) | Heartbeat-native, read-only detection of leads losing momentum; recommends or drafts next steps. | Demonstrates proactive detection, but not durable opportunity ownership. |
| [`inventory-matchmaking-watch`](../../../../skills/global/inventory-matchmaking-watch/SKILL.md) | Read-only detection of actionable property-to-lead matches; recommends a human-reviewed next step. | Demonstrates inventory-triggered opportunity detection, but not Case-level continuity or action authority. |
| [`operational-cases/architecture.md`](../../../operational-cases/architecture.md) | Implemented durable Case runtime around `operational_case_types`, `operational_cases`, append-only `operational_case_events`, deterministic due-case scanning, `next_action_at`, `due_at`, generic runtime status, `current_step`, optimistic locking and `case_runner`. | R1 should reuse this operating kernel rather than build a lead-specific durable engine. |
| `workflow_definitions` + Case definition pinning | Versioned/published executable workflow definitions (`graph_jsonb`) with definition hashes, immutable published versions, guards/transition contracts and per-Case version pinning. | Relationship behavior that truly belongs to the durable workflow contract should be expressed through this shared definition/evaluator layer rather than a Relationship-only state machine. |
| `work_items` / `work_item_attempts` / dependencies / work events | Generic Work Plane attached to a Case, with bounded executable units, retries/attempts, `not_before`, `due_at`, idempotency and verification contracts. Case vocabulary and Work vocabulary are deliberately separate. | Reconciliation, follow-up preparation/execution and other durable units should reuse Work Items where the contract fits; R1 should not add a separate scheduler/retry engine. |
| `case_facts` / `case_artifacts` / `case_approvals` | Impact Plane with append-oriented commercial facts and provenance, generated artifacts pinned to inputs, and human approvals pinned to the evidence seen. | Prospect requirements, accepted business facts and consequential approvals have a shared primitive available; R1 should specialize fact keys and approval kinds rather than invent parallel stores by default. |
| Notification / engagement policy primitives | Case reminder defaults/overrides plus user-level engagement-policy overrides for cooldowns, escalation and delivery windows. | R1 delivery policy should compose with these shared policy mechanisms; exact applicability to prospect-facing WhatsApp must be verified rather than duplicated locally. |
| `operational_case_conversation_bindings` | Durable conversation-to-Case binding for late responses, interruptions and ambiguity; current database contract is limited to `web` / `telegram`. | The pattern is reusable, but WhatsApp/prospect-channel support and authority routing require generic architectural extension/verification. |
| `durable_tasks` / `work_runs` | Independent durable-work root for jobs that are not commercial Cases; Work Items attach to exactly one Case or Work Run. | A Lead Opportunity is a commercial Case, not a phantom Durable Task; unrelated batch/recurrent work should remain on the other durable root. |

Current domain-confirmed warehouse replication from Traditional Gu operational stores is approximately **every eight hours**. That is acceptable for many historical/aggregate questions, but it is not sufficiently fresh for prospect-facing operational decisions such as whether a lead just replied, whether an appointment was just changed, or whether a relationship-sensitive follow-up is still justified.

## 5. Data and system boundaries discovered

### 5.1 Working separation of responsibilities

The initiative currently points toward three distinct data/work planes:

#### A. Traditional Gu operational sources

Mongo, Firebase and the services around them currently hold fresh production facts such as leads, messages, appointments, properties, deals and account/user information.

They answer questions such as:

- What did this lead just say?
- What is the current appointment state?
- What property information is current now?
- What deal record currently exists?

#### B. Gu OS durable operating state

Supabase / Gu OS primitives own the new durable responsibility that Traditional Gu does not currently represent as a governed Case/Work contract.

Examples include:

- Lead Opportunity Case identity and lifecycle;
- delegated objective/responsibility;
- `next_action_at` or equivalent scheduled reconsideration;
- commitments;
- Work Items / attempts;
- human decisions/approvals;
- evidence and outcome assertions;
- Case events;
- pause/override/recovery state.

This is intentional persistence, not accidental duplication.

#### C. BigQuery analytical plane

BigQuery remains valuable for:

- KPIs;
- historical reporting;
- funnels;
- conversion analysis;
- cohorts;
- source/channel comparisons;
- advisor/team performance;
- downstream outcome analysis;
- experiment analysis;
- later closed-loop learning and Business Brain / platform-improvement evidence where appropriate.

BigQuery should answer **what happened and what patterns exist**, not be the authoritative answer for **what just happened and what Gu is allowed to do now**.

### 5.2 Why BigQuery should remain

Keeping BigQuery is recommended even if Gu OS gains direct/near-real-time operational access because the two systems serve different workloads.

Operational stores are optimized for current records and transactional/application behavior. BigQuery is better suited to large historical scans, cross-domain aggregation and analytical joins without loading the live production stores.

As Gu OS matures, the analytical plane can also receive selected Gu OS outcomes/evidence so the business can analyze not only legacy activity but the effect of delegated AI work itself.

Replication frequency may evolve independently from the operational path. Faster incremental/CDC ingestion may become useful for dashboards or near-real-time analytics, but Relationship Operations should not depend on a warehouse refresh to decide whether to act on a live prospect.

### 5.3 Working operational access direction

The preferred direction is:

```text
Gu OS / Relationship Operations
  -> business/domain capability
  -> legacy operational gateway / service / adapter
  -> Mongo / Firebase / relevant upstream service
```

If Traditional Gu already exposes suitable domain APIs/services, Gu OS should prefer those. If it does not, a Gu OS integration adapter may temporarily encapsulate direct Mongo/Firestore access.

The model/Skill should not be exposed to generic database primitives such as:

- `mongo_update(...)`
- `firestore_query(...)`
- generic CRUD over arbitrary collections

Instead, Gu OS should expose bounded semantic capabilities such as:

- `lead_get_context`
- `lead_get_recent_messages`
- `property_search_current_inventory`
- `property_get_details`
- `appointment_get`
- `appointment_create`
- `appointment_reschedule`
- `appointment_cancel`
- later, narrowly governed lead/outcome write capabilities where justified

This keeps database location, physical collection names and provider changes below the product/Skill layer.

### 5.4 Skill / Tool / Adapter implication

The expected composition is:

```text
Skill
  -> decides / guides what work should be done

Tool / business capability
  -> performs a bounded contract

Adapter / service
  -> knows whether the current implementation is Mongo, Firestore,
     a Traditional Gu API, an external CRM, or another provider
```

Therefore, if R1 moves away from BigQuery for live lead context, the desired change is **not** to create a "Mongo Skill" and "Firebase Skill." Existing lead Skills may instead be refactored or supplemented to call operational business tools whose adapters hide the physical data source.

### 5.5 Preliminary source-of-record map — discovery hypothesis

This matrix is **not yet an ADR**. It is the working model to validate against the legacy repository and current integrations.

| Business concept | Current likely operational authority | Gu OS target responsibility |
|---|---|---|
| Traditional Gu account/user | Firebase users | Reference/map to Gu OS organization/user identity; do not copy indiscriminately |
| Gu WhatsApp number / activation | Firebase Gu numbers | Integration/channel identity where needed |
| Lead/contact identity and current lead record | Mongo lead data | Legacy operational SOR initially; Gu OS references the lead |
| Prospect messages | Firebase messages / channel path | Channel/message SOR + events/signals into the Case |
| Property inventory | Ungga Firebase unified inventory, with source-aware upstream provenance | Operational property capability; Gu OS references current inventory and provenance |
| Appointment record | Mongo appointments | Legacy operational SOR initially + Gu OS Case evidence/outcome linkage |
| Deal record | Firebase deals | Legacy/transactional SOR initially; later boundary with Transaction Operations |
| Lead Opportunity responsibility | No equivalent durable owner today | **Gu OS authoritative** |
| Commitments / next-work responsibility | Largely implicit / legacy timers/tasks | **Gu OS authoritative** |
| Case/Work events, approvals and evidence | No equivalent durable owner today | **Gu OS authoritative** |
| Historical KPIs/funnels/analysis | BigQuery mirrors | **BigQuery analytical authority** |
| Gu OS outcome/AI-work analytics | Limited today | Later BigQuery analytical projection fed by Gu OS evidence/outcomes |

### 5.6 Terminology guard: `owner`

Legacy fields may use `owner`, `owner_firebase_id`, `user_owner`, or similar names to mean the **Ungga account user / real-estate professional associated with the record**, not the owner of a property.

Gu OS product/domain language should prefer explicit terms such as:

- organization;
- account user;
- advisor / broker;
- assigned advisor;
- property owner / listing contact

and isolate ambiguous legacy names inside integration mappings.

### 5.7 Durable responsibility, runtime authority and conversation authority are distinct

R1 now needs three explicit but related concepts:

1. **Durable responsibility** — whether a Lead Opportunity Case exists because Gu has accepted responsibility that must persist beyond the current interaction.
2. **Runtime decision authority** — which agent/runtime currently decides what the next prospect-facing action should be during migration: Traditional Gu or Gu OS.
3. **Conversation authority** — who should speak to the prospect right now: Gu or a human advisor.

These concepts must not be collapsed into a single flag.

Examples:

```text
Case exists = YES
runtime authority = GU_OS
conversation authority = HUMAN
```

means Gu OS still owns the durable opportunity, but the advisor is actively handling the conversation; Gu observes and should not interrupt.

```text
Case exists = YES
runtime authority = LEGACY
conversation authority = GU
```

can represent a shadow/premigration state in which Gu OS has a Case for observation/evaluation while Traditional Gu still decides prospect responses.

A foundational migration rule is:

> **For a given prospect interaction, there must be one authoritative decision-maker at a time.**

A prospect should experience one Gu. Traditional Gu and Gu OS must not independently compete to decide or send the next response for the same interaction.

### 5.8 Case admission does not automatically transfer runtime authority

Creating a Lead Opportunity Case and transferring live conversational decision authority are separate actions.

The expected migration progression is:

```text
lead interaction
  -> Gu OS admission evaluation
  -> Case may be created
  -> runtime authority may remain LEGACY for shadowing
  -> selected pilot opportunity may later transfer to GU_OS
```

This allows Gu OS to validate durable reasoning before it becomes prospect-facing.

For an admitted opportunity whose runtime authority has transferred to Gu OS, any later inbound prospect message — whether it is a reply to Gu, a spontaneous message after inactivity, or a response months later — should wake/routinely reach the owning Lead Opportunity for decision. Traditional Gu may still receive, persist and transport the WhatsApp message, but should not independently invoke its legacy agent for that interaction.

### 5.9 Interaction routing / authority resolution

The Traditional Gu messaging path will need a bounded authority-routing contract. The router should not infer behavior merely by directly querying internal Gu OS tables for “does a Case exist?”.

Conceptually, a capability such as:

```text
resolve_interaction_authority(tenant, lead, conversation)
```

should resolve whether the current interaction is:

- legacy-owned;
- Gu OS-owned, with the relevant Case identity;
- temporarily human-controlled;
- or another explicitly defined migration state.

The canonical authority may live in Gu OS, while the legacy messaging layer can use a suitable service/projection/cache if required for latency and resilience. The exact mechanism belongs in Architecture Analysis / ADR.

### 5.10 Human takeover and interaction capture

The preferred human intervention path is the **same WhatsApp thread** where Gu is talking to the prospect because this preserves one visible conversation and minimizes reconciliation.

Other real-world intervention paths remain valid:

- the advisor may message the prospect directly from another WhatsApp context;
- the advisor may call the prospect by phone;
- future Ungga real-time voice may capture a transcript or structured outcome.

Gu OS should treat channel continuity and knowledge continuity separately. When an advisor acts through another channel, Gu OS should eventually ingest reliable interaction evidence/outcomes so the Case does not lose the relationship history.

When the advisor is known to be actively communicating, Gu should conservatively suppress competing outbound communication even if the full content has not yet been captured.

### 5.11 Evidence gaps are work, not silent unknowns

Relationship Operations must detect when an expected business outcome should have occurred but there is still no admissible evidence.

Example:

```text
visit_requested
  -> reasonable coordination time passes
  -> no visit_scheduled / cancellation / other resolution evidence
  -> Case wakes
  -> inspect current operational sources
  -> if still unresolved, perform reconciliation work
```

Reconciliation may include asking the advisor, reminding the advisor of pending work, or — when commercially appropriate — asking the prospect.

Examples of evidence gaps include:

- visit requested but no scheduling evidence;
- scheduled visit with no attended/cancelled/no-show evidence;
- advisor commitment with no evidence it occurred;
- requested information/documents with no evidence they were delivered.

A timer or deadline should therefore mean **re-evaluate the opportunity**, not automatically **send a follow-up message**.

### 5.12 Cross-repository implementation consequence

Relationship Operations is one product responsibility but its brownfield implementation will likely require coordinated changes in both repositories.

Expected responsibility split:

```text
Gu OS repo
  - admission decision
  - Lead Opportunity durable state
  - organization/platform policy
  - situational next-work reasoning
  - evidence / commitments / human gates
  - runtime authority state/contracts

Traditional Gu repo
  - WhatsApp ingress/egress
  - legacy message persistence
  - existing human-takeover detection
  - event/fact forwarding
  - authority-aware routing
  - suppression of legacy-agent response when Gu OS owns the interaction
  - operational APIs/adapters where needed
```

This does **not** imply two competing Product Specs. The intended business behavior should remain canonical in the Gu OS Feature / Business Spec(s), with a cross-system Architecture Analysis / integration contract and repo-specific Technical Plans/tasks implementing that single product contract.


### 5.13 Shared durable-kernel constraint for R1

Relationship Operations must be implemented as a specialization of Gu OS's **shared durable-work kernel**, not as a domain-specific runtime or mini-application. Reusing a common Supabase database is not sufficient if each domain then recreates its own scheduler, retries, approvals, evidence, policy resolution or recovery semantics.

The architectural constraint is:

> **Relationship Operations must reuse shared Gu OS primitives for durability, execution, evidence/provenance, human gates, scheduling, recovery and policy wherever those primitives satisfy the required contract. Domain-specific concepts may specialize Case semantics, facts, milestones, policies, Skills and bounded capabilities. A new infrastructure primitive should be introduced only when the existing kernel cannot represent the requirement cleanly and the need is demonstrably cross-domain or foundational — not merely for local implementation convenience.**

This implies the following design test before any R1-specific infrastructure is accepted:

```text
R1 concept
  -> existing shared primitive?       -> reuse as-is
  -> shared primitive insufficient?   -> consider generic extension
  -> genuinely domain semantic?       -> Relationship fact/event/policy/Skill
  -> durable architectural choice?    -> Architecture Analysis / ADR
```

In particular, R1 must not assume that every business progression signal belongs in `current_step`. The current kernel defines `current_step` as a durable procedural milestone and `status` as the generic runtime mode. Relationship progression can require a combination of Case facts, Work Items, accepted evidence and projections without recreating a rigid CRM funnel.

A companion discovery artifact — **R1 Concept → Shared Kernel Mapping** — should be maintained before Feature / Business Specs are approved far enough to imply new infrastructure.

### 5.14 Cost-to-Serve / Resource Usage & Economic Telemetry is a cross-cutting requirement

R1 must preserve enough economic telemetry to understand the **variable cost-to-serve** of durable business work while it is in progress and after it closes. This is broader than LLM metering. Material metered resource consumption can include, where applicable:

- LLM / reasoning calls;
- embeddings, vision, extraction and classification;
- WhatsApp or other paid messaging units;
- voice minutes / speech services;
- document-processing services;
- geocoding / maps / search providers;
- specialized real-estate or risk/data providers;
- other paid external APIs or metered infrastructure whose use is causally attributable to the work.

The current repo already contains `ai_usage_events`, an append-only internal AI-model usage ledger with reported/estimated cost, pricing version and correlation seams for session, turn, `operational_case_id`, `workflow_definition_id`, `work_item_id` and `work_item_attempt_id`. That is an important existing primitive, but its current contract is deliberately **AI-model-only and explicitly not customer billing**.

R1 therefore adopts the following cross-cutting requirement:

> **Material variable resource consumption attributable to Gu OS work should be observable and economically measurable. The system should preserve enough correlation and provenance to calculate cost-to-date and final variable cost by the most appropriate durable root and work unit — including user/account context, Case or Durable Task / Work Run, Work Item, Attempt and relevant business outcome — without collapsing internal cost observability into customer credits or billing.**

Cost attribution should follow causal accounting rather than convenient but misleading allocation:

```text
resource event belongs to one work object
    -> direct attribution

resource event benefits multiple similar objects
    -> shared variable cost + documented allocation driver

objects consume materially different effort
    -> weighted causal driver where defensible

no defensible per-object driver exists
    -> retain as shared account/platform cost rather than manufacture precision
```

Candidate drivers can include opportunities processed, attributable tokens/context, messages analyzed, properties evaluated, minutes consumed, pages processed, API calls or another measurable activity that best explains the resource consumption. The exact driver must be selected per activity, not forced into one universal formula, and the allocation method/version should remain auditable.

This requirement is **not** approval of a billing design. A separate Pricing / Credits / Billing initiative should determine what the customer is charged, how credits are valued/deducted/recharged and how that ledger interoperates with the existing Traditional Gu credit/accounting path. Internal cost, customer price and credit movement must remain separate concepts so pricing can change without rewriting historical cost and provider costs can change without rewriting historical customer charges.

R1 / shared-platform evolution should also preserve a **first-class internal economic-observability experience for authorized Ungga administrators**. The current `ai_usage_events` contract already follows an admin-only server-side access pattern tied to `profiles.is_ungga_admin`; the exact authorization implementation should be re-verified when the feature is specified, but the product requirement is clear: an authorized Ungga operator should be able to inspect reconciliable cost views from global/resource spend down to account, durable root, Case, Work Item/Attempt, business activity and outcome. The experience should distinguish at least direct cost, allocated shared variable cost and unallocated/shared/platform cost, and support drill-down to auditable underlying usage/cost/allocation records. Exact visual design, navigation and schema remain downstream Feature Spec / Architecture decisions.

A reconciliation invariant should guide those views: **total recorded provider/resource cost must be explainable as directly attributed + allocated shared + explicitly unallocated/shared/overhead cost, rather than disappear between ledgers and rollups.**

## 6. Important discovery gap: Traditional Gu source audit

The reviewed Gu OS repository and canonical product documents establish the intended **absorption** of Traditional Gu behavior, but this repo does not contain enough evidence to verify the complete production implementation of:

- WhatsApp lead conversation flow;
- fixed/pre-programmed follow-up timers;
- current lead qualification/profiling behavior;
- matching logic boundaries;
- appointment creation/change/cancellation behavior;
- deal progression/write paths;
- current CRM/external-system write-back behavior;
- exact Mongo/Firestore collection names, indexes and service contracts;
- identity mapping between Traditional Gu users/accounts and Gu OS tenants/users.

Before a Technical Plan is approved, we need a source-level audit of the legacy repository/services that own those behaviors.

The Feature / Business Spec can begin before that audit is fully complete because behavior should be defined from the product/business perspective, but the Spec must not pretend that unverified legacy implementation details are known.

## 7. Product problem / opportunity

Today, Traditional Gu already performs valuable lead-engagement work, while Gu OS has durable operating primitives. The missing product layer is **durable, situational responsibility for a commercial opportunity**.

Opportunity progression is currently distributed across:

- live prospect conversations;
- legacy lead/property/appointment/deal records;
- fixed or pre-programmed follow-up logic;
- human memory and relationship judgment;
- analytics mirrors;
- manual pipeline/task operation.

The target is **not** to produce more follow-up activity. The target is for Gu to assume a bounded business responsibility:

- know which opportunity it is advancing;
- understand the fresh commercial context;
- recognize material changes and commitments;
- determine what work best advances the objective now;
- act within explicit policy/authority;
- wake up when new evidence, inventory, a commitment or a timer matters;
- involve a human when relationship, judgment or authority matters;
- preserve evidence of what actually happened.

## 8. Desired initiative outcome

In a controlled pilot, Gu should be able to maintain responsibility for a viable buyer/renter opportunity across multiple sessions and asynchronous events without requiring the professional to manually keep a CRM/pipeline/task system moving.

The first measurable commercial outcome chain is **visit progression**, with multiple meaningful milestones rather than only one terminal visit metric.

The working progression semantics are:

```text
opportunity admitted
  -> meaningful interaction
  -> visit_requested
  -> visit_scheduled
  -> visit_attended
  -> post-visit progression
  -> transaction_started
```

`visit_scheduled` already means the visit is agreed/confirmed for a concrete date/time; R1 should **not** introduce a separate `visit_confirmed` milestone unless later evidence shows a real business distinction.

`visit_rescheduled`, `visit_cancelled`, `visit_no_show` and similar facts are important lifecycle/exception events, not positive progression milestones by themselves.

R1 should make these outcomes observable enough that R2 can measure the economic loop rather than merely AI activity.

The initiative should prove **situational responsibility**, not simply replace a fixed 2h/24h follow-up timer with more timers.

## 9. Primary actors

### Internal actors

- **Advisor / broker:** real-estate professional responsible for relationship judgment, accountable commitments and physical-world/client-sensitive intervention where needed.
- **Brokerage owner / operations supervisor:** needs portfolio-level visibility, control, exceptions and outcome evidence.
- **Gu:** owns the delegated operational responsibility within explicit policy and authority boundaries.

### External actor

- **Buyer / renter prospect:** the person whose evolving needs, responses, inactivity, objections, property reactions and visit progression determine the opportunity state.

### Systems / providers

- Traditional Gu operational services/stores;
- Ungga unified property inventory;
- connected real-estate CRMs and inventory sources;
- messaging/channel infrastructure;
- appointment/calendar infrastructure;
- BigQuery analytical warehouse;
- Gu OS durable runtime / Supabase.

Their exact authority and write-back roles must be declared per business concept rather than summarized as "the CRM."

## 10. Proposed scope for the first Relationship Operations increment

This is initiative scope, not yet the exact behavioral contract.

### In scope

- Define the **Lead Opportunity** as a durable business responsibility distinct from a chat thread and from a concrete Transaction Case.
- Define when Gu begins and ceases durable responsibility for an opportunity.
- Preserve and progressively absorb relevant Traditional Gu lead engagement, requirement understanding, matching and follow-up behavior.
- Make material opportunity facts, commitments, events and outcomes explicit enough to support continuity.
- Replace timer-only follow-up logic with situational next-work decisions driven by current state, fresh operational events, commitments and scheduled reconsideration where appropriate.
- Allow new/relevant inventory to wake or re-evaluate an active opportunity when the match is materially actionable.
- Coordinate visit progression as the first measurable commercial milestone.
- Define proportional human involvement for relationship-sensitive, authority-sensitive or ambiguous moments.
- Provide portfolio supervision / mission-control visibility focused on **which opportunities need attention and why**, not manual pipeline upkeep.
- Instrument R2 outcome/repeatability evidence from the beginning.
- Instrument material variable resource usage and cost attribution from the beginning so R1 can report cost-to-date/final cost-to-serve by durable work and business outcome.
- Define the product-level data/authority contract necessary to avoid competing sources of truth.
- Define admission separately from migration-time runtime authority so shadowing and bounded transfer are possible.
- Define one authoritative prospect-response decision-maker per interaction and preserve temporary human conversational takeover.
- Detect unresolved expected outcomes/evidence gaps and perform appropriate reconciliation work rather than silently losing them.

### Explicit non-goals for the first increment

- Full replacement of every CRM function.
- Full replacement/rewrite of Traditional Gu.
- Copying every Mongo/Firebase/CRM/warehouse field into Gu OS.
- Using BigQuery as the live operational transaction/action database.
- A rigid funnel whose stage is the primary source of truth.
- A general Transaction Case covering offers, documents, financing and closing.
- Demand-generation/campaign operation.
- Full Business Brain / cross-Case cognition.
- Direct-to-consumer marketplace/discovery.
- Making every lead interaction a Case.
- Rebuilding proven Traditional Gu behavior before equivalent quality and observability exist.
- Full enterprise/team administration beyond the minimum organization/multi-seat slice required by Relationship Operations.
- Assuming autonomous outbound messaging rules before product/domain approval.
- Exposing generic Mongo/Firestore CRUD to the model merely because direct operational access is needed.

## 11. High-level business semantics — not a schema

The following concepts appear necessary to specify, but this Brief intentionally does not define tables/fields:

- **Organization / brokerage identity:** the business entity within which Relationship work occurs; legacy representation may currently be indirect through the principal `super-admin`, but Gu OS must not equate organization identity permanently with one user.
- **Organization membership / role:** the relationship between a human user/advisor and the brokerage, including legacy `super-admin`, `admin` and `vendedor` semantics during migration.
- **Account user / advisor identity:** the real-estate professional / Ungga user associated with the opportunity.
- **Assigned advisor / DRI:** the professional primarily responsible for the commercial relationship; distinct from tenant ownership, actor identity and approval authority.
- **Human contact endpoint:** the advisor's own WhatsApp/contact identity used for notifications/input/takeover; distinct from the Gu business-number/channel identity used with prospects.
- **Prospect / lead identity:** the external buyer/renter and the declared current SOR identity.
- **Lead Opportunity:** the durable commercial responsibility Gu is currently advancing.
- **Intent / requirements:** current buyer/renter need and material changes.
- **Property consideration:** relevant properties presented/matched and material reactions.
- **Commitment:** an explicit promise, expected response or future action that should not depend on memory.
- **Next-work need:** what should be reconsidered or performed to advance the objective.
- **Visit progression:** request, coordination and observable visit outcome.
- **Human intervention:** decision, relationship-sensitive handoff, authority gate, correction or pause.
- **Outcome evidence:** evidence sufficient to support a real progression/completion claim.
- **Source/provenance:** where a business fact came from and which system is authoritative for it.
- **Runtime decision authority:** which runtime is currently permitted to decide the next prospect-facing action for the opportunity.
- **Conversation authority:** whether Gu or an active human advisor should speak to the prospect at the current moment.
- **Evidence gap:** an expected outcome whose status remains unresolved after the relevant time/event boundary and therefore creates reconciliation work.
- **Resource usage:** a metered unit consumed while performing work (for example model tokens/call, WhatsApp conversation/message unit, voice minute, page processed or paid provider/API request).
- **Cost attribution:** the economically justified assignment of direct or shared variable resource cost to the durable/work object(s) that caused or benefited from the consumption, with an explicit allocation driver when shared.
- **Customer charge / credits:** a separate commercial/billing concept that must not be inferred directly from internal cost-to-serve.

The Feature / Business Spec must decide which of these are first-class business concepts versus projections/context. Architecture/Technical Plan will decide their implementation representation.

## 12. Human + Gu operating model for the initiative

The intended operating model is:

- **Gu may reason broadly** about what best advances the opportunity.
- **Gu may execute only within explicit capability, channel, tenant, platform policy, organization policy and risk/authority boundaries.**
- **Humans do not need to operate every pipeline record or create every follow-up task.**
- Routine prospect communication and low-risk commercial progression may be autonomous when supported by fresh authoritative data and approved policy.
- **Humans remain the authority** for relationship-sensitive judgment, negotiation, material commitments and other consequential decisions defined by the Spec.
- Human involvement is not binary: Gu may **act**, **act and inform**, **propose and wait**, or **hand over** depending on consequence and policy.
- When an advisor takes over the active prospect conversation, Gu should stop speaking but continue observing/reasoning so the Case remains current.
- The preferred direct-human path is the same WhatsApp thread; off-platform WhatsApp/phone/voice interactions should be captured or reconciled when possible.
- Portfolio supervision should make intervention exception-oriented rather than require constant manual scanning.
- Operational decisions should use fresh authoritative facts, not stale analytical mirrors.
- Deterministic tools/adapters should own database/provider mechanics and repeatable guarantees.
- During migration, **Case existence**, **runtime decision authority**, and **conversation authority** must remain distinct.
- For an interaction assigned to Gu OS, Traditional Gu may provide channel/integration capabilities but must not independently decide a competing prospect response.

The approved P0-3 direction is therefore **risk- and authority-based autonomy**, not a simple “automatic message vs manually approved message” switch.

## 13. Success and graduation evidence

### 13.1 Product acceptance evidence

Relationship Operations v1 should not graduate merely because a Case type exists or the agent can send/draft messages.

At minimum, a controlled pilot should demonstrate that:

- one opportunity survives conversation/session boundaries without losing responsibility;
- material new information changes future work rather than being ignored by a fixed timer;
- fresh operational context is used for prospect-facing decisions;
- a relevant inventory/event/commitment can wake or re-evaluate the opportunity;
- Gu can select the appropriate next work rather than follow one pre-written sequence;
- human intervention occurs where the approved policy requires it;
- the opportunity does not silently progress on ambiguous identity or unsupported facts;
- visit progression/outcomes are linked to admissible evidence where observable;
- the operator can understand why an opportunity needs attention;
- the system can pause/override/recover without losing auditability;
- no stale warehouse snapshot authorizes an action that contradicts fresher operational evidence;
- no interaction is independently answered by both Traditional Gu and Gu OS;
- temporary human takeover suppresses competing Gu speech while preserving Case observation/context;
- at least one unresolved expected outcome/evidence gap is detected and reconciled through the appropriate internal or prospect-facing path;
- current proven customer behavior is preserved or intentionally superseded by approved behavior;
- material metered resource consumption generated by the pilot is captured with enough correlation to calculate cost-to-date/final variable cost for representative Cases/Work Items without confusing those costs with customer credits.

### 13.2 Candidate business / operating metrics

Thresholds are intentionally **not** set in this Brief. Candidate metrics to define during Spec/pilot design include:

- lead → visit-request rate;
- lead → attended-visit rate / Visit Rate where reliable;
- time to first meaningful response / progression event;
- opportunities that cool because an expected next action was missed;
- human interventions per active opportunity;
- proportion of next work executed without manual task creation;
- correction/rework rate after Gu action;
- prospect-facing action approval rate / override rate;
- direct and allocated variable cost per admitted/progressed opportunity, visit-request, scheduled visit and attended visit where evidence is reliable;
- cost-to-date vs final cost per Case / Work Item / Attempt and by material resource category;
- cost per useful business outcome rather than only cost per model call;
- time and custom engineering required to activate a new pilot customer;
- stale-data prevented-action / reconciliation rate if useful operationally;
- latency from meaningful external event to Case reconsideration;
- visit-request → visit-scheduled conversion;
- visit-scheduled → visit-attended conversion;
- unresolved evidence-gap aging / reconciliation success where useful;
- authority-routing conflicts or duplicate-response prevention incidents.

## 14. Dependencies and constraints

- R0 foundation closure remains important, especially production-equivalent verification, Studio/readiness closure and rollback/observability.
- R1 should reuse the implemented Operational Case / Work / event / evidence / HITL primitives rather than create a parallel lead runtime.
- Traditional Gu's current production flow must be source-audited before approving migration/absorption implementation details.
- Exact visit outcome observability must be audited across current operational stores/integrations.
- Existing prospect messaging consent/channel rules and Gu action authority must be explicit in the Spec.
- The source-of-record / provenance contract for lead, message, property, appointment and deal facts must be explicit before a Technical Plan is approved.
- The operational data path must support sufficiently fresh reads and idempotent/controlled writes for the behaviors selected in the Spec.
- BigQuery should remain read-only in its current Gu OS capability unless a separate future analytical requirement justifies a different tool; Relationship Operations should not broaden `bigquery_run_query` into a general CRUD mechanism.
- R1 requires a **minimum viable organization/multi-seat slice** sufficient for Relationship Operations: organization identity, membership/authenticated advisor identity, Opportunity assignment, role-appropriate visibility, human routing and sufficient authority semantics. More advanced organization/team administration remains later roadmap work.
- The legacy WhatsApp path must be able to route/forward inbound events without invoking a competing legacy response when Gu OS has runtime authority.
- The existing Traditional Gu human-takeover behavior should be source-audited and preserved conceptually; the ~10-minute timeout should be treated as a current implementation/default, not yet as a universal product rule.
- Initial R1 migration should support shadowing and explicit authority transfer for selected opportunities/tenants rather than equating Case creation with live cutover.
- R1 execution paths must propagate shared economic-telemetry correlation far enough to measure material variable resource consumption; generalized non-AI resource metering/allocation should extend shared infrastructure rather than be implemented as Relationship-only cost tables.
- Economic telemetry must remain separate from customer credit pricing/balance/recharge semantics; billing interoperability with Traditional Gu is a later dedicated initiative/contract.

## 15. Principal risks / failure modes

- **Activity masquerading as responsibility:** more follow-up messages without better opportunity progression.
- **Over-contact / relationship damage:** Gu follows up because a timer fired rather than because the next action is justified.
- **Stale-data action:** Gu acts from an eight-hour analytical mirror while fresher operational reality already changed.
- **Wrong identity/opportunity association:** a message, property reaction or visit is attached to the wrong durable opportunity.
- **Legacy naming leakage:** ambiguous physical names such as `users` for lead records contaminate Gu OS semantics.
- **Duplicate truth:** Mongo/Firebase, external CRM, Case state, conversation and BigQuery silently compete for the same business fact.
- **Property authority confusion:** Gu assumes every property is CRM-owned even though some inventory is native to Ungga.
- **Premature Case creation:** every inbound lead or bounded question becomes durable work even when no durable responsibility is warranted.
- **Rigid funnel recreation:** the new architecture becomes a CRM stage machine with AI around it.
- **Unsupported progression:** the Case claims a visit/commitment/outcome without admissible evidence.
- **Generic database authority:** model access to broad CRUD primitives creates avoidable security, tenancy and data-integrity risk.
- **Excessive HITL:** approval fatigue recreates manual CRM operation.
- **Insufficient HITL:** prospect-facing or consequential actions occur without appropriate authority.
- **Big-bang absorption:** replacing proven Traditional Gu behavior before equivalent quality, observability and rollback exist.
- **Portfolio noise:** supervision surfaces every Case rather than prioritizing real exceptions/opportunities.
- **Cross-system partial failure:** a write succeeds in one operational system but Case/evidence progression fails elsewhere; requires idempotency, reconciliation and repair rather than pretending distributed atomicity.
- **Split-brain conversation:** Traditional Gu and Gu OS both believe they should answer the same inbound interaction.
- **Case/authority conflation:** creating a Case unexpectedly changes live runtime behavior before shadow/pilot readiness.
- **Human collision:** Gu replies while the advisor is actively handling the relationship.
- **Invisible off-platform work:** advisor actions through separate WhatsApp/phone remain unknown and cause Gu to act on obsolete assumptions.
- **Evidence-gap neglect:** unresolved visits/commitments disappear because no explicit event arrived.
- **Unmetered cost-to-serve:** R1 creates valuable work but cannot explain its full variable cost because resource usage/correlation was omitted from execution paths.
- **False cost precision:** shared/batch resource cost is arbitrarily assigned to individual Cases without a causal cost driver, producing misleading unit economics.
- **Cost/billing conflation:** internal provider/resource cost is treated as the customer credit charge, preventing independent pricing strategy and historical auditability.

## 16. Decision priority vocabulary

This Brief keeps the common `P0 / P1 / P2` shorthand, but defines it explicitly because organizations use these labels differently.

- **P0 — Blocking for Spec approval:** must be sufficiently resolved before the relevant Feature / Business Spec can be approved.
- **P1 — Important, non-blocking for initial Spec:** may be resolved during specification, architecture or pilot design without invalidating the initial product contract.
- **P2 — Later / evidence-gated:** should remain open until implementation or product evidence makes the decision necessary.

These are **decision priorities**, not incident severities.

## 17. Product decisions — P0 and P1-9 through P1-12 directions approved

The detailed decision review uses the P0/P1 vocabulary above and includes why each question matters, real-estate examples, alternatives/trade-offs and a recommendation before human/domain approval. All eight P0 directions are now approved at the Initiative Brief level. Exact enums, schemas, APIs and execution mechanics remain downstream decisions.

### 17.1 P0 decisions with approved product direction

#### P0-1 — When does durable responsibility begin? — **Direction approved**

Not every inbound interaction creates a Lead Opportunity Case. A Case begins when a valid, identifiable commercial prospect creates a situation for which Gu accepts **durable responsibility beyond the current interaction**. Admission can occur immediately — for example, a valid portal lead that organization policy requires Gu to pursue — or after limited clarification when initial intent is ambiguous.

The model is:

```text
lead/contact record
  != conversation
  != Lead Opportunity Case
```

Admission combines commercial signals/context, platform guardrails, organization/brokerage policy, and deterministic tenant/consent/duplicate/safety protections. “Qualified lead” in a rigid funnel sense is not required before Case creation; one purpose of Relationship Operations is to perform the work that advances a prospect toward qualification. Every valid lead should reach an explicit admission disposition — admitted, not admitted with reason, or clarification needed. Traditional Gu may transport/persist the source facts during migration, but the durable **Opportunity Admission** business decision belongs to Gu OS (or a shared capability governed by the Gu OS contract).

#### P0-2 — What is the responsibility boundary after a visit? — **Direction approved**

An attended visit is a major measurable progression milestone, **not** the completion boundary of the Lead Opportunity Case. Relationship Operations continues through post-visit feedback, changed requirements, additional matching, re-engagement, further visits and continued opportunity advancement.

The working early progression milestones are:

```text
opportunity_admitted
meaningful_interaction
visit_requested
visit_scheduled
visit_attended
transaction_started
```

`visit_scheduled` means the visit is agreed/confirmed for a concrete date/time. There is no separate positive `visit_confirmed` milestone unless later evidence proves a meaningful domain distinction. `visit_rescheduled`, `visit_cancelled`, `visit_no_show` and similar changes are lifecycle/exception events rather than positive progression milestones.

Primary responsibility moves to a linked **Transaction Case** when the opportunity changes from relationship/exploration/progression into execution of a concrete deal process around a specific property/transaction object. The exact boundary can vary by operation type and, where relevant, property type. The Lead Opportunity remains linked and can resume primary responsibility if the transaction fails and the prospect still has a viable objective.

#### P0-3 — What prospect-facing communication may Gu execute autonomously? — **Direction approved**

Gu should autonomously handle routine prospect communication and low-risk commercial progression — including requirement clarification, contextual follow-up, matching, reasonable re-engagement and visit coordination — when supported by fresh authoritative data and allowed by platform/organization policy. Human involvement is proportional to consequence and may take four forms: Gu acts; Gu acts and informs; Gu prepares/proposes and waits for approval; or a human takes over while Gu observes/supports.

Economic, contractual, negotiation and other authority-bearing commitments require explicit human or otherwise explicitly delegated authority. Three dimensions remain distinct:

- **Action authority** — what Gu may do.
- **Runtime decision authority** — which runtime (`LEGACY`, `GU_OS`, or equivalent) decides the next interaction during migration.
- **Conversation authority** — whether Gu or an active human advisor should speak right now.

The first R1 migration should transfer Gu OS runtime authority only for admitted Lead Opportunities explicitly enabled under shadow/pilot/cutover policy. **Case admission is not authority transfer.** Exactly one runtime may be authoritative for a prospect interaction at a time. Human intervention can temporarily suppress Gu speaking without suppressing Case observation/reasoning.

#### P0-4 — Can one contact have multiple concurrent Lead Opportunities? — **Direction approved**

A contact may have multiple concurrent Lead Opportunities only when they represent **materially distinct commercial objectives that can progress, pause, succeed or fail independently**. Contact identity and Opportunity identity are different concepts.

The default is **continuity**, not fragmentation. Changes in criteria, properties considered, budget, geography or even operation type do not automatically create a new Opportunity if they remain part of the same underlying commercial objective. A new Case is justified when the objective is independently actionable — for example, a primary-home search and a separate investment-property objective.

R1 should support correction of imperfect classification through explicit **merge/split semantics** that preserve history/evidence. Exact merge/split mechanics are not approved here.

#### P0-5 — When is an opportunity viable, paused or closed? — **Direction approved**

Lead Opportunity lifecycle must distinguish at least five conceptual dimensions rather than collapse them into one status enum:

1. **Commercial responsibility / viability** — whether a meaningful commercial objective still exists and can reasonably be advanced.
2. **Progression** — which business milestones/events have occurred.
3. **Case runtime status** — how the durable engine is currently operating (`active`, `waiting_external`, `waiting_internal`, `paused`, `completed`, `failed`, as currently defined by the shared Case kernel).
4. **Delivery/action policy** — whether an otherwise useful action is currently eligible under cooldowns, delivery windows, contact limits or organization policy.
5. **Closure outcome** — why durable commercial responsibility ended, such as `objective_achieved`, `lost`, `invalid`, `duplicate` or `superseded` (final vocabulary belongs in the Spec).

Inactivity, a cooldown or runtime waiting does **not** by itself mean that an Opportunity is lost or commercially paused. Likewise, a prospect request such as “contact me in three months” should remain wakeable through the shared scheduling/policy mechanisms rather than being mapped mechanically to runtime `paused` if that would suppress reconsideration.

`Lost` is a **business closure outcome**, not runtime `failed`. Business loss is not system failure. A transaction start also does **not** complete the Lead Opportunity: the Opportunity remains open and linked while Transaction Operations is primary. If the transaction succeeds with sufficient evidence, the underlying objective can be closed as achieved; if it fails and the prospect remains viable, Relationship Operations can resume.

#### P0-6 — What evidence is sufficient for visit progression? — **Direction approved**

Visit progression should use the **strongest currently observable operational evidence** while explicitly representing gaps in observability. In the current Traditional Gu flow, creation of an appointment is strong positive evidence of `visit_requested` because the record is created from an explicit prospect request to visit a property. Its absence is not proof that no visit was requested, because some advisor/prospect coordination may occur outside currently observable Ungga channels.

The legacy appointment representation contains useful evidence candidates — including requested/proposed date/time, `owner_appointment_status`, `appointment_status`, `property_was_visited`, `finished`, reschedule/cancellation information and related identifiers — but subsequent visit states are not sufficiently reliable to be copied blindly as Gu OS truth. For example:

- date/time can represent a requested/proposed time rather than an agreed visit;
- `owner_appointment_status` may reflect confirmation/cancellation/reschedule through Gu, while `null` can mean “not observed through this mechanism,” not “not confirmed”;
- `appointment_status` appears related to a later reconfirmation flow and must not be equated automatically with the moment `visit_scheduled` was established;
- `property_was_visited` depends on a next-day prospect survey, so positive evidence can be useful while `null` is not evidence that the visit did not occur;
- `finished` is an appointment-lifecycle signal and is not automatically equivalent to `visit_attended`.

Therefore existing fields are treated as **evidence with provenance and known semantics**, not as a universal state machine. Missing or stale data ordinarily yields `unknown`, not a negative outcome. When a commercially important expected outcome remains unresolved, Relationship Operations should re-read available sources and create reconciliation work through the advisor, prospect or newly observable channels. R1 should progressively make the rest of the visit lifecycle as observable as `visit_requested`, rather than invent a clean status model over incomplete legacy data.

#### P0-7 — What situations require human involvement? — **Direction approved**

Human involvement is proportional to **consequence, authority, ambiguity and recoverability**. Gu remains autonomous for routine relationship progression and normal commercial ambiguity. Human notification is appropriate when a development is important but does not require approval. Explicit approval is required before Gu makes non-delegated economic, contractual, negotiation or other authority-bearing commitments. Human takeover should be available or required for explicit human requests, serious trust/conflict situations, unresolved identity/authority ambiguity where continuing autonomously would create material risk, or other exceptional relationship-sensitive cases.

Missing information alone should generally trigger **targeted human input**, not a full conversational takeover. Platform hard bounds are deterministic; organization policy may be more restrictive. Model judgment can recognize frustration, ambiguity, intent or relationship risk, while the policy layer enforces protected actions.

The governing principle is:

> **Human gates protect authority, irreversible consequence and material relationship risk; they do not substitute for Gu's ordinary judgment.**

#### P0-8 — What is the product-level Source-of-Record and write-back contract? — **Direction approved**

Relationship Operations uses **fact-level, domain-aware ownership**, not one monolithic source of record. Existing operational systems remain authoritative for the entities/provider facts they own — for example, lead/contact identity, original channel messages, current property/inventory data, and operational appointment/deal objects. Gu OS is authoritative for the durable Lead Opportunity responsibility: its commercial objective, accepted/interpreted Case facts and requirements with provenance, commitments, accepted progression facts, next work, human decisions, evidence gaps, lifecycle and closure outcome.

Gu OS must not create full mirrors of legacy entities merely to own the Opportunity. Cross-system write-back is **selective, authorized and evidence-backed**: write back when another operational system needs the fact to continue its own responsibility correctly, or when failing to synchronize would leave materially contradictory operational reality. Knowledge of a fact is not itself write authority.

BigQuery remains an **analytical projection**, not R1 operational authority. Conflicts should be reconciled using semantic ownership, provenance, recency and source semantics rather than generic last-write-wins. Idempotency, retry/outbox/reconciliation mechanics and the exact field-level authority matrix remain Architecture/Technical Plan concerns.

### 17.2 P0 closure note

There are no remaining P0 **product-direction** questions in this Initiative Brief. This does not mean R1 is implementation-ready. The approved directions still require:

- a Concept → Shared Kernel Mapping against current Gu OS primitives;
- Feature / Business Specs with precise intended behavior;
- source-level audit of Traditional Gu where implementation facts are not yet verified;
- Architecture Analysis / ADRs for durable cross-system choices;
- Technical Plans only after the relevant product and architecture contracts are sufficiently resolved.
- the cross-cutting Cost-to-Serve / Resource Usage requirement is carried into Specs/Architecture so implementation cannot silently bypass metering/correlation.

### 17.3 P1 — important, non-blocking for the initial product contract

9. **P1-9 — Minimum Work Portfolio experience — DIRECTION APPROVED.**  
   R1 should provide an **exception-first Work Portfolio**: a human supervisory surface over the shared Case / Work / Fact / Approval kernel that lets a real-estate professional supervise many Lead Opportunities without manually operating a CRM pipeline. Its primary experience is a ranked **Needs Attention** view that surfaces materially relevant human interventions with an explicit reason, current situation, Gu's ongoing/intended work, required human action and timing. A secondary **In Motion** view makes Gu's autonomous work visible, and a lightweight **Outcomes** view shows evidence-backed progression such as visit requests, scheduled visits, attended visits and transaction starts. Each Opportunity should support concise drill-down into objective, current facts, progression, next work, evidence and human decisions. The same supervisory model should be accessible conversationally through Gu.

   **Terminology guard:** `Work Portfolio` names the **human-facing supervisory surface**. `Supervisor` should be reserved for agentic/runtime concepts such as the planned **Case Supervisor** that evaluates a Case and helps determine what work best advances its objective now. The responsible real-estate professional remains an advisor / responsible professional / DRI according to context; the product surface is not itself an AI Supervisor.

   **Ranking principle:** rank **human attention**, not merely lead attractiveness. Priority should be explainable and should distinguish opportunity importance from attention urgency. A strong opportunity that Gu is handling correctly may require no interruption, while a lower-value opportunity may need immediate human action because a commitment, authority boundary or time-sensitive coordination is at risk. Exact ranking bands/formula belong in the Feature / Business Spec.

   **Architecture guard:** Work Portfolio is a projection/read model over shared operating truth; it must not become a second Source of Record, CRM stage machine, independent scheduler or domain-specific portfolio database.

10. **P1-10 — Minimum organization / multi-seat slice — DIRECTION APPROVED.**  
    R1 must support the multi-advisor business semantics already present in Traditional Gu and must include a **minimum viable organization/multi-seat foundation** sufficient for Relationship Operations. An initial operational validation may begin with one authenticated Gu OS seat, but the target R1 product architecture must support multiple authenticated advisors as a first-class near-term requirement.

    Traditional Gu currently represents a brokerage indirectly through a principal `super-admin` user plus related `admin` / `vendedor` users associated through `organization_id` / `org_name`; there is no separate legacy Organization table. Gu OS should treat this as the **legacy identity/membership source during migration**, not as the permanent organization model. In particular, the legacy `organization_id` behaves like a principal-user reference and must not become the canonical semantic definition of an organization in Gu OS.

    The minimum R1 slice should establish or cleanly enable: **organization identity, membership, authenticated advisor identity, Opportunity assignment / DRI, role-appropriate visibility, human routing/contact identity and sufficient decision-authority semantics** for Relationship work. Full custom role systems, complex team hierarchies, enterprise IAM and advanced organization administration may remain in the later organization/team maturity roadmap.

    **Identity guard:** tenant/account ownership, organization membership, assigned advisor/DRI, human actor, approver/decision authority, advisor WhatsApp contact endpoint and Gu business-number/channel identity are distinct concepts even when an early pilot maps several of them to the same person/account.

    **Roadmap implication:** R3 should no longer be framed as the first introduction of organization/multi-seat. R1 pulls forward the minimum foundation required by Relationship Operations; R3 becomes **organization/team maturity and expansion** beyond that minimum.

11. **P1-11 — Shared Inventory and Opportunity wake-up — DIRECTION APPROVED.**  
    Shared Inventory should be treated as an **authorized extension of the inventory universe** available to Relationship Operations, not as a separate relationship workflow, pipeline or Case model. Property source changes provenance, permissions, representation/economic rights and policy; it does not create a second Relationship Operations model.

    A materially new or materially changed **authorized** property match may wake a viable Lead Opportunity and trigger situational re-evaluation. The event is a reason for Gu to reconsider the Opportunity — it is **not** an instruction to send a property, contact the prospect or route/share lead data with another brokerage. Before acting, Gu should re-read current Opportunity facts, prior property reactions, inventory freshness/availability and applicable delivery/authority policy.

    The match itself is an **actionable opportunity input**, not a commercial progression milestone. Progression occurs only when the relationship/opportunity materially advances — for example, the prospect engages with the option, requests a visit, schedules/attends a visit or otherwise moves toward a concrete transaction.

    Relationship Operations owns the question **whether and how an eligible match can advance the prospect relationship**. Inventory/Network capabilities remain authoritative for **inventory eligibility, provenance, representation, sharing permissions, cross-brokerage routing, attribution and commission/economic rights**. Matching a Shared Inventory property does not by itself authorize disclosure of prospect identity/data to another brokerage.

    Prior property exposure and reactions should remain part of durable Opportunity context so Gu does not repeatedly present rejected options without a material change. A property may become relevant again when a material fact changes — for example price, availability or prospect requirements — and that change can legitimately trigger re-evaluation.

    **Short rule:** a new match is a reason to reconsider the Opportunity, not an instruction to send a property.

12. **P1-12 — Production-representative pilot environment — DIRECTION APPROVED.**  
    R1 should be validated in a **production-representative but operationally bounded brokerage environment** with continuous real lead flow, multiple advisors, current inventory access, observable visit progression and a customer willing to delegate bounded relationship work to Gu. The pilot must generate enough real multi-day Opportunity journeys to exercise admission, event/scheduled wake-ups, matching including Shared Inventory where available, follow-up, human gates, evidence gaps, visit progression, recovery and closure rather than merely testing conversation quality or UI usability.

    Authority should progress deliberately from **shadow observation → assisted execution → selective live autonomy → broader situational responsibility** as evidence supports it. The pilot should generate both **operating-contract evidence** (correct admission, wake-up, next-work selection, policy/authority compliance, routing, recovery and evidence reconciliation) and **business/outcome evidence** (opportunity progression toward visits/transactions), together with end-to-end **Cost-to-Serve** observability.

    Exact numeric volume thresholds do not belong in this Initiative Brief. The Pilot / Verification Plan should instead define evidence thresholds for the important behaviors and require repeated real journeys rather than relying on a single aggregate conversion metric.

    **Selection rule:** choose the pilot for **learning density**, not merely customer size or convenience.

## 18. Architecture decisions to open — not product decisions

The following should not be answered by product judgment alone. They should be resolved through repo/legacy-source inspection and Architecture Analysis / ADR where the choice creates a durable constraint.

### A1 — Real-time operational data access boundary

Determine the preferred current-state path for fresh reads/writes:

- existing Traditional Gu domain API/service, if suitable;
- new legacy operational gateway;
- direct Mongo/Firestore adapters hidden behind Gu OS domain tools;
- staged combination.

Decision criteria include freshness, isolation, security, idempotency, source ownership, reuse by other domains and migration cost.

### A2 — Event ingestion / wake-up strategy

Determine how meaningful changes reach active Lead Opportunity Cases:

- initial real-time reads + scheduled reconciliation;
- explicit webhooks/domain events for high-value changes;
- CDC/streaming where justified;
- hybrid progression.

The architecture should be able to evolve toward event-driven wake-ups without requiring an always-on LLM scan.

### A3 — Identity mapping between Traditional Gu and Gu OS

Define the mapping between:

- Gu OS organization / tenant;
- Gu OS user/advisor;
- Traditional Gu Firebase account/user ids;
- Gu numbers;
- lead/contact ids;
- relevant external CRM/property source ids.

Do not reuse ambiguous legacy `owner` terminology as the canonical Gu OS identity model.

### A4 — Cross-system write consistency

For workflows that touch Mongo, Firebase, external providers and Gu OS state, define:

- idempotency;
- evidence binding;
- retry/reconciliation;
- partial-failure handling;
- ownership of each write;
- no assumption of one distributed ACID transaction across all systems.

### A5 — Analytics feed evolution

Preserve BigQuery as the analytical plane and decide later, based on R2/R4/R5 needs:

- whether the current ~8-hour replication is sufficient;
- whether selected data needs hourly/incremental refresh;
- whether CDC/streaming is warranted for specific analytical use cases;
- how Gu OS Case/outcome/evidence data should feed BigQuery for closed-loop analysis.

This decision must remain separate from the operational freshness requirement of R1.

### A6 — Interaction authority, routing and migration contract

Define how the system represents and resolves, without split-brain behavior:

- Case/durable responsibility existence;
- runtime decision authority (`LEGACY`, `GU_OS`, or equivalent);
- temporary human conversation authority;
- shadow mode versus live Gu OS cutover;
- inbound message/event routing;
- legacy-agent suppression when Gu OS owns the interaction;
- return of conversational authority after human takeover;
- failure/fallback behavior if the authority service/projection is unavailable.

The architecture should expose a bounded authority-resolution contract rather than require the legacy channel handler to infer behavior from Gu OS internal database tables.


### A7 — Shared-kernel fit and generic extension contract

For every R1 concept that appears to require persistence, scheduling, evidence, approvals, Work or conversation binding, determine whether the current shared primitive is sufficient, needs a **generic cross-domain extension**, or is genuinely Relationship-specific semantics. The decision must explicitly prevent domain-local infrastructure from duplicating the durable Case/Work/Impact planes.

Particular questions include:

- whether Relationship progression should be represented by `current_step`, `case_facts`, Work Items, projections, or a combination;
- whether business evidence gaps need any generic primitive beyond facts + Work;
- whether the existing engagement-policy resolver covers prospect-facing WhatsApp safely;
- whether current Case event vocabulary is sufficient without introducing Relationship-only event infrastructure.

### A8 — Case relationship / lineage and transaction handoff contract

Define a generic way, if one does not already exist, to represent durable Case relationships needed by R1 without hard-coding a lead-specific graph:

- contact → multiple Lead Opportunities;
- Opportunity merge/split/supersession history;
- Lead Opportunity → linked Transaction Case;
- transfer of primary responsibility and reactivation if a transaction fails.

The reviewed kernel evidence establishes Case roots, Work roots and workflow definition pinning, but does not yet establish a canonical Case-to-Case relationship/lineage primitive. Architecture Analysis should verify the full repo before concluding that a new primitive is required.

### A9 — Resource Usage, Cost Attribution & Economic Telemetry

Generalize the existing AI-usage observability contract into a durable cross-domain approach for material variable resource consumption without turning Relationship Operations into the owner of a billing subsystem.

Architecture Analysis should determine:

- which existing `ai_usage_events` correlation fields can be reused directly by Case/Work execution and where propagation is currently missing;
- whether a generic resource-usage / cost-event primitive is needed for non-AI resources such as messaging, voice, document processing and paid external providers;
- how direct attribution differs from shared-cost allocation when one resource event serves multiple Cases or other business objects;
- how allocation method, cost driver, quantity/weight and policy/version are preserved so the calculation is auditable and can evolve;
- how costs attach to `operational_case`, `work_item`, `work_item_attempt`, `durable_task` / `work_run`, account/user context and business outcomes without inventing false precision;
- how retries, failed attempts and reconciliation work remain visible in cost-to-serve;
- how provider price versions and estimated/reported costs remain historically interpretable;
- how an authorized Ungga-admin economic-observability surface can drill from global/resource spend to account, durable root, Case, Work Item/Attempt, business activity and outcome without introducing a second economic Source of Record;
- how reconciliable rollups prove that total recorded resource cost equals directly attributed + allocated shared + explicitly unallocated/shared/overhead cost, with traceability to underlying usage/cost/allocation records;
- how internal economic telemetry remains structurally distinct from future customer Pricing / Credits / Billing and the Traditional Gu customer credit ledger.

The default cost-accounting rule should be **direct causal attribution first; documented Activity-Based Costing driver for shared variable work; shared/account/platform retention when no defensible driver exists**.

## 19. Candidate Feature / Business Spec decomposition

This is a **candidate decomposition**, not an approved 1:1 mapping. Discovery may merge or split these after the P0 decisions.

### Candidate Spec A — Lead Opportunity Responsibility & Lifecycle

Owns intended behavior for:

- Case creation/admission;
- opportunity identity/cardinality;
- commercial viability / temporary hold / closure-outcome semantics, explicitly separate from generic runtime `status`;
- durable facts/commitments at the business level;
- boundary with bounded chat work, legacy lead/contact records and Transaction Operations.

### Candidate Spec B — Situational Progression, Next Work & Human Authority

Owns intended behavior for:

- event/state/commitment-driven reconsideration;
- scheduled wake-ups where necessary;
- matching/follow-up/re-engagement work selection;
- prospect-facing action authority;
- relationship-sensitive human handoff;
- pause/override/correction behavior;
- freshness requirements from the product perspective;
- action authority, runtime authority and conversation authority semantics;
- human takeover / return-of-authority behavior from the product perspective;
- evidence-gap detection and reconciliation behavior.

This Spec should reuse existing Skills/capabilities where appropriate rather than redefine them as a new lead-specific engine.

### Candidate Spec C — Visit Progression & Outcome Evidence

Owns intended behavior for:

- visit request;
- coordination/scheduling;
- changes/cancellation/no-show where observable;
- attended/completed evidence;
- how visit outcomes affect the opportunity;
- downstream outcome events for R2 and later Demand Operations.

### Candidate Spec D — Portfolio Supervision & Operator Control

Owns intended behavior for:

- which opportunities surface to the professional and why;
- prioritization / exception semantics;
- human pending work;
- ability to inspect, intervene, pause/override and understand outcome/evidence;
- avoiding manual pipeline upkeep as the default operating model.

### Migration / absorption note

The **Traditional Gu → Gu OS absorption plan should not automatically become another Feature Spec**. If approved behavior is preserved, the mapping of legacy services/data/timers/integrations into the new contracts primarily belongs in Architecture Analysis / Technical Plan. A separate behavior Spec is needed only where migration intentionally changes user/business behavior.

Likewise, "Mongo vs Firebase vs API" is not a Feature Spec decision unless it changes externally meaningful behavior.

Because live prospect behavior crosses repositories, approved Feature / Business Specs should remain canonical in the Gu OS documentation hierarchy. Cross-system Architecture Analysis / integration contracts can then produce **repo-specific Technical Plans and Tasks** for Gu OS and Traditional Gu without duplicating or silently redefining the product behavior in the legacy repo.

### Cross-cutting requirement — Economic telemetry / Cost-to-Serve

Every R1 Spec that authorizes material executable work should state the observability requirement for resource consumption and correlation, while leaving the generic metering/allocation mechanism to A9 / shared infrastructure. Specs should make the business/work boundary clear enough that cost can later be aggregated by meaningful activity (for example qualification/conversation, matching, follow-up, visit coordination, reconciliation) and outcome. A separate customer Billing/Pricing Spec should not be smuggled into R1.

## 20. Exit criterion for this Initiative Brief

At v0.5, the Initiative Brief has completed its primary P0 product-direction gate: **P0-1 through P0-8 have approved directions**. The Brief can now support downstream specification work when the following are also true enough for the specific Spec being opened:

1. product/domain leadership continues to accept the initiative responsibility and non-goals;
2. the companion **R1 Concept → Shared Kernel Mapping** has classified the major R1 concepts against current Gu OS primitives and surfaced genuine architecture gaps instead of assuming domain-local infrastructure;
3. the selected first pilot and its observable outcome sources are known enough to test the relevant behavioral contract;
4. the current Traditional Gu production path/repository/services are identified for source-level audit, including WhatsApp routing, appointment lifecycle, off-platform interaction gaps and human takeover behavior;
5. the candidate Spec boundaries are approved or revised;
6. the working data/system boundary — including durable responsibility vs runtime authority vs conversation authority, and fact-level source ownership/write-back — is accepted strongly enough to open Architecture Analysis without pretending the Brief itself is an ADR.
7. R1 economic telemetry is mapped as a cross-cutting requirement: material variable resource usage must remain measurable/correlatable, while customer credits/billing remain a separate future contract.

The next product artifacts may therefore be Feature / Business Specs, with Architecture Analysis progressing in parallel where product behavior is sufficiently settled. P1 decisions should be reviewed before they become blockers for a selected Spec or pilot. A Technical Plan or implementation task list should not be approved before the relevant Spec and architectural constraints are sufficiently resolved.

## Appendix 0 — v0.7 update note

v0.7 records the approved P1-10 direction and the newly confirmed Traditional Gu multi-advisor semantics:

- corrected the legacy role terminology to `super-admin` (not `user-admin`);
- documented `super-admin` / `admin` / `vendedor`, `organization_id` / `org_name` and the absence of a separate legacy Organization table;
- classified `organization_id` as a legacy organization key/principal-user reference rather than the future canonical Gu OS organization identity;
- recorded that each advisor has a separate human WhatsApp number/contact endpoint while the principal account is associated with the Gu WhatsApp API/business-number identity, with exact routing left to source audit;
- approved a **minimum viable organization/multi-seat slice inside R1** and reframed later R3 as organization/team maturity and expansion.

## Appendix A — Source basis and status discipline

### Canonical Gu OS repo sources

- `docs/product/PRD.md` — parent product intent, current wedge, Relationship Operations and product boundaries.
- `docs/roadmap/gu-os-evolution-roadmap.md` — R1 sequencing, proposed responsibility, graduation evidence and R2 instrumentation.
- `docs/principles/gu-os-principles-and-design-doctrine.md` — responsibility/outcome, truth boundaries, model authority, evidence and brownfield evolution.
- `docs/development/agentic-product-software-development-methodology.md` — Initiative Brief and Feature / Business Spec ownership and human gates.
- `docs/operational-cases/architecture.md` — current implemented durable Case runtime.

### Current Gu OS repository evidence reviewed

- `skills/global/company-data/SKILL.md`
- `skills/global/business-data-core/`
- `skills/global/lead-follow-up-draft/SKILL.md`
- `skills/global/lead-follow-up-draft/references/lead-context.md`
- `skills/global/lead-momentum-watch/SKILL.md`
- `skills/global/inventory-matchmaking-watch/SKILL.md`
- `packages/agent/src/tools/bigquery-adapter.ts`
- `packages/agent/src/tools/bigquery-sql.ts`
- `docs/operational-cases/architecture.md`
- `docs/operational-cases/authoring-playbook.md`
- `packages/db/supabase/migrations/00019_operational_cases.sql`
- `packages/db/supabase/migrations/00021_user_notification_preferences.sql`
- `packages/db/supabase/migrations/00029_operational_case_activation_policy.sql`
- `packages/db/supabase/migrations/00036_notification_engagement_policy_overrides.sql`
- `packages/db/supabase/migrations/00044_operational_case_conversation_bindings.sql`
- `packages/db/supabase/migrations/00065_workflow_definitions.sql`
- `packages/db/supabase/migrations/00066_operational_cases_definition_pin.sql`
- `packages/db/supabase/migrations/00068_evidence_records.sql`
- `packages/db/supabase/migrations/00069_work_plane.sql`
- `packages/db/supabase/migrations/00070_impact_plane.sql`
- `packages/db/supabase/migrations/00064_ai_usage_events.sql`
- `packages/db/supabase/migrations/00074_durable_task_roots.sql`

### Domain-confirmed Traditional Gu facts incorporated through v0.5

- Traditional Gu is a separate operating system/repo with WhatsApp-facing lead/professional flows.
- Fresh operational data currently lives across Firebase and Mongo.
- BigQuery contains mirror/light representations used by current Gu OS analytical Skills.
- Current BigQuery replication is approximately every eight hours.
- Firebase properties is a unified Ungga operational inventory that can be fed by external CRM sync or native Ungga property entry.
- External-CRM property synchronization is incremental and approximately hourly.
- The physical Mongo collection name for lead records may be historically misleading and must not define Gu OS terminology.
- Traditional Gu currently detects same-thread advisor intervention, pauses Gu speaking while continuing to observe, and resumes after roughly ten minutes of advisor inactivity.
- Advisors may also contact prospects through a separate WhatsApp conversation or by phone; direct capture of these off-platform interactions is incomplete today, with testing/planned voice/transcript mechanisms expected to improve observability.
- P0-1 through P0-8 product directions are approved at the Initiative Brief level as of v0.5.

### Source-status warning

Strategic/internal documents and founder/domain-confirmed facts describe Traditional Gu's product behavior and current topology, but they do not substitute for a source-level audit of the current production Traditional Gu runtime. This Brief therefore distinguishes **canonical product intent**, **repo-verified Gu OS behavior**, **domain-confirmed legacy behavior**, and **proposed/open R1 behavior**.


## Appendix B0 — v0.8 decision/update note

v0.8 preserves all approved P0 directions and P1-9/P1-10, and closes **P1-11 — Shared Inventory** at the Initiative Brief level. Relative to v0.7 it adds:

- Shared Inventory is an authorized extension of the inventory universe available to Relationship Operations, not a separate relationship workflow/pipeline;
- a materially new or changed authorized match may wake and re-evaluate a viable Lead Opportunity, but does not mechanically trigger prospect contact or message sending;
- a property match is an actionable input, not itself a commercial progression milestone;
- Relationship Operations owns whether/how a match can advance the relationship, while Network/Inventory retains authority for eligibility, provenance, representation, sharing permissions, routing, attribution and commission/economic rights;
- cross-brokerage prospect-data sharing is never implied merely by the existence of a match;
- prior exposure/rejection and material changes such as price, availability or requirements must inform whether a property is relevant again.


## Appendix B — v0.6 decision/update note

v0.6 preserves all approved P0 directions and the v0.5 economic-telemetry requirement, and closes **P1-9** at the Initiative Brief level. Relative to v0.5 it adds:

- renames the human supervisory surface from **Portfolio Supervisor** to **Work Portfolio** to avoid collision with the planned agentic/runtime **Case Supervisor** concept;
- approves an exception-first Work Portfolio with **Needs Attention** as the primary surface, plus **In Motion**, lightweight evidence-backed **Outcomes**, concise Opportunity drill-down and conversational access through Gu;
- establishes the principle **rank human attention, not merely leads**, with explainable attention priority distinct from opportunity importance;
- reinforces that Work Portfolio is a projection/read model over shared Gu OS operating truth, never a second CRM/SOR/pipeline/runtime;
- strengthens A9 with a first-class internal **Ungga-admin economic-observability surface** supporting reconciliable drill-down from global/resource spend to account, durable root, Case, Work Item/Attempt, business activity and outcome;
- adds the reconciliation rule that total recorded resource/provider cost must remain explainable as direct attribution + allocated shared variable cost + explicit unallocated/shared/overhead cost, traceable to auditable records.

### Historical v0.5 note

v0.5 preserves the approved P0 product directions and the v0.4 shared-kernel constraint, and adds a cross-cutting **Cost-to-Serve / Resource Usage & Economic Telemetry** requirement before P1/Spec work proceeds. Relative to v0.4 it adds:

- full variable-resource observability as an R1 requirement, not only LLM cost;
- explicit inclusion of AI, messaging, voice, document processing, geocoding/search, specialized providers and other causally attributable paid resources;
- direct attribution vs shared variable-cost allocation using documented causal cost drivers / Activity-Based Costing principles;
- a guard against false per-Case precision when no defensible allocation driver exists;
- cost-to-date and final cost aggregation by durable root / Case, Work Item, Attempt, user/account context and relevant business outcome where attribution is defensible;
- explicit separation between internal cost-to-serve, customer pricing/credits and customer wallet/billing/recharge behavior;
- A9 — Resource Usage, Cost Attribution & Economic Telemetry as a cross-domain Architecture Analysis item;
- repo verification that `ai_usage_events` already provides an append-only AI-model ledger with reported/estimated cost, price versioning and Case/Work correlation seams, while explicitly remaining internal observability rather than billing.

### Historical v0.4 note

v0.4 closed the P0 product-direction set and incorporated the shared-kernel audit constraint. Relative to v0.3 it added:

- approved P0-4 Opportunity cardinality / continuity + merge/split direction;
- approved P0-5 separation of commercial responsibility/viability, progression, runtime status, delivery policy and closure outcome;
- approved P0-6 evidence-backed visit progression grounded in the currently observable Traditional Gu appointment lifecycle and explicit evidence-gap reconciliation;
- approved P0-7 consequence/authority/ambiguity/recoverability-based human involvement;
- approved P0-8 fact-level Source-of-Record / selective write-back contract;
- explicit requirement that R1 specialize the shared durable Case/Work/Impact kernel rather than create a Relationship mini-runtime;
- repo-verified references to versioned workflow definitions, Case definition pinning, Work Plane, Impact Plane / `case_facts` / `case_approvals`, delivery-policy overrides, conversation bindings and the separate Durable Task root;
- new architecture questions for shared-kernel fit/generic extensions and generic Case relationship/lineage;
- a companion **R1 Concept → Shared Kernel Mapping** as a required discovery input before architecture/implementation choices are treated as settled.

### Historical v0.3 note

v0.3 incorporated the approved directions for P0-1 through P0-3 and the resulting brownfield migration implications:

- responsibility-based Lead Opportunity admission;
- visit progression milestones and transaction boundary;
- risk/authority-based prospect communication;
- explicit distinction between durable responsibility, runtime decision authority and conversation authority;
- preservation of Traditional Gu's human-takeover behavior conceptually;
- evidence-gap reconciliation;
- one authoritative decision-maker per prospect interaction;
- gradual Gu OS authority transfer for admitted/pilot opportunities;
- coordinated implementation across Gu OS and Traditional Gu repositories under one canonical product contract.


## Appendix D — v0.9 update note

v0.9 closes **P1-12 — Pilot environment** at the Initiative Brief level and therefore completes the P0/P1 product-decision framing for this Brief. It records:

- production-representative but operationally bounded pilot selection;
- multiple-advisor reality, real lead flow, current inventory and observable visit outcomes as desired validation conditions;
- staged authority from shadow through selective live autonomy;
- separate operating-contract, business/outcome and economic evidence;
- evidence thresholds in the Pilot / Verification Plan rather than arbitrary fixed lead-count invariants;
- the next artifact stage as Feature / Business Specs plus Architecture Analysis, not additional Brief-level product-decision expansion.
