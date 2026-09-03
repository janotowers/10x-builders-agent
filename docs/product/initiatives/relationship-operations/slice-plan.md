# Integrated R1 Relationship Operations — Slice Plan

> **Version:** v1.1  
> **Status:** Approved — governing R1 Slice Plan; SL-1 **READY**, not yet Executable (case-B credential prerequisite unprovisioned)  
> **Owner:** engineering owner (R1)  
> **Initiative:** R1 Relationship Operations — [`brief.md`](brief.md)  
> **Governing Specs:** S1 [`lead-opportunity-lifecycle.md`](specs/lead-opportunity-lifecycle.md) · S2 [`situational-progression-next-work-human-authority.md`](specs/situational-progression-next-work-human-authority.md) · S3 [`visit-progression-outcome-evidence-reconciliation.md`](specs/visit-progression-outcome-evidence-reconciliation.md) · S4 [`work-portfolio-supervisory-experience.md`](specs/work-portfolio-supervisory-experience.md)  
> **Architecture / ADRs:** [`architecture-analysis.md`](architecture-analysis.md) (AC-1…AC-10) · [ADR-106](../../../adr/ADR-106-organization-native-multiseat-tenancy.md) · [ADR-107](../../../adr/ADR-107-runtime-conversation-authority.md) · [ADR-108](../../../adr/ADR-108-versioned-organization-policy.md) · [ADR-109](../../../adr/ADR-109-generic-case-relationships-lineage.md) · [ADR-110](../../../adr/ADR-110-resource-usage-cost-attribution.md)  
> **Technical Plan:** [`technical-plan.md`](technical-plan.md) (v1.5)  
> **Supporting sources:** [`legacy-source-audit.md`](legacy-source-audit.md) · [`r1-concept-shared-kernel-mapping.md`](r1-concept-shared-kernel-mapping.md)  
> **Development method:** [`agentic-product-software-development-methodology.md`](../../../development/agentic-product-software-development-methodology.md) v0.3.1  
> **Artifact role:** Owns the **durable Slice contracts** for R1 and their order. It does **not** own intended behavior (the four approved Specs do), consequential architecture (the Architecture Analysis and ADR-106…110 do), approved technical realization and sequencing (the Technical Plan does), just-in-time implementation Tasks and pre-PR execution context (the agent runtime does), or recorded execution state — branch, commits, PR, CI, merge, Actions, environment approvals (GitHub does).

This is the first Gu OS initiative migrated to the Slice planning model of Methodology §10–§10.4, §12.1–§12.2, §14.2 and §19.1–§19.2. Slice contracts here were **extracted** from approved Technical Plan v1.4 §9; no scope, behavior, acceptance meaning, architecture decision or sequencing was changed in the move. Section 8 records what the migration exposed and needs human resolution.

## 1. How to read this plan

- The **Specs** own intended behavior. A Slice owns a bounded increment that proves part of it, or a required enabling capability.
- Slice contracts are written **rolling wave**: SL-0 as a completed historical Slice, SL-1 as a **full Slice contract at the current planning depth**, SL-2…SL-13 as stubs carrying only enough to sequence, size and prioritize them. "Full" describes depth relative to the stubs, not finality — a Slice contract can still be refined by its readiness/elaboration pass.
- **Tasks are not written here.** They are derived by the coding agent once a Slice is Ready, Planned and Executable.
- **Readiness lives here; execution stage does not.** A Slice can be READY with nobody assigned; the Accountable / DRI is confirmed at planning time and recorded in §5.
- Nothing in this document is a live status board. See §5.
- Stage gates (**shadow** SL-0…SL-8b → **assisted** SL-9…SL-10 → **selective live** SL-11+) are business/authority gates per Methodology §12, **not** per-Slice approvals, and are not readiness conditions. They live in Technical Plan §5.

## 2. Shared baseline

Every non-trivial R1 Slice inherits the following, so individual contracts record only their delta. Extracted verbatim in substance from Technical Plan §9 legend, §6 and §8 — neither strengthened nor weakened here.

- **Baseline Definition of Done** (Technical Plan §9 legend): type-check / lint / validators green; module selftests wired into `test:selftests` and green; **flags off ⇒ inert**; correlation-coverage check (applies from SL-2); docs-sync note.
- **Cross-tenant negative suite** (Technical Plan §8): the two-orgs read-and-write fixture suite is required from SL-0 and **gates every multi-seat surface (SL-7+)**. Landed at SL-0 as `npm run test:rls` with its own CI job.
- **Security / tenancy invariants** (Technical Plan §6): membership-EXISTS RLS plus restrictive org-tenancy guards; `is_active_org_member` hardening; explicit `organizationId` on every service-role helper; Case-child tenancy **derived from the parent Case**; `authorizeOrgAction` on every server-route mutation; authorization resolved **before** any model context or ranking; opaque external ids only; gateway checks the org external binding **before every legacy read**.
- **Shadow-stage constraint** (Technical Plan §5): for SL-0…SL-8b there are **no prospect-facing effects**; supervisor decisions are logged and compared only.
- **Compatibility**: additive-only migrations; rollback for every table = flag off ⇒ rows inert audit data.
- **Evidence discipline** (Methodology §14): an agent assertion does not close a Slice; the declared Release Scope's evidence does.

Migration numbers are **never pre-reserved** — Technical Plan §3 defines symbolic units claimed in landing order at implementation time. Slice contracts therefore name the symbolic unit, never a number.

## 3. Slice index

Order, dependencies and Release Scope at a glance. Detail lives in §4; technical sequencing rationale stays in [`technical-plan.md`](technical-plan.md) §9.

| Slice | Title | Type | Depends on | Inspectable outcome (one line) | Release Scope | Readiness |
|---|---|---|---|---|---|---|
| SL-0 | Org substrate & pilot bootstrap | enabling capability | — | Alebrixe is a real Organization in the system, and Organization-owned data is provably isolated from other tenants | RS-2 (achieved) | N/A — historical Done; see §6 |
| SL-1 | Gateway reads v1 (bootstrap) | enabling capability | SL-0 | Four bounded read capabilities exist and are fixture-verified with provenance and an Organization binding check; the real hosted path is proven in staging for an Alebrixe lead — with provenance and freshness metadata — and its thread-aware messages | RS-2 | **READY** — see §4 |
| SL-2 | Admission (shadow) | behavior | SL-0, SL-1 | Real inbound leads produce admission dispositions and shadow Opportunity Cases with visible policy-version attribution | RS-2 (indicated) | NOT READY — stub |
| SL-3 | Duplicate & supersession flows | behavior | SL-2 | Duplicate and superseded leads resolve to one canonical Opportunity with queryable lineage, without mutating Case rows | RS-2 (indicated) | NOT READY — stub |
| SL-4 | Supervisor loop (shadow) | behavior | SL-2 | Multi-day shadow Opportunities carry a coherent posture history and tracked commitments, reconstructable by replay | RS-2 (indicated) | NOT READY — stub |
| SL-5 | Event wake-ups (prod) `[L:C1]` | enabling capability | SL-2 | A signed forwarded legacy event wakes the right Case within the agreed SLA, and polling is retired | TBD at elaboration | NOT READY — stub |
| SL-6 | Bindings + authority (advisory) `[L:C2 advisory]` | enabling capability | SL-2 | For pilot conversations the resolver's authority answer matches observed reality, log-only, with conflicts failing safe | RS-2 (indicated) | NOT READY — stub |
| SL-7 | Work Portfolio v1 (deterministic) | behavior | SL-0, SL-4 | An advisor sees a predicate-ranked attention list with WHY / WHAT / WHY-NOW, and snooze can never hide must-surface work | TBD at elaboration | NOT READY — stub |
| SL-8 | Visit evidence v1 (shadow) | behavior | SL-4, SL-5 | A real appointment lifecycle produces visit facts that preserve *unknown*, do not inflate on reschedule, and retain conflict | RS-2 (indicated) | NOT READY — stub |
| SL-8b | Transaction boundary seam (shadow) | behavior | SL-3, SL-8 | A concrete offer creates a Transaction shell Case and an association edge with evidence on both timelines, leaving the Opportunity open | TBD at elaboration | NOT READY — stub |
| SL-9 | Message effects (assisted) `[L:C3; C6 hard gate]` | behavior | SL-4, SL-6, **C6 live** | An approved prospect message is sent, correlated by `wamid`, and reconciled to delivered / failed / unknown — with zero unapproved sends | TBD at elaboration | NOT READY — stub |
| SL-10 | Appointment effects (assisted) `[L:C7]` | behavior | SL-8, SL-9 | An approved appointment create / reschedule / cancel round-trips into the legacy stores and updates visit facts with provenance | TBD at elaboration | NOT READY — stub |
| SL-11 | Authority transfer (selective live) `[L:C2 enforcing]` | behavior | SL-6, SL-9, SL-10 | Each pilot Opportunity is answered by exactly one runtime, and human takeover suppresses Gu while the Case continues | TBD at elaboration | NOT READY — stub |
| SL-12 | Portfolio v2 (contextual ranking) | behavior | SL-7 (+SL-8 for richer evidence) | Ranking is model-contextual with evidence-grounded explanations, and must-surface work is never suppressed | TBD at elaboration | NOT READY — stub |
| SL-13 | Economics v1 | behavior | SL-9 | The send path emits keyed usage that rolls up to a proven identity, and late valuations land without rewriting history | TBD at elaboration | NOT READY — stub |

`[L:Cn]` = needs cross-repo contract Cn live (Technical Plan §4). Readiness is a property of the Slice (Methodology §10.2), and its only values are **READY** and **NOT READY**; **no Accountable / DRI, Execution Cycle or planning status is assigned in this document.** SL-0 is not evaluated for readiness at all — it is completed history, and **Done is a completion concept, never a third readiness value.**

## 4. Slice contracts

---

### SL-0 — Org substrate & pilot bootstrap

**Historical, completed Slice.** Recorded here to preserve its place in the sequence. Its authoritative closure evidence lives, and stays, in [`technical-plan.md`](technical-plan.md) §9 ("Execution status — SL-0"); it is referenced rather than duplicated.

- **Type:** enabling capability
- **Inspectable outcome / value:** Alebrixe exists as a real Organization resolvable end-to-end from its legacy identity, pilot seats are explicit, and Organization-owned data is provably isolated from other tenants on both read and write paths — the prerequisite every multi-seat R1 surface depends on.
- **Governing behavior / traceability:** TD-1 (Organization, membership, contacts, external identity), TD-7 (Case relationships primitive), M-CASE-ORG; architecture contract **AC-3** (Organization, Membership, Tenancy & Identity); **ADR-106** (organization-native multi-seat tenancy); **ADR-109 §9** (Organization containment for Case relationships). No Spec acceptance scenario is claimed: SL-0 is an enabling substrate, not user-visible behavior.
- **Dependencies:** none.
- **Release Scope:** **RS-2 (hosted)** — achieved. Deterministic evidence plus hosted evidence in the `Gu-OS-Stage` environment. Production was deliberately **not** reached; that is Gate B.
- **Estimate / confidence:** *not available — predates the Slice calibration model.*
- **Material risk:** tenancy and authority boundary change (highest-consequence class in Technical Plan §6); mitigated by the cross-tenant negative suite becoming a release gate.
- **Readiness:** historically Done; not reinterpreted through current readiness machinery.

**Slice Acceptance Contract** — the four DoD clauses approved in Technical Plan v1.0 §9, all evidenced:

| ID | What must be demonstrably true | Governing source | Evidence type |
|---|---|---|---|
| SA-0.1 | Alebrixe Organization resolvable end-to-end | TD-1 bootstrap | hosted verification (`Gu-OS-Stage`) |
| SA-0.2 | Cross-tenant negative fixtures pass on **read and write** paths | TD-1 RLS matrix, Technical Plan §8 | deterministic suite + hosted verification with real user JWTs |
| SA-0.3 | `is_active_org_member` hardening asserted (fixed `search_path`, qualified references, `EXECUTE` restricted) | TD-1 invariant, §6 | deterministic suite |
| SA-0.4 | JSONB fallback still works | TD-1 bootstrap (discovery source, not key) | hosted verification |

**Definition of Done:** satisfied. See the Done record in §6.

---

### SL-1 — Gateway reads v1 (bootstrap)

**Full Slice contract at the current rolling-wave planning depth** — substantially more detail than the SL-2…SL-13 stubs, and still open to refinement by the dedicated readiness/elaboration pass, which has not run. This is the next candidate for execution, not an authorized one. It is a **planning artifact only**: no Tasks, file-level plans or implementation decisions are made here, and approval of this plan does not authorize execution.

- **Type:** enabling capability. SL-1 delivers a prerequisite contract that SL-2 and every later shadow Slice depend on; it is independently verifiable in its own right, and it produces no user-visible Relationship behavior on its own.
- **Inspectable outcome / value:** two distinct things become true, and the contract below proves exactly these and no more.
  - **(a) The bounded read capability surface exists and is contract-verified.** All four capabilities — lead context, recent **thread-aware** messages, appointment read, property read — return normalized results against recorded contract fixtures, each carrying **provenance**, each gated by an Organization external-binding check, with no generic CRUD tool and no reachable prospect-facing effect. When a source shape drifts away from its fixture, an operator is paged rather than the system silently returning wrong data.
  - **(b) The real hosted read path is proven — for the lead and its messages.** In staging, a **real Alebrixe lead** is read with **provenance and freshness metadata**, and its recent messages are read thread-aware.
  - **Deliberately not claimed:** the appointment and property capabilities are established and fixture-verified under (a), but the approved v1.4 DoD does **not** require them to be exercised against real hosted data, so this Slice does not claim a real appointment or a real property was operationally read. Strengthening the hosted evidence contract to cover them would be an explicit decision at the readiness/elaboration pass, not a silent addition during this migration.
  - **Freshness, precisely.** These are *fresh operational* read capabilities by architecture — that is TD-5's and AC-1's whole point, and nothing here weakens it. What the governing sources establish per result is **provenance** ("provenance on every result", TD-5); an explicit **freshness-metadata field** is required by the approved DoD specifically of the **hosted lead read**. This Slice therefore asserts freshness metadata where its source requires it, and does not invent a per-fixture freshness field for all four capabilities.
- **Governing behavior / traceability:**
  - **TD-5** — Operational gateway & fresh-read capabilities (hybrid target): the capability surface `legacy_lead_get_context`, `legacy_lead_get_recent_messages`, `appointment_get`, `property_get_details`; direct adapters sanctioned **only as shadow/bootstrap**; collection allowlist in code; org external-binding check before every read; provenance on every result; contract-fixture tests + drift alarms; no generic CRUD tool, ever.
  - **TD-1** — `organization_tool_secrets` with providers `traditional_gu_firestore` / `traditional_gu_mongo`; CURRENT `account_tool_secrets` untouched.
  - **AC-1 — Operational Access & Eventing** (Architecture Analysis §6), accepted decision: *"R1 uses bounded fresh operational capabilities…; BigQuery remains analytical."* Specifically §6.2 Option C (bounded operational gateway / domain capabilities) and §6.5 (freshness and authoritative reread).
  - **ADR-106** — Organization-native multi-seat tenancy: the binding check is what makes a read Organization-scoped rather than user-scoped.
  - **Technical Plan §6** — gateway checks org external-binding before every legacy read; bootstrap-adapter credentials scoped per TD-5 with blast radius documented.
  - **Prerequisite capability provided to:** SL-2 (admission needs lead context and messages), and thereafter every shadow Slice that reads operational reality.
  - **Enabled but NOT proved by this Slice** — recorded so the traceability is not overstated: S2 **AC-20** ("BigQuery stale but fresh conversation changed → fresh operational source governs live decisions") describes supervisor behavior that consumes these reads. SL-1 supplies the capability; the scenario is proved where that decision behavior lands, not here. No S1/S2/S3/S4 acceptance scenario is claimed as proved by SL-1.
- **Dependencies:**
  - **SL-0** — satisfied. `organization_tool_secrets` landed in `00080_organizations_core`; `packages/db/src/queries/organizations.ts` and `authorizeOrgAction` exist; the external-binding resolution SL-1's per-read check depends on was evidenced in Gate A.
  - **Alebrixe legacy read credentials — dependency case B** (team-controlled, schedulable before dependent execution). Mongo keys collection-scoped; the Firestore credential documented as whole-database read, an explicitly accepted, time-boxed, shadow-only risk (TD-5). Classified first-hand in the 2026-09-03 readiness pass. **Evidence:** the credentials do **not** exist today — Gu OS declares no `LEGACY`/`GATEWAY`/`FIRESTORE`/`MONGO` environment variable, its single deployment environment (`staging`) holds a single secret (`GUOS_STAGING_SUPABASE_DATABASE_URL`), no provider registry exists in `packages/types`, and no runbook records an issuance path; `organization_tool_secrets` (migration `00080`) names the intended providers but is unpopulated plumbing. Issuance is nevertheless **administered by this team**: administrative access to the relevant Google Cloud project and MongoDB Atlas project is held directly, so the dedicated read identities can be created and scoped without a third party acting. Case B **permits READY and withholds EXECUTABLE**: SL-1 does not become Executable until the credentials are actually provisioned, which is deliberately deferred until this Slice confirms the exact required scopes and credential-handling path (SA-1.5).
  - **Staging environment with pilot credentials** — Technical Plan §8 requires "a staging pass with pilot credentials before each stage gate". The Gu OS hosted-verification harness exists but is **Supabase-only**: `scripts/lib/target-env.ts` resolves a `projectRef` / `databaseUrl` / publishable-key target and `scripts/verify-hosted.ts` offers the groups `smoke | schema | security`. There is no target slot, credential form or check group for a legacy source system. Extending it for a legacy read target is therefore **verification capability created inside this Slice**, the same way SL-0 built `npm run test:rls` within its own Slice; it is recorded in the Definition of Done below rather than assumed.
  - **Not** dependent on C6: TD-5 sanctions direct bootstrap adapters for shadow stages, and C6 is a hard gate before **SL-9**, not before SL-1.
- **Release Scope:** **RS-2 (hosted).** Grounded, not assumed: the approved DoD requires a "staging read of real Alebrixe lead with provenance + freshness metadata", which is environment evidence a disposable CI environment cannot establish (Methodology §11.5, §14.2). RS-1 would silently lower an existing evidence requirement. RS-3 is not implied — SL-1 is a shadow-stage Slice with no prospect-facing effect, and production rollout is the separate Gate B.
**First-hand legacy-source revalidation (2026-09-03).** Performed with the audit's own method ([`legacy-source-audit.md`](legacy-source-audit.md) §23.1): resolve current heads, confirm the audit pin is still an ancestor, diff pin→head, read every changed file relevant to the R1 question set, and classify files with no diff as STILL VALID without re-reading. Window: the audit's 2026-08-31 revalidation heads → `UnggaMX/ungga-full` `gcp/main` and `UnggaMX/ungga-landing` `main` as of 2026-09-03. Both pins remain ancestors — fast-forward history, no rewrites. Drift: **13 commits / 47 files** and **32 commits / 61 files** respectively.

| Capability | Source contract | Drift classification |
|---|---|---|
| Lead context | `lead_id = prospect_phone + bot_phone_number + owner_phone_number`, a composite operational-context key, **not** canonical Prospect or Gu OS identity (audit §5.1) | **No drift.** `ungga-full/src/guv3/gu/db/firebase/leads.py` untouched in the window → STILL VALID. |
| Thread-aware messages | `leads/{lead_id}/wsp_messeges` holds the Gu-number conversation document(s) plus one `asesor_<phone>` document per linked advisor, items carrying `source` and author; the platform flattens into typed `gu` / `advisor` threads under server-side visibility (audit §10.1) | **No drift.** `ungga-landing/src/lib/firebase/leads.ts` untouched in the window → STILL VALID. |
| Appointment | Partial persistence and Calendar-before-persistence orphan risk (audit §11) | **No drift.** No appointment source changed in the window → STILL VALID. |
| Property | Firestore is the authoritative property record; the Mongo `property_data` copy is incomplete (audit §14) | **Physical drift only.** `ungga-landing/src/lib/firebase/properties.ts` changed, but solely in the public SEO sitemap path (`listPublishedPropertiesShard`), which reaffirms Firestore as the source. `ungga-full` `MongoService.ts` now recalculates the search vector on every upsert and adds a `vector_model` field to the Mongo mirror — search infrastructure, not the property-details read contract. |

**No semantic contract change was found for any of the four capabilities.** The other material drift is the outbound WhatsApp template path (`notificator/whatsapp/whatsapp.ts`), which belongs to the send contract at **SL-9**, not to SL-1's read path, and a new public FAQ/support assistant unrelated to R1.

One shape finding worth carrying into fixtures: a property's `user_owner` has **two representations** — normally a `DocumentReference` to `users/{uid}`, but part of the imported inventory stores it as a text path — so owner resolution accepts both and returns null otherwise. This is the same normalized-versus-raw pattern SL-0 resolved for the Organization key, and it sits on the path from a property read to its Organization binding (SA-1.6).

- **Estimate:** **3–5 days** elapsed agent-assisted engineering time to evidence-ready. *(Revised from the pre-readiness initial estimate of 2–3 days; frozen at READY per Methodology §10.4 / §17.1.)*
- **Estimate confidence:** **Medium.** Estimated for the actual execution model — a coding agent working autonomously inside the approved Slice (repo inspection → JIT decomposition → implementation → fixtures/selftests → local verification → bounded repair → PR/CI iterations → evidence). Grounded in current repo state: the gateway module `apps/web/src/lib/legacy-gateway/` is net-new, but the adapter + capability pattern it extends is well precedented (52 `TOOL_CATALOG` entries; `packages/agent/src/tools/realestate-adapters.ts` with eight sibling selftests; `realestate-credentials.ts` as a credential-handling seam; `scripts/check-model-price-catalog-drift.mjs` as a drift-check precedent).

  **Why it moved from 2–3 to 3–5 days.** Two forces, and the second is larger. *Downward:* the readiness pass found **no semantic drift** in any of the four source contracts, and the lead and conversation sources are untouched since the audit — so fixture derivation, previously the dominant uncertainty, is better bounded than assumed. *Upward:* the hosted half needs verification capability that does not exist. The current harness targets Supabase only, so SL-1 must add a legacy read target, its credential handling and a check group before SA-1.2/SA-1.3 can produce evidence at all — work comparable to SL-0's in-slice `test:rls` build, against a different kind of system (Firestore/Mongo rather than Postgres) and with its own fail-closed target binding.

  **Confidence stays Medium** rather than rising: fixture risk fell, but new credential-handling and hosted-target risk replaced it, and the `user_owner` dual representation adds a normalization case. **Human/external wait remains excluded** — provisioning the case-B credentials is tracked as a dependency, not folded into this number.
- **Material risk:**
  - **Security / credential blast radius** — the Firestore bootstrap credential is whole-database read (GCP IAM has no per-collection read grant, and the Admin SDK bypasses security rules). TD-5 accepts this explicitly as time-boxed and shadow-only, compensated by a collection allowlist in code and the per-read org-binding check. This is the Slice's dominant risk and the reason its credential scopes must be documented as part of Done.
  - **Tenancy** — a read that skipped the external-binding check would be a cross-tenant read. Mitigated by the check being pre-read and by the shared-baseline cross-tenant suite.
  - **Drift** — coupling to messy physical shapes; mitigated by contract fixtures plus alarms that page an operator on mismatch.
  - **External effects:** none. Shadow stage, reads only.
  - **Flag / compatibility:** `LEGACY_GATEWAY_ENABLED` global kill-switch plus the `relationship_ops` master flag; flags off ⇒ inert per shared baseline.
  - **Rollback:** flag off; no schema change is owned by this Slice.

**Slice Acceptance Contract** — the approved SL-1 DoD from Technical Plan v1.4 §9, decomposed into assertions with evidence types. Nothing is added to or removed from the approved scope.

| ID | What must be demonstrably true | Governing source | Evidence type |
|---|---|---|---|
| SA-1.1 | Each of the four capabilities returns a normalized result against a recorded contract fixture, carrying provenance | TD-5 capability surface ("provenance on every result") | deterministic selftest |
| SA-1.2 | A **real Alebrixe lead** is read in staging, and the result carries provenance **and** freshness metadata | TD-5; Technical Plan §9 DoD; AC-1 §6.5 | hosted verification |
| SA-1.3 | Recent messages are **thread-aware** — Gu and `asesor_*` documents, with `source` and `delivery_status` per item | TD-5 (audit §10.1/§15.7) | deterministic selftest + hosted verification |
| SA-1.4 | A fixture shape mismatch **fires the drift alarm** rather than silently returning wrong data | TD-5 drift alarms | deterministic selftest (injected mismatch) |
| SA-1.5 | Credential scopes are documented, including the accepted whole-database Firestore read and its time-boxed shadow-only bound | TD-5 credentials; Technical Plan §6 | source / operational evidence |
| SA-1.6 | Every read is preceded by the Organization external-binding check; a request outside the bound Organization does not read | Technical Plan §6; ADR-106 | deterministic selftest (negative case) |
| SA-1.7 | No generic CRUD tool is introduced, and no prospect-facing effect is reachable from this Slice | TD-5; Technical Plan §5 shadow stage | deterministic assertion + review |

SA-1.6 and SA-1.7 are **slice-local assertions**: they restate invariants the governing sources already require of any gateway read, made checkable at this Slice's boundary. Coverage of unhappy paths is deliberately at contract level here (drift mismatch, out-of-binding read); scenario-level unhappy paths for admission behavior belong to SL-2.

**Definition of Done (delta over §2)**

- The four capabilities exist behind the bounded tool surface, with contract fixtures and passing selftests wired into `test:selftests`.
- **Hosted verification capability for a legacy read target is created within this Slice** — the current harness targets Supabase only — with fail-closed target binding in the spirit of `scripts/lib/target-env.ts`, and no secret value ever printed or committed.
- Hosted evidence recorded from staging for SA-1.2 and SA-1.3, naming the environment reached.
- Drift alarm demonstrated firing (SA-1.4).
- Credential scopes documented (SA-1.5), including the exact scopes the case-B provisioning must grant.
- Done record states environment reached, Release Scope achieved, and what was intentionally not exercised.

**Readiness**

- **READY** — determined by the dedicated readiness/elaboration pass of 2026-09-03.
- **Why every condition passes.** Governing behavior is approved (Technical Plan v1.5; TD-5 and AC-1 accepted) and no unresolved consequential product question sits inside this Slice's scope. The acceptance contract is stated and testable against **first-hand-revalidated** source contracts, each assertion naming a verifier type. Dependencies are classified: SL-0 satisfied, credentials **case B**, and the missing hosted-verification capability is explicitly built inside the Slice rather than assumed. Release Scope RS-2 is declared and its evidence path is now concrete. Security, tenancy, authority and external-effect impact are assessed, and this Slice has no external effects. The estimate is evidence-based and frozen.
- **READY is not authorization to execute.** It means the Slice is eligible for Cycle planning. **SL-1 is not yet EXECUTABLE:** its case-B credential prerequisite is not actually satisfied, and by deliberate decision the identities are provisioned only after this Slice confirms the exact required scopes and credential-handling path. No Accountable / DRI, Execution Cycle or planning status is assigned by this pass.
- **Residual uncertainty, judged compatible with execution:** legacy physical shapes remain volatile (both repositories moved again on 2026-09-03), which is precisely what the contract fixtures and the SA-1.4 drift alarm exist to absorb.

---

### SL-2 … SL-13 — rolling-wave stubs

Deliberately shallow. Each carries only what is needed to prioritize, sequence and reason about dependencies. Detailed acceptance scenarios, edge cases, evidence contracts, estimates and readiness are produced when the Slice is elaborated — inventing them now would manufacture false precision. Content is extracted from Technical Plan v1.4 §9; the "elaborate before READY" column states what is genuinely missing, not a generic placeholder.

| Slice | Governing TDs / contracts | Material risk category | To elaborate before READY |
|---|---|---|---|
| **SL-2 Admission (shadow)** | TD-2 (policy, seeded baseline), TD-8 (case type / definition / facts), admission pipeline, M-SOURCE-EVENTS (interim polling); AC-1, AC-5; ADR-108 | policy authority; duplicate-event idempotency | Fact-key vocabulary and `closure_reason` enums (Technical Plan §11 OPEN, product touchpoint per S1); which S1 acceptance scenarios admission actually proves; correlation-coverage check definition |
| **SL-3 Duplicate & supersession** | TD-7 flows on the SL-0 primitive; AC-6; ADR-109 | lineage correctness; no Case-row mutation | Exact S1 `EC-06` / `AC-15` scenario mapping; what "lineage queryable" must return |
| **SL-4 Supervisor loop (shadow)** | TD-8 root skill, postures, `agent_proposed` Work; **M-SUBJECTS lands here** (TD-14); AC-7, AC-8 | model-mediated behavior; kernel extension | S2 rubric and which S2 acceptance scenarios are in scope; replay reconstruction contract; no-op ratio target |
| **SL-5 Event wake-ups (prod)** `[L:C1]` | TD-13 auth, webhook ingestion, dedup/normalization; AC-1 §6.3/§6.6 | external contract dependency; signature/replay | **Release Scope** — whether "prod" here means production release or the production wake-up path (see §8, Q2); the agreed wake SLA; C1 availability |
| **SL-6 Bindings + authority (advisory)** | TD-4 bindings (`advisor_wa` evidence-only CHECK), TD-3 states + resolver, `/api/legacy/authority` log-only; AC-4; ADR-107 | authority semantics; fail-safe on conflict | What "resolver answers match observed reality" is measured against; C2 advisory availability |
| **SL-7 Work Portfolio v1** | TD-9 views, `/portfolio`, must-surface predicates, TD-15 typed contracts, M-PRESENTATION; AC-9 | first multi-seat user surface → cross-tenant suite gates it | Release Scope (deterministic views vs advisor-facing hosted evidence); `snooze_until` cap (TENTATIVE 14d) |
| **SL-8 Visit evidence v1 (shadow)** | TD-14 visit subjects + subject-scoped facts + external-ref attachment, S3 reconciliation patterns; AC-2, AC-7 | evidence semantics; preserving *unknown* | S3 acceptance mapping; `EvidenceRequest` emission contract |
| **SL-8b Transaction boundary seam** | TD-16 `transaction` shell case type, `recognize_transaction_boundary`, M-TXN-SHELL; AC-6 | boundary misclassification | Release Scope; the §15.18 rationale contract; negative test definition (Legacy-Deal-alone creates nothing) |
| **SL-9 Message effects (assisted)** `[L:C3; **C6 hard gate**]` | TD-6 ledger + `send_prospect_message` (approval-only) + delivery reconciliation, M-EFFECTS; AC-2 | **first prospect-facing external effect**; zero-unapproved-send invariant | **Release Scope** (see §8, Q3); C6 live — a hard gate with no production waiver; C3 availability; delivery-evidence choice (C4 vs §15.7 read, Technical Plan §11 OPEN) |
| **SL-10 Appointment effects (assisted)** `[L:C7]` | TD-6 appointment capabilities + partial-persistence / orphan-Calendar reconciliation → TD-14 visit facts | partial-failure reconciliation; external effect | Release Scope; C7 availability; bounds of the degraded human-as-executor mode |
| **SL-11 Authority transfer (selective live)** `[L:C2 enforcing]` | per-Opportunity `runtime_authority=gu_os`; legacy suppression; takeover suppress/resume; AC-4; ADR-107 | **runtime authority change**; collision risk | Release Scope; C2 enforcing availability; collision replay contract |
| **SL-12 Portfolio v2 (contextual ranking)** | TD-9 v2 model ranking + evidence-grounded explanations + conversational portfolio tools; AC-9 | model-mediated ranking; must-surface suppression | Exact ranking prompt/rubric (Technical Plan §11 OPEN, eval-gated); adversarial fixture set; fallback contract |
| **SL-13 Economics v1** | TD-10 resource events + valuations + WhatsApp metering + reconciliation selftest, M-ECON; AC-10; ADR-110 | cost attribution correctness | Release Scope; rollup identity contract; late-valuation semantics |

No estimates, acceptance scenarios, edge cases, Tasks, files or migration numbers are recorded for these Slices. That is the intended rolling-wave depth, not an omission.

#### Approved DoD evidence carried forward — the elaboration input

Verbatim from approved Technical Plan **v1.4 §9**, which owned this text before the migration. It is reproduced here so nothing approved was lost when the column moved, and so each elaboration starts from the approved evidence requirement rather than from a re-derivation. **This is source material, not an elaborated acceptance contract** — turning it into one is the elaboration work.

| Slice | Approved DoD evidence (Technical Plan v1.4 §9) |
|---|---|
| SL-2 | real inbound leads → dispositions + shadow Cases; duplicate-event idempotency test; policy-version attribution visible |
| SL-3 | S1 EC-06/AC-15 scenarios pass on shadow traffic; lineage queryable; no case-row mutation by relationship ops |
| SL-4 | multi-day shadow Opportunities with coherent posture history; commitment subjects tracked with due/status facts; no-op ratio observable; replay reconstruction test; existing unscoped-fact selftests stay green (compat) |
| SL-5 | signed forwarded event → case wake < agreed SLA; bad/expired signature rejected; duplicate delivery collapses; polling retired |
| SL-6 | binding rows for pilot conversations; resolver answers match observed reality in logs; conflict fail-safe + advisor_wa-ignored tests |
| SL-7 | advisor sees predicate-ranked attention list with WHY/WHAT/WHY-NOW; actions land in canonical mechanisms; snooze never alters business state nor hides must-surface; org-scope authz tests |
| SL-8 | real appointment lifecycle → visit facts with unknown preserved; reschedule does not inflate (1 visit, n schedule facts); property change ⇒ new visit subject; conflict retained |
| SL-8b | concrete-offer scenario → shell Case + association edge + evidence on both timelines with §15.18 rationale; Opportunity unaffected/open; **Legacy-Deal-alone creates nothing (negative test)** |
| SL-9 | approved send → wamid correlated → delivered/failed/unknown exercised; idempotent retry test; zero unapproved sends; zero direct-adapter reads on the effect path (asserted) |
| SL-10 | approved create/reschedule/cancel round-trip visible in legacy stores; injected partial-failure reconciled; visit facts updated with provenance; degraded mode (if invoked) is flag-off + time-bounded + recorded |
| SL-11 | pilot Opportunities answered by exactly one runtime; collision replay green; takeover suppresses Gu while Case continues; all freshness reads on C6 path |
| SL-12 | eval set passes S4-derived rubric; must-surface never suppressed (adversarial fixtures); model-failure fallback to deterministic order |
| SL-13 | send path emits keyed usage; late valuation lands without history rewrite; rollup identity (direct + shared_unallocated) proven |

SL-0's and SL-1's equivalents are not repeated here: both are already expressed as full acceptance contracts in §4 above.

## 5. Execution register (transitional)

Present only while no Development Control Plane exists, and deliberately minimal. It records the Cycle, the confirmed Accountable / DRI, the frozen estimate and the actual metrics **after** execution.

**This section is not authority for live state, and carries no execution stage.** The agent runtime owns just-in-time Tasks and pre-PR implementation and local verification; GitHub owns branch, commits, PR, CI results, merge state, Actions and environment approvals. Do not edit this document to move a Slice through `Proposed → Planned → Implementing → Local Verify → PR / CI`.

| Slice | Execution Cycle | Accountable / DRI | Estimate (frozen at Ready) | Actual to evidence-ready | Human/external wait | Calendar elapsed | Re-planning events | Reopened after Done | Declared → required Release Scope | New verification capability built? |
|---|---|---|---|---|---|---|---|---|---|---|
| SL-0 | not recorded | not recorded | not available — predates Slice calibration model | not recorded | not recorded | not recorded | not recorded | no | RS-2 → RS-2 | yes — DB-backed cross-tenant suite (`npm run test:rls`) and its CI job |

| SL-1 | — | — | 3–5 days / Medium *(frozen at READY, 2026-09-03)* | — | — | — | — | — | RS-2 → — | — |

A Slice enters this register when the planning facts it records actually exist, not before. SL-1 carries only its **frozen estimate**, recorded when the readiness pass moved it to READY. Its Execution Cycle and confirmed Accountable / DRI stay empty until it becomes `Planned`, and its actuals stay empty until it executes. Nothing else about SL-1 belongs here: the durable contract in §4 remains the single owner of its scope, acceptance and readiness. **SL-2…SL-13 have no register rows at all.**

Metrics are recorded for the first 3–5 real Slices to calibrate estimate bias and variance (Methodology §17.1); they do not establish a productivity multiplier. SL-0 predates the model, so R1's calibration series begins at SL-1.

## 6. Done records

### SL-0 — Done 2026-09-01 (recorded with Technical Plan v1.4)

- **Release Scope achieved:** RS-2 (hosted).
- **Environment reached:** deterministic local + CI, then the **`Gu-OS-Stage`** hosted environment. **Production was not reached.**
- **Evidence:** authoritative record in [`technical-plan.md`](technical-plan.md) §9, "Execution status — SL-0". In summary: the frozen 87-migration chain applies cleanly and the cross-tenant suite passes **36 checks** against a real PostgreSQL 16 (pgvector); a mutation check confirms the restrictive UPDATE guard is load-bearing; the same chain applied in full through `00084` in `Gu-OS-Stage`, where every hosted security invariant matched the deterministic assertions.
- **Verified:** Alebrixe Organization resolvable via the normalized bare owner UID, with the raw `users/<uid>` form retained as provenance only and not resolving as a routing key; exactly one Organization and one binding after apply *and* after an idempotent rerun; explicit seat mapping (Mariana `owner`, Alejandro `advisor`), neither mutated by the rerun; JSONB discovery source byte-identical before and after bootstrap; a falsifiable negative control proving that neither legacy discovery state nor `is_ungga_admin` confers membership; hosted cross-tenant read and write verified with real authenticated user JWTs rather than the privileged service credential.
- **Not exercised:** **production** — no migration applied, no data written, no connection made. Production rollout is the separate **Gate B**, and a read-only production schema-state preflight remains mandatory before `00080`–`00084` are applied there. Also not exercised: any gateway read of live legacy data (that is SL-1), and any prospect-facing effect (shadow stage, per Technical Plan §5).

No Done records exist for SL-1…SL-13.

## 7. Change log

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-09-03 | Initial Slice Plan. Slice contracts extracted from approved Technical Plan v1.4 §9 under Methodology v0.3.1: SL-0 as a completed historical Slice referencing its existing closure evidence, SL-1 as a full draft contract, SL-2…SL-13 as rolling-wave stubs. No R1 scope, behavior, acceptance meaning, architecture decision, cross-repo contract, rollout model or sequencing changed. Status: Draft, pending human review. |
| v1.0 | 2026-09-03 | **Approved as the governing R1 Slice Plan** after human review of the first initiative migrated to the Slice model. Four review corrections applied, all narrowing claims rather than changing scope: (1) the SL-1 credential dependency no longer asserts Definition-of-Ready **case C** — Technical Plan §11 says only "obtainable" and establishes no class, so classification is deferred to the dedicated SL-1 readiness pass, and SL-1 is NOT READY for the elaboration reason alone; (2) SL-1's inspectable outcome now separates the four fixture-verified capabilities from the hosted evidence the approved v1.4 DoD actually requires, and explicitly disclaims any real appointment or property read; (3) SL-0's readiness cell reads `N/A — historical Done` so that **Done** stays a completion concept and never becomes a third readiness value; (4) SL-1's pre-READY row was removed from the transitional execution register — its initial estimate stays in the durable contract and is frozen only at READY. **Approval means** the artifact structure is approved and the recorded contracts and stubs are the governing planning truth. **It does not mean** SL-1 is READY, PLANNED or EXECUTABLE, nor that implementation may begin. |
| v1.1 | 2026-09-03 | **SL-1 readiness/elaboration pass — SL-1 becomes READY.** First-hand legacy-source revalidation performed with the audit's own §23.1 method against both Traditional Gu repositories as of 2026-09-03 (13 commits / 47 files and 32 commits / 61 files of drift since the 2026-08-31 audit revalidation; both pins still ancestors). **No semantic contract change** was found for any of the four capabilities: the lead and conversation sources are untouched, appointments are untouched, and the property change is confined to the public SEO sitemap path while reaffirming Firestore as the authoritative record. Recorded one new fixture-relevant shape: a property's `user_owner` appears both as a `DocumentReference` and as a text path. Credential dependency **classified case B** with evidence — the credentials do not exist today, but issuance is administered by this team without a third party — resolving Q4. Definition of Done gains the hosted verification capability for a legacy read target, which does not exist in the Supabase-only harness and is therefore built inside the Slice, following the SL-0 `test:rls` precedent. Estimate revised **2–3 → 3–5 days**, confidence Medium, and **frozen at READY**: fixture risk fell because no semantic drift was found, while new hosted-target and credential-handling work replaced it. RS-2 reconfirmed. **READY means eligible for Cycle planning, not authorized to execute** — SL-1 is not EXECUTABLE until the case-B credentials are provisioned, which is deliberately deferred until the Slice confirms the exact required scopes. No DRI, Execution Cycle, planning status or JIT Task was created. |

## 8. Open questions surfaced by this migration

Recorded rather than silently resolved, per Methodology §15 and the migration instruction. **None of these is a change to approved R1 content** — each is an ambiguity the Slice format made visible.

| # | Question | Why it matters | Proposed disposition |
|---|---|---|---|
| Q1 | **Acceptance-identifier namespace collision.** `AC-1…AC-10` are *architecture contracts* (Architecture Analysis §6–§15), while S1 and S2 use zero-padded `AC-01…AC-nn` for *Spec acceptance scenarios*. So `AC-7` and `AC-07` are different things in different documents, and S3 references `AC-2 / AC-7 / AC-8` meaning the architecture contracts. | Slice traceability depends on identifiers being unambiguous. A future Slice contract citing "AC-7" is genuinely ambiguous. | Human decision. This plan disambiguates in prose everywhere (writing "architecture contract AC-1" or "S2 AC-20"). A durable fix would be a naming convention, which is a documentation-governance decision outside this migration. |
| Q2 | **SL-5's Release Scope is not derivable.** Its title says "(prod)" and its DoD retires polling, but Technical Plan §5 places SL-5 inside the **shadow** stage (SL-0…SL-8b, no prospect-facing effects). "Prod" appears to mean the production *wake-up path* rather than a production *release*. | RS-2 versus RS-3 changes the Done boundary and the authority required. | Left as `TBD at elaboration`. Needs confirmation from the Technical Plan owner; not resolvable without redesigning meaning. |
| Q3 | **Where the RS-3 boundary falls for the assisted stage.** SL-9 and SL-10 produce real external effects visible in legacy stores (a `wamid`-correlated prospect message; an appointment round-trip). Whether that constitutes RS-3 "production" under Methodology §14.2, or RS-2 hosted evidence in a pilot-scoped environment, is not stated by any current source. | This determines whether the playbook's production release path (§7 — explicit authorization, read-only preflight, canary, rollback) is engaged for those Slices. | Left as `TBD at elaboration`. This is a release-authority question for a human, and deliberately not decided here. |
| Q4 | ~~SL-1's read credentials are an unresolved readiness dependency of unknown class.~~ **RESOLVED 2026-09-03 — case B.** | — | The readiness pass established first-hand that the credentials do not exist today (no environment variable, no environment secret, no provider registry, no runbook) but that issuance is administered by this team, with direct administrative access to the relevant Google Cloud and MongoDB Atlas projects and no third party required. Recorded in SL-1's dependency list. Case B permits READY and withholds EXECUTABLE; provisioning is deliberately deferred until SL-1 confirms the exact scopes and credential-handling path. |

Nothing in this section blocks review of the structure itself; Q2 and Q3 block only the Release Scope fields they name.
