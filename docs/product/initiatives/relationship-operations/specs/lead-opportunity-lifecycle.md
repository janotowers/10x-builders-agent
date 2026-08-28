# Lead Opportunity Lifecycle & Responsibility

> **Version:** v0.3  
> **Status:** Approved — governing S1 behavioral contract; R1 Architecture Analysis complete  
> **Owner / decision owner:** Product / domain leadership  
> **Contributors:** Product, domain, engineering, design, architecture  
> **Initiative:** [Relationship Operations](../brief.md) — R1 Relationship Operations v1  
> **Parent product intent:** [Gu / Gu OS Product Requirements Document](../../../PRD.md)  
> **Initiative Brief:** [Relationship Operations — Initiative Brief](../brief.md)  
> **Companion discovery mapping:** [R1 Concept → Shared Kernel Mapping](../r1-concept-shared-kernel-mapping.md)  
> **Legacy source audit:** [Traditional Gu Legacy Source Audit](../legacy-source-audit.md) — v0.1 complete for R1 Technical-Plan entry  
> **Roadmap:** [Gu OS Evolution Roadmap](../../../../roadmap/gu-os-evolution-roadmap.md) — R1  
> **Doctrine:** [Gu OS Principles & Design Doctrine](../../../../principles/gu-os-principles-and-design-doctrine.md)  
> **Development method:** [Gu OS Agentic Product & Software Development Methodology](../../../../development/agentic-product-software-development-methodology.md)  
> **Architecture Analysis / ADRs:** [R1 Architecture Analysis](../architecture-analysis.md) — v0.12 complete; ADR-101 was reevaluated and superseded by ADR-106. Relevant accepted cross-cutting directions include ADR-106, ADR-107, ADR-108, ADR-109 Generic Case Relationships / Lineage and ADR-110 Resource Usage & Cost Attribution.  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`  
> **Artifact role:** Governing contract for Lead Opportunity admission, identity/continuity, durable responsibility, business viability/progression, closure and reactivation. This Spec does not own implementation design, exact schemas, migration order, model/provider selection, API shapes, or storage mechanisms.

## 1. Summary and decision

R1 Relationship Operations makes Gu durably responsible for keeping a viable buyer/renter opportunity moving toward the best achievable outcome, with visit progression as the first measurable commercial milestone. This Spec defines the behavioral contract for the durable commercial object at the center of that responsibility: the **Lead Opportunity**.

The Spec resolves how a commercial situation becomes eligible for durable responsibility, how Gu decides whether it belongs to an existing Opportunity or a materially distinct new one, how the Opportunity remains open through changing criteria, waiting periods and transaction attempts, and how it closes or reactivates without collapsing business semantics into the generic runtime status of an Operational Case.

Admission is deliberately **hybrid and governed**. Platform hard bounds constrain what may happen. Organization policy defines when the brokerage allows or expects Gu to assume responsibility. Within those bounds, Gu applies contextual semantic judgment to interpret the prospect's actual commercial intent and determine whether the situation warrants durable responsibility and whether it continues an existing Opportunity. Trusted sources may make a situation **eligible for immediate governed admission**, but source membership alone must not mechanically create an Opportunity.

**Approval of this Spec means:** the Lead Opportunity lifecycle and admission/continuity behavior described here become the approved R1 behavior contract that Architecture Analysis and implementation planning must preserve.

**Approval of this Spec does not mean:** approval of a specific database schema, policy JSON shape, workflow graph, prompt, model, API endpoint, CRM/Mongo/Firebase adapter, RLS implementation, merge/split storage mechanism, or UI layout.

## 2. User and business objective

### 2.1 User objective

A brokerage professional should be able to delegate the ongoing responsibility for a buyer/renter opportunity to Gu without manually deciding on every turn whether a lead should be tracked, reopened, split, merged, followed up, or considered dead.

The professional should be able to trust that Gu distinguishes:
- a person/contact from the commercial objective they are pursuing;
- a bounded interaction from durable responsibility;
- evolving criteria within the same objective from a materially different new objective;
- a temporary waiting period from commercial loss;
- business closure from runtime failure;
- transaction progression from the end of the broader relationship responsibility.

### 2.2 Business objective

Reduce opportunity leakage caused by fragmented conversations, inconsistent follow-up and manual pipeline operation while preserving brokerage policy, human authority, source truth and customer relationship quality.

### 2.3 Success signal

A pilot brokerage can show repeated real Opportunity journeys where Gu:
- admits or attaches the correct commercial situations;
- preserves continuity across sessions/events;
- avoids duplicate Opportunities and unnecessary Case creation;
- keeps viable Opportunities open through waits and changed facts;
- closes only on defensible business evidence or explicit authority;
- reactivates or creates a new Opportunity correctly when the prospect returns;
- supports downstream visit progression without requiring a human to operate a rigid CRM funnel.

## 3. Actors, responsibilities, and authority

| Actor / system | Responsibility in this Spec | Authority / limits |
|---|---|---|
| **Prospect / contact** | Expresses needs, intent, changes, pauses, rejection, re-entry and other commercial signals. | Does not directly manipulate Gu OS lifecycle fields; explicit communication is evidence that Gu interprets under applicable policy. |
| **Gu** | Interprets intent/context, judges whether durable responsibility is warranted, resolves likely continuity vs new objective, and proposes/executes allowed lifecycle actions. | Model judgment is not authorization. Gu cannot override platform hard bounds or organization policy and must not invent closure evidence. |
| **Organization / brokerage** | Defines the configurable admission/lifecycle policy within platform bounds and decides how broadly Gu should assume responsibility. | May tighten/configure allowed behavior; may not weaken non-overridable platform/security/privacy constraints. |
| **Assigned advisor / DRI** | Human responsible for the Opportunity where the brokerage operating model assigns one; may supply business knowledge, correct identity/continuity, close/reopen within authority, or take over the relationship. | Assignment does not automatically make every advisor action an approval gate; authority depends on role/policy. |
| **Principal / admin / authorized manager** | May configure organization-level admission/lifecycle policy and resolve protected business exceptions according to role. | Exact role/permission mechanism belongs to Architecture Analysis; legacy `super-admin/admin/vendedor` semantics are not the permanent security model. |
| **Traditional Gu / legacy operating sources** | Current production source for fresh lead/contact/message/appointment/property/account facts during brownfield migration. | Legacy records do not automatically become Gu OS lifecycle truth; source ownership is fact-specific. |
| **Gu OS durable Case runtime** | Holds durable responsibility and runtime execution state once an Opportunity is admitted. | Generic runtime `status` is not the business lifecycle vocabulary. |
| **Transactional / CRM / external systems** | Remain authoritative for declared external records/actions where applicable. | Their records may provide evidence but do not silently redefine Opportunity semantics. |

## 4. Terminology and domain concepts

| Term | Definition in this Spec | Not to be confused with |
|---|---|---|
| **Contact / Prospect** | A person or external identity with whom the brokerage/Gu may interact. | A Lead Opportunity; one contact may have zero, one, or multiple Opportunities over time. |
| **Lead record** | An operational/source-system record representing an inbound or managed prospect context. | The durable Gu OS Lead Opportunity. |
| **Lead Opportunity / Opportunity** | A durable commercial objective/responsibility accepted by Gu on behalf of the brokerage for a prospect, capable of surviving the current interaction. | A contact, transcript, CRM stage, Work Item, or Transaction Case. |
| **Admission** | The governed decision that a commercial situation warrants durable Relationship Operations responsibility, resulting in creation of or attachment to an Opportunity. | Merely receiving a message or creating a lead/contact record. |
| **Bounded interaction** | An interaction Gu may handle without assuming durable responsibility after the current exchange. | A rejected Opportunity; no Opportunity may be needed at all. |
| **Continuity** | The judgment that new information/activity belongs to an existing commercial objective rather than a materially distinct new objective. | Duplicate detection only; continuity may include changed requirements or re-entry after time. |
| **Materially distinct objective** | A different underlying commercial/economic purpose that should be represented by a separate Opportunity. | Normal evolution of criteria within the same search/objective. |
| **Commercial viability** | Whether the underlying objective remains plausibly alive/meaningful based on evidence. | Runtime Case status or current delivery eligibility. |
| **Progression** | Evidence-backed commercially meaningful movement such as meaningful interaction, visit request, visit scheduling/attendance or transaction start. | Mere activity, a property match by itself, or generic runtime state. |
| **Delivery / engagement eligibility** | Whether Gu may or should contact/act toward the prospect at a given time under policy. | Commercial viability. A viable Opportunity may be temporarily non-contactable. |
| **Closure outcome** | Business reason why durable Opportunity responsibility ended correctly. | Runtime `failed`, which represents system/runtime failure. |
| **Reactivation** | Reopening a previously closed Opportunity when the same underlying commercial objective credibly resumes. | A new Opportunity for a materially distinct objective. |
| **Transaction boundary** | The point at which a sufficiently concrete transaction/deal warrants Transaction Operations responsibility. | The visit milestone. A visit is not the domain boundary. |

## 5. Source-status and evidence basis

| Statement / area | Status | Source / evidence |
|---|---|---|
| Relationship Operations responsibility and R1 sequencing | TARGET — APPROVED | Initiative Brief + Roadmap |
| P0-1 hybrid responsibility-based admission direction | TARGET — APPROVED | Initiative Brief v0.9 |
| Contact ≠ Opportunity; multiple concurrent Opportunities only for materially distinct objectives | TARGET — APPROVED | Initiative Brief v0.9 |
| Separation of commercial viability, progression, runtime status, delivery policy and closure outcome | TARGET — APPROVED | Initiative Brief v0.9 |
| Visit is a milestone, not the domain boundary; concrete transaction is the boundary | TARGET — APPROVED | Initiative Brief v0.9 |
| `operational_cases.status` remains generic runtime state | CURRENT — REPO VERIFIED | Operational Cases architecture + shared-kernel mapping |
| Traditional Gu fresh operational data spans Firestore/Mongo/runtime services; BigQuery is analytical/read-only for live R1 decisions | CURRENT — LEGACY SOURCE VERIFIED / REPO VERIFIED by layer | `legacy-source-audit.md` + current Gu OS repo |
| Legacy Firebase identity, principal/advisor organization bridge and mixed `organization_id` representation | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| Legacy Lead `lead_id` ordinary WhatsApp composition and operational-context semantics | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| Same-thread human takeover/resumption, assignment, appointment/visit evidence, Legacy Deal and property source/search semantics | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| Exact Gu OS adapter schemas, event envelopes, identity-binding schema and reconciliation mechanics | OPEN — TECHNICAL DESIGN | Architecture Analysis + `legacy-source-audit.md` |
| Exact policy storage/schema/resolution engine | OPEN — TECHNICAL DESIGN | ADR-108 accepted; exact mechanics remain downstream |
| Exact Case relationship persistence/API representation for merge/split/supersession | OPEN — TECHNICAL DESIGN | ADR-109 accepted; exact mechanics remain downstream |

**Status rule:** source-verified Traditional Gu facts are recorded in `legacy-source-audit.md`. Implementation must still revalidate any legacy contract whose source changes materially before the corresponding adapter is shipped. Absence from inspected evidence remains non-proof of absence.

## 6. Preconditions and triggering context

### 6.1 Preconditions

For a new Opportunity to be created:
- the interaction/event resolves to an admissible organization/tenant context;
- a prospect/contact can be identified sufficiently for durable responsibility or an allowed provisional identity exists under policy;
- platform hard bounds do not prohibit the action;
- organization admission policy allows or expects responsibility for this kind of situation;
- Gu has enough semantic/contextual evidence to determine that a commercial objective probably exists, or an approved organization policy treats a trusted source/event plus its surrounding context as sufficient to make the situation eligible for immediate governed admission;
- continuity resolution does not establish that the situation should attach to an existing Opportunity instead.

For attachment to an existing Opportunity:
- an existing Opportunity candidate is discoverable/authorized;
- the new information is judged to concern the same underlying commercial objective with sufficient confidence/evidence under policy.

### 6.2 Triggering situations

Admission/continuity evaluation may be triggered by:
- a new portal/advertising/referral/WhatsApp inquiry;
- a prospect message revealing or clarifying a commercial objective;
- an imported/assigned operational lead that the organization's policy considers eligible for Gu responsibility;
- a material change in the prospect's expressed objective or criteria;
- re-entry by a known contact after an Opportunity was previously closed or inactive;
- an advisor explicitly asking Gu to take responsibility for a prospect/objective;
- a system event that reveals a likely duplicate or existing Opportunity candidate.

### 6.3 Situations that do **not** by themselves trigger Opportunity creation

- existence of a contact record alone;
- existence of a lead/source record alone when organization policy does not make that source/context eligible for governed admission;
- an ambiguous greeting such as "Hola" with no relevant context;
- a property match without an admitted/viable Opportunity;
- a bounded informational question that leaves no durable commercial responsibility;
- a timer/heartbeat event without an underlying admitted Opportunity;
- a message from a person who is blocked by non-overridable communication/privacy/safety constraints.

## 7. Scope

### 7.1 In scope

- Lead Opportunity definition and durable-responsibility boundary.
- Admission decision outcomes.
- Platform bounds vs organization policy vs Gu contextual judgment.
- Admission-policy authoring behavior at the product-contract level.
- Contact-to-Opportunity cardinality.
- Continuity vs materially distinct objective.
- Duplicate, merge/split and correction behavior at the semantic level.
- Commercial viability vs progression vs delivery eligibility vs runtime state.
- Temporary hold/wait behavior.
- Closure outcomes and evidence discipline.
- Transaction boundary.
- Reactivation vs new Opportunity.
- Human correction/override of lifecycle decisions with traceability.
- Acceptance scenarios for deterministic and model-mediated lifecycle behavior.

### 7.2 Non-goals

- Exact follow-up/messaging decision logic after an Opportunity exists (S2).
- Exact matching/Shared Inventory and visit progression behavior beyond lifecycle implications (S3).
- Work Portfolio UX and multi-advisor supervisory behavior beyond identity/authority implications (S4).
- Database/table/enum design.
- Policy JSON/schema/storage/UI component design.
- Exact identity-resolution algorithm or embedding/model choice.
- Legacy Mongo/Firebase/WhatsApp API implementation.
- Transaction Operations internal lifecycle.
- Billing/credits policy.
- Full organization/team administration.
- Broad CRM pipeline/stage management.

## 8. Behavioral contract

### 8.1 Core invariants

1. **Contact is not Opportunity.** A person may exist without any active Opportunity and may have multiple Opportunities only when they represent materially distinct commercial objectives/economic contexts.
2. **Interaction is not admission.** Gu may converse, clarify or answer bounded questions without creating a durable Case.
3. **Admission is governed.** Platform hard bounds are non-overridable; organization policy defines when Gu may/should assume responsibility; Gu interprets the concrete situation inside those bounds.
4. **Model judgment is not authority.** High confidence cannot bypass a policy, permission, opt-out/communication restriction, tenant boundary or other hard gate.
5. **Admission resolves continuity before creation.** An admissible situation must attach to an existing Opportunity when it is materially the same objective; new Case creation is for materially distinct objectives.
6. **Changing criteria normally update the existing Opportunity.** Budget, zone, property type, timing and other constraints may evolve without creating a new Opportunity when the underlying commercial purpose remains continuous.
7. **Business lifecycle dimensions remain separate.** Commercial viability, progression, delivery eligibility and runtime engine status must not be collapsed into one funnel/stage field.
8. **Inactivity is not loss by default.** Lack of recent response alone does not prove that an Opportunity is `lost`.
9. **Business `lost` is not runtime `failed`.** A correctly closed lost Opportunity may end with runtime completion.
10. **A visit is a milestone, not the Relationship/Transaction domain boundary.**
11. **Transaction start does not automatically close the Opportunity.** The Opportunity remains linked until the broader objective is achieved/lost or otherwise closed with sufficient evidence.
12. **Correction is auditable.** Human merge/split/close/reopen/continuity corrections must preserve traceability rather than rewriting history invisibly.

### 8.2 Admission decision outcomes

Admission evaluation must be able to result in at least four product-level outcomes:

| Outcome | Required meaning | Typical example |
|---|---|---|
| **CREATE NEW OPPORTUNITY** | Durable responsibility is warranted and no existing Opportunity represents the same objective. | New buyer inquiry for a first home. |
| **ATTACH / CONTINUE EXISTING OPPORTUNITY** | Durable responsibility exists already; new signal belongs to the same underlying objective. | Same buyer raises budget and adds another zone. |
| **CONTINUE BOUNDED INTERACTION / CLARIFY** | Gu may engage, but evidence/policy is insufficient to assume durable responsibility yet. | "Hola" or an ambiguous property question. |
| **DO NOT ADMIT** | Durable responsibility is not permitted, not commercially meaningful, invalid, or outside policy. | Spam/test/blocked contact/out-of-scope situation. |

The Spec does not require these exact enum strings in implementation.

### 8.3 Admission decision sequence

The required behavioral sequence is:

```text
incoming signal / interaction / event
        ↓
non-overridable platform bounds
        ↓
organization admission policy
        ↓
Gu contextual/semantic judgment
        ↓
durable responsibility warranted?
        ↓
continuity / identity resolution
        ↓
CREATE NEW | ATTACH EXISTING | CLARIFY | DO NOT ADMIT
```

The layers are not interchangeable:
- platform bounds define what may not be weakened;
- organization policy defines configurable business preference/expectation;
- Gu interprets meaning and context;
- deterministic/governed mechanisms enforce authorization, tenant, dedup identities where mechanically knowable, and approved policy execution.

### 8.4 Organization admission policy

#### 8.4.1 Product design principle

R1 should not force organizations either to program a rules engine or to author all policy from an empty free-text box.

The preferred product contract is:

> **Recommended defaults + a small set of structured high-value controls + natural-language customization compiled into a reviewed structured policy.**

Natural language is an **authoring interface**, not raw runtime authority.

#### 8.4.2 Policy authoring and inspection experience

Policy authoring should be **conversation-first with Gu** while remaining inspectable and governable through an organization configuration surface.

The conceptual authoring flow is:

```text
authorized user natural-language instruction
        ↓
Gu interprets intended policy
        ↓
structured policy proposal
        ↓
human-readable "This is what I understood"
        ↓
representative examples / boundary cases
        ↓
authorized human confirms or edits
        ↓
versioned organization policy becomes active
```

A raw instruction such as "be flexible with my good leads" must not silently become production authority without clarification/confirmation.

The product should also expose an inspectable organization policy surface where authorized users can understand:
- the current active policy;
- recommended/default behavior;
- high-value structured controls;
- additional organization-specific instructions;
- the effective interpretation Gu will apply;
- relevant version/change history where needed for audit or troubleshooting.

Conversation is the preferred authoring interface; Settings/configuration is the durable **inspection and control surface**. The user should not need to reconstruct current policy from an old conversation.

#### 8.4.3 Recommended default behavior

R1 should ship with one useful **Recommended** policy baseline plus an explicit **Customize** path. The product should not require policy authoring before first value, and R1 should not introduce multiple artificial presets such as "Conservative / Balanced / Proactive" until customer evidence shows that those clusters are real and useful.

Approved R1 default behavior:

- trusted/identifiable portal, campaign, referral or property inquiry with context that sufficiently establishes buy/rent intent: **eligible for immediate governed admission**; Gu still resolves platform bounds, organization policy, continuity and `CREATE` vs `ATTACH`;
- WhatsApp/direct inquiry with sufficiently clear commercial intent in message + context: Gu may admit under policy;
- short messages such as "¿sigue disponible?" or "¿precio?" may be sufficient when the surrounding campaign/listing context makes commercial intent reasonably clear; the text alone is not the only semantic evidence;
- ambiguous message with insufficient intent, such as an isolated "Hola": clarify before admission;
- changed criteria within the same underlying objective: continue the existing Opportunity;
- materially distinct objective that can progress independently: create a separate Opportunity;
- obvious spam/test/known duplicate or non-overridable blocked/unauthorized context: do not create a normal active Opportunity.

**Admission does not require full qualification.** Missing budget, zone, timing, financing or other qualification fields may themselves become work inside an admitted Opportunity when the commercial responsibility is already clear enough.

#### 8.4.4 Configurable organization choices

Under the **Recommended + Customize** model, organization policy may, within platform bounds, configure/tighten a small number of high-value behaviors such as:
- which inbound sources are trusted enough for immediate admission;
- whether a source event itself is sufficient or Gu must first confirm intent;
- which business lines/property/operation types Gu may assume responsibility for;
- whether selected high-value contexts may admit with fewer known qualification fields;
- whether certain categories require human confirmation before durable responsibility begins;
- whether organization-specific criteria should bias toward continuation vs new Opportunity in ambiguous cases;
- stricter internal requirements for closure/reopen authority.

Organization policy must not become a substitute for semantic interpretation of every message.

#### 8.4.5 Non-overridable bounds

Organization configuration and Gu judgment must not:
- cross tenant/organization authorization boundaries;
- treat model confidence as permission;
- bypass applicable communication/privacy/safety restrictions;
- create or attach an Opportunity to an unauthorized contact/organization;
- silently disclose prospect data across brokerages;
- erase provenance or audit history;
- declare business outcomes unsupported by required evidence.

#### 8.4.6 Ambiguity rule

When policy permits a range of outcomes but semantic evidence is insufficient, Gu should prefer:
1. safe bounded clarification;
2. targeted human input when needed;
3. conservative continuity/creation behavior that avoids irreversible duplication or unauthorized effects.

Gu should not manufacture certainty merely to force an admission decision.

### 8.5 Opportunity continuity and cardinality

#### 8.5.1 General rule

> **An existing Opportunity should continue when new activity represents evolution, resumption or another path toward the same underlying commercial objective. A new Opportunity should be created when the new objective can meaningfully progress, close, or be economically evaluated independently from the existing one. Field changes, channel changes, property count or elapsed time are signals—not deterministic boundaries.**

Gu should reason about continuity using four semantic tests:

1. **Underlying purpose** — Is the practical/economic purpose still the same?
2. **Decision independence** — Could one objective close while the other remains active?
3. **Work independence** — Do they require sufficiently distinct matching, follow-up, evidence, stakeholders or next work to be responsibly managed separately?
4. **Outcome attribution** — Would combining them materially distort whether the brokerage achieved, lost or partially progressed the responsibility?

Examples likely to remain the same Opportunity:
- budget, zone, timing, bedrooms or property-type preferences change within the same home-search objective;
- the prospect considers renting instead of buying as an alternative path to solve the same housing need;
- the prospect discusses many properties within one search;
- the same objective appears through another channel/source;
- the same search resumes after a temporary hold;
- Guadalajara vs CDMX are alternatives inside one relocation decision.

Examples likely to justify a new Opportunity:
- primary-residence purchase vs a separate investment-property purchase;
- a purchase for self vs a separate property for a child when the decisions can progress independently;
- two independent acquisitions in different cities with separate budgets, teams or decision cycles;
- unrelated buyer and renter objectives that are not alternative paths to the same need.

A request to acquire multiple assets does not automatically imply multiple Opportunities. For example, "buy three rental apartments as one investment mandate" may remain one Opportunity if the assets are part of one portfolio objective; separate capital/decision cycles may justify separate Opportunities.

These are semantic examples, not exhaustive deterministic rules.

#### 8.5.2 One contact, multiple Opportunities

Multiple concurrent Opportunities for one contact are allowed only when they are materially distinct enough that:
- each can progress independently;
- each may have different requirements/evidence/next work;
- closing one would not logically close the other;
- treating them as one would materially distort responsibility or outcome tracking.

The product must not create a new Opportunity merely because:
- a new message thread appears;
- a different property is discussed;
- a search criterion changes;
- an existing Opportunity is temporarily quiet.

#### 8.5.3 Continuity uncertainty

If Gu cannot confidently distinguish continuation from a new objective:
- prefer conservative continuity or bounded clarification over irreversible duplicate creation where practical;
- preserve the known existing Opportunity unless evidence materially supports independence;
- clarify with the prospect or request targeted human input when the distinction affects responsibility, authority, work separation or outcome attribution;
- record the uncertainty/evidence needed for later correction.

### 8.6 Duplicate, merge, split and correction semantics

#### Duplicate

If two Cases are determined to represent the same underlying objective:
- one should remain canonical for ongoing responsibility;
- the other should close/relate as duplicate rather than disappear;
- facts/evidence that matter must remain traceable;
- implementation must not silently discard history.

#### Merge

A human or governed process may determine that two previously separate Opportunities actually represent one objective. Product behavior must preserve lineage and ensure only one responsibility root remains active for that objective.

#### Split

A previously single Opportunity may be split when evidence shows that it actually contains multiple materially distinct objectives that should progress independently. Relevant facts/commitments/evidence must remain attributable.

Exact relationship tables, identifiers and migration mechanics are architecture decisions.

### 8.7 Business lifecycle dimensions

R1 must represent these as conceptually separate dimensions:

| Dimension | Question it answers | Example |
|---|---|---|
| **Durable responsibility** | Does Gu/the brokerage still own responsibility for this Opportunity? | Open vs closed responsibility. |
| **Commercial viability** | Is the objective still plausibly alive? | Viable, uncertain, explicitly ended. |
| **Progression** | What commercially meaningful evidence has occurred? | Meaningful interaction, visit requested, visit attended, transaction started. |
| **Delivery / engagement eligibility** | May/should Gu contact or act toward the prospect now? | Contact allowed, wait until November, human-active suppression. |
| **Runtime status** | What is the durable engine doing technically? | `active`, waiting states, `paused`, `completed`, `failed`. |

No single CRM-style `stage` may be treated as the sole truth for all five questions.

### 8.8 Temporary hold / future contact

If a prospect says, for example, "contact me in three months":
- the Opportunity may remain commercially viable and open;
- delivery/engagement policy must respect the requested wait;
- the runtime should remain capable of waking at/around the appropriate future time;
- `paused` should not be used merely because external contact is deferred if automatic reconsideration is still expected;
- an earlier internal event may trigger reconsideration, but it must not automatically override the delivery restriction.

### 8.9 Progression model

R1 recognizes evidence-backed milestones such as:

```text
Opportunity admitted
→ Meaningful interaction
→ Visit requested
→ Visit scheduled
→ Visit attended
→ Post-visit progression
→ Transaction started
```

This is **not** a mandatory linear funnel. Real Opportunities may:
- move backward in requirements;
- have multiple visits;
- cancel/reschedule;
- return to matching;
- remain open after transaction failure.

Property matching by itself is an actionable input, not commercial progression.

Whether any of these milestones map to generic `current_step` is an Architecture/Technical decision; the Spec does not require a rigid workflow state machine.

### 8.10 Closure outcome, reason and evidence

R1 uses a small stable **closure outcome** taxonomy, with a separate **closure reason** and supporting **closure evidence**.

```text
closure_outcome
= stable business result category

closure_reason
= more specific explanation

closure_evidence
= why Gu / the brokerage can assert it
```

Approved product-level closure outcomes:

| Closure outcome | Meaning |
|---|---|
| **`objective_achieved`** | The Opportunity's intended commercial objective was successfully fulfilled through the brokerage or an authorized network path attributable to this Opportunity. |
| **`lost`** | The Opportunity was valid but ended without the brokerage/authorized Opportunity path achieving the intended commercial result. |
| **`invalid`** | The Case should not have represented a valid Opportunity (spam, test, erroneous admission, etc.). |
| **`duplicate`** | The same objective is represented by another canonical Opportunity. |
| **`superseded`** | Responsibility was intentionally replaced by another durable structure/Opportunity for a reason other than simple duplicate correction. |

Examples:

```text
closure_outcome = objective_achieved
closure_reason  = linked_transaction_closed
closure_evidence = verified transaction outcome
```

```text
closure_outcome = lost
closure_reason  = achieved_elsewhere
closure_evidence = explicit prospect statement
```

```text
closure_outcome = lost
closure_reason  = decided_not_to_move
closure_evidence = explicit prospect statement
```

A prospect saying "I already bought with another brokerage" means the person's broader need may have been satisfied, but **this Opportunity's commercial outcome is `lost`**, not `objective_achieved`.

The exact controlled vocabulary for `closure_reason` may evolve with evidence and should not be inflated into dozens of top-level closure outcomes.

#### Closure rules

- Inactivity alone must not automatically produce `lost`.
- `inactive`, `unresponsive`, `cold`, `paused` and similar operating conditions are not top-level closure outcomes.
- A "no response" period may change attention/delivery strategy without proving business closure.
- Explicit prospect/advisor evidence may support closure when admissible under policy.
- Business `lost` may correctly end with generic runtime `completed`; it is not runtime `failed`.
- Runtime `failed` remains for fatal runtime/system failure or an unrecoverable execution condition, not commercial loss.
- Human close/reopen actions must be traceable.

### 8.11 Transaction boundary

> **Visit is a milestone, not the Relationship/Transaction domain boundary. A concrete transaction is the boundary.**

When a sufficiently concrete transaction begins:
- Transaction Operations may start a linked Transaction Case/responsibility;
- the Lead Opportunity remains linked and does not close solely because the transaction exists;
- if the transaction fails commercially, Relationship Opportunity work may resume;
- if the transaction succeeds with sufficient evidence and satisfies the underlying objective, the Opportunity may close `objective_achieved`.

Exact criteria for "transaction started" belong partly to the future Transaction Spec/domain and current source observability.

### 8.12 Reactivation vs new Opportunity

A closed Opportunity may reactivate when:
- the same underlying commercial objective credibly resumes;
- there is credible continuity of the prior **decision context**, not merely similar superficial criteria;
- the prior context/evidence remains meaningfully relevant;
- reopening is permitted by policy and does not conflict with a later canonical Opportunity.

A new Opportunity should be created when the returning contact is pursuing a materially distinct or genuinely new decision cycle, even if the new search superficially resembles an old one.

For example:
- a three-month pause followed by resumption of the same home search can be a reactivation;
- a new search years later caused by a new marriage, job, family need or investment cycle is normally a new Opportunity even if the city, budget or property type resembles the old one.

> **Similarity of criteria is not sufficient for reactivation. Reactivation requires credible continuity of the prior commercial decision context.**

Reactivation must preserve closure and reopen history; it must not rewrite the earlier closure as if it never occurred.

### 8.13 Model judgment vs deterministic guarantees

| Concern | Model / Skill may judge | Deterministic / governed mechanism must guarantee |
|---|---|---|
| Commercial intent interpretation | Whether the prospect appears to be buying/renting, clarifying, browsing, etc. | Authorized tenant/context; valid tool/capability contract. |
| Durable-responsibility judgment | Whether the situation meaningfully extends beyond the current interaction. | Non-overridable policy bounds; approved organization policy version. |
| Continuity vs new objective | Semantic similarity/difference of objectives and economic context. | Candidate lookup is tenant-scoped; duplicate/relationship writes are authorized/auditable. |
| Ambiguous re-entry | Whether a prior closed Opportunity likely matches the current intent. | Reopen/create operation is idempotent/authorized and preserves lineage. |
| Commercial viability inference | Contextual interpretation of explicit and implicit evidence. | Closure cannot be mechanically claimed without admissible evidence/policy. |
| Closure recommendation | Whether evidence suggests lost/achieved/invalid/etc. | Protected closure authority/evidence requirements; no silent last-write-wins. |
| Source text / natural-language policy | Interpret user-authored intent into structured policy proposal. | Raw prose does not become runtime authority until validation/confirmation/publication. |
| Role/authority ambiguity | May identify that human input is needed. | Role/permission enforcement and tenant isolation are deterministic/governed. |

### 8.14 Human involvement and authority

| Situation | Human role | Required mode | Why |
|---|---|---|---|
| Routine clear admission under approved org policy | None required | Autonomous | Low-risk responsibility creation within policy. |
| Ambiguous continuity with material downstream consequence | Advisor/domain input | Targeted input or review | Human may know whether objectives are actually distinct. |
| Suspected duplicate/merge/split with conflicting evidence | Advisor/authorized operator | Review/correction proportional to impact | Prevent loss/misattribution of responsibility. |
| Explicit close/reopen by authorized advisor | Business decision | Act / act+inform according to role | Human business authority may be decisive. |
| Policy change | Authorized org admin/principal | Explicit confirmation | Changes future behavior for the organization. |
| Raw natural-language policy interpretation | Authorized org admin/principal | Confirm interpreted structured policy before activation | Model interpretation must not silently become authority. |
| Platform/privacy/tenant restriction | No bypass | Deterministic deny/fail-closed | Not subject to business discretion. |

### 8.15 Data, evidence, provenance and freshness

| Business claim / outcome | Required evidence or admissible source | Freshness requirement | If missing / conflicting |
|---|---|---|---|
| Prospect identity/contact binding | Authorized legacy/source identity, channel identity, advisor confirmation, or future canonical identity mapping | Fresh enough for current routing | Do not cross-link on weak identity alone; reconcile. |
| Commercial objective | Prospect messages, advisor input, qualified source event, or derived interpretation with provenance | Current enough to represent present intent | Clarify or mark uncertainty. |
| Requirements change | Prospect/advisor/current source evidence | Prefer current/near-real-time for active work | Preserve prior claim + superseding evidence. |
| Explicit stop / no longer searching | Prospect statement or authorized advisor-confirmed business evidence | Current | Do not infer from silence alone. |
| Objective achieved | Verified transaction/outcome evidence or other accepted authoritative evidence | Sufficiently current and specific | Remain open/uncertain; reconcile. |
| Duplicate / continuity | Identity/objective evidence, prior Case facts, conversation/source context, human correction | Current enough to avoid duplicate active work | Preserve both until resolved if necessary. |
| Temporary contact restriction | Explicit prospect instruction or governed policy | Must be honored until changed/expired | Do not override because of a new match. |

Rules:
- Positive evidence may establish a fact when the source is admissible.
- Absence of evidence is not negative evidence unless the source contract explicitly supports that inference.
- Conflicting claims preserve provenance and require reconciliation; generic last-write-wins is not sufficient.
- Conversation/model interpretation may produce a derived claim but does not automatically override authoritative source evidence.

### 8.16 External effects and commitments

Admission/continuity lifecycle actions may result in durable Case creation/attachment and later downstream work, but this Spec does not itself authorize prospect messaging, appointment creation or cross-brokerage data sharing.

Required product guarantees:
- duplicate/retry processing must not create multiple active Opportunities for the same admitted event/objective when the system can deterministically identify the same request;
- creating/attaching/closing/reopening must leave evidence/auditability;
- lifecycle correction must not silently erase prior responsibility/evidence;
- admission does not imply authorization to contact immediately when delivery policy blocks it.

## 9. Happy paths

### HP-01 — Trusted portal inquiry is eligible for immediate governed admission

**Given**
- an identifiable prospect sends a valid inquiry through a source configured by the organization for direct eligibility;
- the message clearly concerns buying/renting;
- no hard bound blocks the prospect;
- no existing Opportunity represents the same objective.

**When**
- Gu evaluates admission.

**Then**
- Gu resolves hard bounds, organization policy and continuity;
- because no existing Opportunity represents the objective, Gu creates one without requiring full qualification first;
- the original source/intent evidence and policy context are preserved;
- the Opportunity can continue across later sessions/events.

### HP-02 — Ambiguous greeting remains bounded

**Given**
- a known or unknown contact sends only "Hola";
- no current context establishes a commercial objective.

**When**
- Gu responds.

**Then**
- Gu may clarify intent;
- no Opportunity is required yet;
- if later context establishes a commercial objective and policy permits it, admission is reevaluated.

### HP-03 — Criteria change preserves continuity

**Given**
- an existing Opportunity is "buy a primary residence in Zapopan";
- the prospect raises budget and changes preferred zones.

**When**
- Gu interprets the new message.

**Then**
- the existing Opportunity remains canonical;
- requirements are updated with provenance;
- a new Opportunity is not created merely because the criteria changed.

### HP-04 — Separate investment objective creates second Opportunity

**Given**
- the same contact has an active primary-residence purchase Opportunity;
- the contact independently starts looking for an investment apartment with a different budget/purpose.

**When**
- Gu interprets the new objective.

**Then**
- Gu may create a second Opportunity if organization policy allows;
- both can progress independently;
- closing one does not close the other.

### HP-05 — Future-contact request keeps Opportunity alive

**Given**
- the prospect remains interested but says "contact me in three months."

**When**
- Gu updates the Opportunity.

**Then**
- commercial viability may remain positive;
- delivery/contact is deferred;
- the Opportunity remains wakeable for future reconsideration;
- runtime `paused` is not required solely because contact is deferred.

### HP-06 — Transaction failure returns to Relationship progression

**Given**
- a concrete transaction started from the Opportunity;
- the transaction later fails commercially;
- the prospect remains interested in finding another property.

**When**
- the transaction outcome becomes known.

**Then**
- the Lead Opportunity remains/re-becomes active for relationship progression;
- prior transaction history remains linked;
- a new Opportunity is not required if the underlying objective remains the same.

### HP-07 — Same objective returns after closure

**Given**
- an Opportunity was previously closed;
- the same contact credibly resumes the same underlying objective.

**When**
- Gu resolves continuity.

**Then**
- the existing Opportunity may reactivate under policy;
- the earlier closure remains visible in history;
- the system does not pretend the Opportunity was continuously open.

## 10. Unhappy, ambiguous, and edge cases

| ID | Situation | Required behavior | Forbidden shortcut |
|---|---|---|---|
| EC-01 | Ambiguous message with no clear objective | Clarify in bounded interaction. | Create a Case solely because a message exists. |
| EC-02 | Organization policy conflicts with platform hard bound | Platform bound wins; deny/avoid prohibited action. | Let org preference or model confidence override the hard bound. |
| EC-03 | Gu thinks a lead is high-value but org policy excludes the category | Do not admit automatically; follow configured/human path. | Admit because the model predicts high conversion. |
| EC-04 | Same prospect appears through a second channel/source | Resolve identity/objective continuity before creating another Opportunity. | Create one Opportunity per channel. |
| EC-05 | Criteria change is substantial but purpose is probably same | Prefer continuity; clarify if distinction materially affects work. | Split automatically on large field changes. |
| EC-06 | Two existing Cases appear duplicate | Preserve both until canonical resolution; relate/merge with traceability. | Delete one and discard history. |
| EC-07 | Prospect is silent for a long period | Adjust attention/delivery/reconsideration under policy. | Mark `lost` solely because N days elapsed. |
| EC-08 | Prospect says "don't contact me until November" | Preserve viability separately from delivery restriction. | Mark lost or override the restriction because new inventory appears. |
| EC-09 | Prospect explicitly says they already bought elsewhere | Evaluate admissible closure evidence; likely `lost` or outcome-specific closure according to final vocabulary. | Keep autonomous follow-up running indefinitely. |
| EC-10 | Transaction starts | Link/shift downstream responsibility as appropriate. | Close Lead Opportunity merely because a deal record exists. |
| EC-11 | Transaction fails | Resume/continue Relationship work if objective remains alive. | Create a brand-new Opportunity automatically. |
| EC-12 | Raw NL policy is vague ("be aggressive with serious leads") | Ask/compile into structured interpretable policy and confirm. | Execute vague prose as direct runtime authority. |
| EC-13 | Policy update is being edited while events arrive | Continue using the currently active approved policy until the new version is confirmed/published. | Apply half-authored policy. |
| EC-14 | Identity match is uncertain and could cross organizations | Fail closed / ask for resolution. | Attach based on weak similarity across tenant boundary. |
| EC-15 | Human corrects Gu's continuity decision | Apply authorized correction with provenance and downstream reconciliation. | Hide the original decision/evidence. |

## 11. Acceptance scenarios

| ID | Given | When | Then | Required evidence / verifier |
|---|---|---|---|---|
| AC-01 | Clear contextual portal buy/rent inquiry, trusted source, no existing objective | Admission runs | Situation is eligible for governed admission; after continuity resolution one new Opportunity is created once | Scenario fixture + durable Case/evidence record |
| AC-02 | Ambiguous "Hola" with no context | Gu engages | No Opportunity yet; clarification allowed | Scenario/eval |
| AC-03 | Existing Opportunity; budget/zone changes | Continuity evaluation | Same Opportunity; facts supersede/update | Scenario + Case facts/provenance |
| AC-04 | Existing home search; separate investment search | Continuity evaluation | Two distinct Opportunities may coexist | Scenario/eval + Case relationship/identity evidence |
| AC-05 | Same event delivered twice | Admission runs twice | One effective Opportunity/admission outcome | Idempotency/integration test |
| AC-06 | Org policy permits auto-admission but platform bound blocks contact/responsibility | Admission runs | Hard bound wins | Deterministic policy/permission test |
| AC-07 | Org admin enters vague NL policy | Policy authoring | Gu shows interpreted structured proposal/examples; policy not active until confirmation | Product scenario + policy-version evidence |
| AC-08 | Prospect says "contact me in 3 months" | Opportunity updates | Open/viable responsibility may remain; delivery deferred; future wake-up possible | Scenario + policy/runtime evidence |
| AC-09 | 90 days silence, no closure evidence | Reconsideration runs | Opportunity is not automatically `lost` | Scenario test |
| AC-10 | Explicit evidence objective ended unsuccessfully | Closure evaluated | Business closure may be `lost`; runtime may complete rather than fail | Scenario + closure evidence |
| AC-11 | Transaction starts | Boundary evaluated | Linked Transaction responsibility may begin; Lead Opportunity does not auto-close | Scenario/integration contract |
| AC-12 | Transaction fails and prospect keeps searching | Outcome arrives | Existing Opportunity resumes/continues | Scenario |
| AC-13 | Closed Opportunity resumes same objective | Re-entry evaluation | Reactivation possible with history preserved | Scenario + lifecycle history |
| AC-14 | Closed Opportunity returns with materially different objective | Re-entry evaluation | New Opportunity created | Scenario/eval |
| AC-15 | Suspected duplicate with conflicting facts | Resolution occurs | One canonical active responsibility; lineage/history retained | Scenario + audit evidence |
| AC-16 | Human corrects Gu's new-vs-existing judgment | Authorized correction | Case linkage/merge/split outcome updates and remains traceable | Integration + audit evidence |

### Acceptance quality bar

S1 is not accepted merely because the common admission path works. Verification must cover:
- semantic ambiguity;
- organization-policy variation;
- non-overridable hard bounds;
- duplicate/retry behavior;
- continuity vs distinct objectives;
- long inactivity;
- temporary contact holds;
- closure evidence;
- transaction start/failure;
- reactivation;
- human correction;
- tenant/identity uncertainty.

## 12. User experience / supervisory surface

S1 does not own the final Work Portfolio UI, but the lifecycle must be understandable to humans.

### 12.1 Admission policy configuration

The minimum product experience should:
- start with one **Recommended** policy baseline plus **Customize**, rather than a blank configuration canvas or multiple unproven presets;
- expose a small number of understandable high-value controls;
- allow natural-language additions/refinements conversationally through Gu;
- show Gu's interpretation before activation;
- provide representative examples/boundary cases;
- require appropriate authorization to activate organization policy;
- expose the current policy in an inspectable organization Settings/configuration surface;
- allow later review of which policy version influenced an admission when needed for troubleshooting/audit.

### 12.2 Opportunity lifecycle explanation

When a user inspects/corrects an Opportunity, Gu/supervisory surfaces should be able to explain in business language:
- why this was considered an Opportunity;
- whether it was created vs attached to an existing objective;
- current objective and materially relevant changes;
- whether the Opportunity is viable/open/temporarily waiting/closed;
- why it was closed/reopened or considered duplicate;
- what evidence/policy drove the decision.

The user should not need to operate low-level runtime fields to manage normal lifecycle behavior.

## 13. Observability, outcome, and economic telemetry

### 13.1 Operating evidence

At minimum R1 should be able to measure:
- admission evaluations;
- create vs attach vs clarify vs do-not-admit outcomes;
- admission source and active organization policy version;
- Gu semantic decision with bounded reason/evidence metadata suitable for debugging/eval;
- duplicate/merge/split/reactivation corrections;
- closure/reopen events and evidence sources;
- human corrections of Gu lifecycle judgments;
- policy interpretation/confirmation failures;
- retry/idempotency anomalies.

### 13.2 Business / outcome evidence

Useful downstream measures include:
- admitted Opportunities by source;
- percentage that reach meaningful interaction;
- visit request/scheduled/attended outcomes;
- transaction starts;
- reactivation;
- opportunity leakage/recovery patterns;
- human corrections per admission/continuity decision.

Conversion outcomes must be interpreted with source/market/advisor/inventory context rather than treated as proof of lifecycle correctness by themselves.

### 13.3 Resource / cost correlation

Material resource usage involved in admission/continuity evaluation should be correlatable to the appropriate account/organization, Case/Opportunity and Work/attempt context where causally defensible.

Internal cost-to-serve remains separate from customer pricing/credits/wallet behavior.

## 14. Security, privacy, tenancy, and data-sharing behavior

- Admission/continuity lookup must be organization/tenant-authorized before candidate data is exposed to Gu/model context.
- One organization's policy cannot authorize access to another organization's private prospects.
- Legacy `organization_id` is an external/legacy key, not the permanent Gu OS security boundary.
- Cross-brokerage Shared Inventory eligibility does not imply cross-brokerage prospect identity/data-sharing authority.
- `profiles.is_ungga_admin` or future platform-staff authority is distinct from brokerage roles.
- Ambiguous identity that could cross organization boundaries must fail closed or require resolution.
- Policy configuration requires an authorized organization role.
- Model interpretation must receive only the minimum authorized context necessary for the decision.

## 15. Verification expectations

| Behavior type | Minimum expected verification |
|---|---|
| Deterministic platform bounds / permission / tenant checks | Unit/integration tests; fail-closed fixtures |
| Idempotent admission / duplicate event processing | Integration tests with duplicate/retry delivery |
| Model-mediated commercial intent / continuity judgment | Representative eval/scenario set with explicit rubric |
| NL policy interpretation | Eval set covering vague, contradictory, overly broad and unsafe instructions |
| Policy precedence | Deterministic scenarios proving platform > org configuration > contextual judgment |
| Closure/hold/reactivation | Acceptance scenarios + durable state/provenance checks |
| Human correction / merge/split semantics | Integration/replay scenarios with audit evidence |
| Brownfield legacy event path | Source-verified integration tests before live authority transfer |
| Production pilot | Shadow comparison → assisted → selective autonomy with monitored correction/error rates |

**Independent verification:** before live autonomous admission for pilot traffic, use deterministic tests for hard bounds/idempotency plus an eval/replay set reviewed independently from the implementation pass. High-risk tenancy/identity scenarios require explicit security review.

## 16. Architecture dependencies and structural-resolution status

The questions below are preserved because they explain which structural contracts S1 depends on. Architecture Analysis v0.12 has resolved their **architecture direction**, including the completed Case↔Case audit, accepted ADR-109/ADR-110 and the minimum Traditional Gu legacy source audit. Remaining work is downstream Specs or Technical Design as indicated. This status alignment does not change S1 behavior.

| ID | Question / dependency | Why it matters to behavior | Current owning artifact / status |
|---|---|---|---|
| A1 | What fresh operational gateway/capabilities will expose lead/contact/message context from Traditional Gu? | Admission cannot depend on ~8h warehouse freshness for live interactions. | Architecture direction accepted; minimum Traditional Gu source contract is verified in `legacy-source-audit.md`; exact gateway/API mechanics remain Technical Design. |
| A2 | What fact-level SOR/provenance/write-back contract applies to identity, lead, Opportunity and closure facts? | Prevents duplicate truth and stale overwrites. | Architecture direction accepted: fact-level/domain-aware authority + selective governed write-back; source roles are clarified by `legacy-source-audit.md`; exact field matrix/idempotency/reconciliation remain Technical Design. |
| A3 | How are legacy users/`organization_id` mapped to first-class Gu OS organization/membership/seat identity? | Admission policy and candidate lookup must be tenant-correct. | **ADR-106 accepted**; legacy Firebase/org semantics are source-verified; exact schema/RLS/backfill/identity mapping remains Technical Design. ADR-101 is superseded. |
| A4 | What generic Case relationship/lineage primitive represents duplicate/merge/split/supersession/Transaction linkage? | S1 requires traceable continuity correction without Relationship-local runtime hacks. | **ADR-109 accepted** after full-repo audit confirmed no adequate first-class generic primitive; exact persistence/API/vocabulary mechanics remain Technical Design. |
| A5 | How are organization admission policies represented, versioned, validated, published and resolved? | Raw NL cannot be runtime authority; policy version must be auditable. | **ADR-108 accepted**; exact schema/resolver/authorization/activation mechanics remain Technical Design. |
| A6 | What authority model governs advisor corrections, close/reopen, human takeover and organization-policy changes? | Product behavior depends on actor authority without hardcoding legacy roles. | **ADR-107 accepted** for durable/runtime/conversation/approval authority separation; legacy takeover/resumption behavior is source-verified; exact Gu OS role grants/resolver mechanics remain Technical Design. |
| A7 | How is WhatsApp/channel identity bound to contact + Opportunity without conflating Gu business number and advisor human numbers? | Admission/continuity depends on correct identity/routing. | Generic external-conversation binding direction accepted; legacy WhatsApp/provider identifiers and human-takeover path are source-verified; exact Gu OS binding and transport wrapper remain Technical Design. |
| A8 | Which progression/closure facts should be `case_facts`, projections, Case events or other generic primitives? | Preserve shared-kernel semantics. | AC-7 accepted: provenance-backed Case Facts + derived projections; facts/events/projections/lifecycle dimensions remain distinct. Exact fact keys/read models remain downstream Spec/Technical Design. |
| A9 | How is resource usage generalized beyond AI and attributed to Opportunity/Work/outcome? | S1 evaluations need cost-to-serve correlation from the beginning. | **ADR-110 accepted**; exact generic ledger/valuation/allocation migration remains Technical Design. |
| A10 | Does Relationship Operations need `current_step` at all, and if so for what durable procedural milestone? | Avoid forcing a CRM funnel onto a non-linear Opportunity. | AC-7 accepted: use `current_step` only for genuine procedural execution state, never as CRM stage/projection convenience. Exact use, if any, remains downstream design. |

**Rule:** Architecture may reveal that a proposed behavior is unsafe, impossible or underspecified. If so, revise this Spec explicitly; architecture must not silently redefine it.

## 17. Deferred / future behavior

- Full custom role/permission designer.
- Complex organization/team hierarchies.
- Fully configurable lifecycle workflow builder for customers.
- Automated cross-brokerage prospect routing/data disclosure.
- Transaction Operations internal lifecycle.
- Customer billing/credits derived from Opportunity economics.
- Business Brain cross-Case learning that changes admission policy without governed proposal/approval.
- Universal policy DSL or rule builder unless evidence shows structured controls + NL authoring are insufficient.
- Fully automated merge/split without human review where material uncertainty/risk remains.

## 18. Spec exit criteria

Before S1 can be marked **Approved**, confirm:

- [x] Lead Opportunity vs Contact vs lead record is unambiguous.
- [x] Admission is explicitly governed by platform hard bounds + organization policy + Gu contextual judgment.
- [x] Admission has create / attach / clarify / do-not-admit outcomes.
- [x] Recommended admission behavior is approved at Spec level: trusted contextual sources create eligibility for governed admission, not mechanical Case creation; full qualification is not required.
- [x] Organization policy UX is approved at Spec level: Recommended + Customize, conversation-first NL authoring, interpreted structured confirmation, and inspectable Settings surface.
- [x] Continuity rules are approved at Spec level using underlying purpose, decision independence, work independence and outcome attribution.
- [x] Duplicate/merge/split correction semantics preserve lineage and do not prescribe a domain-local runtime table.
- [x] Commercial viability, progression, delivery eligibility, durable responsibility and runtime status remain separate.
- [x] Temporary hold does not become automatic runtime pause/loss.
- [x] Closure model is approved at Spec level: `objective_achieved / lost / invalid / duplicate / superseded`, with separate closure reason and evidence.
- [x] Inactivity-alone ≠ lost is accepted as a product rule.
- [x] Transaction boundary and failed-transaction return behavior are accepted.
- [x] Reactivation vs new Opportunity behavior is accepted.
- [x] Human correction/authority semantics are sufficient for Architecture Analysis.
- [x] Data/evidence/provenance rules prevent unsupported closure/identity inference.
- [x] Acceptance scenarios cover ambiguity, policy variation, retries, identity, closure and recovery.
- [x] Open architecture questions are identified rather than silently solved here.
- [x] Minimum Traditional Gu production source audit is complete for Technical-Plan entry; implementation-time revalidation remains required for materially changed source paths.
- [x] Security/tenancy/cross-brokerage data-sharing constraints are explicit.
- [x] Observability/economic correlation requirements are carried forward.

### S1 approval note

The final whole-S1 review found no unresolved product-behavior contradiction or architecture leakage that should block approval. R1 Architecture Analysis v0.12 has resolved the structural **architecture direction** for the dependencies listed in §16; the Generic Case↔Case audit and minimum Traditional Gu legacy source audit are complete, ADR-109/ADR-110 are accepted, and remaining work is downstream Specs and exact Technical Design. Approval of S1 continues to freeze the intended behavior while preserving implementation freedom and the ability to revise the Spec explicitly if later architecture/source evidence reveals a contradiction.

## 19. Decision / change log

| Version / date | Decision or change | Owner / approver | Notes |
|---|---|---|---|
| v0.1 / 2026-08-26 | Initial S1 draft derived from approved Relationship Operations P0/P1 framing and canonical Feature / Business Spec template. | Product/domain review | Added explicit hybrid admission contract; organization-policy authoring pattern; continuity/cardinality; lifecycle-dimension separation; closure/reactivation; transaction boundary; acceptance scenarios; architecture dependency list. |
| v0.2 / 2026-08-26 | Approved and refined four Spec-level blocks: admission defaults, policy UX, closure model, and continuity rules. | Product/domain leadership | Trusted sources now create eligibility rather than mechanical admission; policy UX is conversation-first + inspectable Settings; closure separates outcome/reason/evidence and treats achieved-elsewhere as lost; continuity uses four semantic independence tests and stronger reactivation criteria. |
| v0.3 / 2026-08-26 | Final whole-S1 consistency and scope-boundary review; Spec approved. | Product/domain leadership | Confirmed internal consistency, acceptance coverage, security/evidence boundaries and architecture handoff. Removed residual auto-admit wording and avoided a broken link to the not-yet-created Architecture Analysis. |

**Maintenance note — 2026-08-27:** aligned architecture-status references with completed R1 Architecture Analysis v0.11, completed Generic Case↔Case audit, ADR-106/107/108/109 and finalized ADR-110 Resource Usage & Cost Attribution. No S1 product/behavior decision changed; the governing behavioral-contract version remains **v0.3**.

**Maintenance note — 2026-08-28:** aligned source-status references with R1 Architecture Analysis v0.12 and `legacy-source-audit.md` v0.1. The minimum Traditional Gu production-source audit is now complete for Technical-Plan entry. No S1 product/behavior decision changed; the governing behavioral-contract version remains **v0.3**.
