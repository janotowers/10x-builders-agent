# Gu OS Development Templates

> **Status:** Canonical authoring scaffolds  
> **Purpose:** Provide reusable structures for development artifacts without becoming a second source of product, architecture, or implementation truth.

Templates in this directory are **scaffolds**, not governing decisions. A copied and approved artifact becomes authoritative only within the role defined by the Gu OS Development Methodology.

## Available templates

| Template | Use | Governing artifact role |
|---|---|---|
| [`feature-business-spec-template.md`](feature-business-spec-template.md) | Consequential user/business behavior, workflow/case behavior, permissions/authority behavior, or other functionality whose implementation must not invent product decisions. | The resulting approved Feature / Business Spec owns intended behavior. |
| [`slice-plan-template.md`](slice-plan-template.md) | A Roadmap Increment whose approved behavior/architecture must be delivered as ordered, independently verifiable increments that humans plan and close with evidence. | The resulting Slice Plan owns the durable Slice contracts and their order. |

Additional PRD, Initiative Brief, ADR, Technical Plan, Verification, and Playbook templates may be added when there is a concrete need. Do not create templates merely to increase document count.

## What owns what

Before copying anything, be clear which truth the new document would own (Methodology §4, §4.1):

| Concept | Required? | Owns |
|---|---|---|
| Product Intent / PRD | Yes, per product | Why the product exists, for whom, and what it deliberately is not. |
| Product Roadmap / Roadmap Increment | Yes where sequencing is consequential | What should be proven next and why now, and the **graduation evidence** that closes the increment. |
| Product Area / Product Responsibility | **Optional** | A durable product/business responsibility, when a product benefits from organizing work that way. Gu OS maps this to its Operating Domains; another product may use capabilities, bounded contexts, journeys, value streams, modules or services instead. |
| Initiative (+ Initiative Brief) | **Optional** | A bounded, temporary coordination frame around a concrete outcome. |
| Feature / Business Spec | Yes for consequential behavior; not for tiny/local work already governed | Intended behavior, at capability scope. |
| Slice Plan | Yes for planned, evidence-closed work | The durable Slice contracts and their order, integrated for one Roadmap Increment. |

**An Initiative is not a Product Area / Product Responsibility**, not a Roadmap Increment and not a Spec — and it is not a mandatory layer. There is no `Product Area → Roadmap Increment → Initiative → Spec → Slice` chain. An Initiative is optional because **a Roadmap Increment already provides sufficient bounded strategic framing** for Specs, ADRs, Technical Plans and Slice planning; add one only when it represents a coordinated outcome the increment does not already represent — for example several distinct coordinated efforts inside one large increment, or one bounded effort spanning several Product Areas. **A Spec does not require a separate Initiative**; create it directly under product and roadmap context. Do not create a document — or a directory — merely because a template exists.

**Depth stays proportional.** A Roadmap Increment is for strategically sequenced, evidence-gated product evolution — not for a typo, a tiny refactor, a small local repair, incident response, maintenance or an unambiguous regression fix. Those execute under existing governing context. See Methodology §18.

**Place artifacts by the repository's documentation architecture, and connect them by links — not by adjacency.** Physical colocation of Specs, Technical Plans and Slice Plans is **not** a methodology requirement. It is often convenient, but artifacts with different lifetimes may legitimately live in different places: an enduring behavior Spec and an increment-specific plan are not obliged to share a directory.

**Paths in this README are current Gu OS examples**, not universal methodology structure, and a directory name is **not** evidence of an artifact's semantic type. `docs/product/initiatives/relationship-operations/` currently holds artifacts for the Relationship Operations **Operating Domain** and the `R1` **Roadmap Increment** inside it — not a bounded Initiative. That path predates the clarified taxonomy and is documentation debt pending reconciliation; the method requires no particular filesystem hierarchy.

## How to use the Feature / Business Spec template

1. Copy `feature-business-spec-template.md` to wherever the repository's current documentation architecture places behavior contracts, and **link it to its governing and related artifacts**. Physical colocation with plans is *not* a methodology requirement.
2. Rename it for the capability. Current Gu OS example path — an example, not prescribed structure:
   `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`.
3. Keep the filename normally unversioned. Use the document `Version` field plus Git history for routine evolution.
4. Remove sections that are genuinely irrelevant rather than filling them with boilerplate.
5. Add detail in proportion to business consequence, ambiguity, model judgment, authority, security, and failure cost.
6. Resolve product behavior in the Spec; record structural questions for Architecture Analysis / ADR; leave implementation mechanics to the Technical Plan.
7. Define acceptance scenarios before or alongside implementation planning.

## How to use the Slice Plan template

1. Copy `slice-plan-template.md` in as `slice-plan.md`, placed according to the repository's current documentation architecture, and **link it to the artifacts that govern it**. Current Gu OS example path — an example, not prescribed structure:
   `docs/product/initiatives/relationship-operations/slice-plan.md` — which serves the `R1` Roadmap Increment.
2. **Keep one Slice Plan per Roadmap Increment** (or per bounded Initiative where one is genuinely the coordinated delivery unit). Do **not** create one per Spec, per ADR, per Architecture Analysis or per Technical Plan: one Slice is often governed by several of those at once, and dependencies, priority, the READY Horizon and Cycle planning need a single integrated view.
3. Fill Slice contracts using rolling wave: the near-term Slices in full, later Slices at stub level. Detailed Tasks are never written here — the coding agent derives them at execution time.
4. Maintain the **READY Horizon** (Methodology §10.5): keep enough elaborated READY work ahead of execution — roughly one to two Cycles of plausible capacity as an operating default — so work does not stall between Slices or Cycles. The horizon is **capacity-based, not a Slice count**, and replenishing it is the development system's proactive job, not a question the human should have to raise.
5. Elaborate readiness without inventing unresolved product or architecture decisions, and never lower the Definition of Ready to widen the horizon. Only **READY** Slices are eligible for Execution Cycle planning.
6. Reference governing acceptance scenarios by their Spec identifiers (`AC-*`, `EC-*`, `HP-*`). Do not restate Spec behavior.
7. Declare Release Scope at readiness, not at completion.
8. Keep the Slice Plan free of execution state. It carries **readiness**, never execution stage: the agent runtime owns Tasks and pre-PR execution, and GitHub owns branch/commit/PR/CI/merge/Actions state.
9. Record the confirmed Accountable / DRI in the transitional execution register, not in the durable Slice contract — a Slice can be READY before anyone is assigned.
10. Remember that closing every Slice is not the same claim as graduating the Roadmap Increment; graduation evidence belongs to the Roadmap (Methodology §17.2).

## Relationship to Agile / backlog work

A Feature / Business Spec is a **behavioral contract**, not a backlog item. It is **capability-sized**: the word "Feature" describes the kind of truth it owns, not the size of an increment.

One Spec may:
- correspond roughly to one product Feature;
- cover behavior that later decomposes into several Stories / Enabler Stories / vertical slices;
- or define a cross-cutting behavioral contract used by more than one implementation slice.

The implementation backlog is derived later from approved behavior and architecture:

`Spec → Architecture / ADR → Technical Plan → Slice Plan → Implementation → Verification`

This chain is **not** a mandatory hierarchy of product units. A Roadmap Increment may pull work from several responsibilities and shared capabilities; one Spec may be proved across several Slices; one Slice may prove parts of more than one Spec (Methodology §4.1).

| Artifact | Owns |
|---|---|
| Spec | Intended behavior, at capability scope. |
| Slice | A bounded, independently verifiable increment that proves part of one or more governing Specs, **or** establishes a required enabling / operational contract under an ADR, architecture source, Technical Plan, invariant or prerequisite capability. The unit humans plan — analogous in spirit to a Story or Enabler, with evidence discipline attached. |
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
- Rolling-wave planning includes **proactive READY-Horizon replenishment**, not only deferral of far work.
- Optional concepts stay optional: a template's existence is never a reason to create the document.
- A template should reduce ambiguity, not create bureaucracy.
- Templates are **scaffolds, never a parallel authority**. The approved artifact owns its truth; this directory owns none of it.
