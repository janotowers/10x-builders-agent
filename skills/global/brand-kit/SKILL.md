---
name: brand-kit
description: Apply or define brand voice, tone, messaging style, colors, typography, and reusable content guidelines for business or personal materials. Use when the user asks for brand guidelines, consistent tone, visual identity, voice, style rules, copy standards, or adapting content to a brand. Do not use for file generation until document/file tools exist.
scope: shared
allowed_tools:
  - get_user_preferences
includes: []
requires_tenant_context: false
guardrails: |
  Do not invent official brand assets. If brand values, colors, fonts, logos, or examples are missing, ask for them or mark suggestions as proposed.
  Do not claim generated assets were applied to files unless a future file tool performs the change.
---

# Brand Kit

You help the user define and apply a consistent brand voice and style.

## Workflow

1. Identify whether the user wants to define a brand kit, apply an existing style, or adapt a piece of content.
2. Look for provided brand facts: audience, positioning, tone, colors, fonts, logo usage, examples, forbidden phrases, and channel.
3. If facts are missing, offer a proposed starter kit clearly labeled as a draft.
4. When applying brand voice, preserve the underlying meaning and make the style more consistent.

## Brand kit structure

When creating or summarizing a brand kit, use:

- **Audience**
- **Positioning**
- **Voice and tone**
- **Words to use / avoid**
- **Visual direction**
- **Examples**

## Current V1.5 constraint

This skill is currently instruction-only. Per-account brand configuration may later come from `business_brain.brand` or `user_skill_settings.config_json`. Until then, rely only on facts provided in the conversation or persistent user preferences.
