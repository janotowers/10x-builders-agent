---
name: skill-authoring
description: Design, critique, and propose Gu OS skills and heartbeat checklist playbooks. Use when the user wants to create a new skill, improve an existing skill, validate whether a checklist item has the right skill support, or turn a workflow into a SKILL.md draft. Proposal-only: do not install or activate skills automatically.
scope: shared
allowed_tools:
  - get_user_preferences
  - read_file
  - list_enabled_tools
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
guardrails: |
  Proposal-only. Do not write files, install skills, enable skills, or activate checklists automatically.
  Use Gu's SKILL.md contract, not Anthropic's raw contract: name, description, scope, allowed_tools, includes, requires_tenant_context, memory_extraction, guardrails.
  For business/tenant data skills, require tenant context and read-only warehouse patterns unless the user explicitly designs a HITL action skill.
---

# Skill Authoring

Use this playbook to help create or improve Gu OS skills and Heartbeat checklist playbooks.

## Capture intent

Clarify or infer:

1. What operational outcome should the skill enable?
2. When should it trigger?
3. What tools are needed?
4. What should it never do?
5. What output should it produce?
6. What examples should pass/fail?

## Gu SKILL.md contract

Draft using this shape:

```markdown
---
name: kebab-case-name
description: What it does. Use when ... Do not use for ...
scope: business | personal | shared
allowed_tools:
  - get_user_preferences
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
guardrails: |
  Read-only by default...
---

# Title

## Workflow

## Output
```

## Validation rubric

Before proposing a skill, check:

- Name is kebab-case and matches intended directory.
- Description includes both trigger and non-trigger boundaries.
- Tools are minimal and scoped.
- Business data skills use `requires_tenant_context: true`.
- Write/send tools are absent or explicitly gated by HITL.
- Body explains when to stop, ask, escalate, or say no action required.
- For Heartbeat skills, there is a no-action path.
- The skill does not ask the model to invent data unavailable through tools.

## Eval suggestions

For each proposed skill, include:

- 3 positive prompts that should trigger it.
- 3 near-miss prompts that should not trigger it.
- 2 Heartbeat scenarios when relevant:
  - one with action required;
  - one with no action required.

## Output

Return:

1. **Skill draft** as Markdown.
2. **Validation notes** with risks or missing inputs.
3. **Suggested evals**.
4. **Activation recommendation**: propose only; ask for explicit human approval before implementation.
