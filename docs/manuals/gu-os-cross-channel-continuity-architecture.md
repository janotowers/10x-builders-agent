# Gu OS — Cross-channel continuity architecture

**Status:** Architectural direction and evidence-gated backlog (not fully implemented).
**Scope:** Internal-user continuity across the current web chat and Telegram surfaces. Future channels may reuse the contracts, but they do not justify speculative implementation.
**Related:** [Agent architecture analysis](./gu-os-agent-architecture-analysis.md) · [Flexible workflows technical plan](./gu-os-flexible-workflows-technical-plan.md) · [Operational-case architecture](../operational-cases/architecture.md) · [Long-term memory plan](../memory/long_term_memory_plan.md) · [G Brain evaluation](../brain/gbrain-evaluation-and-plan.md) · [Talk to Gu vision](../talk-to-gu/vision.md) · [Realtime voice plan](../talk-to-gu/realtime-voice-implementation-plan.md) · [Experience Architecture](./gu-os-experience-architecture.md)

---

## 1. Decision summary

Gu OS should behave consistently across web chat and Telegram without asking the real-estate user to announce a channel switch. The implementation must build on three different continuity mechanisms instead of collapsing them into one universal conversation object:

1. **Operational continuity:** `operational_case.id` + durable case state/events + conversational bindings.
2. **Decision continuity:** user-scoped persistent notifications + the shared `resolvePendingDecisionTurn` router.
3. **General follow-up continuity:** a future, conservative cross-channel antecedent resolver over recent turns and structured turn artifacts.

The following are **not approved**:

- forcing users to type “continue in Telegram/web”;
- merging every web and Telegram message into one prompt history;
- treating `user_id` as if every message belonged to one conversation;
- persisting transient query results as durable personal or business memory;
- introducing a universal `conversation_id` before concrete evidence requires threads beyond cases/turns;
- allowing an LLM to silently choose among ambiguous cases or prior results.

The main interaction surface remains conversational. The web pending inbox is a complementary discovery/evidence/action surface, not a required handoff mechanism.

---

## 2. Current state (verified)

### 2.1 Shared across channels

- Telegram accounts resolve to the same `profiles.id` used by web.
- Operational cases, case events, documents and business state are tenant-scoped and independent of a channel session.
- Web and Telegram invoke the shared `resolvePendingDecisionTurn` before the generic agent for internal-user decisions such as price, contract, listing description, titularidad and comparables.
- Internal-user HITL actions share one contract (`hitl-action-contract`): same action ids/labels/semantics; web chips and Telegram inline keyboards are render adapters. Post-turn invariants and contract/package recoveries run from both entrypoints (`operational-case-post-turn`).
- Web and Telegram reuse shared intake and conversational-routing primitives.
- Case follow-ups choose an **active internal channel** from conversation bindings: when web is active, operational notifies are mirrored into the web chat timeline and Telegram push is suppressed; when Telegram is active, push goes to Telegram as before.
- External contacts use popular messaging channels (Telegram today; WhatsApp later). That boundary is intentional and separate from advisor parity.
- Long-term personal memories are scoped by `user_id`; a sibling-session catch-up flush makes durable memories retrievable after switching web ↔ Telegram.
- `notify()` always persists an internal web notification and attempts configured push delivery (subject to the active-channel push policy above).

### 2.2 Still channel-scoped

- `agent_sessions` are selected by `(user_id, channel)`.
- `runAgent` loads the last messages from the current `session_id`, not all interactive sessions.
- The web timeline does not render the Telegram transcript.
- `operational_case_conversation_bindings` records `channel`, `chat_id` and `session_id`; pending-binding lookup filters by channel.
- A clarification opened in one channel is therefore not guaranteed to be directly consumable from another.

### 2.3 Consequence

Gu OS has **shared user/business state and partial cross-channel behavior**, but not exact cross-channel short-term conversational continuity. Calling the current product “multi-channel” is accurate; calling it fully omnichannel would overstate the implementation.

---

## 3. Terminology and boundaries

| Concept | Meaning | Source of truth |
|---|---|---|
| User identity | Authenticated internal operator | `profiles.id` |
| Channel endpoint | Web session or verified Telegram chat | `agent_sessions`, `telegram_accounts` |
| Turn | One user input and resulting agent/tool activity | `turn_id`, `agent_messages`, `tool_calls` |
| Operational case | Durable multi-day business procedure | `operational_cases` + events/work plane |
| Pending decision | Action/review awaiting the internal user | `internal_user_notifications` and/or pending `tool_calls` |
| Antecedent | Prior turn/result referenced by a follow-up | Future resolver over recent turns/artifacts |
| Durable memory | Stable user fact/preference worth recalling later | `memories` |
| Business cognition | Durable entity knowledge, links and signals | Future `brain_*` layer |
| Turn artifact | Bounded, attributable output/result set useful for a later follow-up; a conversational subtype of the broader Gu OS `Artifact` concept owned by the Experience Architecture | Future ephemeral artifact contract |

These identities must not be conflated. In particular:

- `case_id` is the effective conversation identity for operational messages, not for all assistant use.
- `session_id` is a channel container, not business truth.
- long-term memory is not a transcript store.
- Brain entity identity resolution (“Carlos in CRM = Carlos in Calendar”) is not conversational antecedent resolution (“the ten leads from my previous web query”).

---

## 4. Routing model

### 4.1 Operational-case messages

Keep the current conservative hierarchy:

1. explicit structural references (callback, notification, case/action URL);
2. pending-decision router;
3. routable case bindings;
4. deterministic step-aware matching;
5. constrained classifier with stage/case summary;
6. clarification when candidates remain;
7. general-agent fallback.

Current examples worth preserving:

- an incomplete intake plus property details → continue the only matching case;
- “otra propiedad” → force a new case;
- “listo” while collecting documents/photos → apply only where the case stage makes it meaningful;
- an analytics question → do not let a sticky case binding claim it;
- multiple matching cases → ask with useful title/zone/status labels.

The future flexible-workflows multiplexer wraps this routing; it does not replace the deterministic gates.

### 4.2 Internal decisions

An internal user must be able to act through either conversational surface or the pending inbox. Natural-language replies in web and Telegram use the same router. Buttons/cards add structural certainty but are not the only supported UX.

The external-contact `property_data_review` path is intentionally endpoint-bound and is not evidence that internal-user decisions are Telegram-only.

### 4.3 General cross-channel follow-ups

Example:

1. Web: “Dame los 10 leads que solicitaron visita en marzo.”
2. Telegram later: “De esos 10 leads, ¿cuáles tuvieron interés en Guadalajara?”

This is not a case, notification or durable-memory problem. A future resolver should:

1. detect an anaphoric/follow-up reference (“esos 10”, “la lista anterior”, “la segunda opción”);
2. search recent interactive turns for the same `user_id` across web and Telegram;
3. retrieve candidate assistant outputs and structured tool/result artifacts;
4. resolve only when one candidate is strongly compatible;
5. state the recovered scope (“Retomando la lista consultada hoy en web…”);
6. ask a concise clarification when several candidates fit;
7. request missing context when no candidate is reliable.

Never reconstruct an exact entity set from model memory alone.

---

## 5. Turn artifacts (future contract)

Dynamic result sets should be represented as bounded, tenant-scoped artifacts rather than promoted to memory:

```text
id
user_id
turn_id
session_id
channel
artifact_type             # query_result_set | option_set | generated_report | ...
source_tool
scope_jsonb               # normalized filters/query intent
entity_refs_jsonb         # stable IDs where available
snapshot_jsonb?           # bounded and scrubbed; optional
created_at
expires_at
provenance_jsonb
```

Rules:

- Prefer stable entity IDs and query scope over copied prose.
- Dynamic follow-ups should re-query current data while preserving the antecedent’s entity scope; show when a snapshot is stale.
- Retention is finite and explicit.
- Store no credentials or unrestricted raw warehouse payloads.
- Required `user_id`; no cross-tenant lookup.
- A failed/ambiguous lookup never authorizes an external effect.

Existing `agent_messages`, `tool_calls` and `turn_id` provide the starting evidence. A new table is justified only after validating that bounded structured artifacts cannot be represented safely in existing metadata.

**Update 2026-07-31:** the [realtime voice plan](../talk-to-gu/realtime-voice-implementation-plan.md) is the first planned consumer of this contract: visual artifacts referenced from a voice conversation (charts, tables, property sheets — Slice V4.1) and, later, correlated inbound uploads via a temporary `UploadIntent` expectation (deferred V6.1). Two records must stay distinct when implemented: the **artifact** (content, provenance, turn/case binding) and the **delivery receipt** (channel, timestamp, success). Artifact existence never implies successful delivery, and a voice surface may only reference an artifact after a confirmed render/delivery. Inbound association follows ADR-CC-002: one active, compatible expectation resolves; ambiguity asks; temporal proximity alone never binds.

---

## 6. UX principles

1. **No channel-switch ceremony.** The user simply opens web or Telegram.
2. **Chat-first.** Pending inbox remains useful for discoverability, evidence and batch review.
3. **Quiet provenance.** When recovering another channel’s antecedent, say so briefly.
4. **Clarify only on real ambiguity.** Do not ask which case when one stage-compatible candidate is evident.
5. **Useful candidate labels.** Show property/title/zone/date, not UUIDs or plane terminology.
6. **No false continuity.** “No encuentro con certeza esa lista” is better than hallucinating it.
7. **Channel-local rendering, shared semantics.** Telegram may send a file where web renders inline; both represent the same decision/artifact.

---

## 7. Security and governance

- Resolve Telegram endpoints through verified account linkage.
- Every lookup is scoped by `user_id`; admin-wide access is irrelevant to conversational resolution.
- Treat messages from external contacts as untrusted and distinct from the internal user.
- Never merge identities using names alone.
- Record the linkage reason and confidence for automatic antecedent/case resolution.
- Keep prompts/responses out of analytics events unless a separately approved retention policy allows them.
- Preserve case and tool approval policies after channel switching; channel movement cannot widen authority.

---

## 8. Relationship to other architecture

### Flexible workflows

- Phases 0–3 are not blocked.
- Residual-intent preservation and the Phase 4 decomposer improve both current channels.
- Case/work/approval state remains channel-independent.
- Cross-channel antecedent resolution is an evidence-gated Phase 4 extension, not a prerequisite for the work plane.

### Long-term personal memory

Cross-channel memory means durable facts extracted in one channel can be retrieved in another. It does not promise exact recent transcript/result continuity.

### G Brain / Ingestion Layer

Brain connectors normalize durable external knowledge and resolve business entities across sources. They may consume canonical turn artifacts later, but Brain must not become the short-term conversation store or ingest every transient answer.

### Notifications and delivery

Channel preference and fallback for proactive notifications are separate from resolving what an inbound follow-up refers to. Delivery can reuse an artifact/decision correlation, but delivery success does not define conversation identity.

### Experience Architecture

- This document owns conversational continuity mechanisms; the cross-domain [Experience Architecture](./gu-os-experience-architecture.md) owns Semantic Human Interaction, Contextual Views/Artifacts, identity/representation and attention delivery.
- `Turn Artifact` is a bounded conversational subtype of `Artifact`; artifact identity/lifecycle semantics are Experience-owned.
- ADR-CC-001's deferral of a universal `conversation_id` is consistent with the Experience Architecture rule that continuous cross-surface Experience does not require a universal durable conversation identity.
- `internal_user_notifications` remains a brownfield seam that may currently combine decision persistence and delivery; it does not define target Notification semantics.

---

## 9. Evidence-gated backlog

### Now / planned work

- Preserve the shared pending-decision router and deterministic case routing.
- Implement residual-intent preservation and conservative intent decomposition per the flexible-workflows plan.
- Keep `turn_id`, `channel`, `user_id`, `case_id` and model/tool provenance attributable.
- Add scenario coverage for web ↔ Telegram parity.

### Deferred

1. **Channel-neutral case expectation:** evaluate a user/case-scoped pending expectation with channel endpoints, or a less invasive cross-channel lookup over current bindings.
2. **Antecedent resolver:** recent-turn candidate retrieval, confidence policy and clarification.
3. **Turn artifacts:** structured result-set persistence with TTL/provenance.
4. **Unified transcript/thread UI:** not approved; revisit only if users need multiple named general conversations.
5. **Universal `conversation_id`:** not approved; reconsider with multi-party threads, email-thread continuity, voice handoff or persistent topic workspaces.

### Activation evidence

Prioritize the deferred work when one or more occurs:

- users switch web ↔ Telegram during an active intake/clarification;
- repeated follow-ups refer to results produced in the other channel;
- a third interactive channel is committed;
- multiple concurrent general threads create wrong antecedent selection;
- clarification/fallback metrics show material lost work;
- support reports show users expect exact cross-channel continuation.

**Status 2026-07-31:** the third-interactive-channel trigger is in progress — the [realtime voice plan](../talk-to-gu/realtime-voice-implementation-plan.md) commits voice as an interactive channel. Prioritize the turn-artifact work when its Slice V4.1 / deferred V6.1 (`UploadIntent`) are scheduled; until then this backlog remains evidence-gated as stated above.

---

## 10. Acceptance scenarios for future implementation

| Scenario | Expected behavior |
|---|---|
| Start intake in Telegram; provide the next expected property field in web | Continue the same unique case, or clarify if multiple stage-compatible cases exist |
| Receive a price proposal in Telegram; type approval in web chat | Shared pending-decision router applies it to the correct case |
| Approve and ask an unrelated analytics question in one message | Decision executes; residual intent is routed/acknowledged; no silent loss |
| Query ten March leads in web; refer to “those ten” in Telegram | Recover the exact recent result scope or clarify; never invent members |
| Two recent lists both contain ten leads | Ask which list, showing date/filter/channel labels |
| Referenced result is stale | Re-query with the original scope and disclose refresh, or explain why it cannot be reproduced |
| User A references a result from User B | No candidate is visible; tenant-isolation test fails closed |

---

## 11. Decision records

### ADR-CC-001 — Use domain identities before a universal conversation identity

**Decision:** Cases own operational continuity; turns/artifacts own general antecedents; user-scoped notifications own decisions. Defer a universal conversation entity.

**Why:** These primitives already encode stronger, safer context than channel history. A generic thread would add migration/UI complexity without yet solving a measured failure.

### ADR-CC-002 — Resolve conservatively, clarify on ambiguity

**Decision:** Deterministic structural/stage evidence precedes model classification. Automatic cross-channel linkage requires one high-confidence candidate; otherwise ask.

**Why:** Wrong association can mutate the wrong property case or expose unrelated data.

### ADR-CC-003 — Transient results are artifacts, not memory

**Decision:** Exact query sets/options are bounded turn artifacts with provenance/TTL. Durable facts may still enter personal memory or Brain through their own governed pipelines.

**Why:** Persisting every answer as memory creates stale, noisy and privacy-sensitive context.

