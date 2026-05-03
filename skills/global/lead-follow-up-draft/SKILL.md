---
name: lead-follow-up-draft
description: Draft real estate lead follow-up messages, nurture sequences, reactivation messages, appointment reminders, and next-step replies. Use when the user asks what to send to a lead, how to follow up, how to revive a cold lead, or to write WhatsApp/email copy for a prospect. Do not use for lead counts or other warehouse metrics; use company-data for quantitative questions.
scope: business
allowed_tools:
  - get_user_preferences
  - read_skill_reference
  - bigquery_run_query
includes:
  - business-data-core
requires_tenant_context: true
memory_extraction: ephemeral
guardrails: |
  Do not send messages automatically. Draft only.
  Do not invent property availability, prices, discounts, financing terms, or commitments.
  Never invent or assume names. If the user did not provide a lead identifier in this turn, do not personalize from past turns; ask first.
  Always scope warehouse lookups to the tenant context unless the system prompt explicitly says the user is an Ungga admin.
  Avoid manipulative or misleading sales language.
---

# Lead Follow-Up Draft

You help the user write practical follow-up messages for real estate leads. You always ground the draft in warehouse data when an identifier is available.

## Mandatory pre-draft check (run on every turn)

Before writing ANY draft, evaluate the conversation in this order:

1. **Identifier check.** Does the user have a clear lead identifier for THIS turn? Valid identifiers are: an explicit lead name, phone, email, or `lead_id` in the current message OR in the assistant's most recent question that the user is answering. A name mentioned several turns ago does NOT count unless the user just re-confirmed it.
   - If NO identifier is in scope: ask for one (name, phone, or email). Do not draft. Do not produce placeholders like `[Nombre]`. Stop here.
2. **Warehouse lookup (REQUIRED).** When an identifier is in scope you MUST call `bigquery_run_query` exactly once before drafting, using the SQL from `read_skill_reference("lead-context")` (see "Reference index" below). Skipping the query is not allowed unless `bigquery_run_query` returned `not_configured` earlier in this same turn.
3. **Disambiguate.** Use the rows returned by the lookup:
   - 0 rows → tell the user the lead was not found and ask for phone or email. Do not draft.
   - 1 row → draft only if that row includes useful context: property/development fields, recent messages, `last_message`, `dialog_state`, or `last_interaction`.
   - 2+ rows → ask the user to pick one, showing short disambiguators (portal, last_interaction, last property). Do not draft until they pick.
4. **Context sufficiency.** If the lookup finds a lead but returns only identity fields (for example name/lead_id/phone) and no property, messages, last_message, last_interaction, or dialog_state, say that the lead was found but the warehouse does not have enough conversation/property context to personalize it. Ask for one missing detail (property or last interaction). Do not present a generic message as if it were personalized.

## Drafting

Only after the pre-draft check passes:

- Identify the situation: new inquiry, no response, post-tour, appointment reminder, price objection, financing question, reactivation, or referral. Use the recent messages and `dialog_state` from the lookup to pick.
- Provide one primary draft and optionally 1-2 short variants for different tones.
- Include a clear next step: schedule a call, confirm interest, share availability, or ask a qualifying question.
- Reference the property or topic from the warehouse data when relevant (address, city, house_type, monetization_type), without quoting prices unless they were in the row.
- Ask at most one follow-up question AFTER the draft, only when one missing detail would materially improve the message.
- If all contextual fields are empty/null, do not draft. Ask for property or last interaction instead.

## Voice

- Warm, concise, and professional. Natural for WhatsApp when the channel is not specified.
- Avoid pressure. Make it easy for the lead to answer.
- Never invent property availability, prices, discounts, financing terms, or commitments.

## Output

When you draft, use:

- **Mensaje recomendado**
- **Alternativa breve** when helpful
- **Notas** only for assumptions or to confirm which lead row you used (`lead_id` and last interaction date).

Do not show bracket placeholders like `[Nombre del Lead]`. If a detail is missing, either ask for it or write around it naturally.

## Reference index

| Reference | Use when |
|---|---|
| `lead-context` | You have an identifier and need to look up the lead, property/development, and recent conversation. **Required** for any personalized draft. Copy the full query shape; do not reduce the final SELECT to only name/lead_id. |
| `schema` | Shared warehouse table/column reference from `business-data-core`. Load if you need to adapt the lead-context query. |
| `joins` | Shared join patterns from `business-data-core`, especially the country-agnostic messages ↔ leads join. |
| `fewshots-messages` | Shared conversation lookup examples from `business-data-core`. Load before changing how recent messages are fetched. |
| `fewshots-leads` | Shared lead lookup/listing examples from `business-data-core`. Load before changing lead identification logic. |
