# Gu OS documentation map

This index defines **which artifact owns which kind of truth** across Gu / Gu OS.

Gu OS documentation is intentionally layered. A Product PRD, a Feature / Business Spec, an ADR, a Technical Plan, code and verification evidence can all describe the same initiative without being competing sources of truth, because they answer different questions.

When two documents appear to disagree, first determine whether they are trying to own the same type of truth. If they are not, reconcile the layers rather than applying a single global precedence rule.

## Authority by question

| Question | Primary authority | Notes |
| --- | --- | --- |
| What product are we building, for whom and why? | [`product/PRD.md`](product/PRD.md) | Product intent, category, target users, product model, scope/non-goals, major journeys and success direction. |
| What recurring values, principles, invariants and design rules guide decisions? | [`principles/gu-os-principles-and-design-doctrine.md`](principles/gu-os-principles-and-design-doctrine.md) | Canonical Product / Architecture / AI / UX / security decision doctrine. |
| How do humans + coding agents design, build, verify, release and evolve Gu OS? | [`development/agentic-product-software-development-methodology.md`](development/agentic-product-software-development-methodology.md) | Development lifecycle, artifact ownership, human gates and evidence discipline. |
| What must a consequential feature / business capability do? | Approved Feature / Business Spec for that initiative | Behavior truth: scope/non-goals, actors, state/decision rules, happy/unhappy paths, evidence and acceptance scenarios. |
| What architecture decision is binding? | Accepted ADR + relevant canonical architecture/topic source | ADRs record consequential decisions; topic sources preserve broader design context. |
| How is approved behavior intended to be realized? | Current Implementation Spec / Technical Plan | Repo-grounded implementation intent; should translate governing sources rather than silently redesign them. |
| What is the execution work? | Tasks / Vertical Slices | Ordered, bounded, independently verifiable work with Definition of Done and evidence. |
| What actually runs now? | Current code, migrations/config + [`architecture.md`](architecture.md) | Implemented reality. Proposed schema in a plan is not implemented behavior. |
| Is the implementation correct / ready? | Tests, evals, replay/simulation, readiness and release evidence | Verification truth; an agent saying “done” is not evidence. |
| What should happen next and in what sequence? | [`roadmap/gu-os-evolution-roadmap.md`](roadmap/gu-os-evolution-roadmap.md) | Sequencing, dependencies, evidence gates and deliberately deferred work. |
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
  -> Tasks / Vertical Slices
  -> Implement
  -> Verify / Classify / Repair
  -> Review / Approve
  -> Release Safely
  -> Observe / Learn / Evolve
```

This is **not a waterfall**. Evidence can send the work back to the artifact that owns the defect. Different artifacts do not imply a human approval gate at every boundary; human review is proportional to consequence, as defined by the Development Methodology.

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
