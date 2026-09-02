# Gu OS Development Templates

> **Status:** Canonical authoring scaffolds  
> **Purpose:** Provide reusable structures for development artifacts without becoming a second source of product, architecture, or implementation truth.

Templates in this directory are **scaffolds**, not governing decisions. A copied and approved artifact becomes authoritative only within the role defined by the Gu OS Development Methodology.

## Available templates

| Template | Use | Governing artifact role |
|---|---|---|
| [`feature-business-spec-template.md`](feature-business-spec-template.md) | Consequential user/business behavior, workflow/case behavior, permissions/authority behavior, or other functionality whose implementation must not invent product decisions. | The resulting approved Feature / Business Spec owns intended behavior. |
| [`slice-plan-template.md`](slice-plan-template.md) | An initiative whose approved behavior/architecture must be delivered as ordered, independently verifiable increments that humans plan and close with evidence. | The resulting Slice Plan owns the durable Slice contracts and their order. |

Additional PRD, Initiative Brief, ADR, Technical Plan, Verification, and Playbook templates may be added when there is a concrete need. Do not create templates merely to increase document count.

## How to use the Feature / Business Spec template

1. Copy `feature-business-spec-template.md` into the initiative's `specs/` directory.
2. Rename it for the capability, for example:
   `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`.
3. Keep the filename normally unversioned. Use the document `Version` field plus Git history for routine evolution.
4. Remove sections that are genuinely irrelevant rather than filling them with boilerplate.
5. Add detail in proportion to business consequence, ambiguity, model judgment, authority, security, and failure cost.
6. Resolve product behavior in the Spec; record structural questions for Architecture Analysis / ADR; leave implementation mechanics to the Technical Plan.
7. Define acceptance scenarios before or alongside implementation planning.

## How to use the Slice Plan template

1. Copy `slice-plan-template.md` into the initiative directory as `slice-plan.md`, for example:
   `docs/product/initiatives/relationship-operations/slice-plan.md`.
2. Keep one Slice Plan per initiative, beside that initiative's Technical Plan and `specs/` directory.
3. Fill Slice contracts using rolling wave: the near-term Slices in full, later Slices at stub level. Detailed Tasks are never written here — the coding agent derives them at execution time.
4. Reference governing acceptance scenarios by their Spec identifiers (`AC-*`, `EC-*`, `HP-*`). Do not restate Spec behavior.
5. Declare Release Scope at readiness, not at completion.
6. Keep the Slice Plan free of execution state. It carries **readiness**, never execution stage: the agent runtime owns Tasks and pre-PR execution, and GitHub owns branch/commit/PR/CI/merge/Actions state.
7. Record the confirmed Accountable / DRI in the transitional execution register, not in the durable Slice contract — a Slice can be READY before anyone is assigned.

## Relationship to Agile / backlog work

A Feature / Business Spec is a **behavioral contract**, not a backlog item. It is **capability-sized**: the word "Feature" describes the kind of truth it owns, not the size of an increment.

One Spec may:
- correspond roughly to one product Feature;
- cover behavior that later decomposes into several Stories / Enabler Stories / vertical slices;
- or define a cross-cutting behavioral contract used by more than one implementation slice.

The implementation backlog is derived later from approved behavior and architecture:

`Spec → Architecture / ADR → Technical Plan → Slice Plan → Implementation → Verification`

| Artifact | Owns |
|---|---|
| Spec | Intended behavior, at capability scope. |
| Slice | A bounded increment that proves part of that behavior, or a required enabling capability. The unit humans plan. |
| Task | The implementation steps realizing one Slice, derived just in time by the coding agent. Not a Markdown artifact. |

Do not force a 1:1 mapping between Spec sections and Stories, and do not wait for a whole Spec to be implemented before behavior can be verified — each Slice declares the subset it proves.

## Status vocabulary

Recommended document statuses:

- **Draft** — behavior is still being clarified.
- **In review** — candidate contract is coherent enough for focused human/domain review.
- **Approved** — intended behavior is accepted and may govern architecture/implementation planning.
- **Superseded** — retained for history/redirect only; another artifact owns the active behavior.

These are **document** statuses. Slice execution status (`Proposed`, `Planned`, `Implementing`, … `Done`) is a separate vocabulary scoped exclusively to Slice execution — see Methodology §12.2. Do not mix the two.

## Template design rules

- Behavior first; implementation later.
- Acceptance-scenario-first for product/workflow behavior.
- Model judgment and authority are separate.
- Evidence closes consequential work; agent assertions do not.
- Current, target, and open statements must be distinguishable where brownfield systems are involved.
- Durable contracts belong in Markdown; live execution state does not.
- A template should reduce ambiguity, not create bureaucracy.
