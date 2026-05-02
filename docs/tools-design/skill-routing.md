# Skill routing architecture

This document records why the agent currently uses a **pre-graph skill selector**
instead of a Claude Code-style "main model loads skills directly" flow, what the
trade-offs are, and how we intend to evolve it before adding many more skills.

The context for this decision is the `company-data` skill and BigQuery: it is not
only a formatting playbook. When it is active, the runtime also injects tenant
context and scopes the tool surface so the model can query business data safely.

---

## Current flow

For a normal chat turn, `runAgent` does the following before compiling the
LangGraph loop:

1. Loads recent session messages (`priorRaw`) for short-term context.
2. Loads the global skill registry (`skills/global/*/SKILL.md` metadata).
   In V1.5 this registry also feeds a user-visible Settings catalog; the
   runtime still treats the repo metadata as the canonical standard catalog.
3. Runs a small, deterministic **skill selector** model
   (`createSkillSelectorModel`, default `anthropic/claude-3-5-haiku` via
   OpenRouter).
4. If a skill is active:
   - resolves and injects the skill playbook into the initial system prompt;
   - injects `[Contexto de tenant]` when `requires_tenant_context` is true;
   - filters/annotates tools through `buildLangChainTools`;
   - logs `[SKILL SELECTION]` and `[TENANT CONTEXT]` in
     `packages/agent/logs/turn_summary.log`.
5. The main agent model (`openai/gpt-4o-mini` by default) receives the resulting
   prompt and available tools, then decides which tool calls to make.

So there are two separate model responsibilities:

| Stage | Model | Responsibility |
|-------|-------|----------------|
| Skill selector | Small deterministic model | Classify the turn into one skill or `none`. |
| Main agent | Main chat model | Answer, call tools, handle tool results, produce final text. |

The current contract is intentionally **single-label**: one dominant skill per
turn, or `none`. Composite skills are still possible, but they are explicit
playbooks that resolve to one active context block. Dynamic multi-skill output
such as `skills: ["company-data", "presentation"]` is a future design, not V1.

Before selection, the candidate list should eventually be filtered by
per-account skill settings (`user_skill_settings.enabled`) and by hard runtime
availability (for example, document skills that require attachment tools should
not be candidates until those tools/storage paths exist). The selector should
only choose from skills the account can actually use.

---

## How this differs from Claude Code / Anthropic Skills

Anthropic's documented Agent Skills pattern is also based on **progressive
disclosure**:

- Skills live as directories with `SKILL.md` metadata and instructions.
- The skill `description` tells Claude when the skill is relevant.
- The model sees a list of available skills/descriptions.
- The full skill instructions and supporting files are loaded only when needed.
- Multiple capabilities can compose for complex workflows, but the practical
  recommendation is still to avoid loading irrelevant skill bodies.

The important difference is **where the decision happens**.

| Aspect | Current implementation | Claude Code-style approach |
|--------|------------------------|----------------------------|
| Decision maker | Separate pre-graph selector model. | Main model decides whether to load a skill. |
| Context visible to decision | Currently small: skill metadata plus current turn, plus selected continuity signals. | Full conversation context visible to the main model. |
| Extra model call | Yes, selector call before the agent call. | No separate selector call for the initial decision. |
| Prompt size | Main prompt includes only the selected skill body. Selector sees only metadata. | Main prompt includes skill listing/metadata and later loaded skill body. |
| Follow-up understanding | Weak if selector sees only the latest fragment (`"y en febrero?"`). Must pass continuity context. | Stronger by default because main model sees conversation history. |
| Determinism / auditability | High: selection is JSON, temperature 0, logged independently. | More fluid, but selection is mixed into the main agent loop. |
| Tool scoping | Strong: active skill can narrow/annotate tools before `bindTools`. | Needs additional runtime design if tool availability must change after skill load. |
| Tenant context | Injected before BigQuery can run when `company-data` is active. | Must be enforced carefully if skill loading happens inside the main loop. |
| Failure mode | Selector may return `none` if under-contextualized. | Main model may over-load skills or mix domain instructions when not needed. |

This means many benefits often associated with "our selector" are also benefits
of Claude Code-style skills: progressive disclosure, not loading every
`SKILL.md`, and using skill descriptions for discoverability. The real trade-off
is **control and auditability vs. contextual fluency**.

---

## Skill composition strategy

The near-term strategy is intentionally incremental:

1. **One dominant skill per turn by default.** Most requests belong to one
   coherent procedure. For example, `"cuantos leads tuvimos en abril?"` should
   select `company-data`, not a set of micro-skills.
2. **Use internal subdomains before micro-skills.** When one domain has many
   patterns but shared safety rules, keep a single skill and organize reference
   files inside it. `company-data` is the canonical example: tenant filtering,
   parameterized SQL, read-only validation, timezone rules, and output
   auditability live in the main skill, while `references/fewshots-leads.md`,
   `references/fewshots-messages.md`, `references/joins.md`, etc. hold
   narrower query examples.
3. **Prefer explicit composite skills before dynamic multi-skill routing.** A
   named workflow such as `business-report` can include `company-data` plus
   report-formatting guidance. The selector still chooses one active skill, but
   the resolved playbook expands intentionally.
4. **Use configured global skills before custom DB-authored skills.** A skill
   such as `brand-kit` can be global and versioned in Git while reading
   account-specific values from `business_brain.brand` or
   `user_skill_settings.config_json`. This gives tenant-specific behavior
   without letting arbitrary per-account skill bodies into the runtime yet.
5. **Stage document/file skills behind attachment tools.** Skills such as
   `pdf`, `xlsx`, `docx`, and `pptx` should not be selected unless the account
   has the necessary storage, attachment, and file-operation tools enabled.
   Their descriptions should say when to use them, but runtime availability
   should still be enforced outside the model.
6. **Defer free-form multi-skill selection.** Letting the selector return
   arrays like `["company-data", "presentation"]` requires conflict handling,
   token caps, tool-union rules, tenant-context propagation, permission
   checks, and richer logs. It should wait until real usage proves that
   dominant skills and explicit composites are insufficient.

This mirrors the useful part of Anthropic's Skills model (progressive
disclosure and composable capabilities) while preserving the runtime invariants
we need for multi-tenant data access.

### When to use each mechanism

| Mechanism | Use when | Avoid when |
|-----------|----------|------------|
| Dominant skill | One procedure owns the turn; shared guardrails are important. | The task is pure chitchat or a one-shot tool lookup that needs no playbook. |
| Internal references | A domain has multiple sub-areas with the same tools/safety rules. | Sub-areas have different permissions, side effects, or conflicting instructions. |
| Configured global skill | The playbook is standard but values vary by account, e.g. brand voice/colors/assets. | The entire procedure is truly custom for one account and needs versioned editing. |
| Explicit composite | A recurring named workflow truly combines multiple coherent playbooks. | The combination is one-off or can be handled by a single domain skill. |
| Document/file skill | The user asks to read, inspect, create, or modify an uploaded/generated file and the required file tools exist. | The file only lives on the user's computer and has not been uploaded or connected. |
| Subagent | Work needs isolation, long research, parallelism, a different model/tool set, or should not contaminate the main thread. | A simple inline procedure with the same context and tools is enough. |
| Dynamic multi-skill | Future option for repeated complex requests that cannot be modeled above. | V1/V2 data-sensitive workflows where tenant/tool scoping must stay simple. |

---

## Registry, toggles, and visibility

The skill registry should become visible to users, but the runtime still needs a
server-owned source of truth.

| Layer | Role |
|-------|------|
| Global registry | Repo files under `skills/global/<slug>/SKILL.md`; standard catalog, versioned in Git, loaded by the server. |
| Visible catalog | Settings view showing name, description, `scope`, required tools/integrations, availability, enabled state, and optional config summary. |
| Account settings | `user_skill_settings` rows with `enabled` and optional `config_json`, analogous to `user_tool_settings`. |
| Custom account skills | Future V2 `account_skills` with draft/active/versioning/test harness. |

Selection should use the **effective candidate set**, not the raw global list:

1. Start with global registry metadata.
2. Apply hard runtime gates (for example missing storage/file tools).
3. Apply account settings (`enabled=false` removes a skill).
4. Send the remaining skill names/descriptions plus structured
   `routingContext` to the selector.
5. Resolve the selected skill and bind only its allowed tools.

This keeps the selector prompt small and avoids asking the model to pick skills
that cannot run safely.

---

## Document/file skills and routing

Document skills are high value, but they add one more routing constraint: the
file must be available to the backend. The web app cannot read arbitrary local
files from a user's computer; files must be uploaded, connected through a future
storage integration, or created by the assistant.

For routing:

- `pdf`, `xlsx`, `docx`, and `pptx` should be **global shared skills** by
  default because they can serve both business and personal workflows.
- Their `description` should mention concrete triggers: file extensions,
  "spreadsheet", "deck", "slides", "Word document", "PDF contract", etc.
- Their `allowed_tools` should use attachment/document tools, not the existing
  server-workspace `read_file` / `write_file` tools.
- They should be hidden, disabled, or marked `staged` in Settings until the
  attachment lifecycle exists.
- If a user asks about a file that is only on their local machine, the assistant
  should ask them to upload it or connect a storage integration; it should not
  pretend it can read local paths from the browser environment.

See [`docs/tools-design/file-attachments-and-document-skills.md`](file-attachments-and-document-skills.md)
for the proposed storage and tool architecture.

---

## Why we did not start with a Claude Code-style runtime

The V1 implementation chose pre-graph selection because the existing runtime
already builds and binds the tool list before LangGraph starts. Selecting a skill
at that point let us make a small, safe change:

- append the selected playbook to the first `SystemMessage`;
- filter tools before `model.bindTools(lcTools)`;
- add tenant context before BigQuery can execute;
- preserve the existing `agent -> tools -> compaction -> agent` loop;
- log the selection and tenant context in a dedicated, easy-to-debug section.

A Claude Code-style runtime is still a valid future direction, but it is not a
drop-in swap. It would require a dynamic "Skill tool" or equivalent inside the
agent loop, plus a clear answer for when and how to:

- inject tenant context after skill load but before sensitive tool execution;
- restrict or re-bind tools mid-turn;
- prevent BigQuery queries before tenant context is known;
- log skill activation with enough operational clarity;
- recover from a skill load decision that happens after an initial response or
  tool call.

For generic document or coding skills, that dynamic model is attractive. For
multi-tenant business data, the runtime needs stronger invariants.

---

## Why not give the selector the whole prompt?

Passing the full prompt/history to the selector would reduce ambiguity, but it
has costs:

- duplicates token usage: the selector would pay for much of the same context
  the main model will see moments later;
- adds latency before every turn;
- exposes the selector to noisy or stale assistant responses;
- makes routing harder to debug because the input is huge and often contains
  conflicting signals;
- still does not guarantee correct tool use, because the main model must execute
  the query after selection.

The preferred compromise is **structured continuity context**, not the full
prompt. The selector should see enough state to resolve fragments without being
buried in raw history:

```json
{
  "currentMessage": "y en febrero?",
  "lastActiveSkill": "company-data",
  "lastBusinessDomain": "leads",
  "lastMetric": "count",
  "lastPeriod": "abril 2026",
  "lastTenantName": "Alebrixe",
  "recentSummary": "User asked for lead counts by month; last answer was April leads."
}
```

With this, `"y en febrero?"` is no longer ambiguous: it means the same skill,
domain, metric, and tenant, with a new period.

---

## Implemented evolution: structured `routingContext`

During BigQuery testing, short messages like `"y en abril?"` and
`"y en febrero?"` produced `active=none reason=model_returned_none` because the
selector only saw the latest fragment. The assistant then answered from history
instead of calling BigQuery, which is fast but not auditable.

The current implementation now derives a structured `routingContext` from recent
turns before calling `selectSkillForTurn`. The selector receives this context
alongside the latest user message, so it can resolve continuation fragments
without reading the full prompt or raw history.

The context includes:

- `currentMessage`
- `isContinuation`
- `lastActiveSkill`
- `lastDomain`
- `lastMetric`
- `lastPeriod`
- `lastTenantName`
- `recentTurnSummary`
- `evidence`
- `confidence`

If the selector still returns `none` while the structured context has high
confidence, the runtime can route using `reason=routing_context`.

`follow_up_month` remains as a narrower fallback:

- If the current message is only a month follow-up (`"y en marzo?"`, `"abril"`,
  etc.),
- and recent messages clearly suggest company-data metrics (for example,
  `leads`, `Total de leads`, `leads creados`, KPI language),
- then route to `company-data` with reason `follow_up_month`.

This fallback is intentionally conservative and logged as a distinct reason. It
should not become the long-term routing strategy for all skills.

---

## Recommended next evolution

Before adding many more skills, continue evolving routing from a BigQuery-aware
context into a general **conversation-state router**:

1. Persist or derive `routingContext` for every turn, not only from recent raw
   messages.
2. Broaden fields such as:
   - `lastActiveSkill`
   - `lastDomain`
   - `lastMetric`
   - `lastPeriod`
   - `lastTenantName`
   - `lastToolNames`
   - `recentTurnSummary`
3. Add domain-specific extractors for new skills as they appear.
4. Filter selector candidates by account skill settings and runtime
   availability before calling the selector.
5. Keep the selector prompt small and deterministic.
6. Keep hard safety checks in the tool adapters, especially for tenant filters,
   attachment ownership, and generated-file writes.
7. Treat regex heuristics as fallback or bootstrapping only.
8. Keep selection single-label until explicit composite skills and internal
   references have been exhausted as simpler mechanisms.

This keeps the strongest part of the current implementation (tool scoping,
tenant invariants, logs) while addressing the biggest weakness (myopic
selection on follow-ups).

---

## When to reconsider a Claude Code-style design

Revisit a main-model skill-loading architecture if any of these become true:

- The number of skills grows and pre-routing logic becomes hard to maintain.
- Follow-up handling remains brittle even with structured routing context.
- We need skills that are mostly conversational/procedural and do not require
  strict pre-bound tool scoping.
- Document/file skills become mostly generic and safe enough that dynamic
  skill-loading would simplify the user experience without weakening storage
  isolation.
- We repeatedly need more than one independently authored skill in the same
  turn, and explicit composites become too rigid.
- We implement a safe dynamic skill loader that can inject tenant context and
  update tool availability before any sensitive tool call.

Even in that future design, tenant and SQL safety should remain enforced in
tool adapters. The model should be guided by skills, but the runtime should
still enforce the invariants that protect cross-tenant data.
