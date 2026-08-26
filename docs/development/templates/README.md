# Gu OS Development Templates

> **Status:** Canonical authoring scaffolds  
> **Purpose:** Provide reusable structures for development artifacts without becoming a second source of product, architecture, or implementation truth.

Templates in this directory are **scaffolds**, not governing decisions. A copied and approved artifact becomes authoritative only within the role defined by the Gu OS Development Methodology.

## Available templates

| Template | Use | Governing artifact role |
|---|---|---|
| [`feature-business-spec-template.md`](feature-business-spec-template.md) | Consequential user/business behavior, workflow/case behavior, permissions/authority behavior, or other functionality whose implementation must not invent product decisions. | The resulting approved Feature / Business Spec owns intended behavior. |

Additional PRD, Initiative Brief, ADR, Technical Plan, Slice/Task, Verification, and Playbook templates may be added when there is a concrete need. Do not create templates merely to increase document count.

## How to use the Feature / Business Spec template

1. Copy `feature-business-spec-template.md` into the initiative's `specs/` directory.
2. Rename it for the capability, for example:
   `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`.
3. Keep the filename normally unversioned. Use the document `Version` field plus Git history for routine evolution.
4. Remove sections that are genuinely irrelevant rather than filling them with boilerplate.
5. Add detail in proportion to business consequence, ambiguity, model judgment, authority, security, and failure cost.
6. Resolve product behavior in the Spec; record structural questions for Architecture Analysis / ADR; leave implementation mechanics to the Technical Plan.
7. Define acceptance scenarios before or alongside implementation planning.

## Relationship to Agile / backlog work

A Feature / Business Spec is a **behavioral contract**, not a backlog item.

One Spec may:
- correspond roughly to one product Feature;
- cover behavior that later decomposes into several Stories / Enabler Stories / vertical slices;
- or define a cross-cutting behavioral contract used by more than one implementation slice.

The implementation backlog is derived later from approved behavior and architecture:

`Spec → Architecture / ADR → Technical Plan → Tasks / Vertical Slices → Implementation → Verification`

Do not force a 1:1 mapping between Spec sections and Stories.

## Status vocabulary

Recommended document statuses:

- **Draft** — behavior is still being clarified.
- **In review** — candidate contract is coherent enough for focused human/domain review.
- **Approved** — intended behavior is accepted and may govern architecture/implementation planning.
- **Superseded** — retained for history/redirect only; another artifact owns the active behavior.

## Template design rules

- Behavior first; implementation later.
- Acceptance-scenario-first for product/workflow behavior.
- Model judgment and authority are separate.
- Evidence closes consequential work; agent assertions do not.
- Current, target, and open statements must be distinguishable where brownfield systems are involved.
- A template should reduce ambiguity, not create bureaucracy.
