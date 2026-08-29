# Situational Progression, Next Work & Human Authority

> **Version:** v0.3  
> **Status:** **APPROVED — Product / Domain behavioral contract for S2**  
> **Owner / decision owner:** Product / domain leadership  
> **Contributors:** Product, domain, engineering, design, architecture  
> **Initiative:** [Relationship Operations](../brief.md) — R1 Relationship Operations v1  
> **Parent product intent:** [Gu / Gu OS Product Requirements Document](../../../PRD.md)  
> **Initiative Brief:** [Relationship Operations — Initiative Brief](../brief.md) — v0.9  
> **S1 behavioral contract:** [Lead Opportunity Lifecycle & Responsibility](./lead-opportunity-lifecycle.md) — v0.3 approved  
> **Companion discovery mapping:** [R1 Concept → Shared Kernel Mapping](../r1-concept-shared-kernel-mapping.md) — v0.9  
> **Architecture Analysis:** [R1 Architecture Analysis](../architecture-analysis.md) — v0.12 complete  
> **Legacy source audit:** [Traditional Gu Legacy Source Audit](../legacy-source-audit.md) — v0.1 complete for R1 Technical-Plan entry  
> **Relevant ADRs:** ADR-106 Organization-Native Multi-seat Tenancy; ADR-107 Runtime / Conversation Authority; ADR-108 Versioned Organization Policy; ADR-109 Generic Case Relationships / Lineage; ADR-110 Resource Usage & Cost Attribution  
> **Roadmap:** [Gu OS Evolution Roadmap](../../../../roadmap/gu-os-evolution-roadmap.md) — R1  
> **Doctrine:** [Gu OS Principles & Design Doctrine](../../../../principles/gu-os-principles-and-design-doctrine.md)  
> **Development method:** [Gu OS Agentic Product & Software Development Methodology](../../../../development/agentic-product-software-development-methodology.md)  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/specs/situational-progression-next-work-human-authority.md`  
> **Artifact role:** Governing contract for how an admitted Lead Opportunity is reconsidered over time, how its Case Supervisor discovers and chooses useful work, how adaptive work may learn/replan, what work Gu may initiate autonomously, how research/Tools/artifacts and human contribution participate, how commitments/evidence gaps remain durable, how prospect-facing delivery is governed across channels, and how execution results feed the next decision. This Spec does not own exact schemas, queue/event mechanics, adapter endpoints, prompt/model selection, Work Item persistence details, channel-specific transport implementation, or future channel capability contracts.

---
## 1. Summary and decision

S1 defines **when a Lead Opportunity exists and remains a durable commercial responsibility**. S2 defines how that responsibility operates after admission:

> **Given the current reality of this Opportunity, what work—if any—would best advance, protect, clarify or unblock its durable commercial objective now?**

The answer is not limited to choosing a prospect message or CRM task. The **Case Supervisor chooses work, not merely messages**. It may determine that the best next work is to reason, retrieve fresh operational information, investigate an authorized source, use a Tool/Skill/capability, perform analysis or calculation, create a contextual artifact or visualization, reconcile evidence, obtain targeted human knowledge, prepare an external action, execute an allowed action, wait, or deliberately do nothing.

Next-work selection is **situational and adaptive**. Gu should diagnose the current progress constraint or advancement opportunity, consider the likely value and consequences of candidate work, and may follow a bounded multi-step strategy whose later steps change as new information is discovered. A timer, new message, property match, appointment change, human intervention, commitment deadline, missing expected outcome or other signal is a **reason to reconsider**; it is not automatically an instruction to execute a predetermined action.

Gu may autonomously initiate work reasonably implied by the durable Opportunity objective. Humans delegate the objective/responsibility rather than manually decomposing every task. However, dynamic planning and proactive initiative do not create authority. Execution remains bounded by:

- the durable Opportunity objective and S1 continuity/lifecycle contract;
- available and authorized capabilities;
- fresh evidence and source authority;
- platform hard bounds and published organization policy;
- organization/tenant authorization;
- runtime decision authority;
- conversation authority;
- business approval authority;
- prospect preferences and delivery/engagement constraints;
- privacy and data-use constraints;
- material resource/cost bounds;
- evidence, verification and external-effect requirements.

Human involvement is selected by **what contribution is actually needed**, not by a blanket approval model. S2 distinguishes:

1. **Autonomous** — Gu is authorized and human involvement adds little material value.
2. **Act + inform** — Gu is authorized to act; a human benefits from awareness.
3. **Targeted human input** — Gu retains responsibility but needs specific human knowledge/judgment.
4. **Prepare + approval** — Gu may do the preparatory intelligence, but a protected commitment/effect requires authorized human approval.
5. **Human-as-executor** — a human must perform a physical/off-platform or otherwise human-only contribution while Gu coordinates.
6. **Human takeover** — the relationship/conversation itself materially benefits from a human conversational lead while Gu continues allowed supporting work.

Execution is part of a loop, not the end of it:

```text
observe / wake
    ↓
understand current reality
    ↓
diagnose progress constraint or advancement opportunity
    ↓
choose bounded work / adaptive short strategy
    ↓
execute / learn / wait / involve human
    ↓
observe evidence and actual effect
    ↓
reconsider / replan
```

The operating objective is not activity, message count or reply probability in isolation:

> **Creating activity is not the objective; advancing or protecting the durable Opportunity and relationship is.**

**Approval of this Spec means:** the situational work-discovery, adaptive planning, proactive initiative, human-involvement, authority, commitment, research, delivery, execution-verification, within-Case adaptation and stopping behavior described here becomes the approved R1 product contract for an admitted Lead Opportunity.

**Approval of this Spec does not mean:** approval of a specific Case Supervisor service/process, workflow graph, model/prompt/provider, database table, event bus, queue, Tool implementation, browsing provider, artifact renderer, Work Item schema, timeout value, budget formula, RLS implementation, or WhatsApp/Web/Telegram/voice transport mechanism.

## 2. User and business objective

### 2.1 User objective

A real-estate professional should be able to delegate ongoing responsibility for an admitted buyer/renter Opportunity to Gu without manually:

- checking every lead to decide whether it needs follow-up;
- creating a task for every future reconsideration;
- remembering commitments and promised callbacks;
- deciding whether every new event deserves a message;
- monitoring every appointment/evidence gap;
- approving routine low-risk communication;
- operating a CRM stage/pipeline simply to keep work moving.

The professional should still retain appropriate control where human authority, trust, negotiation, commercial commitment or relationship sensitivity matters.

### 2.2 Business objective

Reduce opportunity leakage and unnecessary human effort while increasing the probability that viable Opportunities progress toward meaningful outcomes—especially visits—without degrading relationship quality or allowing Gu to exceed delegated authority.

### 2.3 Success signal

In a production-representative pilot:

- admitted Opportunities remain active across days/weeks and asynchronous events;
- Gu chooses useful next work based on current context rather than fixed follow-up timers;
- routine low-risk progression occurs without unnecessary human approval;
- important human interventions surface when actually needed;
- Gu does not collide with an advisor who is actively handling the relationship;
- material commitments and expected outcomes are not forgotten;
- missing evidence produces reconciliation rather than invented truth;
- prospect-facing external effects can be tied to current authority, policy and evidence;
- human corrections/takeovers do not destroy Case continuity;
- outcome and cost telemetry can correlate work, decisions and observed outcomes strongly enough to support evaluation without overstating causal certainty.

---

## 3. Actors, responsibilities, and authority

| Actor / system | Responsibility in this Spec | Authority / limits |
|---|---|---|
| **Gu / Case Supervisor** | Reconsider the Opportunity, interpret current context, identify useful next work, decide whether human involvement is needed, and propose/execute allowed work. | May not invent authority, bypass policy, assert unsupported outcomes, or continue prospect-facing work when conversation/runtime authority forbids it. |
| **Prospect / contact** | Supplies intent, responses, objections, requirements, timing preferences, explicit contact restrictions and other relationship evidence. | Their statements are evidence/context; they do not directly mutate Gu OS runtime controls. Explicit opt-out/contact timing must be honored under policy. |
| **Assigned advisor / DRI** | Contributes relationship/business knowledge, handles physical-world or authority-sensitive work, responds to targeted requests, and may take over the conversation. | Assignment alone does not imply unlimited approval authority. Human actions must still be organization-authorized. |
| **Organization / brokerage** | Defines policy for autonomous relationship work, contact behavior, human gates and escalation within platform hard bounds. | Cannot weaken platform/security/privacy/tenant boundaries or authorize actions outside delegated capability/authority. |
| **Authorized principal/admin/manager** | Approves protected organization-level decisions, policies or high-consequence business commitments where required. | Authority is role/grant-specific; legacy role labels are migration inputs, not the permanent Gu OS security model. |
| **Traditional Gu / messaging runtime** | During migration, may provide WhatsApp ingress/egress, persistence, human-intervention signals and bounded operational capabilities. | May not independently decide the same Gu OS-owned prospect-facing work when runtime authority has transferred to Gu OS. |
| **Operational source systems** | Provide fresh lead/message/property/appointment/assignment/provider evidence. | Their facts are source-specific; existence or absence of one field must not be over-interpreted beyond the source contract. |
| **Gu OS Case / Work kernel** | Persists durable responsibility, facts, approvals, Work, scheduling and evidence/recovery semantics. | Generic runtime state is not the commercial relationship lifecycle or human-attention ranking. |
| **BigQuery analytical plane** | Historical analytics, KPIs, cohorts/evaluation. | Must not govern live prospect-facing next-work decisions when fresher operational data is required. |

---

## 4. Terminology and domain concepts

| Term | Definition in this Spec | Not to be confused with |
|---|---|---|
| **Case Supervisor** | The conceptual agentic/runtime role that reconsiders one Operational Case and determines/proposes what work best advances its durable objective now within governing constraints. For S2, this is the Case Supervisor for a Lead Opportunity. | A Relationship-specific runtime/service/table, a Work Portfolio, or the human advisor/manager. |
| **Reconsideration / Case wake-up** | A moment when current Opportunity reality should be re-evaluated. | A command to send or execute a predetermined action. |
| **Next work** | Work that appears useful now to advance, protect, clarify or reconcile the Opportunity. | The next prospect message, a permanently precomputed CRM task, or necessarily one Work Item. |
| **Progress constraint** | A material uncertainty, obstacle, missing condition or relationship issue currently limiting useful progression. | A generic negative CRM stage. |
| **Advancement opportunity** | A new condition or possibility that could materially improve the Opportunity if acted on appropriately. | Automatic permission to act. |
| **Adaptive work strategy** | A bounded one- or multi-step approach whose later work may branch, stop, change or extend as new evidence is discovered. | An unbounded agent loop or a fixed workflow that must finish every preplanned step. |
| **Situational operation** | Choosing work from current objective, facts, events, policy, authority, commitments and evidence rather than following only a fixed timer/sequence. | Unbounded model autonomy. |
| **Scheduled reconsideration** | A future time when the Case should wake and reassess what is appropriate then. | A Work Item, Durable Task / Work Run, or already-committed deferred action. |
| **Committed deferred Work Item** | Concrete executable work inside the Opportunity that is already intended/authorized for later execution and requires durable Work semantics. | A reminder to decide later what to do. |
| **Commitment** | A sufficiently specific expected outcome/obligation on which another party can reasonably rely and whose loss could materially affect relationship or outcome. | A Work Item, casual model suggestion or generic future possibility. |
| **Evidence gap** | A commercially material expected outcome whose status remains unresolved after the relevant time/event boundary. | Proof that the expected outcome failed. |
| **Work Item** | Durable executable work attached to the Opportunity Case when the work must persist independently because it may wait, retry, depend on other work, involve humans, create a material effect or preserve independent execution/evidence. | The Lead Opportunity Case or a Durable Task / Work Run. |
| **Durable Task / Work Run** | Independent durable work that does not naturally belong to a commercial Case. | The normal execution mechanism for work owned by a Lead Opportunity. |
| **Action authority** | Whether Gu may perform a specific class of action/effect. | Runtime decision authority, conversation authority or business approval authority. |
| **Runtime decision authority** | Which runtime is currently allowed to decide prospect-facing work for the governed interaction/scope during migration. | Which service physically transports a message. |
| **Conversation authority** | Whether Gu or an active human should currently lead/speak in a specific conversation. | Durable Opportunity responsibility. |
| **Business approval authority** | Authority to approve a protected economic, contractual, negotiation or other consequential commitment. | Assigned-advisor status by itself. |
| **Targeted human input** | A bounded request for missing knowledge/judgment while Gu keeps the operational responsibility. | Full conversation takeover or formal approval. |
| **Human takeover** | A period in which a human actively leads the relevant relationship/conversation and Gu suppresses competing speaking while continuing allowed observation/support. | Closing, pausing or transferring the entire Lead Opportunity Case. |
| **Act + inform** | Gu is authorized to execute and then surface the action/result to a relevant human because awareness is useful. | Approval-before-action. |
| **Prepare + approval** | Gu prepares/researches/analyzes/proposes a consequential action but must not execute the protected commitment/effect until an authorized human approves. | Asking for ordinary missing information. |
| **Decision-sufficient evidence** | Evidence adequate for the consequence of the current decision, without requiring exhaustive knowledge. | Perfect certainty. |
| **Prospect research** | Authorized research into relevant public/authorized professional, business or contextual information about the prospect when legitimately related to the Opportunity. | Unbounded or irrelevant personal surveillance. |
| **Context research** | Authorized research about the commercial objective and surrounding market/property/company/neighborhood/industry/financing/regulatory context. | Operational source authority for facts owned by another source. |
| **Generated artifact** | A contextual comparison, calculation, visualization, brief, document or other created output used to improve a decision or interaction. | Proof that the artifact was delivered or that the Opportunity progressed. |
| **Feedback scope** | The narrowest durable subject that a correction, preference or feedback item legitimately describes: current Case, Prospect/Contact, User/Advisor, or Organization Policy. | Automatically treating one local observation as global policy. |
| **No-op / deliberate inaction** | A valid reconsideration result where no work is useful/allowed now. | Runtime failure or lost Opportunity. |
| **Quiescent Opportunity** | An open Opportunity with no active computation/work because waiting/no-op is currently correct, but with durable context and a meaningful route to wake again. | Forgotten/abandoned responsibility. |

## 5. Source-status and evidence basis

| Statement / area | Status | Source / evidence |
|---|---|---|
| R1 must replace timer-only follow-up with situational next-work decisions | TARGET — APPROVED | Initiative Brief v0.9 |
| Routine prospect communication / low-risk progression may be autonomous under policy/fresh data | TARGET — APPROVED | P0-3 |
| Human involvement proportional to consequence, authority, ambiguity and recoverability | TARGET — APPROVED | P0-7 |
| Action authority, runtime authority and conversation authority are distinct | TARGET — APPROVED | P0-3 + ADR-107 |
| Case admission does not transfer runtime authority | TARGET — APPROVED | Initiative Brief + ADR-107 |
| Exactly one runtime may autonomously decide the same governed prospect interaction | TARGET — APPROVED | Initiative Brief + ADR-107 |
| Human takeover may suppress Gu speaking while Case observation/reasoning continues | CURRENT — LEGACY SOURCE VERIFIED + TARGET — APPROVED | `legacy-source-audit.md` + ADR-107 |
| Traditional Gu current takeover uses `bypass_bot`/human-interaction timestamp and scheduled resume | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| The legacy >5-minute resume threshold is not a Gu OS product invariant | TARGET — ARCHITECTURE ACCEPTED | Architecture Analysis v0.12 |
| Appointment persistence can partially succeed across legacy stores | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| `wamid`/later provider failures are available but initial queue/HTTP acceptance is not final delivery proof | CURRENT — LEGACY SOURCE VERIFIED | `legacy-source-audit.md` |
| BigQuery is analytical, not fresh live operational authority | CURRENT — REPO VERIFIED / TARGET — ACCEPTED | Architecture Analysis v0.12 |
| Case wake-up as situational reconsideration + shared Work Plane | TARGET — ARCHITECTURE ACCEPTED | AC-8 |
| Organization Policy is typed/versioned; NL authoring is not runtime authority | TARGET — ADR ACCEPTED | ADR-108 |
| Exact event envelope, Work persistence mechanics, authority resolver implementation and adapters | OPEN — TECHNICAL DESIGN | Architecture Analysis v0.12 |

**Status rule:** source-verified Traditional Gu facts are recorded in `legacy-source-audit.md`; this Spec defines product behavior that should remain stable even if the legacy implementation is later replaced.

---

## 6. Preconditions and triggering context

### 6.1 Preconditions

For S2 situational progression to govern an Opportunity:

- a Lead Opportunity has been admitted under S1;
- the relevant Organization / tenant context is resolved and authorized;
- runtime decision authority is known before Gu makes or executes a governed prospect-facing decision/effect; unresolved runtime authority may itself become bounded work and does not necessarily prohibit authorized, non-conflicting internal research/reconciliation/shadow work;
- the Case has enough current context to reconsider responsibly, or the ability to gather it through bounded capabilities;
- applicable organization/platform policy can be resolved;
- any intended external action can be mapped to a bounded capability with explicit authority/evidence expectations.

### 6.2 Triggering situations

A reconsideration may be triggered by:

- a new prospect message;
- a new advisor/human message or observable takeover;
- a human correction, input, decision or approval;
- an appointment request/change/cancellation/visit outcome;
- a materially new or changed authorized property match;
- a property becoming unavailable or materially changing;
- an assignment/DRI change;
- a material Legacy Deal / transaction-related signal;
- a scheduled reconsideration point (`next_action_at`-like product meaning);
- a commitment becoming due;
- an evidence gap reaching a meaningful reconciliation boundary;
- completion/failure of prior Work;
- a provider delivery failure/unknown outcome that requires reconciliation;
- a relevant policy/authority change where explicit reassessment is required.

### 6.3 Situations that do **not** by themselves trigger a predetermined prospect-facing action

- a timer elapsed;
- a Case woke up;
- a new property match exists;
- a prospect has been silent for N hours/days;
- an appointment field remains null;
- a prior outbound message was queued/HTTP-accepted;
- an Opportunity exists;
- a Work Item failed;
- an internal model thinks another message might be useful;
- BigQuery shows low historical momentum;
- a legacy field changed without evidence that the change is semantically relevant.

These may trigger **reconsideration**, not mechanical action.

---

## 7. Scope

### 7.1 In scope

- What causes an admitted Opportunity to be reconsidered.
- What context should influence next-work selection.
- Diagnosing a current progress constraint or advancement opportunity.
- Choosing among multiple candidate pieces of work without a universal rigid scoring formula.
- Information-gathering/learning work before prospect-facing action.
- Bounded multi-step adaptive work strategies and replanning as new evidence appears.
- Proactive/self-initiated work implied by the durable Opportunity objective.
- Research through authorized operational/external sources and relevant prospect/context research.
- Tool/Skill/capability use and capability-gap behavior.
- Creation of contextual artifacts/visualizations and the separation between creation and delivery.
- Decision-sufficient evidence, diminishing returns and resource proportionality.
- When deliberate no-op/wait is correct.
- Scheduled reconsideration vs committed deferred Work Items.
- Durable commitments and expected outcomes.
- Evidence-gap detection and reconciliation behavior.
- Routine autonomous communication / low-risk relationship progression.
- `autonomous`, `act+inform`, targeted human input, `prepare+approval`, human-as-executor and human takeover.
- Relationship-risk judgment distinct from simplistic sentiment classification.
- Runtime/conversation/business-approval authority behavior.
- Advisor/human takeover and governed return-to-Gu behavior.
- Channel-aware but channel-general delivery behavior across currently/future supported authorized surfaces.
- Freshness/source requirements before consequential prospect-facing action.
- Duplicate/retry/unknown-outcome behavior visible to users/business operations.
- Execution-result verification, strategy continuation/stopping and replanning.
- Within-Case adaptation from human corrections, rejected recommendations and observed outcomes.
- Case Supervisor stopping/yield conditions and intentional quiescence.
- Relationship between model judgment and deterministic/governed constraints.
- Acceptance scenarios sufficient to guide S2 implementation planning.

### 7.2 Non-goals

- Admission, continuity/new-Opportunity, closure taxonomy or reactivation semantics already owned by S1.
- Exact visit evidence hierarchy/field mapping and outcome semantics beyond generic reconciliation needs; owned by S3.
- Full Work Portfolio ranking/UX; owned by S4.
- Full Transaction Operations behavior.
- Cross-Case/global Business Brain learning or autonomous organization-wide policy learning.
- Exact organization/membership/RLS schema.
- Exact event bus, queue, webhook, inbox/outbox or scheduler mechanism.
- Exact Case Supervisor service/process/runtime packaging.
- Exact Work Item table/schema/granularity implementation.
- Exact Tool/browser/provider implementation or universal Tool allowlist.
- Exact artifact-rendering stack.
- Exact prompt/model/provider choice.
- Exact per-Case/token/tool-call/budget thresholds.
- Exact WhatsApp, Web Chat, Telegram or future real-time voice transport/routing implementation.
- A universal customer-configurable workflow builder.
- Full CRM task/pipeline recreation.
- Customer billing/credit policy.

## 8. Behavioral contract

### 8.1 Core invariants

#### Situational work and adaptation

1. **Wake-up is reconsideration, not action.** A source event or timer must not mechanically imply a message or other external effect.
2. **The Case Supervisor chooses work, not merely messages.** Next work may be reasoning, retrieval, research, analysis, Tool use, artifact creation, reconciliation, human contribution, external action, waiting or no-op.
3. **Diagnose before acting.** Gu should identify the current progress constraint or advancement opportunity before selecting work.
4. **Next work is situational.** Gu evaluates current objective, evidence, recent interaction, commitments, prior work/results, fresh operational state, policy, authority and expected consequences before deciding what is useful now.
5. **The best next work may improve the next decision rather than directly produce the next interaction.**
6. **Adaptive plans may evolve as Gu learns.** Later steps may branch, stop, change or extend as new evidence appears.
7. **Plans are hypotheses about useful work, not rails.** Obsolete planned steps should not execute merely because they were once chosen.
8. **No-op is valid.** If no useful/allowed action exists, Gu may deliberately do nothing and leave a coherent future/event reconsideration path.
#### Authority and human involvement

9. **Dynamic planning and proactive initiative do not grant authority.**
10. **Action authority, runtime authority, conversation authority and business approval authority remain distinct.**
11. **Exactly one autonomous runtime decides the same governed prospect-facing interaction; unresolved runtime authority does not by itself prohibit authorized non-conflicting internal work.**
12. **Human takeover suppresses competing Gu speaking, not durable responsibility by default.**
13. **Use the smallest human intervention that materially improves the situation.**
14. **Approval gates the protected commitment/effect, not the preparatory intelligence.**
15. **Missing information is normally a targeted input/research problem, not automatic takeover.**
16. **Negative sentiment is a signal, not a handoff rule.**
17. **Human takeover is for relationship leadership, not every difficult problem.**
18. **Consequential external effects revalidate current authority/policy/freshness immediately before execution.**
19. **A timer cannot override explicit prospect contact restrictions, active-human authority or other delivery prohibitions.**
20. **Allowed to contact does not mean useful to contact.**
21. **Prefer value-bearing re-engagement over repetitive reminder-only outreach.**
#### Durability, evidence and external effects

22. **Commitments survive sessions when another party can reasonably rely on the expected outcome.**
23. **Scheduled reconsideration remembers when to think again; a commitment remembers what someone is relying on.**
24. **Evidence gaps create reconciliation; missing evidence remains unknown rather than becoming invented negative truth.**
25. **Commitments and Work Items are related but not identical.**
26. **For Relationship Operations, the default durable root is the Lead Opportunity Case; durable execution beneath it uses Work Items. Durable Tasks / Work Runs are for independent non-Case work.**
27. **Unknown external outcome is not confirmed failure.** Reconcile before repeating a potentially duplicative consequential effect.
28. **Execution success, external-effect success and commercial progression are distinct.**
29. **Execution creates evidence; evidence changes the plan.**
#### Research, resources and capability bounds

30. **Gu should seek decision-sufficient evidence, not exhaustive knowledge.**
31. **Repeated work without material information gain must change strategy, wait, seek input or remain explicitly unresolved rather than loop indefinitely.**
32. **Prospect attention is a resource too.**
33. **Gu may research both the commercial problem and relevant prospect context when legitimately/proportionately related to the Opportunity.**
34. **Research enriches reasoning; it does not silently redefine source authority.**
35. **Artifact creation and artifact delivery are separate decisions.**
36. **Capability gaps are evidence, not invitations to fabricate unsupported workarounds.**
37. **Delegate the objective, not every task.** An admitted durable objective can justify self-initiated bounded work.
38. **Gu may discover work; it may not silently invent a materially new commercial objective.**
39. **Explicit human instruction is not a bypass around tenant, authority, policy or evidence constraints.**
#### Corrections, scope and stopping

40. **Corrections change the plan, not just chat memory.**
41. **Feedback stays at the narrowest durable scope it legitimately describes; broader scope must not be inferred from one local observation, and Organization Policy requires its governed publication path.**
42. **Correcting internal truth does not erase a material external effect already produced.**
43. **Reconsideration complete is not Opportunity complete.**
44. **Durable responsibility can persist while active computation sleeps.**
45. **Quiescent is valid; forgotten is not.**
46. **Future reconsideration must be reconstructible from durable truth, not hidden model memory.**

### 8.2 Situational next-work decision sequence

The product-level loop is:

```text
wake reason / new evidence
        ↓
resolve Organization + Case + runtime/conversation authority
        ↓
compile authorized current Opportunity context
        ├─ objective / requirements
        ├─ recent interaction
        ├─ prior property reactions
        ├─ progression / accepted facts
        ├─ commitments / evidence gaps
        ├─ open / blocked / recent Work
        ├─ human activity / assignment
        ├─ fresh operational sources
        ├─ prospect preferences / delivery eligibility
        ├─ available capabilities / resource bounds
        └─ applicable published policy
        ↓
diagnose:
"What currently constrains progress or creates a meaningful opportunity to advance?"
        ↓
generate candidate work / bounded adaptive strategy
        ↓
judge expected value + urgency + information value +
relationship impact + consequence/reversibility +
uncertainty + human burden + resource cost
        ↓
choose one posture:
NO-OP / WAIT
GATHER / RESEARCH / RECONCILE
CREATE / CONTINUE WORK ITEM(S)
ACT
ACT + INFORM
TARGETED HUMAN INPUT
PREPARE + APPROVAL
HUMAN-AS-EXECUTOR
HUMAN TAKEOVER / SUPPORT
        ↓
pre-effect governed checks where applicable
        ↓
execute / learn / wait / involve human
        ↓
observe actual result/evidence
        ↓
continue / replan / stop / reconcile / lifecycle-reassess
        ↓
leave coherent durable state + meaningful re-entry path
```

This sequence is a behavioral contract, not approval of a fixed workflow graph.

### 8.3 Opportunity advancement strategy & work discovery

Gu should not reduce next-work selection to choosing among predefined prospect messages or CRM tasks.

Given the current durable objective and Opportunity reality, Gu may identify:

- an information gap;
- a decision barrier;
- a missing/contradictory fact;
- a relationship need;
- a broken/at-risk commitment;
- a materially new property/inventory possibility;
- a coordination need;
- a risk that should be prevented;
- a question whose resolution could materially improve the next decision;
- a commercially useful new piece of information/artifact that does not yet exist.

The Case Supervisor may then determine bounded work such as:

- reason/analyze current context;
- retrieve current operational information;
- inspect relevant prior messages/reactions;
- research an authorized source;
- invoke an authorized Tool/Skill/domain capability;
- perform calculations or scenario analysis;
- create a comparison, visualization, brief, document or other artifact;
- reconcile expected evidence;
- obtain targeted advisor/human knowledge;
- prepare a prospect-facing action;
- execute an allowed effect;
- wait or deliberately do nothing.

> **The Case Supervisor chooses work, not merely messages.**

### 8.4 Choosing among candidate work

When several pieces of work are possible, Gu should use contextual judgment rather than one universal numerical scoring formula.

The judgment should consider, as applicable:

| Dimension | Question |
|---|---|
| **Progress value** | How materially could this work advance/protect/clarify the objective? |
| **Progress constraint / advancement opportunity** | What is currently limiting progress or newly enabling it? |
| **Urgency / timing** | Will the value materially decay if we wait? |
| **Information value** | Could this work reduce uncertainty enough to change the next decision? |
| **Relationship value / risk** | Could this strengthen or unnecessarily damage trust/attention? |
| **Consequence / reversibility** | What happens if Gu is wrong? |
| **Uncertainty** | Is uncertainty material to this action/decision? |
| **Human burden** | Can Gu resolve this without interrupting a human? |
| **Prospect attention cost** | Is another interaction worth the interruption? |
| **Resource/cost burden** | Is the expected information/progress value proportionate to material cost? |
| **Business significance** | Does the Opportunity justify additional reasonable effort within policy? |

These factors guide model/Skill judgment; they do not become one fixed score.

Gu should be able to explain the selected strategy in current-context terms, for example:

> "I am verifying financing before recontacting because monthly payment was the prospect's unresolved concern; sending more properties first would not address the current constraint."

Engagement/reply probability is instrumental, not the product objective.

> **Optimize for useful commercial progression and relationship quality, not activity or response alone.**

### 8.5 Learning before acting and adaptive multi-step work

The best next work may be work that improves the **next decision** rather than directly advancing the prospect interaction.

Examples:

```text
verify availability
→ discover property unavailable
→ stop old plan
→ search alternatives
→ compare strongest replacements
→ then decide whether contact is useful
```

or:

```text
research financing
→ discover missing rate assumption
→ use authorized financing capability
→ recalculate scenarios
→ create comparison
→ decide whether to share / ask advisor / no-op
```

Next-work selection may therefore produce a bounded multi-step strategy whose later steps depend on information discovered during execution.

Gu may:

- add a bounded step when new evidence makes it useful;
- skip/stop a planned step made obsolete by new facts;
- branch between alternatives;
- wait for an external result;
- replan after a Tool/human response;
- abandon a strategy whose information/value assumptions proved wrong.

> **The plan may evolve as Gu learns.**

Adaptive work discovery remains bounded by the durable objective, allowed capabilities, policy/authority, resource constraints, freshness/provenance and verification.

### 8.6 Research, Tools, external sources and prospect/context research

Gu may autonomously discover that useful work requires:

- fresh operational retrieval;
- authorized external research;
- a domain Tool/Skill/capability;
- quantitative analysis/calculation;
- contextual artifact creation;
- relevant public/authorized research about the prospect;
- research about the company, market, property, neighborhood, industry, financing, regulation or other Opportunity context;
- targeted human knowledge.

#### 8.6.1 Work discovery does not grant capability

> **Gu may discover the need for a capability; it does not grant itself the capability.**

Execution remains confined to authorized capabilities and data/tenant scope.

If a useful capability is unavailable, Gu should make the gap observable and choose the smallest legitimate alternative:

- another sufficient authorized source/capability;
- qualified uncertainty;
- targeted human input;
- an allowed exception request;
- wait/no-op.

It must not fabricate the missing capability or silently compensate with unsupported inference.

#### 8.6.2 Source/provenance discipline

Research may enrich Opportunity understanding but must not silently override operational source authority.

Conceptually:

```text
authoritative operational source
→ governs facts it owns

authorized external/public source
→ contextual evidence / enrichment

model-derived analysis
→ interpretation / synthesis

generated artifact
→ presentation / derived output
```

Material claims should use source quality/verification proportional to consequence.

Observed information, derived analysis and inference must remain distinguishable.

#### 8.6.3 Relevant prospect research

Gu may research relevant public or otherwise authorized context about the prospect when it has a legitimate, proportionate relationship to advancing, protecting, clarifying or personalizing the Opportunity.

Examples may include:

- public professional role/profile information;
- employer/company information;
- company websites;
- public company announcements;
- reputable institutional/business publications;
- government/public registries where appropriate;
- authorized commercial/professional data sources.

Such research may help Gu understand context, generate better questions, identify relevant information or choose useful work. It must not silently create unsupported consequential judgments such as affordability, trustworthiness, eligibility or willingness to transact.

Public availability alone does not make every piece of personal information relevant or appropriate. Unnecessary collection/use of sensitive personal information is outside normal Relationship Operations unless another explicit legitimate product/process contract authorizes it.

> **Research freedom can be broad; consequential decision authority based on that research remains proportionate and governed.**

### 8.7 Artifact creation and delivery are separate decisions

Creating a useful contextual artifact is valid next work.

Examples:

- property comparison;
- price/m² chart;
- financing/payment scenario;
- shortlist;
- pros/cons matrix;
- neighborhood/market brief;
- investment view;
- map/context view;
- decision timeline;
- document/infographic.

Artifact creation may be followed by:

```text
create
  ↓
inspect / verify
  ↓
share now
OR advisor review/input
OR wait
OR do not deliver
```

> **Artifact creation and artifact delivery are separate decisions.**

Generating an artifact does not itself authorize disclosure or prospect contact, and S2 does not require Gu to create an artifact when expected value is already too low.

### 8.8 Proactive initiative vs explicit instruction

Once Gu has accepted durable responsibility for a Lead Opportunity, it may initiate bounded work reasonably implied by the objective and current evidence without a new human instruction for each task.

Examples:

- property becomes unavailable → search/compare replacements;
- missing total-cost information matters → calculate it;
- appointment outcome is unknown → reconcile;
- stale material fact could create bad outreach → verify first;
- prior constraint suggests an unrequested but useful analysis → prepare it.

> **Delegate the objective, not every task.**

Gu may identify latent work no actor explicitly named and may create Work Items when that work must persist.

However:

- Gu may not silently redefine/expand the durable objective into a materially new commercial objective;
- potentially valuable new objectives should be confirmed and handled under S1 continuity/new-Opportunity rules;
- self-initiated external effects remain governed by the same authority/delivery/freshness rules as explicitly requested effects;
- explicit human instruction also remains subject to platform/tenant/authority/evidence constraints.

> **Initiative can be broad; effect authority remains governed.**

### 8.9 Human involvement modes and authority

Two questions remain separate:

```text
1. Is this work/effect within Gu's authority?
   → governed question

2. Would human involvement materially improve or be required here?
   → contextual judgment + governed requirements
```

| Situation | Human mode | Product rule |
|---|---|---|
| Routine allowed work where human adds little value | **Autonomous** | Gu acts without approval. |
| Gu is authorized; human benefits materially from awareness | **Act + inform** | Inform because awareness helps, not because permission was needed. |
| Gu needs one human fact/judgment | **Targeted human input** | Ask for the smallest contribution necessary. |
| Protected economic/contractual/negotiation/authority-bearing commitment not already explicitly delegated within policy | **Prepare + approval** | Gu may research/analyze/draft; approval gates the commitment/effect. |
| Physical/off-platform/human-only work | **Human-as-executor** | Gu coordinates/remembers; human executes. |
| Relationship itself materially benefits from human conversational lead | **Human takeover** | Human leads; Gu supports without competing. |

> **Ask for the smallest human contribution necessary to unblock the work.**

> **Approval should gate the commitment, not the preparatory intelligence.**

### 8.10 Relationship risk and takeover

Relationship risk is a contextual assessment of potential harm to trust, continuity or commercial outcome; it is not synonymous with negative sentiment.

Examples:

- "I didn't like those properties." → negative reaction, normally not takeover.
- "You have promised this three times and nobody delivers; I want to speak to a person." → materially different trust/relationship risk.

Gu should first determine whether the situation is safely recoverable within its capabilities/authority.

Human involvement should increase when, for example:

- the prospect explicitly requests a person;
- trust has materially deteriorated;
- serious conflict/dispute exists;
- consequential uncertainty cannot be safely resolved;
- human relationship/negotiation judgment adds material value;
- sensitive personal circumstances make human leadership appropriate;
- organization policy requires it.

Even then, select the smallest human mode that resolves the need.

> **Negative sentiment is a signal, not a handoff rule.**

> **Human takeover is reserved for situations where the relationship itself materially benefits from a human conversational lead—not merely because the problem is difficult.**

During takeover, Gu may continue allowed supporting work such as:

- authorized research/retrieval;
- preparation/drafting;
- comparison/analysis;
- commitment tracking;
- evidence reconciliation;
- non-conflicting internal Work.

### 8.11 Human takeover and return to Gu

When evidence establishes that a human is actively leading the governed conversation:

```text
conversation authority = HUMAN_ACTIVE
```

Gu must not send competing prospect-facing messages in that conversation.

The Lead Opportunity remains durable unless S1 lifecycle evidence says otherwise. Runtime decision authority does not automatically revert to Traditional Gu merely because a human speaks.

Gu may continue allowed observation/support.

Return to Gu speaking must follow a governed signal/policy such as:

- explicit advisor resume;
- explicit handback/end signal;
- policy-defined inactivity condition;
- new interaction whose current authority resolution returns conversation lead to Gu;
- another approved source signal.

Before speaking again Gu must recompile current context, including observable human activity, commitments, restrictions and changed facts.

Traditional Gu's source-verified inactivity-based resume timing is a migration input, not a universal S2 invariant.

### 8.12 Delivery / re-engagement policy and channels

Prospect-facing re-engagement is situational and value-driven rather than timer-driven.

Elapsed time/inactivity may justify **reconsideration** but does not by itself justify contact.

Before proactive contact, Gu should separately determine:

```text
IS CONTACT ALLOWED?
→ governed eligibility

IS CONTACT USEFUL?
→ situational judgment
```

Useful re-engagement may include:

- fulfilling a commitment;
- resolving a pending question;
- presenting materially relevant new information;
- meaningful inventory/price/availability change;
- useful research/analysis/artifact;
- concrete visit/coordination progress;
- prospect-requested timing.

Repeated similar outreach with no response should reduce the expected value of another low-value contact without automatically closing the Opportunity.

#### Hard bounds vs soft guidance

Hard/non-overridable restrictions may include:

- explicit opt-out/do-not-contact;
- explicit "not before X";
- channel/regulatory restriction;
- active human conversation authority;
- runtime authority not belonging to Gu OS;
- unresolved tenant/identity;
- non-overridable organization/platform policy.

Soft policy/guidance may include:

- cooldowns;
- frequency expectations;
- preferred delivery windows;
- contextual re-engagement guidance.

A cooldown becoming eligible means contact **may** be allowed, not that contact **should** occur. Policy may define bounded exceptions to soft limits for materially time-sensitive or prospect-requested developments; model judgment cannot override hard restrictions.

#### Channel-general behavior

Relationship Operations is **channel-aware but not channel-defined**.

WhatsApp is the current primary prospect-facing channel in the Traditional Gu path. Web Chat and Telegram are currently Gu OS user/advisor interaction surfaces. Future real-time voice or other channels may become internal, prospect-facing or both only under their explicit channel contract.

The product decision sequence is:

```text
what work is useful?
        ↓
does it require interaction?
        ↓
who should interact?
        ↓
which available authorized surface/channel is appropriate?
```

Channel selection should consider:

- actor/prospect vs internal user;
- conversation binding/identity;
- conversation authority;
- channel capability;
- preferences;
- context continuity;
- delivery restrictions;
- evidence/traceability;
- consequence of changing channel.

A more natural/capable channel does not grant additional business authority, and the existence of an authorized internal surface does not imply permission to contact the prospect through that surface.

> **Same Opportunity, multiple authorized surfaces.**

### 8.13 Commitments, scheduled reconsideration and evidence gaps

S2 distinguishes three future-oriented concepts:

```text
specific expected outcome someone relies on
→ COMMITMENT

nothing specifically committed; think again later
→ SCHEDULED RECONSIDERATION

expected outcome should be knowable, but evidence missing
→ EVIDENCE GAP + RECONCILIATION
```

#### Commitment

A commitment is durable when:

1. there is a sufficiently specific expected outcome;
2. some actor is reasonably expected to act/respond/provide something;
3. forgetting/missing it could materially affect relationship/responsibility/outcome.

Commitments may originate from:

- Gu;
- advisor/human;
- prospect;
- relevant external actor/system.

They should preserve enough semantics to know:

- expected outcome;
- expected actor;
- timing/deadline;
- satisfaction evidence;
- what happens if unresolved.

#### Scheduled reconsideration

A scheduled reconsideration stores **when to think again**, not a predetermined action.

At the wake time Gu recompiles current reality.

#### Evidence gap

When an expected commercially material outcome remains unresolved:

1. re-read strongest available authorized source(s);
2. reconcile source/provider evidence;
3. use low-burden paths first;
4. ask the smallest appropriate human/prospect contribution if still needed;
5. preserve unknown if still unresolved.

> **An evidence gap means we do not yet know—not that the outcome failed.**

### 8.14 Commitment vs Work Item vs Durable Task / Work Run

The abstractions remain distinct:

```text
LEAD OPPORTUNITY CASE
"What durable business responsibility exists?"

WORK ITEM
"What executable work inside this Opportunity must be durable?"

DURABLE TASK / WORK RUN
"What durable work exists independently of a business Case?"

SCHEDULED RECONSIDERATION
"When should the Case think again?"

COMMITMENT
"What outcome/obligation is someone reasonably relying on?"
```

For Relationship Operations:

> **The default durable root is the Lead Opportunity Case; durable execution beneath it uses Work Items.**

A commitment may create:

- a Work Item;
- multiple Work Items;
- a scheduled reconsideration;
- or some combination.

Example:

```text
Commitment:
"send the comparison Friday"

Lead Opportunity Case
    ↓
Work Item: build comparison
    ↓
Work Item: deliver comparison (deferred)
    ↓
Evidence: artifact + external delivery outcome
```

By contrast:

```text
"reconsider Friday whether re-engagement makes sense"
```

may wake the Case and legitimately produce `NO-OP` with no Work Item.

Durable Tasks / Work Runs remain for independent non-Case work, such as a separate recurring inventory analysis that may later wake relevant Opportunities.

A child Case should be created only when a subproblem acquires its own durable business responsibility/lifecycle, not merely because it is complex.

### 8.15 Commitment satisfaction, change and supersession

A commitment is satisfied by sufficient evidence that the expected outcome occurred, not because:

- its deadline passed;
- a Work Item ran;
- an API request was attempted.

If the promised outcome is delivery, artifact creation alone may not satisfy it.

If external outcome is unknown, Gu reconciles before claiming fulfillment or blindly repeating.

Commitments may be:

- changed;
- cancelled;
- superseded;
- fulfilled;
- remain unresolved.

History/provenance should remain reconstructible; exact persistence representation belongs to Technical Design.

### 8.16 Work persistence boundary

Not every thought/tool call becomes a Work Item.

Inline bounded execution is appropriate for ephemeral:

- authorized reads;
- context assembly;
- reasoning;
- deterministic lookups;
- small synchronous analysis or non-material actions that do not require independent durability semantics.

Create/use a Work Item when work materially needs one or more of:

- survival beyond current run/turn;
- waiting;
- retry/recovery;
- dependencies / fan-out / fan-in;
- human participation;
- material external effect;
- idempotency/postcondition verification;
- independent evidence/auditability.

This keeps the Work Plane operationally meaningful.

### 8.17 Autonomy bounds, resource proportionality and diminishing returns

Gu may continue autonomous work while additional work has meaningful expected value and remains within authority, policy, privacy and resource bounds.

S2 does not prescribe a universal product limit such as a fixed maximum number of Tool calls/reasoning steps. Technical safety limits may exist independently.

Gu should stop, wait, change strategy or seek the smallest appropriate human contribution when:

- marginal information/progress value becomes low;
- additional information is unlikely to change the decision;
- available sources cannot materially reduce uncertainty;
- a capability or authority boundary is reached;
- cost becomes disproportionate;
- repeated work provides no material information gain;
- only an external event can unlock progress;
- continued contact/work risks relationship quality.

Resource burden includes:

- monetary/provider/model cost;
- compute/execution effort;
- human attention;
- prospect attention.

Business significance may influence reasonable resource usage but cannot override authority/privacy/tenant/safety/relationship bounds.

> **Seek decision-sufficient evidence, not exhaustive knowledge.**

> **Spend resources where they can change the decision.**

> **No material information gain → change strategy, don't loop.**

### 8.18 Execution, outcome verification and replanning

Execution is not the end of next-work reasoning.

After work is attempted, Gu should determine:

- what actually happened;
- what evidence/postcondition exists;
- what was learned;
- whether the Opportunity materially changed;
- what should happen next.

Keep distinct:

| Result type | Meaning |
|---|---|
| **Technical execution failure** | Tool/provider/runtime failed to execute correctly. |
| **Confirmed external-effect failure** | Evidence confirms the intended external effect did not occur. |
| **Unknown external outcome** | Effect may or may not have occurred; reconciliation required before dangerous repeat. |
| **Successful negative discovery** | Work succeeded and learned commercially negative information (e.g. property unavailable). |
| **Business non-progression** | Work/effect occurred but did not advance the Opportunity. |
| **Commercial progression** | Evidence shows meaningful Opportunity advancement. |

> **Work completed does not mean Opportunity progressed.**

Work should be selected for an intended contribution such as:

- reduce uncertainty;
- resolve constraint;
- create useful information;
- coordinate outcome;
- protect relationship;
- advance progression.

The result becomes new Opportunity context and may justify:

- continuing;
- branching;
- adding work;
- stopping obsolete work;
- waiting;
- reconciliation;
- targeted human contribution;
- S1 lifecycle reconsideration.

Verification strength should scale with consequence/reversibility.

### 8.19 Waiting as a strategy

Waiting is correct when additional work has low expected value until new evidence arrives.

Examples:

- waiting for prospect response;
- waiting for advisor input;
- waiting for approval;
- waiting for provider/source outcome;
- waiting for date/event requested by prospect.

Waiting must not become forgotten responsibility.

If durable responsibility remains, there should be a meaningful re-entry path through:

- an event;
- a commitment/evidence boundary;
- a scheduled reconsideration;
- completion/failure of pending Work;
- human action.

### 8.20 Human corrections, rejected recommendations and within-Case adaptation

Relationship Operations adapts within the current Opportunity when authorized human corrections, human decisions or observed outcomes materially change understanding.

Human input may represent different semantics:

```text
factual correction
contextual judgment
action instruction
approval
preference
possible policy feedback
```

These must not be collapsed.

An authorized correction should:

- update relevant working truth according to actor/source authority;
- preserve provenance of prior interpretation;
- invalidate affected assumptions;
- cause dependent planned/open Work to be reconsidered.

Human correction is evidence appropriate to the claim, not a magical overwrite of stronger authoritative source truth. Conflicts that cannot be reconciled remain explicit and may require targeted clarification.

Rejected recommendations should capture/use the underlying reason when available and materially useful, e.g.:

- already handled;
- wrong fact/assumption;
- wrong timing;
- wrong relationship strategy;
- authority issue;
- prospect preference;
- advisor preference;
- low expected value.

Do not infer strong enduring preferences from weak evidence such as one non-response.

Corrections, preferences and feedback should be scoped to the **narrowest durable subject they legitimately describe**:

- **Case-specific** — applies only to the current Opportunity;
- **Prospect/Contact-specific** — a durable relationship/contact preference or fact that legitimately applies across that prospect's relevant Opportunities;
- **User/Advisor-specific** — a durable working preference of the internal user when appropriate;
- **Organization Policy** — only through the governed authoring/review/publication path defined by ADR-108.

Broader scope must not be inferred merely from one local observation. A Prospect/Contact preference is not automatically Organization Policy, and a Case-specific correction is not automatically a durable user preference.

S2 does not define global/cross-Case autonomous Business Brain learning.

If corrected truth invalidates pending Work, Gu should change/cancel/replace that work. If incorrect information already produced a material external effect, correction may require explicit remediation; internal truth correction does not erase what happened externally.

### 8.21 Case Supervisor responsibility and stopping conditions

The Case Supervisor is responsible for **situational reconsideration**, not continuously running computation or personally executing every piece of work.

A reconsideration may complete when Gu has reached a sufficiently grounded decision about what should happen now and durable responsibility is left coherently in one of these postures:

- useful Work is underway;
- waiting for prospect;
- waiting for human input;
- waiting for approval;
- human currently leads the conversation;
- waiting for an external source/event;
- reconciliation is established;
- waiting until a meaningful time;
- no useful work exists now;
- current evidence requires S1 lifecycle/viability reconsideration;
- responsibility should coordinate with another Case/domain.

> **Reconsideration complete ≠ Opportunity complete.**

An open Opportunity may remain intentionally quiescent without active Work when no action has meaningful expected value, provided it remains wakeable.

The Supervisor coordinates/chooses work but does not absorb every execution responsibility:

```text
Case Supervisor
→ situational reconsideration / coordination

Work Item / Attempt
→ durable execution

Tool / capability
→ bounded effect

Human
→ required contribution / approval / conversation lead

Other Operational Case/domain
→ separate durable business responsibility
```

S2 may surface evidence that Opportunity viability/lifecycle needs reassessment; S1 remains authoritative for closure/reactivation/identity/continuity.

A reconsideration should not yield while material durable responsibility is stranded, for example:

- immediate obligation discovered but not persisted;
- material evidence gap ignored;
- consequential unknown effect without reconciliation strategy;
- human input required but not actually requested;
- waiting chosen with no reasonable wake path;
- stale/invalidated future Work left active;
- material authority ambiguity ignored.

> **Yielding is safe only after durable responsibility has somewhere coherent to go next.**

### 8.22 Reconstructibility and quiescence

Before a reconsideration becomes quiescent, durable truth should be sufficient to reconstruct:

- the Opportunity objective;
- current accepted material facts;
- relevant uncertainty/provenance;
- pending/blocked work;
- commitments/evidence gaps;
- who/what is being waited on;
- authority mode;
- meaningful next wake condition.

This does not require a giant summary field. It requires that durable shared primitives preserve enough truth.

> **Durable responsibility persists while active computation does not need to.**

> **The next reconsideration must be reconstructible from durable evidence, not hidden model memory.**

## 9. Happy paths

### HP-01 — Contextual value-bearing re-engagement

**Given**
- an admitted viable Opportunity;
- no explicit contact restriction;
- runtime/conversation authority permit Gu;
- prior outreach did not receive a response;
- the last known concern was affordability.

**When**
- a scheduled reconsideration occurs and Gu discovers a materially useful financing/price comparison can address that concern.

**Then**
- Gu may research/calculate/create the comparison using authorized capabilities;
- it separately decides whether contact is useful/allowed;
- if useful, it sends a contextual value-bearing message;
- if no new useful value exists, it may no-op/wait rather than send merely because the timer fired.

### HP-02 — Learn before acting

**Given**
- Gu is considering presenting a property;
- current availability is uncertain.

**When**
- the Case Supervisor reconsiders.

**Then**
- Gu verifies current operational availability first;
- if unavailable, it stops the stale plan;
- it may search/compare alternatives and then decide whether outreach is useful;
- no stale property claim is sent.

### HP-03 — Adaptive multi-step strategy

**Given**
- an investor Opportunity where monthly affordability is the main unresolved question.

**When**
- Gu begins a financing comparison.

**Then**
- it may retrieve property facts, discover a missing rate assumption, use an authorized financing capability, recalculate and create a comparison;
- later work adapts to what is learned rather than executing a pre-fixed sequence.

### HP-04 — Relevant prospect/context research

**Given**
- a prospect is searching for office/industrial space for a company;
- public/authorized professional/company context could materially improve the next decision.

**When**
- Gu performs authorized research.

**Then**
- it preserves provenance;
- distinguishes observed professional/company information from inference;
- uses it to improve questions/work selection;
- does not silently infer affordability/trustworthiness or a new commercial objective.

### HP-05 — Artifact creation without automatic delivery

**Given**
- Gu determines a property-cost visualization may help.

**When**
- it creates the artifact.

**Then**
- creation is verified separately from delivery;
- Gu may share, wait, request advisor review or discard/not deliver based on context/policy/authority.

### HP-06 — Prospect says "contact me next month"

**Given**
- a viable Opportunity;
- the prospect explicitly requests no contact until a future date.

**When**
- inventory changes materially before that date.

**Then**
- the Opportunity may wake/update internal context;
- Gu does not contact before eligibility resumes;
- it may research/prepare/wait;
- the Opportunity remains viable/open.

### HP-07 — Advisor takes over same conversation

**Given**
- Gu OS has runtime authority;
- the advisor begins communicating in the same governed prospect conversation.

**When**
- human intervention is observed.

**Then**
- conversation authority becomes human-active;
- Gu suppresses competing prospect messages;
- Gu may continue allowed research/preparation/evidence work;
- the Opportunity remains durable;
- governed resume recompiles current context before Gu speaks.

### HP-08 — Targeted human input without takeover

**Given**
- Gu needs to know whether the advisor can attend a requested visit window;
- no authoritative source contains the answer.

**When**
- Gu identifies that single missing fact.

**Then**
- Gu asks the advisor the smallest targeted question;
- the Case remains Gu-owned;
- conversation authority need not transfer;
- work resumes when the answer arrives.

### HP-09 — Protected economic commitment

**Given**
- the prospect requests a non-delegated price/commission concession.

**When**
- Gu evaluates the request.

**Then**
- Gu may research comparables, analyze alternatives, prepare a recommendation and draft;
- it does not commit externally;
- an authorized human approves/edits/rejects the protected commitment.

### HP-10 — Commitment becomes durable work

**Given**
- Gu promises to prepare and send a comparison Friday.

**When**
- the commitment is created.

**Then**
- the business expectation remains durable;
- Work Items may be created for building and delivering the comparison;
- delivery fulfillment requires sufficient evidence, not merely artifact creation.

### HP-11 — Evidence gap becomes reconciliation

**Given**
- a visit was scheduled;
- the relevant post-visit boundary passes;
- no admissible attended/cancelled/no-show evidence exists.

**When**
- the Case wakes.

**Then**
- Gu re-reads available sources;
- performs low-burden reconciliation;
- may ask advisor/prospect if appropriate;
- preserves unknown until evidence exists.

### HP-12 — Waiting is intentional

**Given**
- Gu asked one material clarification question;
- the message is confirmed delivered;
- additional outreach currently has low expected value.

**When**
- the reconsideration finishes.

**Then**
- waiting for prospect response is a valid posture;
- the Case remains wakeable by response/event/appropriate reconsideration;
- no fake Work/message is created.

### HP-13 — Human correction changes future work

**Given**
- Gu believed budget was the blocker and planned lower-priced options;
- the advisor corrects that architecture/style is the actual issue.

**When**
- the correction is accepted as appropriate evidence.

**Then**
- future understanding and candidate work change;
- dependent stale Work is reconsidered/cancelled;
- prior interpretation remains provenance-visible.

### HP-14 — Reconsideration ends quiescent

**Given**
- prospect said they will return after a trip;
- no brokerage commitment is pending;
- no time-sensitive advancement opportunity exists.

**When**
- the Case Supervisor reconsiders.

**Then**
- it may conclude no useful work exists now;
- the Opportunity stays open/quiescent;
- an appropriate date/event can wake it;
- no continuous process remains running.

## 10. Unhappy, ambiguous, and edge cases

| ID | Situation | Required behavior | Forbidden shortcut |
|---|---|---|---|
| EC-01 | Fixed timer fires but context no longer supports contact | Reconsider and no-op/wait if appropriate. | Send the prewritten follow-up anyway. |
| EC-02 | New property match arrives during explicit do-not-contact window | Update/research internally; respect restriction. | Send because the match is "important." |
| EC-03 | Human intervenes after planning but before Gu send | Pre-effect authority revalidation blocks/reconsiders effect where observable. | Rely only on authority state from planning time. |
| EC-04 | Runtime authority remains Legacy but Gu OS Case exists | Shadow/observe according to policy; no independent competing decision/send. | Treat Case existence as cutover. |
| EC-05 | Model is highly confident advisor would approve a concession | Prepare/request approval. | Treat confidence as authority. |
| EC-06 | Advisor is missing one factual detail | Ask targeted question. | Transfer entire conversation/Case by default. |
| EC-07 | Provider API times out after send request | Mark effect unknown and reconcile. | Blindly repeat message. |
| EC-08 | Provider initially accepts/returns ID but later failure arrives | Reconcile result and replan. | Treat initial acceptance as permanent delivery proof. |
| EC-09 | Legacy appointment sources disagree | Preserve uncertainty/provenance; reconcile. | Generic last-read/last-write truth. |
| EC-10 | No post-visit survey response | Keep outcome unknown; reconcile if material. | Infer `visit_not_attended`. |
| EC-11 | Prospect is silent 30 days | Evaluate viability/context/value/policy. | Automatically mark lost or send because N days elapsed. |
| EC-12 | Advisor acts off-platform and Gu cannot observe contents | Use known signals/conservative reconciliation when collision risk material. | Assert no human interaction occurred. |
| EC-13 | Human takeover resume condition occurs after human made new commitment | Recompile current context/evidence. | Continue stale pre-takeover plan. |
| EC-14 | Tenant/identity mapping ambiguous | Fail closed / resolve identity. | Search across organizations for a likely match. |
| EC-15 | Material Work technically fails | Retry/replan/reconcile according to contract. | Convert system failure into business `lost`. |
| EC-16 | New event arrives while approval pending | Re-evaluate proposal/evidence staleness. | Execute old proposal automatically. |
| EC-17 | Organization policy changes before future decision | Use applicable published policy and preserve attribution. | Execute under a draft/half-authored policy. |
| EC-18 | Prospect asks to talk to a person | Handoff/takeover and suppress competing Gu conversation. | Continue autonomous persuasion. |
| EC-19 | Sentiment classifier reports negative but Gu can safely correct a routine issue | Use contextual judgment; resolve if appropriate. | Automatic takeover on negative sentiment. |
| EC-20 | No useful next work exists | Deliberate no-op + meaningful wake path. | Manufacture activity to keep Case "active." |
| EC-21 | Research source says property available while authoritative operational source says unavailable | Honor fact-level source authority; treat external source as contextual/possibly stale. | Let web/article override operational authority. |
| EC-22 | Public profile suggests high-paying job | Use only legitimate context/inquiry; preserve inference discipline. | Infer affordability/eligibility as fact. |
| EC-23 | Gu has an authorized web/research capability and "wants more context" without a relevant question | Stop/diagnose relevance first. | Browse indefinitely because capability exists. |
| EC-24 | Generated artifact turns out low quality/unhelpful | Do not automatically deliver; replan/discard. | Send because creation succeeded. |
| EC-25 | Useful work requires unavailable capability | Expose gap + choose authorized alternative/input/wait. | Hallucinate/circumvent missing capability. |
| EC-26 | Same search repeated with no new information | Change strategy/wait/input/unresolved. | Infinite agentic research loop. |
| EC-27 | Cheap source provides decision-sufficient evidence; expensive provider adds little | Stop/choose sufficient evidence. | Spend because budget exists. |
| EC-28 | Expensive provider materially resolves a high-value decision within policy | May use it. | Always choose cheapest regardless of value. |
| EC-29 | Prospect attention has been consumed by several low-value contacts | Lower attractiveness of another contact. | Treat each cooldown expiry as fresh permission-to-message instruction. |
| EC-30 | Gu discovers potentially useful but materially different objective | Ask/confirm and apply S1. | Silently open/expand commercial objective. |
| EC-31 | Human explicitly instructs an unauthorized/unsupported material claim | Resolve authority/evidence; refuse/block if invalid. | User instruction overrides hard guarantees. |
| EC-32 | Work discovers property unavailable mid-plan | Stop obsolete downstream steps and replan. | Finish original plan because steps were queued. |
| EC-33 | Research succeeds and discovers commercially negative fact | Treat as successful information gain and replan. | Mark Work technically failed. |
| EC-34 | Message delivered but prospect rejects the proposal | Separate delivery success from business non-progression. | Mark delivery failure or claim progression. |
| EC-35 | Advisor rejects recommendation because already handled by phone | Capture/use underlying reason where appropriate. | Store only `rejected` and propose again. |
| EC-36 | One artifact gets no response | Preserve observation; avoid over-inference. | Create durable "prospect dislikes infographics" fact. |
| EC-37 | Human correction conflicts with stronger operational source | Reconcile based on authority/provenance/recency. | Human-latest-wins universally. |
| EC-38 | Gu sent material misinformation before discovering correction | Correct internal truth and consider explicit remediation. | Rewrite history as though effect never happened. |
| EC-39 | Supervisor chooses wait with no event/time/commitment path | Establish meaningful re-entry or resolve lifecycle. | Leave open Case dependent on human memory. |
| EC-40 | Case remains open but Supervisor finds nothing useful | Quiesce intentionally. | Keep continuous computation/busy work. |

## 11. Acceptance scenarios

| ID | Given | When | Then | Required evidence / verifier |
|---|---|---|---|---|
| AC-01 | Viable Opportunity, timer wake, no current useful work | Reconsideration runs | No prospect message; valid no-op/quiescence + wake path | Scenario + effect log absence |
| AC-02 | Timer wake + unresolved concern + genuinely useful new value | Reconsideration runs | Contextual work/re-engagement may occur if allowed | Eval + integration |
| AC-03 | Explicit "contact me after X" | Earlier event/match wakes | No outbound before X; internal work permitted | Deterministic policy scenario |
| AC-04 | Same event delivered twice | Wake handling runs twice | No duplicate logical external effect | Idempotency integration |
| AC-05 | Runtime authority = LEGACY, Case exists | Prospect message arrives | Gu OS does not independently decide/send | Cross-repo routing test |
| AC-06 | Runtime authority = GU_OS, conversation authority = GU | Prospect message arrives | Gu OS owns decision; legacy agent suppressed | Cross-repo integration |
| AC-07 | Advisor intervenes same conversation | Human signal observed | Gu speaking suppresses; supporting work may continue | Replay/integration |
| AC-08 | Governed human-active period ends | Resume signal occurs | Gu recompiles latest context before response | Replay with changed human content |
| AC-09 | Human intervention occurs after plan before send | Pre-effect check runs | Stale Gu send blocked/reconsidered | Race/concurrency test |
| AC-10 | Routine requirement clarification | Gu authorized | Autonomous communication allowed | Eval + policy test |
| AC-11 | Non-delegated economic commitment | Gu handles request | Prepare/approval; no external commitment pre-approval | Approval integration |
| AC-12 | Missing advisor-only fact | Gu needs it | Targeted input; no unnecessary takeover | Scenario/eval |
| AC-13 | Material trust/conflict risk | Gu evaluates | Appropriate smallest human mode/takeover | Eval rubric + human review |
| AC-14 | Negative sentiment without material relationship risk | Gu evaluates | No automatic handoff; Gu may recover autonomously | Eval set |
| AC-15 | New authorized inventory match | Match wakes Case | Reconsideration; send conditional, not automatic | Scenario/eval |
| AC-16 | Scheduled visit lacks outcome evidence | Evidence boundary passes | Reconciliation; unknown preserved | Source/replay |
| AC-17 | No survey response | Reconciliation runs | No automatic no-show fact | Deterministic evidence test |
| AC-18 | Outbound effect times out | Attempt uncertain | Unknown + reconcile before repeat | Fault injection |
| AC-19 | Initial provider success later reports failure | Callback arrives | Effect reconciled + replan | Provider integration |
| AC-20 | BigQuery stale but fresh conversation changed | Reconsideration runs | Fresh operational source governs live decision | Freshness integration |
| AC-21 | Long silence | Reconsideration runs | Silence alone neither forces loss nor contact | Scenario |
| AC-22 | Commitment reaches due time | Case wakes | Commitment/reconsideration/Work distinction preserved | Scenario + durable evidence |
| AC-23 | Deferred Work becomes invalid before effect | Pre-effect check runs | Effect blocked/reconsidered | Integration |
| AC-24 | Organization policy version changes | Future decision occurs | Applicable published policy governs + attribution retained | Policy-version test |
| AC-25 | Tenant/identity ambiguity | Work might cross org | Fail closed; no unauthorized context/effect | Security negative |
| AC-26 | No useful next work | Case Supervisor runs | Valid no-op; no fake Work Item | Scenario + Work inspection |
| AC-27 | Ephemeral bounded read/reason work | Reconsideration runs | No Work Item required solely for bookkeeping | Review/integration |
| AC-28 | Work must wait/retry/involve human/material effect | Reconsideration runs | Work Item durability used | Integration |
| AC-29 | Advisor takeover + unrelated internal reconciliation | Takeover occurs | Non-conflicting internal work may continue | Scenario |
| AC-30 | Human corrects material assumption | Correction accepted | Dependent future work replans; provenance retained | Audit/replay |
| AC-31 | Multiple candidate actions exist | Case Supervisor judges | Selection explainable via current context; no universal score required | Eval rubric |
| AC-32 | Information gathering can change decision | Gu considers immediate contact | Gu may research/verify first | Eval + Tool trace |
| AC-33 | Multi-step work discovers new material fact | Strategy executes | Later steps adapt/branch/stop | Agentic scenario eval |
| AC-34 | Research uses public professional/company source | Gu enriches context | Provenance + observed/inferred distinction retained | Scenario/audit |
| AC-35 | Prospect research suggests possible affordability | Gu reasons | No unsupported consequential affordability fact/action | Safety/eval |
| AC-36 | Artifact created | Creation succeeds | Delivery is separately authorized/decided | Artifact/effect integration |
| AC-37 | Needed capability unavailable | Gu reaches gap | Exposes gap; chooses legitimate alternative/input/wait | Capability-negative scenario |
| AC-38 | Repeated research yields no material information gain | Strategy continues | Gu stops/changes strategy instead of looping | Loop-control eval |
| AC-39 | Decision-sufficient evidence already obtained | Gu can do more research | Gu may stop without exhaustive research | Eval |
| AC-40 | Costlier provider materially changes decision within policy | Gu evaluates | May use provider despite cheaper incomplete option | Cost/value scenario |
| AC-41 | Several recent low-value contacts had no response | New cooldown expires | Contact not automatic; prospect attention considered | Re-engagement eval |
| AC-42 | Useful new value arises inside soft cooldown allowed exception | Event occurs | Governed exception may allow contact; hard bounds still enforced | Policy test |
| AC-43 | Web Chat/Telegram internal surface active | Gu needs advisor input | Same Opportunity can use appropriate authorized surface | Channel integration |
| AC-44 | A future channel contract (e.g. real-time voice) is introduced | Channel capability is designed/validated | It must preserve the same tenant/privacy/business-authority principles before prospect-facing use | Future channel-contract compatibility review |
| AC-45 | Gu detects latent useful work no one requested | Case reconsiders | May self-initiate bounded work within objective | Agentic eval |
| AC-46 | Gu discovers materially new commercial objective | Research reveals opportunity | Requests confirmation/applies S1; no silent scope expansion | S1/S2 scenario |
| AC-47 | Explicit human instruction violates hard authority/evidence | User requests action | Action blocked/clarified despite instruction | Permission negative |
| AC-48 | Work completes technically with negative discovery | Result observed | Technical success retained; commercial strategy replans | Scenario |
| AC-49 | External effect succeeds but no commercial progression | Outcome observed | No false progression claim | Evidence test |
| AC-50 | Human rejects recommendation with reason | Feedback received | Underlying reason informs future Case work | Replay/eval |
| AC-51 | One non-response follows artifact delivery | Gu updates context | Does not create unsupported enduring preference | Evidence-discipline test |
| AC-52 | Correction conflicts with source | Reconciliation runs | Authority/provenance semantics applied; no generic latest-wins | Integration |
| AC-53 | Material misinformation already sent | Correction discovered | Internal truth corrected + remediation considered/evidenced | Recovery scenario |
| AC-54 | No active Work but viable Opportunity | Reconsideration ends | Case may quiesce with meaningful wake route | Durable-state inspection |
| AC-55 | Reconsideration wants to yield with unresolved material unknown effect | Supervisor evaluates stopping | Does not strand responsibility; reconciliation established first | Scenario |
| AC-56 | New run after long quiescence | Event wakes Case | Current situation reconstructible from durable facts/Work/commitments/authority | Multi-session replay |

### Acceptance quality bar

S2 is not accepted merely because Gu can generate a contextual follow-up.

Verification must cover at least:

- deliberate no-op/quiescence;
- timer/event ≠ action;
- diagnose-before-act;
- information-gathering as valid next work;
- adaptive multi-step planning/replanning;
- research/source/provenance discipline;
- relevant prospect/context research;
- artifact creation vs delivery;
- capability gaps;
- diminishing returns / loop stopping;
- resource/prospect-attention proportionality;
- proactive self-initiated work;
- objective-scope boundary;
- policy/contact restrictions;
- runtime authority;
- human takeover/resume;
- targeted input vs approval vs takeover;
- relationship risk vs sentiment;
- protected commitments;
- stale-plan races;
- fresh-data requirements;
- duplicate/retry/unknown outcomes;
- commitments / evidence gaps;
- Case/Work Item/Durable Task/scheduling distinction;
- human corrections and rejected-recommendation reasons;
- feedback scoping (Case vs Prospect/Contact vs User/Advisor vs Organization Policy) and local adaptation vs global learning;
- stopping/yield conditions;
- reconstruction after quiescence;
- tenant ambiguity.

## 12. User experience / supervisory surface

S2 does not own full S4 Work Portfolio design, but its behavior must be understandable to users.

### 12.1 Explainable situational work

When useful/asked, Gu should be able to explain concisely:

- what changed;
- what it believes currently constrains or enables progress;
- why it chose to act, research, wait or do nothing;
- what it learned;
- why a strategy changed;
- what remains unresolved;
- whether it is waiting on prospect, advisor, provider, policy window or approval;
- whether a human currently leads the conversation;
- what commitment/evidence gap is being tracked;
- why a particular human input/approval is needed;
- why it stopped additional research/work due to sufficient evidence/diminishing returns/capability limits.

Users should not need to inspect low-level queue/retry/legacy datastore mechanics.

### 12.2 Human requests

A human request should be:

- specific;
- contextual;
- proportional;
- explicit whether it is **awareness**, **input**, **approval**, **execution** or **takeover**;
- clear about timing/impact when material.

Bad:

> "Please review this lead."

Preferred:

> "The prospect can visit Saturday or Sunday. I can verify the property's availability, but I cannot verify whether you can attend Sunday. Can you confirm which time works?"

### 12.3 Self-initiated work visibility

When self-initiated work is material, Gu should be able to connect it to the delegated objective, e.g.:

> "The property they liked became unavailable, so I compared current alternatives before deciding whether another contact would add value."

The user should not experience proactive work as unexplained arbitrary activity.

### 12.4 Human takeover visibility

The supervising human should be able to understand:

- they currently lead the relevant conversation;
- Gu is not competing for the same prospect response;
- Gu may still monitor/support the Opportunity;
- Gu can resume under governed return-to-Gu behavior.

### 12.5 Channel continuity

The same Opportunity may be discussed/supervised across authorized internal surfaces such as Web Chat and Telegram, while prospect-facing work primarily uses WhatsApp during the current migration path. Future voice or other surfaces may become prospect-facing only under an explicit channel contract.

The UI should not imply that a different surface creates a different Opportunity truth.

Exact cross-channel routing/bindings/UX belong to Technical Design and channel-specific work.

## 13. Observability, outcome, and economic telemetry

### 13.1 Operating evidence

R1 should be able to observe/correlate, proportionally:

- Case wake reason;
- current runtime/conversation authority at material decision/effect time;
- diagnosed progress constraint / advancement opportunity where materially useful;
- candidate/selected work rationale suitable for eval/debug;
- reconsideration result: no-op/wait/research/work/act/inform/input/approval/takeover/etc.;
- self-initiated vs explicitly requested work;
- research/source provenance for material claims;
- capability used / capability gap;
- artifact creation and separate delivery outcome;
- active policy/version relevant to material decision;
- human takeover/resume events where observable;
- commitments created/due/changed/resolved;
- evidence gaps created/reconciled/unresolved;
- Work proposed/executed/blocked/retried;
- strategy change/obsolete work cancellation where material;
- external effect confirmed success/failure/unknown;
- authority/policy/freshness blocks;
- human corrections / recommendation rejection reason when available;
- quiescence/yield reason and meaningful future wake condition;
- resource use/cost correlation under ADR-110.

### 13.2 Business / outcome evidence

Useful downstream measures include:

- proportion of reconsiderations ending in deliberate no-op/wait vs action;
- human touches avoided;
- human requests by mode: awareness/input/approval/execution/takeover;
- time from meaningful signal to useful next work;
- commitments fulfilled vs missed;
- evidence gaps resolved;
- research/information work that materially changed the next decision;
- contextual re-engagement → meaningful response;
- new-value outreach vs reminder-only outreach;
- match → prospect engagement / visit request;
- visit-coordination progression;
- autonomous vs human-assisted outcome quality;
- relationship collision/error rate;
- unnecessary/redundant messaging rate;
- recovery after failed/unknown effects;
- capability gaps encountered;
- work abandoned/replanned due to changed evidence;
- resource use vs achieved outcome.

Activity count alone is not success.

### 13.3 Resource / cost correlation

Material resource usage should be causally correlatable where defensible to:

- Organization/account;
- Lead Opportunity Case;
- Work Item/Attempt where durable Work Items exist;
- relevant business activity;
- external provider/capability;
- eventual outcome/progression.

Resource reasoning includes monetary cost, execution effort and human/prospect attention at product level, while the economic ledger under ADR-110 should record measurable resource/cost events without manufacturing false precision.

Internal cost-to-serve remains separate from customer price/credits/billing.

## 14. Security, privacy, tenancy, and data-sharing behavior

- Authorization is resolved before retrieving/model-ranking cross-Case or cross-organization context.
- A legacy `organization_id`, Firebase claim, `lead_id`, phone number, Gu number or public profile is not Gu OS authorization by itself.
- Legacy role labels do not imply cross-organization authority.
- Targeted advisor input/approval must route only to an authorized relevant human.
- Gu must fail closed when identity/tenant ambiguity could expose another organization's prospect/data.
- Shared Inventory authorization does not grant permission to disclose prospect identity/data to another brokerage.
- Human takeover signals must be scoped to the correct conversation/organization.
- Service-role/adapter access does not grant business permission by itself.
- Prospect opt-out/privacy/contact restrictions remain enforced where applicable.
- Model context should contain only authorized information relevant to the work.
- External-effect wrappers must enforce organization/capability authority rather than inherit known legacy shortcuts.
- Prospect/context research may use relevant public/authorized information for legitimate Relationship Operations work, but public availability alone does not make every personal attribute relevant.
- Normal Relationship Operations should avoid unnecessary use of sensitive personal information unless a separate legitimate product/process contract explicitly authorizes it.
- Research/inference must not silently create consequential eligibility, affordability, trustworthiness or similar judgments unsupported by an appropriate contract/evidence.
- Relevant prospect research may personalize or improve work, but protected/sensitive personal traits must not be used to produce prohibited discriminatory steering, eligibility, access, pricing or similar consequential treatment; applicable anti-discrimination/housing constraints remain platform hard bounds.
- Channel changes do not weaken tenant, conversation-authority, privacy or business-authority rules.

## 15. Verification expectations

| Behavior type | Minimum expected verification |
|---|---|
| Wake-up ≠ action / no-op / quiescence | Deterministic scenario/integration tests |
| Next-work semantic choice | Representative eval/scenario set + rationale rubric |
| Information gathering before action | Agentic eval + Tool trace |
| Adaptive multi-step strategy / replanning | Multi-step scenario/eval with changed evidence |
| Runtime authority / legacy suppression | Cross-repo integration/replay |
| Conversation takeover/race | Concurrency/replay integration |
| Relationship risk vs sentiment | Eval set + independent human/domain review |
| Targeted input vs approval vs takeover | Scenario/eval + policy/authority tests |
| Protected commitments | Deterministic approval/permission tests |
| Delivery/contact restrictions | Deterministic policy tests |
| Multi-channel business-authority consistency | Channel-contract/integration tests |
| Freshness/source authority | Integration fixtures with stale/conflicting sources |
| Public/external research provenance | Research scenario + source/provenance inspection |
| Prospect-research inference discipline | Safety/eval cases |
| Artifact create-vs-deliver | Artifact/effect integration |
| Capability gap | Negative capability scenarios |
| Diminishing returns / loop stopping | Agentic loop-control evals |
| Duplicate/retry/unknown outcome | Fault injection + idempotency/reconciliation |
| Legacy appointment/source disagreement | Adapter integration fixtures/replay |
| Commitment/evidence-gap semantics | Deterministic + multi-day scenario tests |
| Case vs Work Item vs Durable Task boundary | Architecture/integration review + representative tests |
| Human correction/rejection feedback | Replay/audit evidence |
| Feedback scope (Case / Prospect / User / Organization Policy) + local adaptation vs global learning | Scenario + policy-version assertions |
| Tenant/identity ambiguity | Cross-tenant negative/security tests |
| Reconsideration stopping/yield | Scenario + durable-state inspection |
| Reconstruction after quiescence | Multi-session replay |
| Pilot evolution | Shadow → assisted → selective live autonomy with rollback/telemetry |

**Independent verification:** runtime/conversation authority, cross-tenant authorization, protected commitments, duplicate consequential external effects, human-collision cases and prospect-research use in consequential contexts require independent verification beyond the implementing agent's own happy-path tests before live pilot authority.

## 16. Architecture dependencies and structural-resolution status

The architecture direction is already accepted. S2 constrains behavior without reopening AC-1 through AC-10.

| ID | Dependency | Why it matters | Owning artifact / status |
|---|---|---|---|
| S2-A1 | Fresh operational gateway + normalized events | Situational work cannot rely on delayed warehouse state | AC-1 accepted; source contracts verified; exact adapters/events OPEN — TECHNICAL DESIGN |
| S2-A2 | Fact-level authority / external-effect reconciliation | Next work/outcomes must not invent truth or duplicate effects | AC-2/AC-3/AC-4 accepted; exact mechanics OPEN — TECHNICAL DESIGN |
| S2-A3 | Organization/membership/identity bridge | Human routing/tenant safety depend on canonical Organization context | ADR-106 accepted; exact schema/RLS OPEN — TECHNICAL DESIGN |
| S2-A4 | Runtime / conversation / approval authority | S2 directly depends on these distinctions | ADR-107 accepted; exact resolver/state OPEN — TECHNICAL DESIGN |
| S2-A5 | Organization policy | Autonomous work/delivery/human gates/resource bounds need governed policy | ADR-108 accepted; exact policy types/resolver OPEN — TECHNICAL DESIGN |
| S2-A6 | Case relationships | Transaction/other durable responsibility remains separate | ADR-109 accepted; exact persistence OPEN — TECHNICAL DESIGN |
| S2-A7 | Facts/progression projections | Reconsideration consumes evidence-backed truth, not CRM stage | AC-7 accepted |
| S2-A8 | Case Supervisor / Work Plane | Situational reconsideration + adaptive work + Work durability boundary | AC-8 accepted; exact implementation OPEN — TECHNICAL DESIGN |
| S2-A9 | Durable Tasks / Work Runs | Must remain separate roots for non-Case work | Existing kernel; exact interoperability where needed is Technical Design |
| S2-A10 | Work Portfolio | Human needs generated by S2 should project into S4 | AC-9 accepted; S4 behavior pending |
| S2-A11 | Resource/cost telemetry | Adaptive research/tools must preserve cost-to-serve attribution | ADR-110 accepted; exact ledger mechanics OPEN — TECHNICAL DESIGN |
| S2-A12 | Conversation bindings / channels | Same Opportunity may be accessed across authorized surfaces while prospect-facing channel rights remain channel-contract-specific | AC-4/ADR-107 direction accepted; exact channel extension OPEN — TECHNICAL DESIGN |
| S2-A13 | Research / Tool capability governance | Self-initiated research must use authorized capabilities | Existing Skill/Tool/adapter doctrine + AC-8; exact capability registry/policy OPEN — TECHNICAL DESIGN |
| S2-A14 | Artifact/evidence representation | Created outputs may depend on inputs and later delivery/effect | Shared Case Artifact/Fact/Work primitives exist; exact usage OPEN — TECHNICAL DESIGN |
| S2-A15 | Visit evidence semantics | Reconciliation depends on what qualifies as visit outcomes | Minimum source behavior verified; exact S3 contract pending |

**Architecture consistency note:** AC-8 already establishes the same central taxonomy used by S2: Cases own durable responsibility; Case Supervisors reconsider; dynamic work graphs coordinate adaptive work; Work Items make necessary execution durable; loops execute/correct; guards/policy govern. S2 adds behavioral product detail without turning the Case Supervisor into a Relationship-specific runtime.

**Rule:** architecture/implementation may expose a true contradiction or unsafe behavior. If so, revise S2 explicitly; do not silently redefine the product contract in a Technical Plan.

## 17. Deferred / future behavior

- Full cross-Case portfolio optimization/resource allocation by an autonomous portfolio agent.
- Global/cross-Case autonomous learning that changes behavior without governed evaluation/policy.
- Business Brain learning that automatically changes organization policy without governed proposal/publication.
- Fully autonomous negotiation/economic authority beyond explicitly delegated policy.
- Universal human-attention ranking formula (S4).
- Full production voice/phone interaction, prospect-facing authority, capture and reconciliation.
- Full multi-channel conversation-authority implementation across every external channel.
- Universal customer-configurable workflow-builder semantics.
- Automated cross-brokerage prospect routing/data disclosure.
- Advanced team/role/coverage scheduling beyond R1 minimum multi-seat.
- Transaction Operations execution after concrete transaction boundary.
- Customer pricing/credits/wallet logic.
- Exact dynamic budget optimization formulas or global economic objective functions.

## 18. Spec exit criteria

Before S2 can be marked **Approved**, confirm:

- [x] Situational reconsideration is clearly distinct from timer-driven action.
- [x] `Next work` is explicitly broader than the next prospect message/task.
- [x] Diagnose-before-act and progress-constraint/advancement-opportunity semantics are explicit.
- [x] Information-gathering/learning work is valid next work.
- [x] Bounded adaptive multi-step strategies may replan as Gu learns.
- [x] Deliberate no-op/wait/quiescence are explicit valid outcomes.
- [x] Scheduled reconsideration, commitment and committed deferred Work Item are distinct.
- [x] Lead Opportunity Case, Work Item, Durable Task / Work Run and scheduling are not conflated.
- [x] Routine autonomous work categories and proactive initiative are explicit without over-authorizing external effects.
- [x] Gu may discover work without a fresh human instruction but cannot silently invent a new commercial objective.
- [x] Research/Tool/capability use, relevant prospect research, source provenance and capability gaps are covered.
- [x] Artifact creation and artifact delivery are separate decisions.
- [x] Decision-sufficient evidence, diminishing returns and resource/prospect-attention proportionality are explicit.
- [x] Protected economic/contractual/negotiation commitments require delegated/approval authority.
- [x] `autonomous`, `act+inform`, targeted input, `prepare+approval`, human-as-executor and takeover are behaviorally distinct.
- [x] Missing information does not automatically cause takeover.
- [x] Relationship risk is distinct from negative sentiment.
- [x] Runtime decision authority, conversation authority and business approval authority remain separate.
- [x] One authoritative autonomous runtime per governed prospect interaction is explicit.
- [x] Human takeover suppresses Gu speaking without automatically pausing durable responsibility.
- [x] Return-to-Gu requires current-context recompilation and does not depend on one universal legacy timeout.
- [x] Re-engagement is value-driven; contact eligibility is distinct from usefulness.
- [x] WhatsApp is the current primary prospect-facing channel; Web Chat/Telegram are current Gu OS user/advisor surfaces; future channels remain contract-specific while S2 stays channel-general.
- [x] Contact/delivery restrictions cannot be overridden by timer/match/model confidence.
- [x] Commitments survive sessions and evidence gaps preserve unknown until resolved.
- [x] Fresh operational sources govern live material decisions; BigQuery does not.
- [x] Unknown external effect outcomes are reconciled before dangerous repeat.
- [x] Execution success/external-effect success/business progression remain distinct.
- [x] Work results feed replanning; obsolete steps may stop.
- [x] Human corrections/rejected recommendations update future work without becoming accidental global policy.
- [x] Feedback scope distinguishes Case, Prospect/Contact, User/Advisor and Organization Policy; broader scope is governed rather than inferred.
- [x] Within-Case adaptation is separated from global/cross-Case Business Brain learning.
- [x] Case Supervisor stopping/yield conditions and intentional quiescence are explicit.
- [x] Future reconsideration is reconstructible from durable truth rather than hidden model memory.
- [x] S2 does not redefine S1 lifecycle, S3 visit evidence or S4 Work Portfolio.
- [x] Security/tenancy/privacy/data-sharing behavior is explicit.
- [x] Observability/outcome/economic correlation requirements are explicit.
- [x] Remaining structural questions are Technical Design/downstream Spec concerns rather than hidden product decisions.
- [x] Consolidated Spec has received integral Product / Domain review after v0.2 consolidation.
- [x] Issues found during integral review have been incorporated into v0.3.
- [x] Product / domain leadership explicitly approves S2 as a whole.

**Current gate:** **CLOSED.** Blocks 1–12 are individually approved, integral-review corrections are incorporated in v0.3, and Product / domain leadership has explicitly approved S2 as a whole.

## 19. Decision / change log

| Version / date | Decision or change | Owner / approver | Notes |
|---|---|---|---|
| v0.1 / 2026-08-28 | Initial S2 draft derived from approved Initiative Brief, S1, Architecture Analysis, Mapping, ADR-106/107/108/109/110 and completed Traditional Gu source audit. | Product/domain review pending | Initial situational next-work / authority contract. |
| v0.2 / 2026-08-29 | Consolidated product-decision review Blocks 1–12. | Product/domain leadership — block-level directions approved; whole Spec approval pending | Expands next work beyond messaging; work discovery; diagnose-before-act; information-gathering; adaptive multi-step planning; authority/human modes; relationship-risk semantics; value-driven multichannel re-engagement; commitment/Work/scheduling taxonomy; research/Tools/artifacts and relevant prospect research; resource/diminishing-return bounds; proactive initiative; execution verification/replanning; within-Case correction/outcome adaptation; Case Supervisor stopping/quiescence/reconstructibility. Standardizes canonical term **Case Supervisor** and removes accidental non-canonical domain-specific Supervisor wording. |
| v0.3 / 2026-08-29 | Integral-review corrections incorporated and whole S2 Spec approved. | Product/domain leadership — **APPROVED** | Clarifies runtime-authority preconditions for internal vs prospect-facing work; scopes feedback to Case/Prospect/User/Organization Policy; makes current channel roles explicit (WhatsApp prospect-facing, Web/Telegram internal surfaces); converts future voice to compatibility rather than R1 acceptance; adds anti-discrimination guardrail for prospect research; tightens protected-commitment, Work persistence, artifact, telemetry and terminology wording. Whole S2 behavioral contract approved after integral review. |
