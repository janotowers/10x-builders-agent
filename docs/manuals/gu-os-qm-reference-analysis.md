# Gu OS × QM (yc-software/qm) — Reference Analysis

**Status:** External-system reference analysis. Informative for prior art; selected positions have been folded into the Technical Plan / detailed plan (see §8). Still subordinate to `gu-os-flexible-workflows-architecture-analysis.md` (architectural source of truth) and to `gu-os-flexible-workflows-technical-plan.md`. It does not invent architecture outside those fold-ins; remaining [P]/[H] items stay non-binding until activated.

**QM snapshot analyzed:** `yc-software/qm` @ `7f2c916360f1797a8ff2a77ce2ce40c5fabab087` (main, 2026-07-31). QM self-describes as early, experimental software; every claim below is pinned to this snapshot and may not hold for later revisions.

**Analysis provenance:** direct source review of a local clone (contracts cited by file path below), cross-checked against a prior GPT 5.6 comparative analysis (2026-07-31). The GPT analysis was found substantially accurate; divergences are noted in §4.7.

## Evidence legend

| Tag | Meaning |
|---|---|
| **[V-QM]** | Verified in QM source at the pinned snapshot (file cited) |
| **[V]** | Verified Gu OS repository/plan state (see the technical plan's own [V] items) |
| **[P]** | Possibility / proposal — not planned work, no phase commitment |
| **[H]** | Requires a product/human decision before any adoption |

---

## 1. Executive verdict

QM is a **multiplayer agent harness for a single company**: shared scopes, durable per-scope sandboxes, interchangeable agent harnesses (Pi, OpenCode, Codex, Claude Code), governed Skills, triggers, and shareable web-app artifacts, over Slack and web.

It is **not** a multi-agent workflow engine. At the pinned snapshot there is no workflow definition, no work-item dependency graph, no capability-based executor assignment, no verification/evidence contract, and no business-state authority anywhere in `src/` (verified by exhaustive search — §4.3).

For Gu OS:

- **Not a market competitor today.** QM requires self-hosting in the customer's own cloud account with a technical deployment operator, and assumes one organization of trusted internal users. That buyer profile has near-zero overlap with a MX/Latam brokerage buying governed real-estate processes as SaaS.
- **Not an architecture substitute.** Its durable unit is the agentic session/turn inside a workspace; Gu OS's durable unit is the business case and (per the plan) the work item.
- **Primarily a design reference** for concrete mechanisms Gu OS has already decided to build or has now folded in: claim/lease/liveness workers (plan §10), Skill governance lifecycle (plan §9.2 / §28.10 / ADR-011), provenance-based screening (plan §21), Studio shell + tenant assets (plan §16 / detailed Slice 2.7), and — still future — multi-seat collaboration (§6) and channel-linked views (§7 / plan §16.1).
- **Potentially a specialized external executor later** (e.g. `required_capability: software_engineering`), but only if the project demonstrates continuity (§4.6 governance risk).

**Phase order and architecture stay intact.** Fold-ins localize contracts and slices; they do not reorder Phases 0–4 or replace the case/work/impact core.

---

## 2. What QM is (verified summary)

Every turn flows through a headless core (identity, policy, scheduler, HTTP API) that routes to a selected harness+model; state persists in Postgres; each person and each shared room gets a durable, isolated sandbox whose primary tool surface is small and general (`execute`, `read`, `write`, `publish`, `memory` — `src/harness/pi-tools.ts` [V-QM]). Web UI, admin panel, portal, and Slack are plugins over the core API. Deployment-specific customization lives in a separate deployment repository; the core is generic.

Center of gravity: **give every person and room in one company a governed computer with a general agent on it.** Not: model the company's business processes.

---

## 3. QM's core contracts, verified

### 3.1 Scopes and projects [V-QM]

- Scope kinds: `personal`, `channel`, `team`, `org`, `group` (`src/types.ts`). Sessions, memory, files, credentials, crons, apps, and sandboxes resolve against scopes; read-only/read-write workspace layers plus `Grant` records share resources across scopes.
- A project is `{ id, orgId, name, ownerId, memberIds }` materialized as a `group` scope (`web-project-<id>`) — `src/projects/project-store.ts`. It is a shared workspace, **not** a workflow entity.

### 3.2 Tasks [V-QM]

`src/tasks/task-store.ts`: `Task { id, sessionId, originRunId, title, status }` with statuses `pending | in_progress | completed | skipped | failed`. No dependencies, no `blocked_by`, no required capability, no assigned executor, no I/O contract, no verification, no business-entity link. It is a durable checklist attached to a session/run — categorically different from the plan's `work_items` (§7 of the plan).

### 3.3 Runs, leases, worker [V-QM]

`src/runs/run-store.ts` + `src/runs/worker.ts`:

- The queued unit is a **conversation turn** (`Run` wraps an `OrchestratorInput`), with per-session dedup and idempotency. Even QM's durable background queue models agent turns, not business work.
- Claim/lease mechanics: `claim(workerId, ttlMs)` → `leaseToken` + `leaseExpiresAt`; `heartbeat(runId, leaseToken, ttlMs)` renews; the worker beats every `leaseTtl/3` and aborts the in-process turn after **3 consecutive lost beats** (`LEASE_LOST_CONSECUTIVE = 3`); a reaper either requeues or **parks** expired runs (`errorParks` at `maxAttempts`).
- Two deliberate schema differences from the Gu OS plan: QM stores the lease **on the run itself** and **collapses liveness and renewal into one `heartbeat` call**. The plan does the opposite (claim fields on `work_item_attempts`; liveness and lease renewal recorded separately — plan §10) and should keep doing so. QM is a reference for the **mechanism**, not the **schema**.

### 3.4 Skill governance [V-QM]

`src/skills/skill-store.ts`:

- Lifecycle `draft → reviewed → published → archived`; HMAC-SHA256 signature over the canonical manifest; `requiredCapabilities` vs `grantedCapabilities`.
- `publish()` fails unless the skill was reviewed **and** every required capability has been granted.
- `update()` outside the personal scope resets status to `draft`; renames are forbidden (create a new skill).
- Promotion to the org scope is admin-gated; `move()` to org throws (*"ceding a skill to the org goes through promote (admin-gated), not move"*). Resolution follows scope precedence with shadowing reported.

This is a **control plane around standard Agent Skills packages**, not a new SKILL.md format — directly relevant to plan §9.2 / ADR-011 / open decision §28.10.

### 3.5 Harness router [V-QM]

`src/harness/harness-router.ts`: resolves `{ harnessId, modelId }` with precedence org → scope → explicit request, validated against org-approved harnesses and model support. Switching harness mid-session **resets the session in both harnesses** — the visible cost of the lowest-common-denominator problem, and a concrete reason Gu OS should not make its main runtime harness-swappable (plan already rejects this).

### 3.6 Security model [V-QM]

`SECURITY.md` states verbatim that QM *"assume[s] one organization of authenticated internal users"* and *"is not a hardened public or multi-tenant service boundary"*. Known limitations admitted in the same file: command policy is bypassable ("a speed bump… not a sandbox boundary"), sandbox credentials are plaintext while in use, credential *purpose* is not enforced authorization, admins can read transcripts/memory/keychain metadata (audited, not consent-gated).

**Consequence:** QM `scope` ≈ compartmentalization inside one trusting company. Gu OS `tenant` = boundary between independent client businesses. These are different objects; nothing in QM's scope model weakens the plan's tenancy obligations (§21, principle 7).

### 3.7 Project governance signals [V-QM]

~40 commits at snapshot; `CONTRIBUTING.md` accepts proposals only as human-written text in `adrs/` (YC implements internally); README labels it an experiment with bugs. **Dependency risk: high.** This lowers near-term attractiveness of QM-as-component and raises the relative value of QM-as-design-reference.

---

## 4. Positioning and assessment

### 4.1 Competitor, complement, or reference?

Three levels (ordered by current relevance):

1. **Design reference (now).** The concrete mechanisms in §3 de-risk work the plan already schedules. This is where ~all present value is.
2. **External specialized executor (conditional, later) [P][H].** A QM-like sandboxed harness could serve narrow work items (`software_engineering`, heavy file analysis, long-running artifact builds) under a worker profile with strict tool/data scopes — Gu OS keeps case truth and verification; the sandbox returns artifacts + evidence. Blocked on §3.7 continuity risk and on a real work item that needs it.
3. **Horizontal competitor (only if theses change).** QM competes with Gu OS only in a world where Gu OS abandons verticality, or where MX/Latam brokerages self-host horizontal agent infrastructure with in-house operators. Neither is plausible near-term.

### 4.2 What QM validates about the Gu OS plan

- Postgres-backed durable queue with claim/lease/liveness and bounded retries is buildable and sufficient at startup scale — no Temporal-class engine needed (plan Decision 4 / §6.9 thresholds).
- Governed Skill publication with capability gating is practical and shippable (plan §9.2).
- Narrow, typed tool surfaces vs. general `execute`: QM's own SECURITY.md documents the blast-radius cost of the general approach, validating the plan's typed-tool philosophy.

### 4.3 Verified absences (why QM is not a workflow engine)

Exhaustive search of `src/` at the snapshot for `workflow`, `depends_on`, `dependsOn`, `blocked_by`, `dag`: **zero matches**. No supervisor/subagent trees (the only "spawn" references are trigger-originated turn flags). No business-state machine, no transition authority, no evidence records.

### 4.4 What Gu OS must not copy

1. `execute`/shell as the primary operational primitive (regression vs. typed tools with risk contracts).
2. "Agent acts as the person with their full credentials" as the standard execution model (Gu OS needs least-privilege per executor per work item).
3. Shared scopes as a substitute for tenant isolation (§3.6).
4. QM's task model as a work plane (§3.2 — missing everything that makes work governable).
5. Projects/chats as a substitute for cases (a QM project groups people and files; a case carries durable commercial truth).
6. Fully swappable agent harnesses for the main runtime (§3.5).
7. Lease-on-item + collapsed heartbeat schema (§3.3 — keep attempts-scoped claims and separated liveness/renewal).

### 4.5 Adoption map (anchored to the plan's phases)

| Horizon | Item | Anchor | What QM contributes |
|---|---|---|---|
| Phase 0–1 | — nothing — | | QM touches none of transition authority, pinning, instrumentation |
| Phase 2 (parallel) | Studio shell + tenant assets panel | plan §16 / detailed Slice 2.7 | UX inspiration: resources (Files/Skills/Deploys) as first-class nav; **not** QM's workspace-as-truth model. Gu's shell is read-only catalog + assets upload over existing `account_assets` |
| Phase 2 | Work dispatcher/worker implementation | plan §10 | Read (not copy) `run-store` + `worker`: claim→renew→detect-loss→abort loop; lost-beat threshold; reaper with requeue/park (park ≈ `blocked` at `max_attempts`, plan §8.5) |
| Phase 3 | Provenance-based screening of external content | plan §21 | Pattern: classifier over provenance-labelled external data before it reaches the model, pluggable screening proxy ("Auto" posture) |
| Phase 3 | Account-asset edges in impact model | plan §11 C3 | Contrast only: QM shares files in scopes; Gu versions templates and selectively stales generated artifacts |
| Phase 4+ / §28.10 | Skill import + governance lifecycle | plan §9.2, ADR-011 | Concrete lifecycle: review-before-publish, publish blocked until required capabilities granted, re-draft on edit, admin-gated scope promotion, content signature. Adopt the capability-gated publish rule verbatim for the import pipeline |
| Medium [P][H] | Channel-linked views (dynamic interfaces) | plan §16.1 / §28.12 | QM `publish` (durable internal web apps + share grants) and Claude Cowork/Code live artifacts are prior art — adopt the *product shape*, not QM's bearer-link/container default (§7) |
| Medium [P][H] | Org/team scope resolution | plan §28.9 (`owner_scope = organization`) | Precedence-based resolution + grants as reference; must be re-derived inside Gu's tenant model, never copied |
| Long [P][H] | Sandbox as executor profile | plan §9 `worker_profiles` | `sandboxMode: none / ephemeral / durable` as a profile extension; enables specialized workers without making Gu a shell agent |
| Long [P][H] | QM (or similar) as external executor | plan §9 executor kinds | Only after continuity is demonstrated and a real work item requires it |

### 4.6 Dependency-risk stance

Treat QM as **read-only prior art** until further notice. Do not schedule integration work against it. Re-evaluate on: a tagged release cadence, external contribution acceptance, or a security-posture hardening announcement.

### 4.7 Note on the GPT 5.6 analysis

The GPT 5.6 comparative analysis (2026-07-31, no repo access) was verified contract-by-contract against source and found substantially accurate. Additions made here beyond it: the queued run is a conversation *turn*, not a work unit (§3.3); QM's lease schema diverges from the plan's deliberate attempts-scoped design (§3.3); the contribution model and commit volume imply high dependency risk (§3.7); provenance screening called out as a Phase 3-adjacent adoption (§4.5). Its suggested weekly repo watch was assessed as marginal value at current commit volume; manual review on relevant announcements suffices.

---

## 5. Asset classes and the Studio shell (fold-in complete; product position)

Gu OS already distinguishes more asset classes than QM's "files in a scope" model. Collapsing them would break the case/work/impact separation.

| Class | Gu unit today / planned | QM analogue | Notes |
|---|---|---|---|
| Tenant prerequisite | `account_assets` + flow/`graph` `required_assets` | Skills/files shared by grant | Must exist *before* some steps can run (templates, watermarks). Studio assets panel (detailed Slice 2.7) is the upload home before lab retirement |
| Case document | `operational_case_documents` (supersession) | Workspace files in a session | Temporary (intake photos) or durable replacements (user-uploaded contract over generated draft) |
| Case-generated artifact | `case_artifacts` + `artifact_inputs` (Phase 3) | Published app output / files | Impact model; `input_kind` includes `account_asset` so template changes selectively stale dependents (C3) |
| Channel-linked view | Future (§16.1 / §7 below) | QM `publish`; Claude live artifacts | Views over truth, not truth; two link classes |

**Studio shell stance (now planned, not speculative):** ship early as read-only definitions catalog + assets/readiness panel; Phase 4 absorbs it. Explicitly **no authoring** until the compiler Studio. This is Gu's disciplined answer to QM's resource-centric sidebar without importing workspace-as-OS.

**Knowledge relation (Brain Layer boundary):** not every asset class is knowledge. Tenant prerequisites (templates) are capability-plane inputs and never feed the Brain; case documents are raw evidence whose durable business facts reach knowledge only via extraction → `case_facts` → selective HITL promotion; case-generated artifacts (comparables, valuations) are the genuinely knowledge-bearing class (zone/price cognition reusable across cases); channel-linked views carry none. The normative boundary — including the anti-pattern of uploading agent-informing content (zone dossiers, brokerage guides) into the Studio assets panel because it has an upload UI — lives in the Brain plan, [`gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) §1.4.8 (v1.5.2). The Brain program is explicitly sequenced **after** the workflows phases.

---

## 6. Collaboration layer as a future Gu OS product capability [P][H]

This section records the multi-seat product possibility QM illustrates. **Nothing here is scheduled work** beyond the Studio shell/assets fold-in in §5. It exists so the eventual §28.9-adjacent decision starts from a written position.

### 6.1 Why it plausibly matters for MX/Latam brokerages

Mid-size and large brokerages in Mexico/Latam are structurally multi-seat: a director, office managers, teams of asesores, and *desarrollos*/projects with several asesores assigned. That maps almost one-to-one to QM's scope kinds (`org`, `team`, `group`/project, `personal`). Concrete collaborative moments in the vertical:

- a desarrollo with 30 units worked by 5 asesores sharing comparables, price tables, and marketing artifacts;
- an office manager supervising cases across a team (visibility without ownership transfer);
- shared reusable artifacts: valuation templates, zone dossiers, owner-report formats;
- handoff of a case between asesores (vacation, exit, specialization) with full provenance.

### 6.2 Architectural principles if/when this is built

1. **Collaboration is an access-and-visibility layer over cases and work — never a second source of truth.** The case plane remains the only commercial truth; sharing a case must not mean sharing a workspace/filesystem with live credentials in it (QM's model, and its weakest security property — §3.6).
2. **Tenant first, scope second.** Any team/project scoping nests strictly inside the tenant boundary; grants never cross tenants. QM's resolution/precedence logic is a reference for *within-tenant* sharing only.
3. **Roles precede collaboration.** The plan already flags that no role model exists beyond `profiles.is_ungga_admin` [V]. A collaboration layer without roles is unbuildable; role modeling (Phase 2's work-view gating) is the true prerequisite.
4. **Artifacts shared by reference with provenance**, not by copying files into shared folders; staleness/impact semantics (plan §11) must survive sharing.
5. **Knowledge scoping follows the same tenant-first rule.** If multi-seat activates, the future Brain Layer's knowledge needs the scope dimension `workflow_definitions` already reserved (personal — an asesor's leads; team; org — zone dossiers, brokerage playbooks), nested strictly inside the tenant. Prior art: QM's scope-owned `memory` primitive and its "company brain" connectors, and G Brain v0.40+ company brain (federated sources + per-person OAuth). Recorded as a forward-looking note in [`gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) §1.4.8 — no brain schema exists yet, and none should be added for this before activation.

### 6.3 Tentative shape (illustrative only)

```text
Tenant (inmobiliaria)
├── users (roles: director / office manager / asesor / operator)
├── teams (office, specialization)
├── projects (desarrollo, campaign)
├── cases (owner + participants with per-role visibility)
├── shared artifacts (by grant, with provenance + staleness)
└── permissions (tenant-scoped grants; no cross-tenant edges)
```

UI/UX implications worth prototyping when the time comes: an **operator/manager workbench** (multiple cases/sessions observable side-by-side, artifacts opening next to conversation — QM's strongest UX idea) as a *role-gated additional surface*; the asesor's primary UI remains case/next-action-centric, not a session desktop.

### 6.4 Activation triggers (do not build before)

- Real multi-seat tenants asking for shared visibility/handoff (not hypothetical);
- role model shipped (Phase 2 exit);
- case plane + work plane stable (Phases 1–3 done);
- an explicit product decision on §28.9 (`owner_scope = organization`) that this layer would extend.

---

## 7. Channel-linked views (dynamic interfaces) [P][H]

Same product family as QM's `publish` tool and Claude Cowork/Code **live artifacts**: agent-produced interactive UI reachable beside (or instead of) chat, often via a link. Gu OS does **not** schedule this until Technical Plan §28.12 activates it. The design position below is normative *when* activated.

### 7.1 Prior art (verified)

- **QM** (`src/harness/pi-tools.ts` `publish`): durable scope-bound internal web app from a workspace directory; stable `/d/<name>/` link; versions + rollback; share via grants. Apps run as containers; `SECURITY.md` admits published-app links are **bearer authorization** (anyone with the link reaches that app; no QM principal).
- **Claude Cowork / Claude Code live artifacts** (public docs, 2026): persistent interactive HTML pages; connector-backed views refresh with data; sharing uses the **viewer's** permissions; connector-backed artifacts are deliberately **not** public-linkable.

### 7.2 Gu OS position — two link classes, never one

| Audience | Mechanism | AuthZ | Mutability | Examples |
|---|---|---|---|---|
| External participant (owner, buyer, …) | Signed, expiring, revocable URL scoped to tenant+case (+ artifact) | Bearer of the signed token only; not a Gu principal | **Read-only.** Actions return via existing external-response / channel association | Owner report, price simulation snapshot, document package view |
| Internal user (asesor, manager, …) | Authenticated **deep link** into the web app | Viewer's session + RBAC | Interactive under role (filter, navigate). **HITL decisions stay on notifications/inbox** — the view complements Telegram/WhatsApp chat; it is not a second approval surface | Case dashboard, comparables map, work summary |

Links are channel-agnostic: the same URL works when delivered over Telegram, WhatsApp, or email whether or not those channels are fully integrated as Gu surfaces.

### 7.3 What Gu must not copy from QM here

1. Arbitrary containerized app code as the default "artifact" path (violates "generated code never executes from a runtime path").
2. Bearer links for anything that can mutate commercial state.
3. Treating a published app / shared folder as commercial truth — case plane + `case_artifacts` remain authoritative; the view reads them.

Preferred v1 shape when §28.12 activates: **server-rendered or tightly allowlisted interactive views** over case/artifact data, not a general `publish` substrate. Reusable calculators that outgrow a view graduate to registered tools / deterministic services — not to ad-hoc sandboxed apps.

---

## 8. Relationship to existing documents

- **`gu-os-flexible-workflows-architecture-analysis.md`:** no edit required for this fold-in; accepted decisions remain intact. Material product positions that later need architecture-level promotion should go through the normal analysis → technical plan path.
- **`gu-os-flexible-workflows-technical-plan.md` (2026-08-01):** §5.2 `required_assets`; §11 `input_kind=account_asset`, asset-class table, C3; §15 capability map includes assets; §16 Studio shell early/read-only; §16.1 channel-linked views; §17 lab-retirement constraint; §26/§28.12/§30/Annex A.17–19 updated accordingly.
- **`gu-os-flexible-workflows-detailed-implementation-plan.md`:** Slice 2.7 (Studio shell + assets panel + resolver fallback + transformer port); 3.1/3.2 C3 and account-asset versioning; 4.2 absorbs shell / blocks lab retirement on 2.7; finding 16; prior QM fold-ins (lease/liveness, provenance screening, Skill governance) unchanged in intent.
- **`docs/brain/gbrain-evaluation-and-plan.md` (v1.5.2):** owns the knowledge/Brain boundary this document touches — `case_facts` as the preferred selective-promotion source into `brain_pages` (§1.4.8), the asset-classes × knowledge table, and the multi-seat knowledge-scoping note that pairs with §6 here. The Brain program is sequenced after the workflows phases; nothing in this analysis accelerates it.
- Remaining future fold-ins only when product decisions activate: §28.9 + §6 (multi-seat collaboration / operator workbench), §28.12 + §7 (channel-linked views implementation), sandbox/external-executor profiles (§4.5).
- This document should be **re-verified against QM's `main`** before being cited in any ADR, given QM's velocity and experimental status.
