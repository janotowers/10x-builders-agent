# Gu OS Evolution Roadmap

> **Version:** v1.1  
> **Status:** Canonical product sequencing roadmap  
> **Intended canonical path:** `docs/roadmap/gu-os-evolution-roadmap.md`  
> **Supersedes for sequencing:** `docs/business-brain-evolution-roadmap.md`  
> **Purpose:** Own sequencing, dependencies, status and evidence gates for Gu / Gu OS. Product intent lives in `docs/product/PRD.md`; recurring design doctrine lives in `docs/principles/gu-os-principles-and-design-doctrine.md`; architecture and implementation detail remain in topic plans/ADRs/code.

## 1. Roadmap contract

This roadmap answers four questions:

1. **What should we prove next?**
2. **What must exist before that proof is credible?**
3. **What evidence is required to graduate the increment?**
4. **What remains deliberately deferred?**

It does **not** restate the full product narrative, architecture design, implementation checklist, external inspirations or detailed subsystem schemas.

### Status vocabulary

- **Implemented:** present in code/migrations and usable under documented controls.
- **Closure / rollout:** foundation exists; remaining work is verification, live rollout, operational polish or removal of temporary paths.
- **Next product increment:** selected product responsibility to prove next.
- **Evidence-gated:** starts only when a declared trigger or business need is observed.
- **Later / option:** strategically coherent but not current sequencing commitment.

## 2. Baseline as of August 2026

The old V1–V1.7 roadmap is no longer an accurate representation of what remains to be built.

Verified current foundations include:

- file-based global Skills, pre-graph Skill selection and direct/no-skill tool use;
- Heartbeat, scheduled work and per-account agent context;
- `account_skills` V1;
- operational Cases and Property Optioning as the first real durable workflow;
- versioned workflow definitions and enforcing runtime transitions;
- Work Plane with capability-based dispatch, multiple executor modes, attempts/leases and operator views;
- Impact Plane with facts, artifacts, approvals, selective invalidation and repair;
- conservative multi-intent routing;
- Workflow Studio compiler/validation/simulation/publication foundations;
- first-class Durable Tasks / Work Runs, with remaining live-E2E/rollout work;
- private attachment and operational-AI qualification foundations, with rollout/canary work still open.

Brain Layer remains a separate future layer. Its current plan explicitly sequences it **after** the flexible-workflow foundation rather than as a parallel parent roadmap.

## 3. Sequencing principles

1. **Product responsibility before platform expansion.** Prefer the next economically meaningful responsibility Gu can assume over building a broad platform capability without a near-term product consumer.
2. **Close existing foundations before opening another major foundation.** Finish the remaining rollout/evidence gaps in Studio, Durable Tasks, attachments and Property Optioning before starting another large infrastructure program.
3. **Follow the revenue loop.** Default sequence is `Property Onboarding → Demand Generation → Conversion → Transaction → Outcome Feedback → Better Decisions`, while operating domains reuse one Gu OS kernel.
4. **Exploit the current wedge.** Relationship/Conversion work has the closest connection to Gu's proven commercial behavior and Visit Rate.
5. **Measure downstream outcomes.** A roadmap increment graduates on business/operational evidence, not on code completion or number of AI calls.
6. **Keep Brain demand-driven.** Build cross-case cognition when repeated product decisions require it; do not let ontology/knowledge work outrun operational truth and real workflows.
7. **Pull forward only the organization/multi-seat foundation consumed by R1.** Relationship Operations now requires a minimum organization/membership/assignment/visibility/routing slice because Traditional Gu already operates with multiple advisors. Keep broader organization/team administration evidence-gated and do not bundle it with unrelated multi-agent/router work.
8. **One Gu.** New domains should feel like additional responsibilities Gu assumes, not new apps the user must operate.

## 4. Roadmap sequence

| Horizon | Product / platform objective | Key deliverables | Graduation evidence | Status |
|---|---|---|---|---|
| **R0 — Close the current Gu OS foundation** | Turn the extensive architecture already built into a trustworthy pilot baseline rather than opening another major foundation. | Complete Studio human walkthrough/canary; finish Durable Task live E2E and file-input rollout; wire remaining rollout flags/telemetry; validate Property Optioning controlled E2E/readiness; retire/de-emphasize temporary lab paths only after replacement coverage exists. | A non-engineer can author/review/validate/simulate/publish a bounded workflow under governance; one real Case and one Durable Task complete through production runtime with evidence; no critical tenancy/authority regression. | **Closure / rollout** |
| **R1 — Relationship Operations v1 / absorb Traditional Gu responsibility** | Make Gu responsible for advancing a lead opportunity toward the best achievable next outcome, especially visit progression, rather than only responding/following fixed rules. | Define Lead Opportunity Case semantics; map Traditional Gu lead/conversation/matching/follow-up commitments into durable state/events; replace fixed timer follow-up with situational/event-driven next work; human involvement for relationship-sensitive moments; **minimum organization/membership/multi-advisor identity + assignment + role-appropriate visibility/routing foundation**; Work Portfolio projection; preserve WhatsApp-first prospect semantics. | In a pilot brokerage, Gu can keep opportunities alive across sessions/events and multiple advisor assignments, choose/execute allowed next work, route/escalate to the correct human, and link progression to visit request/attended-visit evidence without manual pipeline operation. | **Next product increment** |
| **R2 — Outcome loop + repeatable deployment** | Prove Gu OS can be deployed repeatedly and that delegated work produces measurable value. | End-to-end outcome linkage for lead → visit request → attended visit where available; operational/product telemetry; deployment/readiness checklist; customer configuration/integration recipe; measure first valuable work, consumption/reload, retention/expansion; reduce bespoke setup. | More than one materially different customer can reach first valuable delegated work with limited custom engineering; Visit Rate / downstream outcome evidence is attributable; operational corrections/rework and human touches are visible. Exact customer-count threshold remains a product decision. | **Next after R1 / partly parallel evidence** |
| **R3 — Organization / team maturity and expansion** | Expand the minimum organization/multi-seat foundation introduced for R1 into a broader collaboration, policy and administration model as rollout requires it. | Richer membership/role/team administration; organization-owned knowledge/skills/integrations/policies where justified; manager/team scopes; advanced delegation/approval structures; migration away from remaining profile/account shortcuts; enterprise identity only when demanded. | Multiple materially different brokerages can collaborate across teams/roles with governed visibility and authority without bespoke account-level workarounds or cross-tenant leakage. | **Evidence-gated maturity layer** |
| **R4 — Demand Operations v1** | Connect acquisition decisions to downstream commercial outcomes instead of optimizing only lead cost/activity. | Campaign objective/state; source attribution into Lead Opportunity; budget/policy boundaries; orchestrate ad platforms; event/outcome feedback from qualification/matching/visits; governed experiment loop. | Gu can compare/adjust a bounded campaign using qualified-opportunity / visit evidence under declared policy, with human authority for budget or high-risk changes. | **Next domain after Relationship outcome loop is reliable** |
| **R5 — Minimum valuable Business Brain slice** | Add cross-Case/company cognition only where it materially improves a repeated product decision or query. | One evidence-backed ingestion → compiled knowledge → query/synthesis path; promote selectively from `case_facts`/authorized SOR evidence; preserve scope/provenance; no duplicate operational state/action queue; measure retrieval/decision value. | A repeated real product question/decision becomes materially better/faster with compiled cross-Case knowledge and remains reproducible/authorized. Do not require the full 7-layer Brain vision to prove the first slice. | **Evidence-gated; default after operational workflows create sufficient evidence** |
| **R6 — Transaction Operations v1** | Preserve responsibility once a concrete deal/transaction begins without forcing the Relationship Case to own every downstream process. | Transaction Case contract; coexistence/relationship with Lead Opportunity Case; document/service/provider orchestration; approvals/evidence; failure returns appropriately to broader relationship. | A pilot transaction advances across multiple actors/systems with traceable state, human authority and verified milestones. | **Later product domain** |
| **R7 — Network / Ecosystem expansion** | Increase Gu's reach through Shared Inventory and specialist services while preserving explicit economic rights. | Liquidity/freshness/coverage metrics; explicit origin/representation/routing/attribution/commission rules; governed provider participation; cross-brokerage opportunity flows. | Cross-company work produces measurable additional opportunity/coverage without ambiguous ownership or economic rights. | **Later / grows with supply and usage** |
| **R8 — Consumer discovery** | Allow demand to originate directly through Gu only when supply density/liquidity makes the experience credible and broker-aligned. | Conversational discovery/distribution; persistent consumer relationship; broker-routing rules; no mandatory consumer app; attribution/representation model. | Sufficient market-specific inventory density/freshness and governed routing exist to create a useful consumer experience without positioning Ungga as default broker disintermediator. | **Conditional strategic option** |
| **R9 — Governed improvement / Platform Knowledge expansion** | Let product/operational evidence improve Skills, validators, patterns and software under explicit governance. | Platform learning inbox/pattern registry; failure classification; proposal/eval/approval/canary/rollback; Pattern → Skill and other owning-artifact routes. | Improvements are linked to measured outcomes, safely evaluated and reversible; no silent self-modification of policy, permissions or production code. | **Progressive; widen only with evidence** |

## 5. Immediate execution order

The small-team default should be:

1. **Finish R0 closure items.**
2. **Start R1 Relationship Operations v1 as the primary product slice.**
3. **Instrument R2 outcome/repeatability evidence from the beginning of R1 rather than as a later analytics project.**
4. **Build the minimum R1 organization/multi-seat slice needed for Relationship Operations; defer broader R3 team/organization maturity until rollout evidence requires it.**
5. **Move to R4 Demand Operations once downstream Relationship outcomes are reliable enough to optimize against.**
6. **Start the first R5 Business Brain slice when a concrete repeated cross-Case knowledge problem is observed; do not launch the entire Brain plan just because the foundation is ready.**

R6–R9 remain strategic directions whose order can change as market evidence accumulates.

## 6. R0 closure checklist

R0 is deliberately finite. It should not become another platform program.

- Studio human walkthrough in the real UI completes successfully.
- Studio discovery/qualification/attachment rollout flags and telemetry are wired for controlled canary.
- Durable Task file input + live E2E verification closes the remaining Phase 5 gap.
- Property Optioning completes a controlled N5/business-contract path with current runtime primitives.
- Existing temporary diagnostic/lab surfaces have explicit keep/retire decisions; no functional coverage is lost.
- Current docs/status labels are reconciled after the rollout evidence.
- Any critical tenancy, authority, evidence or rollback defect blocks graduation.

## 7. R1 Relationship Operations v1 — proposed scope boundary

### Responsibility

**Keep a viable buyer/renter opportunity moving toward the best achievable outcome, with visit progression as the first measurable commercial milestone.**

### Must be durable

- opportunity identity and relationship to lead/contact;
- current intent/requirements and material changes;
- presented/matched properties and key reactions;
- commitments and expected follow-up;
- visit requests / scheduled visits / attended or failed visit outcomes when observable;
- `next_action_at` / event-driven wake-up where appropriate;
- human decisions/interventions and evidence.

### Must not become

- a second CRM copy of every source field;
- a rigid predefined funnel that cannot react to changed facts;
- a general Transaction Case;
- a transcript store;
- an excuse to move every bounded lead question into a Case.

### Traditional Gu absorption rule

Preserve proven lead-engagement, matching, CRM/property integrations and WhatsApp-first semantics. Progressively move durable responsibility, commitments, follow-up scheduling, evidence and outcome state into Gu OS primitives rather than duplicating all legacy data.

## 8. Cross-cutting tracks — not top-level product phases

These capabilities remain important but should be pulled by product increments rather than automatically occupying the roadmap:

| Track | Trigger / rule |
|---|---|
| **Custom Skill packages / ADR-0011** | Implement when private package/version/rollback needs block a real customer workflow; `account_skills` V1 is already sufficient for many near-term uses. |
| **Dynamic multi-skill / subagents** | Introduce only when logs show dominant Skill + references + explicit composite + capability dispatch cannot solve repeated requests cleanly. Do not couple this to the organization model. |
| **Voice / cross-channel antecedent continuity** | Advance when live usage shows channel-switch continuity or voice artifacts materially improve the target workflow. Case continuity and decision continuity remain separate from general transcript continuity. |
| **Sandbox / executable generated artifacts** | Add when a product capability requires executable user/generated code; code generation never grants execution authority. |
| **Full Brain Layer / ingestion / pattern mining** | Start from one product-backed knowledge need; preserve Brain plan as canonical architecture reference, not fixed calendar sequence. |
| **Consumer marketplace/discovery** | Requires supply liquidity/density and broker-aligned network economics; not an early wedge. |

## 9. What becomes historical from the old roadmap

The following remain useful provenance but should no longer occupy the canonical future sequence:

- V1-A/V1-B Skill registry/selector foundation;
- V1-C/V1-D/V1-E Business Brain JSONB / Heartbeat / Settings foundation;
- V1.5 Skill visibility/config foundation;
- V1.6 `account_skills` V1;
- V1.7 operational Cases / Property Optioning foundation;
- much of the detailed “Claude Code / LLM Wiki / GStack” inspiration mapping;
- detailed `runAgent`, tool-binding, schema and migration instructions.

Those belong in Git history, architecture/topic documents and reference analyses. The roadmap should link to them rather than carry them forward.

## 10. Supersession plan

With v1.0 approved:

1. Create `docs/roadmap/gu-os-evolution-roadmap.md` from this document.
2. Update `docs/README.md` so **Product sequencing** points to the new roadmap.
3. Replace `docs/business-brain-evolution-roadmap.md` with a short supersession stub linking to the new canonical roadmap and to the Brain plan.
4. Preserve the complete old roadmap in Git history; do not copy its full body into a second historical file unless there is a concrete archival need.
5. Update high-value incoming links over time; the stub prevents old links from becoming dead ends.

## 11. Open roadmap decisions

- Exact graduation threshold for repeatable deployment across distinct customers.
- Which minimum organization/multi-seat capabilities are required for the first Relationship Operations pilot versus deferred organization/team maturity; the direction is now fixed that R1 must support multi-advisor semantics and a near-term multi-seat path.
- Which specific Lead Opportunity outcome events are reliably observable today across current integrations.
- Which Demand Operations channel/platform should be the first bounded pilot.
- What concrete repeated cross-Case question should trigger the first Business Brain slice.
- What market-level liquidity/freshness threshold should trigger Consumer Discovery.
