# R1 Relationship Operations — Architecture Analysis

> **Version:** v0.18  
> **Status:** Architecture review complete — AC-1 through AC-10 accepted; Generic Case↔Case audit complete; ADR-109 and ADR-110 accepted; minimum Traditional Gu legacy source audit complete for Technical-Plan entry; behavioral Specs S1–S4 approved; S4 owns AC-9 behavioral semantics. Technical Design is complete and approved — see the governing Technical Plan below.  
> **Initiative:** R1 — Relationship Operations v1  
> **Parent product intent:** `docs/product/PRD.md`  
> **Initiative Brief:** `docs/product/initiatives/relationship-operations/brief.md`  
> **S1 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md` — v0.3 approved  
> **S2 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/situational-progression-next-work-human-authority.md` — v0.3 approved  
> **S3 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/visit-progression-outcome-evidence-reconciliation.md` — v0.2 approved  
> **S4 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/work-portfolio-supervisory-experience.md` — v0.1 approved  
> **Cross-domain Experience source:** `docs/manuals/gu-os-experience-architecture.md` — v0.1 approved  
> **Shared-kernel mapping:** `docs/product/initiatives/relationship-operations/r1-concept-shared-kernel-mapping.md`  
> **Legacy source audit:** `docs/product/initiatives/relationship-operations/legacy-source-audit.md` — v0.3 (v0.2 full audit + targeted drift revalidation 2026-08-31) complete for R1 Technical-Plan entry  
> **Technical Plan:** `docs/product/initiatives/relationship-operations/technical-plan.md` — v1.4 approved; translates AC-1..AC-10 and S1–S4 into implementation design and slices SL-0..SL-13, and does not redefine this analysis  
> **Roadmap:** `docs/roadmap/gu-os-evolution-roadmap.md` — R1  
> **Doctrine:** `docs/principles/gu-os-principles-and-design-doctrine.md`  
> **Development method:** `docs/development/agentic-product-software-development-methodology.md`  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/architecture-analysis.md`  
> **Artifact role:** Analyze the structural choices required to implement the approved Relationship Operations behavior as a specialization of the shared Gu OS durable-work kernel. This document compares boundaries and recommends decisions; accepted durable choices should be captured in ADRs where warranted, and implementation mechanics belong in a later Technical Plan.

---

## 1. Executive conclusion

R1 Relationship Operations should **not** create a lead-specific runtime, CRM-like pipeline engine, duplicate operational database, or WhatsApp-specific parallel architecture.

The current Gu OS repository already contains the major durable-work primitives required for R1:

- `operational_cases` as the durable commercial-responsibility root;
- versioned `workflow_definitions` and Case definition pinning;
- `work_items` / attempts / dependencies / work events for executable durable work;
- `case_facts` for append-oriented commercial truth with provenance;
- `case_approvals` for evidence-pinned human decisions;
- generic Case scheduling and wake-up;
- conversation-to-Case binding as an existing pattern;
- engagement-policy seams;
- append-only AI usage/cost telemetry;
- Durable Tasks / Work Runs as a separate non-Case durable root.

The largest R1 architecture gap is therefore **not the durable-work engine**. The gaps are at the boundaries between that kernel and the existing Traditional Gu production world:

1. **fresh operational access and event ingestion;**
2. **first-class organization / membership / multi-seat tenancy;**
3. **legacy ↔ Gu OS identity mapping, including composite Legacy Lead/conversation identity;**
4. **interaction/runtime authority during brownfield migration;**
5. **fact-level source of record and governed cross-system writes;**
6. **versioned organization policy;**
7. **generic Case relationships/lineage;**
8. **WhatsApp/external-conversation binding and human takeover;**
9. **cross-domain resource usage / cost attribution;**
10. **organization-aware projections such as Work Portfolio.**

The recommended target shape is:

```text
                                  GU / HUMAN
                                      │
                                      ▼
                         supervisory + conversational surfaces
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GU OS                                          │
│                                                                             │
│  Organization / membership / authority                                      │
│             │                                                               │
│             ├──────────────► Organization policy                             │
│             │                                                               │
│             ▼                                                               │
│  Lead Opportunity Case ──► Case facts / approvals / relationships           │
│             │                                                               │
│             ├──────────────► Work Items / attempts                           │
│             │                                                               │
│             ├──────────────► scheduled + event wake-up                       │
│             │                                                               │
│             └──────────────► evidence / outcome / cost correlation           │
│                                                                             │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ bounded semantic capabilities
                                ▼
                    Legacy operational gateway / integration layer
                                │
            ┌───────────────────┼────────────────────┐
            ▼                   ▼                    ▼
       Traditional Gu      Mongo / Firebase       CRM / providers
       WhatsApp runtime    operational stores     inventory/calendar/etc.
                                │
                                ▼
                             BigQuery
                        historical analytics only
```

The architectural principle remains:

> **Shared primitives, domain-specific semantics.**

A new primitive is justified only when the current kernel cannot express the requirement cleanly and the need is cross-domain/foundational rather than Relationship-specific convenience.

---

## 2. Source-status discipline

This analysis deliberately distinguishes:

- **CURRENT — REPO VERIFIED** — observed in the current Gu OS repository/docs/migrations inspected for this analysis.
- **CURRENT — DOMAIN CONFIRMED** — current behavior/topology confirmed by product/domain leadership but not source-verified for the specific statement.
- **CURRENT — LEGACY SOURCE VERIFIED** — observed directly in the audited Traditional Gu production repositories/branches recorded in `legacy-source-audit.md`.
- **CURRENT — LEGACY RISK** — source-verified legacy behavior that is unsafe, ambiguous or too legacy-specific to promote into a Gu OS invariant.
- **TARGET — PRODUCT APPROVED** — behavior/direction approved in the Product PRD, R1 Brief, Roadmap, or S1.
- **RECOMMENDED — ARCHITECTURE** — recommendation of this analysis; not an accepted ADR until reviewed.
- **OPEN — TECHNICAL DESIGN** — architecture/source direction can be chosen, but exact schema/API/migration/adapter/reconciliation mechanics belong later.

The initial Architecture Analysis did not source-audit Traditional Gu. That minimum audit is now captured separately in `legacy-source-audit.md`. This document remains the owner of architecture decisions; the audit owns the source-verified brownfield contracts and risks.

A supplemental April 2026 data catalog supplied by product/domain leadership remains useful domain documentation for the seven currently mirrored BigQuery datasets and selected legacy field semantics. Where that catalog conflicts with current BigQuery Skills/references, the current Skills/references should govern warehouse-query mechanics; where implementation details matter, the source-verified operational code/audit governs.

### 2.1 Naming discipline: domain concept vs operational source vs BigQuery mirror

R1 architecture must not infer physical Mongo/Firebase collection names from BigQuery mirror names.

```text
DOMAIN / BUSINESS CONCEPT
        ↓
OPERATIONAL LEGACY SOURCE
Mongo / Firebase / Traditional Gu service
source-verified operational contract: legacy-source-audit.md
        ↓
BIGQUERY ANALYTICAL MIRROR
*_light dataset/view used for warehouse analytics
```

Examples:

```text
Legacy Lead
→ Traditional Gu operational representations
  source-verified details: legacy-source-audit.md
  external field/reference: lead_id
→ mongo_data.leads_light
```

```text
Legacy User
→ Firebase users
  organization/principal semantics: legacy-source-audit.md
→ firestore_users.users_light
```

The `_light` suffix is a BigQuery mirror naming convention. It must not be treated as an operational Mongo/Firebase collection name or a Gu OS domain-identity concept.

---

## 3. Governing constraints

The following constraints are treated as non-negotiable inputs unless the owning product/doctrine artifact is explicitly revised:

1. A Lead Opportunity is a **commercial Case**, not a Durable Task.
2. Relationship Operations specializes the shared durable-work kernel; it does not introduce its own scheduler, retry engine, evidence store, approval system, or workflow engine.
3. Conversation is an interface/context source, not the sole operational truth.
4. Model judgment handles ambiguity/semantics; deterministic/governed mechanisms enforce authorization, tenant isolation, invariants, idempotency, policy publication and mechanical postconditions.
5. Gu may assume more responsibility without receiving unbounded authority.
6. Business lifecycle dimensions must not be collapsed into generic runtime status.
7. BigQuery remains an analytical plane; R1 live decisions must not depend on an approximately eight-hour warehouse refresh.
8. Organization/multi-seat is a first-class near-term R1 requirement, not a later optional platform feature.
9. Shared Inventory may wake/reconsider an Opportunity but does not itself authorize prospect contact or cross-brokerage data sharing.
10. Internal cost-to-serve is separate from customer pricing/credits/billing.

---

## 4. Current architecture findings

### 4.1 Durable Case kernel is a fit

`operational_cases` already provides:

- durable Case identity;
- generic runtime status;
- `current_step`;
- `assigned_to_user_id`;
- `next_action_at` / `due_at`;
- `context_jsonb`;
- optimistic versioning;
- append-only Case events;
- tenant/user RLS in the current implementation.

**Assessment:** strong fit for Lead Opportunity as the durable root.

**Important limitation:** current ownership/RLS is primarily `user_id`-scoped. That is incompatible with the final R1 multi-seat product semantics if multiple authenticated advisors must safely share organization-owned Opportunities.

### 4.2 Work Plane is already cross-domain

`work_items` and `work_item_attempts` already separate executable work from Case truth and provide:

- durable status;
- capability requirement;
- `not_before` / `due_at`;
- attempts and leases;
- idempotency key;
- input/output/verification contracts;
- result/evidence;
- append-only work events.

**Assessment:** R1 follow-up, reconciliation, coordination and other persistent execution should reuse Work Items.

**Guardrail:** do not pre-generate a rigid future-message queue. Scheduled eligibility should wake reconsideration; the Case-level intelligence/policy decides what work is useful now.

### 4.3 Impact Plane is already the correct truth/evidence base

`case_facts` already supports:

- append-oriented commercial claims;
- source kind/ref;
- confidence;
- explicit supersession;
- immutable correction history.

`case_approvals` already supports evidence-pinned human decisions.

**Assessment:** R1 requirements, viability claims, progression assertions and closure evidence should be modeled through these shared primitives/projections before considering a Relationship-specific evidence structure.

### 4.4 Conversation binding exists, but is not yet suitable for WhatsApp R1

`operational_case_conversation_bindings` currently:
- binds a Case to a conversation;
- supports late replies / clarification / ambiguity;
- is user-scoped;
- restricts channels to `web` and `telegram`;
- uses `chat_id bigint`, which reflects current channel assumptions.

**Assessment:** reuse the concept, not necessarily the current exact shape. R1 needs a generic external-conversation/participant binding capable of representing WhatsApp and future channels without treating WhatsApp identifiers as Telegram-like numeric chat IDs.

### 4.5 Policy seams exist, but admission policy needs a stronger generic contract

The current repo includes `engagement_policy_overrides_jsonb` at user-notification-preference scope, covering cooldowns, escalation and delivery windows.

**Assessment:** useful proof that policy resolution belongs in shared infrastructure, but insufficient as the authoritative R1 **organization admission policy** because:

- it is user-level;
- it is notification/engagement oriented;
- S1 requires organization-owned, versioned, reviewed policy;
- raw natural-language authoring must not become direct runtime authority.

A generic organization policy contract is justified if designed for cross-domain use rather than only Relationship Admission.

### 4.6 Current tenancy model requires deliberate migration

The canonical knowledge-ownership document already says:

- current runtime is mostly `user_id`-scoped;
- target tenant is the organization;
- R1 pulls forward a minimum organization/membership/role bridge;
- legacy `organization_id` is a **legacy organization key**, not permanent Gu OS identity;
- legacy roles are `super-admin`, `admin`, `vendedor`;
- broader team maturity is deferred.

Current kernel migrations confirm user-scoped RLS across Cases, Work Items, Facts and other durable records.

Traditional Gu source audit further confirms that legacy organization/principal semantics have mixed historical representation and must be bridged rather than promoted into canonical Gu OS identity.

**Assessment:** multi-seat cannot be solved by adding an organization table only. Authorization for the R1 shared kernel and projections must become organization-aware.

### 4.7 Existing AI usage ledger is valuable but narrower than R1 economics target

`ai_usage_events` is:

- append-only;
- internal observability, not billing;
- per model call;
- provider/model/token/cost aware;
- price-version aware;
- correlated to Case/Workflow/Work Item/Attempt.

**Assessment:** preserve its semantics and correlation. R1 needs a generic extension for non-AI material resources and cost allocation rather than a Relationship-specific cost table.

### 4.8 Seven mirrored legacy datasets are the current analytical core

The supplemental data catalog identifies seven currently mirrored datasets in BigQuery:

| Domain concept | Operational source | BigQuery mirror | R1 relevance |
|---|---|---|---|
| Legacy Users / Ungga accounts | Firebase | `firestore_users.users_light` | organization/account/advisor identity bridge |
| Gu WhatsApp Numbers | Firebase | `firestore_gu_numbers.gu_numbers_light` | Gu WhatsApp API identity + linked legacy user |
| Properties | Firebase | `firestore_properties.properties_light` | current Ungga inventory representation / source-aware property context |
| Legacy Deals | Firebase | `firestore_deals.deals_light` | property-specific interest context; **not equivalent to Transaction start** |
| Messages | Firebase | `firestore_messages.messages_light` | conversational history / legacy conversation linkage |
| Legacy Leads | Mongo | `mongo_data.leads_light` | prospect/lead analytical mirror; operational Lead/runtime representations and `lead_id` semantics are source-verified in `legacy-source-audit.md` |
| Appointments | Mongo | `mongo_data.appointments_light` | visit-request / appointment analytical evidence; operational persistence/evidence semantics are source-verified in `legacy-source-audit.md` |

There may be additional Mongo/Firebase collections in production. These seven are the currently mirrored analytical core and should be treated as the minimum known legacy data surface, not the exhaustive operational schema.

### 4.9 Prospect / Legacy Lead / Lead Opportunity must remain distinct

```text
Prospect / Contact
= person / external party

Legacy Lead
= Traditional Gu operational record associated with that prospect
  in a specific brokerage / Gu / conversation context

Lead Opportunity
= durable commercial responsibility accepted by Gu OS
```

A Legacy Lead may exist before Gu OS admits a Lead Opportunity. A person may also be represented by more than one Legacy Lead over time or across distinct operational contexts.

The legacy `lead_id` is therefore **not** a canonical Prospect identifier and must not become the canonical Gu OS Opportunity identifier.

Terminology rule for cross-system documents:

- `lead_id` = the complete Legacy Lead identifier;
- `prospect_phone` = first historical component of `lead_id`;
- `gu_phone` / `bot_phone_number` = second historical component;
- `owner_phone` = third historical component;
- avoid the vague phrase **"Lead identity"** when one of these specific concepts is intended.

### 4.10 Legacy Lead / conversation identity encodes operational context

Traditional Gu source audit confirms that the ordinary WhatsApp Lead context historically constructs:

```text
prospect phone
+
Gu WhatsApp API number
+
principal / owner user phone
```

The BigQuery references also document an historical messages path format consistent with this three-part sequence.

Architectural implication:

> The legacy Lead identifier represents an operational relationship/context key, not a pure person identity.

Gu OS should preserve the legacy `lead_id` as an **opaque external identifier** and map it to explicit identities:

- Prospect / Contact;
- Organization;
- Gu WhatsApp API identity;
- legacy principal/account user;
- current assigned advisor/DRI where applicable;
- Lead Opportunity.

Do not make target architecture depend on parsing fixed phone-number lengths from `lead_id`; historical formats and country lengths vary.

### 4.11 Legacy Deal is not the Transaction boundary

Traditional Gu source audit confirms that Legacy Deal is property-specific commercial-interest context and may be created as part of appointment/visit flows.

Therefore:

```text
Legacy Deal
≠ automatically Transaction Case
≠ automatically "transaction started"
```

A Lead Opportunity may accumulate several property-specific Legacy Deals before a concrete transaction exists.

R1 should treat Legacy Deals as **property-interest / commercial-context evidence** until a separate Transaction boundary predicate is satisfied by the relevant domain/source evidence.

---

## 5. Architecture decision map

To avoid ID collisions between the Initiative Brief's architecture queue and S1's local dependency table, this analysis uses **architecture clusters** rather than reusing bare `A1`, `A2`, etc.

S1 local references should be read as `S1-A1`, `S1-A2`, etc.

| Cluster | Covers | Review status |
|---|---|---|
| **AC-1 Operational Access & Eventing** | fresh reads, inbound events, Case wake-up, BigQuery boundary | **Accepted direction** |
| **AC-2 SOR & Cross-System Effects** | fact authority, writes, idempotency, evidence, reconciliation | **Accepted direction** |
| **AC-3 Organization, Membership, Tenancy & Identity** | multi-seat, legacy bridge, RLS, assignment, identity | **Accepted direction** |
| **AC-4 Interaction / Conversation Authority** | Legacy vs Gu OS authority, human takeover, WhatsApp/channel binding | **Accepted direction** |
| **AC-5 Organization Policy Architecture** | admission policy, versioning, authoring vs runtime contract | **Accepted direction** |
| **AC-6 Case Relationships & Lineage** | duplicate, merge, split, supersession, Transaction links | **Accepted direction** |
| **AC-7 Relationship Facts / Progression Projection** | viability, closure, milestones, `current_step` restraint | **Accepted direction** |
| **AC-8 Work Orchestration & Wake-up** | situational work, timers, external events, evidence reconciliation | **Accepted direction** |
| **AC-9 Supervisory Projection & Multi-seat UX** | Work Portfolio / Needs Attention authorization and projection | **Accepted direction** |
| **AC-10 Economic Telemetry** | resource usage, valuation, direct/shared attribution, outcome correlation, billing boundary | **Accepted direction** |

---
# 6. AC-1 — Operational Access & Eventing

> **Review status:** Accepted architecture direction.

## 6.1 Problem

Relationship Operations cannot carry durable commercial responsibility if it only sees delayed analytical copies of operational reality.

R1 needs fresh enough access to determine, when relevant:

- recent prospect messages and conversation context;
- current Legacy Lead/contact ownership and assignment;
- observable advisor intervention;
- current appointment state;
- current property availability/details;
- material inventory changes;
- Legacy Deal / concrete transaction signals where relevant.

BigQuery remains valuable for historical analysis, cohorts, funnels, evaluation and economics, but its delayed mirror is not the live operational authority for R1 decisions.

## 6.2 Access alternatives

### Option A — Continue using BigQuery for R1 runtime

**Rejected.**

It creates an architectural mismatch between live relationship responsibility and delayed warehouse state.

### Option B — Give the model generic Mongo/Firestore access

**Rejected.**

It leaks physical storage semantics into the model layer, expands authority excessively and makes migration/provider changes expensive.

### Option C — Bounded operational gateway / domain capabilities

**Accepted direction.**

```text
Gu OS
  → bounded business/domain capability
  → legacy operational gateway / integration adapter
  → current authoritative operational source
```

Candidate capability classes include:

- `legacy_lead_get_context`
- `legacy_lead_get_recent_messages`
- `contact_identity_lookup`
- `property_search_current_inventory`
- `property_get_details`
- `legacy_deal_get_context`
- `appointment_get`
- later governed appointment/write capabilities
- normalized source-event ingestion/retrieval

These are semantic capability labels, not claims about physical Mongo/Firebase collection names.

The capability boundary should hide whether a given implementation uses an existing Traditional Gu service/API, a narrowly scoped direct Mongo/Firebase adapter, a CRM API, or a provider.

## 6.3 Event, fact, wake-up and action are different concepts

R1 must not collapse:

```text
source event
    ≠ accepted business fact
    ≠ Case wake-up
    ≠ action
```

A source event is evidence that something happened in an external system. Domain interpretation and evidence rules determine whether it establishes or changes Case truth. A wake-up means the Case should be reconsidered. The reconsideration may produce zero, one or multiple Work Items.

Example:

```text
prospect message arrives
        ↓
authenticated + normalized source event
        ↓
Opportunity wakes
        ↓
Gu interprets current evidence/context
        ↓
accepted/superseding Case facts if warranted
        ↓
0..n bounded Work Items
```

A new event does **not** itself mandate an outbound message.

## 6.4 Hybrid event-driven + scheduled reconsideration

Use both:

```text
external source event
        ↓
authenticate + normalize + deduplicate
        ↓
resolve Organization / external identities / relevant Opportunity
        ↓
preserve provenance
        ↓
wake/reconsider Case
```

and:

```text
next_action_at / Work not_before
        ↓
deterministic due scanner
        ↓
wake/reconsider Case
```

Timers and events are both **reasons to reconsider**, not instructions to act.

Priority R1 event classes are:

- new prospect messages;
- observable advisor/human activity or takeover;
- appointment creation/status changes/visit evidence;
- material inventory changes relevant to active Opportunities;
- assignment changes;
- necessary Legacy Deal / concrete transaction signals.

Do not integrate every legacy event merely because it exists.

## 6.5 Freshness and authoritative reread

Events should carry enough identity, provenance and change context to route/reconsider work. When correctness or freshness matters and the event itself is not sufficient evidence, consequential decisions should re-read the current authoritative operational state through the bounded capability layer before acting.

A property-change event, for example, may be a wake signal followed by `property_get_details`; a provider message payload with a stable message ID may itself be primary evidence.

Compiled decision context must preserve the difference between:

- fresh operational reads;
- accepted Case facts with provenance;
- historical/analytical BigQuery data.

## 6.6 Idempotency, coalescing and concurrency

Inbound event processing must be authenticated, provenance-preserving and idempotently deduplicated.

Multiple source retries must not become multiple logical business events.

Multiple wake signals for the same Opportunity must not produce concurrent conflicting Case decisions. The implementation should support serialization/coalescing at the Case boundary using shared-kernel concurrency primitives rather than spawning independent competing supervisors.

## 6.7 Transport is not predetermined

"Event-driven" is an architectural contract, not a mandate to introduce Kafka, Pub/Sub or another streaming platform.

A source adapter may initially use authenticated webhooks, callbacks, a durable inbox, narrowly scoped polling, database triggers or a queue. Polling is acceptable when a source lacks events, but it remains encapsulated inside the integration boundary and emits the same normalized wake-up semantics.

## 6.8 Accepted decision

> **R1 uses bounded fresh operational capabilities plus normalized, authenticated and idempotent event ingestion. BigQuery remains analytical. Source events and timers trigger Case reconsideration rather than directly commanding actions; accepted business facts remain evidence-governed; consequential decisions reread fresh authority when required; and concurrent wake signals must not create conflicting Case decisions.**

### Legacy source audit — completed

The minimum Traditional Gu production-source audit required before Technical Planning is complete and recorded in `legacy-source-audit.md`. It source-verifies Legacy Lead identity/context, WhatsApp ingress/provider IDs, human takeover/resumption, appointment/visit evidence, property source/search roles, assignment, Legacy Deal semantics and outbound provider correlation.

Remaining work in these areas is **Technical Design / adapter implementation / implementation-time revalidation**, not an open architecture source-audit gate.

---
# 7. AC-2 — Fact-level Source of Record & Cross-System Effects

> **Review status:** Accepted architecture direction.

## 7.1 Principle: authority belongs to facts and responsibilities

R1 uses **fact-level authority**, not "one database is the master of everything."

Recommended initial ownership matrix:

| Fact / responsibility | Initial authority |
|---|---|
| Prospect/contact operational identity + Legacy Lead operational record | Traditional Gu / current operational source, bridged into Gu OS |
| Message source/delivery history | Channel/provider + Traditional Gu operational source |
| Gu WhatsApp API identity/configuration | Traditional Gu / current operational configuration |
| **Lead Opportunity identity and durable lifecycle** | **Gu OS** |
| Gu-accepted objective/requirements/viability claims | **Gu OS Case facts**, with evidence provenance |
| Organization admission/engagement policy | **Gu OS** |
| Property fields | Source-aware: upstream CRM where authoritative; Ungga operational source for native/current representation |
| Appointment external record | Traditional Gu / current appointment source |
| Visit progression interpretation | **Gu OS**, evidence-backed |
| Legacy Deal record | Traditional Gu operational source; property-specific interest context, not automatically Transaction start |
| Concrete transaction process | Current transaction domain/source until Transaction Operations changes the contract |
| Runtime/conversation authority | **Gu OS governance/migration contract**, enforced across execution paths |
| Internal resource cost-to-serve | Gu OS observability plane |
| Customer credits/wallet/billing | Existing billing/credit system until explicitly migrated |

Legacy records can support Gu OS Case facts without becoming those Case facts automatically.

## 7.2 Evidence → interpretation → accepted Case truth

Conceptually:

```text
source evidence
      ↓
semantic interpretation
      ↓
candidate business assertion
      ↓
authority / admissibility / confidence / confirmation rules
      ↓
accepted or superseding Case fact
```

The model may interpret evidence; interpretation alone does not grant authority.

`case_facts` should preserve provenance and supersession rather than silently mutating earlier assertions.

## 7.3 Property and Legacy Deal are source-aware

Property authority must preserve provenance rather than flatten every field into "Firebase is master." Imported CRM fields may remain authoritative upstream while native Ungga fields are authoritative in Ungga's operational representation.

Likewise:

```text
Legacy Deal exists
    ≠ Transaction Case exists
    ≠ transaction started
```

A Legacy Deal is evidence of property-specific commercial interest until the Transaction domain's separate boundary predicate is satisfied.

The legacy source audit also confirms that Firestore is the original/current Ungga property record while Mongo `property_data` and Qdrant act as serving/search layers, and that Legacy Deal may be created by an appointment/visit flow before a Transaction boundary exists.

## 7.4 Cross-system effect pattern

Do not attempt distributed ACID across Gu OS + Traditional Gu + Mongo/Firebase + CRM/provider.

Use bounded Work-backed commands:

```text
Case decides allowed work
       ↓
Work Item
       ↓
deterministic authority/policy/freshness gate
       ↓
bounded external command
       ↓
legacy/provider effect
       ↓
observe evidence/postcondition
       ↓
record Attempt/result/evidence
       ↓
if uncertain → reconciliation
```

A model must not perform raw multi-system writes or infer success merely because an API call returned without error.

## 7.5 Idempotency and unknown outcomes

Material external effects require a logical idempotency strategy where the integration allows it.

A timeout is not proof of failure:

```text
confirmed success
confirmed failure
unknown outcome
```

are distinct.

For unknown outcomes, reconcile against provider/legacy state before repeating an effect that could duplicate a message, appointment, cancellation, reschedule or other consequential write.

The source audit reinforces this with two concrete brownfield examples:

- appointment creation may partially succeed across Firestore/Mongo/Google Calendar;
- WhatsApp HTTP acceptance/queue acceptance/provider `wamid` and later failure callbacks are separate states.
Reuse existing Work Item / Attempt / evidence primitives first. Do not introduce a Relationship-specific external-effects ledger unless a shared missing contract is demonstrated.

## 7.6 Selective writeback, not generic mirroring

A Gu OS Case fact does not imply that every similarly named legacy field must be updated.

Cross-system writeback must be explicit and purpose-bound:

- Gu OS-owned truth may require no legacy writeback;
- a legacy field may remain authoritative and be read by Gu OS;
- a temporary compatibility projection/writeback may be necessary while legacy functionality still consumes that field.

When a compatibility writeback exists, document which side is authority and which side is projection. Do not create implicit dual masters or generic bidirectional synchronization.

## 7.7 Conflict resolution

Cross-system conflicts resolve by **fact-specific authority + provenance + evidence**, not by generic database precedence or last-write-wins.

A newer explicit prospect statement may supersede an earlier interpretation; a stale analytical mirror must not override fresher operational evidence merely because of ingestion timestamps; an authorized human correction may have different authority than a model inference.

## 7.8 External effects must revalidate current authority

Immediately before a consequential prospect-facing effect, execution must revalidate the applicable runtime authority, conversation authority, delivery policy and materially relevant fresh state.

A Work Item that was valid when proposed may become blocked, cancelled or require reconsideration if human takeover or another relevant fact changes before execution.

## 7.9 Accepted decision

> **Gu OS uses fact-level authority. It owns Lead Opportunity durable responsibility and interpreted Case truth while legacy/current systems retain selected operational records. External effects use bounded Work-backed commands with authority revalidation, idempotency where possible, evidence/postcondition verification and reconciliation for unknown/partial outcomes. Cross-system writeback is selective and explicitly owned; R1 does not attempt distributed ACID, generic bidirectional mirroring or last-write-wins conflict resolution.**

---
# 8. AC-3 — Organization, Membership, Tenancy & Identity

> **Review status:** Accepted architecture direction. ADR-106 accepted; ADR-101 superseded.

## 8.1 Why ADR-101 is superseded

ADR-101 correctly anticipated:

- organization as target isolation boundary;
- user as runtime identity;
- separation of membership/role/team/assignment/DRI;
- platform-staff authority distinct from brokerage roles.

Its stated reevaluation trigger — multi-seat brokerage collaboration becoming a near-term product requirement — occurred.

Its legacy bridge was also no longer precise enough. Product/domain knowledge and the completed source audit show that:

- legacy `organization_id` is a **legacy organization/principal bridge**, not a canonical Gu OS Organization ID;
- its historical representation is mixed (including DocumentReference/string-like forms);
- `org_name` is display data, not identity;
- `super-admin`, `admin` and `vendedor` are legacy membership/role semantics;
- some legacy custom claims are not reliable enough to become Gu OS authorization directly;
- the principal/Gu owner is not necessarily the Opportunity's assigned advisor/DRI;
- R1 requires individual authenticated advisor seats with organization-appropriate visibility, assignment and authority.

ADR-101 remains in history with status **Superseded** and ADR-106 owns the current direction.

## 8.2 Target conceptual model

```text
Organization
  ├─ Membership(s)
  │    ├─ authenticated user
  │    ├─ role / permission grants
  │    └─ status
  │
  ├─ External identity mappings
  │    ├─ legacy organization key
  │    ├─ legacy user document_id / Firebase UID
  │    ├─ Gu/channel identifiers
  │    └─ source/provider identifiers
  │
  ├─ Organization policy
  └─ organization-owned durable work
       ├─ Lead Opportunity Cases
       ├─ Work Items
       ├─ Case facts / approvals
       └─ supervisory projections
```

Keep these concepts distinct:

- **organization** = tenant/business owner;
- **user** = authenticated human actor;
- **membership** = user belongs to organization;
- **role/grant** = authorization;
- **assignment** = who currently carries work/responsibility for an Opportunity;
- **DRI** = human accountable for a defined outcome;
- **approver** = authority for a particular protected decision;
- **contact endpoint** = phone/WhatsApp/email route;
- **platform admin** = Ungga staff authority;
- **Prospect / Contact** = external person/party;
- **Legacy Lead** = Traditional Gu operational record/context;
- **Legacy Lead ID** = opaque external record ID; ordinary WhatsApp flow historically concatenates `prospect_phone + gu_phone + owner_phone`;
- **Gu WhatsApp API identity** = Gu's connected business/API number (`bot_phone_number` in the legacy request contract);
- **principal legacy user / Gu owner** = legacy account context, not necessarily the assigned advisor or DRI.

## 8.3 Legacy role bridge is transitional

Conceptually:

```text
legacy organization key (`organization_id`)
    → Gu OS organization external-identity mapping

legacy `super-admin`
    → migration input for principal owner/admin membership

legacy `admin`
    → migration input for organization-admin membership

legacy `vendedor`
    → migration input for advisor/sales membership
```

These are bridge semantics, not the permanent Gu OS authorization vocabulary.

`profiles.is_ungga_admin` remains separate platform-staff authority and must never be inferred from brokerage roles.

The source audit specifically warns against treating legacy Firebase custom claims as sufficient Gu OS authorization.

## 8.4 Organization ownership ≠ assignment

Lead Opportunities are organization-owned durable responsibilities.

Reassigning an Opportunity from one advisor to another must not change its tenant/business owner.

```text
Organization owns Opportunity
        ↓
Advisor is assigned
        ↓
DRI / approver may be separate relationships
```

The principal/super-admin phone embedded in historical `lead_id` context must not be assumed to be the assigned advisor/DRI.

Traditional Gu's source-verified sticky assignment behavior further confirms that organization/principal context and current advisor assignment are separate dimensions.

## 8.5 External identity mapping is first-class

Gu OS canonical IDs must remain independent of legacy/provider IDs.

Conceptually Gu OS needs source-scoped mappings such as:

```text
Gu OS Organization ↔ legacy organization key
Gu OS User/Membership ↔ legacy Firebase UID / user document_id
Gu OS Contact ↔ one or more Legacy Lead records / channel identities
Gu WhatsApp channel identity ↔ legacy Gu number
Lead Opportunity ↔ relevant Legacy Lead external reference(s)
```

Do not make `contact.id`, `opportunity.id` or canonical `organization.id` equal to legacy `lead_id`, `document_id`, `organization_id`, phone numbers or provider IDs.

The exact mapping schema is Technical Design work.

## 8.6 Migration approach

### Option A — keep `user_id` as tenant and add sharing exceptions

**Rejected as target.**

It preserves the wrong ownership model and makes authorization increasingly exception-driven.

### Option B — big-bang replace every current `user_id` tenancy assumption

**Rejected.**

Too broad and risky for brownfield R1.

### Option C — first-class organization + staged dual-scope migration

**Accepted direction.**

- introduce canonical Gu OS Organization identity;
- bridge legacy org/user/channel IDs explicitly;
- make organization the target ownership/isolation dimension;
- retain existing `user_id` fields where needed for current actor/provenance/backward compatibility;
- do **not** silently reinterpret an existing tenancy `user_id` column as actor identity;
- make R1 Case/Work/Fact/Approval/Work Portfolio paths organization-aware first;
- add explicit cross-tenant denial verification;
- expand broader org-owned assets/Brain/workflows/skills only when product increments require them.

## 8.7 Multi-organization compatibility

R1 need not expose multi-organization UX in the first pilot, but the conceptual Membership model should permit a user to belong to multiple organizations with an explicit active organization context rather than making one-user-one-organization a permanent invariant.

## 8.8 Accepted decision

> **Organization becomes the canonical target tenant/business owner for R1 organization-owned work. User is the authenticated actor/member. Membership, role, assignment, DRI, approver and routing remain separate concepts. Legacy organization/user/Lead/channel identifiers are bridged as source-scoped external identities rather than promoted into Gu OS canonical IDs. Migration is staged, organization-aware and brownfield-safe, not a big-bang rewrite.**

---
# 9. AC-4 — Interaction, Runtime and Conversation Authority

> **Review status:** Accepted architecture direction. ADR-107 accepted.

## 9.1 Four authority concepts must stay separate

R1 distinguishes:

1. **Durable responsibility** — does the Lead Opportunity exist and remain Gu OS responsibility?
2. **Runtime decision authority** — which system may autonomously decide relationship work for the governed scope: Traditional Gu or Gu OS?
3. **Conversation authority** — who currently has the conversational lead in a specific thread/channel: Gu or a human?
4. **Business approval authority** — who may approve a protected/consequential business decision?

These dimensions can differ at the same time.

## 9.2 Brownfield runtime authority

During migration:

```text
runtime authority = LEGACY | GU_OS
```

is a conceptual authority state, not a transport selector.

If `runtime authority = GU_OS`, Gu OS may decide the work while Traditional Gu still executes a bounded transport/service call such as sending WhatsApp.

```text
decision authority = GU_OS
transport/execution adapter = Traditional Gu
```

Case existence does not transfer runtime authority. A shadow Case may observe and simulate while Legacy remains authoritative.

For the **same governed scope of autonomous relationship work**, Legacy and Gu OS must not independently decide prospect-facing actions concurrently.

If conflicting autonomous authority is detected, fail safe: suppress the new external effect, surface/reconcile the authority conflict, and avoid competing messages.

## 9.3 Human same-thread takeover

Observable advisor intervention may transition conversation authority:

```text
conversation authority = gu
        ↓ advisor intervenes
conversation authority = human_active
```

When `human_active` applies:

- Gu stops speaking in that governed conversation;
- Gu OS may continue observing, updating facts, reasoning, monitoring and preparing non-conflicting work;
- durable Case responsibility does not automatically pause;
- runtime authority does not automatically revert to Legacy;
- unrelated/non-conversational work need not stop unless policy requires it.

**Pause speaking ≠ pause thinking ≠ pause the Case.**

Traditional Gu source audit confirms the current implementation uses `bypass_bot` + `last_owner_interaction_wba` and a later scheduled reconsideration after more than five minutes of no newer observed owner interaction. That timeout is a legacy implementation/UX policy, **not** an architecture invariant. Gu OS resumption remains governed, observable and policy/explicit-signal based.

## 9.4 Off-thread / cross-channel human activity

An advisor may contact a prospect from a personal WhatsApp number, telephone call or another channel that R1 cannot observe.

Therefore:

- observed same-thread activity can deterministically change conversation authority;
- unobserved human activity is an evidence gap;
- absence of an observed advisor message does not prove no human interaction occurred;
- future advisor input/integrations/reconciliation can reduce the gap.

R1 must not claim omniscience.

## 9.5 Pre-effect authority revalidation

Prospect-facing external effects must deterministically revalidate immediately before execution:

- current runtime decision authority;
- current conversation authority;
- applicable delivery/engagement policy;
- any materially relevant fresh state required by the capability.

This protects against race conditions where Gu proposed a message immediately before a human took over.

## 9.6 Existing outbound WhatsApp execution seam

**CURRENT — LEGACY SOURCE VERIFIED:** Traditional Gu exposes outbound WhatsApp execution paths that can be reused/wrapped during brownfield migration. The demonstrated contracts include prospect/channel identifiers and the legacy `lead_id` context, and the audited worker/provider path exposes WhatsApp provider correlation (`wamid`) plus later failure callbacks.

Historical legacy semantics:

```text
lead_id = prospect_phone + gu_phone + owner_phone
```

`lead_id` remains an opaque external Legacy Lead/context reference in Gu OS. Do not make target architecture depend on parsing fixed phone-number lengths.

The preferred brownfield shape is:

```text
Gu OS decides useful work
        ↓
authority + delivery policy
        ↓
bounded `send_prospect_message`-style capability
        ↓
resolve authorized legacy/channel references
        ↓
Traditional Gu adapter / existing or wrapped endpoint
        ↓
WhatsApp
```

The model should not receive unrestricted authority to construct raw endpoint tuples or issue generic HTTP calls.

The source audit confirms usable provider `wamid` correlation and later failure callbacks, but not an end-to-end idempotent Gu OS command contract. It also confirms that HTTP/provider acceptance is not always equivalent to final delivery. The Gu OS wrapper must therefore add operation correlation, authority/tenant revalidation, idempotency strategy and reconciliation for failed/unknown outcomes.

If a selected route lacks required guarantees, wrap/extend it behind a stable bounded capability rather than rebuilding WhatsApp transport merely for R1.

## 9.7 Generic conversation binding

The existing conversation-to-Case binding concept should be generalized for external channels rather than replaced by a Relationship-only WhatsApp table.

Conceptually support:

- Organization;
- Case;
- channel/provider;
- opaque external conversation reference;
- participant/contact identity;
- Gu channel identity;
- optional advisor/contact endpoint mapping;
- ambiguity/status resolution;
- provenance.

Legacy `lead_id` may be one external reference/mapping; it is not the Gu OS conversation identity.

Conversation authority may reference the binding but should not be collapsed into it if authority requires different lifecycle/audit semantics.

## 9.8 UX consequence

Internal authority state may be rich, but users should see the practical result rather than low-level switches, for example:

- "Carlos is handling this conversation. Gu is monitoring the Opportunity."
- "Gu active."
- an explicit governed "Resume Gu" control where supported.

## 9.9 Accepted decision

> **Durable responsibility, runtime decision authority, conversation authority and business approval authority are separate. `LEGACY | GU_OS` identifies autonomous decision authority, not transport. Case existence does not transfer authority; Legacy and Gu OS must not independently decide the same governed prospect-facing work concurrently. Human takeover suppresses Gu speaking without automatically pausing the Case. Prospect-facing effects revalidate current authority immediately before execution. External conversation binding is generic and source-referenced; the existing Traditional Gu outbound WhatsApp capability is the preferred initial transport seam when wrapped to satisfy the required authorization, idempotency, evidence and reconciliation guarantees.**

---
# 10. AC-5 — Organization Policy Architecture

> **Review status:** Accepted architecture direction. ADR-108 accepted.

## 10.1 Product requirement and boundary

S1 approves the governing sequence:

```text
platform hard bounds
        ↓
organization policy
        ↓
Gu contextual judgment
```

The organization decides, within non-overridable platform/security/privacy bounds, when Gu may or should assume responsibility and how configured behavior should operate. Model confidence alone never grants authority.

Policy must remain distinct from other Gu OS artifacts:

| Artifact | Primary question |
|---|---|
| **Platform hard bound** | What may never be weakened by a tenant? |
| **Organization Policy** | What does this organization permit, require or constrain within platform bounds? |
| **Workflow** | What durable procedural guarantees govern this work? |
| **Skill / model judgment** | What does this concrete situation mean and what work appears appropriate? |
| **Knowledge / Brain** | What does the organization/system know? |
| **Prompt/context** | What relevant information is compiled for this decision? |

> **Knowledge informs. Policy authorizes/constrains. Workflow guarantees process. Model judgment interprets.**

Do not use Brain pages, prompt prose or workflow definitions as the sole runtime authorization mechanism for organization policy.

## 10.2 Generic primitive, domain-specific policy semantics

R1 should introduce a **generic versioned organization-policy capability/contract**, while keeping individual policy purposes typed and domain-specific.

Conceptually:

```text
Organization
   ├─ relationship admission policy
   ├─ relationship engagement / escalation policy
   ├─ future property-operation policy
   ├─ future transaction policy
   └─ other typed policy purposes
```

Exact policy type names are not fixed here.

Do **not** create one unbounded "organization policy JSON" that accumulates every business rule, and do not create a Relationship-only infrastructure primitive if the same lifecycle/versioning/authorization contract is cross-domain.

## 10.3 Authoring plane ≠ runtime plane

Policy authoring should support:

```text
natural-language intent
      ↓
model-assisted interpretation
      ↓
structured policy proposal
      +
human-readable explanation / examples / edge cases
      ↓
deterministic validation
      ↓
authorized human review
      ↓
publish immutable version
```

The original natural-language intent should be retained as provenance, but **raw prose is not runtime authority**.

At runtime:

```text
current situation
      ↓
semantic interpretation where required
      ↓
published structured policy resolution
      ↓
allowed / blocked / required / approval-needed / other typed result
```

The runtime must not repeatedly ask a model to reinterpret what a manager "probably meant" from free-form policy prose.

## 10.4 Structured policy does not eliminate model judgment

Do not attempt to encode all commercial semantics as a deterministic DSL.

Preferred boundary:

```text
model / Skill
interprets ambiguous business meaning
        ↓
structured semantic result + evidence refs
        ↓
deterministic/governed policy resolver
applies the published organization's constraints
```

Example: the model may judge whether a genuine commercial objective is present; the policy resolver determines whether, given that judgment and the active published policy, autonomous admission is allowed/expected.

> **The policy deterministically constrains authority without requiring every business predicate to be deterministic.**

## 10.5 Versioning, publication and audit

Published policy versions are immutable.

Conceptually:

```text
v1 published
v2 draft
v2 validated
v2 published
```

Drafts do not affect production behavior.

Each consequential policy-governed decision/effect must record or be able to reconstruct:

- organization;
- policy purpose/type;
- effective published version;
- relevant rule/path;
- semantic input/evidence references where applicable;
- result;
- actor/service that evaluated or published it.

This makes questions such as "why did Gu admit/contact/escalate this Opportunity?" auditable.

Publication requires an authorized Organization Membership/role/grant; model-generated drafts or advisor suggestions do not self-publish.

## 10.6 Effective version and Case lifetime

Do **not** automatically pin every Organization Policy to a Case for the Case's entire lifetime.

Workflow-definition pinning and policy resolution solve different problems.

Historical decisions retain the policy version that governed them, but newly published organization policy normally governs future decisions from its effective point.

If a policy type needs retroactive reassessment of existing Cases, that behavior must be explicit and governed; publishing a new version must not silently rewrite historical Case truth.

## 10.7 Missing/invalid policy is not broader authority

Missing, invalid or unresolved organization policy must never be interpreted as permission to exercise broader autonomy.

The exact product behavior may be a safe platform baseline, onboarding-required policy, no autonomous action for that policy purpose, or another explicitly defined fail-safe default.

Exact fallback semantics belong to Product/Technical Plan per policy type, but the architecture is **fail-closed with respect to additional authority**.

## 10.8 Relationship to existing engagement preferences

Existing user-level engagement/notification overrides may coexist with Organization Policy.

A narrower/user preference may further restrict behavior or override a higher-level policy only where the higher-level contract explicitly permits that override.

Do not encode a universal precedence rule such as `user > organization`; provenance and policy-specific override authority govern resolution.

## 10.9 Policy examples as verification evidence

Model-assisted authoring should be able to produce examples such as SHOULD allow/admit, SHOULD block/not admit, NEEDS semantic judgment, and boundary/edge cases.

These examples are verification artifacts for the policy intent, not necessarily the runtime policy itself.

The lifecycle should permit simulation/replay against historical or synthetic Cases before publication, even if sophisticated replay is not required for initial R1.

## 10.10 Policy is not Case truth

Organization Policy is organization-owned configuration/authority. Case facts describe the specific Opportunity.

Do not clone policy text/rules into every Case as source of truth. Instead, persist the policy version/reference used by policy-governed decisions where auditability requires it.

Likewise, prompts may include a compact relevant policy representation for reasoning, but prompt content is not enforcement authority.

## 10.11 Accepted decision

> **Gu OS adopts a generic, organization-owned, typed and versioned policy contract. Natural language is an authoring interface, not runtime authority. Published versions are immutable and explicitly authorized; model judgment may provide structured semantic interpretations, while governed/deterministic mechanisms enforce policy constraints. Consequential decisions remain attributable to the effective policy version. New policy versions govern future decisions without silently rewriting history, and missing/invalid policy never broadens authority.**

---
# 11. AC-6 — Case Relationships & Lineage

> **Review status:** Accepted architecture direction. The full-repo audit is complete and found no adequate first-class generic Case↔Case relationship/lineage primitive; ADR-109 establishes the shared cross-domain contract. Exact persistence/API mechanics remain Technical Design.

## 11.1 Product need

S1 requires traceable:

- duplicate;
- merge;
- split;
- supersession;
- reactivation history;
- Lead Opportunity ↔ Transaction relationship.

The full-repo audit established that the current Gu OS repository has no adequate first-class generic Case-to-Case relationship/lineage primitive.

## 11.2 Lineage is not generic association

AC-6 distinguishes two different ideas:

1. **Lineage / lifecycle relationship** — a relationship that explains how durable Cases came to exist, changed identity/continuity, or replaced/contributed to one another. Examples include duplicate, merge, split and supersession.
2. **Business association** — two Cases are related in the business domain without one being the historical successor/predecessor of the other. Lead Opportunity ↔ Transaction is the clearest R1 example.

Do not collapse these semantics into an unbounded generic `related_to` edge. Relationship types should remain few, typed, directed where direction matters, and governed by explicit semantics.

## 11.3 Alternatives

### Option A — encode relationships in `context_jsonb`

**Rejected** for durable canonical lineage.

It is hard to query, validate, authorize, constrain and reuse cross-domain, and it makes historical identity semantics dependent on mutable Case context.

### Option B — Relationship-specific merge/split table

**Rejected.**

Property, Transaction and other domains can also need Case lineage/relationships. R1 should not create a private lineage subsystem for convenience.

### Option C — generic Case relationship primitive

**Accepted direction through ADR-109.**

The target contract supports a deliberately small governed vocabulary/registry of typed relationships, with exact representation left to Technical Design.

## 11.4 Continuity semantics

### Reactivation

Reactivation normally continues the **same Case**. A Case that becomes dormant, lost, paused or otherwise inactive should not acquire a new identity merely because work resumes. A new Case plus lineage link is justified only when the owning product semantics establish a genuinely new durable commercial responsibility.

### Merge

A merge must preserve historical identities and provenance. It must not erase source Cases or pretend their earlier facts, Work, approvals, conversations or external bindings were always owned by the surviving Case. Exact reconciliation/data-movement rules belong to Technical Plan and the owning Specs.

### Split

A split creates distinct durable responsibility while preserving the source Case and the provenance of what motivated or seeded each resulting Case. Facts, Work and bindings are not implicitly copied wholesale; transfer/derivation must follow explicit semantics.

### Supersession and duplicate

Duplicate and supersession are durable business facts/relationships, not destructive rewrites. Completion/closure projections may use them, but history remains reconstructable.

## 11.5 Authority, evidence and organizational boundary

Creating or mutating a lineage relationship can alter which Case humans and Gu treat as authoritative. Therefore:

- lineage mutations require authorized execution, not free-form model state mutation;
- the reason/evidence/provenance for consequential relationships must be retained or reconstructable;
- model/Skill judgment may identify or propose a relationship, but governed mechanisms validate and persist it;
- relationships are organization-contained by default; cross-organization Case linkage is not implied by this primitive and requires a separately governed product requirement;
- merge/split/supersession must not silently transfer runtime, conversation or business-approval authority; ADR-107 boundaries still apply.

## 11.6 Opportunity ↔ Transaction does not imply closure

A Lead Opportunity may be associated with one or more downstream Transaction Cases when the Transaction boundary predicate is satisfied. That association does **not**, by itself, mean the Opportunity is complete, lost or superseded. Closure remains an evidence-backed business projection governed by the Relationship lifecycle contract.

This preserves the distinction already established in §4.11: a Legacy Deal is not automatically a Transaction Case, and a Transaction relationship is not automatically a Relationship closure event.

## 11.7 Accepted decision

> **Gu OS adopts generic, governed Case relationship semantics for durable lineage and typed cross-Case business association. The shared primitive is governed by ADR-109 rather than a Relationship-specific table. Keep the relationship vocabulary small and typed; preserve Case history and provenance across merge/split/supersession; treat reactivation as same-Case continuity by default; require authority/evidence for consequential mutations; keep relationships organization-contained by default; and do not infer Opportunity closure from a Transaction association alone.**

Exact persistence/API shape remains Technical Design.

---

# 12. AC-7 — Relationship Facts, Progression and `current_step`

**Accepted direction.**

## 12.1 Truth model: evidence/facts → business projection

Relationship Operations should not collapse commercial truth into one mutable CRM-style stage. The preferred conceptual shape is:

```text
observable occurrence / source evidence
(message, appointment, prospect statement, advisor correction, transaction event, ...)
                ↓
      provenance-backed Case facts
                ↓
       derived business projection
                ├─ objective / requirements
                ├─ durable responsibility
                ├─ commercial viability
                ├─ delivery / engagement eligibility
                ├─ progression / milestone history
                ├─ closure outcome / reason
                └─ accepted evidence / uncertainty
```

The projection is the current operational interpretation of accumulated evidence; it is not a replacement source of truth that erases provenance. It may later be materialized/denormalized for supervision/query performance, but the underlying semantics should remain evidence-backed, attributable and reconstructable.

Facts, events and projections must remain conceptually distinct. A source event may supply evidence; accepted evidence may become a Case fact; one or more facts may support a current business projection. Technical Design may choose exact storage/materialization mechanics without changing that semantic boundary.

## 12.2 Business dimensions remain separate

R1 must preserve the S1 separation between at least:

- durable commercial responsibility;
- commercial viability;
- progression;
- delivery / engagement eligibility;
- closure outcome; and
- generic runtime status.

No single CRM-style `stage` or enum should become the authoritative answer to all of these questions. For example, a commercially viable Opportunity may be temporarily non-contactable while its runtime remains wakeable; a commercially lost Opportunity may complete successfully at the runtime level rather than `failed`.

## 12.3 Progression is evidence-backed, non-linear and potentially repeating
Progression milestones such as:

- `opportunity_admitted`;
- `meaningful_interaction`;
- `visit_requested`;
- `visit_scheduled`;
- `visit_attended`;
- `transaction_started`;

should be treated as evidence-backed commercial milestones/history, not necessarily as mutually exclusive values of one monotonic scalar.

An Opportunity may have multiple visit requests/visits, cancellations/reschedules, changed requirements, return to matching, more than one transaction attempt, or a failed Transaction followed by renewed Relationship progression. The projection should therefore preserve the commercially relevant history/current interpretation rather than pretending that the Opportunity occupies exactly one irreversible funnel stage.

Property matching by itself remains an actionable input, not proof of commercial progression.

The source audit adds a useful evidence constraint: appointment creation/confirmation does not prove attendance. Explicit post-visit evidence such as `property_was_visited = Afirmativo | Negativo` is a stronger attendance source, while absence remains unknown.

## 12.4 `current_step` restraint

Relationship Operations is not naturally a linear procedure like Property Optioning.

R1 should **not require `current_step` as a CRM stage/funnel or as a UI convenience field**.

`current_step` may remain null or be used only if a genuine procedural execution state later emerges that:

- materially governs allowed work or readiness;
- represents a durable procedural condition rather than a business projection;
- is mutually understandable across runtime/operations; and
- provides value to workflow guards or execution semantics that cannot be represented more cleanly by facts, Work state or policy.

A progression milestone such as `visit_attended` does not, by itself, imply a mandatory next procedural step and therefore should not be forced into `current_step`.

## 12.5 Closure remains business truth, not runtime status

S1-approved top-level closure outcomes remain:

- `objective_achieved`;
- `lost`;
- `invalid`;
- `duplicate`;
- `superseded`;

with separate closure reason and supporting evidence.

These are business facts/projections used by completion predicates and supervisory views, not new values of `operational_cases.status`. Inactivity, coldness, temporary waiting or lack of response do not themselves establish closure. Business `lost` is not runtime `failed`; runtime `failed` remains a technical/execution condition.

## 12.6 Accepted decision

> **Relationship Operations represents current commercial truth through provenance-backed Case Facts and derived business projections rather than a CRM-style stage machine. Commercial viability, progression, delivery/engagement eligibility, durable responsibility and closure remain distinct from generic Case runtime status. Progression is evidence-backed and potentially non-linear/repeating rather than a single monotonic scalar. `current_step` is not required for R1 and should be used only if a genuine procedural execution state emerges that materially governs allowed work or readiness—not to represent CRM progression or simplify UI. Closure outcome/reason/evidence remain business truth used by completion predicates, while `operational_cases.status` retains generic runtime semantics.**

---

# 13. AC-8 — Work Orchestration & Wake-up

> **Review status:** Accepted architecture direction.

## 13.1 Case Supervisor concept

R1 needs an agentic/runtime role that, for one Opportunity, can decide:

- what changed?
- does anything need to happen now?
- what work is useful?
- can Gu act?
- should a human be involved?
- when should the Case be reconsidered?

This is the **Case Supervisor** concept, not necessarily a new service/process/table. The shared Case runner + root Skill/workflow policy may provide the initial implementation surface, while a more general Case Supervisor remains an evolution target.

The Supervisor reasons about **how best to advance the durable objective now**. It does not become the source of authority for the objective, permissions, invariants, business approvals, evidence requirements or completion semantics.

## 13.2 Wake-up means situational reconsideration

A scheduled or event-driven Case wake-up should normally mean **reconsider the current situation**, not blindly execute a future action that was chosen from stale context.

```text
external event / scheduled wake-up / human intervention / changed fact
        ↓
compile current Case contract + current facts + fresh source context + policy
        ↓
Case Supervisor / model-Skill judgment
        ↓
0..n bounded proposed actions / waits / human requests
        ↓
deterministic authority, policy, invariant and verification checks
        ↓
inline bounded execution and/or durable Work Items
```

A source event or timer does not itself mandate an outbound message. The reconsideration may legitimately decide to do nothing, wait, gather more evidence, ask a human, or create one or more pieces of Work.

### Scheduled reconsideration vs committed deferred work

R1 must distinguish:

```text
scheduled reconsideration
≠
scheduled committed work
```

A reminder such as “re-evaluate this Opportunity Friday morning” should wake the Case and reassess current reality. By contrast, an already-authorized commitment such as “send the requested documents tomorrow at 09:00” may be represented as durable deferred Work with `not_before`/equivalent scheduling semantics.

Even committed deferred Work must revalidate relevant authority, material preconditions and changed facts immediately before a consequential external effect.

## 13.3 Work granularity: not every thought becomes a Work Item

The Work Plane should persist work that deserves independent operational identity, not every read/reason/tool step performed during reconsideration.

**Inline / immediate bounded execution** is appropriate for ephemeral reads, deterministic lookups, context assembly, reasoning or small synchronous actions that do not need independent waiting/retry/dependency/evidence semantics.

A **durable Work Item** is appropriate when the work materially benefits from one or more of:

- surviving beyond the current turn/run;
- waiting until a later time or external condition;
- retries/recovery;
- explicit dependencies or fan-out/fan-in;
- human participation/review;
- material external effects;
- idempotency or post-condition verification;
- independent execution evidence/auditability.

This keeps Work Items as durable execution units rather than a log of every internal reasoning step.

## 13.4 Dynamic work may adapt execution, not invent authority

Relationship Operations should be able to use **situational/dynamic work generation** rather than instantiate a long predetermined sequence merely because the workflow-definition format can encode one. The work graph may branch, loop, parallelize, wait, replan or create additional bounded Work as reality changes.

However, dynamic planning does **not** grant dynamic authority. The Case Supervisor may determine or propose work only within the Case contract and other governing constraints, including:

- durable Case objective/responsibility;
- allowed capabilities;
- platform hard bounds and organization policy;
- workflow/Case invariants;
- resource/cost constraints where applicable;
- human-authority and approval rules;
- evidence, verification and completion requirements.

The model may choose strategy where intelligence is valuable; deterministic/governed mechanisms remain authoritative where reality, permissions, commitments and consequential effects must be hard.

## 13.5 Relationship to routines, dynamic workflows, Work Items and loops

The mechanisms should remain distinct:

```text
Routine / external observer
        ↓ detects something relevant
source event / scheduled wake-up
        ↓
Operational Case
        ↓ preserves durable responsibility
Case Supervisor
        ↓ decides what best advances the Case now
Dynamic work graph
        ↓ coordinates adaptive work
Work Items
        ↓ durable units where persistence is needed
Worker / agent loop
        ↓ iterates inside bounded execution
verification / guards / policy
        ↓ govern consequential outcomes
```

In shorthand:

- **routines detect**;
- **Cases remember/own the durable commitment**;
- **Case Supervisors reconsider**;
- **dynamic work graphs coordinate adaptive execution**;
- **Work Items make necessary work durable**;
- **loops execute and correct within bounded work**;
- **guards/policy govern**.

Dynamic workflows therefore complement rather than replace durable Operational Cases.

## 13.6 Evidence gaps use ordinary shared Work when resolution is worthwhile

Missing expected evidence does not automatically require action or a durable Work Item.

The Case Supervisor should first determine whether resolving the gap is materially worthwhile for the current decision, responsibility or outcome. If not, the gap may legitimately remain unknown.

When reconciliation is worthwhile, it is ordinary Case work and should reuse shared Work/attempt/evidence mechanisms rather than a Relationship-specific evidence-gap subsystem. A durable Work Item is appropriate only when the reconciliation itself benefits from durable execution semantics such as waiting, retry, dependencies, human participation, material effects, idempotency/post-condition verification or independent execution evidence.

For example:

```text
appointment happened?
        ↓ unknown
is resolution materially worthwhile?
        ├─ no  → preserve unknown / no further active work
        └─ yes
              ↓
       inline reconciliation and/or durable Work Item
              ↓
       reread source / ask advisor / ask prospect if appropriate
              ↓
       accepted Case fact or remain unknown
```

Do not create a Relationship-specific `relationship_evidence_gaps` table, scheduler or retry engine by default.

## 13.7 Child Case boundary

Dynamic decomposition must not turn every subtask into a Case. Create a child Case only when the subproblem acquires its own durable business responsibility or lifecycle—for example, its own participants, waits, authority, commitments or completion evidence. Otherwise keep it as Work inside the parent Case.

## 13.8 Accepted decision

> **Use Case wake-up as situational reconsideration and the shared Work Plane for durable execution. A Case Supervisor may determine or propose what work best advances the Case after relevant events, scheduled wake-ups, human interventions or changed facts, including adapting the work graph within the Case contract. Dynamic planning does not grant dynamic authority: proposed work remains bounded by the Case objective, allowed capabilities, organization/platform policy, invariants, resource constraints, human-authority rules and deterministic verification. Use inline bounded execution for ephemeral read/reason steps, and durable Work Items when work must wait, retry, depend on other work, involve humans, create material external effects or preserve independent execution/evidence. Distinguish scheduled reconsideration from already-committed deferred work; both revalidate relevant authority and material preconditions before external effects. When resolving an evidence gap is materially worthwhile, represent reconciliation through ordinary shared Case work and use durable Work Items only when durable execution semantics are needed; do not create a Relationship-specific scheduler or evidence-gap subsystem. Create a child Case only when the subproblem acquires its own durable business responsibility/lifecycle.**

---

# 14. AC-9 — Supervisory Projection & Multi-seat UX

> **Review status:** Accepted architecture direction.

## 14.1 Work Portfolio is a projection, not operational truth

S4's Work Portfolio should derive from shared operating truth, including:

- organization-authorized Cases;
- assignment/DRI;
- current facts/progression;
- open Work Items and blocked work;
- approvals / human decisions;
- delivery/authority state;
- commitments and timing;
- relevant outcomes and evidence.

It is **not** a second SOR, a manually editable CRM pipeline or a durable queue separate from Case / Work / Fact / Approval truth.

Human actions initiated from Work Portfolio must update the canonical mechanism that owns the decision or state (for example Case approval, fact, Work Item, assignment, governed override/policy action). Presentation-only state such as a personal `seen`, `snooze` or filter preference must remain explicitly separate from operating truth.

## 14.2 Authorization happens before cross-Case reasoning

R1 needs at least:

- **My Work** — assigned/DRI-relevant Opportunities visible to the authenticated actor;
- **Organization Work** — broader organization scope for authorized roles;
- **Needs Attention** — human-intervention subset;
- **In Motion** — autonomous work that remains visible but does not currently require human intervention;
- **Outcomes** — evidence-backed result/progression projection.

Authorization must be resolved **before** ranking or model reasoning across Cases:

```text
authenticated actor
      ↓
organization / membership / role / assignment authorization
      ↓
authorized Cases
      ↓
attention predicates + contextual ranking
      ↓
Work Portfolio
```

The model that ranks/explains a user's Work Portfolio should not receive unauthorized Cases merely because they will be filtered out later.

This is one reason organization-aware tenancy must exist before R1 multi-seat graduation. `My Work` and `Organization Work` are different authorized projections over the same operating truth, not separate databases.

## 14.3 Must-surface conditions vs contextual ranking

`Needs Attention` should rank **the need for human intervention**, not generic lead attractiveness.

Some human-attention conditions are governed obligations and should be deterministic or policy-enforced **must-surface** conditions. Examples include, where the applicable contract/policy says so:

- an explicit approval or protected decision pending from a human;
- Work blocked on required human authority/input;
- a material commitment or deadline that has crossed a governed threshold;
- a high-consequence external effect whose execution outcome is uncertain and requires human resolution;
- an authority/policy exception that Gu cannot resolve autonomously.

Model ranking must not suppress these obligations.

After hard inclusion/urgency/authority constraints are applied, model/Skill judgment may prioritize discretionary human attention using contextual factors such as:

- consequence;
- urgency;
- blockage;
- relationship risk/frustration/ambiguity;
- uncertainty;
- business relevance;
- expected value of human involvement;
- interaction among multiple Case facts that would be brittle to encode as a growing rule set.

This preserves the intended hybrid boundary:

```text
DETERMINISTIC / GOVERNED
- who may see the Case
- whether a human decision is mandatory
- hard deadlines / approvals / authority blockers
- what facts, Work and commitments actually exist

        ↓

MODEL / SKILL JUDGMENT
- which discretionary intervention matters most now
- relationship / contextual risk
- expected value of human involvement
- concise situation summary and rationale

        ↓

DETERMINISTIC / GOVERNED
- what intervention the actor is authorized to perform
- where the resulting decision is persisted
- whether execution actually succeeded
```

## 14.4 Explainability and evidence grounding

A ranking score alone is insufficient operationally.

The Work Portfolio should be able to explain *why* attention is needed using traceable operating evidence, for example:

```text
Needs attention because:
- prospect expressed frustration;
- advisor commitment conflicts with current availability;
- Gu lacks authority to revise the commitment;
- response is due today.
```

The model may use probabilistic/contextual judgment, but its explanation must be grounded in authorized Case / Work / Fact / Approval / commitment / event evidence rather than opaque free-form intuition.

> **Principle:** Judgment may be probabilistic; the evidence it reasons over must remain traceable.

## 14.5 No required Portfolio Supervisor agent for R1

R1 does not require a new durable `Portfolio Supervisor` agent/service/root merely to produce Work Portfolio. A viable initial architecture is:

```text
shared operating truth
      ↓
authorized projection
      ↓
hard attention predicates
      ↓
optional contextual model ranking / explanation
      ↓
Work Portfolio
```

A future cross-Case agentic supervisor may become useful for capacity allocation, portfolio-wide pattern detection or proactive coordination, but that is a separate capability and should not be smuggled into the R1 projection contract.

Terminology remains deliberate: **Work Portfolio** is the human-facing supervisory surface; `Supervisor` remains reserved for agentic/runtime concepts.

## 14.6 Behavioral ownership after S4 approval

S4 (`specs/work-portfolio-supervisory-experience.md`) now owns Work Portfolio / Needs Attention / Gu Handling / Waiting / Watching / stalled / Outcome behavior; the cross-domain Experience Architecture (`docs/manuals/gu-os-experience-architecture.md`) owns semantic Human Interaction primitives, Contextual Views/Artifacts, rendering and attention delivery. `Needs Attention` is a supervisory projection over one or more materially relevant Human Interactions, not itself a Human Interaction primitive. AC-9 remains the accepted architecture direction and is unchanged; where wording overlaps, S4 owns behavior and Experience Architecture owns expression.

## 14.7 Accepted decision

> **Implement Work Portfolio as an exception-first, organization-authorized read/projection over shared operating truth rather than a second operational database or CRM pipeline. Authorization and hard attention eligibility must be resolved before cross-Case ranking. Cases requiring human action because of explicit authority, approval, blocked work, material commitments, high-consequence uncertainty or other governed conditions must surface deterministically and must not be suppressible by model scoring. Within authorized and policy-bounded attention candidates, model/Skill judgment may rank contextual human-intervention priority using factors such as consequence, urgency, blockage, relationship risk, uncertainty, business relevance and expected value of human involvement, with evidence-linked explanations. `Needs Attention` ranks the need for human intervention, not generic lead attractiveness. `In Motion` and `Outcomes` remain derived projections. Human actions initiated from Work Portfolio must update the canonical Case / Work / Fact / Approval / assignment / policy mechanisms—or clearly separate user presentation state—rather than mutate a parallel portfolio truth. Exact ranking bands, projection implementation and visual design remain downstream Technical Design/Spec concerns.**

---

# 15. AC-10 — Resource Usage, Cost Attribution & Economic Telemetry

## 15.1 Current base

> **Review status:** Accepted architecture direction. ADR-110 accepted; exact schema/migration remains Technical Design.

`ai_usage_events` already provides the right append-only and correlation principles for model cost.

## 15.2 R1 target and separation of concerns

Track material variable resources such as:

- AI model calls;
- WhatsApp/message provider usage;
- voice minutes where used;
- document processing/OCR if used;
- geocoding/search/provider calls;
- specialist service/provider fees causally attributable to work;
- other material variable resources.

Keep four concerns distinct:

```text
1. resource usage
        ↓
2. cost valuation
        ↓
3. causal attribution / explicit shared allocation
        ↓
4. cost-to-serve projections by
   organization / Case / Work / activity / outcome

SEPARATE CONTRACT:
customer price / credits / wallet / billing
```

> **Invariant:** Usage measures consumption. Cost valuation measures economic input. Attribution/allocation explains causal ownership. Billing monetizes customer value. They must not collapse into one ledger or one price rule.

## 15.3 Usage evidence and valuation maturity

Do not create Relationship-specific cost tables. A generic cross-domain resource/economic telemetry contract should preserve:

- append-only/auditable resource usage;
- provider/resource/operation;
- quantity/unit;
- reported vs estimated cost and the pricing version used;
- status/retry/failure where consumption occurred;
- organization/account;
- Case/Work Item/Attempt/Work Run correlations;
- minimal non-content allowlisted metadata.

A resource usage event is durable evidence that consumption occurred. Cost knowledge may mature later: an initial estimate may be replaced in the current projection by provider-reported or reconciled valuation, but later valuation must not erase the original usage evidence or the historical basis used at the time. The exact event/valuation table shape belongs in Technical Design.

`ai_usage_events` should therefore be **extended/evolved rather than conceptually replaced**. It may become a specialized source, compatibility view or migration input into the generic model; avoid unnecessary dual-write unless Technical Design proves it necessary.

## 15.4 Correlation, attribution and allocation

Hierarchical correlation is not multiple economic allocation. One resource event may be correlated simultaneously to an Organization, Case, Work Item and Attempt; those are different roll-up dimensions over the same underlying cost, not four costs.

Use this precedence:

```text
1. direct causal attribution
        ↓ if not defensible
2. explicit shared-cost allocation using a documented/versioned driver
        ↓ if no defensible driver exists
3. retain shared / platform / unallocated cost
```

Shared allocation may use defensible activity drivers such as attributable tokens/context, messages, pages, minutes, API calls, properties or Opportunities processed. Do not divide shared cost merely because a per-Case number is desirable.

Economic roll-ups must remain reconcilable:

```text
total recorded resource cost
= directly attributed cost
+ allocated shared cost
+ explicit shared/unallocated cost
```

## 15.5 Failures, retries, activity semantics and outcomes

Retries, failures and reconciliation consume real resources and remain cost-bearing usage rather than being hidden from successful-work economics. This enables later analysis of productive cost vs retry/failure/reconciliation waste.

Cost-to-Serve may be analyzed against evidence-backed business outcomes, but the economic ledger does not become the owner of those outcomes. Outcome truth remains in Case/Work/domain semantics.

Likewise, strategically useful activity categories such as qualification, matching, follow-up, visit coordination or reconciliation should derive from governed Work/capability/domain semantics, not arbitrary free-text labels invented independently by callers.

Economic telemetry should remain deliberately poor in business content: record identity, resource, quantity, causal correlation and cost metadata without copying prompts, messages, documents or transcripts merely for cost accounting.

## 15.6 Billing boundary

Customer credits, subscriptions, wallets, outcome pricing and billing are a separate contract. They may consume economic telemetry and outcome truth, but customer charges are **not derived 1:1 from internal provider cost**. Preserve separate provider-pricing versions and future customer-pricing/credit-policy versions.

## 15.7 Accepted decision
> **Generalize Gu OS economic observability as a cross-domain resource-usage and cost-attribution contract, extending rather than replacing the append-only, versioned-pricing and correlation semantics already established by `ai_usage_events`. Keep resource usage, cost valuation, cost attribution/allocation and customer pricing/billing as distinct concerns. Durable usage evidence must remain auditable even when cost estimates later mature, reconcile or receive provider adjustments. Prefer direct causal attribution to Case / Work Item / Attempt / Work Run when defensible; treat hierarchical correlations as lineage rather than multiple allocations, and use explicit versioned shared-cost allocation only when a defensible cost driver exists. Preserve unallocated/shared cost rather than inventing false per-Case precision, and require economic roll-ups to remain reconcilable to their underlying resource events. Retry, failure and reconciliation consumption remain real cost-bearing usage. Business activity and outcome analysis should derive from governed Case/Work semantics rather than making the economic ledger a second owner of business truth. Keep telemetry metadata minimal and allowlisted, avoiding unnecessary business content. Customer credits, price, wallet and billing remain a separate contract that may consume economic/outcome telemetry but is not derived 1:1 from internal cost. Do not create Relationship-specific economic tables.**

---

# 16. ADR status and architecture packaging

AC-1 through AC-10 are accepted at architecture-direction level. Durable cross-cutting decisions are captured in the architecture system rather than duplicated in initiative-local implementation prose.

## 16.1 ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge

**Accepted. Supersedes ADR-101.**

Owns:

- organization as canonical target isolation/business-ownership boundary;
- user as authenticated actor/member;
- Membership/role/assignment/DRI/approver/routing separation;
- staged dual-scope migration;
- legacy organization/user/channel identity bridge;
- legacy `organization_id` as external key/bridge, not Gu OS canonical Organization ID;
- R1 minimum multi-seat slice;
- multi-organization-compatible conceptual shape;
- platform-staff authority separation.

The completed Traditional Gu source audit strengthens this ADR by confirming Firebase identity, mixed `organization_id` representation, principal/advisor distinction and legacy claim drift.

## 16.2 ADR-107 — Runtime, conversation and approval authority during brownfield migration

**Accepted.**

Owns:

- durable responsibility vs runtime decision authority vs conversation authority vs business approval authority;
- `LEGACY | GU_OS` as decision authority, not transport;
- Case existence does not transfer authority;
- one autonomous decision-maker for the same governed scope;
- human takeover suppresses Gu speaking without automatically pausing the Case;
- pre-effect deterministic authority revalidation;
- generic external conversation binding;
- Traditional Gu outbound WhatsApp seam as preferred initial transport when wrapped with required guarantees;
- fail-safe behavior on authority conflict.

The legacy source audit confirms the existing takeover/resume and provider-correlation mechanics without making those exact implementation values the Gu OS invariant.

## 16.3 AC-1 / AC-2 architecture packaging

AC-1 and AC-2 remain accepted architecture direction in this analysis. Exact operational gateway, event-ingestion, idempotency, external-effect and reconciliation mechanics belong to the Technical Plan/Technical Design. If a separate cross-domain ADR is later useful for one of these mechanics, it should capture a durable shared decision rather than restating R1-specific implementation details.

## 16.4 ADR-108 — Versioned organization policy

**Accepted.**

Owns:

- generic organization-owned policy contract with typed/domain-specific policy purposes;
- Platform hard bounds / Policy / Workflow / Knowledge / model judgment separation;
- natural-language authoring vs structured published runtime authority;
- immutable published versions and authorized publication;
- semantic model interpretation feeding deterministic/governed policy resolution;
- decision-level effective policy-version attribution;
- future-policy resolution rather than lifetime pinning of all policy to a Case;
- explicit/non-silent retroactive reassessment;
- missing/invalid policy cannot broaden autonomy;
- subordinate/user overrides only where explicitly permitted.

## 16.5 ADR-109 — Generic Case relationships and lineage

**Accepted direction.** The full-repo audit found no adequate first-class generic Case↔Case relationship/lineage primitive. [ADR-109](../../../adr/ADR-109-generic-case-relationships-lineage.md) establishes the shared cross-domain Case Relationship / Lineage contract. Exact persistence schema, relationship registry/vocabulary representation, indexes, RLS, APIs, mutation mechanics and migration/backfill remain Technical Design.

## 16.6 ADR-110 — Resource Usage & Cost Attribution

**Accepted direction.** [ADR-110](../../../adr/ADR-110-resource-usage-cost-attribution.md) owns the durable cross-domain economic-observability contract:

- resource usage ≠ cost valuation ≠ attribution/allocation ≠ customer billing;
- append-only usage evidence and versioned/reconcilable valuation;
- direct causal attribution before shared allocation;
- correlation/lineage is not repeated economic allocation;
- explicit versioned shared allocation only with a defensible driver;
- explicit shared/unallocated cost rather than false precision;
- mathematical reconciliability of roll-ups to underlying resource events;
- retries/failures/reconciliation as cost-bearing usage;
- activity/outcome semantics sourced from governed operational truth;
- minimal allowlisted metadata / no unnecessary business content;
- cross-domain primitive, not Relationship-specific tables;
- billing/pricing/credits as a separate future contract.

Exact table names, migration/dual-write strategy, valuation record shape and read-model implementation remain Technical Design.

---

# 17. Brownfield migration strategy

The architecture should migrate responsibility progressively rather than replace Traditional Gu in one cut.

## Stage 0 — Source contracts verified; adapter contract inventory

The minimum Traditional Gu source audit for R1 Technical-Plan entry is complete. Before implementing/cutting over each selected path, translate the audited contracts into exact adapter/API/test contracts and revalidate any source path that changed materially.

Verified areas include:

- lead/contact identity and `lead_id`;
- organization/principal/advisor relationships;
- WhatsApp business-number routing/provider IDs;
- inbound webhook/event IDs;
- human same-thread intervention/resumption;
- appointment persistence/visit evidence;
- property source/search roles;
- Legacy Deal creation/meaning;
- assignment behavior;
- outbound WhatsApp provider correlation/failure evidence;
- relevant legacy authorization risks.

No live Gu OS authority transfer before the selected path's adapter, authorization and reconciliation behavior is implemented and verified.

## Stage 1 — Identity/org bridge + read-only operational gateway

- first-class Gu OS organization/membership bridge;
- map legacy IDs with provenance;
- organization-aware R1 authorization;
- fresh read capabilities;
- shadow Lead Opportunity admission/continuity;
- no duplicate external action authority.

## Stage 2 — Event wake-up + shadow/assisted Case responsibility

- normalized inbound events;
- WhatsApp/external conversation binding;
- Cases maintain durable responsibility;
- Case Supervisor decisions shadow Legacy;
- Work Portfolio shows what Gu would do / Needs Attention;
- compare against real outcomes/human behavior.

## Stage 3 — Selective action authority

Per pilot policy/Opportunity:

```text
runtime authority = GU_OS
```

for approved classes of work.

- bounded outbound capabilities;
- idempotency/evidence/reconciliation;
- human takeover preserved;
- consequential actions remain gated appropriately.

Legacy path must not independently perform the same autonomous work for those Opportunities.

## Stage 4 — Broader situational responsibility

Expand only after evidence:

- more sources;
- more autonomous low-risk work;
- Shared Inventory wake-up;
- stronger outcome/economic instrumentation;
- reduced fixed-timer legacy behavior.

Do not remove legacy paths until replacement coverage and rollback are proven.

---

# 18. Failure and recovery model

R1 architecture should explicitly handle:

| Failure | Required architectural behavior |
|---|---|
| Duplicate inbound event | Idempotent normalize/process; no duplicate Opportunity/effect |
| Source read unavailable | Preserve known truth + mark freshness/uncertainty; retry/reconcile; do not invent |
| External command timeout | Unknown outcome until postcondition/reconciliation |
| External effect succeeded, local acknowledgment failed | Re-read/postcondition + reconcile; do not blindly repeat |
| Local Work succeeded, external evidence missing | Preserve the evidence gap; reconcile when materially worthwhile, using durable Work only when durable execution semantics are needed. |
| Human intervened | Suppress Gu speaking as required; Case may continue observing/thinking |
| Policy changed mid-run | Active published version governs until new version is explicitly activated |
| Identity ambiguous | Fail closed where tenant/data-sharing risk exists |
| Model uncertain | Clarify/targeted human input; confidence does not widen authority |
| Legacy/Gu OS authority conflict | Stop autonomous duplicate action; surface operational incident |
| Cost event cannot be causally allocated | Keep shared/unallocated; do not fabricate per-Case cost |

---

# 19. Security and tenancy requirements

Before R1 multi-seat live authority:

1. Every tenant-owned Case/Work/Fact/Approval access path used by R1 must enforce organization-aware authorization.
2. Cross-tenant denial must be deterministic and tested.
3. Legacy identity mappings must be scoped by source + organization and preserve provenance; composite `lead_id` values must be treated as opaque external identifiers rather than canonical person/tenant IDs.
4. Model context must be authorized **before** retrieval/ranking, not filtered only after generation.
5. Shared Inventory access does not imply prospect-data sharing.
6. External conversation/contact identifiers are sensitive operational references and should not become broad lookup keys without tenant scope.
7. Service-role runtime paths must perform application authorization explicitly; service role itself is not business permission.
8. Platform/Ungga admin authority remains separate from organization roles.
9. Legacy `super-admin` or equivalent product-layer role must not imply cross-organization authority in Gu OS.
10. Selected legacy capability wrappers must add organization ownership checks rather than inheriting legacy shortcuts identified in `legacy-source-audit.md`.

---

# 20. Pilot architecture / evidence

The pilot should prove both business behavior and architecture contracts.

## Required operating evidence

- correct organization/contact/Opportunity identity resolution;
- no cross-tenant leakage;
- no duplicate active authority between Legacy and Gu OS;
- event wake-up latency/freshness;
- admission/continuity correction rate;
- idempotent external effects;
- human takeover correctness;
- evidence reconciliation;
- Work Item retries/recovery;
- policy-version traceability;
- resource/cost correlation.

## Business evidence

- viable Opportunity continuity across days/events;
- visit request / scheduled / attended evidence where observable;
- human touches avoided vs required;
- lost Opportunities recovered/advanced;
- outcome quality by source/Opportunity;
- cost-to-serve.

Pilot authority progression remains:

```text
shadow
→ assisted
→ selective live autonomy
→ broader situational responsibility
```

---

# 21. Technical Plan entry conditions

The architecture/source-discovery gates needed to **enter** Technical Planning are now sufficiently resolved:

1. [x] Minimum Traditional Gu source audit for WhatsApp/Legacy Lead/Legacy Deal/appointment/property/assignment paths, including outbound provider correlation.
2. [x] Accepted organization/membership/identity tenancy direction — ADR-106.
3. [x] Accepted runtime/conversation authority direction — ADR-107.
4. [x] Accepted operational gateway / SOR / write-consistency direction — AC-1 / AC-2.
5. [x] Generic Case relationship contract — ADR-109 after full-repo audit.
6. [x] Organization policy contract direction — ADR-108.
7. [x] Generic economic telemetry direction — ADR-110.
8. [x] Architecture-cluster review AC-1 through AC-10 complete.

The Technical Plan must now make the remaining implementation choices explicitly rather than inventing new product/architecture semantics. Plan/slice approval will still depend on:

- exact pilot boundary and source systems;
- S2/S3/S4 behavior sufficiently approved for the slices they affect;
- exact organization/RLS migration for the multi-seat slice;
- exact adapter/event/idempotency/reconciliation contracts;
- implementation-time revalidation if an audited Traditional Gu source path changes materially.

---

# 22. Architecture decision register

## Accepted direction

1. **Operational gateway:** bounded semantic capabilities over fresh Traditional Gu/operational sources; BigQuery remains analytical.
2. **Eventing:** authenticated/idempotent normalized event-driven wake-up + scheduled reconsideration; event/timer ≠ action.
3. **SOR:** fact-level authority; Gu OS owns Opportunity durable lifecycle/interpreted truth while legacy/current systems retain selected operational records; Legacy Deal does not itself define Transaction start.
4. **External effects:** Work-backed bounded commands with pre-effect authority revalidation, idempotency where possible, evidence/postconditions and reconciliation; no distributed ACID or generic mirroring.
5. **Tenancy:** Organization becomes canonical target business/tenant owner for R1 organization-owned work; User is member/actor; staged migration.
6. **ADR-101:** superseded by ADR-106 reflecting current multi-seat and legacy-identity semantics.
7. **Authority:** durable responsibility, runtime authority, conversation authority and business approval authority remain distinct; Case existence does not transfer runtime authority.
8. **WhatsApp/external conversation:** generic external-conversation binding; legacy `lead_id` is opaque external context; reuse/wrap Traditional Gu outbound transport with Gu OS-grade authorization/idempotency/evidence/reconciliation.
9. **Policy:** generic organization-owned typed/versioned policy contract; NL is authoring interface, published structured version is runtime authority; consequential decisions remain policy-version attributable; missing/invalid policy cannot broaden authority.
10. **Case relationships / lineage:** generic governed Case relationship semantics under ADR-109; lineage preserves history/provenance, reactivation normally continues the same Case, consequential mutations require authority/evidence, relationships are organization-contained by default, and Opportunity ↔ Transaction association does not itself close the Opportunity.
11. **Relationship truth/projection:** provenance-backed `case_facts` + derived business projections; keep viability/progression/delivery/closure separate from generic runtime status; progression is non-linear/repeating; `current_step` is reserved for genuine procedural execution state, not CRM staging.
12. **Work:** situational Case reconsideration + adaptive shared Work Plane; dynamic planning remains inside Case/authority/invariant/evidence bounds; distinguish scheduled reconsideration from committed deferred Work; evidence reconciliation uses ordinary shared Case work when resolution is materially worthwhile, and durable Work Items only when durable execution semantics are needed; child Cases require independent durable responsibility.
13. **Work Portfolio:** exception-first organization-authorized projection over shared truth; authorization and governed must-surface predicates precede model ranking; model judgment may prioritize contextual human-intervention need with evidence-linked explanations; UI actions write to canonical operating mechanisms, not portfolio truth.
14. **Economics:** cross-domain resource usage/cost telemetry separates usage, valuation, causal attribution/shared allocation and billing; preserves append-only evidence, reconciliability, no-false-precision rules and cross-domain semantics.

---

# 23. Open questions for Technical Design or later Specs

The minimum legacy source audit is complete. The following are no longer architecture source-audit blockers; they are implementation/spec questions to resolve against the verified contracts.

### Legacy adapter / implementation design
- Which exact service/API/direct adapter should implement each bounded Legacy Lead/message/Legacy Deal/appointment/property capability?
- What event envelope/deduplication key should Gu OS use for WhatsApp/provider/source events?
- How should the canonical Organization external binding represent the legacy organization key, principal Firebase UID, member identities and Gu/WABA identifiers?
- What exact state/resolver represents Gu OS runtime and conversation authority?
- How should the source-verified `bypass_bot`/human-intervention signals map into that generic authority contract?
- How should `wamid`, appointment IDs and other provider/source IDs correlate to Work Item Attempts?
- What exact idempotency/reconciliation strategy wraps outbound message and appointment effects?
- How should Gu OS reconcile Firestore/Mongo appointment disagreement and possible orphan Calendar effects?
- Which property reads must consult upstream CRM vs current Ungga Firestore representation?
- Which Legacy Lead assignment events/fresh reads should wake an Opportunity?
- What exact source predicate constitutes a concrete Transaction boundary beyond Legacy Deal existence?
- What source freshness SLA is required per capability?

### S2 / S3 / S4
- Exact autonomous-action classes and human gate thresholds.
- Exact delivery/cooldown policy behavior.
- Exact match/material-change wake-up behavior.
- Exact visit evidence acceptance/reconciliation.
- Exact Work Portfolio ranking and role visibility.

### Technical design
- Exact organization/membership schema and RLS migration.
- Exact generic policy schema.
- Exact conversation-binding extension.
- Exact Case relationship schema.
- Exact generic resource-usage ledger migration.
- Exact projection/read-model strategy.

---

# 24. Architecture exit criteria

Current status:

- [x] Bounded operational gateway vs BigQuery/live-runtime separation accepted.
- [x] Organization/membership/tenancy migration direction accepted.
- [x] ADR-101 supersession accepted through ADR-106.
- [x] Legacy vs Gu OS runtime decision authority accepted conceptually through ADR-107.
- [x] Human takeover / conversation authority separation accepted.
- [x] Fact-level SOR/write consistency pattern accepted.
- [x] Generic organization-policy direction (AC-5) reviewed/accepted through ADR-108.
- [x] Generic Case relationship direction (AC-6) reviewed/accepted; full-repo audit completed, no adequate first-class primitive found, and ADR-109 accepted for the new shared contract.
- [x] Relationship facts/projection vs `current_step` direction (AC-7) reviewed/accepted.
- [x] Work/evidence-reconciliation reuse, situational wake-up and bounded dynamic-work direction (AC-8) reviewed/accepted.
- [x] Work Portfolio projection / authorization / human-attention ranking principle (AC-9) reviewed/accepted.
- [x] Generic economic telemetry direction (AC-10) reviewed/accepted through ADR-110.
- [x] Minimum Traditional Gu production source audit completed for Technical-Plan entry and recorded in `legacy-source-audit.md`.
- [x] Architecture changes affecting S1 behavior were kept aligned with the approved S1 contract; future behavior changes must return to the owning Spec.

**Architecture-cluster review is complete: AC-1 through AC-10 are accepted.** The Generic Case↔Case audit/ADR packaging and the minimum Traditional Gu production-source audit are also complete. Remaining work is downstream Feature/Business Specs, exact Technical Design, implementation-time revalidation of materially changed legacy paths, and pilot/slice planning—not unresolved architecture-cluster discovery.

---

# 25. Documentation cleanup recommendations

These are documentation-maintenance items, not architecture decisions:

1. Update BigQuery reference wording that currently describes `users_light.organization_id` as a "canonical tenant id" so it is clear that it is the **legacy warehouse tenant/organization key used for current analytics**, not the future canonical Gu OS Organization ID.
2. Keep `_light` names confined to BigQuery/warehouse documentation; do not reuse them when describing Mongo/Firebase operational collections unless source-verified.
3. Prefer the terms **Prospect / Contact**, **Legacy Lead**, **Legacy Deal**, and **Lead Opportunity** in cross-system architecture documents to avoid conflating person identity, legacy records and Gu OS durable responsibility.
4. Preserve BigQuery Skills/references as the preferred source for current SQL mechanics, while `legacy-source-audit.md` owns the source-verified brownfield operational contracts relevant to R1.
5. Treat the manually configured Traditional Gu `organization_id` in the current Gu OS lab UI as a temporary external data-source binding/bootstrap key, not canonical Gu OS tenancy or authorization.

# 26. Change log

| Version / date | Change | Status |
|---|---|---|
| v0.1 / 2026-08-26 | Initial R1 Architecture Analysis grounded in current Gu OS shared-kernel migrations/docs, approved Relationship Operations product directions, multi-seat legacy semantics and S1 lifecycle contract. | Draft for architecture/product review |
| v0.2 / 2026-08-26 | Incorporated supplemental seven-dataset legacy catalog, naming-layer discipline, Prospect vs Legacy Lead vs Lead Opportunity distinction, composite Legacy Lead identity semantics, Legacy Deal ≠ Transaction, and existing Traditional Gu outbound WhatsApp HTTP seam. | Draft for architecture/product review |
| v0.3 / 2026-08-26 | Corrected the outbound WhatsApp audit wording so `lead_id` is treated explicitly as the composite Legacy Lead identifier (`prospect_phone + gu_phone + owner_phone`) rather than as a third independent identity; added terminology guardrails for the three components. | Draft for architecture/product review |
| v0.4 / 2026-08-26 | Consolidated the accepted AC-1 through AC-4 decisions, added event/fact/wake/action separation, fresh-read and concurrency rules, selective writeback/unknown-outcome handling, explicit external-identity bridge semantics, pre-effect authority revalidation, decision-authority-vs-transport distinction, and ADR-106/ADR-107 drafting status. | Draft — AC-1 through AC-4 accepted direction |
| v0.5 / 2026-08-27 | Accepted and expanded AC-5 Organization Policy Architecture: typed generic policy contract, NL authoring vs runtime separation, immutable publication lifecycle, model-interpretation/deterministic-enforcement boundary, effective-version audit, non-retroactivity by default, fail-closed authority semantics, and ADR-108 drafting status. | Draft — AC-1 through AC-5 accepted direction |
| v0.6 / 2026-08-27 | Accepted and expanded AC-6 Case Relationships & Lineage: lineage vs business-association distinction; generic reuse-or-introduce contract; same-Case reactivation by default; history/provenance-preserving merge/split/supersession; governed authority/evidence for mutations; organization-contained default; Opportunity ↔ Transaction without implied Opportunity closure; ADR-109 gated on full-repo audit. | Draft — AC-1 through AC-6 accepted direction |
| v0.7 / 2026-08-27 | Accepted and expanded AC-7 Relationship Facts / Progression Projection: provenance-backed facts separated from events/projections; durable responsibility, viability, progression, delivery eligibility, closure and runtime status remain distinct; progression is non-linear/repeating rather than a single stage; `current_step` is reserved for genuine procedural execution state; closure remains business truth with reason/evidence rather than runtime status. | Draft — AC-1 through AC-7 accepted direction |
| v0.8 / 2026-08-27 | Accepted and expanded AC-8 Work Orchestration & Wake-up: wake-up as situational reconsideration; scheduled reconsideration distinguished from committed deferred Work; inline-vs-durable Work granularity; Case Supervisor may adapt work but cannot invent authority; routines/Cases/Supervisor/dynamic work/Work Items/loops separated; evidence reconciliation reuses shared Work; child Cases require independent durable responsibility/lifecycle. | Draft — AC-1 through AC-8 accepted direction |
| v0.9 / 2026-08-27 | Accepted and expanded AC-9 Supervisory Projection & Multi-seat UX: Work Portfolio remains an exception-first authorized projection; authorization precedes cross-Case reasoning; governed must-surface conditions cannot be suppressed by model ranking; model/Skill judgment may rank contextual human-intervention need with evidence-linked explanations; Needs Attention is not lead scoring; UI actions update canonical Case/Work/Fact/Approval/assignment/policy mechanisms; no new Portfolio Supervisor agent is required for R1. | Draft — AC-1 through AC-9 accepted direction |
| v0.10 / 2026-08-27 | Accepted and expanded AC-10 Resource Usage, Cost Attribution & Economic Telemetry: usage, valuation, attribution/allocation and billing separated; durable usage evidence survives later valuation maturity; correlation distinguished from allocation; direct causal attribution preferred; shared allocation requires a defensible versioned driver; shared/unallocated cost is preserved rather than fabricated; roll-ups remain reconcilable; retries/failures/reconciliation are cost-bearing; activity/outcome semantics remain owned by governed operational truth; generic cross-domain ADR warranted with provisional numbering. | Architecture review complete — AC-1 through AC-10 accepted direction |
| v0.11 / 2026-08-27 | Documentation-maintenance alignment after the full-repo Generic Case↔Case audit: audit confirmed no adequate first-class generic primitive; ADR-109 accepted for the shared Case Relationship / Lineage contract; provisional economic ADR finalized as ADR-110. No AC-1..AC-10 architecture direction changed. | Architecture review complete; Case-relationship audit / ADR numbering gate resolved |
| v0.12 / 2026-08-28 | Source-status/documentation alignment after the minimum Traditional Gu production-source audit. Added the canonical `legacy-source-audit.md` reference; source-verified identity/organization, `lead_id`, assignment, takeover/resumption, appointment/visit evidence, Legacy Deal, property and WhatsApp-provider contracts; moved the legacy audit out of the Technical-Plan blocker list; updated accepted ADR statuses. No AC-1..AC-10 or S1 behavior changed. | Architecture review complete; minimum legacy source-audit gate resolved for Technical-Plan entry |
| v0.13 / 2026-08-30 | Post-S3 documentation alignment. Refined AC-8 so evidence gaps create reconciliation work only when resolving them is materially worthwhile, and durable Work Items only when durable execution semantics are needed. Updated the decision register accordingly. No AC-1..AC-10 architecture direction or ADR changed. | Architecture review complete; aligned with approved S3 Visit behavior |
| v0.14 / 2026-08-31 | Documentation-alignment update after approval of the cross-domain Experience Architecture and the S4 Work Portfolio Spec: the header now lists the four approved R1 behavioral contracts (S1 v0.3, S2 v0.3, S3 v0.2, S4 v0.1) plus the cross-domain Experience source, and new §14.6 records AC-9 behavioral/expression ownership. No AC-1..AC-10 architecture direction, ADR or S1–S3 behavior changed. | Architecture review complete; companion sync for S4 / Experience Architecture |
| v0.15 / 2026-08-31 | Legacy-source-revalidation alignment only: the Legacy source audit reference now points to `legacy-source-audit.md` v0.3, which records the targeted drift revalidation at the new `gcp/main` / `main` heads (advisor-linked WhatsApp / `waProbe` seam, multi-thread conversation store, delivery-status writeback, identity/permission clarifications, persisting §16 risks). No AC-1..AC-10 architecture direction, ADR decision, behavioral ownership, acceptance scenario or Technical Design direction changed. | Architecture review complete; aligned with legacy source audit v0.3 |
| v0.16 / 2026-08-31 | Companion sync after approval of the R1 Technical Plan: the header now references `technical-plan.md` (v1.1 approved) and the Status line no longer states that Technical Design remains downstream. No AC-1..AC-10 architecture direction, ADR decision, behavioral ownership, acceptance scenario or S1–S4 behavior changed. | Architecture review complete; companion sync for the approved Technical Plan |
| v0.17 / 2026-08-31 | Reference refresh only: the Technical Plan pointer now reads v1.2 (SL-0 execution sync). No AC-1..AC-10 architecture direction, ADR decision, behavioral ownership, acceptance scenario or S1–S4 behavior changed. | Architecture review complete; pointer refresh |
| v0.18 / 2026-09-01 | Reference refresh only: the Technical Plan pointer now reads v1.4 (SL-0 closed with hosted pilot evidence). No AC-1..AC-10 architecture direction, ADR decision, behavioral ownership, acceptance scenario or S1–S4 behavior changed. | Architecture review complete; pointer refresh |
