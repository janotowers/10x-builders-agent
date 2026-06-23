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

Use this playbook to create, improve, or audit Gu OS skills and Heartbeat
checklist playbooks. It is proposal-only: return drafts, validation results,
evals, and activation recommendations for human approval. Never install,
enable, save, or run the proposed skill.

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

## Workflow

1. **Capture intent before drafting.** Clarify or infer:
   - operational outcome;
   - trigger and non-trigger boundaries, including 2-3 near-misses;
   - atomic vs composite ownership;
   - tenant/business data and external systems touched;
   - read vs write/send tools;
   - output format and HITL gates;
   - existing global skill overlap.
2. **Classify the form.** Decide whether this is a single-turn skill,
   heartbeat checklist item, operational case, or hybrid review. Ask if durable
   state, external waits, cron/case runner activity, or multi-step handoffs are
   ambiguous.
3. **Load only the references needed for this request.**
   - Read `references/skill-contract.md` when drafting or auditing any
     `SKILL.md` field, composition, tenant context, body rule, or gotcha.
   - Read `references/operational-case-authoring.md` when the proposal has
     durable steps, documents, approvals, external participants, E2E tests, or
     case-runner behavior.
   - Read `references/output-formats.md` when invoked by automation or when the
     user asks for a copy-pasteable draft, evals, or activation recommendation.
4. **Draft conservatively.** Prefer one dominant owner per workflow. Use atomic
   `includes` only when a step is reusable elsewhere. Keep `allowed_tools`
   minimal and aligned with body instructions.
5. **Validate before returning.** Run the rubric from
   `references/skill-contract.md`. If any item is FAIL, return the draft
   annotated with the failure and propose a fix instead of declaring success.
6. **Recommend activation, never perform it.** Use `do_not_activate`,
   `activate_after_tests`, or `skill_only` based on evidence and risk.

## Skill Development Cycle

- **Discovery:** observe repeated work, existing skills/cases, missing tools,
  credentials/assets, and MECE overlap before drafting.
- **Draft and MECE:** one dominant owner; distinct `description`; push
  repeatability into wrappers/adapters before prose.
- **Readiness proportional to form:** operational cases need `testPlan` with
  N0-N5 refs; single-turn skills need Skill Lab evals; Heartbeat items need
  preview, dry-run, and a documented `no_action` path.
- **Activation:** `do_not_activate` for any FAIL or unresolved overlap;
  `activate_after_tests` for operational cases; `skill_only` for single-turn
  skills after Skill Lab.

## Output Defaults

For interactive use, return:

1. Skill draft as copy-pasteable Markdown.
2. Validation rubric results with PASS / WARN / FAIL / N/A.
3. Suggested evals: positive, near-miss, and Heartbeat when relevant.
4. Activation recommendation and remaining gaps.

For automation, follow `references/output-formats.md` exactly. Keep metadata
compact and put the full draft in `<skill-draft>`, never inside JSON.

## Gotchas

- The selector reads only `description` and metadata when choosing a skill, not
  the body.
- Gu's parser accepts only its constrained frontmatter subset. When uncertain,
  read `references/skill-contract.md` before drafting.
- `requires_tenant_context: true` is what makes tenant tools work. Setting it
  wrong silently breaks runtime tool calls.
- `heartbeat: blocked` means the skill will not run from cron. Use it for
  skills that must be triggered by a user or operational case runner.
- For account skills that shadow a global, read the global `SKILL.md` first and
  propose a delta instead of regenerating from scratch.
