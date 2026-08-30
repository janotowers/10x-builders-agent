# Visit Progression, Outcome Evidence & Reconciliation

> **Version:** v0.2  
> **Status:** **APPROVED — Product / Domain behavioral contract for S3**  
> **Owner / decision owner:** Product / domain leadership  
> **Contributors:** Product, domain, engineering, design, architecture  
> **Initiative:** [Relationship Operations](../brief.md) — R1 Relationship Operations v1  
> **Parent product intent:** [Gu / Gu OS Product Requirements Document](../../../PRD.md)  
> **Initiative Brief:** [Relationship Operations — Initiative Brief](../brief.md)  
> **S1 behavioral contract:** [Lead Opportunity Lifecycle & Responsibility](./lead-opportunity-lifecycle.md) — v0.3 approved  
> **S2 behavioral contract:** [Situational Progression, Next Work & Human Authority](./situational-progression-next-work-human-authority.md) — v0.3 approved  
> **Architecture Analysis:** [R1 Architecture Analysis](../architecture-analysis.md) — v0.13 complete  
> **Legacy source audit:** [Traditional Gu Legacy Source Audit](../legacy-source-audit.md) — v0.2 complete for R1 Technical-Plan entry  
> **Relevant ADRs:** ADR-106 Organization-Native Multi-seat Tenancy; ADR-107 Runtime / Conversation Authority; ADR-108 Versioned Organization Policy; ADR-109 Generic Case Relationships / Lineage; ADR-110 Resource Usage & Cost Attribution  
> **Roadmap:** [Gu OS Evolution Roadmap](../../../../roadmap/gu-os-evolution-roadmap.md) — R1  
> **Doctrine:** [Gu OS Principles & Design Doctrine](../../../../principles/gu-os-principles-and-design-doctrine.md)  
> **Development method:** [Gu OS Agentic Product & Software Development Methodology](../../../../development/agentic-product-software-development-methodology.md)  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/specs/visit-progression-outcome-evidence-reconciliation.md`  
> **Artifact role:** Governing behavioral contract for how R1 Relationship Operations represents a real-estate property viewing as an identifiable business event within a Lead Opportunity; establishes visit request/scheduling/coordination semantics, occurrence and actor-specific evidence, post-visit commercial learning, reconciliation, Visit-related responsibility and Work, the Relationship↔Transaction boundary around strong property interest, and product/analytics/stopping requirements. This Spec does not own exact schemas, Fact keys, APIs, adapters, persistence shape, UI components, event envelopes, model/provider selection, or Transaction Operations internal lifecycle.

---

# 1. Summary and decision

S1 establishes the **Lead Opportunity** as the durable commercial responsibility owned by Relationship Operations. S2 establishes how its **Case Supervisor** situationally decides what useful work, if any, should happen next.

S3 defines the product semantics for one of the most important forms of commercial progression inside that Opportunity: the **Visit**.

A Visit is not merely an Appointment record, Calendar event, CRM stage or message. It is an identifiable business viewing instance involving an intended prospect-side viewing party and one identifiable property within a Lead Opportunity.

The core S3 model is:

```text
Viewing intent
      ↓
Visit requested
      ↓
coordination / evidence / readiness
      ↓
Visit scheduled
      ↓
real-world occurrence boundary
      ↓
evidence establishes:
    occurred
    did not occur
    actor-specific no-show
    cancelled
    access/host failure
    unknown / conflict
      ↓
post-Visit commercial learning
      ↓
situational Opportunity next work
      ↓
possible continued search,
another Visit,
intentional waiting,
or concrete Transaction responsibility
```

This is deliberately **not** a rigid linear workflow.

A Visit may be rescheduled, cancelled, remain partially unresolved, occur without the assigned advisor physically attending, produce mixed commercial feedback, or coexist with other Visits and even a downstream Transaction responsibility.

S3 therefore rejects the idea that Visit reality can be represented correctly by a single mutable appointment status.

Instead:

> **Visit truth is multidimensional, evidence-backed and attributable.**

The principal dimensions include:

- Visit identity and intended property;
- request / viewing intent;
- current scheduling arrangement;
- coordination/readiness;
- occurrence;
- actor participation / no-show attribution where justified;
- commercial reaction;
- requirements/preference learning;
- evidence/provenance;
- unresolved conflict/uncertainty;
- current Visit-related responsibility and Work.

S3 also establishes an important stopping rule:

> **Gu does not need perfect information in order to stop active Visit-specific work.**

An unresolved fact may intentionally remain unknown when obtaining more evidence has insufficient expected value. Conversely, new material evidence may later wake reconsideration without erasing history or requiring a new Visit.

Finally, S3 refines the Relationship↔Transaction boundary:

> **Strong interest in a property is not itself a Transaction. A separate Transaction responsibility begins when attributable evidence establishes a sufficiently concrete deal objective whose execution needs its own durable lifecycle.**

**Approval of this Spec means:** the Visit identity, progression, evidence, reconciliation, post-Visit learning, Visit-related Work/human-responsibility, Transaction-boundary and stopping behavior defined here become the approved R1 product contract.

**Approval of this Spec does not mean:** approval of a particular Visit table/entity, Case Fact schema, appointment adapter, Calendar integration, status enum, Work graph, UI component, survey cadence, evidence confidence score, model prompt, API endpoint, provider, analytics implementation or Transaction Operations lifecycle.

# 2. User and business objective

## 2.1 User objective

A real-estate professional should be able to trust Gu to coordinate and learn from property viewings without manually operating an appointment pipeline or reconstructing Visit truth from fragmented systems.

The professional should be able to understand:

- what property is intended to be viewed;
- whether a viewing has merely been requested or is actually scheduled;
- what still matters operationally before the Visit;
- who, if anyone, is expected to host/show the property;
- what changed after a reschedule or cancellation;
- whether the Visit actually occurred;
- whether a no-show is genuinely attributable to someone;
- what the prospect learned or felt after the Visit;
- what Gu learned about the broader Opportunity;
- whether Gu is handling an unresolved issue autonomously;
- whether a human contribution is actually needed;
- whether a concrete Transaction responsibility has emerged;
- and when there is no longer useful Visit-specific work to perform.

The professional should **not** need to interpret raw appointment records, Calendar state, survey fields or integration status to determine these answers.

## 2.2 Business objective

Increase the reliability and commercial usefulness of the lead→Visit progression signal while reducing:

- coordination failures;
- stale reminders/actions after reschedules;
- false attendance/no-show assumptions;
- fragmented post-Visit feedback;
- unnecessary human interruptions;
- Opportunity leakage after unsuccessful property viewings;
- and premature or missed handoff into Transaction Operations.

## 2.3 Success signal

In a production-representative pilot:

- `visit_requested`, `visit_scheduled` and `visit_attended` correspond to defensible business reality rather than raw appointment records;
- reschedules do not inflate Visit counts;
- property changes do not rewrite prior Visit history;
- missing occurrence evidence remains unknown rather than becoming no-show;
- explicit negative occurrence evidence is not over-attributed to a particular actor;
- post-Visit feedback improves Opportunity understanding without automatically closing it;
- Gu chooses proportional reconciliation rather than repeatedly chasing low-value missing fields;
- strong commercial interest triggers Transaction responsibility only when a concrete deal-execution objective exists;
- Visit-related Work stops intentionally when no material responsibility remains;
- and actual/effective Visits can support a trustworthy downstream Visit-rate metric.

# 3. Actors, responsibilities and authority

| Actor / system | Responsibility in this Spec | Authority / limits |
|---|---|---|
| **Lead Opportunity / Relationship Operations** | Owns the durable commercial responsibility within which Visits are coordinated and interpreted. | A Visit does not become a separate Operational Case by default. S1 remains authoritative for Opportunity closure/reactivation/identity/continuity. |
| **Gu / Case Supervisor** | Reconsiders Visit-related reality, identifies useful coordination/reconciliation/post-Visit work, interprets evidence and recognizes when a Transaction responsibility emerges. | Cannot invent authority, attendance, no-show, cancellation, Transaction intent or evidence. Does not absorb provider internals or the downstream Transaction lifecycle. |
| **Prospect / viewing party** | Expresses viewing intent, accepts/rejects proposed arrangements, participates in the Visit, supplies occurrence evidence and commercial reaction. | A prospect statement is evidence with claim-specific authority; silence is not automatically cancellation, rejection or no-show. |
| **Assigned advisor / Opportunity DRI** | May coordinate, contribute knowledge, communicate with the prospect, host the Visit or supply evidence. | Assignment does not imply the advisor must host every Visit or approve every scheduling action. |
| **Visit Coordinator** | Coordinates the viewing arrangement where a human contribution is needed. | Coordination responsibility is distinct from Opportunity ownership, Visit Host and approval authority. |
| **Visit Host** | Person, if any, expected to receive/accompany/show the property to the prospect-side viewing party during that Visit. | May be the assigned advisor, another advisor, listing agent, owner, development staff, assistant, reception/showroom staff or another authorized person. A Visit may also be self-guided. |
| **Approval Authority** | Approves protected scheduling, access, economic or other consequential decisions where applicable. | Separate from Opportunity DRI, Visit Coordinator and Visit Host. |
| **Organization / brokerage** | Defines applicable scheduling, engagement, representation and human-authority policy within platform bounds. | Policy may govern allowed coordination behavior but does not redefine Visit business truth. |
| **Traditional Gu / legacy appointment sources** | Current brownfield source of appointment/confirmation/survey and related operational evidence. | Legacy records are evidence inputs, not canonical Gu OS Visit semantics. |
| **Calendar / scheduling provider** | Supplies scheduling/RSVP/provider evidence and may execute external effects. | Calendar event existence or RSVP does not establish actual Visit occurrence. |
| **Future access/showing providers** | May provide access, check-in or showing evidence under an explicit evidence contract. | Provider data is authoritative only for the claims its contract supports. |
| **Transaction Operations** | Owns a sufficiently concrete deal-execution responsibility after the Transaction boundary is crossed. | Transaction start does not automatically close the Lead Opportunity. |

Role distinction:

```text
Opportunity DRI
≠ Visit Coordinator
≠ Visit Host
≠ Approval Authority
≠ Conversation Lead
```

The same person may hold several of these roles, but the concepts remain distinct.

# 4. Terminology and domain concepts

| Term | Definition in this Spec | Not to be confused with |
|---|---|---|
| **Visit** | An identifiable business viewing instance within a Lead Opportunity involving one identifiable property and the intended prospect-side viewing party. | A legacy appointment record, Calendar event, CRM status or separate Operational Case. |
| **Visit identity** | Continuity of the same intended property viewing across coordination changes such as ordinary rescheduling. | Legacy `appointment_id`; target Visit identity must not depend blindly on mutable legacy identity behavior. |
| **Visit request / `visit_requested`** | Evidence-backed progression that sufficiently concrete intent exists to coordinate an actual viewing of an identified property. | A fully scheduled arrangement. |
| **Visit scheduled / `visit_scheduled`** | Evidence-backed progression that the viewing arrangement is sufficiently reliable that relevant parties can reasonably rely on it. | Mere appointment persistence, one actor's tentative proposal, Calendar event existence or perfect readiness. |
| **Visit readiness / coordination posture** | Current situational assessment of whether access, participants, instructions, confirmations or other operational conditions are sufficiently resolved. | A progression milestone. A Visit may be scheduled while readiness issues remain. |
| **Confirmation evidence** | Advisor/prospect/host/provider evidence supporting scheduling or readiness. | A mandatory canonical `visit_confirmed` progression milestone. S3 does not define one. |
| **Visit occurrence** | Whether the intended real-world viewing actually took place. | Scheduling, confirmation or Calendar RSVP. |
| **`visit_attended`** | Evidence-backed progression that the intended prospect-side viewing party meaningfully participated in the actual viewing of the Visit property. | Requirement that the named Prospect personally attend or that the assigned advisor be physically present. |
| **Non-occurrence** | Evidence that the intended Visit did not occur. | Actor-specific no-show; non-occurrence may have many causes. |
| **Actor-specific no-show** | Evidence-backed attribution that an expected actor failed to participate without sufficient prior cancellation/reschedule evidence. | Silence, missing survey response or generic non-occurrence. |
| **Visit Host** | Person, if any, expected to receive/accompany/show the property during that specific Visit. | Property owner, Opportunity DRI or Visit Coordinator by definition. |
| **Reschedule** | Continued coordination of the same intended Visit with a changed schedule while the intended property/viewing remains continuous. | Property substitution or a genuinely terminated old Visit followed by a new viewing intent. |
| **Cancellation** | Evidence that the current intended Visit is terminated rather than merely moved. | Opportunity loss or no-show. |
| **Occurrence unknown** | No defensible accepted conclusion yet about whether the Visit occurred. | Non-occurrence, cancellation or no-show. |
| **Evidence conflict** | Two or more materially incompatible claims that cannot yet be reconciled into one accepted understanding. | Generic data mismatch or latest-write-wins correction. |
| **Post-Visit commercial feedback** | Property-specific reaction, objections, interest, preference/requirement learning or decision signals arising after/around the Visit. | Attendance evidence itself. |
| **Transaction boundary** | Point where a sufficiently concrete deal objective requires separate durable deal-execution responsibility. | Positive interest, a favorite property, a Visit, affordability analysis or exploratory discussion by themselves. |
| **Visit-specific active work** | Current useful work whose purpose is to coordinate, reconcile or learn from a Visit. | The entire Lead Opportunity responsibility. |
| **Visit-specific operational stopping** | Judgment that no material unresolved Visit responsibility currently justifies further active work. | Proof of attendance, a terminal Visit status or Opportunity closure. |

# 5. Source-status and evidence basis

This Spec distinguishes:

- **CURRENT — REPO VERIFIED** — observed in the current Gu OS repository.
- **CURRENT — LEGACY SOURCE VERIFIED** — directly observed in audited Traditional Gu production source.
- **CURRENT — DOMAIN CONFIRMED** — confirmed by product/domain leadership but not source-verified for the exact mechanism.
- **CURRENT — LEGACY RISK** — source behavior that must not be promoted into target semantics.
- **TARGET — PRODUCT APPROVED** — S3 behavior approved through product/domain review.
- **OPEN — SOURCE VERIFICATION** — source question still unresolved but not blocking target behavior.
- **OPEN — TECHNICAL DESIGN** — implementation mechanics intentionally deferred.

## 5.1 Legacy findings relevant to S3

| Finding | Status | Target consequence |
|---|---|---|
| Traditional Gu has a dedicated post-appointment Visit tracker/survey path. | CURRENT — LEGACY SOURCE VERIFIED | Useful source evidence; not target workflow definition. |
| Explicit survey evidence exists through `property_was_visited = "Afirmativo" | "Negativo"`. | CURRENT — LEGACY SOURCE VERIFIED | Strong direct occurrence/non-occurrence evidence candidate. |
| General conversation context must not be substituted automatically for the survey answer in the current flow. | CURRENT — LEGACY SOURCE VERIFIED | Reinforces evidence discipline; target may accept other authorized evidence sources under explicit contracts. |
| Appointment/owner confirmation and post-Visit occurrence survey are distinct. | CURRENT — LEGACY SOURCE VERIFIED | Scheduling/confirmation ≠ attendance. |
| A legacy appointment created by the appointment assistant is initially a Visit request; prospect may still be awaiting advisor confirmation. | CURRENT — LEGACY SOURCE VERIFIED | Appointment existence can support `visit_requested`; does not automatically establish `visit_scheduled`. |
| Appointment creation may partially succeed across Google Calendar, Firestore and Mongo. | CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK | External records require source-aware evidence and reconciliation. |
| Advisor/prospect confirmations are actor-specific. | CURRENT — LEGACY SOURCE VERIFIED | No single confirmation field should become universal canonical truth. |
| Calendar RSVP/response status exists independently from Visit occurrence. | CURRENT — LEGACY SOURCE VERIFIED | RSVP is scheduling/participation evidence, not actual attendance proof. |
| Legacy rescheduling mutates the same appointment ID and can even change property. | CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK | Target Visit identity must follow business continuity, not blindly inherit mutable legacy record identity. |
| Legacy cancellation records cancellation/finished-like status. | CURRENT — LEGACY SOURCE VERIFIED | Cancellation evidence is useful, but legacy `finished` is not target business semantics. |
| Negative occurrence survey establishes that the intended Visit did not occur. | CURRENT — LEGACY SOURCE VERIFIED | Does not by itself establish why or actor-specific no-show. |
| No globally reliable explicit `no_show` contract was established in the audit. | CURRENT — LEGACY SOURCE VERIFIED / OPEN by source | No-show target semantics must be evidence-based and actor-specific. |
| Exact source path that schedules/sets the post-Visit survey trigger was not conclusively established in the audit. | OPEN — SOURCE VERIFICATION | No fixed survey-delay invariant may be derived from legacy behavior. |
| Product/domain observation suggests the current survey is typically sent around the day after the Visit and does not appear to be an indefinitely retried workflow. | CURRENT — DOMAIN CONFIRMED | Context only; no universal 24-hour or retry invariant. |
| Legacy Deal may be created from property-interest/Visit flows before a concrete transaction exists. | CURRENT — LEGACY SOURCE VERIFIED | Legacy Deal ≠ Transaction responsibility. |

Source verification records historical implementation behavior. It does not override the approved target semantics below.

# 6. Scope

## 6.1 In scope

- Visit business identity within a Lead Opportunity.
- `visit_requested`, `visit_scheduled`, `visit_attended` semantics.
- Scheduling reliability vs readiness/coordination.
- Confirmation evidence.
- Reschedule, cancellation and property-change continuity.
- Visit occurrence and actor participation.
- Non-occurrence, actor-specific no-show, access/host failure and unknown.
- Claim-specific evidence authority and conflicts.
- Proportional evidence reconciliation.
- Post-Visit property/commercial feedback.
- Requirements/preference learning across Visits.
- Multiple/concurrent/historical Visits.
- Visit-related commitments, Work and human contribution.
- Opportunity↔Transaction boundary after strong commercial interest.
- Visit UX information requirements.
- Visit analytics semantics.
- Visit-specific stopping/re-entry.
- Acceptance scenarios and important non-actions.

## 6.2 Non-goals

- Lead Opportunity admission, closure/reactivation/identity/continuity except where Visit evidence affects them — S1 owns these.
- General situational next-work selection outside Visit-specific semantics — S2 owns this.
- Work Portfolio / Needs Attention cross-Case ranking and supervisory experience — S4 owns this.
- Transaction Operations internal lifecycle.
- Exact database schema or Visit persistence representation.
- Exact Case Fact keys/enums/confidence fields.
- Exact appointment/Calendar/provider adapter.
- Exact event/wake-up envelope.
- Exact Work Item graph/persistence.
- Universal survey cadence or number of retries.
- Exact source-priority scoring algorithm.
- Exact UI component, layout, color, typography or surface renderer.
- Final company-wide Visit-rate formula/denominator.
- A canonical `ViewingPlan`/tour entity.
- Billing/credits/pricing behavior.

# 7. Core S3 invariants

1. **Appointment created ≠ Visit scheduled.**
2. **Calendar event ≠ Visit scheduled by itself.**
3. **Scheduling confirmation/readiness evidence ≠ Visit attendance.**
4. **S3 does not define a mandatory `visit_confirmed` progression milestone.**
5. **Visit is an identifiable business viewing instance, not merely a legacy appointment record.**
6. **A Visit concerns one identifiable property; coordinated multi-property tours preserve separate Visit identities.**
7. **Visit is not a separate Operational Case by default.**
8. **Reschedule normally preserves Visit identity when the same intended property viewing continues.**
9. **Changing the intended property creates a different Visit.**
10. **Reschedule/cancellation preserve prior arrangement history rather than rewriting it.**
11. **Cancellation ≠ no-show ≠ Opportunity loss.**
12. **Passing scheduled time creates an occurrence question, not an automatic answer.**
13. **`visit_attended` requires admissible occurrence evidence.**
14. **Assigned-advisor physical attendance is not required for `visit_attended`.**
15. **Missing evidence ≠ non-occurrence.**
16. **Non-occurrence ≠ actor-specific no-show.**
17. **Silence ≠ no-show.**
18. **Legacy negative survey evidence may support non-occurrence but not actor attribution by itself.**
19. **Unknown is a valid current truth.**
20. **Conflicting evidence may remain explicitly unresolved.**
21. **Late evidence may correct accepted understanding without erasing provenance.**
22. **Attendance and commercial reaction are separate dimensions.**
23. **Negative reaction to one property ≠ Opportunity loss.**
24. **Positive interest ≠ Transaction start.**
25. **Transaction responsibility begins with sufficiently concrete durable deal-execution responsibility, not keywords or CRM stage.**
26. **Transaction start ≠ Opportunity closure.**
27. **Transaction failure ≠ Opportunity loss by itself.**
28. **Work completion ≠ Visit progression.**
29. **Evidence gap ≠ automatic Work Item.**
30. **Visit-specific active work may stop while some facts remain unknown.**
31. **Visit-specific stopping ≠ Opportunity completion.**
32. **UI/projections represent accepted Visit truth; they do not create business truth.**
33. **Unknown outcomes must not be counted as actor-specific no-shows.**
34. **Reschedules must not inflate Visit progression counts.**
35. **S3 owns required semantic information; the cross-domain Design/Experience System owns exact visual/interaction expression.**

# 8. Visit identity and initial progression

## 8.1 Traditional Gu appointment persistence is evidence, not target identity

A legacy Appointment is a source record that may provide strong evidence about a Visit.

It is not automatically:

- the canonical Visit identity;
- proof of `visit_scheduled`;
- proof of occurrence;
- or the source of all Visit truth.

Target Gu OS semantics remain independent from the loose/mutable legacy appointment schema.

## 8.2 `visit_requested`

`visit_requested` is established when attributable evidence supports sufficiently concrete intent to coordinate an actual viewing of an identifiable property.

This may occur before the date/time is fully resolved.

Examples:

- “I want to see Property A.”
- “Can we arrange a viewing for Property B this weekend?”
- an authorized advisor explicitly starts coordination for Property C based on the prospect's expressed viewing intent.

A Traditional Gu persisted appointment is normally strong evidence of `visit_requested` because the legacy flow has already captured explicit viewing intent, a property and a concrete proposed schedule before persistence.

However, target Gu OS does **not** require legacy appointment persistence to recognize `visit_requested`.

## 8.3 One Visit = one identifiable property viewing

One Visit represents one intended viewing instance for one identifiable property.

A multi-property tour may be coordinated in one conversation or logistical plan:

```text
Saturday tour
├─ Property A — Visit 1
├─ Property B — Visit 2
└─ Property C — Visit 3
```

Each Visit retains separate:

- progression;
- occurrence;
- feedback;
- evidence;
- property attribution.

S3 does not introduce a canonical `ViewingPlan`/tour entity.

Whether a future reusable grouping construct is needed is Technical Design / later product work.

## 8.4 `visit_scheduled`

`visit_scheduled` is established when the arrangement is sufficiently reliable that relevant parties can reasonably rely on the Visit occurring at the current agreed date/time/location/access context.

The exact evidence required depends on:

- source contracts;
- Organization policy;
- delegated scheduling authority;
- availability confidence;
- participants;
- consequence/reversibility.

No universal human click is required.

For example, Gu may autonomously establish a scheduled Visit where:

- Organization policy delegates routine scheduling;
- required availability is authoritative;
- the prospect accepts the arrangement;
- no protected exception requires human approval.

Conversely, a Calendar event generated from a tentative/requested slot does not automatically establish `visit_scheduled`.

## 8.5 Confirmation is evidence, not a universal milestone

Possible evidence includes:

- advisor acceptance;
- Visit Host acceptance;
- prospect reconfirmation;
- Calendar RSVP;
- access confirmation;
- showing-provider confirmation;
- deterministic availability evidence.

These claims may strengthen:

- scheduling reliability;
- readiness;
- coordination confidence;
- or create/resolve Work.

S3 does not require a canonical progression milestone called `visit_confirmed`.

# 9. Readiness, rescheduling and cancellation

## 9.1 Scheduled progression and readiness are distinct

A Visit can be genuinely scheduled while readiness remains incomplete.

Example:

```text
Visit:
Sunday 13:00
Scheduled = yes

Readiness:
Access instructions missing

Current work:
Gu resolving access
```

The missing access instruction does not erase the already established scheduling milestone.

Similarly, complete readiness does not itself prove future occurrence.

## 9.2 No universal readiness checklist

Relevant coordination conditions vary by situation:

- access/key instructions;
- gate/reception process;
- Visit Host acceptance;
- prospect reconfirmation;
- property availability;
- required documentation;
- showing instructions;
- special access restrictions.

The Case Supervisor asks:

> **What is currently missing for this viewing responsibility to be sufficiently coordinated?**

not:

> “Which fixed appointment workflow step comes next?”

## 9.3 Reschedule normally preserves Visit identity

Changing date/time normally continues the same Visit when:

- the intended property remains the same;
- the viewing intent remains continuous;
- the prior arrangement is being moved rather than terminated.

History must be preserved.

Example:

```text
Visit A / Property X

Original:
Saturday 11:00

Rescheduled:
Sunday 13:00
```

The Visit remains one business viewing instance.

Analytics should be able to count:

```text
1 Visit
2 schedule changes
```

rather than:

```text
3 scheduled Visits
```

## 9.4 Reschedule may invalidate current applicability of earlier evidence

An earlier confirmation remains historical evidence but may no longer support the new arrangement.

For example:

```text
Visit Host confirmed Saturday 11:00
Visit moved to Sunday 13:00
```

The original confirmation is not deleted.

Its current applicability may be invalidated or require reconsideration.

The same principle applies to:

- reminders;
- access instructions;
- dependent Work;
- Calendar effects;
- human commitments.

## 9.5 Property change creates a different Visit

If the intended viewing changes from Property A to Property B, target semantics create a different Visit.

Legacy code may mutate the same appointment record/ID across such a change; S3 explicitly does not inherit that behavior as canonical identity.

The prior Visit's resulting disposition/history remains attributable and must not be rewritten to pretend it always referred to Property B.

S3 does not fix the exact Visit-level disposition enum for the old Visit.

## 9.6 Cancellation

Cancellation means the intended current Visit has been terminated rather than merely moved.

Cancellation should preserve, where known:

- actor/source;
- timestamp;
- reason;
- evidence;
- prior/current schedule;
- affected commitments/Work.

Cancellation does not imply:

```text
Visit no-show
Opportunity lost
Prospect rejected all properties
```

A prospect may cancel one Visit and continue an otherwise healthy Opportunity.

## 9.7 Cancellation vs later renewed viewing

If the original Visit intent was genuinely terminated and a materially later/new viewing is subsequently requested, that normally becomes a new Visit.

S3 does not use a fixed elapsed-time threshold.

Continuity follows the actual business intent rather than arbitrary days/hours.

# 10. Visit occurrence, attendance, non-occurrence and no-show

## 10.1 Scheduled time passing creates a question

When the expected Visit time passes, Gu OS should not infer:

```text
attended
```

or:

```text
no-show
```

merely because the scheduled boundary elapsed.

Instead, the Case may need to determine:

> **What actually happened?**

## 10.2 `visit_attended`

`visit_attended` is established when admissible evidence supports that the intended prospect-side viewing party meaningfully participated in the actual viewing of the Visit property.

The assigned advisor does not have to be physically present.

The Visit may be hosted by:

- assigned advisor;
- another brokerage advisor;
- listing agent;
- property owner;
- development/showroom staff;
- receptionist/authorized staff;
- access/showing provider;
- or be self-guided.

Likewise, the named Prospect need not always be personally present if an authorized/relevant member of the prospect-side viewing party meaningfully performs the viewing on behalf of the commercial objective.

Example:

```text
Visit occurred = yes
Spouse viewed property on buyer household's behalf = yes
Named Prospect physically present = no
```

Individual participation can remain separately attributable where material.

## 10.3 Evidence for occurrence

Explicit prospect confirmation is strong occurrence evidence but is not the only possible admissible source.

Potential future sources include:

- prospect direct declaration;
- authorized Visit Host direct observation;
- showing/access provider;
- verified check-in/access event;
- another authorized system observation;
- other source-specific evidence satisfying an explicit evidence contract.

Source authority remains claim-specific.

## 10.4 Non-occurrence

A Visit may have admissible evidence that the intended viewing did not occur.

The legacy survey:

```text
property_was_visited = "Negativo"
```

may support this conclusion.

It does not, by itself, answer:

```text
Why?
Whose responsibility?
Did someone cancel?
Was access impossible?
Did the advisor fail to appear?
Did the prospect fail to appear?
```

Therefore:

> **Non-occurrence is not equivalent to actor-specific no-show.**

## 10.5 Actor-specific no-show

A no-show is a stronger attribution claim.

It requires sufficient evidence that:

1. the Visit remained expected for the actor;
2. the actor was expected to participate;
3. no sufficient prior cancellation/reschedule evidence changes that expectation;
4. admissible evidence supports the actor's failure to participate.

Possible examples:

```text
prospect no-show
Visit Host no-show
advisor no-show
```

S3 deliberately avoids reducing all of these to one generic `NO_SHOW`.

## 10.6 Silence is insufficient

Examples that do **not** independently establish prospect no-show:

- survey unanswered;
- no new WhatsApp response;
- no post-Visit note;
- Calendar event ended;
- advisor did not update CRM;
- provider data missing.

Silence may create an evidence gap.

It does not prove actor nonparticipation.

## 10.7 Unknown is valid truth

If sufficient occurrence evidence is unavailable:

```text
occurrence = unknown
```

is a correct business representation.

`Unknown` must not be converted into a negative outcome merely to fill a funnel metric or simplify UI.

## 10.8 Partial/qualified occurrence

Some situations may require qualified interpretation.

Examples:

- prospect arrives but cannot enter property;
- prospect views only common areas;
- wrong property was shown;
- spouse views property but primary buyer does not;
- Visit ends immediately because property is unavailable.

The model may interpret whether the intended viewing objective was meaningfully satisfied, grounded in evidence.

Technical Design may support structured qualifiers where needed.

S3 does not force every ambiguous event into only `attended` / `not_attended`.

# 11. Post-Visit commercial feedback and learning

## 11.1 Attendance and reaction remain separate

A Visit can be:

```text
attended = yes
reaction = strongly negative
```

or:

```text
attended = yes
reaction = unknown
```

or:

```text
attended = yes
reaction = positive
transaction responsibility = no
```

Attendance never implies satisfaction or commercial intent.

## 11.2 Preserve reasons, not only yes/no interest

Post-Visit learning should retain material reasons where evidence supports them.

Examples:

- too small;
- location inconvenient;
- liked natural light;
- worried about renovation;
- spouse dislikes distribution;
- price feels high;
- wants to compare another option;
- uncertain;
- needs financing clarity.

A generic:

```text
interested = false
```

is insufficient when the reason materially informs the Opportunity.

## 11.3 Property-specific reaction is not automatically global preference

Example:

> “This apartment feels too small.”

may mean:

- this specific layout feels too small;
- actual minimum size should increase;
- number of bedrooms is wrong;
- storage is inadequate;
- or a contextual reaction not yet generalizable.

Gu may infer candidate implications, but should preserve:

```text
observed statement
interpreted meaning
inferred broader preference
```

as distinguishable concepts where material.

## 11.4 Requirements/preferences can evolve

Visits may:

- confirm an existing requirement;
- weaken one;
- reveal a new requirement;
- expose a hidden tradeoff;
- show that a previously stated preference was tentative;
- reveal that priorities changed.

Contradiction is not necessarily data corruption.

It may be real preference evolution.

History and provenance should remain available.

## 11.5 Indecision is legitimate

Feedback such as:

> “I liked it but I'm not sure.”

is not a failure to classify.

It may justify:

- comparison;
- clarification;
- financing analysis;
- discussing a concern;
- another Visit;
- waiting;
- no immediate contact.

The Case Supervisor chooses useful work under S2.

## 11.6 `Not this property` ≠ `Not this Opportunity`

A prospect may reject Property A while the search remains active.

S1 remains authoritative for Opportunity lifecycle.

S3 must not automatically convert negative property feedback into:

```text
Opportunity lost
```

## 11.7 Advisor/service feedback remains separate

Feedback about:

- advisor experience;
- property access;
- host quality;
- responsiveness;
- showing organization;

may affect relationship strategy.

It should remain distinguishable from:

- property fit;
- commercial viability;
- Transaction intent.

Negative service feedback may make human involvement more valuable, but does not automatically require takeover.

## 11.8 Multiple actors may provide feedback

Relevant post-Visit evidence may come from:

- prospect;
- spouse/partner;
- advisor;
- Visit Host;
- other authorized participant.

The system should preserve who said/observed what.

## 11.9 Silence ≠ rejection

No post-Visit response does not establish:

```text
not interested
lost
```

The Case Supervisor may decide whether further evidence acquisition is worthwhile.

## 11.10 Multiple Visits accumulate commercial learning

Gu should be able to synthesize patterns across Visits, for example:

> The last three Visits suggest location is materially more important than garden size.

Such synthesis should remain grounded in attributable observations.

Exact aggregation can be deterministic where mechanical.

Commercial synthesis remains model judgment.

# 12. Visit truth is multidimensional

## 12.1 No canonical single Visit status

S3 does not define one status enum as the source of all Visit truth.

Relevant dimensions may include:

```text
identity
property
request/intention
current scheduling arrangement
readiness/coordination
occurrence
participant attribution
commercial feedback
evidence/conflicts
current related commitments/work
```

A convenience UI/projection may summarize these dimensions.

The summary must not become the canonical business truth.

## 12.2 Historical progression and current posture differ

Example:

```text
Historical progression:
visit_requested = achieved
visit_scheduled = achieved

Current posture:
Visit cancelled
```

Cancellation does not erase the fact that the Visit was previously genuinely scheduled.

Similarly:

```text
Visit attended = achieved
```

remains historical progression even if the property later becomes irrelevant.

## 12.3 S1 milestones are evidence-backed accomplishments

S1 progression concepts such as:

- `visit_requested`;
- `visit_scheduled`;
- `visit_attended`;

should be interpreted as accumulated evidence-backed milestones/history rather than mutually exclusive current stages.

The Opportunity may have:

- multiple requested Visits;
- multiple scheduled Visits;
- multiple attended Visits;
- cancelled Visits;
- unresolved Visit outcomes.

## 12.4 Same property may have multiple Visits

An Opportunity may revisit Property A.

Example:

```text
Visit 1:
initial viewing

Visit 2:
second viewing with spouse
```

These are distinct Visits.

A reschedule of Visit 1 remains the same Visit 1.

## 12.5 Opportunity projections should answer useful questions

A useful Opportunity-level projection may need to answer:

- Has any Visit ever been requested?
- Has any Visit ever been scheduled?
- Has any Visit ever been attended?
- What is the next upcoming Visit?
- What Visits have unresolved occurrence evidence?
- Which properties were viewed recently?
- What active Visit-related commitments exist?
- What did we learn across Visits?
- Is any human contribution currently needed?

Exact projection implementation belongs to Technical Design.

## 12.6 Progression attribution

Opportunity-level milestones should remain attributable to the supporting Visit/property/evidence.

For example:

```text
visit_attended
supported by:
Visit 7
Property ABC
Prospect confirmation
```

rather than a context-free boolean.

## 12.7 Transaction progression does not invalidate other Visits

A concrete Transaction may begin for Property A while:

- another Visit for Property B is scheduled;
- the prospect continues considering alternatives;
- a prior Visit outcome remains partially unresolved.

No global rule automatically cancels unrelated/legitimate Visit responsibility.

# 13. Evidence authority and reconciliation

## 13.1 No universal Visit source of truth

Authority is claim-specific.

Different sources may legitimately own different claims:

```text
Appointment source
→ appointment record/schedule evidence

Calendar
→ provider event/RSVP evidence

Prospect
→ prospect intention/direct experience

Visit Host
→ host observation

Access provider
→ access/check-in event

Gu model
→ interpretation/synthesis, not source authority
```

Therefore:

> **Visit truth must be resolved claim by claim, not by declaring one entire record/database globally authoritative.**

## 13.2 Evidence and accepted facts remain distinct

Conceptually:

```text
source evidence
      ↓
claim interpretation
      ↓
authority/admissibility evaluation
      ↓
accepted Visit/Case fact
      ↓
derived projection
```

A raw field does not automatically become accepted Gu OS truth.

## 13.3 No latest-value-wins

When two sources disagree, S3 rejects:

```text
newest timestamp wins
```

as a generic rule.

The system should first determine:

- are these actually claims about the same Visit?
- are they claims about the same dimension?
- did one source correct/supersede another?
- does one source have stronger authority for this claim?
- are the claims temporally compatible?
- is the conflict genuine?

## 13.4 Evidence type is distinct from source

Evidence may conceptually be:

- direct declaration;
- direct human observation;
- system/provider observation;
- indirect report;
- derived interpretation;
- model inference.

Exact enums are Technical Design.

This helps separate:

```text
Prospect explicitly said X
```

from:

```text
Model inferred X from surrounding conversation
```

even if both originate from the same conversation source.

## 13.5 Conversational evidence can be strong

Gu should not require brittle keyword/regex extraction where natural-language interpretation is needed.

A prospect message:

> “Yes, we went yesterday. My wife loved the kitchen.”

can strongly support occurrence and commercial feedback.

The model may interpret the semantic claims.

Governed mechanisms preserve:

- source;
- text/reference;
- Visit binding;
- timestamps;
- authority;
- accepted fact/projection.

Principle:

> **Model judgment interprets evidence; governed structures determine what authority that evidence may have.**

## 13.6 Reconciliation is claim-targeted

When a material question remains unresolved, preferred reasoning is:

```text
1. reread available relevant evidence
2. identify the exact unresolved claim
3. query an authoritative source for that claim where available
4. use authorized corroboration if proportionate
5. resolve stale/identity/semantic confusion where possible
6. request the smallest useful human/prospect contribution if needed
7. preserve unknown/conflict if resolution is not worth further cost/burden
```

The goal is decision-sufficient truth, not exhaustive data completion.

## 13.7 Evidence gap does not automatically create Work

An evidence gap may remain inline reasoning or require no action.

When resolving the gap is materially worthwhile:

> **Reconciliation is ordinary Case work and should reuse shared Work/evidence mechanisms.**

A durable Work Item is appropriate only when the reconciliation itself benefits from durable execution semantics such as:

- waiting;
- retry;
- dependency;
- human contribution;
- material effect;
- independent evidence/audit.

This refines the AC-8 statement that evidence gaps are ordinary Work:

```text
material gap worth resolving
→ use ordinary shared work mechanisms

not:
every missing fact
→ mandatory Work Item
```

## 13.8 Corrections preserve history

Late or stronger evidence may change the current accepted interpretation.

Example:

```text
Day 1:
occurrence = unknown

Day 4:
prospect explicitly confirms Visit occurred

Current:
occurrence = occurred
```

History should still show that the outcome was previously unresolved.

No silent rewrite.

## 13.9 Source failure does not change business truth

If Calendar, appointment store or access provider is unavailable:

```text
source unavailable
```

does not mean:

```text
Visit cancelled
Visit did not occur
```

It may create an operational/evidence problem.

Business truth remains unchanged until supported evidence changes it.

## 13.10 Absence can be evidence only under an explicit source contract

Absence may support a conclusion only when the source has known completeness and relevant time boundaries.

Example:

```text
No access check-in
```

is meaningful only if:

- all entries are guaranteed to be captured;
- the relevant Visit/door is correctly bound;
- the observation window is complete.

Generic absence is not proof.

## 13.11 No universal numeric confidence threshold

Evidence sufficiency should scale with:

- consequence;
- reversibility;
- ambiguity;
- source authority;
- cost of error.

S3 does not define:

```text
confidence >= 0.8
→ attended
```

as a universal policy.

Provenance and admissibility cannot be replaced by one scalar.

# 14. Visit-related commitments, Work and human responsibility

## 14.1 Opportunity owns the responsibility

A Visit does not become a separate Operational Case by default.

> **The Opportunity owns the responsibility; the Visit provides a concrete coordination and evidence context within it.**

The Lead Opportunity remains the durable root.

## 14.2 Scheduled Visits create relied-upon expectations

A genuinely scheduled Visit normally creates specific expectations that relevant parties rely upon.

Examples:

- property available at agreed time;
- prospect expected to attend;
- Visit Host expected to receive/show;
- access expected to be possible;
- a promised instruction/document expected before the Visit.

S3 does not introduce one giant generic `VISIT_COMMITMENT`.

Commitments may be actor/subject-specific.

## 14.3 Commitment ≠ Work Item

A commitment describes a relied-upon expected outcome/obligation.

A Work Item describes durable executable work.

Example:

```text
Commitment:
Visit Host will provide access at 13:00

Work:
Gu must obtain missing gate instructions
```

Likewise, a prospect's expected response should not normally become an internal Work Item assigned to the prospect.

## 14.4 Not every action becomes Work

Inline/ephemeral work remains appropriate for:

- reads;
- context gathering;
- reasoning;
- small immediate calculations;
- simple authorized checks.

Durable Work is appropriate when persistence materially matters.

S2 remains authoritative for Work granularity.

## 14.5 Coordination can be dynamic and parallel

There is no universal sequence:

```text
request
→ advisor confirm
→ prospect confirm
→ access
→ reminder
→ Visit
→ survey
```

A real Visit may involve parallel coordination or skip some steps entirely.

The Case Supervisor may dynamically coordinate:

- scheduling;
- access;
- host;
- prospect;
- artifacts;
- Calendar;
- evidence;
- reminders;

within applicable authority.

Dynamic coordination does not create dynamic authority.

## 14.6 Human contribution is specific

Human involvement may take forms such as:

- Targeted Human Input;
- Human-as-executor;
- Approval;
- Visit Host;
- Conversation Lead;
- Act + Inform / awareness.

Human participation does not automatically transfer the entire Opportunity or Visit responsibility.

## 14.7 Reassignment preserves attribution

If the Opportunity is reassigned:

- Organization ownership remains unchanged;
- prior human actions remain attributable;
- current Visit Coordinator/Host/approvals/commitments/Work should be reconsidered where affected.

Reassignment does not rewrite historical responsibility.

## 14.8 Routine scheduling need not require approval

If policy, availability evidence and capability authority permit, Gu may autonomously coordinate routine scheduling.

Protected exceptions may require Prepare + Approval.

Human approval mode is not inherent to the fact that a Visit exists.

## 14.9 Scheduled Visit ≠ mandatory reminder

A future Visit does not automatically require:

```text
send reminder 24h before
```

The Case Supervisor decides whether reminder/confirmation work is useful under current policy/context.

Legacy reminder cadence must not become a universal invariant.

## 14.10 Reschedule/cancellation invalidates stale Work applicability

Changing the arrangement may make prior future work obsolete.

Example:

```text
Reminder:
Saturday 10:00

Visit moved:
Sunday 13:00
```

The stale reminder should not execute blindly.

History of the original Work remains.

## 14.11 External-effect failure ≠ commercial outcome

If Calendar update fails after the business arrangement is agreed:

```text
scheduling business truth may remain valid
external effect = failed/unknown
```

Gu should reconcile the operational effect.

It should not fabricate:

```text
Visit cancelled
```

## 14.12 Missing human response is unresolved contribution

If Gu asks a Visit Host:

> “Can you show the property Sunday?”

and receives no answer, that is:

```text
host contribution unresolved
```

not automatically:

```text
declined
Visit cancelled
```

unless the governing source/contract establishes that semantic.

## 14.13 Quiescent Visit coordination is valid

A Visit may be:

```text
scheduled
ready enough
nothing useful to do now
```

Durable Opportunity responsibility persists while active computation sleeps.

Quiescence is valid when intentional and wakeable.

## 14.14 After the occurrence boundary

After the scheduled time passes, Visit responsibility may shift from:

```text
coordination
```

to:

```text
resolve what happened / learn from it
```

This does not create a new Case or new Visit by itself.

## 14.15 Evidence gap does not prescribe a survey

Gu may decide the best reconciliation source is:

- existing messages;
- Visit Host;
- access system;
- advisor;
- prospect;
- or no further work.

S3 does not define “send survey” as the mandatory post-Visit workflow.

## 14.16 Work completion ≠ Visit progression

Example:

```text
Work:
send reminder
status = completed
```

does not establish:

```text
Visit scheduled
Visit attended
```

Progression requires business evidence.

## 14.17 Work can coordinate several Visits

A single piece of work may coordinate a multi-property tour:

```text
Obtain driver schedule for Saturday tour
```

while each property Visit keeps distinct identity and outcome.

No canonical `ViewingPlan` is required by S3.

## 14.18 Case Supervisor coordinates capabilities; it does not absorb them

The Case Supervisor should not implement:

- Calendar internals;
- WhatsApp transport;
- access-provider internals;
- appointment-store reconciliation algorithms.

It requests/coordinates bounded capabilities under shared Gu OS contracts.

# 15. Opportunity ↔ Transaction boundary after Visits

## 15.1 Positive property interest remains Relationship evidence until a concrete deal responsibility exists

Examples that may remain entirely inside Relationship Operations:

- “I liked it.”
- “This is my favorite so far.”
- “Can we see it again?”
- “Do you think they'd accept less?”
- “What would the mortgage payment look like?”
- “Compare this one with Property B.”
- “I need to talk to my spouse.”
- “What would an offer around 5.5M imply?”

These may justify:

- more information;
- comparison;
- affordability analysis;
- another Visit;
- objection resolution;
- waiting;
- contextual guidance.

Principle:

> **Commercial momentum is not Transaction Operations merely because the prospect becomes highly interested.**

## 15.2 No keyword/CRM-stage trigger

Compare:

> “Would they accept 5M?”

with:

> “Submit a formal offer for 5.8M.”

The words may be similar.

The durable responsibilities are different.

Therefore:

> **The Transaction boundary is semantic and responsibility-based, not keyword-based.**

## 15.3 Boundary test

A separate Transaction responsibility exists when attributable evidence establishes:

> **a sufficiently concrete objective regarding this property whose execution requires coordinating and executing durable deal work from which stakeholders expect a result.**

Examples include:

- prepare/submit a concrete offer;
- manage an actual negotiation/counteroffer;
- enter a rental application;
- initiate a reservation;
- collect/manage deal-specific documents;
- manage earnest money/deposit;
- execute a contractual process;
- manage deal-specific financing;
- coordinate closing/lease execution.

That responsibility can have its own:

- objective;
- stakeholders;
- commitments;
- approvals;
- evidence;
- external effects;
- lifecycle;
- outcomes.

## 15.4 Preparation ≠ Transaction start

Relationship Operations may legitimately prepare:

- affordability analysis;
- scenario comparison;
- exploratory offer analysis;
- negotiation preparation;
- market context;
- financing estimates.

Preparation does not itself create a Transaction responsibility.

> **Transaction responsibility begins with concrete deal-execution responsibility, not merely intelligence that could support a future deal.**

## 15.5 Do not delay Transaction Operations once the boundary exists

If the prospect says:

> “Submit a formal offer for 6M.”

Relationship Operations should not absorb the downstream lifecycle of:

- formal offer submission;
- seller response;
- counteroffers;
- deal-specific approvals;
- contracts;
- deposits;
- transaction documentation.

The Case Supervisor should recognize/associate/initiate the appropriate Transaction responsibility and allow Transaction Operations to own execution.

## 15.6 Transaction start does not close the Opportunity

A Lead Opportunity may legitimately coexist with a Transaction.

For example:

```text
Property A
→ active offer Transaction

Property B
→ Visit scheduled

Opportunity
→ broader buyer objective still active
```

S1 remains authoritative over Opportunity closure.

> **Transaction start is progression evidence, not automatic Opportunity closure.**

## 15.7 Opportunity↔Transaction association is explicit

The relationship should preserve:

- source Opportunity;
- property;
- evidence/intent establishing the deal responsibility;
- timing;
- relevant context.

Do not infer canonical association merely because:

```text
same legacy lead_id
+
same property
```

ADR-109 semantics apply:

> **Business association ≠ Case lineage.**

## 15.8 One Opportunity may produce multiple Transaction responsibilities

One buyer search may produce:

```text
Transaction A
offer rejected

later:

Transaction B
offer on another property
```

Potential concurrent Transaction responsibilities are not universally forbidden by S3 if legitimate business semantics permit them.

S3 does not impose:

```text
1 Opportunity = maximum 1 Transaction
```

## 15.9 Transaction failure ≠ Opportunity failure

Rejected offer/application or failed negotiation may return the prospect to:

- search;
- comparison;
- another Visit;
- financing work;
- intentional waiting.

The Relationship Case Supervisor reconsiders current Opportunity reality.

## 15.10 Transaction success supplies lifecycle evidence

A successful downstream Transaction is strong evidence relevant to S1's objective-achievement semantics.

It does not bypass S1's lifecycle contract by directly mutating Relationship closure.

## 15.11 Relationship can continue while Transaction runs

Relationship Operations may continue to own:

- broader prospect relationship;
- changing preferences;
- alternatives;
- new inventory;
- general questions;
- strategic search context.

Transaction Operations owns:

- concrete deal terms;
- deal approvals;
- economic commitments;
- contractual process;
- deal-specific documents;
- closing/execution.

Shorthand:

```text
Relationship Operations:
How should this commercial relationship/search continue to advance?

Transaction Operations:
How do we execute this concrete deal responsibility correctly?
```

## 15.12 Case Supervisor recognizes the boundary; it does not become Transaction Ops

The Case Supervisor may:

- interpret intent;
- verify the relevant property/context;
- ask minimal clarification if materially ambiguous;
- determine whether a concrete responsibility exists;
- initiate/associate the downstream Transaction;
- pass attributable relevant context.

It does not execute the entire downstream domain inside Relationship Operations.

## 15.13 Handoff preserves relevant context

Transaction responsibility should have access to enough attributable context such as:

- Opportunity;
- Prospect;
- property;
- Visit history;
- post-Visit feedback;
- objections;
- requirements;
- relevant artifacts;
- commitments;
- authority/evidence context.

S3 does not require physical duplication of all state.

Exact cross-domain context-sharing mechanics are Technical Design.

## 15.14 No indiscriminate mirroring

Cross-domain coordination should share relevant attributable outcomes/facts/events.

It should not create competing copies of truth.

## 15.15 Subject matter alone does not define the domain

A discussion about price can remain Relationship work.

A concrete executable offer belongs to Transaction.

> **Domain boundary follows durable responsibility and consequence, not merely subject matter.**

## 15.16 Approval mode is orthogonal to domain

Relationship work may require approval.

Transaction work may contain some autonomous low-risk steps.

Therefore:

> **Human approval mode and domain responsibility are orthogonal dimensions.**

## 15.17 Artifact does not define Transaction start

A generated:

- comparison;
- offer scenario;
- negotiation brief;
- financing analysis;

does not itself create Transaction responsibility.

Preparation and commitment/execution are separate.

## 15.18 Boundary recognition must be explainable

Gu should be able to ground:

> “Why did this become a Transaction?”

in evidence such as:

> prospect explicitly instructed us to submit a concrete offer for 6M.

Not:

```text
AI stage classifier = offer
```

## 15.19 Material ambiguity can request minimal human input

Example:

> “We could try with six.”

This may mean:

- explore a scenario;
- prepare an offer;
- submit an offer.

If the distinction materially changes authority/responsibility, Gu may request the smallest useful clarification.

## 15.20 Transaction may begin without a Visit

The Transaction boundary may be crossed:

- before;
- during;
- after;

a property Visit.

Visits are an important source of Transaction-triggering evidence.

They are not a prerequisite.

## 15.21 Transaction initiation is not the optimization target

The best post-Visit next work may be:

- another property;
- waiting;
- clarification;
- financing education;
- spouse discussion;
- no contact;
- more market context;
- or Transaction initiation.

> **Gu should optimize for correctly advancing/protecting the Opportunity, not forcing an offer.**

## 15.22 No fabricated urgency or manipulative pressure

Positive Visit feedback does not authorize Gu to:

- invent competing buyers;
- fabricate scarcity;
- falsely claim price urgency;
- pressure the prospect with unsupported assertions.

Commercial progression must remain evidence-grounded.

# 16. UX and product-observability requirements

## 16.1 UX should show useful reality, not Gu OS internals

A professional normally needs answers such as:

```text
What Visit is next?
Is it actually scheduled?
What remains unresolved?
Who is showing it?
Did it occur?
What did we learn?
Do I need to do anything?
```

They should not have to operate:

- Work Item IDs;
- Case Fact schemas;
- evidence records;
- provider internals.

> **The UX should project decision-relevant Visit reality rather than expose raw internal machinery.**

## 16.2 Do not flatten materially different truth into one badge

A single:

```text
Visit status = CONFIRMED
```

may hide:

```text
Scheduled:
Tomorrow 11:00

Readiness:
Access instructions missing

Human attention:
None — Gu is resolving it
```

A UI may summarize, but materially different dimensions must remain recoverable/understandable.

## 16.3 Human-attention projection must explain the required contribution

Examples:

- advisor approval required;
- Visit Host acceptance needed;
- physical key pickup required;
- conflicting occurrence evidence requires authorized resolution.

Something being unresolved does not imply human attention.

## 16.4 Unknown must remain visible where material

When decisions, accountability or analytics depend on the distinction:

```text
occurrence = unknown
```

must not be presented as:

```text
Visit did not occur
```

or:

```text
prospect no-show
```

## 16.5 Consequential conclusions should be evidence-explainable

For materially consequential claims, the user should be able to understand the attributable evidence supporting them.

Examples:

```text
Visit occurred
Based on:
Prospect confirmed after the Visit
```

or:

```text
Prospect no-show
Based on:
Visit Host direct observation
No prior cancellation/reschedule evidence
```

This is evidence/provenance, not model Chain-of-Thought.

## 16.6 Current arrangement and material history should remain distinguishable

Example:

```text
CURRENT
Sunday 13:00

HISTORY
Originally Saturday 11:00
Rescheduled Aug 28
```

The experience should not make changed history look as if it had always been the current arrangement.

## 16.7 Multiple Visits should remain understandable

An Opportunity experience should be able to distinguish, conceptually:

```text
UPCOMING
Property A
Property B

PAST
Property C — attended
Property D — cancelled

UNRESOLVED
Property E — occurrence unknown
```

Exact layout belongs to the Design/Experience System.

## 16.8 Cross-Visit synthesis should be grounded

If Gu concludes:

> “Location appears to matter more than garden size.”

the system should retain the attributable Visit observations supporting that conclusion.

## 16.9 Transaction association should not overwrite Visit progression

An experience may show:

```text
Property A
Visit attended
Transaction: active offer
```

It should not convert Visit status into:

```text
OFFER
```

These are different business dimensions.

## 16.10 S3 owns semantics, not visual implementation

S3 defines required information such as:

- distinguish unknown vs no-show;
- explain material evidence;
- distinguish current arrangement vs history;
- explain why a human is needed.

The cross-domain **Gu OS Design/Experience System** owns:

- exact components;
- color;
- typography;
- branding;
- Organization theming;
- adaptive/generative composition;
- surface-specific Web/messaging/Voice rendering.

Relationship Operations must not invent a separate UI grammar.

# 17. Analytics and product-quality semantics

## 17.1 Count business Visits, not raw technical records

Visit metrics must derive from canonical business viewing instances and accepted progression evidence.

Do not assume:

```text
Calendar events count
=
scheduled Visit count
```

or:

```text
Mongo appointment count
=
Visit count
```

## 17.2 Preserve distinct funnel dimensions

At minimum, analytics should be able to distinguish:

- Visit requested;
- Visit scheduled;
- Visit attended;
- Visit cancelled;
- known non-occurrence;
- actor-specific no-show;
- reschedules;
- occurrence unknown.

Exact metric formulas remain downstream.

## 17.3 Unknown must never be counted as no-show

Strong invariant:

> **Visits with unresolved occurrence evidence must not be counted as actor-specific no-shows.**

An unanswered survey cannot become prospect no-show merely to complete the denominator.

## 17.4 Reschedules must not inflate Visit counts

If one Visit is scheduled, moved twice and ultimately occurs:

```text
Visits = 1
reschedules = 2
```

Potential operational metrics may include:

- reschedule count;
- coordination churn;
- time-to-stable-arrangement.

But reschedules are not additional business Visits.

## 17.5 Denominators should remain explicit

Possible future analytics may distinguish:

```text
attended / scheduled
attended / occurrence-known eligible Visits
cancellation rate
known non-occurrence rate
actor-specific no-show rate
unknown-outcome rate
```

S3 does not fix the final dashboard formulas.

It requires that the underlying distinctions are not destroyed.

## 17.6 Observe reconciliation quality, not only funnel conversion

Useful product/evaluation signals may include:

- unresolved occurrence gaps;
- time unresolved;
- evidence conflicts;
- reconciliation attempts;
- outcomes resolved autonomously;
- outcomes resolved with human input;
- outcomes intentionally left unknown;
- external-effect reconciliation.

These are useful for:

- debugging;
- evals;
- autonomy quality;
- cost;
- product reliability.

## 17.7 Observe coordination quality

Examples of valuable operating outcomes:

- stale reminder prevented after reschedule;
- duplicate Calendar effect prevented;
- access problem resolved before prospect arrival;
- unnecessary advisor interruption avoided;
- redundant survey/contact prevented.

These may not all be customer-facing KPIs.

They should remain evaluable.

## 17.8 Human/prospect burden matters

Evaluation should be able to detect excessive:

- confirmations;
- survey retries;
- redundant reminders;
- low-value advisor interruptions;
- repeated reconciliation questions.

The objective is not “fewest messages.”

The objective is:

> **Was the interaction burden justified by enough operational/commercial value?**

## 17.9 Visit-rate North Star requires actual viewing occurrence

A North Star such as:

```text
leads / Opportunities
→ effective Visits
```

should ultimately use evidence-backed actual viewing occurrence for the Visit numerator.

Request/schedule/cancellation/unknown remain diagnostic funnel dimensions.

S3 supplies the trustworthy Visit semantics; the final company-level denominator is outside this Spec.

# 18. Visit-specific stopping and re-entry

## 18.1 Gu may stop active work before all data is complete

Core rule:

> **Gu may stop active Visit-specific work when no material unresolved Visit responsibility currently justifies further action, even if nonessential facts remain unknown.**

No requirement exists that:

```text
every Visit field = complete
```

before Gu can become quiescent.

## 18.2 Pre-Visit stopping

Example:

```text
Visit scheduled
material readiness resolved
no pending external effect
no useful human contribution
no material risk
```

Then:

```text
active Visit-specific work = none
```

until:

- new event;
- material reply;
- scheduled reconsideration;
- occurrence boundary.

No continuously running loop is needed.

## 18.3 Post-Visit stopping with unknown occurrence is possible

Example:

```text
Visit expected two weeks ago
occurrence remains unknown
reasonable evidence sources exhausted
further interruption expected value low
Opportunity is currently paused for another reason
```

Gu may intentionally retain:

```text
occurrence = unknown
reconciliation = intentionally stopped
```

> **Unknown does not imply unfinished work forever.**

## 18.4 Four distinct questions

S3 explicitly separates:

```text
Is Visit outcome known?

Is current Visit coordination/outcome sufficiently settled?

Is useful Visit-specific active work needed?

Is the Lead Opportunity complete?
```

These are not equivalent.

## 18.5 Visit-specific operational completion ≠ occurrence truth

Active Visit work may be complete because:

- Visit occurred and evidence is sufficient;
- Visit was cancelled and implications are reconciled;
- non-occurrence is sufficiently understood;
- occurrence remains unknown but further work is not worthwhile;
- request was terminated/replaced;
- no current coordination responsibility remains.

It does not force one terminal business outcome.

## 18.6 Visit-specific stopping ≠ Opportunity closure

S1 remains authoritative.

A Visit may be fully settled while the Opportunity continues through:

- matching;
- another Visit;
- Transaction;
- waiting;
- other relationship work.

S3 must not introduce:

```text
case_status = VISIT_DONE
```

as a Relationship lifecycle.

## 18.7 Re-entry with late evidence

If new evidence arrives after Visit-specific work stopped:

> “By the way, we did see it and loved it.”

the Case Supervisor may:

- wake;
- accept/reconcile the evidence;
- update current Visit understanding;
- reconsider the Opportunity.

The same Visit identity may continue.

Stopping active work does not make evidence immutable.

## 18.8 Intentional stopping must be distinguishable from forgotten responsibility

For observability/evals, Gu OS should be able to establish that:

```text
no further action planned
```

was a reasoned outcome rather than an omitted/forgotten task.

This aligns with S2 quiescence semantics.

# 19. Product acceptance scenarios

Product acceptance must test business semantics and important **non-actions**, not merely successful APIs/tool calls.

## Scenario A — Legacy appointment is a request, not yet scheduled

**Given**

Traditional Gu has persisted an appointment with prospect-requested date/time, but the necessary arrangement evidence is not yet sufficient for relevant parties to rely on it.

**Expected**

```text
visit_requested = established
visit_scheduled = not yet established
```

The existence of the appointment does not mechanically set `visit_scheduled`.

## Scenario B — Delegated autonomous scheduling

**Given**

- Organization policy authorizes Gu to schedule routine viewings;
- authoritative availability is known;
- required access conditions are satisfied;
- prospect accepts the arrangement.

**Expected**

```text
visit_scheduled = established
```

No artificial human approval click is required.

## Scenario C — Scheduled but readiness incomplete

**Given**

- Sunday 13:00 is a reliable agreed arrangement;
- access instructions are still missing.

**Expected**

```text
visit_scheduled = established
readiness = unresolved access issue
```

Gu may resolve access work without erasing scheduling progression.

## Scenario D — Same-property reschedule

**Given**

```text
Property A
Saturday 11:00
→ Sunday 13:00
```

**Expected**

- same Visit identity;
- old schedule preserved historically;
- current schedule updated;
- stale dependent Work/effects reconsidered;
- Visit counts not inflated.

## Scenario E — Property change

**Given**

an appointment/interaction changes from Property A to Property B.

**Expected**

- Property B viewing is a distinct Visit;
- Property A Visit history is preserved;
- mutable legacy appointment identity does not redefine canonical Visit continuity.

## Scenario F — Cancellation

**Given**

the prospect cancels the Visit before occurrence.

**Expected**

```text
Visit cancelled
```

and not:

```text
prospect no-show
Opportunity lost
```

unless separate evidence establishes those facts.

## Scenario G — Scheduled time passes; no evidence

**Given**

scheduled Visit time has passed and no defensible occurrence evidence exists.

**Expected**

```text
occurrence = unknown
```

No automatic attendance/no-show inference.

## Scenario H — Prospect confirms actual Visit

**Given**

prospect explicitly says:

> “Yes, we saw the property yesterday.”

**Expected**

```text
visit_attended = established
```

while property reaction may still be unknown.

## Scenario I — Spouse attends on behalf of buying party

**Given**

the named Prospect does not attend physically but their spouse meaningfully views the property as part of the same buyer household/objective.

**Expected**

- Visit may qualify as `visit_attended`;
- named Prospect's personal attendance can remain separately false/unknown;
- participant attribution preserved.

## Scenario J — Negative legacy occurrence survey

**Given**

```text
property_was_visited = "Negativo"
```

with no additional reason evidence.

**Expected**

```text
Visit non-occurrence = supported
```

but not automatically:

```text
prospect no-show
advisor no-show
access failure
```

## Scenario K — Actor-specific no-show

**Given**

- Visit remained valid/expected;
- Visit Host was present;
- authorized direct evidence establishes the Prospect did not arrive;
- no prior cancellation/reschedule evidence applies.

**Expected**

actor-specific prospect no-show may be established.

## Scenario L — Conflicting occurrence evidence

**Given**

- Prospect says Visit did not occur;
- Visit Host says it did.

**Expected**

- preserve both claims/provenance;
- no latest-write-wins;
- reconcile if material;
- allow explicit conflict/unknown if unresolved.

## Scenario M — Late occurrence evidence

**Given**

Visit was previously left unknown and active reconciliation stopped.

Later the prospect confirms attendance.

**Expected**

- same Visit reconsidered;
- accepted current truth corrected;
- prior unknown history preserved;
- no new Visit solely because evidence arrived late.

## Scenario N — Negative property feedback

**Given**

prospect says:

> “We saw it, but it is too small.”

**Expected**

```text
visit_attended = established
property reaction = negative
reason = too small
```

No automatic Opportunity closure.

## Scenario O — Feedback changes broader requirements

**Given**

after several Visits, evidence supports that commute/location is consistently more important than garden size.

**Expected**

Gu may synthesize a broader requirement/preference update with underlying Visit evidence retained.

## Scenario P — Positive interest but no concrete Transaction

**Given**

prospect says:

> “This is definitely my favorite. Do you think they'd accept less?”

**Expected**

- strong commercial interest;
- Relationship Operations continues;
- no Transaction Case merely because interest is high.

## Scenario Q — Concrete offer instruction

**Given**

prospect says:

> “Submit a formal offer for 6 million pesos.”

**Expected**

- concrete Transaction responsibility recognized;
- explicit Opportunity↔Transaction association;
- Transaction Operations owns concrete deal lifecycle;
- Lead Opportunity remains open unless S1 lifecycle evidence independently closes it.

## Scenario R — Exploratory offer ambiguity

**Given**

prospect says:

> “We could try with six.”

**Expected**

Gu interprets context and, if the distinction is materially consequential, requests minimal clarification about whether this means:

- analyze;
- prepare;
- or submit.

The model does not infer submission authority from ambiguous wording.

## Scenario S — Transaction fails

**Given**

a concrete offer Transaction is rejected.

**Expected**

- Transaction may close/fail according to its own domain;
- Opportunity does not automatically become `lost`;
- Relationship Case Supervisor reconsiders useful next work.

## Scenario T — External Calendar effect fails

**Given**

the business arrangement is genuinely scheduled, but Calendar update fails.

**Expected**

- scheduling truth is not automatically cancelled;
- operational external-effect failure/unknown is reconciled;
- stale/duplicate effects are avoided.

## Scenario U — No mandatory reminder

**Given**

Visit is scheduled and ready.

**Expected**

Gu may intentionally perform no reminder work when current policy/context indicates no useful reminder is needed.

The presence of a future Visit does not automatically generate a reminder task.

## Scenario V — Evidence gap not worth pursuing

**Given**

occurrence remains unknown, available sources have been checked, further outreach has low expected value.

**Expected**

- `occurrence = unknown`;
- active Visit-specific reconciliation may stop;
- no infinite survey/retry loop;
- Opportunity lifecycle remains independently governed by S1.

## Scenario W — Multi-property tour

**Given**

three properties are coordinated in one Saturday tour.

**Expected**

- logistics Work may span all three;
- three separate Visit identities exist;
- each has its own occurrence/feedback/progression;
- no mandatory `ViewingPlan` entity required.

## Scenario X — Important non-actions

The system should explicitly verify that Gu:

- does **not** infer no-show from silence;
- does **not** infer attendance from Calendar completion;
- does **not** create a new Visit for a normal same-property reschedule;
- does **not** mutate prior Visit history when property changes;
- does **not** create Transaction responsibility from casual/positive interest alone;
- does **not** require human approval where scheduling authority is delegated;
- does **not** close the Opportunity merely because Transaction starts;
- does **not** close the Opportunity merely because a property was rejected;
- does **not** overwrite genuine evidence conflict through latest-write-wins;
- does **not** repeatedly pursue low-value missing evidence;
- does **not** execute stale reminder/coordination Work after material reschedule/cancellation;
- does **not** treat successful tool/provider invocation as proof of real-world Visit progression.

# 20. Relationship to S1, S2, S4 and downstream domains

## 20.1 S1 remains authoritative for Opportunity lifecycle

S3 provides Visit evidence that may affect:

- progression;
- commercial viability;
- objective achievement;
- Transaction start;
- closure evidence.

S3 does not redefine:

- Opportunity identity;
- continuity;
- duplicate/merge/split lifecycle;
- closure outcome;
- reactivation.

Those remain S1.

## 20.2 S2 remains authoritative for situational next work

S3 defines what Visit facts/claims mean.

S2 determines:

> **Given the current Opportunity reality, what work, if any, is useful now?**

S3 therefore does not create a separate Visit-specific supervisor/runtime.

The Lead Opportunity Case Supervisor uses S3 semantics while operating under S2.

## 20.3 S4 owns Work Portfolio / Needs Attention

S3 may establish that a Visit:

- has an approval requirement;
- requires physical human action;
- has a material evidence conflict;
- has no human need because Gu is resolving it.

S4 owns:

- how such human-needs project across Cases;
- `Needs Attention`;
- cross-Case ranking;
- Work Portfolio supervisory semantics.

## 20.4 Transaction Operations owns concrete deal execution

S3 refines how Visit/post-Visit evidence can satisfy the S1 Transaction boundary.

It does not define the downstream Transaction lifecycle.

## 20.5 Cross-domain Design/Experience System owns exact UI expression

S3 owns semantic requirements such as:

- unknown distinguishable from no-show;
- evidence explainability;
- historical/current arrangement distinction;
- reason for human attention.

The cross-domain Design/Experience System owns exact visual and surface implementation.

# 21. Architecture compatibility and shared-kernel implications

S3 does not require reopening accepted R1 architecture.

It is compatible with:

## AC-2 / fact-level authority

Source evidence is interpreted into accepted Case/Visit truth with provenance.

## AC-7 / progression

Visit progression is evidence-backed, non-linear and potentially repeating rather than one CRM stage.

## AC-8 / Work orchestration

Visit coordination/reconciliation uses the shared Case Supervisor + Work Plane.

S3 clarifies that an evidence gap is **ordinary shared work when resolving it is worthwhile**, but does not automatically imply a durable Work Item.

## ADR-107 / authority

Visit-related external effects revalidate runtime, conversation and business authority before execution.

## ADR-109 / Case relationships

Opportunity↔Transaction association is a typed business association and does not imply lineage or Opportunity closure.

## ADR-110 / resource usage

Visit coordination/reconciliation cost can use generic cross-domain usage/cost attribution rather than Visit-specific ledgers.

No Visit-specific:

- scheduler;
- retry engine;
- approval engine;
- evidence store;
- external-effect ledger;
- workflow engine;

is justified by this Spec.

# 22. Open Technical Design questions

The following intentionally remain downstream:

## Visit representation

- Is Visit represented as a first-class shared/domain entity, structured Case Facts/projections, or another durable representation?
- What canonical Visit ID is used?
- How is Visit identity mapped to one or more mutable legacy appointment records?

## Fact/evidence model

- Exact Fact/claim keys.
- Exact observed/interpreted/inferred evidence structure.
- Exact participant-attendance representation.
- Exact conflict/current-projection materialization.
- Exact evidence admissibility rules by provider/source.

## Scheduling/readiness

- Exact predicate/materialization for `visit_scheduled`.
- Exact readiness projection.
- Exact invalidation mechanism for stale confirmation/readiness evidence after reschedule.

## External effects

- Appointment/Calendar command contracts.
- Idempotency and partial-effect reconciliation.
- Correlation across legacy appointment IDs / Calendar IDs / Work Attempts.

## Reconciliation

- Exact Work Item shapes.
- Exact wake-up/event mechanics.
- Any product-specific limit/budget policy for reconciliation.
- Exact use of prospect survey vs other sources.

## Analytics

- Final metric definitions/denominators.
- Materialized Visit funnel projections.
- Attribution to Opportunity/cohort/source/advisor.
- Visit-rate North Star denominator.

## Transaction

- Exact creation/association capability for Transaction Cases.
- Exact context-transfer/reference contract.
- Exact downstream Transaction lifecycle.

## UX / Design System

- Exact Interaction Primitive contracts.
- Visit-specific compositions/views.
- Organization branding/theme adaptation.
- Web/messaging/Voice surface behavior.

These questions must not reopen S3 semantics unless implementation evidence reveals a genuine product contradiction.

# 23. Post-approval companion document sync — completed

The two documentation alignments required by S3 approval have been completed. They refine wording and target-semantic references without reopening architecture decisions or changing source-verified legacy facts.

## Architecture Analysis / AC-8 clarification — completed

`architecture-analysis.md` v0.13 now clarifies:

> **Evidence gaps are ordinary shared Case work when resolving them is worthwhile; they do not automatically create Work Items. Durable Work is used when reconciliation requires durable execution semantics.**

This is a wording refinement, not an architecture reversal.

## Legacy Source Audit clarification — completed

`legacy-source-audit.md` v0.2 now makes S3 the governing target semantic contract for Visit progression/evidence and clarifies that:

- `visit_confirmed` was an early evidence-mapping candidate, not a target mandatory progression milestone;
- legacy negative occurrence evidence supports non-occurrence but does not itself establish actor-specific no-show;
- unresolved occurrence may remain `unknown`/conflicted and reconciliation is pursued only when materially worthwhile.

The source-verified legacy facts remain unchanged.

No accepted ADR was revised solely because of S3.

# 24. Approval statement

**Approval of S3 means Product/Domain leadership accepts the following governing behavior:**

A Visit is an identifiable property-viewing instance within a Lead Opportunity and not a separate Case by default. `visit_requested`, `visit_scheduled` and `visit_attended` are evidence-backed progression milestones with distinct meanings; appointment persistence, confirmation/readiness, Calendar state and actual occurrence must not be collapsed.

Scheduling reliability is distinct from readiness. Rescheduling normally preserves Visit identity when the same property viewing continues; property change creates a different Visit. Cancellation, non-occurrence, actor-specific no-show and unknown are separate semantics. Missing evidence and silence do not establish no-show.

Occurrence and post-Visit commercial reaction remain separate. Feedback preserves attributable reasons and may update broader Opportunity understanding without automatically declaring the Opportunity lost or creating a Transaction.

Visit truth is multidimensional, source/claim-specific and provenance-backed. Conflicts may remain unresolved. Reconciliation is proportional and decision-sufficient; an evidence gap does not automatically create Work or justify indefinite outreach.

The Lead Opportunity owns Visit-related responsibility. Commitments, Work and human contributions remain separate concepts. The Case Supervisor coordinates situational work under S2 rather than following a rigid Visit workflow.

Strong property interest remains Relationship evidence until a sufficiently concrete deal-execution objective creates its own durable Transaction responsibility. Transaction start does not automatically close the Opportunity; Transaction failure does not automatically mean Opportunity loss; Opportunity↔Transaction association is explicit business association rather than lineage.

Visit UX/analytics must preserve material distinctions such as unknown vs no-show and business Visit vs technical appointment records. Reschedules do not inflate Visit counts. Evidence-backed actual viewing occurrence supplies the trustworthy Visit concept needed for downstream Visit-rate measurement.

Gu may intentionally stop active Visit-specific work when no material unresolved Visit responsibility justifies further action, even while some facts remain unknown. Such stopping is distinct from Visit occurrence truth and from Lead Opportunity completion, and later evidence may wake reconsideration while preserving history.

---

> **Document status: APPROVED — Product / Domain behavioral contract for S3.**
