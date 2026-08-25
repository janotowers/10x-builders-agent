# Gu OS Agentic Product & Software Development Methodology

> **Version:** v0.2.1  
> **Status:** Canonical development methodology  
> **Scope:** Tool-agnostic operating method for humans + coding agents  
> **Intended repo path:** `docs/development/agentic-product-software-development-methodology.md`

*Repository grounding: janotowers/10x-builders-agent, GitHub main snapshot 49d5f176f744fa67021b5874e2c4d0c43a5cbc96, including the tracked app-scoped agent instruction files apps/web/AGENTS.md and apps/web/CLAUDE.md. External methodological references: Lab10 structured vibecoding guide, Lab10 Spec-Driven Development guide, and current Cursor / Claude Code instruction-system documentation. This document adapts external practices only where they align with Gu OS repo-native architecture, governance and verification.*

| **Core idea.** Humans own intent, consequential decisions and acceptable risk. Coding agents may execute broadly inside an approved scope, but product intent, specifications, architecture decisions, verification evidence and release authority remain explicit, versioned and reviewable. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Purpose, scope and non-goals

This document defines how Ungga should design and build Gu OS with AI coding agents. It is not a product PRD, not the Principles & Design Doctrine, not a collection of templates, and not a Claude Code manual. Its job is to define the development lifecycle, the artifact architecture, the ownership of each kind of truth, the human-agent collaboration model and the evidence required to move from idea to production.

It deliberately separates three concerns that are easy to blur: product intent, intended behavior, and implementation. A PRD can be excellent while a feature Spec is incomplete; a Spec can be correct while an implementation plan is wrong; code can pass unit tests while failing the business contract. The methodology exists to keep those layers connected without collapsing them.

| **Three-document model.** This Methodology explains HOW we work. The future Principles & Design Doctrine explains WHAT rules guide decisions. The future Templates / Playbooks package explains HOW to create each artifact in practice. The actual Gu / Gu OS PRD is a product artifact created under this methodology, not part of the methodology itself. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 2. Source hierarchy used to build this methodology

The methodology is grounded first in Gu OS repo-native practice, then enriched by external guides. External sources are pedagogical/reference inputs, not architecture authorities.

| **Source**                                                   | **Contribution**                                                                                                                                                                                                                                                                        | **Authority in this methodology**                                                           |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Repo-native: docs/README.md                                  | Defines documentation authority: current code/migrations + architecture.md for implemented behavior; integrated architecture manual; topic-specific canonical plans; roadmaps; reference/historical material. It explicitly keeps brief.md and plan.md as historical/reference context. | Governing context                                                                           |
| Repo-native: Flexible Workflows Technical Plan               | Explicitly targets a spec-driven workflow lifecycle, failure classification, evidence-gated verification, versioned definitions, governed publication and shared runtime primitives.                                                                                                    | Governing target design                                                                     |
| Repo-native: Flexible Workflows Detailed Implementation Plan | Translates governing design into phases/slices/tasks and states that implementation must not silently redesign when contradictions appear.                                                                                                                                              | Execution discipline                                                                        |
| Repo-native: ai-native-loops.md                              | Defines Observe -\> Decide -\> Act -\> Evaluate -\> Learn -\> Repeat; safe change path; DRI; evidence, canary and rollback; workflow lifecycle from specs/definitions/scenarios to fork/new version.                                                                                    | Governed improvement model                                                                  |
| Repo-native: Operational readiness/testing framework         | Readiness validates reproducible business contracts, not merely absence of exceptions; N0-N5 gives progressive evidence.                                                                                                                                                                | Verification model                                                                          |
| Repo-native: ADR system                                      | ADRs hold cross-cutting decisions that should not remain buried in long plans; plans keep implementation detail.                                                                                                                                                                        | Decision governance                                                                         |
| External: Lab10 structured vibecoding guide                  | PRD as persistent product context; DESIGN.md; concise repo operating instructions; inspect before inventing; vertical slices; build/verify/checkpoint.                                                                                                                                  | Adopt/adapt                                                                                 |
| External: Lab10 Spec-Driven Development                      | Clarify -\> Spec -\> Plan -\> Execute/Verify; human approval at the specification boundary; agent autonomy after clear approved intent.                                                                                                                                                 | Adopt/adapt                                                                                 |
| Repo-native: apps/web/AGENTS.md + apps/web/CLAUDE.md         | Tracked app-scoped agent instruction layer. apps/web/AGENTS.md carries Next.js/web operational guidance; apps/web/CLAUDE.md imports @AGENTS.md to avoid duplication.                                                                                                                    | Canonical adapter for apps/web scope; not a monorepo-wide contract                          |
| Historical reference: .cursor/rules/forma_de_trabajo.mdc     | Useful prior operating rules: tool/skill discovery, do not invent commands, root-cause debugging, verification evidence, proportional test rigor, documentation sync, defense in depth and implementation-vs-verification separation.                                                   | Reference / adapt only; stack, paths and normative documents are from an older mini-project |
| Current Cursor / Claude Code instruction systems             | Cursor: AGENTS.md and .cursor/rules/\*.mdc; Claude Code: CLAUDE.md, imports, .claude/rules/\*.md, skills and hooks. Both treat instruction files as context; hard guarantees require deterministic enforcement.                                                                         | External product mechanics; not Gu OS design authority                                      |

# 3. The methodology at a glance

The lifecycle is intentionally longer than the external four-step Spec-Driven Development loop because Gu OS has multi-tenant security, durable business state, integrations, architecture invariants, governed releases and a growing documentation system. The external loop remains visible inside a richer Gu OS operating model.

<table style="width:100%;">
<colgroup>
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Discover /<br />
Clarify</strong></th>
<th><strong>Product Intent /<br />
PRD</strong></th>
<th><strong>Initiative Brief<br />
(if useful)</strong></th>
<th><strong>Feature /<br />
Business Spec</strong></th>
<th><strong>Architecture /<br />
ADR</strong></th>
<th><strong>Implementation Spec /<br />
Technical Plan</strong></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

<table style="width:100%;">
<colgroup>
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
<col style="width: 16%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Tasks /<br />
Vertical Slices</strong></th>
<th><strong>Implement</strong></th>
<th><strong>Verify /<br />
Classify / Repair</strong></th>
<th><strong>Review /<br />
Approve</strong></th>
<th><strong>Release<br />
Safely</strong></th>
<th><strong>Observe /<br />
Learn / Evolve</strong></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

This is not a waterfall. Artifacts can be revised when evidence reveals a contradiction. The key discipline is that the correction goes to the artifact that owns the defect, rather than letting implementation silently become the new truth.

# 4. Artifact architecture: which document owns which truth?

The methodology treats documentation as an architecture of responsibilities. Multiple documents are useful only when each owns a different question. A document that has no distinct ownership role should usually be merged, linked or retired.

| **Truth owned**             | **Primary artifact / system**                                  | **Question it owns**                                                                                                                          |
|-----------------------------|----------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Product truth               | Product Intent / PRD                                           | Why does the product exist, for whom, what problem/outcome matters, what strategy/principles/scope guide decisions?                           |
| Initiative framing          | Initiative Brief (optional)                                    | Why should this bounded initiative exist now, what outcome and constraints define it, and is deeper specification justified?                  |
| Behavior truth              | Feature / Business Spec                                        | Exactly what must the feature/capability do and not do, including happy/unhappy paths, business contracts and acceptance scenarios?           |
| Architecture decision truth | Architecture Analysis + ADR                                    | What boundaries/trade-offs matter and what consequential design choice was accepted/rejected?                                                 |
| Implementation intent       | Implementation Spec / Technical Plan                           | How will the approved behavior/architecture be realized in this system?                                                                       |
| Execution work              | Tasks / Vertical Slices                                        | What is the smallest ordered, verifiable implementation work and what is its Definition of Done?                                              |
| Implemented reality         | Code, schemas, migrations, configuration                       | What actually runs now? Implemented reality can invalidate an outdated plan but cannot silently redefine product intent or accepted behavior. |
| Verification truth          | Tests, evals, replay/simulation, readiness, evidence           | What evidence proves the implementation satisfies the Spec and invariants?                                                                    |
| Release truth               | Release record / flags / migration state / canary evidence     | What was released, where, under what controls, and how can it be rolled back?                                                                 |
| Outcome / learning truth    | Telemetry, incidents, business outcomes, improvement proposals | Did the change create the intended outcome, and what artifact should be changed next?                                                         |

| **Important analogy.** Gu OS already separates Case state, case_facts, transactional systems of record and Business Brain because different kinds of truth need different owners. Development documentation should follow the same discipline: PRD, Spec, ADR, Plan, Code and Tests are related, but they are not interchangeable sources of truth. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 5. Product Intent / PRD

The PRD is the durable product-context artifact. It should let a human or coding agent understand the product well enough to make aligned decisions across many sessions without re-discovering the fundamental problem every time. It is not a screen specification and it is not a technical plan.

| **Field**          | **Methodology rule**                                                                                                                                                                                                                                               |
|--------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Purpose            | Preserve why the product exists, for whom, the outcome/value thesis, strategy, product principles, major use cases, scope boundaries and success measures.                                                                                                         |
| Owner              | Product leadership / founders. AI may interview, synthesize and draft; humans approve product intent and unresolved assumptions.                                                                                                                                   |
| Required?          | Yes for Gu / Gu OS as a product. A new major product line or materially independent product may require its own PRD.                                                                                                                                               |
| Should contain     | Problem/evidence; target users/ICP; vision; strategy/positioning; product principles; value proposition; major journeys/use cases; scope/non-goals; roadmap framing; functional themes; relevant NFRs; success metrics; open questions; links to deeper artifacts. |
| Should not contain | Table schemas, endpoint-by-endpoint implementation, detailed component code, migration steps, exhaustive UI pixel specs, or architecture choices better owned by ADRs/plans.                                                                                       |
| Change cadence     | Low to moderate. Product-learning changes it; routine implementation should not.                                                                                                                                                                                   |
| Exit criterion     | A competent reviewer can explain why Gu/Gu OS exists, what outcome it promises, who it serves, what it intentionally does not become, and which product principles constrain lower-level decisions.                                                                |

The external Vibecoding guide is useful here: it treats PRD as persistent context across sessions and recommends problem, user, vision, strategy, principles, value proposition, key use cases, MVP/scope, non-goals, happy/unhappy paths, acceptance criteria, metrics, open questions and links. Gu OS should adapt this rather than copy it mechanically. Detailed material should move to linked documents so the PRD remains readable.

# 6. Initiative Brief: a lightweight bridge, not a second PRD

An Initiative Brief is optional. It exists to prevent two opposite failures: creating a full PRD for every small initiative, or jumping from an informal idea straight into a Feature Spec before the business purpose is understood.

| **Question**       | **Rule**                                                                                                                                                                                                                  |
|--------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Use it when        | A bounded initiative is meaningful enough to justify discovery but not yet mature enough for a full Spec; several related features share one outcome; the initiative needs prioritization/approval before technical work. |
| Do not use it when | The change is a small, well-understood maintenance task; the parent PRD and existing Spec already frame the work; or the initiative is itself the whole product and belongs in the PRD.                                   |
| Minimum content    | Problem/opportunity; user/stakeholder; desired outcome; why now; scope/non-goals; constraints; evidence; dependencies; open questions; parent PRD link; decision on next artifact.                                        |
| Exit paths         | Stop/reject; continue discovery; create/update Product PRD; create Feature/Business Spec; open Architecture Analysis/ADR if the main uncertainty is structural.                                                           |

| **Current brief.md.** The existing docs/brief.md should be treated as historical/provenance material during the later documentation audit. The current docs/README.md already classifies brief.md and plan.md as historical/reference. This Methodology does not yet decide whether to rename/archive/move them; that is the next documentation-architecture audit. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 7. Feature / Business Spec: source of intended behavior

For consequential non-trivial work, the Feature / Business Spec is the governing contract for intended behavior. It sits below product intent and above architecture/implementation. A coding agent should be able to derive an implementation plan from it without having to invent product behavior.

| **Field**            | **Methodology rule**                                                                                                                                                                                                                                                                                     |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Purpose              | Close ambiguity about what the capability must do and not do from the user/business perspective.                                                                                                                                                                                                         |
| Owner                | Product/domain owner with engineering participation. AI may interrogate ambiguities and draft. Human approval is the normal high-leverage gate.                                                                                                                                                          |
| Required?            | Yes for consequential feature behavior, workflow/case behavior, data contracts with business semantics, user-visible state machines, permissions/authority changes, or changes whose failure would be costly.                                                                                            |
| Core content         | Summary; user/business objective; actors; preconditions; strict scope and non-goals; expected behavior; happy paths; unhappy paths; state/decision rules; data/evidence requirements; permissions/human involvement; acceptance scenarios; verification expectations; open questions; links to PRD/ADRs. |
| What it does not own | Detailed file list, migration order, specific function signatures unless they are part of an external contract, or incidental implementation decisions.                                                                                                                                                  |
| Exit criterion       | Behavior is coherent, testable, compatible with known invariants and sufficiently explicit that implementation alternatives can be compared without changing what the feature means.                                                                                                                     |

| **Spec-driven means behavior-driven, not bureaucracy.** A Spec should be proportional to risk and ambiguity. The goal is not to produce more Markdown; it is to prevent a coding agent from silently resolving product questions inside implementation. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 8. Architecture Analysis and ADRs

Architecture Analysis explores a design space when the problem is not yet a single decision. An ADR records a consequential decision once the trade-off is understood. The repo already uses both patterns: long topic plans/analyses retain detail, while ADRs capture cross-cutting decisions that should not remain buried.

| **Artifact**          | **Rule**                                                                                                                                                                                                                                 |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Architecture Analysis | Use for multi-dimensional problems, uncertain boundaries, alternatives comparison, repo evidence, risks and staged recommendations. It can conclude that no new architecture is needed.                                                  |
| ADR                   | Use for a specific consequential decision with context, decision, alternatives/rejections, consequences, status and reevaluation trigger.                                                                                                |
| When not needed       | Routine implementation choices that do not create a durable constraint; local refactors with no cross-cutting consequence; choices already governed by a canonical ADR/plan.                                                             |
| Human role            | Approve material trade-offs and accepted direction. AI can perform repo inspection, alternative analysis and contradiction detection but must not silently convert an inference into accepted architecture.                              |
| Relationship to Spec  | A Spec defines intended behavior. Architecture may discover that the behavior is unsafe/impossible/underspecified; the Spec can then be revised explicitly. Architecture never silently changes product behavior through implementation. |

# 9. Implementation Spec / Technical Plan

The Technical Plan is the bridge from approved behavior/architecture into implementation. In Gu OS practice, it should translate governing sources rather than redesign them. If implementation reveals a material contradiction, the contradiction is surfaced and the owning artifact is revisited.

| **Field**          | **Methodology rule**                                                                                                                                                                                                                |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Inputs             | Approved Spec; relevant PRD/Brief; current repo reality; accepted ADRs/topic architecture; security/tenancy constraints; existing migrations/APIs/tests.                                                                            |
| Content            | Technical approach; affected components/files; schemas/migrations; contracts/interfaces; compatibility/brownfield strategy; flags; observability; security; test/eval plan; rollback; sequencing; known assumptions/open decisions. |
| Status discipline  | Explicitly label current/implemented, accepted target, tentative design, assumptions and human decisions. Do not present proposed schema as implemented behavior.                                                                   |
| Exit criterion     | The implementation can be decomposed into ordered, independently verifiable slices without requiring each coding session to re-decide architecture.                                                                                 |
| Contradiction rule | Implementation evidence may invalidate the Plan. Record the contradiction; fix Plan/ADR/Spec as appropriate. Do not let code become an undocumented design fork.                                                                    |

# 10. Tasks and vertical slices

Tasks are execution units, not miniature Specs. The preferred shape is a vertical slice: a small end-to-end increment that can demonstrate a real contract and produce evidence. Horizontal plumbing is acceptable when it is itself a prerequisite contract, but broad layers with no demonstrable behavior should be treated cautiously.

| **Aspect**             | **Rule**                                                                                                                                                                                                                                                                  |
|------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A good slice has       | One objective; declared dependencies; bounded files/components; implementation work; tests/evidence; flag/compatibility impact; security impact; Definition of Done; rollback/checkpoint.                                                                                 |
| A bad slice looks like | “Build backend,” “finish UI,” “add AI,” or a large task that cannot be verified until ten other layers land.                                                                                                                                                              |
| Ordering               | Work top-to-bottom unless dependencies allow parallelization. Parallel work should be isolated enough to avoid conflicting ownership of the same contracts/files.                                                                                                         |
| Checkpointing          | Implement -\> verify -\> checkpoint -\> continue is a useful playbook pattern, not a universal law. Use small commits/checkpoints when they improve review, rollback and agent context.                                                                                   |
| Agent autonomy         | Once the slice is bounded and governing artifacts are approved, a coding agent may implement broadly, inspect the repo and repair local defects without asking for line-by-line permission. It must not cross the approved scope or silently redefine governing behavior. |

# 11. Cross-cutting context artifacts: Design and repo operating instructions

Not every artifact belongs in the linear PRD -\> Spec -\> Plan chain. Some provide persistent context across many initiatives and should be linked rather than duplicated.

| **Cross-cutting artifact**                                                                                  | **Methodology role**                                                                                                                                                                                                                                                                                                                                                                                                           |
|-------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Experience / DESIGN.md-equivalent                                                                           | When UI/UX is material, preserve product interaction principles, design system/tokens, component patterns, accessibility, states and explicit do/don’t guidance. It complements, not replaces, PRD or Feature Specs. Dynamic/contextual UI must still obey the same experience doctrine.                                                                                                                                       |
| Portable root agent contract (AGENTS.md + CLAUDE.md adapter)                                                | Keep a short, stable and tool-portable root contract: authority map, repo discovery rules, verified commands, safety boundaries, development-method expectations and links to canonical docs. AGENTS.md is the preferred shared source when supported; Claude Code can import it from CLAUDE.md and append only Claude-specific instructions. Do not duplicate the full Methodology, PRD or architecture in always-on context. |
| Path-scoped IDE / agent rules (.cursor/rules/\*.mdc; .claude/rules/\*.md; nested AGENTS.md where supported) | Use for rules that matter only in a code area or file class: security/tenancy, database migrations, workflow runtime, UI/UX, docs/ADRs, testing/evals. Scope them so irrelevant instructions do not consume every agent context. Cursor .mdc adds metadata such as alwaysApply/globs; Claude rules use Markdown with optional paths frontmatter.                                                                               |
| Skills / playbooks for coding agents                                                                        | Use for multi-step reusable procedure: how to discover a feature, prepare a Spec, inspect migrations, debug a regression, verify an agentic behavior or review security. A Skill/playbook is procedure, not product truth, and should load on demand rather than live permanently in always-on instructions.                                                                                                                   |
| Hooks / automated checks                                                                                    | Use when an action or prohibition must reliably happen rather than merely be remembered in prose: tests, lint/type-check, migration validators, policy scans, permission checks, schema validation, CI, release gates and tool-use hooks. Instruction files guide model behavior; deterministic controls enforce guarantees.                                                                                                   |

## 11.1 The four-layer agent instruction architecture

The Methodology should not be copied wholesale into every coding-agent prompt. The operating architecture is layered so that stable knowledge remains authoritative, agents receive only the instructions they need, procedures are invoked when relevant, and hard guarantees are enforced outside model judgment.

| **Layer**                        | **Examples**                                                                           | **Primary purpose**                                                                                            | **Strength**                                                  |
|----------------------------------|----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|
| 1\. Canonical knowledge          | PRD, Principles & Design Doctrine, this Methodology, architecture manuals, Specs, ADRs | Own durable product/design/development truth. Rich enough for humans and agents to inspect when needed.        | Authoritative knowledge; not automatically loaded in full     |
| 2\. Agent operating instructions | Root AGENTS.md, CLAUDE.md adapter, path-scoped Cursor/Claude rules                     | Tell coding agents the small set of rules/context they must hold while working in the repo or a specific area. | Prompt/context guidance; high influence, not hard enforcement |
| 3\. Skills / Playbooks           | Spec preparation, debugging, migration review, verification, release checklist         | Encode reusable multi-step procedures that should load only when the task requires them.                       | Procedural guidance / orchestration                           |
| 4\. Deterministic enforcement    | Tests, linters, type-check, CI, validators, hooks, permission/policy gates             | Make critical guarantees mechanically checkable or block prohibited actions.                                   | Hardest enforcement available                                 |

| **Design rule.** Do not solve a hard-enforcement problem with a longer prompt. If a requirement must never be violated, prefer a validator, test, hook, policy or runtime guard. Use agent instructions to steer judgment and workflow, not as the sole security boundary. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 11.2 Current Gu OS root-agent files: what exists and what it means

The repository currently contains app-scoped agent instruction files at apps/web/AGENTS.md and apps/web/CLAUDE.md on main. apps/web/AGENTS.md contains a Next.js compatibility warning plus operational-case/tool-provisioning pointers; apps/web/CLAUDE.md contains only @AGENTS.md. This is a good scoped-instruction pattern: web-specific context stays with the web app, while a future root-level contract can carry only monorepo-wide rules.

| **Current item**                                                   | **Assessment**                                                                                                            | **Recommended evolution**                                                                                                                                                                                 |
|--------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| apps/web/AGENTS.md: Next.js breaking-change warning                | Valuable: it corrects model-training staleness and directs the agent to repo-local framework documentation before coding. | Keep in apps/web. Its scope is correct because it applies to the Next.js web application rather than the whole monorepo.                                                                                  |
| apps/web/AGENTS.md: Operational cases & tool provisioning pointers | Useful and concrete, but narrower than a root-wide operating contract.                                                    | Keep app-scoped. During the documentation audit, verify whether every pointer is still current and whether any deeper procedure should move to a Skill/playbook instead of expanding this always-on file. |
| apps/web/CLAUDE.md = @AGENTS.md                                    | Excellent anti-duplication adapter for Claude Code.                                                                       | Keep this anti-duplication adapter. Claude-specific content should be added only if it cannot live in the shared apps/web contract.                                                                       |
| Scope / hierarchy                                                  | Both files are tracked on main under apps/web/. No root-level AGENTS.md or CLAUDE.md has been verified.                   | Preserve the app-scoped pair. Evaluate adding a separate root AGENTS.md + root CLAUDE.md adapter for monorepo-wide rules; do not move web-specific content to root.                                       |

## 11.3 What should be always-on for coding agents

The old forma_de_trabajo.mdc contains several rules worth carrying forward, but in updated, tool-agnostic wording. The root always-on contract should stay concise; detailed domain rules belong in scoped rules or Skills.

| **Always-on candidate**        | **Updated Gu OS wording**                                                                                                                                                                                                                       |
|--------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Authority and source discovery | Before changing consequential behavior, identify the governing PRD/Spec/architecture/ADR/plan and current implemented reality. Do not silently choose among contradictory sources.                                                              |
| Inspect before inventing       | Inspect the repo, package scripts, existing patterns, available tools and Skills before planning. Do not invent commands, APIs, files, migrations or capabilities that can be verified.                                                         |
| Spec/plan discipline           | For consequential non-trivial work, implementation follows approved intended behavior and relevant architecture/plan. If implementation evidence contradicts them, surface and reconcile the owning artifact; do not silently redesign in code. |
| Security / tenancy             | Respect tenant isolation, authorization, evidence and side-effect boundaries. Prompt instructions are not a substitute for deterministic controls.                                                                                              |
| Verification before done       | Do not claim completion without evidence proportional to risk. State explicitly what was run, what passed/failed and what could not be verified.                                                                                                |
| Root-cause debugging           | For bugs, reproduce and isolate before patching; classify the owning artifact; make the smallest justified repair; add regression evidence.                                                                                                     |
| Documentation synchronization  | When a change modifies a governing contract, architecture decision or operational control, update the owning document/ADR/Spec in the same change or explicitly record why not.                                                                 |
| Abstraction discipline         | Prefer simplicity and stable semantic reuse. Do not apply DRY mechanically: duplicated syntax is cheaper than the wrong abstraction across different business/security semantics.                                                               |

## 11.4 Test-first, eval-first and verification independence

The older Cursor rule used TDD proportional to risk. The underlying idea survives, but Gu OS should generalize it beyond classic unit-test TDD because part of the system is model-mediated.

| **Behavior type**                         | **Preferred pre-implementation evidence**                                                                                           | **Examples**                                                                                                                       |
|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| Deterministic invariant / regression      | Test-first when practical: write a failing test or reproducible fixture before the fix.                                             | Tenant isolation, permission gates, workflow transition invariants, deterministic validators, financial formulas, reproduced bugs. |
| Model-mediated behavior                   | Eval/scenario-first: define representative prompts/states, expected rubric/outcomes and failure cases before tuning/implementation. | Intent classification, semantic extraction, qualitative synthesis, model routing.                                                  |
| Product / workflow behavior               | Acceptance-scenario-first: state observable happy/unhappy paths before implementation.                                              | Case lifecycle, human decision flows, cross-channel behavior, Studio authoring.                                                    |
| Minor UI/copy with no consequential logic | Lightweight verification proportional to impact.                                                                                    | Copy, spacing, non-critical presentation changes.                                                                                  |

| **Independent verification pattern.** For high-risk changes, prefer verification that is sufficiently independent of the implementer: deterministic tests/CI, a separate reviewer or human, or an isolated verification-agent pass. This is a development-process pattern, not a requirement to build Gu OS as a multi-agent product. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 12. Human + coding-agent operating model

The methodology is designed for strong agent autonomy without collapsing human authority. The human role shifts upward from typing code toward product intent, specification quality, architecture trade-offs, risk acceptance and outcome review. This does not mean humans disappear from implementation; it means human attention is concentrated where judgment and accountability have the highest leverage.

| **Stage**               | **Agent/human collaboration**                                                                                             | **Primary human gate**                                     |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| Discover / clarify      | Human leads intent and evidence; agent interviews, researches repo/context, identifies contradictions and drafts options. | Human confirms problem framing.                            |
| PRD / Brief             | Agent can synthesize; human owns product truth, strategy and non-goals.                                                   | Human approval.                                            |
| Feature / Business Spec | Agent drafts/test-challenges; human/domain owner resolves ambiguous behavior and risk.                                    | Human approval for consequential scope.                    |
| Architecture / ADR      | Agent inspects repo and compares alternatives; humans accept durable trade-offs.                                          | Architecture/product approval proportional to consequence. |
| Technical Plan          | Agent can derive plan; engineering owner reviews feasibility, security, compatibility and rollback.                       | Plan approval when risk/size warrants.                     |
| Implementation          | Agent can write/refactor/test within bounded scope; humans may pair/review hotspots.                                      | No routine approval for every edit.                        |
| Verification            | Agent runs tests/evals/replay/readiness and gathers evidence; humans review failures, risk and business acceptance.       | Evidence gate.                                             |
| Release                 | Agent may prepare release/canary/rollback steps; authorized human/system policy controls consequential release.           | Release authority.                                         |
| Observe / learn         | Agent mines incidents/outcomes and proposes changes; humans govern promotion/policy/code changes.                         | Governed improvement.                                      |

# 13. Model judgment vs deterministic engineering in development

The same repo-native boundary used inside Gu OS applies while building Gu OS. Use models where semantic understanding, synthesis, ambiguity resolution and adaptation matter; use deterministic mechanisms where repeatability, authorization and mechanically testable guarantees matter.

| **Development area**   | **Model-appropriate**                                                                   | **Deterministic-appropriate**                                                                                     |
|------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Requirements discovery | Model excels: ask contextual questions, surface contradictions, synthesize user intent. | Deterministic checklists can ensure required sections are not forgotten.                                          |
| Spec lint / schema     | Model can critique coherence and edge cases.                                            | Machine-check frontmatter/schema/required fields/links/version IDs.                                               |
| Architecture analysis  | Model can compare trade-offs and inspect broad context.                                 | Security invariants, tenancy rules, schema constraints and dependency checks remain explicit.                     |
| Code generation        | Model can implement and refactor.                                                       | Compiler, type system, tests, linters, migrations, permissions and release controls determine admissibility.      |
| Verification           | Model judge can assist qualitative evaluation.                                          | Mechanical postconditions/tests/evidence take precedence wherever available.                                      |
| Anti-pattern           | Growing regex/dictionary/rule forests trying to imitate semantic understanding.         | Opposite anti-pattern: using an LLM for stable calculations, permissions, hard gates or deterministic transforms. |

# 14. Verification: evidence before completion

A coding agent saying “done” is not evidence. Verification must be proportional to the contract and risk. Gu OS already has a strong readiness culture: the testing framework states that operational readiness validates reproducible business contracts, not simply whether a tool throws an exception.

| **Evidence layer**                        | **What it proves**                                                                                                 | **Use**                                                             |
|-------------------------------------------|--------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
| Level 0 - Static / local                  | Type-check, lint, schema validation, formatting, pure/unit tests.                                                  | Always where applicable.                                            |
| Level 1 - Component / integration         | Adapter/tool integration, database query contracts, migration behavior, API contracts.                             | When changed components cross boundaries.                           |
| Level 2 - Scenario                        | Happy/unhappy path, permission/empty/duplicate/timeout cases, deterministic fixtures.                              | Required for user/business behavior.                                |
| Level 3 - Agentic / eval                  | Model-dependent behavior with controlled fixtures, eval sets, model/judge where mechanical verifier is incomplete. | Required when behavior materially depends on model judgment.        |
| Level 4 - Replay / simulation / readiness | Exercise the same runtime contracts with controlled state/evidence; N0-N5 readiness when relevant.                 | Required for operational workflow changes proportional to maturity. |
| Level 5 - E2E / product acceptance        | Actual UI/channel/business flow and side effects under controlled conditions.                                      | Required for high-value user journeys.                              |
| Level 6 - Release / outcome               | Canary, telemetry, regressions, business outcome and rollback evidence.                                            | Required for consequential production evolution.                    |

| **Verification should challenge the Spec.** Tests are not only implementation checks. They can reveal that the Spec itself is ambiguous, unsafe or wrong. When that happens, the correct response is not to “make the test pass” by changing code blindly; classify the failure and repair the owning artifact. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 14.1 Verification-first spectrum

Verification should be designed before or alongside implementation whenever the expected behavior can be stated. The specific instrument depends on whether the behavior is deterministic, model-mediated or product-level.

| **If the behavior is...**                 | **Prefer...**                                       | **Completion signal**                                                    |
|-------------------------------------------|-----------------------------------------------------|--------------------------------------------------------------------------|
| Deterministic and mechanically assertable | Tests/fixtures first when practical                 | Previously failing case passes; relevant regression suite remains green  |
| Model-dependent                           | Eval/scenario set first                             | Quality/safety rubric and failure-rate threshold met on controlled cases |
| User/business workflow                    | Acceptance scenarios first                          | Observable happy/unhappy paths and evidence contract satisfied           |
| Operational release                       | Replay/simulation/readiness + canary where relevant | Same runtime contracts pass; release evidence and rollback path exist    |

# 15. Failure classification and owning-artifact repair

Verification failure is routed to the artifact that owns the defect. This is a repo-native Gu OS idea and a key extension beyond simple Spec -\> Plan -\> Code loops.

| **Failure class**                              | **Owning artifact**                              | **Repair action**                                                                        |
|------------------------------------------------|--------------------------------------------------|------------------------------------------------------------------------------------------|
| Requirement ambiguity / wrong desired behavior | Product Intent / Initiative Brief / Feature Spec | Clarify outcome/actor/scope; revise governing behavior before further implementation.    |
| Architecture contradiction / unsafe design     | Architecture Analysis / ADR / Technical Plan     | Revisit the trade-off; document accepted alternative and consequences.                   |
| Missing/misordered work or contract            | Technical Plan / Tasks / vertical slices         | Repair decomposition/dependencies; do not change intended behavior.                      |
| Implementation defect                          | Code/config/migration                            | Fix implementation and re-run relevant evidence.                                         |
| Verifier/test defect                           | Test/eval/verifier contract                      | Repair the evidence mechanism; preserve the business contract.                           |
| Environment/provider/integration issue         | Environment/integration/runbook                  | Repair setup or explicitly classify external dependency failure.                         |
| Policy/security issue                          | Policy/Spec/ADR                                  | Do not bypass the gate to make implementation succeed.                                   |
| Non-convergence                                | Plan/scope/agent strategy/human decision         | Stop bounded retries; escalate or reduce/reframe scope rather than looping indefinitely. |

## 15.1 Debugging loop for agentic development

For reported bugs, the default sequence is: reproduce -\> isolate -\> classify cause -\> identify owning artifact -\> make the minimum justified repair -\> run regression evidence -\> update governing documentation if the contract/control changed. Avoid speculative patching before the failure mechanism is understood.

| **Step**            | **Question**                                                                                                                                     |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| Reproduce           | Can we make the failure observable with a deterministic fixture, scenario or controlled run?                                                     |
| Isolate             | Which layer actually fails: product requirement, model interpretation, deterministic code, state/data, provider/environment, verifier or policy? |
| Classify            | Which artifact owns the defect?                                                                                                                  |
| Repair              | What is the smallest change that fixes the root cause without broad unrelated redesign?                                                          |
| Regression evidence | What test/eval/scenario proves the failure is fixed and adjacent contracts remain safe?                                                          |
| Document            | Did the accepted behavior, architecture or control change? If yes, reconcile the owning Spec/ADR/plan/docs.                                      |

# 16. Review, approval and release

Human review should be concentrated at consequential boundaries rather than sprayed across every agent action. Approval intensity is proportional to product, security, data, business and operational risk.

| **Change class**                                 | **Signal**                                                                | **Minimum governance**                                                     |
|--------------------------------------------------|---------------------------------------------------------------------------|----------------------------------------------------------------------------|
| Low-risk maintenance                             | Existing intent/architecture unchanged; tests prove no behavior drift.    | Code review + automated checks; no new PRD/Spec.                           |
| Feature behavior change                          | User/business behavior changes.                                           | Spec approval + evidence; architecture review if boundaries change.        |
| Data/tenancy/security change                     | Authorization, RLS, secrets, data ownership/scope, external side effects. | Security/architecture review + explicit verification/rollback.             |
| Workflow/case authority change                   | Transitions, approvals, evidence, durable state, external commitments.    | Business/architecture approval + simulation/replay/readiness.              |
| Production code/policy self-improvement proposal | Generated from incidents/evals/outcomes.                                  | PR + tests/evals + human release authority; never silent runtime mutation. |

Release safely means retaining a credible rollback path: additive migrations where practical, feature flags, versioned behavior, canary/staged rollout and preserved prior artifacts. “Generated quickly” is not a reason to make consequential change irreversible.

# 17. Observe, learn and evolve

After release, product and engineering outcomes feed the next cycle. Gu OS already defines a safe change path: detect failure -\> classify owning artifact -\> propose versioned change -\> simulate/evaluate -\> approve -\> publish/canary -\> measure -\> retain or rollback. The methodology adopts the same pattern for software development.

| **Loop stage**    | **Development meaning**                                                                                           |
|-------------------|-------------------------------------------------------------------------------------------------------------------|
| Observe           | Incidents, support, usage, business outcomes, rework, cost, latency, human corrections, failed evals.             |
| Classify          | Which artifact owns the learning: PRD, Spec, ADR, pattern, Skill, test fixture, code, runbook, provider contract? |
| Propose           | Versioned diff/change proposal with provenance and expected impact.                                               |
| Evaluate          | Tests, replay, simulation, security review, product acceptance and comparison to baseline.                        |
| Approve / release | Authority proportional to risk; canary/staged deployment where appropriate.                                       |
| Measure           | Did the change improve the intended outcome without unacceptable regressions/cost?                                |
| Retain / rollback | Keep evidence-linked successful changes; revert or revise unsuccessful ones.                                      |

# 18. Which artifacts are required? Proportionality matrix

The methodology must not turn every two-line fix into a paperwork exercise. Artifact depth scales with ambiguity, consequence and cross-cutting impact.

| **Work type**                    | **Typical signal**                                                          | **Minimum artifacts**                                                                                         | **Usually unnecessary**                                     |
|----------------------------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| Tiny refactor / typo / local bug | Existing governing behavior is clear; no architecture/security/data change. | Issue/task or short change note; tests/checks.                                                                | PRD, new Spec, ADR usually unnecessary.                     |
| Normal feature                   | User-visible behavior changes but architecture is familiar.                 | Parent PRD link + Feature Spec + implementation plan/tasks + verification evidence.                           | Initiative Brief optional.                                  |
| Major initiative / new domain    | Multiple related capabilities share a business outcome.                     | PRD or parent PRD + Initiative Brief + Specs + architecture/ADRs + plan + staged evidence.                    | Dedicated initiative PRD if materially independent.         |
| Architecture/platform change     | Cross-cutting runtime/data/security/tooling constraint.                     | Architecture Analysis + ADR + Technical Plan; affected Specs if behavior changes.                             | PRD only if product intent/scope changes.                   |
| Workflow/case definition         | Durable responsibility, transitions, approvals, evidence or dynamic work.   | Business/Feature Spec + workflow implementation spec + verification/replay/readiness + versioned publication. | Architecture/ADR when new primitive/boundary is introduced. |
| High-risk security/data change   | Tenancy, authorization, privacy, credentials, destructive/external effects. | Spec/ADR/plan + explicit security evidence and rollback.                                                      | Human approval mandatory at relevant authority boundary.    |

# 19. Documentation governance and authority

The repo already has an authority order in docs/README.md. This methodology preserves it and adds an artifact-responsibility rule: when documents disagree, first determine whether they are even trying to own the same truth. A PRD and architecture plan can differ without contradiction if one describes product intent and the other implementation; two current architecture documents claiming different implemented behavior is a real contradiction.

| **Governance concern**     | **Rule**                                                                                                                                                    |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Status label               | Every consequential document should identify whether statements are Implemented, Partial, Target, Tentative, Open or Reference where ambiguity is possible. |
| Owner / scope              | Document should state what question/topic it owns and what it does not own.                                                                                 |
| Governing sources          | Plans/specs should link to parent PRD/Spec/ADR/architecture rather than restating them wholesale.                                                           |
| Supersession               | If a document is replaced, mark it Superseded/Historical and link to the replacement. Do not leave two competing “current” documents.                       |
| Contradictions             | Record and resolve; do not silently choose the more convenient document or let code drift become undocumented doctrine.                                     |
| Tool-specific instructions | May point to canonical docs; should not create a parallel product/architecture truth for Claude/Cursor/Codex/etc.                                           |
| Historical material        | Keep when it explains provenance/evolution, but remove it from the active authority path.                                                                   |

| **Current repo note.** docs/README.md already classifies brief.md and plan.md as historical/reference. architecture.md remains the concise implemented-runtime overview, while manuals/architecture-manual.md and topic plans carry integrated/current-target design. The later documentation audit will decide how the new PRD changes that map; this Methodology intentionally does not pre-empt that audit. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 20. Worked example: Relationship Operations / Lead Opportunity Case

This example shows why the artifact hierarchy matters. It is illustrative methodology, not a new approved product Spec.

| **Artifact**                | **Relationship Operations example**                                                                                                                                                                                                    |
|-----------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Product Intent / PRD        | Real-estate teams lose revenue because valuable opportunities depend on human memory/capacity. Gu should assume increasing responsibility for advancing opportunities while humans retain authority over sensitive business decisions. |
| Initiative Brief            | Why Relationship Operations now? Desired business outcome, customer evidence, wedge, initial scope, constraints, current Traditional Gu behavior and metrics to improve.                                                               |
| Feature / Business Spec     | Define when a Lead Opportunity exists, what durable state/facts/commitments it owns, what events advance it, what counts as blocked/completed, how human decisions work, happy/unhappy paths and acceptance scenarios.                 |
| Architecture Analysis / ADR | Decide Operational Case vs other root; CRM/SOR vs case_facts boundaries; wake-ups/events; capability dispatch; how it coexists with a Transaction Case.                                                                                |
| Technical Plan              | Schemas/migrations, adapters, case type/work items, event wiring, policies, projections/UI, flags, compatibility with Traditional Gu, test/eval/readiness strategy.                                                                    |
| Vertical Slice              | For example: create/attach Lead Opportunity Case from an existing lead, persist one commitment/fact, wake on event, surface one governed next action, verify no tenant/authority regression.                                           |
| Verification                | Unit/integration + scenarios + agent eval where judgment matters + replay/readiness + E2E through web/WhatsApp-equivalent path when available.                                                                                         |
| Observe / Learn             | Measure response/visit/outcome progression, human touches, corrections, rework, cost and failure classes; propose changes to the owning artifact rather than only tuning prompts.                                                      |

# 21. Relationship to Workflow Studio and spec-driven authoring inside Gu OS

There are two related but distinct spec-driven systems and they should not be conflated.

| **System**                            | **What it governs**                                                                            | **Typical chain**                                                                                                                                                                     |
|---------------------------------------|------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A. Development of Gu OS               | How humans + coding agents design and build the product itself.                                | PRD/Brief -\> Feature Spec -\> Architecture/ADR -\> Technical Plan -\> Tasks/Slices -\> Code -\> Verification -\> Release -\> Learning                                                |
| B. Spec-driven authoring inside Gu OS | How Gu OS/Studio converts a business workflow intention into a governed executable definition. | Business spec -\> implementation spec -\> capability map/compiler -\> versioned definition -\> validation/simulation/replay -\> publication -\> runtime evidence -\> fork/new version |

They share principles: explicit intent, versioning, evidence, bounded authority, classification of failures and no silent redesign. But a workflow definition compiled by Studio is a product runtime artifact; a Gu OS Feature Spec is an engineering/product development artifact.

# 22. What this document deliberately does not decide yet

| **Open implementation choice**                                                  | **Why deferred**                                                                                                                                                                                                                                                             |
|---------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Exact PRD file path/name                                                        | Likely docs/product/PRD.md or equivalent, but decide after documentation audit.                                                                                                                                                                                              |
| Whether brief.md is moved/renamed/archived                                      | The repo already treats it as historical/reference; audit links and provenance before changing paths.                                                                                                                                                                        |
| Whether Gu OS needs one PRD or product + initiative PRDs                        | Methodology defines roles; documentation audit/product synthesis should choose minimum non-duplicative structure.                                                                                                                                                            |
| Exact template fields/frontmatter                                               | Templates/Playbooks is a separate deliverable after methodology and PRD/document audit.                                                                                                                                                                                      |
| Final distribution of agent instructions across AGENTS.md, IDE rules and Skills | apps/web/AGENTS.md + apps/web/CLAUDE.md already provide a tracked app-scoped layer. The remaining design decision is whether to add a concise root-wide AGENTS.md + CLAUDE.md adapter and which additional rules belong in nested/path-scoped files versus on-demand Skills. |
| Final Principles & Design Doctrine wording                                      | The adjudicated Principle Registry is ready, but Doctrine publication follows this Methodology and the product-document architecture.                                                                                                                                        |

# 23. Adoption plan for the methodology

Adoption should itself be brownfield. Do not stop engineering to rewrite all historical documentation. Apply the methodology first to new consequential work and progressively reconcile existing artifacts.

| **Order** | **Action**                                                                                                                                                                                                                                                                                                                                                                   |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Step 1    | Approve this Methodology v0.2.1 conceptually, including the four-layer agent instruction architecture and proportional test/eval-first guidance.                                                                                                                                                                                                                             |
| Step 2    | Audit current docs, strategic documents and agent-instruction files using a matrix: retain canonical / contributes to PRD / link from PRD / merge / supersede / historical/archive / agent-adapter-only. Treat apps/web/AGENTS.md and apps/web/CLAUDE.md as tracked app-scoped adapters.                                                                                     |
| Step 3    | Create the canonical Gu / Gu OS Product PRD from reconciled existing material, not from a blank page.                                                                                                                                                                                                                                                                        |
| Step 4    | Publish the concise Principles & Design Doctrine using the adjudicated Registry plus this Methodology/product intent.                                                                                                                                                                                                                                                        |
| Step 5    | Create Templates / Playbooks for PRD, Initiative Brief, Feature/Business Spec, ADR, Technical Plan, Slice/Task and Verification.                                                                                                                                                                                                                                             |
| Step 6    | Update docs/README.md authority map; preserve apps/web/AGENTS.md + apps/web/CLAUDE.md as web-scoped adapters; add a concise root AGENTS.md + root CLAUDE.md only for monorepo-wide rules if the audit confirms the need; add further nested/path-scoped IDE rules/Skills only where they reduce noise or encode real procedure; mark superseded/historical files explicitly. |
| Step 7    | Use one real upcoming Gu OS initiative as a pilot; measure whether the method reduces drift/rework and improves verification, then refine.                                                                                                                                                                                                                                   |

# 24. Working glossary

| **Term**                             | **Working definition**                                                                                                                                                                                   |
|--------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Product Intent                       | The durable why/for whom/outcome/strategy context of a product.                                                                                                                                          |
| PRD                                  | Product Requirements Document; canonical product-intent context, not a technical implementation document.                                                                                                |
| Initiative Brief                     | Optional lightweight framing artifact for a bounded initiative before committing to detailed specification.                                                                                              |
| Feature / Business Spec              | Approved intended-behavior contract for consequential functionality.                                                                                                                                     |
| Architecture Analysis                | Evidence-based exploration of system boundaries, alternatives, risks and design space.                                                                                                                   |
| ADR                                  | Architecture Decision Record; concise accepted/rejected consequential decision with context and consequences.                                                                                            |
| Implementation Spec / Technical Plan | Detailed translation of approved behavior/architecture into implementation design.                                                                                                                       |
| Vertical Slice                       | Small end-to-end increment that can be demonstrated and verified against a real contract.                                                                                                                |
| Definition of Done                   | Explicit conditions/evidence that make a task/slice complete.                                                                                                                                            |
| Verification Evidence                | Tests/evals/replay/simulation/readiness/E2E evidence that supports a completion or release claim.                                                                                                        |
| Owning artifact                      | The document/system that has authority over the type of truth implicated by a failure or change.                                                                                                         |
| Silent drift                         | Behavior/design changes introduced through implementation without reconciling the governing artifact.                                                                                                    |
| Spec-driven development              | Development in which approved intended behavior is explicit before consequential implementation and downstream plans/tests derive from it.                                                               |
| Agentic development                  | Software development where AI coding agents perform meaningful reasoning/implementation/testing inside explicit human/governance boundaries.                                                             |
| Repo operating instructions          | Concise persistent instructions for building/testing/navigating a repository; tool-specific entrypoints should link to canonical truth rather than duplicate it.                                         |
| Agent operating contract             | Concise always-on project instructions for coding agents: authority map, verified workflows/commands, safety rules and links to canonical sources; not a replacement for product/architecture documents. |
| Path-scoped rule                     | Instruction loaded only when work touches matching files/directories; used to keep domain-specific guidance out of every coding-agent context.                                                           |
| Deterministic enforcement            | Test, hook, validator, policy, permission or CI/release mechanism that mechanically checks or blocks behavior rather than relying on model compliance.                                                   |
| Verification independence            | Degree to which verification is performed by evidence/mechanisms sufficiently separate from the generation path to reduce self-confirming errors.                                                        |

# Appendix A - Source-to-method mapping

| **Source idea**                                                              | **Disposition**               | **Methodology consequence**                                                                                                                                     |
|------------------------------------------------------------------------------|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Lab10 Vibecoding: PRD as persistent product context                          | Adopt / adapt                 | Becomes Product Intent / PRD; keep concise and link deep material.                                                                                              |
| Lab10 Vibecoding: DESIGN.md                                                  | Adapt                         | Cross-cutting Experience/Design Contract; not mandatory for backend-only work and not a substitute for Specs.                                                   |
| Lab10 Vibecoding: CLAUDE.md                                                  | Generalize                    | Tool-agnostic repo operating instructions; Claude-specific file may remain one adapter/entrypoint.                                                              |
| Lab10: inspect/think before coding                                           | Adopt                         | DM: investigate/clarify before code; authoritative repo/docs over invention.                                                                                    |
| Lab10: vertical slices                                                       | Adopt                         | Preferred task decomposition for user/business behavior.                                                                                                        |
| Lab10 SDD: Clarify -\> Spec -\> Plan -\> Execute/Verify                      | Adopt + extend                | Gu OS adds PRD/Brief, Architecture/ADR, owning-artifact failure routing, release governance and outcome learning.                                               |
| Lab10 SDD: human approves Spec, agent codes/tests                            | Adapt                         | Strong default; additional human gates depend on architecture/security/business risk.                                                                           |
| Gu OS Technical Plan: spec-driven workflow lifecycle                         | Recognize as repo-native      | Confirms SDD is already part of Gu OS direction, not imported from Lab10.                                                                                       |
| Gu OS Detailed Implementation Plan: translate, do not redesign               | Adopt                         | Implementation contradiction is escalated/reconciled; no silent drift.                                                                                          |
| Gu OS ai-native-loops: safe change path                                      | Adopt                         | Extends development into governed learning and rollback.                                                                                                        |
| Gu OS readiness: reproducible business contracts                             | Adopt                         | Verification evidence must prove the real contract, not only technical execution.                                                                               |
| Gu OS ADR system                                                             | Adopt                         | Cross-cutting decisions live in ADRs; topic plans retain detail.                                                                                                |
| Historical forma_de_trabajo.mdc: tool/skill discovery + no invented commands | Adopt / modernize             | Move concise versions into the portable agent contract; derive actual commands from current package scripts/repo evidence.                                      |
| Historical forma_de_trabajo.mdc: risk-proportional TDD                       | Adapt                         | Deterministic invariants/regressions -\> test-first; model behavior -\> eval/scenario-first; product workflows -\> acceptance-scenario-first.                   |
| Historical forma_de_trabajo.mdc: implementer vs QA separation                | Adapt                         | Prefer sufficiently independent verification for high-risk work; mechanism may be CI, human review, deterministic verifier or isolated verification-agent pass. |
| Historical forma_de_trabajo.mdc: root-cause debugging                        | Adopt                         | Reproduce -\> isolate -\> classify owning artifact -\> minimum repair -\> regression evidence.                                                                  |
| Historical forma_de_trabajo.mdc: absolute DRY                                | Reject / replace              | Prefer simplicity and stable semantic reuse; avoid premature abstractions that collapse distinct business/security semantics.                                   |
| Cursor/Claude persistent instruction mechanics                               | Adopt as adapter architecture | Canonical docs -\> concise root agent contract -\> path-scoped rules -\> Skills/playbooks -\> deterministic hooks/tests/CI.                                     |

# Appendix B - Preliminary current-repo document role map

| **Source-state precision. apps/web/AGENTS.md and apps/web/CLAUDE.md are tracked on GitHub main and are correctly app-scoped for their current content. No root-level AGENTS.md or CLAUDE.md was found in the inspected main snapshot. The methodology therefore recommends preserving the existing web layer and evaluating a separate root layer only for genuinely monorepo-wide instructions.** |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

This map was intentionally preliminary and has now been followed by the dedicated Gu OS Documentation & Agent Context Architecture Audit v0.1. Use that audit for role, supersession and target-location decisions; do not use this preliminary table by itself to rename, move or delete files.

| **Artifact**                               | **Provisional role**                                 | **Recommendation**                                                                                                                                                                             |
|--------------------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| docs/README.md                             | Documentation authority/index                        | Keep canonical; update later with PRD/Methodology/Doctrine locations.                                                                                                                          |
| docs/brief.md                              | Historical initial personal/business agent MVP brief | Retain as provenance for now; likely superseded for product intent by future PRD; audit links before moving.                                                                                   |
| docs/plan.md                               | Historical/evolutionary implementation plan          | Retain as history/provenance; not the modern product roadmap or PRD.                                                                                                                           |
| docs/architecture.md                       | Concise implemented-runtime technical overview       | Keep as implemented reality overview; title/legacy framing may need later cleanup.                                                                                                             |
| docs/manuals/architecture-manual.md        | Integrated current/target architecture               | Keep canonical architecture map.                                                                                                                                                               |
| Topic-specific technical plans             | Accepted target design by topic                      | Keep; subordinate implementation work to these where marked governing.                                                                                                                         |
| ADRs                                       | Cross-cutting accepted decisions                     | Keep and expand as needed.                                                                                                                                                                     |
| Principle Mining Registry v0.3             | Evidence-rich adjudicated principle inventory        | Working source for future concise Doctrine; not product truth.                                                                                                                                 |
| Agentic Architecture Primer v0.2           | Pedagogical mental model                             | Keep educational/reference; not governing implementation source.                                                                                                                               |
| Future Gu/Gu OS PRD                        | Product intent                                       | New canonical product artifact after audit/reconciliation.                                                                                                                                     |
| This Methodology                           | How product/software is designed and developed       | New canonical development-process artifact after approval.                                                                                                                                     |
| Future Principles & Design Doctrine        | Canonical decision principles                        | New concise doctrine after Methodology + PRD/document architecture are stabilized.                                                                                                             |
| apps/web/AGENTS.md                         | Tracked app-scoped coding-agent instruction contract | Keep in apps/web. Verify/update its web-specific pointers during audit; do not promote the same content to root. A future root AGENTS.md, if created, should contain only monorepo-wide rules. |
| apps/web/CLAUDE.md = @AGENTS.md            | Tracked Claude Code adapter for apps/web             | Keep. It cleanly imports the adjacent app-scoped AGENTS.md and avoids duplicate instructions.                                                                                                  |
| .cursor/rules/\*.mdc / .claude/rules/\*.md | Path-scoped or IDE-specific agent rules              | Use only for contextual instructions that should not live always-on; do not fork canonical product/architecture truth into IDE-specific copies.                                                |
