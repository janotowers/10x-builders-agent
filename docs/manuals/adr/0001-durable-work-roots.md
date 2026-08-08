# ADR-0001 — Durable work roots (Case vs Durable Task vs Skill vs Schedule)

**Status:** Accepted direction (Phase 5)  
**Date:** 2026-08-07  
**Related:** Technical Plan §7.0; detailed plan Phase 5 + findings 23, 29, 30; walkthrough taxonomy

## Context

`work_items.case_id` was historically `NOT NULL`, so batch jobs and other non-dossier work were forced into phantom cases or non-durable turns. Duration and HITL do **not** distinguish roots. Studio authoring must classify NL without asking operators for ontology jargon.

## Decision

Classification test (truth kind):

| Root / artifact | Question owned |
| --- | --- |
| **Case** (`case_workflow`) | What is commercially/operationally true about this entity or process *now*? |
| **Durable task** | How is this job progressing / what did it deliver? |
| **Skill** (`reusable_skill`, `simple \| composite`) | Reusable procedure — not a root. |
| **Schedule** | When to start/repeat underlying work — references a case or durable task; not a one-off chat query. |

Non-discriminators: HITL presence, wall-clock duration, “feels long.”

Non-artifact router outcomes: `clarify`, `redirect_to_chat` (one-off query → Chat, not Studio).

Runtime shape: `durable_tasks` → `work_runs` → `work_items` with XOR root (`case_id` **or** `work_run_id`). Durable roots are a standard capability: active runs enroll their tenant in the dispatcher without a separate feature flag.

Artifact inputs: `input_requirements` taxonomy separates account prerequisites from runtime data (finding 30); do not overload `account_assets` for task I/O.

## Consequences

- No phantom `case_type` rows for batches.
- Control operativo / Studio list cases **and** durable tasks; compiling remains side-effect free and execution starts through an explicit human action or schedule.
- Dynamic `agent_proposed` work waits until verification envelopes + either root exist.
- Skills and schedules never substitute for a durable root.

## Reevaluate when

- Retention defaults for task inputs vs results need a product decision (§28.13).
- Schedules create new runs vs new tasks in production traffic.
- Overview board parity with case cards is productized beyond the Diseño list.
