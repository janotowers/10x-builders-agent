# Operational Case Authoring

Use this reference when the user describes a multi-step business process rather
than a single-turn draft.

## Classify the governed form

Run discovery and gap analysis before final classification. Studio's artifact
kinds are:

- `case_workflow`: a commercial case with durable state, external actors,
  multi-hour/day waits, decisions, handoffs, or traceability per instance.
- `durable_task`: batch or result-oriented work whose root is a durable task /
  work run, not a commercial case per entity.
- `reusable_skill` (`simple | composite`): a reusable procedure without its own
  durable case or work-run lifecycle.
- `schedule`: recurrence plus a reference to the underlying governed work.

Use `redirect_to_chat` for one-shot execution and `clarify` when a material
ambiguity remains. Heartbeat is a runtime checklist mechanism, not a Studio
artifact kind. A human review requirement is a mechanism inside the chosen
form, not a separate `hybrid_review` kind.

Ask in business language when ambiguous:

- What result must exist, and how is success verified?
- Does work persist between sessions or wait for an external participant?
- Who decides what, and what evidence must that person see?
- Does Gu only prepare, or also send/write/publish after authorization?
- What source contains the required history, contacts, records, or documents?
- Is this reusable, one-time, or recurring?

Do not ask the operator to select a technical kind or whether they “want HITL.”
Present the recommended form and rationale in the review summary.

For `reusable_skill`, emit `skillLabChecklist` instead of a full `testPlan`:

```json
{
  "meceCheck": "No overlap with company-data; near-miss: generic CRM questions",
  "evalsRequired": { "positive": 3, "nearMiss": 3 },
  "integrationN1": ["telegram_send_message_to_contact"],
  "readinessPath": "skill_lab"
}
```

Do not show case-workflow jargon to the user when classification is
`reusable_skill`. Present one coherent capability proposal with the
recommended form in structured metadata.

## Intake Paths

Operational cases can be born in two ways and the skill body must cover both.

1. **Web UI structured path:** the form already filled `context_jsonb` and
   created the case with `current_step=intake`. Validate `context_jsonb` against
   the case type intake schema, decide whether the data is enough to proceed,
   and call `operational_case_update_state` with `expected_version` to move into
   the first operational step. If a critical field is missing, notify the
   operator and leave the case in `intake`.
2. **Conversational path:** the user asked for the workflow through web chat or
   Telegram without a `case_id`. Ask for every field declared as `required` in
   `intake_schema_jsonb`, then call `operational_case_create` with `case_type`,
   `context`, and `external_contact` if provided. The returned `case_id` and
   `current_step='intake'` then follow the same transition rules as path 1.

If a transition rule cannot be inferred from request/context, mark WARN and ask
for it explicitly.

The high-level workflow must not contradict the conversational path. When there
is no `case_id`, include collecting intake and calling
`operational_case_create`, not only "open/select the case in the web UI".

## Inputs, assets, and tenant capabilities

- Use `required_assets` / `account_assets` only for reusable account-level
  files or configuration such as brand kits, templates, or policy documents.
- Use `input_requirements` for runtime or per-case data such as conversation
  history, the latest agreement, contacts, property records, uploaded
  documents, approvals, and selection criteria.
- Never set `requires_tenant_context: true` while leaving the procedure unable
  to identify how required tenant data is obtained. Ask or record a capability
  gap first.
- Compare requested systems with the real tenant tool/integration catalog.
  Never invent a CRM, adapter, tool id, credential, or MCP server.

## Emit Test Plan

For `case_workflow`, emit a `testPlan` that references catalog IDs from:

- `docs/operational-cases/operational-case-reusable-patterns.md`
- `apps/web/src/lib/operational-cases/test-patterns-catalog.ts`

Do not invent ad-hoc pattern names.

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

- Use catalog patterns such as `n1_single`, `n2_telegram_abc`,
  `n2_request_documents`, `n2_characteristics_telegram_abc`, and
  `n2_easybroker_ab`.
- `n3Skills`: atomic skill slugs per step that need N3 in Preparación
  operativa.
- `n4Scenarios`: only when the step has root orchestration or critical
  branches; keys must match or be proposed to match
  `step-test-scenario-registry.ts`.
- `runtimePatterns` / `uiPatterns`: include when Telegram, `notify_user`,
  `operational_case_update_state`, or settings-test seed/repair apply.
- Map each proposed tool to N1 vs N2 vs N3 per
  `docs/operational-cases/testing-framework.md`.
- A `step_key` is a durable business milestone, not one step per atomic skill.
  The root composite orchestrates atomics within the same step until the
  milestone closes.
- For each step with an N4 scenario, state that N1 of all step tools is
  required before N3/N4.

Never write flow JSON, migrations, or activate case types. This skill proposes
only.
