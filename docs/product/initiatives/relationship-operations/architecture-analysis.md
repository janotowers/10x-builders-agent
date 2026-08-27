# R1 Relationship Operations — Architecture Analysis

> **Version:** v0.4  
> **Status:** Draft — AC-1 through AC-4 accepted as architecture direction; AC-5 through AC-10 remain recommendations pending review. ADRs/Technical Plan remain separate artifacts.  
> **Initiative:** R1 — Relationship Operations v1  
> **Parent product intent:** `docs/product/PRD.md`  
> **Initiative Brief:** `docs/product/initiatives/relationship-operations/brief.md`  
> **S1 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`  
> **Shared-kernel mapping:** `docs/product/initiatives/relationship-operations/r1-concept-shared-kernel-mapping.md`  
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
- **CURRENT — DOMAIN CONFIRMED** — current Traditional Gu behavior/topology confirmed by product/domain leadership but not source-audited in the legacy repository in this analysis.
- **TARGET — PRODUCT APPROVED** — behavior/direction approved in the Product PRD, R1 Brief, Roadmap, or S1.
- **RECOMMENDED — ARCHITECTURE** — recommendation of this analysis; not an accepted ADR until reviewed.
- **OPEN — LEGACY SOURCE AUDIT** — cannot be safely finalized without inspecting the live Traditional Gu implementation.
- **OPEN — TECHNICAL DESIGN** — architecture direction can be chosen, but exact schema/API/migration mechanics belong later.

Absence from inspected Gu OS files is not proof that a capability is absent elsewhere. In particular, this analysis does **not** claim to have source-verified the Traditional Gu production repository.

A supplemental April 2026 data catalog supplied by product/domain leadership is used here as **domain-confirmed documentation** for the seven currently mirrored BigQuery datasets and selected legacy field semantics. Where that catalog conflicts with current BigQuery Skills/references, the current Skills/references should govern warehouse-query mechanics; where implementation details matter, the operational source code remains authoritative.

### 2.1 Naming discipline: domain concept vs operational source vs BigQuery mirror

R1 architecture must not infer physical Mongo/Firebase collection names from BigQuery mirror names.

```text
DOMAIN / BUSINESS CONCEPT
        ↓
OPERATIONAL LEGACY SOURCE
Mongo / Firebase / Traditional Gu service
physical collection/path: source-audit before implementation
        ↓
BIGQUERY ANALYTICAL MIRROR
*_light dataset/view used for warehouse analytics
```

Examples:

```text
Legacy Lead
→ Mongo operational source
  physical collection name: source-audit pending
  field: lead_id
→ mongo_data.leads_light
```

```text
Legacy User
→ Firebase operational source
  probable collection: users
  field: organization_id
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
| Legacy Leads | Mongo | `mongo_data.leads_light` | prospect/lead operational record; exact physical Mongo collection source-audit pending |
| Appointments | Mongo | `mongo_data.appointments_light` | visit-request / appointment operational evidence |

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

Domain-confirmed legacy semantics indicate that the historical Legacy Lead/conversation identifier can concatenate:

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

The supplemental catalog describes a Legacy Deal as a record created when a Lead has confirmed interest in a specific property and associates that interest with a property and advisor.

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
| **AC-5 Organization Policy Architecture** | admission policy, versioning, authoring vs runtime contract | Recommendation pending review |
| **AC-6 Case Relationships & Lineage** | duplicate, merge, split, supersession, Transaction links | Recommendation pending review |
| **AC-7 Relationship Facts / Progression Projection** | viability, closure, milestones, `current_step` restraint | Recommendation pending review |
| **AC-8 Work Orchestration & Wake-up** | situational work, timers, external events, evidence reconciliation | Recommendation pending review |
| **AC-9 Supervisory Projection & Multi-seat UX** | Work Portfolio / Needs Attention authorization and projection | Recommendation pending review |
| **AC-10 Economic Telemetry** | resource usage, direct/shared cost, outcome correlation, billing boundary | Recommendation pending review |

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

### Source-audit blocker

Before Technical Plan, inspect Traditional Gu for:

- existing APIs/services for Legacy Lead, messages, appointments, properties, Legacy Deals and assignment;
- WhatsApp webhook/event flow;
- stable external event/message IDs and retry semantics;
- human-intervention/takeover detection;
- appointment write/readback paths;
- inventory-change signals;
- concrete transaction signals;
- whether polling already exists and at what freshness;
- provider correlation IDs.

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

> **Review status:** Accepted architecture direction. Superseding ADR required.

## 8.1 Why ADR-101 must be superseded

ADR-101 correctly anticipated:

- organization as target isolation boundary;
- user as runtime identity;
- separation of membership/role/team/assignment/DRI;
- platform-staff authority distinct from brokerage roles.

Its stated reevaluation trigger — multi-seat brokerage collaboration becoming a near-term product requirement — has now occurred.

Its legacy bridge is also no longer precise enough. Current domain knowledge shows that:

- legacy `organization_id` is a **legacy organization key** anchored to the principal `super-admin`, not a canonical Gu OS Organization ID;
- `org_name` is display data, not identity;
- `super-admin`, `admin` and `vendedor` are legacy membership/role semantics;
- the principal/Gu owner is not necessarily the Opportunity's assigned advisor/DRI;
- R1 requires individual authenticated advisor seats with organization-appropriate visibility, assignment and authority.

Do not silently rewrite ADR-101. Retain it historically and supersede it with a new ADR.

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
  │    ├─ legacy user document_id
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
- **Legacy Lead ID** = opaque external record ID; historical format concatenates `prospect_phone + gu_phone + owner_phone`;
- **Gu WhatsApp API identity** = Gu's connected business/API number (`bot_phone_number` in the legacy request contract);
- **principal legacy user / Gu owner** = legacy account context, not necessarily the assigned advisor or DRI.

## 8.3 Legacy role bridge is transitional

Conceptually:

```text
legacy organization key (`organization_id`)
    → Gu OS organization external-identity mapping

legacy `super-admin`
    → principal owner/admin membership

legacy `admin`
    → organization-admin membership

legacy `vendedor`
    → advisor/sales membership
```

These are bridge semantics, not the permanent Gu OS authorization vocabulary.

`profiles.is_ungga_admin` remains separate platform-staff authority and must never be inferred from brokerage roles.

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

## 8.5 External identity mapping is first-class

Gu OS canonical IDs must remain independent of legacy/provider IDs.

Conceptually Gu OS needs source-scoped mappings such as:

```text
Gu OS Organization ↔ legacy organization key
Gu OS User/Membership ↔ legacy user document_id
Gu OS Contact ↔ one or more Legacy Lead records / channel identities
Gu WhatsApp channel identity ↔ legacy Gu number
Lead Opportunity ↔ relevant Legacy Lead external reference(s)
```

Do not make `contact.id`, `opportunity.id` or canonical `organization.id` equal to legacy `lead_id`, `document_id`, `organization_id`, phone numbers or provider IDs.

The exact mapping schema is Technical Plan work.

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

> **Review status:** Accepted architecture direction. Separate ADR required.

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

The current approximate legacy inactivity timeout is not an architecture invariant. Resumption must be governed, observable and policy/explicit-signal based.

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

**CURRENT — DOMAIN CONFIRMED / SOURCE AUDIT REQUIRED:** Traditional Gu exposes an HTTP-based outbound WhatsApp capability that has been successfully invoked externally. The demonstrated request shape includes:

- prospect `phone_number`;
- Gu WhatsApp API `bot_phone_number`;
- composite legacy `lead_id`;
- either free-form `message` or approved `template_id` + template variables.

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

Before live R1 authority, source audit must verify how the endpoint uses and validates the separately supplied `phone_number`, `bot_phone_number` and composite `lead_id`, including the embedded prospect/Gu components, owner-phone context, tenant/channel ownership, provider message evidence, retries/idempotency, timeout/unknown outcomes, logging/writeback and stage/production routing.

If the route lacks required guarantees, wrap/extend it behind a stable bounded capability rather than rebuilding WhatsApp transport merely for R1.

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

> **Durable responsibility, runtime decision authority, conversation authority and business approval authority are separate. `LEGACY | GU_OS` identifies autonomous decision authority, not transport. Case existence does not transfer authority; Legacy and Gu OS must not independently decide the same governed prospect-facing work concurrently. Human takeover suppresses Gu speaking without automatically pausing the Case. Prospect-facing effects revalidate current authority immediately before execution. External conversation binding is generic and source-referenced; the existing Traditional Gu outbound WhatsApp capability is the preferred initial transport seam if source audit confirms or enables the required guarantees.**

---
# 10. AC-5 — Organization Policy Architecture

## 10.1 Product requirement

S1 approves:

```text
platform hard bounds
        ↓
organization policy
        ↓
Gu contextual judgment
```

Policy authoring is:

```text
natural language
→ interpreted structured proposal
→ examples / confirmation
→ approved version
→ runtime policy
```

Raw prose is not runtime authority.

## 10.2 Existing policy infrastructure fit

Existing notification engagement overrides are useful but should **not** become the generic admission-policy store by convenience.

Admission policy needs:

- organization ownership;
- typed policy purpose/domain;
- versioning;
- draft / validated / published-like lifecycle;
- publication authority;
- provenance;
- deterministic validation;
- runtime resolution by active version;
- auditability ("which policy version governed this decision?");
- future reuse by other domains.

## 10.3 Recommended architectural direction

Introduce a **generic versioned organization-policy primitive** or equivalent reusable contract, separate from workflow definitions and semantic knowledge.

Do not:
- store the sole policy as prompt text;
- hide it in `context_jsonb`;
- use Brain pages as authorization;
- clone policy fields onto every Case;
- treat a workflow definition as a catch-all policy store.

The organization policy contract should be reusable for future domain policies where the same governance/versioning requirements apply.

Exact schema and policy DSL/JSON shape remain Technical Plan work.

## 10.4 Decision recommendation

> **Adopt a generic, versioned, organization-owned policy contract. Natural language is an authoring interface; the published structured policy is runtime authority.**

This likely warrants an ADR if the primitive becomes cross-domain.

---

# 11. AC-6 — Case Relationships & Lineage

## 11.1 Product need

S1 requires traceable:

- duplicate;
- merge;
- split;
- supersession;
- reactivation history;
- Lead Opportunity ↔ Transaction relationship.

The reviewed shared kernel does not establish a canonical generic Case-to-Case relationship primitive.

## 11.2 Alternatives

### Option A — encode relationships in `context_jsonb`

**Reject** for durable canonical lineage.

Hard to query, validate, authorize and reuse cross-domain.

### Option B — Relationship-specific merge/split table

**Reject unless no generic contract can work.**

Property, Transaction and other domains can also need Case lineage/relationships.

### Option C — generic Case relationship primitive

**RECOMMENDED.**

Conceptually support typed, directed relationships such as:

- duplicate_of
- supersedes / superseded_by
- split_from
- merged_into
- related_transaction
- resumed_from / other carefully governed types if needed

Exact vocabulary should remain small and evidence-driven; do not create an ontology prematurely.

## 11.3 Decision recommendation

> **If full-repo audit confirms no existing generic relationship primitive, introduce a shared Case relationship/lineage contract rather than a Relationship-specific table.**

The exact merge/split data-movement semantics belong to Technical Plan and S1/S2 behavior; lineage should preserve history rather than physically pretending the past never existed.

---

# 12. AC-7 — Relationship Facts, Progression and `current_step`

## 12.1 Recommended truth model

Use:

```text
case_facts
    ↓
current business projection
    ├─ objective / requirements
    ├─ viability
    ├─ delivery constraints
    ├─ progression milestones
    ├─ closure outcome/reason
    └─ accepted evidence
```

The projection may be materialized/denormalized later if needed for supervision/query performance, but the domain semantics should remain evidence-backed and reconstructable.

## 12.2 `current_step`

Relationship Operations is not naturally a linear procedure like Property Optioning.

**RECOMMENDATION:** R1 should **not require `current_step` as a CRM stage/funnel**.

`current_step` may remain null or be used only if a true durable procedural milestone emerges that:

- meaningfully changes allowed work;
- is mutually understandable;
- is not merely a projection of concurrent facts;
- benefits workflow guards/readiness.

Progression such as visit requested/scheduled/attended should default to evidence-backed facts/projections rather than being forced into `current_step`.

## 12.3 Closure

S1-approved:

- `objective_achieved`
- `lost`
- `invalid`
- `duplicate`
- `superseded`

with separate reason/evidence.

These should be business facts/projection used by completion predicates, not new generic runtime statuses.

## 12.4 Decision recommendation

> **Use `case_facts` + derived projection for Relationship lifecycle/progression. Keep `operational_cases.status` generic and use `current_step` only if a true procedural state is later proven useful.**

---

# 13. AC-8 — Work Orchestration & Wake-up

## 13.1 Case Supervisor concept

R1 needs an agentic/runtime role that, for one Opportunity, can decide:

- what changed?
- does anything need to happen now?
- what work is useful?
- can Gu act?
- should a human be involved?
- when should the Case be reconsidered?

This is the **Case Supervisor** concept, not necessarily a new service/process/table.

It may be implemented through the existing Case runner + root Skill/workflow policy initially.

## 13.2 Work generation

Prefer **situational work generation**:

```text
wake
 ↓
compile current Case context + fresh source facts + policy
 ↓
model/Skill judgment
 ↓
0..n bounded proposed actions
 ↓
deterministic authority/policy checks
 ↓
Work Items / immediate bounded actions as appropriate
```

Do not instantiate a long predetermined future sequence merely because a workflow definition can represent one.

## 13.3 Evidence gaps

Missing expected evidence should usually create reconciliation work, e.g.:

```text
appointment happened?
        ↓ unknown
reconciliation Work Item
        ↓
reread source / ask advisor / ask prospect if appropriate
        ↓
accepted Case fact or remain unknown
```

Do not create `relationship_evidence_gaps` by default.

## 13.4 Decision recommendation

> **Use Case wake-up as reconsideration, Work Items as durable execution, and evidence reconciliation as Work—not a Relationship-specific scheduler or fixed future-message queue.**

---

# 14. AC-9 — Supervisory Projection & Multi-seat UX

## 14.1 Work Portfolio is a projection

S4's Work Portfolio should derive from:

- organization-authorized Cases;
- assignment/DRI;
- current facts/progression;
- open Work Items;
- approvals;
- delivery/authority state;
- relevant outcomes.

It is **not** a second SOR or manually editable CRM pipeline.

## 14.2 Authorization implications

R1 needs at least:

- **My Work** — assigned/DRI-relevant Opportunities;
- **Organization Work** — broader view for authorized admin/principal roles;
- **Needs Attention** — ranked human intervention subset;
- **In Motion** — autonomous work;
- **Outcomes** — evidence-backed result projection.

This is one reason organization-aware tenancy must exist before R1 multi-seat graduation.

## 14.3 Ranking

Hard urgency/authority commitments should be deterministic bands/constraints; model judgment may order within contextual ranges and explain why attention is needed.

## 14.4 Decision recommendation

> **Implement Work Portfolio as an organization-authorized read/projection over shared operating truth, not a new operational database or pipeline.**

Exact query/read-model strategy belongs after S4 behavior is approved.

---

# 15. AC-10 — Resource Usage, Cost Attribution & Economic Telemetry

## 15.1 Current base

`ai_usage_events` already provides the right append-only and correlation principles for model cost.

## 15.2 R1 target

Track material variable resources such as:

- AI model calls;
- WhatsApp/message provider usage;
- voice minutes where used;
- document processing/OCR if used;
- geocoding/search/provider calls;
- specialist service/provider fees causally attributable to work;
- other material variable resources.

Separate:

```text
resource usage event
        ↓
provider/resource cost
        ↓
direct attribution
OR
documented shared allocation
OR
explicit unallocated/shared cost
        ↓
cost-to-serve by
organization / Case / Work / activity / outcome

SEPARATE:
customer price / credits / wallet / billing
```

## 15.3 Ledger evolution recommendation

Do not create Relationship-specific cost tables.

A generic resource-usage ledger should preserve:

- append-only/auditable usage;
- provider/resource/operation;
- quantity/unit;
- reported vs estimated cost;
- pricing version;
- status/retry;
- organization/account;
- Case/Work/Attempt correlations;
- non-content allowlisted metadata.

`ai_usage_events` may become an input/backfill/compatibility view or specialized source into that generic model. The exact migration strategy should be decided in Technical Design to avoid unnecessary dual-write.

Shared cost allocation should remain explicit and versioned; if no defensible causal driver exists, retain the cost as shared/unallocated rather than inventing false per-Case precision.

## 15.4 Decision recommendation

> **Generalize economic observability cross-domain, preserving the append-only/correlation semantics already proven by `ai_usage_events`. Keep cost-to-serve separate from customer billing.**

---

# 16. ADR recommendations

AC-1 through AC-4 are now accepted at architecture-direction level. Durable cross-cutting decisions should move into ADRs without importing Technical Plan mechanics.

## 16.1 ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge

**Draft now. Supersedes ADR-101.**

Capture:

- organization as canonical target isolation/business-ownership boundary;
- user as authenticated actor/member;
- Membership/role/assignment/DRI/approver/routing separation;
- staged dual-scope migration;
- legacy organization/user/channel identity bridge;
- legacy `organization_id` as external key, not Gu OS canonical Organization ID;
- R1 minimum multi-seat slice;
- multi-organization-compatible conceptual shape;
- platform-staff authority separation.

ADR-101 should remain in history with status changed to **Superseded** and a link to ADR-106; its original rationale/decision text should otherwise remain intact.

## 16.2 ADR-107 — Runtime, conversation and approval authority during brownfield migration

**Draft now.**

Capture:

- durable responsibility vs runtime decision authority vs conversation authority vs business approval authority;
- `LEGACY | GU_OS` as decision authority, not transport;
- Case existence does not transfer authority;
- one autonomous decision-maker for the same governed scope;
- human takeover suppresses Gu speaking without automatically pausing the Case;
- pre-effect deterministic authority revalidation;
- generic external conversation binding;
- Traditional Gu outbound WhatsApp seam as preferred initial transport subject to source-audited guarantees;
- fail-safe behavior on authority conflict.

## 16.3 AC-1 / AC-2 ADR granularity

After reviewing ADR-106/107, decide whether to create:

- one combined ADR for **operational gateway + event wake-up + fact-level authority + governed cross-system effects**, or
- two ADRs if repo practice benefits from separating access/eventing from SOR/write consistency.

The architecture directions themselves are already accepted; this is ADR packaging/granularity, not reopening AC-1/AC-2.

## 16.4 Versioned organization policy

ADR if AC-5 is accepted and introduced as a new shared cross-domain infrastructure primitive.

## 16.5 Generic Case relationships

ADR if AC-6 is accepted and full-repo audit confirms a new generic primitive is required.

## 16.6 Economic telemetry

ADR only if AC-10 is accepted and the generic resource ledger creates a durable cross-platform contract; otherwise an Architecture/Technical Plan may suffice.

---
# 17. Brownfield migration strategy

The architecture should migrate responsibility progressively rather than replace Traditional Gu in one cut.

## Stage 0 — Source audit and contract inventory

Verify Traditional Gu source for:

- lead/contact identity;
- org/advisor relationships;
- WhatsApp business-number routing;
- advisor contact endpoints;
- inbound webhook/event IDs;
- human same-thread intervention;
- current follow-up timers;
- appointment reads/writes;
- property reads/search;
- Legacy Deal creation/meaning/write paths;
- concrete transaction/outcome path;
- existing domain APIs/services;
- idempotency/retry/provider correlation;
- outbound WhatsApp endpoint authentication, validation, provider IDs, logging/write-back, idempotency, stage/prod routing and stability.

No live Gu OS authority transfer before the relevant path is understood.

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
| Local Work succeeded, external evidence missing | Reconciliation Work Item |
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

# 21. Technical Plan blockers

Do **not** approve the R1 Technical Plan until the following are resolved enough for implementation:

1. Legacy source audit for WhatsApp/Legacy Lead/Legacy Deal/appointment/property/assignment paths, including the existing outbound messaging endpoint.
2. Accepted organization/membership/identity tenancy ADR.
3. Accepted runtime/conversation authority direction.
4. Accepted operational gateway / SOR / write-consistency direction.
5. Decision on generic Case relationship primitive or confirmation of existing equivalent.
6. Organization policy contract direction.
7. Exact pilot boundary and source systems.
8. S2/S3/S4 behavior sufficiently approved for the slices they affect.
9. Economic telemetry minimum R1 contract.
10. Security/RLS migration strategy for the multi-seat slice.

Not every blocker must be fully implemented before the Technical Plan is written, but the plan must not be forced to invent these governing decisions.

---

# 22. Architecture decision register

## Accepted direction

1. **Operational gateway:** bounded semantic capabilities over fresh Traditional Gu/operational sources; BigQuery remains analytical.
2. **Eventing:** authenticated/idempotent normalized event-driven wake-up + scheduled reconsideration; event/timer ≠ action.
3. **SOR:** fact-level authority; Gu OS owns Opportunity durable lifecycle/interpreted truth while legacy/current systems retain selected operational records; Legacy Deal does not itself define Transaction start.
4. **External effects:** Work-backed bounded commands with pre-effect authority revalidation, idempotency where possible, evidence/postconditions and reconciliation; no distributed ACID or generic mirroring.
5. **Tenancy:** Organization becomes canonical target business/tenant owner for R1 organization-owned work; User is member/actor; staged migration.
6. **ADR-101:** supersede with ADR-106 reflecting current multi-seat and legacy-identity semantics.
7. **Authority:** durable responsibility, runtime authority, conversation authority and business approval authority remain distinct; Case existence does not transfer runtime authority.
8. **WhatsApp/external conversation:** generic external-conversation binding; legacy `lead_id` is opaque external context; prefer reuse/wrapping of Traditional Gu outbound transport subject to source-audited guarantees.

## Recommendations still pending review

9. **Policy:** generic versioned organization policy; NL is authoring interface, published structure is runtime authority.
10. **Case lineage:** generic Case relationship primitive if none exists after full-repo audit.
11. **Relationship truth/projection:** `case_facts` + projections; no CRM-stage abuse of runtime status/current_step.
12. **Work:** situational Case reconsideration + shared Work Items; no fixed future-message queue.
13. **Work Portfolio:** organization-authorized projection over shared truth, not a second SOR.
14. **Economics:** cross-domain resource usage/cost telemetry preserving current append-only AI ledger semantics; billing remains separate.

---
# 23. Open questions that require source audit or later Specs

### Legacy source audit
- What exact service/API already exists for Legacy Lead/message/Legacy Deal/appointment/property reads/writes?
- What stable IDs exist for WhatsApp conversation/message/advisor/business number, and how is the composite legacy `lead_id` constructed/resolved in source code?
- How is same-thread human intervention detected today?
- What exactly happens after the ~10-minute inactivity period?
- How are advisor personal WhatsApp numbers associated with principal/Gu business number?
- What are current idempotency/retry semantics for outbound message/appointment actions?
- Which appointment fields are updated by which actor/path?
- Which property writes must go back to CRM vs Firebase/Ungga?
- Which Legacy Lead assignment events exist and how fresh are they?
- What exactly creates a Legacy Deal, and what downstream state (if any) marks a truly concrete transaction?
- How does the outbound WhatsApp endpoint use and validate the separately supplied `phone_number` and `bot_phone_number` against the corresponding prospect-phone and Gu-phone components of the composite `lead_id`; how is the owner-phone component resolved; and does the endpoint return a provider/message correlation ID?

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
- [x] ADR-101 supersession accepted.
- [x] Legacy vs Gu OS runtime decision authority accepted conceptually.
- [x] Human takeover / conversation authority separation accepted.
- [x] Fact-level SOR/write consistency pattern accepted.
- [ ] Generic organization-policy direction (AC-5) reviewed/accepted.
- [ ] Generic Case relationship direction (AC-6) reviewed/accepted or full-repo audit finds an existing equivalent.
- [ ] Relationship facts/projection vs `current_step` direction (AC-7) reviewed/accepted.
- [ ] Work/evidence-reconciliation reuse and situational wake-up direction (AC-8) reviewed/accepted.
- [ ] Work Portfolio projection principle (AC-9) reviewed/accepted.
- [ ] Generic economic telemetry direction (AC-10) reviewed/accepted.
- [ ] Legacy source-audit checklist assigned before Technical Plan.
- [x] Architecture changes affecting S1 behavior were kept aligned with the approved S1 contract; future behavior changes must return to the owning Spec.

**ADR drafting may proceed now for the accepted cross-cutting decisions.** The Architecture Analysis itself should remain Draft until the remaining AC-5 through AC-10 recommendations are reviewed or explicitly deferred.

---
# 25. Documentation cleanup recommendations

These are documentation-maintenance items, not architecture decisions:

1. Update BigQuery reference wording that currently describes `users_light.organization_id` as a "canonical tenant id" so it is clear that it is the **legacy warehouse tenant/organization key used for current analytics**, not the future canonical Gu OS Organization ID.
2. Keep `_light` names confined to BigQuery/warehouse documentation; do not reuse them when describing Mongo/Firebase operational collections unless source-audited.
3. Prefer the terms **Prospect / Contact**, **Legacy Lead**, **Legacy Deal**, and **Lead Opportunity** in cross-system architecture documents to avoid conflating person identity, legacy records and Gu OS durable responsibility.
4. Preserve BigQuery Skills/references as the preferred source for current SQL mechanics, while the supplemental data catalog remains useful domain documentation for semantics and relationships.

# 26. Change log

| Version / date | Change | Status |
|---|---|---|
| v0.1 / 2026-08-26 | Initial R1 Architecture Analysis grounded in current Gu OS shared-kernel migrations/docs, approved Relationship Operations product directions, multi-seat legacy semantics and S1 lifecycle contract. | Draft for architecture/product review |
| v0.2 / 2026-08-26 | Incorporated supplemental seven-dataset legacy catalog, naming-layer discipline, Prospect vs Legacy Lead vs Lead Opportunity distinction, composite Legacy Lead identity semantics, Legacy Deal ≠ Transaction, and existing Traditional Gu outbound WhatsApp HTTP seam. | Draft for architecture/product review |
| v0.3 / 2026-08-26 | Corrected the outbound WhatsApp audit wording so `lead_id` is treated explicitly as the composite Legacy Lead identifier (`prospect_phone + gu_phone + owner_phone`) rather than as a third independent identity; added terminology guardrails for the three components. | Draft for architecture/product review |
| v0.4 / 2026-08-26 | Consolidated the accepted AC-1 through AC-4 decisions, added event/fact/wake/action separation, fresh-read and concurrency rules, selective writeback/unknown-outcome handling, explicit external-identity bridge semantics, pre-effect authority revalidation, decision-authority-vs-transport distinction, and ADR-106/ADR-107 drafting status. | Draft — AC-1 through AC-4 accepted direction |
