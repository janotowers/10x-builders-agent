# {{Slice Plan name}} — Slice Plan

> **Version:** v0.1  
> **Status:** Draft  
> **Owner:** {{engineering owner}}  
> **Roadmap Increment:** {{link, when this plan realizes one — and where its declared graduation evidence lives; otherwise omit this line}}  
> **Product Area / Responsibility:** {{link, where the product uses that concept; otherwise omit this line}}  
> **Initiative:** {{link only when a bounded Initiative is genuinely the coordinated delivery unit; otherwise omit this line}}  
> **Governing Specs:** {{links to the approved Feature / Business Specs}}  
> **Architecture / ADRs:** {{links}}  
> **Technical Plan:** {{link}}  
> **Development method:** {{Methodology link}}  
> **Intended repo path:** `{{directory}}/slice-plan.md`  
> **Artifact role:** Owns the durable Slice contracts this plan covers and their order. For roadmap-driven product work it normally realizes **one Roadmap Increment**; where a bounded Initiative is genuinely the coordinated delivery unit it may serve that Initiative instead. It does **not** own intended behavior (the Specs do), consequential structure (the Architecture Analysis / ADRs do), technical design (the Technical Plan does), strategic sequencing and graduation evidence (the Roadmap does), pre-PR execution state and implementation Tasks (the agent runtime does), or recorded execution state — branch, commits, PR, CI, merge, Actions, environment approvals (GitHub does).

Authoring guidance lives in [`README.md`](README.md); the governing rules are Methodology §4.1, §10–§10.5, §12.1–§12.4, §14.2, §18 and §19.1–§19.2. Remove sections — and header lines — that are genuinely irrelevant rather than filling them with boilerplate.

**Default: a Slice Plan integrates the Slices required to realize one Roadmap Increment.** A genuinely bounded Initiative used as the coordinated delivery unit may justify its own plan instead. Proportional non-roadmap work that nonetheless warrants Slice treatment under Methodology §18 — an architecture/platform change, a significant repair, operational infrastructure — **must not invent a Roadmap Increment or an Initiative merely to fill a header line here**; omit the line that does not apply and name the artifact that actually governs the work.

Do **not** create a separate Slice Plan per Spec, per ADR, per Architecture Analysis or per Technical Plan. Those artifacts govern individual Slices through traceability; dependencies, priority, the READY Horizon and Cycle planning all need one integrated view (Methodology §10.1). This template requires no particular filesystem hierarchy.

## 1. How to read this plan

- The **Spec** owns intended behavior. A Slice proves part of one or more governing Specs, **or** establishes a required enabling / operational contract governed by an ADR, architecture source, Technical Plan, invariant or prerequisite capability. Do not invent a Spec to give enabling work something to point at.
- Slice contracts are written **rolling wave**: near-term Slices in full, later Slices as stubs carrying enough to sequence, size and prioritize them.
- **Near-term work maintains the READY Horizon** (Methodology §10.5): enough elaborated READY work to avoid stalling between Slices or Cycles — roughly one to two Cycles of plausible capacity as an operating default. The horizon is **capacity-based, not a fixed Slice count**, and maintaining it is the development system's own proactive work, not something a human should have to request.
- **Readiness elaboration never invents unresolved product or architecture decisions**, and never lowers the Definition of Ready to widen the horizon. When a Slice cannot legitimately become READY, name the owning artifact and the smallest precise decision needed rather than leaving it a passive dead end.
- **Only READY Slices are eligible for Execution Cycle planning** (Methodology §10.2, §12.1). Readiness is an attribute of the Slice, not an approval and not a stage.
- **Tasks are not written here.** They are derived by the coding agent once a Slice is Ready, Planned and Executable, and they never become durable Markdown truth.
- **Readiness lives here; execution stage does not.** A Slice can be READY with nobody assigned; the Accountable / DRI is confirmed at planning time and recorded in §5.
- **Every Slice being Done is not the same claim as the Roadmap Increment graduating** (Methodology §17.2). This plan closes Slices; the Roadmap owns graduation evidence.
- Nothing in this document is a live status board. See §5.

## 2. Shared baseline

State once what every Slice in this plan inherits, so individual contracts record only their delta.

- **Baseline Definition of Done:** {{e.g. type-check / lint / validators green; module selftests wired and green; flags off ⇒ inert; documentation synchronization note}}
- **Baseline evidence commands:** {{the specific repo scripts}}
- **Baseline security/tenancy assertions:** {{what every Slice must not regress}}

## 3. Slice index

Order and dependencies at a glance. Detail lives in §4.

| Slice | Title | Type | Depends on | Inspectable outcome (one line) | Release Scope | Readiness |
|---|---|---|---|---|---|---|
| {{SL-n}} | {{title}} | {{behavior / enabling capability / operational infrastructure / repair}} | {{—}} | {{what becomes observably true}} | {{RS-1 / RS-2 / RS-3}} | {{READY / NOT READY}} |

Readiness belongs here because it is part of the durable Slice contract. **Execution stage does not.** There is deliberately no `Status` column carrying `Proposed` / `Planned` / `Agent Planning` / `Implementing` / `Local Verify` / `PR / CI / Merge` / `Hosted Verify` / `Release` / `Done` — those are projected from the agent runtime and GitHub, never transcribed here (Methodology §19.1–§19.2).

## 4. Slice contracts

Repeat the block below per non-trivial Slice. Keep each close to one screen in spirit; unusual length is a granularity signal, not a formatting violation. High-risk security, tenancy, authority or migration evidence may legitimately need more.

---

### {{SL-n}} — {{title}}

- **Type:** {{behavior / enabling capability / operational infrastructure / repair}}
- **Inspectable outcome / value:** {{what observable business, user, system or enabling capability is true when this Slice is complete. Avoid "create tables" / "implement service layer" unless that capability is itself the independently verifiable enabling contract — then say what it guarantees, not what it builds.}}
- **Governing behavior / traceability:** {{Spec + the `AC-*` / `EC-*` / `HP-*` identifiers this Slice proves; or, for an enabling Slice, the governing ADR / technical decision / invariant / prerequisite capability}}
- **Dependencies:** {{Slice IDs, cross-repo contracts, external prerequisites — and which are still outstanding}}
- **Release Scope:** {{RS-1 deterministic / RS-2 hosted / RS-3 production}} — declared at readiness, never lowered at completion.
- **Estimate:** {{≤ 0.5 day / ~1 day / 1–2 days / 2–3 days / 3–5 days}} elapsed agent-assisted engineering time to evidence-ready
- **Estimate confidence:** {{High / Medium / Low}} — {{uncertainty driver}}
- **Material risk:** {{security / tenancy / authority / data / external effects / flag-compatibility / rollback. "None" is a valid answer; silence is not.}}

**Slice Acceptance Contract**

| ID | What must be demonstrably true | Governing scenario | Evidence type |
|---|---|---|---|
| {{SA-1}} | {{assertion}} | {{AC-nn / EC-nn / ADR §n / slice-local}} | {{deterministic test / contract test / integration test / eval / replay / hosted verification / source evidence}} |

Cover proportionally: the happy path, the material unhappy paths, the relevant edge cases, and any slice-local assertions needed to prove the increment. Do not restate the Spec.

**Definition of Done (delta over §2)**

- {{what closes this Slice beyond the shared baseline}}

**Readiness**

- {{READY / NOT READY}} — {{blocking gap, if any}}
- Dependency case: {{A satisfied / B ours with a concrete prerequisite contract — may be Ready, Cycle planning sequences the prerequisite first, not Executable until satisfied / C outside our control — not Ready}}

Readiness describes the Slice, not the team: a Slice can be READY with nobody assigned. The Accountable / DRI is confirmed when the Slice is planned into a Cycle and is recorded in §5, not here.

---

## 5. Execution register (transitional)

Present only while no Development Control Plane exists, and deliberately minimal. It records four things: the Cycle, the **confirmed Accountable / DRI** (a planning fact, which is why it is not in the durable contract above), the frozen estimate, and the actual metrics **after** execution.

**This section is not authority for live state, and carries no execution stage.** The agent runtime owns just-in-time Tasks and pre-PR implementation and local verification; GitHub owns branch, commits, PR, CI results, merge state, Actions and environment approvals. Do not edit this document to move a Slice through `Proposed → Planned → Implementing → Local Verify → PR / CI`; that manufactures a stale second copy of state. This section should shrink or disappear once a proper control plane exists.

| Slice | Execution Cycle | Accountable / DRI (confirmed at Planned) | Estimate (frozen at Ready) | Actual to evidence-ready | Human/external wait | Calendar elapsed | Re-planning events | Reopened after Done | Declared → required Release Scope | New verification capability built? |
|---|---|---|---|---|---|---|---|---|---|---|
| {{SL-n}} | {{cycle}} | {{name}} | {{range + confidence}} | {{ }} | {{ }} | {{ }} | {{count + cause}} | {{no / artifact that owned the defect}} | {{RS-n → RS-n}} | {{no / what}} |

Metrics are recorded for the first 3–5 real Slices to calibrate estimate bias and variance (Methodology §17.1). They do not establish a productivity multiplier and must not be reported as one.

## 6. Done records

One short entry per completed Slice. State the environment reached, the Release Scope achieved, the material assertions verified, and the material things intentionally **not** exercised.

### {{SL-n}} — Done {{date}}

- **Release Scope achieved:** {{RS-n}}
- **Environment reached:** {{local / CI / staging project / production}}
- **Evidence:** {{suites, counts, run links}}
- **Verified:** {{material assertions}}
- **Not exercised:** {{what this Slice deliberately did not prove, and why}}

## 7. Change log

| Version | Date | Change |
|---|---|---|
| v0.1 | {{date}} | Initial Slice Plan. |

---

*Template aligned to Methodology v0.4.0.*
