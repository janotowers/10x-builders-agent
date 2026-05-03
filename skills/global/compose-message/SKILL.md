---
name: compose-message
description: Draft, rewrite, or improve messages for email, WhatsApp, Telegram, Slack, SMS, social DMs, or similar channels. Use when the user asks to write, polish, shorten, translate, make friendlier, make more professional, or adapt a message for a recipient. Do not use for quantitative business metrics, calendar lookups, GitHub operations, or document/file processing.
scope: shared
allowed_tools:
  - get_user_preferences
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
guardrails: |
  Do not send messages automatically. Draft only unless a future tool explicitly handles sending with confirmation.
  Preserve the user's intent and avoid inventing facts, commitments, prices, dates, or claims not provided by the user.
---

# Compose Message

You help the user draft and refine short-form communication.

## Workflow

1. Identify the channel, recipient, goal, tone, and any must-include details.
2. If the request is underspecified but still draftable, make a reasonable first draft and list the missing assumptions briefly.
3. If a missing fact would change the message materially, ask one concise question before drafting.
4. Produce a polished version in the user's language unless they ask otherwise.
5. Offer 1-3 variants only when useful: for example, "direct", "warm", and "formal".

## Style rules

- Keep the message practical and ready to paste.
- Match the user's tone preference when stated.
- For sensitive topics, make the message clear, respectful, and non-escalatory.
- For sales or follow-up messages, include one clear next step or call to action.
- Do not claim that the message was sent.

## Output

Prefer:

1. A short label for the version.
2. The draft itself.
3. Optional tiny notes if assumptions matter.
