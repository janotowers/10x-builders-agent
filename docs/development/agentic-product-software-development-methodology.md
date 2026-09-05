# Gu OS Agentic Product & Software Development Methodology

> **Version:** v0.4.0  
> **Status:** Canonical development methodology  
> **Scope:** Tool-agnostic, product-portable operating method for humans + coding agents  
> **Intended repo path:** `docs/development/agentic-product-software-development-methodology.md`

*Repository grounding: janotowers/10x-builders-agent, GitHub main snapshot 49d5f176f744fa67021b5874e2c4d0c43a5cbc96, including the tracked app-scoped agent instruction files apps/web/AGENTS.md and apps/web/CLAUDE.md. External methodological references: Lab10 structured vibecoding guide, Lab10 Spec-Driven Development guide, and current Cursor / Claude Code instruction-system documentation. This document adapts external practices only where they align with Gu OS repo-native architecture, governance and verification.*

*Current-state correction (v0.4.0): that grounding snapshot is historical. The repository now also tracks a **root `AGENTS.md`** repo-wide operating contract and a **root `CLAUDE.md`** adapter containing `@AGENTS.md`, alongside the app-scoped `apps/web/` pair. Statements below about root agent files reflect this current reality; aligning the existing root contract with the v0.4.0 Development Continuity Loop is a named follow-up (Sections 11.2, 22, 23).*

| **Core idea.** Humans own intent, consequential decisions and acceptable risk. Coding agents may execute broadly inside an approved scope, but product intent, specifications, architecture decisions, verification evidence and release authority remain explicit, versioned and reviewable. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Purpose, scope and non-goals

This document defines how Ungga should design and build Gu OS with AI coding agents. It is not a product PRD, not the Principles & Design Doctrine, not a collection of templates, and not a Claude Code manual. Its job is to define the development lifecycle, the artifact architecture, the ownership of each kind of truth, the human-agent collaboration model and the evidence required to move from idea to production.

It deliberately separates three concerns that are easy to blur: product intent, intended behavior, and implementation. A PRD can be excellent while a feature Spec is incomplete; a Spec can be correct while an implementation plan is wrong; code can pass unit tests while failing the business contract. The methodology exists to keep those layers connected without collapsing them.

| **Three-document model.** This Methodology explains HOW we work. The canonical Principles & Design Doctrine explains WHAT rules guide decisions. The Development Templates / Playbooks package provides practical authoring scaffolds as they are adopted; the canonical Feature / Business Spec template now lives at `docs/development/templates/feature-business-spec-template.md`. The actual Gu / Gu OS PRD is a product artifact created under this methodology, not part of the methodology itself. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 1.1 Portability: a generic operating method with concrete examples

The method described here is intended to be **tool-agnostic and product-portable**. It is developed, proven and continuously corrected against Gu OS, but Gu OS is its **proving ground, not its definition**. Another product should be able to adopt this methodology without adopting Gu OS's product organization, runtime concepts or repository layout.

| **Layer**                    | **Portability rule**                                                                                                                                                                                                                                                          |
|------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Generic methodology concepts | Product Intent, Roadmap Increment, Feature / Business Spec, architecture decision, Technical Plan, Vertical Slice, Definition of Ready, READY Horizon, Execution Cycle, Release Scope, verification evidence, owning-artifact repair and the Development Continuity Loop. These travel to any product. |
| Optional organizing concepts | Product Area / Product Responsibility and Initiative (Section 4.1). Useful when a product benefits from them; never mandatory, and never a required filesystem shape.                                                                                                            |
| Gu OS-specific mapping       | Operating Domains, Cases, Work Plane, Skills / Tools, Brain, the organization model and paths such as `docs/product/initiatives/...`. These are **concrete examples of how Gu OS applies the method**, not requirements the method imposes.                                       |
| Tooling                      | **Specific tools and providers are replaceable within their respective roles** — which are distinct, not interchangeable with each other. Another SCM/CI platform could fill GitHub's role; another coding environment could fill the current agent runtime's role; another planning/projection surface could implement the future control-plane role. Changing a provider does not change the authority boundaries of Section 19.1, and does not merge the roles those boundaries separate. |

| **Reading rule.** Where this document names a Gu OS concept, read it as an example. Where it names a generic concept, read it as the method. A product with no Operating Domains, no Cases and a completely different repository layout can still run Roadmap Increments, Specs, Slices, a READY Horizon, Execution Cycles and the Development Continuity Loop unchanged. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 2. Source hierarchy used to build this methodology

The methodology is grounded first in Gu OS repo-native practice, then enriched by external guides. External sources are pedagogical/reference inputs, not architecture authorities.

| **Source**                                                   | **Contribution**                                                                                                                                                                                                                                                                        | **Authority in this methodology**                                                           |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Repo-native: docs/README.md                                  | Defines documentation authority: current code/migrations + architecture.md for implemented behavior; integrated architecture manual; topic-specific canonical plans; roadmaps; reference/historical material. It explicitly keeps brief.md and plan.md as historical/reference context. | Governing context                                                                           |
| Repo-native: Flexible Workflows Technical Plan               | Explicitly targets a spec-driven workflow lifecycle, failure classification, evidence-gated verification, versioned definitions, governed publication and shared runtime primitives.                                                                                                    | Governing target design                                                                     |
| Repo-native: Flexible Workflows Detailed Implementation Plan | Translates governing design into phases/slices/tasks and states that implementation must not silently redesign when contradictions appear.                                                                                                                                              | Execution discipline                                                                        |
| Repo-native: ai-native-loops.md                              | Defines Observe -\> Decide -\> Act -\> Evaluate -\> Learn -\> Repeat; safe change path; DRI; evidence, canary and rollback; workflow lifecycle from specs/definitions/scenarios to fork/new version.                                                                                    | Governed improvement model                                                                  |
| Repo-native: Operational readiness/testing framework         | Readiness validates reproducible business contracts, not merely absence of exceptions; N0-N5 gives progressive evidence.                                                                                                                                                                | Verification model                                                                          |
| Repo-native: ADR system                                      | ADRs hold cross-cutting decisions that should not remain buried in long plans; plans keep implementation detail.                                                                                                                                                                        | Decision governance                                                                         |
| External: Lab10 structured vibecoding guide                  | PRD as persistent product context; DESIGN.md; concise repo operating instructions; inspect before inventing; vertical slices; build/verify/checkpoint.                                                                                                                                  | Adopt/adapt                                                                                 |
| External: Lab10 Spec-Driven Development                      | Clarify -\> Spec -\> Plan -\> Execute/Verify; human approval at the specification boundary; agent autonomy after clear approved intent.                                                                                                                                                 | Adopt/adapt                                                                                 |
| Repo-native: apps/web/AGENTS.md + apps/web/CLAUDE.md         | Tracked app-scoped agent instruction layer. apps/web/AGENTS.md carries Next.js/web operational guidance; apps/web/CLAUDE.md imports @AGENTS.md to avoid duplication.                                                                                                                    | Canonical adapter for apps/web scope; not a monorepo-wide contract                          |
| Historical reference: .cursor/rules/forma_de_trabajo.mdc     | Useful prior operating rules: tool/skill discovery, do not invent commands, root-cause debugging, verification evidence, proportional test rigor, documentation sync, defense in depth and implementation-vs-verification separation.                                                   | Reference / adapt only; stack, paths and normative documents are from an older mini-project |
| Current Cursor / Claude Code instruction systems             | Cursor: AGENTS.md and .cursor/rules/\*.mdc; Claude Code: CLAUDE.md, imports, .claude/rules/\*.md, skills and hooks. Both treat instruction files as context; hard guarantees require deterministic enforcement.                                                                         | External product mechanics; not Gu OS design authority                                      |

# 3. The methodology at a glance

The lifecycle is intentionally longer than the external four-step Spec-Driven Development loop because Gu OS has multi-tenant security, durable business state, integrations, architecture invariants, governed releases and a growing documentation system. The external loop remains visible inside a richer Gu OS operating model.

<table style="width:100%;">
<colgroup>
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Discover /<br />
Clarify</strong></th>
<th><strong>Product Intent /<br />
PRD</strong></th>
<th><strong>Initiative Brief<br />
(if useful)</strong></th>
<th><strong>Feature /<br />
Business Spec</strong></th>
<th><strong>Architecture /<br />
ADR</strong></th>
<th><strong>Implementation Spec /<br />
Technical Plan</strong></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

<table style="width:100%;">
<colgroup>
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Tasks /<br />
Vertical Slices</strong></th>
<th><strong>Implement</strong></th>
<th><strong>Verify /<br />
Classify / Repair</strong></th>
<th><strong>Review /<br />
Approve</strong></th>
<th><strong>Release<br />
Safely</strong></th>
<th><strong>Observe /<br />
Learn / Evolve</strong></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

This is not a waterfall. Artifacts can be revised when evidence reveals a contradiction. The key discipline is that the correction goes to the artifact that owns the defect, rather than letting implementation silently become the new truth.

**Where the planning layer sits.** The chain above says which artifacts exist. The **Vertical Slice** is where humans plan against it: Slices are prioritized, sized, made ready and planned into a short **Execution Cycle** (Section 12.1), after which the coding agent derives Tasks just in time and executes autonomously inside approved scope. Planning a Slice into a Cycle schedules already-approved work; it adds no approval gate to the chain.

**Where strategic sequencing sits.** The chain says what gets built; the **Product Roadmap** decides *what should be proven next and why now*. A **Roadmap Increment** (Section 4.1) pulls work from one or more product responsibilities, shared capabilities, Specs and Slices, and declares the graduation evidence that shows the increment achieved its intent. Slice completion is not increment graduation (Sections 4.1, 17.2).

**The chain is traversed continuously, not once per human prompt.** Section 12.3 defines the **Development Continuity Loop**: the development system observes development state, identifies the next legitimate action anywhere in this chain, acts inside approved authority, verifies, reassesses and continues — stopping only at a genuine human-authority boundary.

# 4. Artifact architecture: which document owns which truth?

The methodology treats documentation as an architecture of responsibilities. Multiple documents are useful only when each owns a different question. A document that has no distinct ownership role should usually be merged, linked or retired.

| **Truth owned**             | **Primary artifact / system**                                  | **Question it owns**                                                                                                                          |
|-----------------------------|----------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Product truth               | Product Intent / PRD                                           | Why does the product exist, for whom, what problem/outcome matters, what strategy/principles/scope guide decisions?                           |
| Strategic sequencing truth  | Product Roadmap / Roadmap Increment                            | What should be proven next and why now, what must exist before that proof is credible, what **graduation evidence** closes the increment, and what is deliberately deferred? |
| Initiative framing          | Initiative Brief (optional)                                    | Why should this bounded initiative exist now, what outcome and constraints define it, and is deeper specification justified?                  |
| Behavior truth              | Feature / Business Spec                                        | Exactly what must the feature/capability do and not do, including happy/unhappy paths, business contracts and acceptance scenarios?           |
| Architecture decision truth | Architecture Analysis + ADR                                    | What boundaries/trade-offs matter and what consequential design choice was accepted/rejected?                                                 |
| Implementation intent       | Implementation Spec / Technical Plan                           | How will the approved behavior/architecture be realized in this system?                                                                       |
| Slice contract truth        | Slice Plan (`slice-plan.md`) — normally one per Roadmap Increment | Which bounded increments prove the approved behavior, in what order, and for each: inspectable outcome, acceptance contract, Definition of Done, Release Scope and readiness? |
| Execution work in progress  | Agent runtime / coding environment                             | What ordered Tasks realize a planned Slice, and where has implementation and local verification actually got to before a PR exists? Derived at execution time; not canonical Markdown truth. |
| Recorded execution state    | GitHub                                                         | Branch, commits, PR, CI results, merge state, Actions runs, environment approvals, and the deployment evidence GitHub itself generates. |
| Implemented reality         | Code, schemas, migrations, configuration                       | What actually runs now? Implemented reality can invalidate an outdated plan but cannot silently redefine product intent or accepted behavior. |
| Verification truth          | Tests, evals, replay/simulation, readiness, evidence           | What evidence proves the implementation satisfies the Spec and invariants?                                                                    |
| Release truth               | Release record / flags / migration state / canary evidence     | What was released, where, under what controls, and how can it be rolled back?                                                                 |
| Outcome / learning truth    | Telemetry, incidents, business outcomes, improvement proposals | Did the change create the intended outcome, and what artifact should be changed next?                                                         |

| **Important analogy.** Gu OS already separates Case state, case_facts, transactional systems of record and Business Brain because different kinds of truth need different owners. Development documentation should follow the same discipline: PRD, Spec, ADR, Plan, Code and Tests are related, but they are not interchangeable sources of truth. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 4.1 Planning taxonomy: generic concepts and their Gu OS mapping

The table above says which artifact owns which truth. This subsection says how the **units of product and planning** relate — and, deliberately, how loosely. There is **no mandatory hierarchy** here: the relationships are many-to-many wherever the product justifies it.

| **Concept**                           | **Generic meaning**                                                                                                                                                        | **Required?**                                     | **Gu OS mapping (example, not requirement)**                                                                          |
|---------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| Product Area / Product Responsibility | A durable product or business responsibility, when a product benefits from organizing intent and work that way.                                                            | **Optional.** No universal decomposition model.    | The PRD's **Operating Domains**: Property, Demand, Relationship, Transaction and Network / Ecosystem Operations.           |
| Shared / Core capability              | A capability consumed across several responsibilities, increments or initiatives. It **may** have its own user-facing or administrative surfaces; what matters is that its cross-cutting role does not by itself make it a peer Product Area. | Optional; recognized where it exists.              | Organization / tenancy / identity, Cases, Work Plane, Skills / Tools, governance / authority, memory / context, Brain.     |
| Roadmap Increment                     | A temporary, strategically sequenced, evidence-gated increment: what should be proven next, why now, what must exist first, and what graduation evidence closes it.         | Yes for strategically sequenced product evolution; **not** for proportional local work (Section 18). | The roadmap's R-numbered horizons — for example `R1 — Relationship Operations v1` and its declared graduation evidence.    |
| Initiative                            | A bounded, temporary coordination frame around a concrete outcome, potentially coordinating several Specs, architecture decisions, Technical Plans and Slices.              | **Optional and bounded.** Only when it adds framing a Roadmap Increment does not already provide. | **No distinct Initiative layer is currently in use.** The `docs/product/initiatives/…` path predates this taxonomy and is naming debt, not evidence of type (see below). |
| Feature / Business Spec               | The governing contract for intended consequential behavior (Section 7).                                                                                                    | Yes for consequential behavior; not for tiny/local work whose behavior is already governed and unambiguous (Section 18). | The approved R1 Specs.                                                                                                    |
| Vertical Slice                        | The bounded, independently verifiable planning and execution increment humans plan at (Section 10).                                                                        | Yes for planned, sequenced, evidence-closed work; proportional under Section 18. | The Slices in the R1 Slice Plan.                                                                                          |

**Not a hierarchy.** A Roadmap Increment may pull work from several Product Areas and Shared capabilities; one Spec may be proved across several Slices and more than one increment; one Slice may prove parts of more than one Spec. Do not force a 1:1 chain from responsibility to increment to initiative to Spec to Slice.

**Three questions that are easy to conflate:**

| **Artifact**      | **Question it answers**                                             |
|-------------------|-----------------------------------------------------------------------|
| Spec              | What behavior must be true?                                          |
| Slice             | What bounded increment do we build and prove now?                    |
| Roadmap Increment | What strategically meaningful result are we trying to demonstrate?   |

| **All planned Slices being Done does not by itself make the Roadmap Increment complete.** A Slice closes against its own acceptance contract and declared Release Scope; an increment graduates against the evidence the roadmap declared for it. Emptying a backlog is not proof of an outcome. Graduation evaluation is Section 17.2. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

### Why Initiative is optional

This is **not** the methodology:

```text
Product Area -> Roadmap Increment -> Initiative -> Spec -> Slice
```

There is no such mandatory chain. An Initiative is optional because **a Roadmap Increment already provides sufficient bounded strategic framing** for Specs, Architecture Analyses and ADRs, Technical Plans and Slice planning. Inserting an Initiative between them adds a layer without adding a decision.

A bounded Initiative earns its place only when it represents a coordinated outcome the Roadmap Increment does not already represent adequately. It **may** add value when:

- one large Roadmap Increment contains several distinct coordinated efforts worth governing separately;
- one bounded effort spans several Product Areas / Product Responsibilities;
- several Specs or plans share an intermediate outcome worth governing independently.

Otherwise, create the Spec directly under product and roadmap context. **Do not create an Initiative as a mandatory container**, and do not create one merely to justify an existing directory name.

Preserved: Initiative ≠ Product Area / Product Responsibility; Initiative ≠ Roadmap Increment; Initiative ≠ Feature / Business Spec; Initiative is not mandatory.

### Reading the Gu OS mapping

Gu OS Operating Domains are enduring business-semantic responsibilities and one concrete application of the generic Product Area idea. They are **not** a methodology requirement for other products, and they are **not** independent Gu OS runtime engines — they reuse one shared operating core. A different product may decompose by capabilities, bounded contexts, customer journeys, value streams, modules or services and use every concept above unchanged (Section 1.1).

Shared / Core capabilities are **not** peer Operating Domains. Organization / tenancy / identity is the clearest case: it is consumed across Relationship, Property, Demand and Transaction Operations, it has real administrative surfaces of its own, and it is still not a sixth domain beside them. An increment may legitimately pull the minimum organization foundation it needs without that foundation becoming a Product Area.

| **Current naming debt, stated explicitly.** **Relationship Operations is an Operating Domain** — an enduring product responsibility named as such by the Product PRD and by its own framing document — and **`R1 — Relationship Operations v1` is a Roadmap Increment within it**. Its artifacts nonetheless live under `docs/product/initiatives/relationship-operations/`, a path that predates this taxonomy. **That path is documentation debt; it is not evidence that Relationship Operations is a bounded Initiative.** Do not infer semantic type from a directory name. Reconciling the layout is a named follow-up (Sections 22, 23) and no path is renamed by this version. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 5. Product Intent / PRD

The PRD is the durable product-context artifact. It should let a human or coding agent understand the product well enough to make aligned decisions across many sessions without re-discovering the fundamental problem every time. It is not a screen specification and it is not a technical plan.

| **Field**          | **Methodology rule**                                                                                                                                                                                                                                               |
|--------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Purpose            | Preserve why the product exists, for whom, the outcome/value thesis, strategy, product principles, major use cases, scope boundaries and success measures.                                                                                                         |
| Owner              | Product leadership / founders. AI may interview, synthesize and draft; humans approve product intent and unresolved assumptions.                                                                                                                                   |
| Required?          | Yes for Gu / Gu OS as a product. A new major product line or materially independent product may require its own PRD.                                                                                                                                               |
| Should contain     | Problem/evidence; target users/ICP; vision; strategy/positioning; product principles; value proposition; major journeys/use cases; scope/non-goals; roadmap framing; functional themes; relevant NFRs; success metrics; open questions; links to deeper artifacts. |
| Should not contain | Table schemas, endpoint-by-endpoint implementation, detailed component code, migration steps, exhaustive UI pixel specs, or architecture choices better owned by ADRs/plans.                                                                                       |
| Change cadence     | Low to moderate. Product-learning changes it; routine implementation should not.                                                                                                                                                                                   |
| Exit criterion     | A competent reviewer can explain why Gu/Gu OS exists, what outcome it promises, who it serves, what it intentionally does not become, and which product principles constrain lower-level decisions.                                                                |

The external Vibecoding guide is useful here: it treats PRD as persistent context across sessions and recommends problem, user, vision, strategy, principles, value proposition, key use cases, MVP/scope, non-goals, happy/unhappy paths, acceptance criteria, metrics, open questions and links. Gu OS should adapt this rather than copy it mechanically. Detailed material should move to linked documents so the PRD remains readable.

# 6. Initiative Brief: a lightweight bridge, not a second PRD

An Initiative Brief is optional. It exists to prevent two opposite failures: creating a full PRD for every small initiative, or jumping from an informal idea straight into a Feature Spec before the business purpose is understood.

| **Question**       | **Rule**                                                                                                                                                                                                                  |
|--------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Use it when        | A bounded initiative is meaningful enough to justify discovery but not yet mature enough for a full Spec; several related features share one outcome; the initiative needs prioritization/approval before technical work. |
| Do not use it when | The change is a small, well-understood maintenance task; the parent PRD and existing Spec already frame the work; or the initiative is itself the whole product and belongs in the PRD.                                   |
| Minimum content    | Problem/opportunity; user/stakeholder; desired outcome; why now; scope/non-goals; constraints; evidence; dependencies; open questions; parent PRD link; decision on next artifact.                                        |
| Exit paths         | Stop/reject; continue discovery; create/update Product PRD; create Feature/Business Spec; open Architecture Analysis/ADR if the main uncertainty is structural.                                                           |

**An Initiative is a bounded coordination frame, not a product layer.** Per Section 4.1 it is not a Product Area / Product Responsibility, not a Roadmap Increment and not a Feature / Business Spec. When the surrounding product and roadmap context already frame the work adequately, create the Spec directly and skip the Brief. Do not create an Initiative — or an Initiative directory — merely because the template exists.

| **Current brief.md.** The existing docs/brief.md should be treated as historical/provenance material during the later documentation audit. The current docs/README.md already classifies brief.md and plan.md as historical/reference. This Methodology does not yet decide whether to rename/archive/move them; that is the next documentation-architecture audit. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 7. Feature / Business Spec: source of intended behavior

For consequential non-trivial work, the Feature / Business Spec is the governing contract for intended behavior. It sits below product intent and above architecture/implementation. A coding agent should be able to derive an implementation plan from it without having to invent product behavior.

| **Field**            | **Methodology rule**                                                                                                                                                                                                                                                                                     |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Purpose              | Close ambiguity about what the capability must do and not do from the user/business perspective.                                                                                                                                                                                                         |
| Owner                | Product/domain owner with engineering participation. AI may interrogate ambiguities and draft. Human approval is the normal high-leverage gate.                                                                                                                                                          |
| Required?            | Yes for consequential feature behavior, workflow/case behavior, data contracts with business semantics, user-visible state machines, permissions/authority changes, or changes whose failure would be costly.                                                                                            |
| Core content         | Summary; user/business objective; actors; preconditions; strict scope and non-goals; expected behavior; happy paths; unhappy paths; state/decision rules; data/evidence requirements; permissions/human involvement; acceptance scenarios; verification expectations; open questions; links to PRD/ADRs. |
| What it does not own | Detailed file list, migration order, specific function signatures unless they are part of an external contract, or incidental implementation decisions.                                                                                                                                                  |
| Exit criterion       | Behavior is coherent, testable, compatible with known invariants and sufficiently explicit that implementation alternatives can be compared without changing what the feature means.                                                                                                                     |

| **Spec-driven means behavior-driven, not bureaucracy.** A Spec should be proportional to risk and ambiguity. The goal is not to produce more Markdown; it is to prevent a coding agent from silently resolving product questions inside implementation. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 7.1 Granularity: a Spec is not a backlog unit

The word "Feature" in the artifact name describes the *kind* of truth owned, not the *size* of the increment. A Feature / Business Spec is a **behavioral contract and may be capability-sized**. It is not necessarily an Agile Feature, a User Story, or a backlog item, and a single Spec may govern behavior that is realized through several Vertical Slices.

| **Artifact** | **Owns**                                                                                          |
|--------------|---------------------------------------------------------------------------------------------------|
| Spec         | The intended behavior — what the capability must do and not do, at capability scope.               |
| Slice        | A bounded increment that proves part of that behavior, or a required enabling capability.          |
| Task         | The implementation steps that realize one Slice, derived just in time by the coding agent.         |

Consequences:

- Do not force a 1:1 mapping between a Spec, a Slice and a unit of planning.
- Do not wait for an entire large Spec to be implemented before meaningful behavior can be verified. Each Slice declares the subset of governing behavior it proves (Section 10.1).
- Do not restate Spec behavior inside a Slice contract. The Slice references the governing acceptance scenarios; the Spec remains their owner.

The current artifact name is retained. A future rename such as *Business Behavior Spec* remains deliberately deferred (Section 22); this Methodology resolves the ambiguity by rule rather than by renaming approved artifacts.

**Canonical authoring template:** [`templates/feature-business-spec-template.md`](templates/feature-business-spec-template.md). The template is a scaffold, not a second source of truth: the copied and approved Spec owns intended behavior. Sections may be omitted when genuinely irrelevant; detail remains proportional to consequence, ambiguity and risk.

# 8. Architecture Analysis and ADRs

Architecture Analysis explores a design space when the problem is not yet a single decision. An ADR records a consequential decision once the trade-off is understood. The repo already uses both patterns: long topic plans/analyses retain detail, while ADRs capture cross-cutting decisions that should not remain buried.

| **Artifact**          | **Rule**                                                                                                                                                                                                                                 |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Architecture Analysis | Use for multi-dimensional problems, uncertain boundaries, alternatives comparison, repo evidence, risks and staged recommendations. It can conclude that no new architecture is needed.                                                  |
| ADR                   | Use for a specific consequential decision with context, decision, alternatives/rejections, consequences, status and reevaluation trigger.                                                                                                |
| When not needed       | Routine implementation choices that do not create a durable constraint; local refactors with no cross-cutting consequence; choices already governed by a canonical ADR/plan.                                                             |
| Human role            | Approve material trade-offs and accepted direction. AI can perform repo inspection, alternative analysis and contradiction detection but must not silently convert an inference into accepted architecture.                              |
| Relationship to Spec  | A Spec defines intended behavior. Architecture may discover that the behavior is unsafe/impossible/underspecified; the Spec can then be revised explicitly. Architecture never silently changes product behavior through implementation. |

# 9. Implementation Spec / Technical Plan

The Technical Plan is the bridge from approved behavior/architecture into implementation. In Gu OS practice, it should translate governing sources rather than redesign them. If implementation reveals a material contradiction, the contradiction is surfaced and the owning artifact is revisited.

| **Field**          | **Methodology rule**                                                                                                                                                                                                                |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Inputs             | Approved Spec; relevant PRD/Brief; current repo reality; accepted ADRs/topic architecture; security/tenancy constraints; existing migrations/APIs/tests.                                                                            |
| Content            | Technical approach; affected components/files; schemas/migrations; contracts/interfaces; compatibility/brownfield strategy; flags; observability; security; test/eval plan; rollback; sequencing; known assumptions/open decisions. |
| Status discipline  | Explicitly label current/implemented, accepted target, tentative design, assumptions and human decisions. Do not present proposed schema as implemented behavior.                                                                   |
| Exit criterion     | The implementation can be decomposed into ordered, independently verifiable slices without requiring each coding session to re-decide architecture.                                                                                 |
| Contradiction rule | Implementation evidence may invalidate the Plan. Record the contradiction; fix Plan/ADR/Spec as appropriate. Do not let code become an undocumented design fork.                                                                    |

**Boundary with the Slice Plan.** The Technical Plan owns technical design, governing technical decisions and implementation sequencing. It may carry a **concise slice index** — identifier, title, governing decisions, dependencies, one-line intent — so the sequencing logic stays readable. It does **not** own the detailed Slice contracts: acceptance traceability, Slice Acceptance Contract, Definition of Done / evidence, Release Scope, estimates or readiness belong to the Slice Plan (Section 10). Avoid duplicated, competing Definition-of-Done or scope definitions across the two artifacts; where both mention a Slice, the Slice Plan is the detail owner and the Technical Plan links to it.

# 10. Vertical slices and Tasks

**The Vertical Slice is the primary unit of human planning; the Task is the unit of agent execution.** Humans prioritize, assess readiness, plan and hold accountability at Slice level. Coding agents decompose a Slice into Tasks at execution time. In planning spirit a Slice is analogous to a User Story, Technical Story, Architecture Story or Enabler — with explicit evidence discipline attached.

**What governs a Slice.** For consequential product behavior the normal relationship is:

```text
Feature / Business Spec -> one or more Vertical Slices
```

But not every valid Slice traces directly to a Feature / Business Spec. An **enabling** Slice may instead be governed by an ADR, an architecture source, the Technical Plan, an invariant or a prerequisite capability, when what it establishes is an independently verifiable enabling contract. The precise general rule:

| **A Slice is a bounded, independently verifiable increment that proves part of one or more governing Specs, *or* establishes a required enabling / operational contract under the appropriate governing artifact.** Do not manufacture a fake product Spec to give purely enabling work something to point at; point it at the artifact that actually governs it (Sections 10.1, 15). |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

A Slice already carries its own bounded outcome through its contract — inspectable outcome, governing traceability, Slice Acceptance Contract, Definition of Done, dependencies, Release Scope, estimate and readiness (Section 10.1). **No further concept above the Slice is introduced** to bound work; a document-organization problem is not a reason to invent a planning layer.

Tasks are execution units, not miniature Specs. The preferred shape is a vertical slice: a small end-to-end increment that can demonstrate a real contract and produce evidence. Horizontal plumbing is acceptable when it is itself a prerequisite contract, but broad layers with no demonstrable behavior should be treated cautiously.

**Rolling wave / progressive elaboration.** Future Slices may exist at contract level — enough to sequence, size and prioritize them — while detailed Tasks are created near execution time. Defining every Task for every future Slice up front is waste: the repository, the dependencies and the evidence available all change before the work starts. Rolling wave is **maintained proactively, not merely consumed**: Section 10.5 defines the READY Horizon and the readiness replenishment that keeps the near horizon from running dry.

| **Aspect**             | **Rule**                                                                                                                                                                                                                                                                  |
|------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A good slice has       | One objective; declared dependencies; bounded files/components; implementation work; tests/evidence; flag/compatibility impact; security impact; Definition of Done; rollback/checkpoint.                                                                                 |
| A bad slice looks like | “Build backend,” “finish UI,” “add AI,” or a large task that cannot be verified until ten other layers land.                                                                                                                                                              |
| Ordering               | Work top-to-bottom unless dependencies allow parallelization. Parallel work should be isolated enough to avoid conflicting ownership of the same contracts/files.                                                                                                         |
| Checkpointing          | Implement -\> verify -\> checkpoint -\> continue is a useful playbook pattern, not a universal law. Use small commits/checkpoints when they improve review, rollback and agent context.                                                                                   |
| Agent autonomy         | Once the slice is bounded and governing artifacts are approved, a coding agent may implement broadly, inspect the repo and repair local defects without asking for line-by-line permission. It must not cross the approved scope or silently redefine governing behavior. |

## 10.1 The durable Slice contract

Each non-trivial Slice has a durable contract recorded in a Slice Plan. The contract exists to make the Slice plannable, traceable, autonomously executable and verifiable — not to restate the Spec or pre-empt implementation.

**What a Slice Plan aggregates.** A Slice Plan is the **integrated** planning artifact holding the ordered Slices needed to realize a coherent delivery effort. For consequential roadmap-driven product work the default is:

| **A Slice Plan normally integrates the Slices required to realize one Roadmap Increment.** When a bounded Initiative is genuinely used as the coordinated delivery unit — inside or across increments — it may justify its own Slice Plan instead. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

Do **not** normally create a separate Slice Plan per Spec, per ADR, per Architecture Analysis or per Technical Plan. Those artifacts **govern** individual Slices through traceability; they do not partition the execution backlog. The reason is practical: one Slice is often governed by several Specs, ADRs and technical decisions at once, and dependencies, priority, the READY Horizon and Cycle planning all need a single integrated view of what is being built next.

```text
R1 — Relationship Operations v1          (Roadmap Increment)
  ├── Spec S1 · S2 · S3 · S4             (govern behavior)
  ├── Architecture Analysis / ADRs       (govern structure)
  ├── Technical Plan                     (governs realization)
  └── Slice Plan                         (integrates execution)
       ├── SL-1
       ├── SL-2
       └── ...
```

Each Slice carries the specific traceability that governs *it* — which may be one Spec, several Specs, or an ADR / invariant / prerequisite capability for enabling work (Section 10).

**How multiple increments inside one enduring Product Area should be represented physically** — one Slice Plan per increment, a successor document, an archived section — is a documentation-architecture question deliberately deferred to the follow-up reconciliation (Sections 22, 23). Semantically, though, a Slice Plan serving a Roadmap Increment is scoped to **that increment**; it is not a perpetual list of every Slice its Product Area will ever have.

| **Element**                        | **What it must answer**                                                                                                                                                          |
|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Slice ID / title                   | How is this Slice referred to across the Slice Plan, PRs and evidence?                                                                                                            |
| Type                               | Behavior, enabling capability, operational infrastructure, or repair (below).                                                                                                     |
| Inspectable outcome / value        | What observable business, user, system or enabling capability is true when this Slice is complete?                                                                                |
| Governing behavior / traceability  | Which Spec(s), acceptance scenarios, ADR(s), technical decisions or invariants govern this increment?                                                                             |
| Slice Acceptance Contract          | What must be demonstrably true for this increment specifically, and by what evidence type?                                                                                        |
| Dependencies                       | What must already be satisfied, and which prerequisites are still outstanding?                                                                                                     |
| Definition of Done / evidence      | What evidence closes this Slice, beyond the initiative's shared baseline?                                                                                                          |
| Release Scope                      | RS-1 / RS-2 / RS-3 (Section 14.2) — the Done boundary this Slice claims.                                                                                                          |
| Estimate                           | Elapsed agent-assisted engineering time to evidence-ready (Section 10.4).                                                                                                          |
| Estimate confidence / uncertainty  | High / Medium / Low, plus the driver of the uncertainty where useful.                                                                                                             |
| Material risk                      | Security, tenancy, authority, data, external-effect, flag/compatibility and rollback impact. *None* is a valid answer; silence is not.                                             |
| Readiness                          | The Definition of Ready result (Section 10.2) and any blocking gap.                                                                                                                |

**Type.** A minimal vocabulary, deliberately not a taxonomy:

| **Type**                   | **Meaning**                                                                                                                             |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| Behavior                   | Proves part of an approved Spec's intended behavior.                                                                                    |
| Enabling capability        | A prerequisite contract other Slices depend on; it is itself independently verifiable. This is the disciplined form of "horizontal plumbing" the table above allows. |
| Operational infrastructure | Development, verification, delivery or observability capability rather than product behavior.                                            |
| Repair                     | Correction of a defect whose owning artifact has been classified (Section 15).                                                          |

**Inspectable outcome.** State in one concise form what will be observably true. Avoid implementation-only outcomes such as "create tables" or "implement service layer" **unless that technical capability is itself the independently verifiable enabling contract** — in which case say what it guarantees, not what it constructs.

**Acceptance traceability.** Where the governing Spec already carries identifiers such as `AC-*`, `EC-*` or `HP-*`, use those identifiers. A Slice normally proves a **subset**, and identifying that subset is what allows meaningful behavior to be verified without waiting for a whole Spec to be implemented. A Slice may additionally carry **slice-local assertions** required to prove the increment. For enabling Slices with no direct user/business acceptance scenario, traceability points instead to the governing ADR, technical decision, invariant or prerequisite capability. Do not duplicate the Spec inside the Slice Plan.

**Slice Acceptance Contract.** A concise statement of the inspectable outcome, the relevant governing acceptance scenarios, the relevant happy path, the relevant unhappy paths and edge cases, and any slice-local assertions. Each item names an appropriate **evidence type** — deterministic test, contract test, integration test, eval, replay/simulation, hosted verification, or source/operational evidence — without prescribing implementation detail prematurely.

**Proportionality.** A Slice contract should normally stay close to one screen in spirit. There is no hard page limit: high-risk security, tenancy, authority or migration evidence can legitimately need more. Unusual length is a **granularity signal** — check whether the Slice should be split — not a formatting violation. Tiny or local work does not need a Slice contract at all unless consequence or risk justifies one (Section 18).

## 10.2 Definition of Ready

Definition of Ready is a **readiness condition** of a Slice, not a workflow column and not an approval gate. It answers one question about the Slice itself: is it sufficiently defined, governed, testable, estimable and dependency-classified to be **eligible for Cycle planning**?

Proportionally to the Slice's consequence, a Slice is **READY** when:

- governing behavior / architectural intent is sufficiently approved;
- no unresolved consequential product question exists inside the Slice scope;
- the Slice Acceptance Contract is stated and testable;
- the required evidence can be produced — or creating the verification capability is explicitly part of the Slice;
- Release Scope is declared;
- security / tenancy / authority / data / external-effect impact has been assessed;
- estimate and estimate confidence are recorded;
- dependencies satisfy the rule below.

**Readiness is a property of the Slice, not of the team.** A Slice may be READY before anyone has been assigned to it: the human Accountable / DRI is confirmed when the Slice becomes `Planned`, not when it becomes ready (Section 12.1). Requiring an assignment for readiness would make a well-specified Slice look unready merely because nobody has picked it up yet.

**Dependencies.**

| **Case** | **Dependency situation**                                                                                                                                                          | **Effect**                                                                     |
|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| A        | Satisfied.                                                                                                                                                                        | READY.                                                                          |
| B        | Controlled by our team, with a **concrete prerequisite contract** and sufficient confidence that it can be satisfied before the dependent Slice starts.                            | MAY be READY. Cycle planning must then **sequence the prerequisite before** the dependent Slice. **Not EXECUTABLE** until actually satisfied. |
| C        | Unresolved and outside our control.                                                                                                                                               | NOT READY.                                                                      |

There is deliberately no generic "planned but externally blocked" exception: case C is simply not ready.

**Case B is a readiness test, not a scheduling fact.** What readiness asks of a case-B dependency is only that it is ours and that its prerequisite is concrete enough to be satisfied deliberately — not that it has already been scheduled. Requiring it to be "planned in the same Cycle" would be circular, because readiness is what makes a Slice eligible for Cycle planning in the first place. The scheduling obligation is real, but it belongs to Cycle planning (Section 12.1), and it is the reason a case-B Slice can be READY yet never silently start before its prerequisite lands.

"Concrete" means the prerequisite can be stated as a bounded contract — what must exist, at what scope, and who provides it — without executing the dependent Slice to find out. A prerequisite whose shape can only be discovered by running the Slice that depends on it is not concrete, and the Slice is not READY.

**READY is not PLANNED, and PLANNED is not necessarily EXECUTABLE.** Readiness makes a Slice eligible for a Cycle; planning puts it in one and confirms its Accountable; executability additionally requires that prerequisites are actually satisfied and capacity is available. See Section 12.1.

**Not required for READY:** an assigned Accountable / DRI, detailed Tasks, an exact file list, an exact migration number, a branch name, or a commit structure. The first is a planning-time concern (Section 12.1); the rest are execution-time concerns (Section 10.3).

**Maintaining readiness is an ongoing activity.** How much READY work should exist ahead of execution, and whose responsibility it is to replenish it, is Section 10.5. The readiness bar defined above is unchanged by that, and is never lowered in order to widen the horizon.

## 10.3 Just-in-time Task planning

JIT Task planning is the **first execution activity** after a Slice is READY, PLANNED and EXECUTABLE — not before. This is the rolling-wave boundary.

The coding agent produces a concise **visible execution plan** before substantial implementation. *Visible does not mean separately approved*: Section 12 keeps Tasks and code edits outside routine human approval. The plan normally identifies:

- ordered Tasks and their dependencies;
- expected repository areas / files;
- the verification instruments to create and run;
- migration impact, if any;
- flag / compatibility impact;
- assumptions being proceeded under;
- known blockers.

**Task-level estimates are not a required human planning artifact.** An agent may use them internally. The calibration and planning target is the Slice, not the Task.

**JIT Tasks do not become canonical Markdown truth.** Their expected homes are the agent runtime / coding session, the PR body where useful, and the commit sequence where appropriate (Section 19).

## 10.4 Slice estimation

The initial estimation concept is **elapsed agent-assisted engineering time to evidence-ready**.

- Do **not** estimate historical manual coding time.
- Do **not** assume a productivity multiplier such as "10x".
- Do **not** introduce Story Points yet.

Use simple ranges — for example `≤ 0.5 day`, `~1 day`, `1–2 days`, `2–3 days`, `3–5 days` — together with an estimate confidence of High / Medium / Low and a concise uncertainty driver where useful.

**An estimate is a planning signal, not evidence.** It never contributes to a Definition of Done, and it is never presented as a measured result. Calibration of estimate bias and variance is handled empirically in Section 17.1.

## 10.5 READY Horizon and readiness replenishment

Rolling-wave planning (Section 10) says later work may stay coarse. It does not say the near horizon may run dry. The **READY Horizon** is the amount of sufficiently elaborated READY work maintained *ahead of* current execution, so that development does not stall unnecessarily between Slices or between Cycles.

**Initial operating default: roughly one to two Execution Cycles of plausible READY capacity.** This is an operational starting point — **not a methodology invariant, and not a mandatory number of Slices**. Adapt it from evidence: empirical throughput (Section 17.1), dependency uncertainty, Slice size, roadmap volatility, and actual human and agent capacity.

**The horizon is capacity-oriented, not count-oriented.** Three small READY Slices may represent less horizon than one large READY Slice. Never express the target as "always keep N Slices ready".

**READY remains an attribute of the Slice** (Section 10.2), not a live execution stage and not an approval. Widening the horizon changes how much work has been elaborated; it changes nothing about authority.

### Readiness replenishment

Maintaining the horizon is the development system's own work, not a question the human should have to think to ask. When the horizon is thin or thinning, replenishment:

- inspects current Roadmap Increment priority and the graduation evidence it declares;
- inspects governing dependencies and their classification (Section 10.2);
- inspects existing Slice stubs and candidate increments;
- elaborates near-term work far enough to genuinely test the Definition of Ready;
- moves a Slice to READY **only when the existing Definition of Ready is actually satisfied**;
- leaves later or uncertain work as stubs when further elaboration would depend on learning that does not exist yet;
- creates no premature Tasks — Task planning stays where Section 10.3 puts it;
- invents no consequential product, architecture, security or risk decision.

**When readiness cannot be reached, that is not a dead end.** Identify the artifact that owns the missing decision, progress everything that can legitimately be progressed without human authority, and surface the **smallest precise human decision** required — not a generic "blocked" (Sections 12.3, 15).

**Do not make every future Slice READY for completeness.** Premature elaboration of far work is exactly the waste rolling-wave planning exists to avoid. An over-elaborated horizon is as much a planning failure as an empty one.

# 11. Cross-cutting context artifacts: Design and repo operating instructions

Not every artifact belongs in the linear PRD -\> Spec -\> Plan chain. Some provide persistent context across many initiatives and should be linked rather than duplicated.

| **Cross-cutting artifact**                                                                                  | **Methodology role**                                                                                                                                                                                                                                                                                                                                                                                                           |
|-------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Experience / DESIGN.md-equivalent                                                                           | When UI/UX is material, preserve product interaction principles, design system/tokens, component patterns, accessibility, states and explicit do/don’t guidance. It complements, not replaces, PRD or Feature Specs. Dynamic/contextual UI must still obey the same experience doctrine.                                                                                                                                       |
| Portable root agent contract (AGENTS.md + CLAUDE.md adapter)                                                | Keep a short, stable and tool-portable root contract: authority map, repo discovery rules, verified commands, safety boundaries, development-method expectations and links to canonical docs. AGENTS.md is the preferred shared source when supported; Claude Code can import it from CLAUDE.md and append only Claude-specific instructions. Do not duplicate the full Methodology, PRD or architecture in always-on context. |
| Path-scoped IDE / agent rules (.cursor/rules/\*.mdc; .claude/rules/\*.md; nested AGENTS.md where supported) | Use for rules that matter only in a code area or file class: security/tenancy, database migrations, workflow runtime, UI/UX, docs/ADRs, testing/evals. Scope them so irrelevant instructions do not consume every agent context. Cursor .mdc adds metadata such as alwaysApply/globs; Claude rules use Markdown with optional paths frontmatter.                                                                               |
| Skills / playbooks for coding agents                                                                        | Use for multi-step reusable procedure: how to discover a feature, prepare a Spec, inspect migrations, debug a regression, verify an agentic behavior or review security. A Skill/playbook is procedure, not product truth, and should load on demand rather than live permanently in always-on instructions.                                                                                                                   |
| Hooks / automated checks                                                                                    | Use when an action or prohibition must reliably happen rather than merely be remembered in prose: tests, lint/type-check, migration validators, policy scans, permission checks, schema validation, CI, release gates and tool-use hooks. Instruction files guide model behavior; deterministic controls enforce guarantees.                                                                                                   |

## 11.1 The four-layer agent instruction architecture

The Methodology should not be copied wholesale into every coding-agent prompt. The operating architecture is layered so that stable knowledge remains authoritative, agents receive only the instructions they need, procedures are invoked when relevant, and hard guarantees are enforced outside model judgment.

| **Layer**                        | **Examples**                                                                           | **Primary purpose**                                                                                            | **Strength**                                                  |
|----------------------------------|----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|
| 1\. Canonical knowledge          | PRD, Principles & Design Doctrine, this Methodology, architecture manuals, Specs, ADRs | Own durable product/design/development truth. Rich enough for humans and agents to inspect when needed.        | Authoritative knowledge; not automatically loaded in full     |
| 2\. Agent operating instructions | Root AGENTS.md, CLAUDE.md adapter, path-scoped Cursor/Claude rules                     | Tell coding agents the small set of rules/context they must hold while working in the repo or a specific area. | Prompt/context guidance; high influence, not hard enforcement |
| 3\. Skills / Playbooks           | Spec preparation, debugging, migration review, verification, release checklist         | Encode reusable multi-step procedures that should load only when the task requires them.                       | Procedural guidance / orchestration                           |
| 4\. Deterministic enforcement    | Tests, linters, type-check, CI, validators, hooks, permission/policy gates             | Make critical guarantees mechanically checkable or block prohibited actions.                                   | Hardest enforcement available                                 |

| **Design rule.** Do not solve a hard-enforcement problem with a longer prompt. If a requirement must never be violated, prefer a validator, test, hook, policy or runtime guard. Use agent instructions to steer judgment and workflow, not as the sole security boundary. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 11.2 Current Gu OS root-agent files: what exists and what it means

The repository tracks **both layers of the pattern this section previously only recommended**:

- **`AGENTS.md`** at the repository root — the repo-wide coding-agent operating contract: authority map, repo-discovery rules, artifact chain, architecture and security boundaries, verified commands, verification discipline, documentation synchronization, and human gates versus agent autonomy.
- **`CLAUDE.md`** at the repository root — the Claude adapter, containing only `@AGENTS.md`.
- **`apps/web/AGENTS.md`** — scoped web instructions: a Next.js compatibility warning plus operational-case/tool-provisioning pointers.
- **`apps/web/CLAUDE.md`** — the app-scoped Claude adapter, also containing only `@AGENTS.md`.

This is the intended layering: monorepo-wide rules at root, web-specific context beside the web app, and each tool adapter importing the shared contract rather than duplicating it.

| **Current item**                                                   | **Assessment**                                                                                                            | **Recommended evolution**                                                                                                                                                                                 |
|--------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| apps/web/AGENTS.md: Next.js breaking-change warning                | Valuable: it corrects model-training staleness and directs the agent to repo-local framework documentation before coding. | Keep in apps/web. Its scope is correct because it applies to the Next.js web application rather than the whole monorepo.                                                                                  |
| apps/web/AGENTS.md: Operational cases & tool provisioning pointers | Useful and concrete, but narrower than a root-wide operating contract.                                                    | Keep app-scoped. During the documentation audit, verify whether every pointer is still current and whether any deeper procedure should move to a Skill/playbook instead of expanding this always-on file. |
| apps/web/CLAUDE.md = @AGENTS.md                                    | Excellent anti-duplication adapter for Claude Code.                                                                       | Keep this anti-duplication adapter. Claude-specific content should be added only if it cannot live in the shared apps/web contract.                                                                       |
| Root AGENTS.md                                                     | Exists and is tracked. Carries genuinely monorepo-wide rules and links to canonical docs rather than duplicating them — the intended shape for layer 2 above. | Keep concise and stable. **Open follow-up:** its artifact-chain and planning wording still reflects the pre-v0.4.0 model and should be aligned with Sections 4.1, 10.5, 12.3 and 12.4. Not changed by this version. |
| Root CLAUDE.md = @AGENTS.md                                        | Exists and is tracked. Same anti-duplication adapter pattern as the app-scoped pair.                                       | Keep. Claude-specific content only where it genuinely cannot live in the shared root contract.                                                                                                            |
| Scope / hierarchy                                                  | Both layers now exist: root AGENTS.md + CLAUDE.md for monorepo-wide rules, apps/web/AGENTS.md + CLAUDE.md for web scope.  | Preserve the separation. Do not move web-specific content to root, and do not restate root-wide rules in the app-scoped files. Add further nested files only where a directory has genuinely different semantics. |

## 11.3 What should be always-on for coding agents

The old forma_de_trabajo.mdc contains several rules worth carrying forward, but in updated, tool-agnostic wording. The root always-on contract should stay concise; detailed domain rules belong in scoped rules or Skills.

| **Always-on candidate**        | **Updated Gu OS wording**                                                                                                                                                                                                                       |
|--------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Authority and source discovery | Before changing consequential behavior, identify the governing PRD/Spec/architecture/ADR/plan and current implemented reality. Do not silently choose among contradictory sources.                                                              |
| Inspect before inventing       | Inspect the repo, package scripts, existing patterns, available tools and Skills before planning. Do not invent commands, APIs, files, migrations or capabilities that can be verified.                                                         |
| Spec/plan discipline           | For consequential non-trivial work, implementation follows approved intended behavior and relevant architecture/plan. If implementation evidence contradicts them, surface and reconcile the owning artifact; do not silently redesign in code. |
| Security / tenancy             | Respect tenant isolation, authorization, evidence and side-effect boundaries. Prompt instructions are not a substitute for deterministic controls.                                                                                              |
| Verification before done       | Do not claim completion without evidence proportional to risk. State explicitly what was run, what passed/failed and what could not be verified.                                                                                                |
| Root-cause debugging           | For bugs, reproduce and isolate before patching; classify the owning artifact; make the smallest justified repair; add regression evidence.                                                                                                     |
| Documentation synchronization  | When a change modifies a governing contract, architecture decision or operational control, update the owning document/ADR/Spec in the same change or explicitly record why not.                                                                 |
| Abstraction discipline         | Prefer simplicity and stable semantic reuse. Do not apply DRY mechanically: duplicated syntax is cheaper than the wrong abstraction across different business/security semantics.                                                               |

## 11.4 Test-first, eval-first and verification independence

The older Cursor rule used TDD proportional to risk. The underlying idea survives, but Gu OS should generalize it beyond classic unit-test TDD because part of the system is model-mediated.

| **Behavior type**                         | **Preferred pre-implementation evidence**                                                                                           | **Examples**                                                                                                                       |
|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| Deterministic invariant / regression      | Test-first when practical: write a failing test or reproducible fixture before the fix.                                             | Tenant isolation, permission gates, workflow transition invariants, deterministic validators, financial formulas, reproduced bugs. |
| Model-mediated behavior                   | Eval/scenario-first: define representative prompts/states, expected rubric/outcomes and failure cases before tuning/implementation. | Intent classification, semantic extraction, qualitative synthesis, model routing.                                                  |
| Product / workflow behavior               | Acceptance-scenario-first: state observable happy/unhappy paths before implementation.                                              | Case lifecycle, human decision flows, cross-channel behavior, Studio authoring.                                                    |
| Minor UI/copy with no consequential logic | Lightweight verification proportional to impact.                                                                                    | Copy, spacing, non-critical presentation changes.                                                                                  |

| **Independent verification pattern.** For high-risk changes, prefer verification that is sufficiently independent of the implementer: deterministic tests/CI, a separate reviewer or human, or an isolated verification-agent pass. This is a development-process pattern, not a requirement to build Gu OS as a multi-agent product. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

**Writing the required tests is part of implementation, not a separate permission.** When a slice's approved Definition of Done names verification — unit, integration, contract, workflow/eval/replay, E2E, security, migration or other proportional evidence — creating, updating and running it falls inside the coding agent's autonomous scope. An implementation that omits the evidence its DoD requires is incomplete, not merely untested.

## 11.5 Four verification layers

Verification happens at four distinct levels. They answer different questions and must not be collapsed into one another; in particular, a later layer never substitutes for an earlier one.

| **Layer**              | **Runs against**                        | **Answers**                                                        |
|------------------------|-----------------------------------------|--------------------------------------------------------------------|
| Local tests            | the developer's / agent's machine        | Does the implementation behave as intended while building?         |
| CI                     | a clean, disposable environment          | Is it deterministically correct independent of any one machine?    |
| Hosted verification    | a real hosted environment (e.g. staging) | Does the deployed system behave in a real project?                 |
| Post-release           | production, after a release              | Did the release do what was expected, and is it safe to widen?     |

The deterministic suites remain the release-gating evidence. Hosted and post-release verification add environment-specific evidence — schema/migration state, deployed security invariants, contract and pilot evidence a slice's DoD requires — that a disposable CI environment cannot establish.

Destructive verification is bound to the layer it was designed for. A suite that rebuilds a database from scratch belongs to CI and local use and must never be pointed at a hosted environment.

Tool- and environment-specific execution detail for these layers lives in the operational playbook ([`release-path-playbook.md`](release-path-playbook.md)), not in this methodology.

# 12. Human + coding-agent operating model

The methodology is designed for strong agent autonomy without collapsing human authority. The human role shifts upward from typing code toward product intent, specification quality, architecture trade-offs, risk acceptance and outcome review. This does not mean humans disappear from implementation; it means human attention is concentrated where judgment and accountability have the highest leverage.

**Mapping note.** The artifact-ownership table in Section 4 and the operating-model table below are not intended to map 1:1. Section 4 separates artifacts because they own different kinds of truth; this table highlights collaboration and human gates. A distinct artifact does not automatically create a distinct human approval checkpoint.

| **Stage**               | **Agent/human collaboration**                                                                                             | **Primary human gate**                                     |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| Discover / clarify      | Human leads intent and evidence; agent interviews, researches repo/context, identifies contradictions and drafts options. | Human confirms problem framing.                            |
| PRD / Brief             | Agent can synthesize; human owns product truth, strategy and non-goals.                                                   | Human approval.                                            |
| Roadmap sequencing      | Agent maintains evidence about what is proven, what remains and what blocks the next increment, and can synthesize evidence-backed sequencing options; humans own strategic sequencing and the graduation evidence an increment must satisfy. | Product-leadership decision. |
| Feature / Business Spec | Agent drafts/test-challenges; human/domain owner resolves ambiguous behavior and risk.                                    | Human approval for consequential scope.                    |
| Architecture / ADR      | Agent inspects repo and compares alternatives; humans accept durable trade-offs.                                          | Architecture/product approval proportional to consequence. |
| Technical Plan          | Agent can derive plan; engineering owner reviews feasibility, security, compatibility and rollback.                       | Plan approval when risk/size warrants.                     |
| Tasks / Vertical Slices | Agent decomposes the approved Plan into bounded, ordered, independently verifiable execution units; human/engineering owner reviews when decomposition materially changes scope, risk, dependencies or release strategy. | No separate approval by default; review proportional to consequence. |
| Execution Cycle planning | System/agent proposes READY Slices for the upcoming Cycle from roadmap priority, dependencies, capacity, estimates, risk and continuity, and may propose an Accountable; human/team confirms inclusion, **confirms the Accountable / DRI** and makes any planning adjustment. | Planning confirmation. **Not an additional approval gate** — see 12.1. |
| Task decomposition (JIT) | Agent derives ordered Tasks once the Slice is Ready, Planned and Executable, and publishes a visible execution plan before substantial implementation. | Visible, not approved. |
| Implementation          | Agent can write/refactor/test within bounded scope; humans may pair/review hotspots.                                      | No routine approval for every edit.                        |
| Verification            | Agent runs tests/evals/replay/readiness and gathers evidence; humans review failures, risk and business acceptance.       | Evidence gate.                                             |
| Release                 | Agent may prepare release/canary/rollback steps; authorized human/system policy controls consequential release.           | Release authority.                                         |
| Observe / learn         | Agent mines incidents/outcomes and proposes changes; humans govern promotion/policy/code changes.                         | Governed improvement.                                      |
| Increment graduation    | Agent evaluates the declared graduation evidence and identifies what is missing, proposing legitimate additional Slices or evidence work already inside approved intent. Where the evidence is unambiguously satisfied and the next increment is already governed, work continues without a new approval. | **Only** when criteria must change, evidence is ambiguous/disputed, or opening the next increment changes strategy, priority or accepted risk — see 17.2. |

## 12.1 Execution Cycle and human accountability

An **Execution Cycle** is a short, tool-agnostic planning time box, analogous in spirit to a Scrum Sprint. Approximately one week is a reasonable operational starting point; **the length is not a methodology invariant** and should be revised from evidence.

The Execution Cycle is a short-horizon *planning container*. It does **not** replace product roadmap sequencing, architecture dependencies, evidence gates or release authority.

**How a Cycle is formed.** The system or agent may propose READY Slices for the upcoming Cycle based on roadmap priority, dependencies, capacity, estimates, risk and continuity of work in progress, and may propose an Accountable / DRI for each. The human or team then reviews the proposed Cycle.

**Cycle proposal is proactive.** The proposal should be formed when the situation calls for it, rather than waiting to be requested. Typical triggers:

- the current Cycle is approaching its planning boundary;
- remaining Planned or Executable work is insufficient for expected capacity;
- enough READY capacity exists to form the next meaningful proposal (Section 10.5);
- a material replanning boundary has been reached — a dependency changed, an estimate became materially invalid, or increment scope moved;
- current work completes earlier than expected and capacity opens.

These are judgment triggers, **not rigid clock-only rules**. Whatever prompts the proposal, the human or team still confirms Cycle inclusion and the confirmed human Accountable / DRI — and **no additional human approval is introduced after a Planned Slice becomes Executable**.

**Cycle planning owns dependency sequencing.** When a Slice carrying a case-B dependency (Section 10.2) is confirmed into a Cycle, planning must **explicitly sequence the prerequisite before** the dependent Slice — as its own **READY** Slice when the prerequisite itself warrants Slice treatment under Section 18, otherwise as named prerequisite / setup / coordination work. Which of the two applies is decided by proportionality, not by whether the prerequisite happens to be engineering work: a small configuration or provisioning step does not become a Slice merely because someone has to build or configure something. What is never allowed is leaving the prerequisite implicit. This is where the "planned before it" obligation lives: readiness establishes that the prerequisite is ours and concrete, planning decides when it happens. Scheduling is not approval, so this adds no gate.

| **Status**   | **Meaning**                                                                                                                                     |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `Proposed`   | A READY Slice proposed for the upcoming Execution Cycle. An Accountable / DRI may be *suggested* here, but is not yet confirmed.                 |
| `Planned`    | Human/team-confirmed as part of the Execution Cycle, **including a confirmed human Accountable / DRI**.                                          |
| `Executable` | A **derived condition**: Planned (therefore with a confirmed Accountable), required prerequisites actually satisfied, and execution/WIP capacity available. Normally a condition, not a workflow column. |

The confirmation step determines which Slices are included, who is Accountable, and any explicit planning adjustment. After it, autonomous execution resumes: **a Planned Slice may start automatically once it becomes Executable, and no further routine human approval is required before Agent Planning.**

**A Slice must not become Executable or enter Agent Planning without a confirmed Accountable / DRI.** This is not an extra approval of the work — the work was already approved upstream — it is the guarantee that autonomous execution always has a named human who will answer an escalation, coordinate an external dependency and carry the Slice to its Done boundary. Readiness carries no such requirement (Section 10.2): a Slice can be well specified long before anyone is assigned to it.

| **Selecting a Slice into an Execution Cycle schedules already-approved work. Cycle planning is not an additional approval gate.** It does not re-approve product behavior, architecture, Slice scope, agent Tasks or code edits. The human authority boundaries defined in Section 12 and in the repository operating contract remain intact and unchanged. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

The term `commit` / `committed` is deliberately **not** used for Slice planning status: it collides with its Git meaning and implies an immutable delivery promise that cycle planning does not make.

**Human Accountable / DRI is not the AI execution actor.** Every non-trivial Slice has one confirmed human Accountable **before it executes**, even when one person currently fills several roles. Assignment happens at planning time, not at readiness time, and it never transfers accountability to the agent that does the work.

| **Role**                 | **Responsible for**                                                                                                                                                                                                                     |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Human Accountable / DRI  | Outcome; escalation response; coordination of external dependencies; participation in consequential decisions; ensuring the Slice reaches its governed Done boundary.                                                                     |
| AI / coding agent        | Inspecting; planning Tasks; implementing; refactoring; creating required tests; running tests; diagnosing; repairing; branching; committing; pushing; creating and updating PRs; responding to CI failures; gathering verification evidence — inside approved scope and repository policy. |

The Accountable is **not** redefined as a line-by-line code approver.

**When execution must return to human planning.** These are the existing agent-autonomy and escalation principles, consolidated rather than replaced. Human re-planning or decision is required when execution discovers:

- a genuine contradiction between governing sources;
- a missing consequential product decision;
- a missing consequential architecture decision;
- that intended behavior would materially change;
- that architecture or domain boundaries would materially change;
- that a security / tenancy / authority boundary would change;
- that external-effect authority would increase;
- that release strategy or accepted risk would materially change;
- that an assumed dependency is not actually available;
- non-convergence after bounded repair attempts (Section 15);
- an explicit human or release authority gate;
- that the Slice estimate has become materially invalid.

For estimate invalidation, roughly **2× the upper estimate bound** is a documented initial practical trigger, not a rigid invariant. The purpose is to surface material planning failure, not to interrupt execution for ordinary variance.

## 12.2 Slice execution-state model

The following is a **conceptual** model of how a Slice progresses. It describes stages of work, not a mandatory board layout.

```text
Backlog                        (a Slice becomes READY here — no assignment yet)
  -> This Cycle / To Do        (Proposed -> Planned + confirmed Accountable / DRI)
  -> Agent Planning            (entered when the Slice becomes Executable)
  -> Implementing
  -> Local Verify / Repair
  -> PR / CI / Merge
  -> Hosted Verify             (RS-2 and RS-3 only)
  -> Release / Post-release    (RS-3 only)
  -> Done
```

- `READY` is an attribute of the Slice (Section 10.2), not a stage: it is what makes a Slice eligible to be proposed for a Cycle.
- `Proposed` and `Planned` are planning statuses **inside** This Cycle / To Do. The Accountable / DRI may be suggested at `Proposed` and is confirmed at `Planned`.
- `Executable` is normally a derived condition, not a column: it is what allows a Planned Slice — which therefore already has a confirmed Accountable — to enter Agent Planning without further approval.
- The stages a Slice actually traverses depend on its declared **Release Scope** (Section 14.2). An RS-1 Slice is Done after `PR / CI / Merge`; it makes no hosted claim and does not pass through the later stages.
- This model does **not** require every state to become a physical column in any future board.
- Git commits are events/metadata, not workflow states. Branch creation is likewise an event, not necessarily a column.

**Orthogonal flags, not linear columns:** `Blocked`, `Needs Human Attention`, `Expedite`. A Slice keeps its actual execution stage while any of these flags is active.

**This vocabulary is scoped exclusively to Slice execution.** Do not reuse it for document status, roadmap increment status, architecture/capability status or doctrine status — each of those already has its own vocabulary, and conflating them would make status statements ambiguous.

Progressing through `Local Verify`, `PR / CI / Merge` and `Hosted Verify` is *progress through* the verification layers of Section 11.5. A state model never substitutes for a layer: reaching a later state does not retire the evidence owed to an earlier one.

## 12.3 The Development Continuity Loop

The operating model above defines *who decides what*. This subsection defines *what happens next* — specifically, what the development system does when the current piece of work ends.

| **Core principle.** The development agent/system must not limit itself to executing the current work item. It should keep the development system advancing to the next legitimate action until it reaches a real human-authority boundary. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

The behavior this replaces:

```text
finish current Task / Slice -> stop -> wait for a human to ask "what next?"
```

The behavior it defines:

```text
observe development state
  -> identify the next legitimate work
  -> act within authority
  -> verify
  -> reassess
  -> continue
  -> stop or escalate only at a genuine human-authority boundary
```

**Autonomy here means continuity, not expanded authority.** Continuing legitimate work without unnecessary human prompting is the point. Silently making a consequential product, architecture, security, risk, economic, dependency-contract or release-authority decision is not, and never becomes acceptable merely because the loop would otherwise stall. Every escalation boundary in Section 12, Section 12.4, Section 16 and the repository operating contract remains intact and unchanged.

### Decision policy

The loop continuously reassesses development state and selects the next legitimate action. The cases below are a policy to match against, not a sequence to run top to bottom.

| **State observed**                                                       | **Next legitimate action**                                                                                                                                                                                                                                                                                                                                                                                     |
|--------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **A. Executable work exists** — one or more Planned Slices are Executable. | Select valid work by current Cycle sequencing, dependencies, priority and WIP/capacity; perform JIT Task planning (Section 10.3); execute autonomously inside approved scope. **No additional routine human approval is required.**                                                                                                                                                                             |
| **B. Planned work exists but is not Executable.**                        | Determine *why*. If the unsatisfied prerequisite is team-controlled, already governed or approved, and within execution authority — advance and satisfy it. If it requires human action, an external party, new authority or a consequential decision — surface the exact blocker and the exact intervention required. **Do not simply stop with a generic "blocked".**                                            |
| **C. The next Execution Cycle needs to be formed.**                      | Proactively prepare a Cycle proposal from READY Slices using roadmap priority, dependencies, capacity, estimates, risk and continuity of work in progress (Section 12.1); a human Accountable / DRI may be proposed. The human or team confirms inclusion, the Accountable and any legitimate planning adjustment. This is planning confirmation, **not re-approval** of already-governed behavior or architecture. |
| **D. The READY Horizon is insufficient.**                                | Perform readiness replenishment (Section 10.5) — proactively, rather than only after current work is exhausted.                                                                                                                                                                                                                                                                                                 |
| **E. A Slice cannot become READY.**                                      | Identify why, and move **upward to the artifact that owns the gap**: Feature / Business Spec, Architecture Analysis / ADR, Technical Plan, Roadmap / Roadmap Increment, Initiative Brief where one actually exists, or Product Intent where genuinely necessary. Progress everything that can legitimately be progressed without human authority. **A NOT READY Slice must not become a passive dead end.**          |
| **F. Current and planned Slices for a Roadmap Increment are exhausted.** | Evaluate the increment's declared graduation evidence (Section 17.2). **Do not assume backlog empty = increment graduated.**                                                                                                                                                                                                                                                                                    |
| **G. Graduation evidence is not satisfied.**                             | Identify what is missing: additional verification/evidence only; another Slice inside already-approved intent; Spec refinement; an architecture change; a new product decision; external/business validation; or release/outcome evidence. Propose or create the legitimate additional work when it sits inside approved governing intent; route it to the appropriate human-governed artifact when it requires a consequential product, architecture or risk decision. **Never quietly rewrite the increment's graduation criteria in order to declare success.** |
| **H. The Roadmap Increment graduates.**                                  | Where the declared evidence is unambiguously satisfied and the next increment is already governed, **no new approval is required** to recognize that (Section 17.2): record the evaluation, inspect the next governed increment, and begin preparing the next legitimate development work. Do not become idle. Criteria changes, ambiguous evidence, and anything that would shift strategy, priority or accepted risk go to product leadership. |
| **I. The next Roadmap Increment is insufficiently specified.**           | Progress discovery, framing, Specs, architecture and planning as far as authority allows. The human should not have to initiate every preparatory step manually.                                                                                                                                                                                                                                                |
| **J. The roadmap itself has no sufficiently governed next increment.**   | Do **not** remain silently idle, and do **not** invent product strategy. Inspect available product evidence, outcomes, unresolved roadmap questions and governing Product Intent; synthesize evidence-backed options; explain the trade-offs; request the precise product-leadership decision required. **This is a legitimate human-authority boundary.**                                                        |

### The stopping condition

A development agent should not stop merely because its current Task, Slice or Execution Cycle is exhausted. It should determine whether the next legitimate action is execution, prerequisite work, verification, repair, READY replenishment, a Cycle proposal, Spec or architecture refinement, Roadmap Increment graduation evaluation, next-increment preparation, or human escalation.

| **The stopping condition is not "my current work item ended". It is "the next meaningful action crosses a genuine human-authority boundary, or no legitimate progress is currently possible."** |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

**Proportionality still applies.** The loop is not a mandate to generate speculative documentation. When future intent is genuinely unknown, the correct next action is case J — surface evidence-backed options and ask — not to elaborate Specs and Slices for work nobody has decided to do. Producing plausible-looking artifacts for undecided intent is a failure of this loop, not a fulfilment of it.

## 12.4 Planning authority does not override governing dependencies

Human planning authority is real: humans reprioritize, resequence and decide what is worked on next. What an **informal planning request cannot do** is silently invalidate a governing dependency, a Slice contract, an approved Spec, an accepted architecture decision, a security or tenancy boundary, or accepted risk.

**Worked case.** A human asks to schedule Slice X before Slice Y, but X's governing contract currently depends on Y.

The wrong response is a mechanical "OK". The correct response is to:

1. surface the conflict explicitly;
2. name the governing artifact and the specific dependency;
3. explain why the requested ordering is not currently valid;
4. present the valid alternatives;
5. route any actual change of the dependency or contract to the artifact that owns it.

Valid alternatives typically include: preserve the current ordering; revise the governing dependency through the process that owns it; split a genuinely independent increment out of X into its own Slice; or revisit the architecture if the dependency is no longer justified.

**Human authority is preserved, not bypassed.** The human may well decide to change the governing contract — that is their call. The requirement is that the change happens **explicitly, at the layer that owns it**, rather than as an invisible side effect of a scheduling request.

| **Planning schedules approved work; it does not rewrite governing truth.** This is Section 12.1's "scheduling is not approval" read from the other direction: because Cycle planning approves nothing, it also cannot un-approve, reorder around, or quietly relax what was approved elsewhere. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 13. Model judgment vs deterministic engineering in development

The same repo-native boundary used inside Gu OS applies while building Gu OS. Use models where semantic understanding, synthesis, ambiguity resolution and adaptation matter; use deterministic mechanisms where repeatability, authorization and mechanically testable guarantees matter.

| **Development area**   | **Model-appropriate**                                                                   | **Deterministic-appropriate**                                                                                     |
|------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Requirements discovery | Model excels: ask contextual questions, surface contradictions, synthesize user intent. | Deterministic checklists can ensure required sections are not forgotten.                                          |
| Spec lint / schema     | Model can critique coherence and edge cases.                                            | Machine-check frontmatter/schema/required fields/links/version IDs.                                               |
| Architecture analysis  | Model can compare trade-offs and inspect broad context.                                 | Security invariants, tenancy rules, schema constraints and dependency checks remain explicit.                     |
| Code generation        | Model can implement and refactor.                                                       | Compiler, type system, tests, linters, migrations, permissions and release controls determine admissibility.      |
| Verification           | Model judge can assist qualitative evaluation.                                          | Mechanical postconditions/tests/evidence take precedence wherever available.                                      |
| Anti-pattern           | Growing regex/dictionary/rule forests trying to imitate semantic understanding.         | Opposite anti-pattern: using an LLM for stable calculations, permissions, hard gates or deterministic transforms. |

# 14. Verification: evidence before completion

A coding agent saying “done” is not evidence. Verification must be proportional to the contract and risk. Gu OS already has a strong readiness culture: the testing framework states that operational readiness validates reproducible business contracts, not simply whether a tool throws an exception.

| **Evidence layer**                        | **What it proves**                                                                                                 | **Use**                                                             |
|-------------------------------------------|--------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
| Level 0 - Static / local                  | Type-check, lint, schema validation, formatting, pure/unit tests.                                                  | Always where applicable.                                            |
| Level 1 - Component / integration         | Adapter/tool integration, database query contracts, migration behavior, API contracts.                             | When changed components cross boundaries.                           |
| Level 2 - Scenario                        | Happy/unhappy path, permission/empty/duplicate/timeout cases, deterministic fixtures.                              | Required for user/business behavior.                                |
| Level 3 - Agentic / eval                  | Model-dependent behavior with controlled fixtures, eval sets, model/judge where mechanical verifier is incomplete. | Required when behavior materially depends on model judgment.        |
| Level 4 - Replay / simulation / readiness | Exercise the same runtime contracts with controlled state/evidence; N0-N5 readiness when relevant.                 | Required for operational workflow changes proportional to maturity. |
| Level 5 - E2E / product acceptance        | Actual UI/channel/business flow and side effects under controlled conditions.                                      | Required for high-value user journeys.                              |
| Level 6 - Release / outcome               | Canary, telemetry, regressions, business outcome and rollback evidence.                                            | Required for consequential production evolution.                    |

| **Verification should challenge the Spec.** Tests are not only implementation checks. They can reveal that the Spec itself is ambiguous, unsafe or wrong. When that happens, the correct response is not to “make the test pass” by changing code blindly; classify the failure and repair the owning artifact. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 14.1 Verification-first spectrum

Verification should be designed before or alongside implementation whenever the expected behavior can be stated. The specific instrument depends on whether the behavior is deterministic, model-mediated or product-level.

| **If the behavior is...**                 | **Prefer...**                                       | **Completion signal**                                                    |
|-------------------------------------------|-----------------------------------------------------|--------------------------------------------------------------------------|
| Deterministic and mechanically assertable | Tests/fixtures first when practical                 | Previously failing case passes; relevant regression suite remains green  |
| Model-dependent                           | Eval/scenario set first                             | Quality/safety rubric and failure-rate threshold met on controlled cases |
| User/business workflow                    | Acceptance scenarios first                          | Observable happy/unhappy paths and evidence contract satisfied           |
| Operational release                       | Replay/simulation/readiness + canary where relevant | Same runtime contracts pass; release evidence and rollback path exist    |

## 14.2 Release Scope and the Done boundary

The four verification layers of Section 11.5 stay exactly as they are. **Release Scope** is a separate, Slice-level declaration: how far a specific Slice must reach before it can be Done. It composes with the layers; it does not replace, collapse or reorder them.

| **Release Scope**    | **Required evidence**                                                                                                                                                                                                                     | **Typical Slices**                                                                     |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| **RS-1 Deterministic** | Appropriate local verification plus the required deterministic CI evidence. **No hosted-environment claim is made.**                                                                                                                       | Refactors; deterministic verification capability; local contract fixture work.          |
| **RS-2 Hosted**        | RS-1, plus the hosted/staging evidence required by the Slice Acceptance Contract.                                                                                                                                                          | Hosted schema/security/tenancy capability; shadow behavior; pilot capability.            |
| **RS-3 Production**    | RS-2, plus explicit production authorization, the required production preflight, controlled deploy/release, post-release verification, and canary / flags / observability / rollback discipline as applicable.                             | User-visible external effects; authority transfer; consequential production evolution.   |

Rules that keep the boundary honest:

- **Production is required for Done only for RS-3.**
- **Release Scope is declared at READY**, not chosen at completion. It must not be silently lowered so that a Slice can be called Done.
- **Increasing Release Scope mid-flight requires the appropriate human authority** (Section 16); it is not an agent decision.
- **Behavior/authority mode is not Release Scope.** `shadow` — flag-off, no external effects — is a behavior and authority mode; a shadow Slice will often be RS-2. Do not conflate the two.

### Done

A Slice is **Done** when:

- its Slice Acceptance Contract is satisfied;
- its applicable Definition of Done is satisfied;
- the required verification evidence exists;
- the evidence required by its declared Release Scope is satisfied;
- no unresolved consequential blocker remains.

The Done record makes explicit: the **environment reached**, the **Release Scope achieved**, the **material assertions verified**, and the **material things intentionally not exercised**.

| **Merged is not Done. CI green is not Done. Deployed to staging is not Done.** Each is evidence at one layer. Done is the satisfaction of the Slice's own acceptance contract, Definition of Done and declared Release Scope. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

**Done is a Slice boundary, not a roadmap boundary.** A Done Slice says its own acceptance contract, Definition of Done and declared Release Scope are satisfied. It says nothing about whether the Roadmap Increment it belongs to has demonstrated its intended result — that is a separate evaluation against separately declared evidence (Sections 4.1, 17.2).

# 15. Failure classification and owning-artifact repair

Verification failure is routed to the artifact that owns the defect. This is a repo-native Gu OS idea and a key extension beyond simple Spec -\> Plan -\> Code loops.

| **Failure class**                              | **Owning artifact**                              | **Repair action**                                                                        |
|------------------------------------------------|--------------------------------------------------|------------------------------------------------------------------------------------------|
| Requirement ambiguity / wrong desired behavior | Product Intent / Initiative Brief / Feature Spec | Clarify outcome/actor/scope; revise governing behavior before further implementation.    |
| Architecture contradiction / unsafe design     | Architecture Analysis / ADR / Technical Plan     | Revisit the trade-off; document accepted alternative and consequences.                   |
| Missing/misordered work or contract            | Technical Plan / Tasks / vertical slices         | Repair decomposition/dependencies; do not change intended behavior.                      |
| Implementation defect                          | Code/config/migration                            | Fix implementation and re-run relevant evidence.                                         |
| Verifier/test defect                           | Test/eval/verifier contract                      | Repair the evidence mechanism; preserve the business contract.                           |
| Environment/provider/integration issue         | Environment/integration/runbook                  | Repair setup or explicitly classify external dependency failure.                         |
| Policy/security issue                          | Policy/Spec/ADR                                  | Do not bypass the gate to make implementation succeed.                                   |
| Non-convergence                                | Plan/scope/agent strategy/human decision         | Stop bounded retries; escalate or reduce/reframe scope rather than looping indefinitely. |

## 15.1 Debugging loop for agentic development

For reported bugs, the default sequence is: reproduce -\> isolate -\> classify cause -\> identify owning artifact -\> make the minimum justified repair -\> run regression evidence -\> update governing documentation if the contract/control changed. Avoid speculative patching before the failure mechanism is understood.

| **Step**            | **Question**                                                                                                                                     |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| Reproduce           | Can we make the failure observable with a deterministic fixture, scenario or controlled run?                                                     |
| Isolate             | Which layer actually fails: product requirement, model interpretation, deterministic code, state/data, provider/environment, verifier or policy? |
| Classify            | Which artifact owns the defect?                                                                                                                  |
| Repair              | What is the smallest change that fixes the root cause without broad unrelated redesign?                                                          |
| Regression evidence | What test/eval/scenario proves the failure is fixed and adjacent contracts remain safe?                                                          |
| Document            | Did the accepted behavior, architecture or control change? If yes, reconcile the owning Spec/ADR/plan/docs.                                      |

## 15.2 Intake of bugs, unexpected work and incidents

The classification and owning-artifact repair model above is unchanged. This subsection adds only the **operational intake** question that classification does not answer: how does unplanned work enter the Slice Plan and the Execution Cycle?

| **Situation**                                                            | **Intake rule**                                                                                                                                                                                                                                                                     |
|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **A.** Defect inside the active Slice's own scope                        | Not a new backlog item by default. Repair inside the Slice and add regression evidence. The Slice is **not Done** until corrected.                                                                                                                                                    |
| **B.** Pre-existing regression discovered incidentally                   | Do not silently absorb it into the current Slice. Record it as repair work — a repair-type Slice or a proportional bug item — and classify the owning artifact (Section 15). Schedule it explicitly, unless fixing it immediately is clearly justified and stated.                     |
| **C.** Apparent "bug" that is actually ambiguous or changed behavior     | Route to the governing Spec / product artifact. The coding agent must not silently decide intended product behavior. It blocks the affected acceptance scenarios, not necessarily the whole Slice.                                                                                    |
| **D.** Production, security, tenancy or data-integrity incident          | **Expedite.** May interrupt the normal Cycle. A named human is accountable. Contain, classify, repair, verify; a follow-up owning-artifact correction is required when applicable, and the governance in Section 16 applies to the fix.                                               |

`Blocked`, `Needs Human Attention` and `Expedite` remain orthogonal flags (Section 12.2), not stages.

# 16. Review, approval and release

Human review should be concentrated at consequential boundaries rather than sprayed across every agent action. Approval intensity is proportional to product, security, data, business and operational risk.

| **Change class**                                 | **Signal**                                                                | **Minimum governance**                                                     |
|--------------------------------------------------|---------------------------------------------------------------------------|----------------------------------------------------------------------------|
| Low-risk maintenance                             | Existing intent/architecture unchanged; tests prove no behavior drift.    | Code review + automated checks; no new PRD/Spec.                           |
| Feature behavior change                          | User/business behavior changes.                                           | Spec approval + evidence; architecture review if boundaries change.        |
| Data/tenancy/security change                     | Authorization, RLS, secrets, data ownership/scope, external side effects. | Security/architecture review + explicit verification/rollback.             |
| Workflow/case authority change                   | Transitions, approvals, evidence, durable state, external commitments.    | Business/architecture approval + simulation/replay/readiness.              |
| Production code/policy self-improvement proposal | Generated from incidents/evals/outcomes.                                  | PR + tests/evals + human release authority; never silent runtime mutation. |

**Relationship to Release Scope.** A Slice's declared Release Scope (Section 14.2) says how far it must reach; this table says who must authorize it. RS-1 and RS-2 are ordinarily satisfied inside the governance a Slice already carries. **RS-3 always engages release authority**, and raising a Slice from RS-1 or RS-2 to RS-3 mid-flight is a human decision at the boundary its change class implies.

Release safely means retaining a credible rollback path: additive migrations where practical, feature flags, versioned behavior, canary/staged rollout and preserved prior artifacts. “Generated quickly” is not a reason to make consequential change irreversible.

# 17. Observe, learn and evolve

After release, product and engineering outcomes feed the next cycle. Gu OS already defines a safe change path: detect failure -\> classify owning artifact -\> propose versioned change -\> simulate/evaluate -\> approve -\> publish/canary -\> measure -\> retain or rollback. The methodology adopts the same pattern for software development.

| **Loop stage**    | **Development meaning**                                                                                           |
|-------------------|-------------------------------------------------------------------------------------------------------------------|
| Observe           | Incidents, support, usage, business outcomes, rework, cost, latency, human corrections, failed evals.             |
| Classify          | Which artifact owns the learning: PRD, Spec, ADR, pattern, Skill, test fixture, code, runbook, provider contract? |
| Propose           | Versioned diff/change proposal with provenance and expected impact.                                               |
| Evaluate          | Tests, replay, simulation, security review, product acceptance and comparison to baseline.                        |
| Approve / release | Authority proportional to risk; canary/staged deployment where appropriate.                                       |
| Measure           | Did the change improve the intended outcome without unacceptable regressions/cost?                                |
| Retain / rollback | Keep evidence-linked successful changes; revert or revise unsuccessful ones.                                      |

## 17.1 Calibrating agent-assisted development

The same loop applies to how we plan, not only to what we ship. Slice estimation (Section 10.4) is a new practice with no local evidence base, so the first **3–5 real Slices** record a minimal empirical dataset.

| **#** | **Recorded**                                                                                                       |
|-------|----------------------------------------------------------------------------------------------------------------------|
| 1     | Initial estimate range + confidence, **frozen when the Slice becomes READY** and not edited afterwards.              |
| 2     | Actual agent-assisted engineering elapsed time to evidence-ready.                                                    |
| 3     | Human/external wait time, recorded **separately** from (2).                                                          |
| 4     | Total calendar elapsed time from execution start to evidence-ready / Done — preferably derived from timestamps.      |
| 5     | Re-planning events: count and concise cause, mapped where possible to the failure classification in Section 15.      |
| 6     | Reopen / rework after Done, and the artifact that owned the defect.                                                  |
| 7     | Declared Release Scope versus the Release Scope actually required.                                                   |
| 8     | Whether new verification capability had to be created inside the Slice.                                              |

Deliberately **not** collected yet: story points, velocity, burndown, a productivity multiplier, or per-Task time as a required metric.

| **What 3–5 Slices can and cannot show.** They can begin calibrating estimate bias and variance. They cannot establish a trustworthy productivity multiplier, and must not be reported as one. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 17.2 Roadmap Increment graduation

The loop above closes a *change*. This subsection closes an *increment*, and exists because "implementation complete" is routinely mistaken for "outcome demonstrated".

Four **distinct** claims, with different evidence and different owners. They are deliberately *not* presented as a single scale of increasing strength:

| **Claim**                               | **What it establishes**                                                                                     | **Governing authority for the claim**                                                                                          |
|-----------------------------------------|-----------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| Implementation complete                 | An implementation claim only: the code exists. No evidence claim is made.                                   | The implementation itself. It authorizes no evidence claim.                                                                        |
| Slice Done                              | This Slice's Acceptance Contract, Definition of Done and declared Release Scope are satisfied (Section 14.2). | The **Slice contract** defines the bar; the supporting evidence is owned by the tests, evals, CI, hosted runs and records that produced it. |
| Roadmap Increment graduated             | The increment's **declared graduation evidence** is satisfied — whatever the roadmap declared that to be.     | The **Roadmap declares the graduation criteria and the evidence requirement**; the supporting evidence remains owned by the systems and artifacts that produced it — tests/evals, hosted verification, telemetry, release records, business results. |
| Business / product outcome demonstrated | An intended business or operational outcome is observed in reality.                                          | Telemetry, incidents and business results own the observation; whichever artifact set the target owns what counts as success.       |

**Declaring a criterion is not the same as owning the evidence.** The Roadmap says *what must be shown*; it never becomes the store of the proof. Reading a graduation criterion tells you which evidence to go and ask for, and from which owner.

**These do not form a fixed ordering.** In particular, business/product outcome evidence is **not** universally a later or stronger claim than graduation: an increment's declared graduation evidence may already *include* business or operational outcome evidence, in which case graduating requires it. Equally, broader outcome evidence may keep accumulating long after an increment has graduated. What each claim needs is defined by its own owner, not by its position in a list.

**When a Roadmap Increment's currently planned work is complete:**

- evaluate the graduation evidence the roadmap declared for that increment;
- identify what evidence or work is still missing;
- classify each mismatch to its owning artifact (Section 15);
- create or propose the legitimate additional work when it already sits inside approved governing intent;
- escalate consequential uncertainty to the human-governed artifact that owns it;
- **graduate only when the declared evidence is satisfied.**

When the increment graduates, continue to the next governed increment (Section 12.3, case H). Do not stop merely because a predefined Slice list is exhausted.

### Graduation is an evidence evaluation, not a new approval ceremony

Humans own the **rules** and the **strategic decisions**. Recognizing that already-governed evidence is objectively satisfied is not, by itself, another decision.

| **Situation**                                                                                                                 | **Who acts**                                                                                                            |
|-------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| The declared graduation evidence is **unambiguously satisfied**, and the next Roadmap Increment is **already governed**.        | The system/agent records the evaluation and the Continuity Loop may continue into preparing the next legitimate work (Section 12.3, cases H–I). **No additional routine approval is required.** |
| Evidence is **ambiguous, incomplete or disputed**.                                                                             | Human judgement. Surface precisely what is unresolved (Section 12.3, case G).                                             |
| The **graduation criteria themselves** would need to change.                                                                   | Product leadership, at the roadmap — never the party trying to graduate.                                                  |
| Opening or reprioritizing the next increment would change **product strategy, priority, accepted risk** or another human-owned decision. | Product leadership (Section 12.3, case J).                                                                                |
| An explicit **roadmap, release or business authority gate** exists.                                                            | That gate applies unchanged (Sections 14.2, 16).                                                                          |

This introduces **no new universal human approval gate**. It preserves human authority exactly where it already sat — over product strategy, roadmap sequencing, the creation and change of graduation criteria, consequential reinterpretation of them, and accepted risk and authority decisions — while declining to add an approval ceremony for the act of reading satisfied evidence.

| **Graduation criteria are not editable by the party trying to graduate.** Discovering that the declared evidence is itself wrong is a legitimate finding, and it belongs to the roadmap as its owning artifact. Rewriting the criteria so that current results satisfy them is silent drift with a success label attached. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 18. Which artifacts are required? Proportionality matrix

The methodology must not turn every two-line fix into a paperwork exercise. Artifact depth scales with ambiguity, consequence and cross-cutting impact.

| **Work type**                    | **Typical signal**                                                          | **Minimum artifacts**                                                                                         | **Usually unnecessary**                                     |
|----------------------------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| Tiny refactor / typo / local bug | Existing governing behavior is clear; no architecture/security/data change. | Issue/task or short change note; tests/checks.                                                                | PRD, new Spec, ADR usually unnecessary.                     |
| Normal feature                   | User-visible behavior changes but architecture is familiar.                 | Parent PRD link + Feature Spec + implementation plan/tasks + verification evidence.                           | Initiative Brief optional.                                  |
| Major bounded coordinated Initiative | Multiple related capabilities share a **bounded intermediate outcome** that a Roadmap Increment does not already frame adequately (Section 4.1). | Parent PRD link + Initiative Brief — *because an Initiative is genuinely being used* — + Specs + architecture/ADRs + plan + staged evidence proportional to consequence. | A dedicated PRD unless the effort is materially independent. |
| New Product Area / Product Responsibility | A new **durable** product responsibility or decomposition boundary is being established, not a temporary effort. | Parent **Product Intent / PRD must establish the responsibility**, plus the relevant Specs, architecture/ADRs, plans and evidence the work itself warrants. | An Initiative Brief — **Initiative remains optional here** and is added only if a separate bounded coordinated outcome genuinely adds value. |
| Architecture/platform change     | Cross-cutting runtime/data/security/tooling constraint.                     | Architecture Analysis + ADR + Technical Plan; affected Specs if behavior changes.                             | PRD only if product intent/scope changes.                   |
| Workflow/case definition         | Durable responsibility, transitions, approvals, evidence or dynamic work.   | Business/Feature Spec + workflow implementation spec + verification/replay/readiness + versioned publication. | Architecture/ADR when new primitive/boundary is introduced. |
| High-risk security/data change   | Tenancy, authorization, privacy, credentials, destructive/external effects. | Spec/ADR/plan + explicit security evidence and rollback.                                                      | Human approval mandatory at relevant authority boundary.    |

**Slice contracts are proportional too.** A Slice contract (Section 10.1) is required for work that is planned, sequenced, sized and closed with evidence — the "normal feature" row and heavier. Tiny refactors, typos and local bug fixes do not get one unless consequence or risk justifies it; a change note plus the relevant checks remains sufficient. Conversely, an architecture/platform or high-risk security/data Slice may legitimately carry a longer contract, because the evidence it must name is itself larger.

**Establishing a durable responsibility is not the same work type as running a bounded effort.** The two rows above are deliberately separate: a **Product Area / Product Responsibility** is durable and optional product organization established by Product Intent, while an **Initiative** is bounded, temporary and optional (Section 4.1). Creating one does not imply creating the other, and a new responsibility does not make an Initiative Brief mandatory. The generic term is Product Area / Product Responsibility; *domain* is Gu OS's concrete mapping of it (Section 1.1), not universal methodology vocabulary.

**Roadmap Increments are proportional too — they are not universal paperwork.** A Roadmap Increment is the unit of *strategically sequenced, evidence-gated product evolution* (Section 4.1). It is **not** required for every kind of work. The following legitimately execute under existing governing context without inventing a new increment:

- a typo or a tiny refactor;
- a small local repair or an unambiguous regression fix;
- routine maintenance;
- incident response (Section 15.2, case D).

The same proportionality governs the Feature / Business Spec: it is required for consequential behavior that needs an explicit behavior contract, **not** for tiny or local work whose intended behavior is already governed and unambiguous. Nothing in Sections 4.1, 12.3 or 17.2 raises the artifact floor set by this section. When in doubt, ask what ambiguity the artifact would resolve; if the answer is "none", the artifact is overhead.

# 19. Documentation governance and authority

The repo already has an authority order in docs/README.md. This methodology preserves it and adds an artifact-responsibility rule: when documents disagree, first determine whether they are even trying to own the same truth. A PRD and architecture plan can differ without contradiction if one describes product intent and the other implementation; two current architecture documents claiming different implemented behavior is a real contradiction.

| **Governance concern**     | **Rule**                                                                                                                                                    |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Status label               | Every consequential document should identify whether statements are Implemented, Partial, Target, Tentative, Open or Reference where ambiguity is possible. |
| Owner / scope              | Document should state what question/topic it owns and what it does not own.                                                                                 |
| Governing sources          | Plans/specs should link to parent PRD/Spec/ADR/architecture rather than restating them wholesale.                                                           |
| Supersession               | If a document is replaced, mark it Superseded/Historical and link to the replacement. Do not leave two competing “current” documents.                       |
| Contradictions             | Record and resolve; do not silently choose the more convenient document or let code drift become undocumented doctrine.                                     |
| Tool-specific instructions | May point to canonical docs; should not create a parallel product/architecture truth for Claude/Cursor/Codex/etc.                                           |
| Historical material        | Keep when it explains provenance/evolution, but remove it from the active authority path.                                                                   |

| **Current repo note.** docs/README.md already classifies brief.md and plan.md as historical/reference. architecture.md remains the concise implemented-runtime overview, while manuals/architecture-manual.md and topic plans carry integrated/current-target design. The later documentation audit will decide how the new PRD changes that map; this Methodology intentionally does not pre-empt that audit. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 19.1 Authority boundaries across repo, GitHub, agent runtime and a future control plane

Development work now produces truth in more than one system. Each system owns a different kind, and none may silently redefine another's.

| **System**                                    | **Owns**                                                                                                                                            |
|-----------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| Repository canonical documents                | Durable intent and contracts: product intent; behavior contracts; architecture decisions; implementation intent; **durable Slice contracts**; this Methodology. |
| Agent runtime / coding environment            | The just-in-time Task plan, and the **current pre-PR execution context**: implementation in progress and local verification results that do not yet exist anywhere else. |
| GitHub                                        | Branch; commits; PR; CI results; merge state; Actions runs; environment approvals; and the deployment evidence GitHub itself generates.               |
| Future Development Control Plane / Board      | Projection and orchestration across those sources: Cycle planning, Accountable / DRI visibility, human attention, workflow visualization, metrics/learning. |

**No single system owns "where the work is right now."** Before a PR exists, that lives in the agent runtime; once work is pushed, GitHub records it. Asking GitHub for the state of unpushed work, or the repo documents for either, produces a confident wrong answer.

A future board **projects** existing truth across these sources. It must not become an independent competing source of truth for data another system already owns. The board itself remains deliberately undesigned here (Section 22).

**Conceptual projected responsibilities.** As the continuity model of Section 12.3 becomes operational, what a future control plane would *project* grows accordingly:

- READY Horizon visibility (Section 10.5);
- readiness replenishment visibility — what is being elaborated, and what is blocked from becoming READY;
- the upcoming Cycle proposal, and confirmed Cycle inclusion;
- confirmed human Accountable / DRI visibility;
- prerequisites and blockers, with the specific intervention each one needs;
- `Needs Human Attention`;
- dependency conflicts, including planning requests that would violate a governing dependency (Section 12.4);
- Roadmap Increment graduation evidence and status (Section 17.2);
- estimate and calibration learning (Section 17.1);
- continuation / next-legitimate-action visibility — what the system intends to do next, and why.

This list is **conceptual**. No database schema, UI, service architecture, workflow engine or other implementation detail for a control plane is designed here, and none is implied by naming these responsibilities. Every item above remains a projection over the authorities in the table, never a second copy of them.

## 19.2 Transitional execution register

No control plane exists yet. Until one does, a **minimal transitional register** may live alongside the Slice Plan, recording only:

- the Execution Cycle a Slice belongs to;
- the **confirmed human Accountable / DRI** — assignment is a planning fact, not part of the durable Slice contract, so until a control plane exists this register is its temporary home;
- the initial estimate and confidence, by reference where useful;
- final actual metrics and retrospective outcome **after** Done (Section 17.1).

That is the whole list. In particular the register does **not** carry the execution stage of a Slice: `Proposed`, `Planned`, `Agent Planning`, `Implementing`, `Local Verify / Repair`, `PR / CI / Merge`, `Hosted Verify` and `Release / Post-release` are projected from their real authorities, never transcribed.

Any such register must state explicitly that GitHub remains the authority for branch/commit/PR/CI/merge/Actions state, that the agent runtime owns JIT Tasks and pre-PR execution, that the register is **not** authority for live state, and that it should shrink or disappear once a proper control plane exists.

| **Do not track live execution in Markdown.** Editing a document to move a Slice through `Implementing -> Local Verify -> PR / CI` is not a tracking mechanism; it manufactures a stale second copy of state that GitHub and the agent runtime already own. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 20. Worked example: Relationship Operations / Lead Opportunity Case

This example shows how the generic method lands in one concrete product. It is illustrative methodology, not a new approved product Spec, and it neither restates nor alters any current R1 contract.

Read the left column as **the method** and the right columns as **Gu OS's application of it**. Another product would fill the mapping column differently — and the first row is precisely the one it would fill differently.

| **Generic concept**                   | **Gu OS mapping**                                    | **Relationship Operations example**                                                                                                                                                                                                    |
|---------------------------------------|------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Product Area / Product Responsibility | Operating Domain (PRD §7.2) — *optional generically*  | **Relationship Operations**: an enduring business-semantic responsibility. It is not a runtime engine, and it is not a concept another product is required to define (Section 4.1).                                                     |
| Product Intent                        | Product PRD                                          | Real-estate teams lose revenue because valuable opportunities depend on human memory/capacity. Gu should assume increasing responsibility for advancing opportunities while humans retain authority over sensitive business decisions. |
| Roadmap Increment                     | Roadmap horizon + its declared graduation evidence   | **R1 — Relationship Operations v1**: what should be proven now inside that enduring domain, and the evidence that graduates it. The domain outlives the increment; the increment does not rename the domain.                            |
| Shared / Core capability              | Cross-cutting capability pulled by an increment      | The minimum organization / tenancy / multi-seat foundation R1 consumes. It is pulled into the increment **without becoming another Operating Domain**.                                                                                  |
| Initiative *(optional)*               | **Not used here.** No distinct Initiative layer is required for R1 | The `R1` Roadmap Increment already supplies the bounded strategic framing the Specs, ADRs, Technical Plan and Slice Plan need. An Initiative would be added only if a genuinely bounded coordinated effort were later identified. The existing `brief.md` supplies R1's framing — why now, desired outcome, customer evidence, wedge, initial scope, constraints and metrics to improve — which is increment framing, not proof of an Initiative layer. |
| Feature / Business Spec               | Approved Specs                                       | Define when a Lead Opportunity exists, what durable state/facts/commitments it owns, what events advance it, what counts as blocked/completed, how human decisions work, happy/unhappy paths and acceptance scenarios.                 |
| Architecture Analysis / ADR           | Architecture Analysis + accepted ADRs                | Decide Operational Case vs other root; CRM/SOR vs case_facts boundaries; wake-ups/events; capability dispatch; how it coexists with a Transaction Case.                                                                                |
| Technical Plan                        | Technical Plan                                       | Schemas/migrations, adapters, case type/work items, event wiring, policies, projections/UI, flags, compatibility with Traditional Gu, test/eval/readiness strategy.                                                                    |
| Slice Plan / Vertical Slice           | `slice-plan.md` and its Slices                       | For example: create/attach Lead Opportunity Case from an existing lead, persist one commitment/fact, wake on event, surface one governed next action, verify no tenant/authority regression.                                           |
| Verification                          | Evidence layers of Sections 11.5 and 14              | Unit/integration + scenarios + agent eval where judgment matters + replay/readiness + E2E through web/WhatsApp-equivalent path when available.                                                                                         |
| Observe / Learn + graduation          | Section 17 loop + Section 17.2 evaluation            | Measure response/visit/outcome progression, human touches, corrections, rework, cost and failure classes; propose changes to the owning artifact rather than only tuning prompts. Then evaluate R1's declared graduation evidence — completing its Slices is not the same claim. |

| **Do not universalize the mapping column.** Operating Domains, Cases, the Work Plane, Skills and the Brain are how Gu OS currently applies this method. A different product may organize by capabilities, bounded contexts, customer journeys, value streams, modules or services and still run every generic concept in the left-hand column unchanged (Sections 1.1, 4.1). |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

**A note on the current path.** These artifacts live under `docs/product/initiatives/relationship-operations/`. Read that as **documentation debt predating this taxonomy**, not as a classification: the row above is what Relationship Operations actually is. The `slice-plan.md` there serves the **R1 increment** — it is not a perpetual list of every Slice the domain will ever have. Reconciling the layout is a named follow-up (Sections 22, 23); no path is renamed by this version.

# 21. Relationship to Workflow Studio and spec-driven authoring inside Gu OS

There are two related but distinct spec-driven systems and they should not be conflated.

| **System**                            | **What it governs**                                                                            | **Typical chain**                                                                                                                                                                     |
|---------------------------------------|------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A. Development of Gu OS               | How humans + coding agents design and build the product itself.                                | PRD/Brief -\> Feature Spec -\> Architecture/ADR -\> Technical Plan -\> Tasks/Slices -\> Code -\> Verification -\> Release -\> Learning                                                |
| B. Spec-driven authoring inside Gu OS | How Gu OS/Studio converts a business workflow intention into a governed executable definition. | Business spec -\> implementation spec -\> capability map/compiler -\> versioned definition -\> validation/simulation/replay -\> publication -\> runtime evidence -\> fork/new version |

They share principles: explicit intent, versioning, evidence, bounded authority, classification of failures and no silent redesign. But a workflow definition compiled by Studio is a product runtime artifact; a Gu OS Feature Spec is an engineering/product development artifact.

# 22. What this document deliberately does not decide yet

| **Open implementation choice**                                                  | **Why deferred**                                                                                                                                                                                                                                                             |
|---------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| PRD file path/name                                                              | The current canonical product-intent path is `docs/product/PRD.md`; this Methodology does not redefine that path.                                                                                                                                                            |
| Whether brief.md is moved/renamed/archived                                      | The repo already treats it as historical/reference; audit links and provenance before changing paths.                                                                                                                                                                        |
| Whether Gu OS needs one PRD or product + initiative PRDs                        | Methodology defines roles; documentation audit/product synthesis should choose minimum non-duplicative structure.                                                                                                                                                            |
| Remaining artifact templates / playbooks                                        | Canonical templates now exist for the Feature / Business Spec (`docs/development/templates/feature-business-spec-template.md`) and the Slice Plan (`docs/development/templates/slice-plan-template.md`). PRD, Initiative Brief, ADR, Technical Plan, Verification and reusable playbook templates remain incremental deliverables pulled by concrete need. |
| Whether `Feature / Business Spec` is eventually renamed                         | Section 7.1 resolves the granularity ambiguity by rule. A rename such as *Business Behavior Spec* would touch the authority map, this Methodology, the Doctrine, the templates and four approved Specs for a purely lexical gain, so it is deliberately deferred until there is a reason beyond wording. |
| Development Control Plane / Board design                                        | Section 19.1 fixes the authority boundary a future board must respect and now enumerates, conceptually, what it would project. Its data model, surface, service architecture and interaction design remain out of scope here and require their own product and architecture decisions. |
| Durable Execution Cycle length                                                  | Approximately one week is an operational starting point (Section 12.1), not an invariant. Revise it from the calibration evidence of Section 17.1 rather than by preference. |
| Durable READY Horizon size                                                      | Roughly one to two Cycles of READY capacity is an operating default (Section 10.5), not an invariant and not a Slice count. Revise it from throughput, dependency uncertainty, Slice size and roadmap volatility as Section 17.1 evidence accumulates. |
| Whether the Continuity Loop is encoded deterministically                        | Section 12.3 defines the loop as method. Whether part of it should become a coding-agent Skill, a root agent contract rule, a scheduled trigger or another deterministic control is a Section 11.1 layering decision, deliberately not made here. |
| Document organization for the clarified taxonomy                                | Section 4.1 settles the **semantics**: Relationship Operations is an Operating Domain, `R1` is a Roadmap Increment inside it, and no distinct Initiative layer is in use. The **filesystem** question is deferred: how multiple future Roadmap Increments inside one enduring Product Area should be represented, and where R1-specific artifacts belong. The follow-up must first classify each existing artifact by actual ownership and lifetime — enduring Domain framing, governing Specs, R1-specific framing, R1 Architecture / Technical Plan, R1 Slice Plan, Slice-specific evidence. **A blind rename from `product/initiatives/…` to `product/domains/…` would not be enough**, because it would leave R1-specific artifacts looking like perpetual Domain-level ones. No path is renamed by this version. |
| Final distribution of agent instructions across AGENTS.md, IDE rules and Skills | Both layers now exist and are tracked: root `AGENTS.md` + `CLAUDE.md` for monorepo-wide rules, and `apps/web/AGENTS.md` + `apps/web/CLAUDE.md` for web scope (Section 11.2). The remaining decisions are which additional rules belong in nested/path-scoped files versus on-demand Skills, and **how much of the v0.4.0 Development Continuity Loop should be reflected in the root contract** versus loaded on demand. |
| Principles & Design Doctrine wording                                            | Owned by the canonical Doctrine at `docs/principles/gu-os-principles-and-design-doctrine.md`; future changes follow the same artifact-governance method defined here.                                                                                                          |

# 23. Adoption: what is already true, and what is next

Adoption is itself brownfield. Do not stop engineering to rewrite all historical documentation. Apply the methodology first to new consequential work and progressively reconcile existing artifacts. Several steps that earlier versions listed as future work are now done; this section records current state honestly rather than restating them as pending.

**Already established:**

| **Item**                        | **Current state**                                                                                                                                                                                                     |
|---------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Canonical Product PRD           | **Exists** at `docs/product/PRD.md`, built from reconciled existing material. It owns product intent, including the Operating Domain model this Methodology maps as a Product Area example (Section 4.1).               |
| Principles & Design Doctrine    | **Exists** at `docs/principles/gu-os-principles-and-design-doctrine.md` as the canonical decision doctrine.                                                                                                              |
| Product Roadmap                 | **Exists** at `docs/roadmap/gu-os-evolution-roadmap.md`, owning strategic sequencing and per-increment graduation evidence (Section 4).                                                                                  |
| Root agent contract             | **Exists**: root `AGENTS.md` plus root `CLAUDE.md` (`@AGENTS.md`), alongside the app-scoped `apps/web/` pair (Section 11.2).                                                                                             |
| Authority map                   | **Maintained** at `docs/README.md`.                                                                                                                                                                                     |
| Templates                       | Feature / Business Spec and Slice Plan templates are **adopted** under `docs/development/templates/`.                                                                                                                    |
| First real pilot                | **Done.** R1 SL-1 was the first Slice carried through the Slice method end to end, and the first real Definition-of-Ready evaluation — the evidence that produced the v0.3.2 correction (Section 23.4).                  |

**Next, in no fixed order — pulled by real work rather than run as a programme:**

| **Order** | **Action**                                                                                                                                                                                                                                                                                                                                                                   |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Next 1    | Maintain this Methodology (current v0.4.0) as the canonical development method, including the four-layer agent instruction architecture, proportional test/eval-first guidance, the Slice / Execution Cycle planning model, and the Development Continuity Loop with its READY Horizon and Roadmap Increment graduation.                                                       |
| Next 2    | **Align the existing root `AGENTS.md` with accepted v0.4.0** — its artifact chain and planning wording still reflect the pre-v0.4.0 model. Keep it concise: link to Sections 4.1, 10.5, 12.3 and 12.4 rather than copying them into always-on context. Not done by this version.                                                                                              |
| Next 3    | **Reconcile document organization with the clarified taxonomy** (Section 22, Section 4.1). Relationship Operations is an Operating Domain, not a bounded Initiative, yet its artifacts currently live under `docs/product/initiatives/`. Classify the existing artifacts by actual ownership and lifetime before moving anything; a blind rename would not resolve the debt.   |
| Next 4    | Continue empirical calibration with subsequent Slices and Cycles (Section 17.1), including the READY Horizon and Execution Cycle defaults, which are operating starting points rather than invariants.                                                                                                                                                                       |
| Next 5    | **Exercise the Development Continuity Loop at the next real planning boundary** (Section 12.3), and record where it produced legitimate continuation versus where it correctly stopped at a human-authority boundary.                                                                                                                                                        |
| Next 6    | Continue the documentation audit already under way: retain canonical / contributes to PRD / link from PRD / merge / supersede / historical-archive / agent-adapter-only; mark superseded and historical files explicitly.                                                                                                                                                     |
| Next 7    | Grow Templates / Playbooks incrementally. Add PRD, Initiative Brief, ADR, Technical Plan, Verification and reusable procedure templates only when concrete work benefits from standardization; add nested or path-scoped rules and Skills only where they reduce noise or encode real procedure.                                                                              |

# 23.1 v0.2.3 update note

v0.2.3 adopts the first canonical Development Template: `docs/development/templates/feature-business-spec-template.md`. It does not change the artifact ownership model. The update makes the existing Feature / Business Spec requirements operational through a reusable scaffold, preserves proportionality (irrelevant sections may be omitted), and explicitly separates the approved Spec from the template itself. Remaining templates/playbooks stay incremental and demand-driven.

# 23.2 v0.3.0 update note

v0.3.0 is a **model change**, not a template addition. It makes the Agile planning layer of the existing Spec-driven, agentic method explicit, without moving any authority.

What it adds: the Vertical Slice as the primary human planning unit (Section 10); the durable Slice contract (10.1); Definition of Ready as a readiness condition (10.2); just-in-time Task planning (10.3); Slice estimation (10.4); the Execution Cycle with `Proposed` / `Planned` / `Executable` and the human Accountable / DRI (12.1); the conceptual Slice execution-state model (12.2); Release Scope RS-1/RS-2/RS-3 and the Done boundary (14.2); intake of bugs and incidents (15.2); development calibration metrics (17.1); and the repo / GitHub / agent-runtime / future-board authority boundary (19.1–19.2). It adopts a second canonical template, `docs/development/templates/slice-plan-template.md`.

What it deliberately does **not** change: the artifact ownership model; the four verification layers of Section 11.5; the failure-classification and owning-artifact repair model of Section 15; and the human authority boundaries of Section 12. **Selecting a Slice into an Execution Cycle schedules already-approved work; it is not an additional approval gate.** Section 7.1 resolves Spec granularity by rule; nothing is renamed.

# 23.3 v0.3.1 update note

v0.3.1 is a **coherence correction** to the model adopted in v0.3.0. It introduces no new concept, no new artifact and no new authority.

Three inconsistencies are repaired:

1. **Accountable / DRI was required by the Definition of Ready.** That conflated a property of the *Slice* with a property of the *team*, and made a well-specified Slice look unready merely because nobody had picked it up. Readiness no longer requires an assignment; the Accountable / DRI is confirmed when the Slice becomes `Planned`, and a Slice must not become `Executable` or enter Agent Planning without one (Sections 10.2, 12.1, 12.2).
2. **The Slice Plan template's index carried a live `Status` column** (`Backlog` / `Proposed` / … / `Done`), contradicting the same document's statement that it is not authority for execution state. The index now carries **Readiness** — part of the durable contract — and the durable per-Slice block no longer carries an assignment; the transitional register in Section 19.2 is the temporary owner of the confirmed Accountable.
3. **"Where is the work right now" was attributed wholly to GitHub**, which is broader than GitHub's actual authority. Before a PR exists that state lives in the agent runtime; GitHub owns what execution has recorded — branch, commits, PR, CI, merge state, Actions, environment approvals and the deployment evidence it generates (Sections 4, 19.1).

Unchanged: the artifact ownership model, the four verification layers, Release Scope RS-1/RS-2/RS-3 and the Done boundary, failure classification and owning-artifact repair, and the human authority boundaries of Section 12. **Selecting or planning a Slice remains scheduling, not an approval gate.**

# 23.4 v0.3.2 update note

v0.3.2 repairs a circularity in the v0.3.0 dependency rule, found by the **first real Definition-of-Ready evaluation** (R1 SL-1, 2026-09-03). It is a semantic correction to one rule; the governance model is unchanged.

**The defect.** Case B required the dependency to be *"planned earlier in the same Execution Cycle"* as a condition of the dependent Slice becoming READY. But Section 10.2 also defines READY as what makes a Slice *eligible for Cycle planning*, and Section 12.1 places Cycle planning after readiness. So a Slice could not become READY without a Cycle fact that only exists after it is READY. In practice the rule also assumed every prerequisite is itself a Slice, which a provisioning or coordination prerequisite need not be.

**The correction.** Readiness now asks only what readiness can answer: is the dependency ours, and is its prerequisite **concrete** — statable as a bounded contract without executing the dependent Slice to discover it? The scheduling obligation is not dropped; it moves to where it belongs, Cycle planning (Section 12.1), which must explicitly sequence a case-B prerequisite before the dependent Slice — as its own READY Slice where the prerequisite warrants Slice treatment under Section 18, otherwise as named prerequisite / setup / coordination work. Proportionality decides which, so no new artifact is required for small provisioning or configuration steps; what is disallowed is leaving the prerequisite implicit.

**What is preserved.** READY remains intrinsic to the Slice and still precedes Cycle planning; it still requires no Accountable / DRI and no Cycle. `Planned` still confirms Cycle inclusion and a confirmed human Accountable. `Executable` still requires prerequisites *actually* satisfied plus capacity. Sequencing inside Cycle planning is scheduling, not approval, so **no additional approval gate is introduced** — Section 12.1's standing rule that cycle planning is not an approval gate is untouched.

Affected: Section 10.2 (the case-B row plus the note distinguishing readiness from scheduling), Section 12.1 (the sequencing obligation), and `templates/slice-plan-template.md`, which duplicated the old wording.

# 23.5 v0.4.0 update note

v0.4.0 is a **semantic evolution of the operating model**, not a rewrite. Everything v0.3.2 established about artifact ownership, readiness, planning, evidence and human authority is preserved. What changes is the *scope of what the development system is expected to do on its own*.

**The evolution.** v0.3.2 described agent-autonomous **Slice execution**. v0.4.0 describes agent-autonomous **development continuity under human authority**: the system observes development state, identifies the next legitimate action, acts inside approved authority, verifies, reassesses and continues — stopping only when the next meaningful action crosses a genuine human-authority boundary, or when no legitimate progress is possible. Autonomy here means continuing legitimate work without unnecessary prompting; it grants no new authority over consequential product, architecture, security, risk, economic, dependency or release decisions.

What it adds:

1. **Product portability made explicit** (Section 1.1). The method is generic; Gu OS is its proving ground and its worked example, not its definition.
2. **A clarified planning taxonomy** (Section 4.1). Product Area / Product Responsibility and Initiative are **optional** organizing concepts; the relationships among them are many-to-many, not a mandatory hierarchy — there is explicitly no `Product Area → Roadmap Increment → Initiative → Spec → Slice` chain. An Initiative is optional *because a Roadmap Increment already provides sufficient bounded strategic framing*, and earns its place only when it represents a coordinated outcome the increment does not. Gu OS Operating Domains are mapped as one concrete application of Product Area; Shared / Core capabilities are explicitly not peer domains, though they may have surfaces of their own. All of it stays proportional under Section 18: none of these artifacts is required for tiny or local work.
3. **Product Roadmap / Roadmap Increment as an owned truth** (Sections 3, 4, 12, 17.2). Strategic sequencing, evidence gates, graduation evidence and deliberately deferred work belong to the roadmap, not to Specs or Slice Plans.
4. **The READY Horizon and proactive readiness replenishment** (Section 10.5). Rolling-wave planning becomes something the system *maintains*, with a capacity-oriented default of roughly one to two Cycles — an operating default, not an invariant, and never a Slice count.
5. **The Development Continuity Loop** (Section 12.3), with an explicit ten-case decision policy and an explicit stopping condition.
6. **Proactive Execution Cycle formation** (Section 12.1). Cycle proposal now has stated triggers; confirmation of inclusion and of the human Accountable / DRI is unchanged.
7. **Dependency-safe planning** (Section 12.4). An informal planning request may reprioritize valid options but must not silently invalidate a governing dependency, contract, Spec, architecture decision, security boundary or accepted risk; the conflict is surfaced and any real change is routed to the artifact that owns it.
8. **Roadmap Increment graduation inside Observe / Learn** (Section 17.2), separating implementation complete, Slice Done, increment graduated and outcome demonstrated as four distinct claims with different owners — deliberately **not** a single scale of increasing strength, since declared graduation evidence may itself include business or operational outcome evidence. Graduation is an **evidence evaluation, not a new approval ceremony**: where the declared evidence is unambiguously satisfied and the next increment is already governed, work continues without additional approval; criteria changes, ambiguous evidence and strategy/priority/risk decisions remain human-owned.
9. **An expanded conceptual role for the future Development Control Plane** (Section 19.1) — projection responsibilities only.

It also carries a set of **coherence repairs** to current-state claims: root `AGENTS.md` and `CLAUDE.md` now exist and are described as such (Sections 11.2, 22, 23, Appendix B); the adoption section reports what is already true rather than restating it as pending (Section 23); Slice Plan aggregation is stated as **normally one per Roadmap Increment**, not one per Spec / ADR / Technical Plan (Section 10.1); the Spec → Slice relationship is stated precisely, preserving enabling Slices governed by an ADR, architecture source, Technical Plan, invariant or prerequisite capability (Section 10); tool portability is expressed as *replaceable within a role* rather than roles being interchangeable (Section 1.1); and the current `docs/product/initiatives/relationship-operations/` path is named as documentation debt rather than as evidence that Relationship Operations is an Initiative — it is an Operating Domain, with `R1` a Roadmap Increment inside it (Sections 4.1, 20, 22).

**What it changes about ownership.** v0.4.0 does **extend and refine the ownership architecture**: it adds Product Roadmap / Roadmap Increment as an owned truth (Section 4), states Slice Plan aggregation as normally one per Roadmap Increment (Section 10.1), and separates declaring a graduation criterion from owning the supporting evidence (Section 17.2).

What it deliberately does **not invalidate**: the existing ownership boundaries for product intent, intended behavior, architecture decisions, implementation intent, execution state, verification and release. Nor does it change `READY` ≠ `PLANNED` ≠ necessarily `EXECUTABLE`; the confirmed human Accountable / DRI belonging to `Planned` and being required before execution; JIT Tasks beginning only after READY + PLANNED + EXECUTABLE and never becoming canonical Markdown truth; **Cycle planning remaining scheduling rather than an approval gate**; GitHub as authority for recorded execution state and the agent runtime as authority for pre-PR execution context; the four verification layers; Release Scope RS-1/RS-2/RS-3 and the Done boundary; failure classification and owning-artifact repair; the preference for deterministic controls over longer prompts; proportional artifact depth under Section 18; and every human authority boundary in Sections 12 and 16.

**No Development Control Plane is implemented or designed by this version**, and no Gu OS product intent, roadmap priority, graduation criterion, approved Spec, accepted ADR, Slice contract or execution state is changed by it.

# 24. Working glossary

| **Term**                             | **Working definition**                                                                                                                                                                                   |
|--------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Product Intent                       | The durable why/for whom/outcome/strategy context of a product.                                                                                                                                          |
| PRD                                  | Product Requirements Document; canonical product-intent context, not a technical implementation document.                                                                                                |
| Product Area / Product Responsibility | **Optional** generic concept: a durable product or business responsibility used to organize intent and work. Gu OS maps it to its Operating Domains; other products may decompose differently. Not a mandatory methodology concept. |
| Shared / Core capability             | A cross-cutting capability consumed across responsibilities, increments or initiatives. It **may** have user-facing or administrative surfaces; its cross-cutting role does not by itself make it a peer Product Area / Product Responsibility. |
| Roadmap Increment                    | A temporary, strategically sequenced, evidence-gated increment owning what should be proven next, why now, what must exist first, and the graduation evidence that closes it. Gu OS maps it to the roadmap's R-numbered horizons. |
| Graduation evidence                  | The evidence the roadmap declared for a Roadmap Increment. Satisfying it graduates the increment; completing every planned Slice does not. Not editable by the party trying to graduate.                    |
| Initiative                           | **Optional** bounded, temporary coordination frame around a concrete outcome. Not a Product Area, not a Roadmap Increment, not a Spec, and not a required layer.                                            |
| Initiative Brief                     | Optional lightweight framing artifact for a bounded initiative before committing to detailed specification.                                                                                              |
| Feature / Business Spec              | Approved intended-behavior contract for consequential functionality.                                                                                                                                     |
| Architecture Analysis                | Evidence-based exploration of system boundaries, alternatives, risks and design space.                                                                                                                   |
| ADR                                  | Architecture Decision Record; concise accepted/rejected consequential decision with context and consequences.                                                                                            |
| Implementation Spec / Technical Plan | Detailed translation of approved behavior/architecture into implementation design.                                                                                                                       |
| Vertical Slice                       | Small end-to-end increment that can be demonstrated and verified against a real contract. The **primary unit of human planning**: prioritized, sized, made ready, planned into a Cycle and closed with evidence. |
| Slice Plan                           | Integrated canonical artifact owning the durable Slice contracts and their order — normally one per Roadmap Increment, or per bounded Initiative where one is genuinely used. Not one per Spec / ADR / Technical Plan, and not a live execution-state store. |
| Slice Acceptance Contract            | The concise, testable statement of what one Slice must demonstrate — its inspectable outcome, the governing acceptance scenarios it proves, relevant paths and edge cases, and any slice-local assertions. |
| Task                                 | An implementation execution unit derived just in time by the coding agent after a Slice is Ready, Planned and Executable; not canonical Markdown truth.                                                    |
| Execution Cycle                      | Short, tool-agnostic planning time box holding the Slices planned for the near horizon. A planning container, not a sequencing, evidence or release authority.                                             |
| Proposed / Planned                   | Slice planning statuses inside an Execution Cycle: system-proposed (Accountable may be suggested), then human/team-confirmed **with a confirmed Accountable / DRI**. Deliberately not called *committed*.  |
| Executable                           | Derived condition: a Planned Slice (so with a confirmed Accountable) whose prerequisites are actually satisfied and for which execution capacity is available. Ready is not Planned; Planned is not necessarily Executable. |
| Definition of Ready                  | Readiness condition of the Slice itself — governing behavior approved, acceptance contract testable, evidence achievable, Release Scope declared, risk assessed, estimate recorded, dependencies classified. Not an approval gate, and not dependent on anyone being assigned. |
| READY Horizon                        | The amount of sufficiently elaborated READY work maintained ahead of current execution so development does not stall between Slices or Cycles. **Capacity-oriented, not a Slice count**; default roughly 1–2 Cycles, an operating default rather than an invariant. |
| Readiness replenishment              | The proactive activity of maintaining the READY Horizon: elaborating near-term work far enough to genuinely test the Definition of Ready, without lowering that bar, creating premature Tasks, or inventing consequential decisions.                                       |
| Development Continuity Loop          | The operating rule that the development system keeps advancing to the next legitimate action — execution, prerequisites, verification, repair, replenishment, Cycle proposal, artifact refinement, graduation evaluation, next-increment preparation or escalation — rather than stopping when the current work item ends. Autonomy in continuity, never in authority. |
| Accountable / DRI                    | The human responsible for a Slice's outcome, escalation response, external coordination and its reaching the governed Done boundary — confirmed when the Slice becomes `Planned`, required before it can execute, and distinct from the AI actor that executes it. |
| Release Scope                        | Slice-level Done boundary: RS-1 deterministic, RS-2 hosted, RS-3 production. Declared at Ready; composes with the four verification layers rather than replacing them.                                     |
| Definition of Done                   | Explicit conditions/evidence that make a task/slice complete.                                                                                                                                            |
| Verification Evidence                | Tests/evals/replay/simulation/readiness/E2E evidence that supports a completion or release claim.                                                                                                        |
| Owning artifact                      | The document/system that has authority over the type of truth implicated by a failure or change.                                                                                                         |
| Silent drift                         | Behavior/design changes introduced through implementation without reconciling the governing artifact.                                                                                                    |
| Spec-driven development              | Development in which approved intended behavior is explicit before consequential implementation and downstream plans/tests derive from it.                                                               |
| Agentic development                  | Software development where AI coding agents perform meaningful reasoning/implementation/testing inside explicit human/governance boundaries.                                                             |
| Repo operating instructions          | Concise persistent instructions for building/testing/navigating a repository; tool-specific entrypoints should link to canonical truth rather than duplicate it.                                         |
| Agent operating contract             | Concise always-on project instructions for coding agents: authority map, verified workflows/commands, safety rules and links to canonical sources; not a replacement for product/architecture documents. |
| Path-scoped rule                     | Instruction loaded only when work touches matching files/directories; used to keep domain-specific guidance out of every coding-agent context.                                                           |
| Deterministic enforcement            | Test, hook, validator, policy, permission or CI/release mechanism that mechanically checks or blocks behavior rather than relying on model compliance.                                                   |
| Verification independence            | Degree to which verification is performed by evidence/mechanisms sufficiently separate from the generation path to reduce self-confirming errors.                                                        |

# Appendix A - Source-to-method mapping

| **Source idea**                                                              | **Disposition**               | **Methodology consequence**                                                                                                                                     |
|------------------------------------------------------------------------------|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Lab10 Vibecoding: PRD as persistent product context                          | Adopt / adapt                 | Becomes Product Intent / PRD; keep concise and link deep material.                                                                                              |
| Lab10 Vibecoding: DESIGN.md                                                  | Adapt                         | Cross-cutting Experience/Design Contract; not mandatory for backend-only work and not a substitute for Specs.                                                   |
| Lab10 Vibecoding: CLAUDE.md                                                  | Generalize                    | Tool-agnostic repo operating instructions; Claude-specific file may remain one adapter/entrypoint.                                                              |
| Lab10: inspect/think before coding                                           | Adopt                         | DM: investigate/clarify before code; authoritative repo/docs over invention.                                                                                    |
| Lab10: vertical slices                                                       | Adopt                         | Preferred task decomposition for user/business behavior.                                                                                                        |
| Lab10 SDD: Clarify -\> Spec -\> Plan -\> Execute/Verify                      | Adopt + extend                | Gu OS adds PRD/Brief, Architecture/ADR, owning-artifact failure routing, release governance and outcome learning.                                               |
| Lab10 SDD: human approves Spec, agent codes/tests                            | Adapt                         | Strong default; additional human gates depend on architecture/security/business risk.                                                                           |
| Gu OS Technical Plan: spec-driven workflow lifecycle                         | Recognize as repo-native      | Confirms SDD is already part of Gu OS direction, not imported from Lab10.                                                                                       |
| Gu OS Detailed Implementation Plan: translate, do not redesign               | Adopt                         | Implementation contradiction is escalated/reconciled; no silent drift.                                                                                          |
| Gu OS ai-native-loops: safe change path                                      | Adopt                         | Extends development into governed learning and rollback.                                                                                                        |
| Gu OS readiness: reproducible business contracts                             | Adopt                         | Verification evidence must prove the real contract, not only technical execution.                                                                               |
| Gu OS ADR system                                                             | Adopt                         | Cross-cutting decisions live in ADRs; topic plans retain detail.                                                                                                |
| Historical forma_de_trabajo.mdc: tool/skill discovery + no invented commands | Adopt / modernize             | Move concise versions into the portable agent contract; derive actual commands from current package scripts/repo evidence.                                      |
| Historical forma_de_trabajo.mdc: risk-proportional TDD                       | Adapt                         | Deterministic invariants/regressions -\> test-first; model behavior -\> eval/scenario-first; product workflows -\> acceptance-scenario-first.                   |
| Historical forma_de_trabajo.mdc: implementer vs QA separation                | Adapt                         | Prefer sufficiently independent verification for high-risk work; mechanism may be CI, human review, deterministic verifier or isolated verification-agent pass. |
| Historical forma_de_trabajo.mdc: root-cause debugging                        | Adopt                         | Reproduce -\> isolate -\> classify owning artifact -\> minimum repair -\> regression evidence.                                                                  |
| Historical forma_de_trabajo.mdc: absolute DRY                                | Reject / replace              | Prefer simplicity and stable semantic reuse; avoid premature abstractions that collapse distinct business/security semantics.                                   |
| Cursor/Claude persistent instruction mechanics                               | Adopt as adapter architecture | Canonical docs -\> concise root agent contract -\> path-scoped rules -\> Skills/playbooks -\> deterministic hooks/tests/CI.                                     |

# Appendix B - Preliminary current-repo document role map

| **Source-state precision (updated at v0.4.0). Both agent-instruction layers are now tracked: a root `AGENTS.md` repo-wide operating contract with a root `CLAUDE.md` adapter (`@AGENTS.md`), and the app-scoped `apps/web/AGENTS.md` + `apps/web/CLAUDE.md` pair. The earlier note that no root-level files had been verified described an older snapshot and no longer holds. The methodology's recommendation is now to preserve the separation between the two layers — see Section 11.2.** |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

This map was intentionally preliminary and has now been followed by the dedicated Gu OS Documentation & Agent Context Architecture Audit v0.1. Use that audit for role, supersession and target-location decisions; do not use this preliminary table by itself to rename, move or delete files.

| **Artifact**                               | **Provisional role**                                 | **Recommendation**                                                                                                                                                                             |
|--------------------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| docs/README.md                             | Documentation authority/index                        | Keep canonical; update later with PRD/Methodology/Doctrine locations.                                                                                                                          |
| docs/brief.md                              | Historical initial personal/business agent MVP brief | Retain as provenance for now; likely superseded for product intent by future PRD; audit links before moving.                                                                                   |
| docs/plan.md                               | Historical/evolutionary implementation plan          | Retain as history/provenance; not the modern product roadmap or PRD.                                                                                                                           |
| docs/architecture.md                       | Concise implemented-runtime technical overview       | Keep as implemented reality overview; title/legacy framing may need later cleanup.                                                                                                             |
| docs/manuals/architecture-manual.md        | Integrated current/target architecture               | Keep canonical architecture map.                                                                                                                                                               |
| Topic-specific technical plans             | Accepted target design by topic                      | Keep; subordinate implementation work to these where marked governing.                                                                                                                         |
| ADRs                                       | Cross-cutting accepted decisions                     | Keep and expand as needed.                                                                                                                                                                     |
| Principle Mining Registry v0.3             | Evidence-rich adjudicated principle inventory        | Evidence/provenance source for the canonical concise Doctrine; not product truth.                                                                                                             |
| Agentic Architecture Primer v0.2           | Pedagogical mental model                             | Keep educational/reference; not governing implementation source.                                                                                                                               |
| Gu/Gu OS PRD                               | Product intent                                       | Canonical product artifact at `docs/product/PRD.md`.                                                                                                                                           |
| This Methodology                           | How product/software is designed and developed       | New canonical development-process artifact after approval.                                                                                                                                     |
| Principles & Design Doctrine               | Canonical decision principles                        | Canonical decision doctrine at `docs/principles/gu-os-principles-and-design-doctrine.md`.                                                                                                     |
| AGENTS.md (root)                           | Tracked repo-wide coding-agent operating contract    | Keep concise and stable; it carries monorepo-wide rules and links to canonical docs rather than duplicating them. Aligning its artifact-chain and planning wording with v0.4.0 is an open follow-up (Sections 11.2, 22, 23). |
| CLAUDE.md (root) = @AGENTS.md              | Tracked root Claude Code adapter                     | Keep. It imports the root contract and avoids duplicate instructions.                                                                                                                          |
| apps/web/AGENTS.md                         | Tracked app-scoped coding-agent instruction contract | Keep in apps/web. Verify/update its web-specific pointers during audit; do not promote the same content to root, and do not restate root-wide rules here.                                      |
| apps/web/CLAUDE.md = @AGENTS.md            | Tracked Claude Code adapter for apps/web             | Keep. It cleanly imports the adjacent app-scoped AGENTS.md and avoids duplicate instructions.                                                                                                  |
| .cursor/rules/\*.mdc / .claude/rules/\*.md | Path-scoped or IDE-specific agent rules              | Use only for contextual instructions that should not live always-on; do not fork canonical product/architecture truth into IDE-specific copies.                                                |
