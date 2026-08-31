# R1 Relationship Operations — S4 Work Portfolio, Needs Attention & Multi-seat Supervisory Experience

> **Version:** v0.1  
> **Status:** APPROVED — canonical Relationship Operations behavioral contract  
> **Initiative:** R1 — Relationship Operations v1  
> **Parent architecture:** `docs/product/initiatives/relationship-operations/architecture-analysis.md`  
> **Related specs:** S1 `lead-opportunity-lifecycle.md` · S2 `situational-progression-next-work-human-authority.md` · S3 `visit-progression-outcome-evidence-reconciliation.md`  
> **Cross-domain Experience source:** `docs/manuals/gu-os-experience-architecture.md`  
> **Intended repo path:** `docs/product/initiatives/relationship-operations/specs/work-portfolio-supervisory-experience.md`

---

## 1. Executive contract

The Work Portfolio is the human supervisory projection over durable business responsibility delegated to Gu OS. It is **not** a CRM pipeline, a second source of operational truth, a generic task inbox or a list of everything Gu is doing.

The Portfolio answers, for an authorized human:

- where human awareness, judgment or action matters now;
- what Gu currently owns and is handling autonomously;
- what Gu is intentionally waiting for or watching;
- what meaningful business results have occurred;
- where responsibility is stalled or requires intervention;
- how work, human contribution and business outcomes relate without collapsing into one status vocabulary.

The canonical business unit remains the **Case** and its accepted Facts, Work, Approvals, relationships and domain lifecycle. Portfolio entries are projections over that truth. Portfolio actions update the owning canonical mechanisms rather than creating Portfolio-only business truth.

> **Needs Attention means human-intervention relevance, not commercial attractiveness, lead quality, raw urgency or recent activity.**

---

## 2. Scope and non-goals

### In scope

- Work Portfolio purpose and supervisory posture;
- My Work / Organization Work scope;
- Needs Attention admission, ranking and exit semantics;
- Gu Handling / Active Handling / Waiting / Watching / quiescence / stalled semantics;
- business results and contribution projection;
- multi-seat assignment/delegation/approval/takeover semantics;
- Human Involvement mapping;
- Experience Architecture boundary.

### Out of scope

- exact UI/components;
- notification/delivery implementation;
- Portfolio storage schema;
- new Portfolio SOR;
- Portfolio Supervisor agent;
- exact role tables;
- Analytics causal/economic methodology;
- S1 lifecycle, S2 next-work semantics or S3 Visit truth already owned elsewhere.

---

## 3. Relationship to S1–S3

- **S1** owns Lead Opportunity lifecycle, continuity, reactivation and canonical closure outcomes.
- **S2** owns situational next-work judgment and the Relationship Operations human-authority/product lens.
- **S3** owns Visit identity, occurrence/evidence, feedback and Relationship↔Transaction boundary semantics.
- **S4** projects the supervisory consequences of those truths without redefining them.

Relationship Operations continues to specialize shared Gu OS primitives: Operational Cases, Facts/evidence, Work, Approvals, relationships, current authority and organization membership.

---

## 4. Work Portfolio supervisory model

> **Work Portfolio = authorized human supervisory projection over Gu-held durable responsibilities, emphasizing where human awareness/judgment/action matters, what Gu is handling, what Gu is waiting/watching for and what meaningful results occurred.**

### 4.1 Exception-first, not exception-only

The Portfolio should make exceptional/human-relevant situations easy to discover while preserving enough visibility into Gu-owned work to support trust and supervision.

It should answer:

- What needs me?
- What does Gu have under control?
- What is intentionally waiting/watching?
- What changed materially?
- What did Gu get done?

### 4.2 My Work / Organization Work

- **My Work:** organization work relevant to the current user through DRI/assignment, pending input, approval authority, human-executor responsibility, Visit Host/domain role, delegated supervision or another explicit relationship.
- **Organization Work:** organization-owned responsibilities visible under current organization authorization.

Both project shared canonical business truth; they do not create private business realities.

### 4.3 Non-exclusive postures

A Case may simultaneously be in Needs Attention and Gu Handling if a human approval is needed while Gu continues authorized parallel work. Outcomes may also coexist with an active Case.

---

## 5. Supervisory posture semantics

### Needs Attention

A human contribution is materially relevant now.

### Gu Handling / In Motion

Gu retains responsibility; no additional human contribution is currently needed. This does not imply continuous compute or an active Work Item.

### Waiting

Progression depends on a future time, response, event or condition and additional action is not currently justified.

### Watching

Gu owns responsibility to detect a material change and reconsider. Watching requires a credible detection mechanism.

### Outcomes

Evidence-backed meaningful business results/material progression useful for supervision. S4 Outcomes are a projection, not a new universal Outcome root.

### Stalled / anomaly

Material responsibility exists but there is no credible active path, valid waiting/watching posture, intentional quiescence or reliable wake/re-entry path.

---

## 6. Needs Attention

### 6.1 Definition

> **Needs Attention exists when a specific authorized human contribution is required now, or when human incremental value is sufficiently high that delay or omission creates material cost, risk or lost opportunity.**

A future/abstract human dependency is not enough.

### 6.2 WHY / WHAT / WHY NOW

A useful item explains:

1. WHY it is being surfaced;
2. WHAT GU NEEDS from the human;
3. WHY NOW the contribution is material.

### 6.3 Governed must-surface path

Examples:

- approval/protected decision;
- human execution materially required;
- blocking human input;
- authority exception;
- consequential unresolved effect needing intervention;
- governed deadline/commitment requiring human contribution.

The underlying requirement comes from current truth, policy, authority, capability or domain semantics. Gu does not invent it.

### 6.4 Contextual human-value path

Model judgment may assess human incremental value using consequence, urgency, blockage, human advantage, relationship risk, business relevance/value, interruption cost and whether Gu still has a credible autonomous path.

### 6.5 Eligibility ≠ priority

Must-surface status does not mean maximum priority. Urgency, consequence and priority remain distinct.

### 6.6 Avoid brittle lead scoring

Needs Attention must not become an opaque commercial score or brittle rule forest. Deterministic mechanisms are appropriate for hard deadlines, authority and blockers; contextual human value generally requires bounded model judgment.

### 6.7 Actor/role-specific

Attention is relative to a capable actor/role/group. Authorization, routing and responsibility remain separate.

### 6.8 Exit semantics

Attention exits when the underlying human need is resolved, obsolete, superseded by a valid path, or no longer materially worth human interruption.

Seen/opened/acknowledged/snoozed/claimed do not by themselves resolve it.

### 6.9 Human contribution is bounded

Requesting input/approval/execution does not transfer Case ownership. After human contribution the Case Supervisor reconsiders current truth; it does not blindly resume stale work.

---

## 7. Gu Handling, Waiting, Watching, quiescence and stalled

### 7.1 Gu Handling is business-level

Gu Handling means Gu retains responsibility and no additional human contribution is needed now. It does not imply a currently running model/process/message/work item.

### 7.2 Actively Handling

Useful autonomous work is currently justified and Gu has a credible authorized path.

### 7.3 Waiting

Progression depends on future time/response/event/condition. An external person does not need a Work Item merely because Gu waits for them.

### 7.4 Watching

Watching requires a credible detection mechanism: event-driven, scheduled, polling-backed or authorized human/external input.

A per-Case timer is not required. Example:

```text
inventory source
→ webhook / CDC / polling observer
→ material delta
→ candidate routing
→ wake relevant Cases
→ fresh search / matching
→ Supervisor decides
```

### 7.5 Quiescence

Intentional inactivity is valid when durable context exists, no work is justified now and a credible re-entry path exists.

Deliberate no-op is valid agentic behavior.

### 7.6 Quiet ≠ stalled

No universal inactivity timeout defines stalled. Stalled is responsibility-relative.

### 7.7 Runtime vs commercial stall

Technical provider failure and commercial stagnation are distinct. Stalled/anomaly also does not automatically imply Needs Attention if Gu has an autonomous recovery path or the relevant human is an operational/engineering actor rather than the real-estate user.

### 7.8 Forgotten responsibility is failure

A responsibility that has no active path, valid wait/watch/quiescence or credible wake mechanism is an integrity problem.

### 7.9 Deferred Work ≠ scheduled reconsideration

Committed deferred Work is a promise to execute a bounded work contract later. Scheduled reconsideration means Gu will reassess what work is useful then.

### 7.10 Human conversation takeover

Takeover may suppress Gu speaking in that conversation without necessarily stopping all other authorized Case work.

---

## 8. Outcomes and contribution

### 8.1 Preserve distinctions

> **Work ≠ execution activity ≠ Work result ≠ business progression ≠ business outcome.**

Example:

```text
Work: identify alternatives
Execution: searched 120 listings
Work result: 4 viable alternatives
Progression: prospect requested Visit
Material result: Visit attended
Closure: owned by S1 when applicable
```

### 8.2 Work success ≠ business progress

Correctly finding zero suitable properties can be a successful Work result without Opportunity progression.

### 8.3 Intermediate results may be material

Project an intermediate result when it materially changes human understanding of the situation/progress/result. Results may be positive, negative or mixed.

### 8.4 Outcome truth ≠ contribution ≠ causality

Preserve:

1. what occurred;
2. demonstrable contributions;
3. causal claims requiring stronger methodology.

Gu contribution does not automatically imply Gu caused the sale.

### 8.5 Mixed human + Gu contribution

Prepared by / approved by / executed by / negotiated by / detected by may remain distinct. Outcome first, credit second.

### 8.6 Portfolio ≠ Analytics

Portfolio emphasizes current/recent supervision and meaningful results. Cohort, causal, economic, Visit Rate trends and longitudinal performance belong in Analytics.

### 8.7 Supervisory insight ≠ automatic authority

A pattern/recommendation surfaced by Gu does not automatically become a Fact, Brain entry, Skill or Policy. Improvement routes to the owning artifact.

### 8.8 Failure layers remain distinct

Work/effect failure ≠ business failure. Negative outcome ≠ bad Gu execution. Positive outcome ≠ proof of causal quality.

---

## 9. Human Involvement and Human Interaction

### Cross-domain WHAT

1. Action/tool authorization
2. Business decision
3. Human contribution/task
4. Exception review/intervention

### Cross-domain HOW

- HITL — blocking
- Human as executor
- Human-on-the-loop

### Relationship Operations S2 lens

- Autonomous
- Act + Inform
- Targeted Human Input
- Prepare + Approval
- Human-as-executor
- Human Takeover

These are complementary layers, not replacements.

### Experience seam

The cross-domain Experience Architecture owns semantic Human Interactions such as ApprovalRequest, DecisionRequest, InformationRequest, HumanWorkRequest, EvidenceRequest, ExceptionReview, Takeover and Return-to-Gu.

> **Needs Attention is not itself a Human Interaction primitive.** It projects the fact that one or more Human Interactions are materially relevant now.

---

## 10. Multi-seat supervisory actions and handoffs

1. Portfolio actions update canonical mechanisms; Portfolio is not business state authority.
2. Targeted input ≠ approval.
3. Human execution should use appropriate evidence/result semantics where consequence requires it.
4. Approval is bounded to a protected decision/effect; it does not transfer broad authority or freeze state.
5. Consequential execution revalidates current state after approval where material.
6. Ambiguous natural language cannot weaken authority.
7. Organization ownership ≠ assignment ≠ DRI ≠ approver ≠ executor ≠ Visit Host ≠ conversation lead.
8. Delegation cannot mint authority.
9. Reassignment preserves attribution and may trigger reconsideration.
10. Conversation takeover ≠ Case takeover.
11. Return to Gu is a governed transition followed by fresh reconsideration, not a stale bot toggle.
12. Human-reported external action is provenance-bearing evidence/claim in the owning mechanism.
13. Corrections update the owner of canonical truth.
14. Snooze ≠ delegation ≠ business Waiting automatically.
15. Acknowledged ≠ resolved; claimed ≠ completed.
16. Personal presentation state may differ by user while business resolution remains shared.
17. Overrides remain attributable human decisions.
18. Escalation/routing never widens authority merely because time passed.
19. Bulk actions are allowed only when semantics, authority and consequence make them safe.
20. Repeated UI/conversational attempts must not duplicate consequential effects.
21. No universal undo is implied by UI convenience.

---

## 11. Experience Architecture boundary

### S4 owns

- whether/why human attention is materially relevant;
- underlying human need;
- Gu Handling / Waiting / Watching / stalled business semantics;
- outcome/contribution distinctions;
- multi-seat business semantics of assignment/delegation/approval/takeover;
- meanings any renderer must preserve.

### Experience Architecture owns

- Semantic Human Interaction primitives;
- Contextual Views and Artifacts;
- visual hierarchy/progressive disclosure;
- attention delivery/notifications/digests;
- Web/Telegram/WhatsApp/Voice rendering;
- identity/branding/AI Representative expression;
- personalization, Patterns/Definitions;
- accessibility and Experience evals.

The shared seam is the semantic Human Interaction plus current canonical context.

---

## 12. Invariants

1. Portfolio is a projection, not a second SOR.
2. Needs Attention means human-intervention relevance, not lead attractiveness.
3. Human dependency does not imply attention now.
4. Attention eligibility and priority are distinct.
5. Model judgment cannot create authority.
6. Seen/acknowledged/snoozed/claimed do not resolve a business need by themselves.
7. Gu Handling does not imply continuous runtime activity.
8. Waiting does not require an external actor Work Item.
9. Watching requires credible detection/reconsideration.
10. Quiescence is valid only when intentional, durable and credibly re-enterable.
11. Quiet does not imply stalled; stalled does not follow from a universal timeout.
12. Forgotten durable responsibility is an integrity failure.
13. Deferred Work and scheduled reconsideration are distinct.
14. Work activity/result/progression/outcome remain distinct.
15. S1 remains authority for Lead Opportunity closure outcomes.
16. Outcome truth, contribution and causal attribution remain distinct.
17. Conversation takeover does not imply Case takeover.
18. Delegation/routing cannot mint authority.
19. Portfolio actions update owning canonical mechanisms.
20. Needs Attention is not a Human Interaction primitive.
21. Per-user presentation state and shared business resolution are distinct.
22. Reopening/retrying presentation must not duplicate effects.
23. Relationship-specific UI consumes cross-domain Experience primitives where shared meaning exists.

---

## 13. Acceptance scenarios

| Scenario | Expected behavior |
| --- | --- |
| High-value Opportunity with credible authorized Gu path | May remain outside Needs Attention |
| Lower-value Opportunity requiring protected approval | Appears in Needs Attention for capable actor |
| User opens approval but does not decide | Seen may change; need remains unresolved |
| User snoozes attention | Delivery state changes; business need remains unless business commitment also changes |
| Gu waits for prospect and has valid response/event wake path | Waiting/Watching valid without continuous model runtime |
| Watching but no credible detection mechanism | Invalid posture |
| Case has no current work and no credible wake/re-entry | Stalled/integrity failure, not healthy quiescence |
| Search finds zero suitable listings | Work may succeed while business progression does not |
| Visit attended after Gu+human work | Visit outcome is truth; contribution attributable separately; no automatic causality |
| Approval surfaced in Portfolio, resolved in Telegram | One Human Interaction/business resolution; Web must not ask again |
| Assigned advisor lacks approval permission | Assignment does not grant approval authority |
| Human takes over prospect conversation | Gu speaking may stop while other authorized Case work continues |
| Human reports external call | Persist as provenance-bearing claim/evidence in owning mechanism |
| User hides mandatory attention card | Personal presentation cannot erase underlying obligation |
| Provider outage has autonomous retry path | May recover without surfacing to real-estate user |

---

## 14. Technical Design boundaries

S4 intentionally does not select:

- Portfolio projection tables/materialized views;
- attention ranking algorithm;
- current-vs-target mapping of `internal_user_notifications`;
- exact APIs/events;
- role/group schema;
- UI components;
- semantic payload schema;
- presence/channel routing;
- telemetry schema.

Those decisions belong to the integrated R1 Technical Plan and cross-domain Experience technical design.
