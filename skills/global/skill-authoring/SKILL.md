---
name: skill-authoring
description: Design, critique, and propose Gu OS SKILL.md drafts and Heartbeat checklist playbooks. Use when the user wants to create a new skill, improve an existing one, derive a private account skill from a global, or audit a skill against Gu's contract and best practices. Do not use to run a workflow, install or activate skills, or edit files. Proposal-only, returns a draft, validation rubric, and evals for human approval.
scope: shared
allowed_tools:
  - get_user_preferences
  - read_file
  - list_enabled_tools
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Proposal-only. Never write files, install skills, enable skills, or activate
  checklists automatically. Output is for human review.
  Use Gu's SKILL.md contract: name, description, scope, allowed_tools, includes,
  requires_tenant_context, memory_extraction, heartbeat, guardrails.
  Set requires_tenant_context: true when the skill reads or writes tenant or
  business data (BigQuery, EasyBroker, account-specific configuration, brand,
  business_brain). Default to false otherwise; mis-setting silently breaks tools.
  Write/send tools (mutation, messaging, publication) must be gated by HITL or
  escalation paths in both guardrails and body.
  When proposing a private account skill that shadows a global, start from the
  global SKILL.md as baseline and document the delta; do not regenerate from
  scratch unless the user explicitly asks.
---

# Skill Authoring

Use this playbook to help create, improve, or audit Gu OS skills and Heartbeat
checklist playbooks. Output a proposed `SKILL.md` draft plus a validation
rubric, suggested evals, and an explicit activation recommendation. Never
install or activate skills automatically.

## When to use this skill

- The user wants to draft a new skill from a procedure, workflow, or operational
  case.
- The user wants to critique or improve an existing skill.
- The user wants to derive a private account skill from a global one (e.g.
  customising `property-optioning-coach` for a specific tenant).
- The user wants to audit a skill against Gu's contract or against Anthropic /
  agentskills.io best practices.

## When not to use this skill

- The user wants to actually run a workflow: pick the skill that owns it
  (e.g. `property-optioning-coach`) instead.
- The user wants to install, enable, or save a skill: out of scope; this skill
  produces drafts only and the human owns activation.
- The user wants to query or operate on tenant data: route to the tenant data
  skill (e.g. `company-data`) instead.

## Capture intent

Clarify or infer before drafting:

1. What operational outcome should the skill enable?
2. When should it trigger? When should it NOT trigger? Capture 2-3 near-miss
   prompts the selector should reject.
3. Is this skill atomic (single coherent unit) or composite (orchestrates
   `includes`)?
4. Does it touch tenant or business data, or any external system?
5. What tools does it need, separating read from write/send?
6. What output should it produce, and which steps require HITL?
7. Is there an existing global skill that already covers most of this? If so,
   prefer adapting or composing instead of duplicating.

If the user is creating a private account skill that shadows a global, read
the global SKILL.md first via `read_file` and propose a delta, not a fresh
skill.

## Gu SKILL.md contract

Draft using exactly this shape (omit optional fields when not applicable):

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
  Concrete, enforceable rules. Read-only by default. Spell out HITL gates and
  stop / escalate / no-action criteria.
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

### Field rules (any FAIL blocks the draft)

- `name`: kebab-case, ≤64 chars, only `[a-z0-9-]`, must not contain `anthropic`
  or `claude`, must match the directory name.
- `description`: ≤1024 chars, no XML tags, routing metadata only. It must say
  what the skill does, `Use when ...`, and `Do not use ...`. Prefer a concise
  single paragraph in a quoted one-line string. Do NOT put procedural bullets,
  step lists, tables, or the full workflow in frontmatter; those belong in the
  body. Gu's frontmatter parser only supports plain or quoted scalars and the
  literal block scalar `|` (clip). Do NOT use `|-`, `|+`, `>`, `>-`, or `>+`;
  they are rejected. If multiline is unavoidable, use exactly `description: |`
  with two-space indentation.
- `scope`: `business` for tenant data; `personal` for individual user data;
  `shared` only when both apply with the same safety rules.
- `allowed_tools`: minimal and scoped. Every tool must exist in the catalog
  (validated by `prebuild` script `validate-skill-tool-refs.mjs`). **Runtime
  only:** appearing in `allowed_tools` does **not** make a tool N1-visible in
  Preparación operativa. Classify each id (see
  `apps/web/src/lib/operational-cases/tool-surface-classification.ts`):
  integration/action tools need N1; platform/domain tools (`operational_case_*`
  persist/update/add) belong in `allowed_tools` but are validated in N3/N4
  technical detail; `operational_case_create` is `scenario_only` (intake/N0).
- `includes`: every slug must exist; no cycles; prefer composite skills for
  known multi-step procedures (e.g. `property-optioning-coach` orchestrates
  seven atomic skills).
- `requires_tenant_context`: `true` when the skill reads or writes tenant data
  (BigQuery, EasyBroker, account-specific configuration, brand kit). `false`
  otherwise. Setting `false` on a tenant-data skill silently breaks tool
  invocation at runtime.
- `memory_extraction`: `ephemeral` for transactional or operational skills
  whose turns must not feed long-term memory; `default` otherwise.
- `heartbeat`: `native` for proactive monitoring skills; `blocked` for skills
  that must only run on user or operational triggers; `compatible` otherwise.
- `guardrails`: concrete and enforceable; never generic ("be safe", "do your
  best").

## Body rules

- Keep `SKILL.md` ≤500 lines and ≤5,000 tokens. Move long references to
  `references/<topic>.md` and tell the agent *when* to load each one
  ("Read `references/api-errors.md` if a tool returns a non-200 status").
- Match instruction specificity to fragility: prescriptive for fragile or
  destructive operations, flexible (with rationale) for tasks where multiple
  approaches are valid.
- Provide defaults, not menus. If multiple tools could work, name the default
  and mention alternatives briefly.
- Favour procedures over declarations. Teach how to approach a class of
  problems, not the answer for one instance.
- Add a Gotchas section listing non-obvious facts the agent will get wrong
  without being told (env-specific schema names, soft-delete columns, ID
  aliases, half-true health endpoints).
- For multi-step workflows, include a Progress checklist or a step → tool table.
- For destructive or batch operations, use plan-validate-execute: write a plan
  file, validate it against a source of truth, only then act.
- For Heartbeat skills, include a clear no-action path and stop conditions.
- Operational cases can be born in two ways and the skill body MUST cover both
  in its `intake` section:
  1. **Web UI (structured)**: the form already filled `context_jsonb` and
     created the case with `current_step=intake`. The skill must validate
     `context_jsonb` against the case_type's intake schema, decide whether
     the data is enough to proceed, and call `operational_case_update_state`
     with `expected_version` to move into the first operational step
     (e.g. `awaiting_documents`). If a critical field is missing, the skill
     must `notify_user` the inmobiliario asking for the missing data and
     leave the case in `intake`.
  2. **Conversational (web chat or Telegram, no case_id yet)**: the user
     asked for the workflow without going through the UI. The skill must ask
     the user for every field declared as `required` in the case_type's
     `intake_schema_jsonb`, then call `operational_case_create` with
     `case_type`, `context`, and `external_contact` if the user provided it.
     The tool returns `case_id` and `current_step='intake'`; the skill then
     follows the same transition rules as path 1.
  If a transition rule cannot be inferred from the request/context, mark
  WARN and ask for it explicitly.
- **Tool whitelist alignment**: if the body tells the agent to call
  `operational_case_create`, that id MUST appear in `allowed_tools`. Missing it
  is a FAIL in the rubric (the tool exists at runtime but the skill cannot
  invoke it).
- The high-level workflow must not contradict the conversational path: when
  there is no `case_id`, the procedure must include collecting intake and
  calling `operational_case_create`, not only "open/select the case in the
  web UI".

## Composition rules

- Start with one dominant skill per workflow. Split into atomic includes only
  when the same atomic step is reused across composites.
- Atomic skills should have a single coherent purpose, narrow `allowed_tools`,
  and no `includes`.
- Composite skills should declare their includes in execution order; the
  resolved `allowed_tools` are the union of the composite's own list and the
  children's lists, deduplicated.
- Never include a skill that does not exist in the registry (parser will
  reject it at runtime).
- Never create a cycle (`a → b → a`).
- Prefer reusing an existing global skill over re-implementing it as a private
  one.

## Account skill vs global

- A **global** skill lives in `skills/global/<slug>/SKILL.md` and is versioned
  in Git.
- An **account skill** lives in the `account_skills` table for one
  user/tenant. When the slug matches a global, the account version shadows the
  global at runtime (see `getSkillRegistryForUser`).
- For account skills, prefer minimal deltas over full rewrites. Document what
  changed and why in the body, e.g. a "Customisations for <account>" section.
- The slug must be unique per scope: globally unique for globals, unique per
  user for account skills.

## Tenant context and tool safety

- Skills that touch BigQuery, EasyBroker, or other tenant systems MUST declare
  `requires_tenant_context: true`. The runtime injects the
  `[Contexto de tenant]` block before tool execution; without it the tool
  layer cannot resolve the tenant filter.
- Write/send tools must be gated by HITL: the skill prepares a plan or draft,
  the human approves, only then the action runs. Spell this out in
  `guardrails` AND in the workflow body.
- Operational case skills must use `expected_version` when calling
  `operational_case_update_state` (optimistic locking) and append events with
  `operational_case_add_event` for notable changes outside state transitions.

## Validation rubric (run before returning the draft)

Mark each item PASS / WARN / FAIL / N/A.

- Required fields present, types correct, lengths within limits.
- Description includes both trigger and non-trigger boundaries.
- `allowed_tools` are minimal and scoped; each tool exists in the catalog.
- `includes` exist; no cycles; composition order is intentional.
- `requires_tenant_context` is `true` for any skill that touches tenant data.
- Write/send tools are absent OR gated by explicit HITL in guardrails AND body.
- Body explains stop, ask, escalate, and no-action paths.
- If `operational_case_create` appears in the body, it appears in
  `allowed_tools` (else FAIL).
- Heartbeat skills have a documented no-action path. Mark N/A when
  `heartbeat: blocked`.
- Body length ≤5,000 tokens; long references moved to `references/`.
- Skill does not ask the model to invent data unavailable through tools.

If any item is FAIL, return the draft annotated with the failure and propose a
fix instead of declaring success.

## Eval suggestions (return alongside the draft)

For each proposed skill, return:

- 3 positive prompts that should trigger it (selector should pick this skill).
- 3 near-miss prompts that should NOT trigger it (selector should pick a
  different skill, or `none`).
- 2 Heartbeat scenarios when relevant: one with action required, one with no
  action required.

## Output

When invoked from an automation that expects a structured response, return
exactly this two-section format (no extra prose, no fences around the
sections):

```
<metadata>
{"suggestedEvals":{"positive":["..."],"nearMiss":["..."],"heartbeat":["..."]},"notes":"<optional ≤300 chars, concrete only>"}
</metadata>
<skill-draft>
---
name: ...
... full SKILL.md (frontmatter + body) ...
---
# Title
...body...
</skill-draft>
```

Hard rules for the metadata block (output token budgets are tight):

- The block MUST be valid JSON. One line is preferred. No raw newlines inside
  string values; if you need a break, use `\\n` escapes.
- DO NOT include `validationRubric`; the backend derives it with the real Gu
  parser and deterministic checks.
- DO NOT include `activationRecommendation`; the backend derives it from the
  parser-backed rubric (FAIL → block; WARN → review; PASS → ready).
- `suggestedEvals` lists ≤3 items each. Omit the `heartbeat` key when it does
  not apply.
- `notes` is optional and must be ≤300 characters. Use it only when it is
  concrete: name the exact field, step, tool, or risk to review. Omit `notes`
  instead of writing generic reminders like "review validation" or "check the
  flow".
- The skill-draft block must always be complete (closing `</skill-draft>`).
  If you suspect you are running out of tokens, keep metadata compact and
  compact the draft body without dropping critical execution rules.

Never put the SKILL.md inside the JSON metadata: it breaks JSON parsers (raw
newlines, unescaped quotes, backticks). The draft goes in `<skill-draft>`
verbatim; only eval suggestions and optional notes go in `<metadata>`.
Metadata must come first.

When invoked interactively (no automation contract), return:

1. **Skill draft** as Markdown (frontmatter + body), copy-pasteable into
   `SKILL.md`.
2. **Validation rubric results** with PASS / WARN / FAIL / N/A annotations and
   a short rationale per item.
3. **Suggested evals** (positive, near-miss, Heartbeat).
4. **Activation recommendation**: propose only; ask for explicit human
   approval before creating files, calling APIs, or activating the skill. If
   creating a private account skill that shadows a global, restate that the
   runtime will pick the account version over the global once active.

## Operational case proposals (caso operacional)

When the user describes a **multi-step business process** (not a single-turn
draft), treat it as an operational case proposal in addition to the SKILL draft.

### Classify first

Emit in metadata (or prose when interactive):

- `classification`: `operational_case` | `single_turn_skill` | `hybrid_review`
- `confidence` and short `rationale` (why case vs skill-only).

Prefer `single_turn_skill` when there is no durable `current_step`, no external
waits, and no case runner — e.g. one-off copy, one query, one publish preview.

### Emit `testPlan` (required for `operational_case`)

Reference **catalog IDs** from
`docs/operational-cases/operational-case-reusable-patterns.md` and
`apps/web/src/lib/operational-cases/test-patterns-catalog.ts`. Do not invent
ad-hoc pattern names.

```json
{
  "n0": ["Credenciales y secretos", "Activos de prueba", "Caso aislado N0"],
  "steps": [
    {
      "stepKey": "awaiting_documents",
      "patterns": ["n2_request_documents"],
      "n3Skills": ["request-property-documents"],
      "n4Scenarios": ["awaiting_documents_outreach"]
    }
  ],
  "runtimePatterns": [
    "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
    "PATTERN_NOTIFY_USER_CHANNELS"
  ],
  "uiPatterns": ["PATTERN_SKILL_TEST_CALL_DETAILS"]
}
```

Rules:

- `patterns`: use `n1_single`, `n2_telegram_abc`, `n2_request_documents`,
  `n2_characteristics_telegram_abc`, `n2_easybroker_ab`, etc. from the catalog.
- `n3Skills`: atomic skill slugs per step that need N3 in Preparación operativa.
- `n4Scenarios`: only when the step has root orchestration or critical branches;
  keys must match (or be proposed to match) `step-test-scenarios.ts`.
- `runtimePatterns` / `uiPatterns`: include when Telegram, `notify_user`,
  `operational_case_update_state`, or settings-test seed/repair apply.
- Map each proposed tool to N1 vs N2 vs N3 per
  `docs/operational-cases/testing-framework.md`.
- For each step with an N4 scenario: state that **N1 of all step tools is required**
  before N3/N4 (`PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS` in the patterns catalog).

Never write flow JSON, migrations, or activate case types — proposal only, same
as SKILL drafts.

## Gotchas

- The selector reads only `description` and metadata when choosing a skill,
  not the body. A vague description means the skill will not be picked even
  if the body is excellent.
- A frontmatter `description` that contains raw bullets after `description:`
  is invalid/unsafe YAML. Keep the description concise (quoted one-line) or
  use `description: |`; never paste the full workflow into metadata.
- Gu's parser only accepts `|` (literal block, clip mode). `|-`, `|+`, `>`,
  `>-`, `>+` are rejected with "unexpected indentation outside of a block
  value". Always use `|`.
- `requires_tenant_context: true` is what makes BigQuery / EasyBroker work
  for the skill. Setting it `false` on a tenant-data skill silently breaks
  tools at runtime.
- A skill can be valid at parse time and still useless if its `allowed_tools`
  are too broad: the model picks the wrong tool. Narrow tools beat safe
  defaults.
- Composite skills inherit included tools as a union; do not re-list child
  tools in the parent unless the parent itself uses them directly.
- For account skills, the slug must match the directory name (or `slug` row
  in `account_skills`); the parser will reject mismatches.
- Heartbeat skills with `heartbeat: blocked` will never run from cron. Use
  only when the skill must be triggered by the user or operational case
  runner.
- Anthropic's raw Skills contract differs from Gu's: do not invent fields like
  `model` or `inputs`; stick to Gu's frontmatter schema or the parser will
  reject the skill.
