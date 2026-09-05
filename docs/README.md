# Gu OS documentation map

This index defines **which artifact owns which kind of truth** across Gu / Gu OS.

Gu OS documentation is intentionally layered. A Product PRD, a Feature / Business Spec, an ADR, a Technical Plan, code and verification evidence can all describe the same initiative without being competing sources of truth, because they answer different questions.

When two documents appear to disagree, first determine whether they are trying to own the same type of truth. If they are not, reconcile the layers rather than applying a single global precedence rule.

## Authority by question

| Question | Primary authority | Notes |
| --- | --- | --- |
| What product are we building, for whom and why? | [`product/PRD.md`](product/PRD.md) | Product intent, category, target users, product model, scope/non-goals, major journeys and success direction. |
| How is durable product responsibility organized? | [`product/PRD.md`](product/PRD.md) §7.2 Operating domains | Gu OS's concrete mapping of the **optional** generic Product Area / Product Responsibility concept. Enduring business-semantic overlays, not independent runtime engines, and not a structure the Development Methodology requires of other products. |
| What recurring values, principles, invariants and design rules guide decisions? | [`principles/gu-os-principles-and-design-doctrine.md`](principles/gu-os-principles-and-design-doctrine.md) | Canonical Product / Architecture / AI / UX / security decision doctrine. |
| How do humans + coding agents design, build, verify, release and evolve Gu OS? | [`development/agentic-product-software-development-methodology.md`](development/agentic-product-software-development-methodology.md) | Development lifecycle, artifact ownership, human gates and evidence discipline. |
| Why should a bounded coordination effort exist now? | Initiative Brief, where one is useful | **Optional** framing artifact. An Initiative is not a Product Area / Product Responsibility, not a Roadmap Increment and not a Spec, and there is no mandatory chain through it. A Roadmap Increment normally supplies enough bounded framing on its own, so create the Spec directly; add an Initiative only when it represents a coordinated outcome the increment does not already represent. |
| What must a consequential feature / business capability do? | Approved Feature / Business Spec | Behavior truth: scope/non-goals, actors, state/decision rules, happy/unhappy paths, evidence and acceptance scenarios. Owns intended behavior regardless of whether an Initiative frames it, and may be proved across several Slices. |
| What architecture decision is binding? | Accepted ADR + relevant canonical architecture/topic source | ADRs record consequential decisions; topic sources preserve broader design context. |
| How is approved behavior intended to be realized? | Current Implementation Spec / Technical Plan | Repo-grounded implementation intent; should translate governing sources rather than silently redesign them. |
| What is the execution work? | The Slice Plan (`slice-plan.md`) — normally one per Roadmap Increment | Durable Slice contracts: ordered, bounded, independently verifiable increments with inspectable outcome, acceptance traceability, Definition of Done, Release Scope, estimate and readiness. It integrates the Slices realizing one increment; it is not created per Spec / ADR / Technical Plan, since one Slice is often governed by several of those. Implementation Tasks are derived just in time by the coding agent and are not Markdown truth. |
| What is the agent doing right now, before a PR exists? | Agent runtime / coding environment | The just-in-time Task plan and the current pre-PR implementation and local-verification context. Not recorded anywhere else, and not canonical Markdown truth. |
| What has execution actually produced and recorded? | GitHub | Branch, commits, PR, CI results, merge state, Actions runs, environment approvals and the deployment evidence GitHub itself generates. Repo documents do not mirror execution state. |
| Where is everything at a glance? | **No single current authority.** Live development state is split across the rows above: the Slice Plan holds durable contracts and readiness, the agent runtime holds pre-PR execution, GitHub holds recorded execution state. | A future Development Control Plane / Board would **project and orchestrate** across those authorities — READY Horizon, Cycle proposal and inclusion, confirmed Accountable / DRI, blockers and Needs Human Attention, dependency conflicts, increment graduation status, calibration learning and next-legitimate-action visibility — without owning any of the underlying truth. **It does not exist today**, and until it does, ask each authority directly rather than expecting one consolidated view. Conceptual only; see Development Methodology §19.1. |
| What actually runs now? | Current code, migrations/config + [`architecture.md`](architecture.md) | Implemented reality. Proposed schema in a plan is not implemented behavior. |
| Is the implementation correct / ready? | Tests, evals, replay/simulation, readiness and release evidence | Verification truth; an agent saying “done” is not evidence. |
| What should happen next and in what sequence? | [`roadmap/gu-os-evolution-roadmap.md`](roadmap/gu-os-evolution-roadmap.md) | Strategic sequencing truth: **Roadmap Increments** (Gu OS's R-numbered horizons), what must exist before the proof is credible, evidence gates, the **graduation evidence** that closes an increment, and deliberately deferred work. A Roadmap Increment may pull work from several product responsibilities and shared/core capabilities. Roadmap behavior is not owned by Specs or Slice Plans, and completing every planned Slice does not graduate an increment. |
| What should change after outcomes / incidents? | Versioned change to the artifact that owns the defect | Follow the governed improvement loop; do not let implementation drift become new truth silently. |

## Technical authority within the same question

When **technical sources are actually competing for the same truth**, use these rules:

1. **Implemented behavior:** current migrations, code/config and [`architecture.md`](architecture.md).
2. **Accepted consequential decision:** the applicable accepted ADR, unless superseded.
3. **Integrated current/target architecture:** [`manuals/architecture-manual.md`](manuals/architecture-manual.md).
4. **Topic-specific accepted target design:** the canonical topic plan/source listed below.
5. **Implementation sequencing:** current Technical / Detailed Implementation Plan for that topic.
6. **Product sequencing:** [`roadmap/gu-os-evolution-roadmap.md`](roadmap/gu-os-evolution-roadmap.md).
7. **Reference analyses / external material / superseded plans:** context and provenance only.

A later implementation can invalidate an outdated Technical Plan, but it cannot silently redefine product intent, intended behavior, a still-active invariant or an accepted architecture decision. Reconcile the owning artifact explicitly.

## Canonical documents by topic

| Topic | Canonical document | Role |
| --- | --- | --- |
| Product intent | [`product/PRD.md`](product/PRD.md) | Gu / Gu OS product truth: why, for whom, scope, product model, domains and success direction |
| Principles & design doctrine | [`principles/gu-os-principles-and-design-doctrine.md`](principles/gu-os-principles-and-design-doctrine.md) | Values → principles → invariants → patterns → decision/mechanism/evidence discipline |
| Development methodology | [`development/agentic-product-software-development-methodology.md`](development/agentic-product-software-development-methodology.md) | Human + coding-agent development lifecycle and artifact governance |
| Development & release execution | [`development/release-path-playbook.md`](development/release-path-playbook.md) | Operational playbook: migration eras, CI, staging delivery, hosted verification, production release path |
| Development authoring scaffolds | [`development/templates/README.md`](development/templates/README.md) | Canonical templates for the Feature / Business Spec and the per-Roadmap-Increment Slice Plan; scaffolds only, never a second source of truth |
| Product sequencing | [`roadmap/gu-os-evolution-roadmap.md`](roadmap/gu-os-evolution-roadmap.md) | Current Gu OS sequencing, dependencies, graduation evidence and deferred horizons |
| Current stack and migrations | [`architecture.md`](architecture.md) | Concise description of implemented runtime |
| Integrated architecture | [`manuals/architecture-manual.md`](manuals/architecture-manual.md) | Main map of current and future subsystems |
| Experience Architecture / Agentic UX | [`manuals/gu-os-experience-architecture.md`](manuals/gu-os-experience-architecture.md) | Cross-domain Design System, Semantic Interaction, Contextual Views/Artifacts, identity, adaptive/generative Experience, cross-surface continuity, personalization and Experience governance |
| Brain / organizational cognition | [`brain/gbrain-evaluation-and-plan.md`](brain/gbrain-evaluation-and-plan.md) | Detailed Brain Layer design and implementation blocks; not the parent product roadmap |
| Business Brain vs platform improvement | [`brain/business-and-platform-brain-boundary.md`](brain/business-and-platform-brain-boundary.md) | Shared 7-layer model, scope boundary and governed internal learning |
| Personal long-term memory | [`memory/long_term_memory_plan.md`](memory/long_term_memory_plan.md) | Personal memory extraction and retrieval |
| Operational cases | [`operational-cases/architecture.md`](operational-cases/architecture.md) | Multi-day Case runtime and operational responsibility |
| Flexible workflows | [`manuals/gu-os-flexible-workflows-technical-plan.md`](manuals/gu-os-flexible-workflows-technical-plan.md) | Case, Work, Impact, verification, compiler and UI planes |
| Workflow Studio and Pattern Kernel | [`workflow-studio/README.md`](workflow-studio/README.md) | NL authoring, provider capabilities, solution-pattern composition and coverage |
| Operational readiness | [`operational-cases/testing-framework.md`](operational-cases/testing-framework.md) | N0–N5 tests and activation quality bar |
| Skills and tools | [`skills-tools-architecture.md`](skills-tools-architecture.md) | Skill registry, tools, authoring, execution and HITL boundaries |
| Files and attachments | [`tools-design/file-attachments-and-document-skills.md`](tools-design/file-attachments-and-document-skills.md) | Private file storage and document lifecycle |
| Knowledge ownership | [`manuals/knowledge-scope-and-ownership.md`](manuals/knowledge-scope-and-ownership.md) | Platform, industry, organization, team and user scopes |
| AI-native improvement loops | [`manuals/ai-native-loops.md`](manuals/ai-native-loops.md) | Observe → Decide → Act → Evaluate → Learn and governed change |
| External agentic principles | [`manuals/agentic-principles-alignment.md`](manuals/agentic-principles-alignment.md) | Reference mapping of external patterns to Gu OS; not implementation authority |
| Architectural decisions | [`adr/README.md`](adr/README.md) | Short accepted decision records and reevaluation criteria |

## Artifact lifecycle

For consequential product work, the default chain is:

```text
Discover / Clarify
  -> Product PRD / parent intent
  -> Initiative Brief (when useful)
  -> Feature / Business Spec
  -> Architecture Analysis / ADR (when needed)
  -> Implementation Spec / Technical Plan
  -> Slice Plan (Vertical Slices)
  -> Just-in-time agent Tasks
  -> Implement
  -> Verify / Classify / Repair
  -> Review / Approve
  -> Release Safely
  -> Observe / Learn / Evolve
```

This is **not a waterfall**. Evidence can send the work back to the artifact that owns the defect. Different artifacts do not imply a human approval gate at every boundary; human review is proportional to consequence, as defined by the Development Methodology.

The chain sits inside strategic sequencing: the **Roadmap Increment** decides what should be proven next and declares the evidence that graduates it. The **Initiative Brief** step is optional — a Spec may be created directly under product and roadmap context. Neither an Initiative nor a Product Area / Product Responsibility is a required layer of the method; Gu OS's Operating Domains are its concrete application of the latter.

Humans plan at **Vertical Slice** level and hold accountability there; the coding agent derives Tasks at execution time. Selecting a Slice into an Execution Cycle schedules already-approved work — it is not an additional approval gate.

The chain is traversed **continuously**: the development system identifies the next legitimate action — execution, prerequisite work, verification, repair, READY-Horizon replenishment, a Cycle proposal, artifact refinement, increment-graduation evaluation, next-increment preparation or escalation — and stops only at a genuine human-authority boundary. See the Development Methodology's Development Continuity Loop.

## Five-plane knowledge pipeline

```text
raw evidence
  -> parsing and normalization
  -> chunks and indexes
  -> distilled knowledge
  -> artifacts, views, and actions
  -> outcomes and governed learning
```

- Original bytes remain immutable in private object storage or in their authoritative external system.
- Postgres stores metadata, permissions, provenance, indexes, operational state and distilled Brain knowledge.
- BigQuery/CRM remains authoritative for transactional business records where declared.
- Markdown is a machine-readable representation and portability format; it is not the universal source of truth.
- Skills encode how to act. Brain knowledge encodes what is known. Cases encode what is happening.

See the integrated pipeline in [`manuals/architecture-manual.md`](manuals/architecture-manual.md) and detailed Brain design in [`brain/gbrain-evaluation-and-plan.md`](brain/gbrain-evaluation-and-plan.md).

## Scope vocabulary

Do not collapse these dimensions:

- Skill `scope: business | personal | shared` describes the type of work.
- Knowledge ownership `platform | industry | organization | team | user` describes who owns and may see knowledge.
- Workflow `owner_scope` describes ownership of a workflow definition.
- `industry` and `domain_tags` are catalog metadata, not authorization.
- A tenant boundary is an isolation boundary; a role or team is not a tenant.
- Product operating domains (Property, Demand, Relationship, Transaction, Network/Ecosystem) are business-semantic overlays, not independent runtime engines.
- Shared / core capabilities — organization / tenancy / identity, Cases, Work Plane, Skills / Tools, governance / authority, memory / context, Brain — are **cross-cutting**, not operating domains. A Roadmap Increment may pull the minimum shared capability it needs without that capability becoming another domain.
- An **Initiative** is a bounded coordination frame, not an operating domain, not a Roadmap Increment and not a Spec. It is optional, and no Gu OS work currently requires a distinct Initiative layer.
- **A directory name is not evidence of semantic type.** `docs/product/initiatives/relationship-operations/` currently holds artifacts for the Relationship Operations **operating domain** and the `R1 — Relationship Operations v1` **Roadmap Increment** within it — not a bounded Initiative. That path predates the clarified taxonomy and is documentation debt pending reconciliation; no path is renamed by this change.

## Status vocabulary

### Architecture / capability status

- **Implemented:** present in migrations/code and usable under its documented controls/flags.
- **Partial:** some runtime pieces exist, but the end-to-end capability does not.
- **Target:** accepted direction, not necessarily implemented.
- **Tentative:** proposed names or schema requiring implementation validation.
- **Open:** requires a product/domain/architecture decision.
- **Reference:** useful analysis/context; not authoritative runtime behavior.

### Document / decision status

- **Canonical:** active authority for the type of truth named in its scope.
- **Accepted:** approved decision/direction inside its stated scope.
- **Superseded:** retained only as a redirect/provenance surface; no longer active authority.
- **Historical:** useful record of how the system/product evolved; does not govern current work.

## Superseded and historical material

- [`business-brain-evolution-roadmap.md`](business-brain-evolution-roadmap.md) is superseded for product sequencing by [`roadmap/gu-os-evolution-roadmap.md`](roadmap/gu-os-evolution-roadmap.md). Its historical content remains in Git history.
- `plan.md` and `brief.md` remain historical/reference context and do not override the Product PRD, current architecture or topic sources.
- External research, papers and reference analyses do not become Gu OS authority by citation alone. When adopted, the Gu OS-specific decision belongs in the Product PRD, Doctrine, Spec, ADR, canonical architecture source or Development Methodology according to the type of truth it owns.
