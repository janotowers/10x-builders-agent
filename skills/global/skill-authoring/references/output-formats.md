# Skill Authoring Output Formats

Use this reference when automation expects structured output, or when the user
asks for a complete draft with evals and activation recommendation.

## Automation Contract

When invoked from automation, return exactly this two-section format with no
extra prose and no fences around the sections:

```text
<metadata>
{"suggestedEvals":{"positive":["..."],"nearMiss":["..."],"heartbeat":["..."]},"notes":"<optional <=300 chars, concrete only>"}
</metadata>
<skill-draft>
---
name: ...
... full SKILL.md frontmatter and body ...
---
# Title
...body...
</skill-draft>
```

Hard rules:

- The metadata block must be valid JSON. One line is preferred.
- Do not include raw newlines inside JSON string values; use `\\n` escapes if
  needed.
- Do not include `validationRubric`; the backend derives it with the real Gu
  parser and deterministic checks.
- Do not include `activationRecommendation`; the backend derives it from the
  parser-backed rubric: FAIL blocks, WARN requires review, PASS is ready.
- `suggestedEvals` lists at most three items per category.
- Omit the `heartbeat` key when it does not apply.
- `notes` is optional and must be <=300 characters. Use it only for concrete
  review notes naming the exact field, step, tool, or risk.
- The skill-draft block must always be complete, including closing
  `</skill-draft>`.
- Never put the SKILL.md inside JSON metadata. The draft goes verbatim in
  `<skill-draft>`.
- Metadata must come first.

## Interactive Output

When invoked interactively, return:

1. Skill draft as Markdown with frontmatter and body, copy-pasteable into
   `SKILL.md`.
2. Validation rubric results with PASS / WARN / FAIL / N/A annotations and a
   short rationale per item.
3. Suggested evals:
   - three positive prompts that should trigger the skill;
   - three near-miss prompts that should not trigger it;
   - two Heartbeat scenarios when relevant, one action and one no-action.
4. Activation recommendation:
   - `do_not_activate` if any rubric FAIL or unresolved MECE overlap;
   - `activate_after_tests` for operational cases until N0-N2, critical N3/N4,
     and N5 happy path pass in a controlled lab;
   - `skill_only` for single-turn skills after Skill Lab checklist.

Ask for explicit human approval before creating files, calling APIs, enabling a
skill, or activating a checklist. If creating a private account skill that
shadows a global, restate that the account version will override the global at
runtime once active.
