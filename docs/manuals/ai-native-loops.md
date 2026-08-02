# AI-native loops in Gu OS

**Status:** integrated target model. It maps implemented and planned Gu OS components; it does not authorize new autonomous writes by itself.

Gu OS treats an AI-native company capability as a governed loop:

```text
Observe -> Decide -> Act -> Evaluate -> Learn -> Repeat
```

Automation repeats a procedure. Self-improvement evaluates outcomes and changes the mechanism that performs it. The second behavior requires stricter evidence, publication, and rollback gates.

## 1. Standard loop contract

Every production loop should document:

| Field | Question |
| --- | --- |
| Outcome | What business result must it produce? |
| Target / baseline | What expected result or prior performance is the outcome compared with? |
| Sensors | What events/data make the situation observable? |
| Context | What domain and tenant knowledge is required? |
| Policy | What decisions may it make? |
| Escalation | What requires human approval or exception handling? |
| Tools | What systems may it read or modify? |
| Evaluation | How is success verified? |
| Memory | What evidence and result must be retained? |
| Feedback linkage | How does the evaluated result reach the next cycle? |
| Improvement targets | What may the loop propose or change? |
| DRI | Which human remains accountable for the outcome? |

The contract belongs at the workflow/loop level. A Skill supplies procedure; it does not by itself define sensors, outcomes, evaluation, or improvement authority.

### 1.1 Open-loop vs closed-loop

An **open loop** may observe, decide and act, but its result is not systematically compared with a target and fed into the next cycle. A cron, summary or one-time automation may be useful while remaining open-loop.

A loop qualifies as **closed-loop** only when all of the following are true:

1. the target or baseline is explicit;
2. the result is observable and linked to the action/version that produced it;
3. evaluation compares result against target with declared quality and safety criteria;
4. an allowlisted mechanism may adjust the next action, procedure or proposal;
5. the evaluated result actually reaches the next cycle; and
6. the DRI can inspect evidence, intervene and retain or roll back the adjustment.

Missing any item is a documented maturity gap, not permission to infer success. Closing the feedback path does not imply autonomous self-modification: improvement authority remains governed by §4.

## 2. Maturity model

| Level | Capability |
| --- | --- |
| 0 — Manual | Humans observe, decide, execute, and evaluate |
| 1 — Assisted | AI proposes or summarizes; human executes |
| 2 — Automated | AI executes a fixed governed procedure |
| 3 — Evaluated | Results are verified and correlated with evidence/cost |
| 4 — Improvement proposed | Failures/outcomes produce versioned change proposals |
| 5 — Governed improvement | Approved changes pass eval, canary, publication, monitoring, and rollback |

Gu OS must not claim Level 5 because a cron repeats or because an LLM rewrites content. Autonomy is earned per operation through measured evidence.

## 3. Current loop map

| Loop | Observe | Decide/Act | Evaluate | Learn | Status |
| --- | --- | --- | --- | --- | --- |
| Interactive turn | Messages, session, memory | Skill resolver + LangGraph + tools | Tool results, HITL | Personal memory flush | Implemented; learning limited |
| Operational case | Case events, documents, timers | Bound skill, adapters, cron | Gates, events, approvals | Future facts/artifacts/repair | Implemented + planned impact plane |
| Heartbeat | Checklist + deterministic prefetchers | Safe skill/tool policy | Runs, no-action and false-positive review | Checklist/manual tuning | Implemented read-oriented V1 |
| Scheduled task | Schedule + prompt | Allowlisted tools | Run/result/audit | Manual tuning | Implemented |
| Workflow lifecycle | Specs/definitions/scenarios | Compiler/dispatcher target | Replay, verification, release evidence | Fork/new version | Phase 1 partial; later phases planned |
| Brain Ingest/Query/Lint | Sources, turns, entity signals | Connectors, retrieval, maintenance | Provenance, gaps, contradiction/orphan lint | Compiled truth, Signal->Memory | Planned |
| Pattern->Skill | Repeated outcomes and behaviors | Candidate miner | Outcome correlation + rubric/evals | HITL-published Skill | Planned |

## 4. Improvement authority

Each loop must allowlist what it may improve:

| Target | Default authority |
| --- | --- |
| Index/backlink repair, stale embedding, orphan report | Autonomous mechanical maintenance |
| Add evidence-linked Brain fact | Conservative policy; review where uncertain |
| Modify/remove compiled truth | HITL + version/diff |
| Propose Skill | Autonomous proposal; human review and activation |
| Publish/modify workflow | Versioned proposal -> simulation/eval -> release approval |
| Change policy/permissions | Human governance only |
| Change production code | PR, tests, security/release gates; never silent runtime mutation |
| Generate situational UI/code | Sandboxed proposal/use; durable rules and data remain governed |

The safe change path is:

```text
detect failure
  -> classify owning artifact
  -> propose versioned change
  -> simulate/evaluate
  -> approve
  -> publish/canary
  -> measure
  -> retain or rollback
```

## 5. DRI and human roles

The DRI owns the outcome; it is not automatically the assignee, approver, team manager, organization owner, or platform admin. A loop may have:

- AI/worker executors.
- Assigned operational users.
- One or more approval authorities.
- A DRI accountable for the result and acceptable risk.

DRI should become first-class when the work plane is introduced. Until then, documents and UI must not imply that `user_id`, `super-admin`, or the last approver is the DRI.

## 6. Evaluation and outcome economics

Gu OS already records AI calls, tokens, latency, cost, turn, channel, and `operational_case_id` in `ai_usage_events`. The missing step is outcome correlation, not case attribution.

For each loop/case version, evaluate:

- Terminal business outcome and quality.
- Cycle time.
- AI cost and model-call count.
- Human approvals, corrections, touches, and time where measurable.
- Retries, rework, stale artifacts, reversals, and external errors.
- Comparison with baseline and prior workflow version.

The optimization target is:

```text
validated business outcomes
--------------------------------------------
inference cost + human effort + error/rework
```

Tokens alone are an input metric, not success.

## 7. Company legibility backlog

An organization is queryable when an authorized user or agent can reconstruct important operational state from governed evidence—not merely retrieve semantically similar text. For a declared scope, Gu OS should progressively answer:

- **State:** What is happening now, what is blocked, and what changed?
- **Decision:** What was decided, by whom, when, and for what rationale?
- **Commitment:** What was promised, to whom, by when, and who owns follow-up?
- **Outcome:** What result was expected, what occurred, and which actions/version preceded it?
- **Responsibility:** Who is assigned, who may approve, and who is the DRI?
- **Evidence:** Which authoritative source, timestamp, scope and provenance support the answer?

The organization should continuously identify:

- Questions agents could not answer.
- Decisions without rationale/provenance.
- Commitments without owner, due date, source, or follow-up.
- Important meetings or conversations whose approved decisions never reached an operational timeline.
- Exceptions that exist only in conversations.
- Processes known by one person.
- Missing or unauthorized sources.
- Contradictory policies.
- Stale pages/manuals.
- Outcomes not connected to actions.

These gaps become governed ingestion, documentation, policy, eval, or Skill work—not automatic broad recording. Raw transcripts are evidence sources, not universal memory. Consent, participant expectations, minimization, retention, PII, and access control remain part of the architecture.

## 8. Regenerable artifacts and software

Distinguish:

- **Business/knowledge artifact:** durable, versioned output with declared inputs.
- **Generated view:** dashboard, report, map, manual, or calculator projected from authoritative facts/artifacts.
- **Software artifact:** code implementing a view/tool.
- **Situational software:** narrow code that may be cheaper to regenerate than maintain.

Regeneration because inputs changed is repair. Changing the specification/logic because outcomes were poor is self-improvement and must follow the governed change path.

Critical logic—authorization, financial formulas, legal rules, workflow engine, audit, and integrations—does not become disposable merely because code generation is cheap.

## 9. Product principle

AI-native does not mean adding copilots everywhere. It means progressively converting valuable business processes into observable, governed, evaluable loops while preserving clear human accountability.

## Related documents

- [`architecture-manual.md`](architecture-manual.md)
- [`agentic-principles-alignment.md`](agentic-principles-alignment.md)
- [`gu-os-flexible-workflows-technical-plan.md`](gu-os-flexible-workflows-technical-plan.md)
- [`../operational-cases/testing-framework.md`](../operational-cases/testing-framework.md)
- [`../brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md)
- [`../adr/ADR-104-governed-improvement.md`](../adr/ADR-104-governed-improvement.md)
- [`knowledge-scope-and-ownership.md`](knowledge-scope-and-ownership.md)
