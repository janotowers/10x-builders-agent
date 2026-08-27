# Gu OS architectural decision records

ADRs capture cross-cutting decisions that should not remain buried in long plans. Topic plans retain implementation detail.

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-100](ADR-100-hybrid-knowledge-storage.md) | Hybrid raw/index/Brain storage; Markdown is a representation | Accepted direction |
| [ADR-101](ADR-101-organization-tenancy.md) | Historical user-scoped → organization-native target decision; superseded by ADR-106 | Superseded |
| [ADR-102](ADR-102-knowledge-ownership-scopes.md) | Platform/industry/organization/team/user ownership dimension | Accepted direction |
| [ADR-103](ADR-103-hybrid-retrieval.md) | Hybrid retrieval plus generated indexes; no index-only product | Accepted direction |
| [ADR-104](ADR-104-governed-improvement.md) | Improvement authority is target-specific and gated | Accepted direction |
| [ADR-105](ADR-105-shareable-regenerable-views.md) | Share views, not duplicate truth; software may be situational under constraints | Accepted direction |
| [ADR-106](ADR-106-organization-native-multiseat-tenancy.md) | Organization-native multi-seat tenancy with legacy identity bridge | Accepted direction |
| [ADR-107](ADR-107-runtime-conversation-authority.md) | Runtime, conversation and approval authority during brownfield migration | Accepted direction |

Status meanings:

- **Accepted direction:** architectural constraint for target design; implementation may still be pending.
- **Implemented:** verified in current code/migrations.
- **Superseded:** retained for history with a link to the replacement.

Workflow-specific ADRs live under [`../manuals/adr/`](../manuals/adr/); the `100+` range here avoids claiming those numbers. Current records include [ADR-0001 — Durable work roots](../manuals/adr/0001-durable-work-roots.md) and [ADR-0011 — Governed hybrid storage for private skill packages](../manuals/adr/0011-skill-package-interoperability.md).
