# Gu OS documentation map

This index defines where architectural decisions live. Documents marked as plans describe target architecture and may name components that do not exist yet; verify their status legend before treating them as runtime behavior.

## Authority order

When documents appear to disagree, use this order:

1. Current migrations, code, and `docs/architecture.md` for implemented behavior.
2. `manuals/architecture-manual.md` for the integrated current/target architecture.
3. The topic-specific canonical plan below for accepted target design.
4. Roadmaps for sequencing.
5. Reference analyses and historical plans for context only.

An accepted target is not implemented merely because it has a proposed schema. Topic plans must label current, target, tentative, and open decisions explicitly.

## Canonical documents by topic

| Topic | Canonical document | Role |
| --- | --- | --- |
| Current stack and migrations | [`architecture.md`](architecture.md) | Concise description of implemented runtime |
| Integrated architecture | [`manuals/architecture-manual.md`](manuals/architecture-manual.md) | Main map of current and future subsystems |
| Product sequencing | [`business-brain-evolution-roadmap.md`](business-brain-evolution-roadmap.md) | V1–V4 roadmap and locked defaults |
| Brain / organizational cognition | [`brain/gbrain-evaluation-and-plan.md`](brain/gbrain-evaluation-and-plan.md) | Detailed Brain Layer design and implementation blocks |
| Business Brain vs platform improvement | [`brain/business-and-platform-brain-boundary.md`](brain/business-and-platform-brain-boundary.md) | Shared 7-layer model, scope boundary and governed internal learning |
| Personal long-term memory | [`memory/long_term_memory_plan.md`](memory/long_term_memory_plan.md) | Personal memory extraction and retrieval |
| Operational cases | [`operational-cases/architecture.md`](operational-cases/architecture.md) | Multi-day case runtime |
| Flexible workflows | [`manuals/gu-os-flexible-workflows-technical-plan.md`](manuals/gu-os-flexible-workflows-technical-plan.md) | Case, work, impact, verification, compiler, and UI planes |
| Workflow Studio and Pattern Kernel | [`workflow-studio/README.md`](workflow-studio/README.md) | NL authoring, provider capabilities, solution-pattern composition and coverage |
| Operational readiness | [`operational-cases/testing-framework.md`](operational-cases/testing-framework.md) | N0–N5 tests and activation quality bar |
| Skills and tools | [`skills-tools-architecture.md`](skills-tools-architecture.md) | Skill registry, tools, authoring, and HITL |
| Files and attachments | [`tools-design/file-attachments-and-document-skills.md`](tools-design/file-attachments-and-document-skills.md) | Private file storage and document lifecycle |
| Knowledge ownership | [`manuals/knowledge-scope-and-ownership.md`](manuals/knowledge-scope-and-ownership.md) | Platform, industry, organization, team, and user scopes |
| AI-native improvement loops | [`manuals/ai-native-loops.md`](manuals/ai-native-loops.md) | Observe–decide–act–evaluate–learn contract |
| External agentic principles | [`manuals/agentic-principles-alignment.md`](manuals/agentic-principles-alignment.md) | Mapping external patterns to Gu OS |
| Architectural decisions | [`adr/README.md`](adr/README.md) | Short decision records and reevaluation criteria |

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
- Postgres stores metadata, permissions, provenance, indexes, operational state, and distilled Brain knowledge.
- BigQuery/CRM remains authoritative for transactional business records where declared.
- Markdown is a machine-readable representation and portability format; it is not the universal source of truth.
- Skills encode how to act. Brain knowledge encodes what is known. Cases encode what is happening.

See the integrated pipeline in `manuals/architecture-manual.md` and its detailed Brain implementation in `brain/gbrain-evaluation-and-plan.md`.

## Scope vocabulary

Do not collapse these dimensions:

- Skill `scope: business | personal | shared` describes the type of work.
- Knowledge ownership `platform | industry | organization | team | user` describes who owns and may see knowledge.
- Workflow `owner_scope` describes ownership of a workflow definition.
- `industry` and `domain_tags` are catalog metadata, not authorization.
- A tenant boundary is an isolation boundary; a role or team is not a tenant.

## Status vocabulary

- **Implemented**: present in migrations/code and usable under its documented flags.
- **Partial**: some runtime pieces exist, but the end-to-end capability does not.
- **Target**: accepted direction, not necessarily implemented.
- **Tentative**: proposed names or schema requiring implementation validation.
- **Open**: requires a product/domain decision.
- **Reference**: external or historical analysis; not authoritative Gu OS behavior.

## Historical and reference material

`plan.md`, `brief.md`, external reference analyses, and research PDFs remain useful context but do not override the canonical documents above. When an external pattern is adopted, its Gu OS-specific decision belongs in an ADR or a canonical topic plan rather than only in the research note.
