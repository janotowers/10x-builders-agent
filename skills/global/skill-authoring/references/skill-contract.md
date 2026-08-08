# Gu SKILL.md Contract

Use this reference when drafting, auditing, or repairing a Gu OS `SKILL.md`.

## Required Shape

Draft using exactly this shape, omitting optional fields only when not
applicable:

```markdown
---
name: kebab-case-name
description: What this skill does. Use when ... Do not use for ...
scope: business | personal | shared
allowed_tools:
  - tool_name
includes: []
requires_tenant_context: false
memory_extraction: ephemeral | default
heartbeat: native | compatible | blocked
guardrails: |
  Concrete, enforceable rules. Read-only by default. Name human decisions,
  authorization gates, evidence, and stop / escalate / no-action criteria.
---

# Title

## When to use / when not to use

## Workflow
Step-by-step procedure. Include stop conditions and escalation paths.

## Output
What the skill must produce. Include HITL gates.

## Gotchas
Concrete corrections to mistakes the agent will make without being told.
```

## Field Rules

Any FAIL blocks the draft.

- `name`: kebab-case, <=64 chars, only `[a-z0-9-]`, must not contain
  `anthropic` or `claude`, and must match the directory name.
- `description`: <=1024 chars, no XML tags, routing metadata only. It must say
  what the skill does, `Use when ...`, and `Do not use ...`. Prefer a concise
  single paragraph in a quoted one-line string. Do not put procedural bullets,
  step lists, tables, or the full workflow in frontmatter; those belong in the
  body.
- Frontmatter parser subset: plain or quoted scalars, arrays, and literal block
  scalar `|` only. Do not use `|-`, `|+`, `>`, `>-`, or `>+`.
- `scope`: `business` for tenant data; `personal` for individual user data;
  `shared` only when both apply with the same safety rules.
- `allowed_tools`: minimal and scoped. Every tool must exist in the catalog.
  Runtime only: appearing in `allowed_tools` does not make a tool N1-visible in
  Preparación operativa. Integration/action tools need N1; platform/domain
  `operational_case_*` tools belong in `allowed_tools` but are validated in
  N3/N4 technical detail; `operational_case_create` is `scenario_only`
  (intake/N0).
- `includes`: every slug must exist; no cycles; prefer composite skills for
  known multi-step procedures.
- `requires_tenant_context`: `true` when the skill reads or writes tenant data
  such as BigQuery, EasyBroker, account-specific configuration, brand kit, or
  `business_brain`. `false` otherwise.
- `memory_extraction`: `ephemeral` for transactional or operational skills
  whose turns must not feed long-term memory; `default` otherwise.
- `heartbeat`: `native` for proactive monitoring skills; `blocked` for skills
  that must only run on user or operational triggers; `compatible` otherwise.
- `guardrails`: concrete and enforceable; never generic.

## Body Rules

- Keep `SKILL.md` <=500 lines and <=5,000 estimated tokens. Move long
  references to `references/<topic>.md` and tell the agent when to load each
  one.
- Match instruction specificity to fragility: prescriptive for fragile or
  destructive operations, flexible with rationale where multiple approaches are
  valid.
- Provide defaults, not menus. If multiple tools could work, name the default
  and mention alternatives briefly.
- Favor procedures over declarations. Teach how to approach a class of
  problems, not the answer for one instance.
- Add a Gotchas section listing non-obvious facts the agent will get wrong
  without being told.
- For multi-step workflows, include a progress checklist or step-to-tool table.
- For destructive or batch operations, use plan-validate-execute.
- For Heartbeat skills, include a clear no-action path and stop conditions.
- Tool whitelist alignment is mandatory: if the body tells the agent to call a
  tool, that id must appear in `allowed_tools`.

## Composition Rules

- Start with one dominant skill per workflow.
- Split into atomic includes only when the same atomic step is reused across
  composites.
- Atomic skills should have a single coherent purpose, narrow `allowed_tools`,
  and no `includes`.
- Composite skills should declare includes in execution order. Resolved
  `allowed_tools` are the union of the composite and child tools, deduplicated.
- Never include a skill that does not exist in the registry.
- Never create a cycle.
- Prefer reusing an existing global skill over re-implementing it privately.

## Skill provenance

- A global skill lives in `skills/global/<slug>/SKILL.md` and is versioned in
  Git.
- An account skill lives in the `account_skills` table for one user/tenant.
  Classify provenance as:
  - `global`: product capability with no account override;
  - `account_override`: account version with the same slug, which replaces the
    global at runtime;
  - `account_native`: account capability created in Diseño with no global base.
- For `account_override`, prefer minimal deltas over full rewrites. Document
  what changed and why in the body.
- Do not describe every account skill as a “customization”: native Studio
  creations and overrides have different provenance.
- The slug must be unique per scope: globally unique for globals, unique per
  user for account skills.

## Tenant Context and Tool Safety

- Skills that touch BigQuery, EasyBroker, or other tenant systems must declare
  `requires_tenant_context: true`. The runtime injects the tenant context block
  before tool execution; without it the tool layer cannot resolve tenant
  filters.
- Human involvement must state the actual business contract, not only “HITL”:
  - **action authorization:** a human explicitly authorizes a send, write,
    publication, or other external effect;
  - **business decision:** a human chooses an outcome Gu lacks authority to
    decide;
  - **human contribution:** a person supplies documents, facts, availability,
    or another missing input;
  - **exception review:** a person resolves low confidence, policy conflict, or
    failed validation.
  Name who decides or contributes, what they see, and what resumes afterward.
- Operational case skills must use `expected_version` when calling
  `operational_case_update_state` and append events for notable changes outside
  state transitions.

## Validation Rubric

Mark each item PASS / WARN / FAIL / N/A before returning a draft.

- Required fields present, types correct, lengths within limits.
- Description includes both trigger and non-trigger boundaries.
- `allowed_tools` are minimal and scoped; each tool exists in the catalog.
- `includes` exist; no cycles; composition order is intentional.
- `requires_tenant_context` is `true` for any skill that touches tenant data.
- Write/send tools are absent or gated by explicit HITL in guardrails and body.
- Body explains stop, ask, escalate, and no-action paths.
- If a tool appears in the body, it appears in `allowed_tools`.
- Heartbeat skills have a documented no-action path. Mark N/A when
  `heartbeat: blocked`.
- Body length <=5,000 tokens; long references moved to `references/`.
- Skill does not ask the model to invent data unavailable through tools.

If any item is FAIL, return the draft annotated with the failure and propose a
fix instead of declaring success.

## Gotchas

- The selector reads only `description` and metadata when choosing a skill.
- A frontmatter `description` that contains raw bullets after `description:` is
  invalid or unsafe. Keep it concise or use exactly `description: |`.
- Gu's parser only accepts `|` for literal block scalars.
- `requires_tenant_context: true` is what makes BigQuery and EasyBroker work.
- Tenant context is not a data source by itself. If the procedure needs
  history, contacts, agreements, or records, identify the concrete catalog
  capability or keep the draft blocked on a gap.
- A skill can be valid at parse time and still useless if `allowed_tools` are
  too broad.
- Composite skills inherit included tools as a union; do not re-list child
  tools in the parent unless the parent itself uses them directly.
- For account skills, the slug must match the directory name or DB row slug.
- Heartbeat skills with `heartbeat: blocked` never run from cron.
- Anthropic's raw Skills contract differs from Gu's. Do not invent fields like
  `model` or `inputs`.
- Do not invent MCP servers or ad-hoc adapters for missing capabilities. Record
  the gap for governed Connections and Tool Catalog review.
