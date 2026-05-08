---
name: conversation-risk-watch
description: Detect real estate conversations that show frustration, confusion, urgency, negative sentiment, or need human empathy/negotiation. Use in Heartbeat/proactive checks when the checklist mentions risky conversations, buyer frustration, unclear replies, churn risk, or escalation.
scope: business
allowed_tools:
  - get_user_preferences
  - read_skill_reference
  - bigquery_run_query
includes:
  - business-data-core
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: native
guardrails: |
  Read-only. Never send messages automatically.
  Do not infer sentiment from a single ambiguous phrase; quote concise evidence.
  Escalate only when there is concrete risk, urgency, or confusion.
  If no conversation crosses the threshold, return only a compact OK/no-action response.
---

# Conversation Risk Watch

Use this playbook to find conversations that may require human attention.

## Workflow

1. Read the checklist threshold. Only inspect recent conversations when the checklist asks for this source.
2. Load `read_skill_reference("fewshots-messages")` or `read_skill_reference("joins")` before message SQL.
3. Query tenant-scoped recent messages with enough context to understand the latest exchange.
4. Flag only evidence-backed cases:
   - frustration or complaint;
   - repeated unanswered question;
   - urgency around timing, money, documentation, or visit;
   - confusion about property, process, financing, or next step.
5. Avoid broad summaries. Surface only conversations needing action.

## Output

- **Conversación / lead**
- **Evidencia breve**
- **Riesgo**
- **Siguiente paso recomendado**

If nothing crosses the threshold, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```
