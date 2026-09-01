# R1 Relationship Operations — Traditional Gu Legacy Source Audit

> **Version:** v0.3  
> **Status:** Complete for R1 architecture/Technical-Plan entry — v0.2 full audit (2026-08-28) plus targeted drift revalidation (2026-08-31); source-verified legacy contracts and risks; exact adapter/API/schema mechanics remain Technical Design  
> **Initiative:** R1 — Relationship Operations v1  
> **Audit date:** 2026-08-28 (original full audit)  
> **Targeted drift revalidation:** 2026-08-31 — targeted R1-relevant revalidation, **not** a full new audit; see §23  
> **Gu OS repository:** `janotowers/10x-builders-agent`, `main`  
> **Traditional Gu repositories audited (v0.2 baseline):** `UnggaMX/ungga-full`, `gcp/main` at `ae9f107a1d53c8bc25a327bece5701aac192ac49`; `UnggaMX/ungga-landing`, `main` at `77e3dc7fb562f9b249a5d5ec7f8f159e6f2ccdfa`  
> **Revalidated through (2026-08-31):** `UnggaMX/ungga-full`, `gcp/main` at `c88792530152c0c91a1e74c59e26a416103e68ff`; `UnggaMX/ungga-landing`, `main` at `82cab192bec2f23a0709c57ce06204d21007a179`  
> **Companion Architecture Analysis:** `docs/product/initiatives/relationship-operations/architecture-analysis.md`  
> **S1 behavioral contract:** `docs/product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`  
> **Shared-kernel mapping:** `docs/product/initiatives/relationship-operations/r1-concept-shared-kernel-mapping.md`  
> **Relevant ADRs:** ADR-106 Organization-Native Multi-seat Tenancy; ADR-107 Runtime / Conversation Authority; ADR-108 Versioned Organization Policy; ADR-109 Generic Case Relationships / Lineage; ADR-110 Resource Usage & Cost Attribution  
> **Artifact role:** Record source-verified Traditional Gu production contracts that R1 may depend on during brownfield migration, distinguish those contracts from Gu OS target semantics, and identify legacy risks that must not be inherited as Gu OS invariants.

---

## 1. Executive conclusion

The minimum Traditional Gu source audit needed to enter R1 Technical Planning is complete.

The audit does **not** reveal a need to reopen AC-1 through AC-10. Instead, the production code materially reinforces the architecture already accepted:

- legacy identity, organization, assignment and conversation authority are separate concerns even though historical fields sometimes blur them;
- `lead_id` is an operational context identifier, not canonical Prospect or Opportunity identity;
- Legacy Deal is property-interest / visit-context evidence, not the Transaction boundary;
- appointment persistence is brownfield and partially replicated rather than globally atomic;
- visit attendance requires explicit post-appointment evidence and cannot be inferred from appointment existence;
- Firestore property records are the original Traditional Gu property source while Mongo/Qdrant serve operational search/read needs;
- WhatsApp execution has usable provider correlation (`wamid`) and failure callbacks, but the current seams do not expose a complete Gu OS-grade idempotent command/effect contract;
- current human-takeover behavior already separates "Gu stops speaking" from "Gu stops observing/reasoning";
- current authorization shortcuts in legacy/new-owner-app paths must not be copied into organization-scoped Gu OS capabilities.

The appropriate R1 migration strategy remains:

> **Wrap and govern selected Traditional Gu capabilities behind a bounded operational gateway; preserve source-specific evidence and external identifiers; make Gu OS authoritative only for the responsibilities/facts it owns; and reconcile partial/unknown external effects instead of pretending the brownfield estate is one transactional database.**

**Revalidation outcome (2026-08-31):** a targeted drift revalidation at the new branch heads (§23) found **no audited contract invalidated**. One additive material change (conversation persistence is now multi-thread per Lead, §10), one new relevant seam (advisor-linked WhatsApp capture / `waProbe`, §9.1), a strengthened outbound delivery-failure evidence path (§15.7), and identity/permission clarifications (§4.5). The previously recorded authorization risks persist (§16). The drift does not contradict S1–S4 and does not reopen AC-1 through AC-10 or ADR-106 through ADR-110; it strengthens the case for the bounded operational gateway and adds useful evidence/identity/delivery seams for Technical Design.

---

## 2. Source-status discipline

This audit uses the following labels:

- **CURRENT — LEGACY SOURCE VERIFIED** — directly observed in the audited Traditional Gu production branches/files listed in this artifact.
- **CURRENT — LEGACY RISK** — source-verified behavior that is unsafe, ambiguous or too legacy-specific to promote into a Gu OS invariant.
- **TARGET — EXISTING ADR / SPEC** — already-approved Gu OS direction confirmed or clarified by the audit.
- **OPEN — TECHNICAL DESIGN** — exact adapter, schema, API, event, migration or reconciliation mechanics still to design.
- **OUT OF R1 AUDIT SCOPE** — source area not needed to unblock the current R1 architecture/Technical Plan.

v0.3 adds one label:

- **REVALIDATED — 2026-08-31** — re-verified (or newly verified) at the revalidation heads recorded in the header.

Source verification is scoped to the branches and commits recorded in the header. Statements not explicitly marked as revalidated remain pinned to the v0.2 audit commits; the 2026-08-31 pass was a **targeted R1-relevant drift revalidation** (diff-driven over the seams in §3 plus newly added code), not a re-execution of the full audit. A later Traditional Gu change may still require revalidation of the affected contract before implementation if the source has materially moved.

---

## 3. Audit scope and question set

The audit focused on the production boundaries that R1 must cross:

1. authentication and legacy user identity;
2. organization/principal/advisor semantics;
3. Legacy Lead creation and `lead_id` semantics;
4. assignment and sticky reassignment behavior;
5. WhatsApp inbound routing and provider identifiers;
6. human same-thread takeover and automatic resumption;
7. conversation persistence/read surfaces;
8. appointment creation, persistence and confirmation semantics;
9. post-appointment visit-attendance evidence;
10. Legacy Deal creation/meaning;
11. property source/search topology;
12. outbound WhatsApp transport, provider correlation and failure evidence;
13. current authorization boundaries relevant to R1;
14. billing caller contract only where it directly governs an R1 effect.

The audit intentionally did **not** attempt to catalog every Traditional Gu collection, cron, model graph, notification template or billing-internal implementation.

---

# 4. Authentication, user identity and legacy organization semantics

## 4.1 Firebase Auth is the current human authentication identity

**CURRENT — LEGACY SOURCE VERIFIED**

`ungga-landing` authenticates users through Firebase Auth using email/password and Google. Its server session endpoint verifies the Firebase ID token before resolving the effective application role.

Relevant source:

- `UnggaMX/ungga-landing/src/app/login/login-client.tsx`
- `UnggaMX/ungga-landing/src/app/api/auth/session/route.ts`

The Firebase UID therefore remains an important **external identity** during brownfield migration. It is not, by itself, the Gu OS Organization ID or Opportunity assignment identity.

## 4.2 `organization_id` is a legacy organization/principal bridge, not a clean canonical Organization entity

**CURRENT — LEGACY SOURCE VERIFIED**

The current multi-user model stores an advisor as `users/{advisorUid}` and links that user to the principal/owner through `organization_id`. The same advisor is also represented under:

```text
users/{ownerUid}/users_sellers/{advisorUid}
```

The production estate contains historical representation drift:

- `organization_id` may be a Firestore `DocumentReference`;
- older code/data may treat it as a string/path-like value;
- the owner can self-reference through the organization relation;
- `admin_id`, `organization_id`, role and assignment are not equivalent fields.

`ungga-landing` explicitly contains compatibility logic to normalize these variants rather than assuming one clean representation.

## 4.3 Legacy claims are not sufficient Gu OS authorization

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The current session resolver documents that some legacy subusers inherited `super-admin` claims. It therefore inspects the Firestore organization relation to decide whether the account is actually an advisor.

Architectural implication:

> **Do not import Firebase custom claims or legacy role strings as direct Gu OS authorization grants.**

They are migration evidence that must be translated into canonical Gu OS Organization Membership / role/grant semantics under ADR-106.

## 4.4 R1 bridge consequence

**TARGET — EXISTING ADR-106**

Conceptually, Gu OS should resolve:

```text
Gu OS Organization
  └─ Traditional Gu external binding
       ├─ legacy organization key
       ├─ principal Firebase UID
       ├─ member/advisor Firebase UIDs
       ├─ Gu/WABA identifiers
       └─ other source-specific IDs
```

Do not make the canonical Gu OS Organization ID equal to `organization_id` or the principal Firebase UID merely because current Traditional Gu often anchors the organization there.

Exact external-identity schema remains **OPEN — TECHNICAL DESIGN**.

## 4.5 Acting context, staff impersonation and field-scoped org permission

**REVALIDATED — 2026-08-31**

`ungga-landing` now resolves an **acting context** distinct from the raw session: staff can impersonate a user ("ver como usuario"), so authorization gates must use the acting uid, not the session claims. A cached helper `ownerUidOf(uid)` (`src/lib/firebase/session.ts`) resolves the organization owner for **any** uid — an owner resolves to their own uid (owners self-reference or lack `organization_id`); an advisor resolves through `organization_id` to the principal. New org-observing gates (for example the WhatsApp-linking pilot) key on `ownerUidOf(actingUid)`.

`PATCH /api/users/me` no longer requires `organizacion.editar` for the whole body: the `users/{uid}` document mixes **person fields** (name, phone, photo, social) and **organization fields** (`type_user`, `org_name`, `web`, `org_location*`, `privacy_url`), and the permission gate is now applied only when organization fields are touched, so advisors can edit their own personal data.

**Status discipline:** these are legacy clarifications of the identity/permission bridge, **not** Gu OS authorization semantics. The existing rule stands unchanged: legacy Firebase claims and role strings must not become Gu OS grants (ADR-106); Gu OS resolves organization authorization explicitly.

---

# 5. Legacy Lead identity and persistence

## 5.1 `lead_id` is a composite operational-context key

**CURRENT — LEGACY SOURCE VERIFIED**

`guv3` constructs the historical Lead identifier as:

```text
lead_id = prospect_phone + bot_phone_number + owner_phone_number
```

for the ordinary WhatsApp path, with controlled exceptions such as playground/test flows.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/firebase/leads.py`
- `UnggaMX/ungga-full/src/guv3/gu/main_app.py`

This source verification confirms the prior architectural interpretation:

> **Legacy `lead_id` identifies a Traditional Gu operational relationship/conversation context. It is not canonical Prospect identity and is not Gu OS Lead Opportunity identity.**

## 5.2 Lead creation writes multiple legacy representations

**CURRENT — LEGACY SOURCE VERIFIED**

Normal creation writes at least:

```text
Firestore
  leads/{lead_id}
  users/{ownerUid}/user_leads/{lead_id}
  leads/{lead_id}/wsp_messeges/{botNumber}

Mongo runtime/context
  gu2.users / related runtime records
```

The Firestore Lead begins with fields such as `Asesor`, `client_type`, `assigned`, `assignment_type`, `new_assignment`, creation/edit timestamps and source context.

The copies are operational representations; R1 must not infer that every similarly named field has identical authority or freshness across stores.

## 5.3 R1 identity rule

**TARGET — EXISTING ARCHITECTURE / S1**

Persist legacy `lead_id` as an **opaque source-scoped external reference**. Do not derive target Gu OS identity by parsing fixed phone lengths from it.

A future operational gateway may expose normalized participants such as:

```text
legacy_lead_id
prospect/contact external identity
Gu channel identity
legacy organization/principal context
assigned advisor if known
```

while preserving the original opaque identifier for source readback/correlation.

## 5.4 Lead-origin classification

**REVALIDATED — 2026-08-31**

`guv3` lead-origin classification (`src/guv3/gu/api/lead_origins.py`, with `gu/core/message_links.py`) is now deterministic and richer: links are extracted from the raw message text (not the LLM tool argument), and origin is derived from real query-string parameters — `src` button marks (`portal-ficha`, `portal-listado`, `gu-compartido`, advisor-shared `wa`) with `utm_source` as fallback, including recognition of AI-assistant referrals (ChatGPT, Gemini, Perplexity, Claude, Copilot, etc., mirrored in the landing's `src/lib/analytics/fuentes.ts`). Gu-shared fichas now use the public portal link tagged `src=gu-compartido`.

**R1 relevance:** this taxonomy is useful **source evidence** for future S1 admission policy (trusted-source eligibility, campaign/listing context behind short inquiries). Legacy origin labels are evidence with provenance, **not** canonical Gu OS admission semantics.

---

# 6. Organization ownership and advisor assignment

## 6.1 Assignment is independent of organization ownership

**CURRENT — LEGACY SOURCE VERIFIED**

The production `/guard-lead-one` path resolves a seller for one Lead at a time and writes assignment across the global Lead, owner copy, seller copy and Mongo runtime projection.

It explicitly implements **sticky assignment**: an already assigned Lead is not automatically reassigned merely because another guard resolution occurs.

Relevant source:

- `UnggaMX/ungga-full/src/services/src/controllers/guardLeadOne.controller.ts`

## 6.2 Current guard assignment is on-demand; older batch path is deprecated

**CURRENT — LEGACY SOURCE VERIFIED**

`periodAssignationControllers.ts` is explicitly marked deprecated and states that it was replaced by `/guard-lead-one` for on-the-fly assignment.

Relevant source:

- `UnggaMX/ungga-full/src/services/src/controllers/periodAssignationControllers.ts`

## 6.3 R1 consequence

**TARGET — ADR-106**

Preserve the distinction:

```text
Organization owns Opportunity
        ≠
current advisor assignment
        ≠
DRI / approver / conversation actor
```

Legacy principal/owner fields and the principal phone embedded in `lead_id` must not silently become R1 assignment or approval authority.

---

# 7. WhatsApp inbound identity and event routing

## 7.1 Provider message ID is available at ingress

**CURRENT — LEGACY SOURCE VERIFIED**

`messageFilter` extracts the WhatsApp message ID, prospect sender number, display/bot number, provider `phone_number_id`, message type/content and context when available.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/lib/filterDataMessage.ts`
- `UnggaMX/ungga-full/src/messageFilter/src/services/webhook.service.ts`

This gives the future operational gateway usable source identifiers for event deduplication/provenance, subject to Technical Design of the event contract.

## 7.2 Incoming webhook routing is queue-based

**CURRENT — LEGACY SOURCE VERIFIED**

After filtering/coalescing, messageFilter publishes payloads to different topics/handlers according to the receiving Gu number. The webhook acknowledges receipt before downstream processing completes.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/lib/handleQueueMessage.ts`
- `UnggaMX/ungga-full/src/messageFilter/src/controllers/webhook.controller.ts`

Architectural implication:

> provider webhook receipt, queue acceptance, Gu processing and business action completion are different states and must remain distinct in R1 event/effect semantics.

---

# 8. Human same-thread takeover and resumption

## 8.1 Owner/advisor activity can transfer conversation authority without ending the Case

**CURRENT — LEGACY SOURCE VERIFIED**

WhatsApp `smb_message_echoes` are interpreted as owner/advisor messages. They enter the Gu runtime with `ownerWritingFromBot=true`.

For the affected Lead, Gu stores runtime state including:

```text
bypass_bot = true
last_owner_interaction_wba = <timestamp>
```

and suppresses automated Gu responses for that conversation.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/services/webhook.service.ts`
- `UnggaMX/ungga-full/src/guv3/gu/main_app.py`

This behavior source-verifies the ADR-107 distinction:

> **human takeover of speaking authority does not inherently erase durable responsibility or Gu's ability to observe/reason.**

## 8.2 Stale standby analysis is guarded against newer human activity

**CURRENT — LEGACY SOURCE VERIFIED**

Before standby analysis proceeds, Gu re-reads `last_owner_interaction_wba` and aborts the stale analysis if the stored value has changed since the candidate analysis was created.

That is a useful brownfield concurrency pattern, but exact implementation should not be promoted as the generic Gu OS mechanism.

## 8.3 Automatic resume is based on >5 minutes, not a six-minute architecture invariant

**CURRENT — LEGACY SOURCE VERIFIED**

The reminder job selects Lead runtime records where:

```text
bypass_bot = true
and last_owner_interaction_wba < now - 5 minutes
```

sets `bypass_bot=false`, and then emits a `chat_analysis=true` message so Gu can reconsider the conversation.

Relevant source:

- `UnggaMX/ungga-full/src/jobFilter/src/reminder/queries/findUsersWithBotFromWBA.ts`
- `UnggaMX/ungga-full/src/jobFilter/src/reminder/index.ts`
- `UnggaMX/ungga-full/src/jobFilter/src/services/MessageService.ts`

Any user-facing copy that says Gu will resume in roughly six minutes is therefore an implementation/UX approximation, not an R1 policy invariant.

## 8.4 Billing can affect the post-takeover analysis path

**CURRENT — LEGACY SOURCE VERIFIED**

The resume job clears `bypass_bot` for eligible records, then suppresses the generated Gu analysis/send for owners whose billing balance is unavailable under the active billing rules. Owners exempt/not-enabled for billing follow separate logic.

R1 should not conflate **conversation authority** with **commercial/billing eligibility**. They are separate gates even if the current job evaluates them in one flow.

---

# 9. Human response from the new owner app converges on the same takeover semantics

**CURRENT — LEGACY SOURCE VERIFIED**

`ungga-landing` `/api/whatsapp/send`:

1. authenticates the session and checks the UI/application permission;
2. loads the target Lead and owner Gu number;
3. sends directly to Meta;
4. captures the returned `wamid`;
5. persists the outbound human message in Firestore and Mongo;
6. synthesizes/forwards a webhook into `messageFilter` so the runtime sees the action as human intervention.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

Architectural implication:

> R1 can treat observable advisor activity from WhatsApp Business and the owner app as inputs into the same generic conversation-authority contract, while retaining source provenance.

The current mechanics are legacy-specific and need not be copied literally.

## 9.1 Advisor-linked WhatsApp capture (`waProbe`) — NEW RELEVANT SEAM

**REVALIDATED — 2026-08-31 (new since the v0.2 audit)**

Traditional Gu now contains an advisor-linked WhatsApp capability, currently pilot-grade:

- **`ungga-full/src/waProbe/`** maintains a **linked-device WhatsApp session per advisor** (the WhatsApp Web mechanism, hosted server-side), exposed through a minimal session API (`POST/GET/DELETE /sessions/:userId`) consumed by the landing onboarding.
- **`ungga-landing`** adds the onboarding/linking flow: QR/pairing from Perfil/onboarding, proxied through `POST/GET/DELETE /api/whatsapp/vinculacion`, which always forwards the **verified session uid** (never a client-supplied id) plus a service token.
- **Pilot / whitelist nature:** enabled **per inmobiliaria** via a hardcoded owner-uid whitelist (`hasWhatsAppPilot(ownerUid)` in `src/lib/beta-features.ts`), enforced at **both** the UI and the API route; advisors inherit access through `ownerUidOf`.
- **Consent-versioned:** the advisor accepts a permissions text tracked by `CONSENT_VERSION` (currently `2026-08-06`); widening capture scope requires re-consent.
- **Known-lead filtering before content capture:** the session resolves the counterpart phone and checks it against a lead index (`bot_phone_number`-scoped Firestore load or local file) **before** reading message content; non-lead traffic is dropped unread and unlogged.
- **Persistence, separate from Gu's LLM memory:** captured advisor↔prospect 1:1 messages (text, transcribed voice notes, described images) are written to Firestore `leads/{lead_id}/wsp_messeges/asesor_<phone>` documents and to Mongo `gu2.chats` per-advisor arrays (`messages_from_<phone>`). **Mongo `messagesv2` — the memory `guv3` feeds to Gu's LLM — is deliberately not touched**, so legacy Gu does not "see" advisor threads; connecting them to Gu reasoning is an explicit future decision requiring `guv3` changes.
- **Advisor endpoint identity:** the linked number is persisted as `users/{uid}.whatsapp_link.{status,phone}` — a source-verified external mapping for the **advisor human WhatsApp endpoint** identity dimension (ADR-106).
- **Operational grade:** the service is a spike — stateful in-process sockets, one per linked advisor, no scale-to-zero, unofficial client. **It is best-effort and MUST NOT become load-bearing for Gu OS correctness**; Gu OS may consume its output as evidence when present.

### 9.1.1 Conversation-authority rule for `advisor_wa` observations

**TARGET — EXISTING ADR-107, clarified by this revalidation**

`advisor_wa` captures are **evidence of off-thread human activity** (the advisor's own WhatsApp with the prospect), reducing the off-thread evidence gap recorded in ADR-107 and S2. They are **not** a conversation-authority transition:

- they do **not** set `bypass_bot` and do not touch the same-thread takeover/resume mechanics of §8 (which remain unchanged);
- they must **not** automatically suppress Gu speaking on the Gu-number conversation;
- any suppression or authority effect derived from observed advisor activity requires explicit, ADR-107-conformant policy plus current authority resolution in Gu OS.

---

# 10. Conversation persistence is deliberately multi-store

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu maintains conversation material in more than one representation:

- Mongo `chats/messagesv2` contains the richer Gu runtime/context history and source/provider identifiers used by several runtime paths;
- Firestore `leads/{lead_id}/wsp_messeges/{botNumber}.conversation` is also written/read by product surfaces;
- outbound worker/template paths write provider IDs and hidden routing metadata into Mongo and user-visible conversation material into Firestore where applicable.

Relevant source includes:

- `UnggaMX/ungga-full/src/guv3/gu/core/notification_functions.py`
- `UnggaMX/ungga-full/src/workers/src/notificator/saveChat.ts`
- `UnggaMX/ungga-landing/src/lib/firebase/leads.ts`

R1 must therefore avoid the statement "Firestore is the source of truth for all conversations" or "Mongo is the source of truth for all conversations." The operational gateway should expose **business-semantic reads with explicit source/evidence semantics** rather than leaking this replication topology into the Case Supervisor.

## 10.1 Multi-thread persistence per Lead

**REVALIDATED — 2026-08-31 (material additive change)**

The Firestore conversation store is now **multi-thread per Lead**. `leads/{lead_id}/wsp_messeges` holds:

- the Gu-number conversation document(s), as before; and
- one `asesor_<phone>` document per linked advisor who attended the prospect from their own WhatsApp (§9.1), whose items carry `source: "advisor_wa"` plus the advisor as author.

The platform (`ungga-landing/src/lib/firebase/leads.ts`) flattens all thread documents into the prospect timeline with typed threads (`gu` vs `advisor`) and enforces **server-side visibility rules**: the owner (and staff) sees every thread; an advisor sees the Gu thread and colleagues' threads but **not their own** (that conversation already lives in their WhatsApp). Mongo `gu2.chats` mirrors advisor threads as `messages_from_<phone>` arrays, while `messagesv2` remains Gu-only LLM memory.

Consequences for R1:

- conversation reads through the operational gateway must model the **thread dimension** (which thread, which participants, which source) and preserve per-item provenance (`source`, author, `wamid`, delivery fields — see §15.7);
- visibility of advisor threads is itself a legacy product semantic to preserve/replace deliberately, not accidentally;
- the v0.2 rule stands, reinforced: **no single legacy store may be promoted to the universal conversation source of truth.**

---

# 11. Appointment creation and persistence

## 11.1 A requested appointment is not yet a confirmed or attended visit

**CURRENT — LEGACY SOURCE VERIFIED**

The appointment assistant explicitly tells the prospect that the requested visit is not necessarily confirmed until the advisor confirms it.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`

## 11.2 Appointment creation can involve Google Calendar before replicated persistence finishes

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The creation flow can:

1. reserve billing credits where enabled;
2. create a Google Calendar event;
3. create/update legacy property-interest context;
4. write the appointment to Firestore;
5. write the appointment to Mongo;
6. confirm the billing operation when the appointment is accepted as created.

The Firestore and Mongo writes are not one transaction.

## 11.3 One successful appointment store is enough for the current flow to continue

**CURRENT — LEGACY SOURCE VERIFIED**

The code treats these outcomes differently:

```text
Firestore success + Mongo success → continue
Firestore success + Mongo failure → continue with warning
Firestore failure + Mongo success → continue with warning
Firestore failure + Mongo failure → cancel billing reservation / return failure
```

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`

Consequences:

- appointment existence is not globally atomic across legacy stores;
- a downstream consumer must be tolerant of partial replication;
- a read from one store cannot automatically prove the other store is synchronized;
- exact recovery/reconciliation semantics need a Gu OS integration contract.

## 11.4 Potential orphan external effect

**CURRENT — LEGACY RISK**

Because Google Calendar creation can precede successful persistence in both operational stores, a failure after Calendar success can leave an external effect requiring reconciliation/cleanup.

R1 must therefore preserve the AC-2 distinction:

```text
external request accepted
confirmed business effect
confirmed failure
unknown/partial outcome
```

and should reconcile before blindly retrying consequential effects.

---

# 12. Visit confirmation and attendance evidence

## 12.1 Appointment status and visit attendance are separate evidence dimensions

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu tracks appointment status/confirmation separately from later satisfaction/visit evidence.

A current tool can update an appointment to values including a confirmed/cancelled/reschedule path and notify the owner/prospect accordingly.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/agents/prospect/visit_tracker_assistant/nodes/tools.py`

## 12.2 Explicit post-visit evidence exists

**CURRENT — LEGACY SOURCE VERIFIED**

The post-appointment survey persists:

```text
property_was_visited = "Afirmativo" | "Negativo"
```

If negative, the flow also sets:

```text
appointment_qualification = "No hubo visita"
```

and can capture additional fields such as `want_to_acquire` and appointment qualification/comments.

This evidence is written to Mongo `appointments` and used in owner notification/follow-up.

## 12.3 R1 evidence mapping

**TARGET — S3 APPROVED / S1 / AC-7**

S3 (`specs/visit-progression-outcome-evidence-reconciliation.md`) is the governing target semantic contract for Visit progression, occurrence, no-show attribution and reconciliation. The table below maps source-verified legacy evidence into those target semantics; it does not promote legacy appointment statuses into canonical Gu OS Visit states.

| R1 concept / claim | Legacy evidence candidate | Required caution |
|---|---|---|
| `visit_requested` | appointment successfully created in an accepted operational source | partial-replication awareness required; target Gu OS may recognize a sufficiently concrete Visit request earlier than legacy persistence |
| `visit_scheduled` | date/time plus source-specific scheduling/confirmation evidence | do not equate mere request or Calendar-event existence with a sufficiently reliable arrangement |
| scheduling/readiness confirmation evidence | explicit advisor/prospect confirmation and related source evidence | confirmation is claim-specific evidence supporting scheduling/readiness; S3 does **not** define a mandatory canonical `visit_confirmed` progression milestone |
| `visit_attended` | explicit `property_was_visited = Afirmativo` or future equivalent admissible occurrence evidence | appointment existence/confirmation alone is insufficient; assigned-advisor physical presence is not required |
| Visit non-occurrence | explicit `property_was_visited = Negativo` / `appointment_qualification = "No hubo visita"` or future equivalent admissible evidence | establishes/supports non-occurrence, not automatically its cause or an actor-specific no-show |
| actor-specific no-show | additional admissible evidence that a particular expected actor failed to participate without sufficient prior cancellation/reschedule evidence | silence, missing survey fields and generic `Negativo` evidence are insufficient by themselves |
| unresolved Visit occurrence | no defensible occurrence/non-occurrence conclusion yet, or unresolved material conflict | preserve `unknown`/conflict; reconcile only when materially worthwhile and use durable Work only when the reconciliation needs durable execution semantics |

This mapping does not lock exact Case Fact keys, evidence enums, source-priority rules or persistence mechanics; those remain Technical Design concerns under the approved S3 behavior.

---

# 13. Legacy Deal semantics

## 13.1 Deal is created as property-specific context

**CURRENT — LEGACY SOURCE VERIFIED**

Traditional Gu creates Deal records around a Lead's relationship to a specific property. The Mongo representation is minimal and can include:

```text
lead_id
property_uid
asesor
origin
portal
```

and the Firestore representation is likewise tied to Lead + property context.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/mongo/deals.py`
- `UnggaMX/ungga-full/src/guv3/gu/tools/appointment_assistant_tools.py`
- related Firestore Deal helpers in `guv3`

## 13.2 Appointment creation can create/update Deal context

**CURRENT — LEGACY SOURCE VERIFIED**

A prospect asking to visit a specific property may cause a Legacy Deal to exist before any concrete Transaction Operations responsibility exists.

Therefore source verification closes the prior ambiguity:

```text
Legacy Deal
≠ Transaction Case
≠ "transaction started"
```

## 13.3 R1 rule

**TARGET — S1 / ADR-109 boundary**

Treat Legacy Deal as property-interest/commercial-context evidence. A Transaction Case should be created/associated only when the separate Transaction boundary predicate is satisfied by the appropriate domain/source evidence.

The resulting Opportunity↔Transaction Case association does not automatically close the Opportunity.

---

# 14. Property authority and search-serving topology

## 14.1 Firestore is the original Traditional Gu property record

**CURRENT — LEGACY SOURCE VERIFIED**

`guv3` documents that Mongo `property_data` is a copy maintained from Firestore and that Gu normally reads that Mongo representation for serving/search.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/db/firebase/properties.py`

## 14.2 Mongo property copy can be incomplete

**CURRENT — LEGACY SOURCE VERIFIED**

The source explicitly handles properties that exist/publish in Firestore but are absent from `property_data` because historical bulk imports did not always trigger the normal sync path. Gu therefore falls back to Firestore and maps the record into the serving shape expected by the rest of the runtime.

Consequences:

```text
Firestore properties = original/current Ungga property record
Mongo property_data = operational serving/search copy
Qdrant / embeddings = semantic retrieval/index layer
```

Do not make Mongo/Qdrant the canonical authority merely because Gu searches them first.

Upstream CRM authority may still be field/source-specific for imported inventory; AC-2's fact/source-aware model remains the governing target.

---

# 15. Outbound WhatsApp effect contract

## 15.1 Queue/API acceptance is not delivery evidence

**CURRENT — LEGACY SOURCE VERIFIED**

The Traditional Gu outbound notification seam can accept/enqueue a request before the provider call has completed. A successful caller response therefore cannot be interpreted as proof that the prospect received the message.

## 15.2 Worker obtains provider `wamid`

**CURRENT — LEGACY SOURCE VERIFIED**

The worker eventually calls Meta and extracts:

```text
r.data.messages[0].id
```

as the WhatsApp message ID (`waId` / `wamid`) and can persist it with the associated chat/template record.

Relevant source:

- `UnggaMX/ungga-full/src/workers/src/notificator/notificator.app.ts`
- `UnggaMX/ungga-full/src/workers/src/notificator/whatsapp/whatsapp.ts`
- `UnggaMX/ungga-full/src/workers/src/notificator/saveChat.ts`

## 15.3 Failure status is correlated later by provider ID

**CURRENT — LEGACY SOURCE VERIFIED**

`messageFilter` inspects Meta status webhooks for `failed` and forwards/persists failed-template information including provider message ID and error data.

Relevant source:

- `UnggaMX/ungga-full/src/messageFilter/src/controllers/webhook.controller.ts`

The audited path does not establish a single end-to-end contract that returns provider outcome to the original enqueue caller.

## 15.4 Direct human-send route demonstrates why HTTP 200 is not enough

**CURRENT — LEGACY SOURCE VERIFIED**

The owner app documents a production behavior where Meta may accept a free-text POST with HTTP 200 + `wamid` while the 24-hour service window is closed and later report failure/discard via webhook. The route therefore calculates the window before send and persists the `wamid` so later failure callbacks can be correlated.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

This is strong evidence for AC-2's `unknown outcome` semantics.

## 15.5 Legacy retries are not sufficient Gu OS idempotency

**CURRENT — LEGACY SOURCE VERIFIED / LEGACY RISK**

The direct Gu sender has bounded retries with backoff, but the audited function does not expose a Gu OS-style logical idempotency key across attempts.

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/core/notification_functions.py`

## 15.6 R1 target wrapper

**TARGET — AC-2 / ADR-107**

The preferred initial transport is still reuse/wrapping of a Traditional Gu send capability, but the Gu OS-facing contract must conceptually preserve:

```text
Case / Work Item / Attempt correlation
logical operation / idempotency identity
current authority + engagement-policy revalidation
request accepted vs provider accepted vs later failed/unknown
wamid/provider correlation
reconciliation before dangerous repeat
result/evidence persisted on Work Attempt
```

Exact transport endpoint and whether the wrapper calls queue/service/direct provider paths are **OPEN — TECHNICAL DESIGN**.

## 15.7 Delivery-status writeback into the conversation store

**REVALIDATED — 2026-08-31 (strengthened evidence path)**

`saveFailedTemplates.controller.ts` now propagates late provider failure callbacks into the **user-visible conversation store**: the conversation item matching the provider `wamid` in `leads/{lead_id}/wsp_messeges` is updated with `delivery_status: "failed"` and, when reported, `delivery_error_code`. Previously a Meta-rejected message could keep its "sent" appearance in the platform chat forever. The platform chat renders these delivery fields per item.

Retry semantics are now explicit and **asymmetric**:

- only **template** messages enter the `unsent_templates` retry queue (retry re-enqueues from `template_payload`);
- **free-text** messages (for example advisor sends from the platform) are marked failed but are **never queued for retry**.

The v0.2 contract stands unchanged and is reinforced: **HTTP/queue acceptance ≠ provider acceptance ≠ delivery ≠ final outcome.** For Gu OS, the Firestore `delivery_status`/`delivery_error_code` fields are an additional **delivery-evidence read source** for the future `send_prospect_message` reconciliation design; they do not replace the Work-attempt/idempotency wrapper required by §15.6.

---

# 16. Current authorization risks that Gu OS must not inherit

These findings are recorded because they affect the safety of R1 capability reuse. They are not a requirement to refactor all Traditional Gu authorization inside R1.

## 16.1 Appointment mutation helper can over-authorize `super-admin`

**CURRENT — LEGACY RISK**

In `ungga-landing`, appointment confirm/reschedule routes require a session and an activity permission. They then call `canActOnAppointment()`.

The helper returns allowed for a session role of `staff` **or `super-admin`** before checking the appointment's organization/Lead ownership.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/appointments/[id]/confirm/route.ts`
- `UnggaMX/ungga-landing/src/lib/appointments-access.ts`
- `UnggaMX/ungga-landing/src/lib/firebase/require-permission.ts`

Given the audited code path, a brokerage owner with a known foreign appointment `_id` may pass the ownership helper even when the appointment belongs to another organization.

R1 implication:

> **Gu OS capabilities must resolve organization authorization explicitly; `super-admin` must not mean cross-tenant authority.**

## 16.2 Human WhatsApp-send route needs organization ownership revalidation in the Gu OS wrapper

**CURRENT — LEGACY RISK**

The audited `/api/whatsapp/send` route reads a global `leads/{leadId}` and resolves the sending Gu number from the current session. In the inspected route, no explicit `ownerHasLead()`/organization ownership check is performed before the provider send.

Relevant source:

- `UnggaMX/ungga-landing/src/app/api/whatsapp/send/route.ts`

This is another reason to treat current owner-app permissions as a product-layer legacy gate, not a reusable Gu OS authority contract.

## 16.3 Scope response

R1 should:

- deny cross-organization reads/effects at the operational gateway/capability boundary;
- revalidate organization + actor/grant + Case/runtime/conversation authority before material effects;
- add cross-tenant negative tests;
- avoid requiring a broad legacy security cleanup unless a selected adapter cannot be safely bounded without one.

## 16.4 Revalidation status of these risks

**REVALIDATED — 2026-08-31**

The audited routes behind §16.1 (`appointments-access.ts` `super-admin` over-authorization) and §16.2 (`/api/whatsapp/send` without explicit organization-ownership revalidation) are **unchanged at the revalidation heads — both risks persist**.

**CURRENT — LEGACY RISK (new observation):** `ungga-landing/src/lib/beta-features.ts` currently ships `REDESIGN_REVIEW_OPEN_ACCESS = true` — a temporary switch, explicitly marked for removal, that makes **all routes and nav items visible regardless of role/beta/multi-user gating** while the platform redesign lasts. Route-level permission gates still apply where present, but module/nav gating is bypassed. This is additional evidence for the standing rule: **legacy product-layer visibility/access must not be inherited as Gu OS authority**; Gu OS capabilities resolve organization/actor authorization explicitly regardless of what the legacy UI exposes.

---

# 17. Billing caller contract relevant to R1

**CURRENT — LEGACY SOURCE VERIFIED**

The appointment flow uses the billing service through a reserve/confirm/cancel pattern:

```text
reserve operation
    ↓
perform appointment work
    ↓
confirm charge on accepted creation
or
cancel reservation on failure
```

Relevant source:

- `UnggaMX/ungga-full/src/guv3/gu/services/billing_service.py`
- appointment assistant caller

This is enough for the current R1 source boundary. The billing backend's internal ledger/schema is **OUT OF R1 AUDIT SCOPE** because ADR-110 and later pricing/credits work own the broader economic/billing design.

Internal cost-to-serve remains separate from customer credits/billing.

---

# 18. Source-of-record / operational-role matrix after audit

R1 should use a fact/source-aware matrix rather than the statement "Traditional Gu's database is the source of truth."

| Concept / responsibility | Current source-verified legacy role | R1 target interpretation |
|---|---|---|
| Human authentication identity | Firebase Auth | external user identity mapped to Gu OS User/Membership |
| Principal/account user | Firestore `users/{uid}` | legacy principal external identity; not canonical Organization by itself |
| Legacy organization/membership | Firestore `users` + `users_sellers`, mixed `organization_id` representations | explicit Gu OS Organization + Membership + external bindings |
| Advisor assignment | Firestore Lead/user-lead representations + Mongo runtime mirror | organization-owned Opportunity with separate assignment/DRI |
| Legacy Lead | Firestore Lead record plus Mongo runtime context | operational source record; opaque external reference |
| Conversation runtime/context | richer Mongo `chats/messagesv2` plus Firestore conversation representation | bounded semantic conversation/event capability with provenance |
| Human conversation authority | Mongo Lead runtime `bypass_bot` + `last_owner_interaction_wba`, driven by observable human activity | generic ADR-107 conversation-authority state/policy |
| Appointment | replicated Firestore + Mongo operational record; partial success tolerated | source-aware external record + Gu OS evidence/reconciliation |
| Visit attendance | explicit post-visit survey fields in Mongo appointment | evidence-backed Gu OS progression fact/projection |
| Legacy Deal | Firestore/Mongo property-specific interest context | evidence only until Transaction boundary is satisfied |
| Property original/current Ungga record | Firestore `properties` | source-aware authoritative property read |
| Property serving/search | Mongo `property_data` + semantic index | search/read optimization, not authority by itself |
| WhatsApp provider effect | Meta request + `wamid` + later status webhooks | Work-backed correlated effect with unknown-outcome reconciliation |
| Advisor↔prospect off-thread conversation (revalidated 2026-08-31) | `waProbe` capture → Firestore `asesor_<phone>` threads + Mongo per-advisor arrays; excluded from `messagesv2` | best-effort evidence source with provenance; never load-bearing for Gu OS correctness; no authority effect without ADR-107-conformant policy |
| BigQuery mirrors | delayed analytical copies | analytics/evaluation only, not live operational authority |
| Customer credits/billing | current billing service/backend | separate contract from internal economic telemetry |

---

# 19. Consequences for the temporary Traditional Gu binding

The current manually configured legacy organization binding can remain for the lab/pilot, but its architectural meaning is now explicit.

Treat it as:

> **bootstrap external identity used to locate Traditional Gu/warehouse context, not authoritative Gu OS tenancy.**

Target evolution:

```text
Gu OS Organization
  └─ verified Traditional Gu binding
       ├─ source system
       ├─ legacy organization key
       ├─ principal Firebase UID
       ├─ Gu/WABA identity
       ├─ verification/provenance
       └─ migration status
```

The runtime should eventually derive source access from the **current authorized Gu OS Organization** plus its verified binding rather than trusting an arbitrary organization identifier supplied by a user/model.

Exact schema and verification workflow remain **OPEN — TECHNICAL DESIGN**.

---

# 20. Technical-Plan entry conclusions

The audit resolves the minimum source questions required by AC-1 through AC-4 and S1 sufficiently to enter Technical Planning.

The Technical Plan may now assume, subject to normal implementation-time revalidation of changed source code:

1. Firebase UID is the current Traditional Gu human external identity.
2. `organization_id` is a transitional principal/organization bridge with mixed representation; it is not canonical Gu OS Organization identity.
3. Legacy `lead_id` is an opaque operational-context external ID.
4. Organization ownership and advisor assignment are distinct.
5. Observable human activity can drive conversation takeover; current timeout/resume numbers are implementation policy, not architecture.
6. Mongo/Firestore conversation representations are brownfield sources/projections, not one universal truth.
7. appointment creation is replicated and can partially succeed; reconciliation is required for strong Gu OS semantics.
8. visit attendance requires explicit evidence; missing evidence remains unknown.
9. Legacy Deal does not establish Transaction start.
10. Firestore is the original/current Traditional Gu property record while Mongo/Qdrant are serving/search layers.
11. Traditional Gu outbound transport exposes useful provider IDs and later failure evidence but needs a Gu OS command/effect wrapper.
12. selected legacy authorization paths are insufficient as organization-scoped Gu OS authority checks.
13. BigQuery remains analytical and must not govern live R1 decisions.

Added by the 2026-08-31 revalidation:

14. The Firestore conversation store is multi-thread per Lead (Gu thread(s) + `asesor_<phone>` advisor threads with `source: "advisor_wa"` and server-side visibility rules); gateway conversation reads must model the thread dimension.
15. `advisor_wa` captures are evidence of off-thread human activity, not a conversation-authority signal; they do not set `bypass_bot` and must not automatically suppress Gu.
16. Provider failure callbacks write `delivery_status`/`delivery_error_code` onto the Firestore conversation item by `wamid` — an additional delivery-evidence read source for send reconciliation; only template messages are retried by the legacy queue.
17. `waProbe` is pilot/spike-grade (stateful per-advisor sockets, whitelist-gated, consent-versioned); Gu OS may consume its output as evidence but must not depend on it for correctness.

Remaining work is no longer an **architecture source-audit blocker**. It is downstream **Technical Design / adapter implementation / verification work**.

---

# 21. Open Technical Design questions

This audit deliberately leaves the following unresolved for the Technical Plan/implementation specs:

- exact operational-gateway service/process boundary;
- exact external-identity mapping schema and migration/backfill strategy;
- event envelope, source-event deduplication key and inbox/outbox mechanics;
- how Gu OS correlates legacy `wamid`/appointment IDs/provider IDs to Work Item Attempts;
- whether a selected Traditional Gu outbound seam is wrapped as-is or narrowed behind a new internal endpoint;
- exact organization authorization lookup before each legacy capability;
- appointment read precedence/reconciliation when Firestore and Mongo disagree;
- write compensation/reconciliation for Google Calendar or other partial external effects;
- exact visit Fact keys and source-admissibility rules;
- exact source/event freshness SLAs;
- exact lab bootstrap-binding migration into canonical Organization external bindings;
- observability/alerting for authorization conflicts, source drift and reconciliation failures.

Added by the 2026-08-31 revalidation:

- admissibility rules for `advisor_wa` evidence (which claims advisor-thread messages may support in S2/S3 semantics, and with what confirmation requirements);
- whether/how the operational gateway exposes advisor threads (thread dimension, visibility semantics, freshness) versus Gu-thread-only reads for the first slices;
- how the Firestore `delivery_status`/`delivery_error_code` writeback participates in the `send_prospect_message` reconciliation contract alongside `wamid` correlation and failure webhooks.

These questions should not reopen the accepted product/architecture semantics unless implementation evidence exposes a genuine contradiction.

---

# 22. Audit completion statement

> **R1's minimum Traditional Gu production-source audit is complete for Architecture Analysis and Technical-Plan entry. The audit source-verifies identity/organization bridging, Legacy Lead composition, assignment, WhatsApp event/takeover/resume behavior, appointment persistence, visit evidence, Legacy Deal semantics, property source/search roles, outbound provider correlation and relevant authorization risks. These findings refine source status and brownfield adapter requirements; they do not reopen AC-1 through AC-10 or change the approved S1 behavioral contract. The approved S3 Visit Spec now governs target Visit progression, occurrence, no-show attribution and reconciliation semantics while this audit remains the source-verified record of legacy behavior.**

v0.3 extends this statement with the targeted drift revalidation of 2026-08-31 (§23): the revalidation confirms the audited contracts at the new branch heads, records the additive changes described in §4.5, §5.4, §9.1, §10.1, §15.7 and §16.4, and does not alter the completion status above.

---

# 23. Targeted drift revalidation — 2026-08-31

## 23.1 Method and scope

Performed from the Gu OS side as a **targeted R1-relevant drift revalidation**, not a full new audit:

1. current remote heads resolved independently (`git ls-remote`);
2. both repositories partial-cloned; the v0.2 audit pins verified as **ancestors** of the current heads (fast-forward history, no rewrites);
3. full `diff --stat` between pin and head for each repo;
4. targeted diffs/reads on every changed file relevant to the §3 question set plus all newly added code;
5. audited files with no diff were classified STILL VALID without re-reading their v0.2 content.

## 23.2 Pins and heads

| Repo / branch | v0.2 audit pin (2026-08-28) | Revalidation head (2026-08-31) | Commits |
|---|---|---|---|
| `UnggaMX/ungga-full` @ `gcp/main` | `ae9f107a1d53c8bc25a327bece5701aac192ac49` | `c88792530152c0c91a1e74c59e26a416103e68ff` | 6 |
| `UnggaMX/ungga-landing` @ `main` | `77e3dc7fb562f9b249a5d5ec7f8f159e6f2ccdfa` | `82cab192bec2f23a0709c57ce06204d21007a179` | 24 |

## 23.3 Contract classification

| Audited contract (v0.2) | Classification |
|---|---|
| §4 Firebase Auth identity; `organization_id` principal bridge; claims unreliable | STILL VALID (reinforced by `ownerUidOf` / acting-context — §4.5) |
| §5 `lead_id` composition; multi-representation Lead creation | STILL VALID (untouched); lead-origin taxonomy clarified — §5.4 |
| §6 organization ownership vs sticky assignment (`guard-lead-one`) | STILL VALID (untouched) |
| §7 WhatsApp inbound identity, provider IDs, queue-based webhook | STILL VALID (untouched) |
| §8 same-thread takeover (`bypass_bot` + `last_owner_interaction_wba`), >5-min resume, billing gate | STILL VALID (untouched) |
| §9 owner-app send convergence (`/api/whatsapp/send`, `wamid`, webhook synthesis) | STILL VALID (route untouched) |
| §10 conversation persistence multi-store | MATERIAL CHANGE (additive) — multi-thread per Lead; §10.1 |
| §11 appointment creation partial persistence / Calendar orphan risk | STILL VALID (untouched) |
| §12 visit confirmation and attendance evidence | STILL VALID (untouched) |
| §13 Legacy Deal semantics | STILL VALID (untouched) |
| §14 property Firestore-original / Mongo-serving / Qdrant topology | STILL VALID; Gu now shares the public-portal ficha tagged `src=gu-compartido` (link behavior refined) |
| §15 outbound provider correlation; acceptance ≠ delivery; legacy retries insufficient | VALID WITH CLARIFICATION (strengthened) — delivery-status writeback and template-only retry; §15.7 |
| §16 authorization risks | STILL VALID — risks persist; new temporary open-access observation; §16.4 |
| §17 billing caller contract | STILL VALID (untouched) |
| — Advisor-linked WhatsApp capture (`waProbe`) | NEW RELEVANT SEAM — §9.1 |
| — Acting context / staff impersonation / field-scoped org permission | VALID WITH CLARIFICATION — §4.5 |

## 23.4 Architectural conclusion

> **The observed drift does NOT contradict S1–S4, does NOT reopen AC-1 through AC-10, and does NOT reopen ADR-106 through ADR-110.** The advisor-linked WhatsApp pilot in fact supports accepted direction: it begins to reduce the off-thread evidence gap ADR-107 already anticipates, and it supplies a source-verified mapping for the advisor human-WhatsApp endpoint identity dimension of ADR-106. The multi-thread conversation store and delivery-status writeback **strengthen the need for the bounded operational gateway** (business-semantic, thread-aware, provenance-preserving reads rather than raw store access) and add useful **evidence, identity and delivery seams** for Technical Design. `advisor_wa` capture remains evidence, never authority; `waProbe` remains best-effort and must not become load-bearing for Gu OS correctness.
