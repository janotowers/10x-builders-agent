# ADR-104 — Governed improvement authority

**Status:** Accepted direction  
**Date:** 2026-08-02  
**Related:** [`../manuals/ai-native-loops.md`](../manuals/ai-native-loops.md), [`../manuals/gu-os-flexible-workflows-technical-plan.md`](../manuals/gu-os-flexible-workflows-technical-plan.md) §14–15, [`../operational-cases/testing-framework.md`](../operational-cases/testing-framework.md) §13.7

## Context

An AI-native company needs loops that observe, act, evaluate, and improve. Unrestricted self-modification is unsafe. Gu OS already has HITL, workflow immutability for published definitions, and proposal-only skill authoring. Those need an explicit improvement-authority model.

## Decision

Every loop declares what it may improve and under which gates:

| Target | Default authority |
| --- | --- |
| Mechanical index/health repair | Autonomous |
| Add evidence-linked Brain facts | Conservative policy; review when uncertain |
| Modify/remove compiled truth | Diff + HITL + versions |
| Propose Skill / Pattern→Skill | Autonomous proposal; human activation |
| Publish/modify workflow | Proposal → simulate/eval → release approval → canary → measure → rollback |
| Policy/permissions | Human governance only |
| Production code | Normal PR/tests/security/release path |

Autonomy is earned per operation with measured approval quality; it is not assumed.

Distinguish:

- **Regeneration:** inputs changed → repair declared dependent artifacts.
- **Self-improvement:** outcomes indicate the mechanism should change → versioned proposal path.

## Consequences

- Cron repetition is not Level-5 self-improvement.
- Agents may not silently rewrite published workflows, policies, or critical formulas.
- Outcome economics joins existing `ai_usage_events` to terminal outcomes, human touches, and rework; it does not invent a parallel usage ledger.

## Reevaluate when

- A specific operation sustains high approval quality and low regression risk for a defined window.
- Outcome metrics show that required HITL is the dominant delay with negligible safety benefit.
- A new loop class needs a different allowlisted improvement target.
