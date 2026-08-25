# Gu OS Principles & Design Doctrine

> **Version:** v1.0  
> **Status:** Draft for founder / product / architecture review  
> **Intended repo path:** `docs/principles/gu-os-principles-and-design-doctrine.md`  
> **Purpose:** Canonical decision doctrine for Gu / Gu OS. This document distills the evidence-rich Principle Registry into a compact operating constitution; it does not replace the PRD, Development Methodology, ADRs, architecture sources, Specs or executable mechanisms.

## 1. How to use this doctrine

This document answers **how Gu OS should make recurring product, architecture, AI, UX, security and evolution decisions**. It is intentionally normative, but it is not a catalog of every implementation detail.

Use the following chain:

`Values -> Principles -> Invariants -> Patterns -> ADR / Design Decision -> Mechanism -> Evidence`

- **Value:** what we protect or optimize over time.
- **Principle:** reusable guidance for choosing among alternatives.
- **Invariant:** a condition the system must not violate.
- **Pattern:** a reusable solution shape, useful but not universally mandatory.
- **ADR / Design Decision:** a concrete choice in a defined design space, with rationale and reevaluation trigger.
- **Mechanism:** how the current system enforces a principle/invariant. Mechanisms may change without changing doctrine.
- **Evidence:** tests, evals, replay, readiness, audit or outcome data demonstrating the mechanism and behavior.

> **Governance rule:** Do not call every rule a principle. Code repetition alone does not establish doctrine. Strong doctrine requires repeated rationale, explicit architectural intent and/or enforceable boundaries across contexts.

## 2. Canonical values

| ID | Value | Meaning |
|---|---|---|
| V-01 | **Human leadership and capability amplification through governed autonomy** | Humans remain accountable and able to intervene; AI should expand capacity rather than force constant manual operation. |
| V-02 | **Reliable, verifiable execution** | Consequential work must be demonstrably correct enough for its risk, not merely fluent or plausible. |
| V-03 | **Security, privacy and tenant isolation** | Authority, minimization and tenant boundaries are product properties, not after-the-fact controls. |
| V-04 | **Business outcomes over activity** | Optimize for validated business results, not message, tool-call or task volume. |
| V-05 | **Contextual intelligence and adaptability** | Use models where judgment and context matter while preserving authority and source boundaries. |
| V-06 | **Traceability, reversibility and learnability** | Important decisions/actions should be attributable, versionable and reversible enough to support repair and governed improvement. |

## 3. Canonical cross-cutting principles

### CP-01 - Start from business responsibility and outcome

Define what Gu is responsible for advancing and what outcome proves value before choosing UI, workflow, model or tool. Activity metrics are diagnostics, not the product objective.

**Design test:** Anti-pattern: feature-first design or optimizing messages/tool calls without a downstream business result.

### CP-02 - Make operational truth explicit and keep truth types distinct

Conversation, memory, Case state, case_facts, transactional systems of record and Business Brain answer different questions. Give each type of truth an explicit owner and do not collapse them for convenience.

**Design test:** Anti-pattern: using chat history, memory or Brain as a second operational status store.

### CP-03 - Reuse one operating kernel; add domain semantics rather than duplicate engines

Property, Relationship, Demand, Transaction and Network/Ecosystem responsibilities should compose over shared runtime primitives for durable work, events, governance, evidence and human involvement.

**Design test:** Anti-pattern: separate mini-apps or workflow engines for every domain that later need to be re-integrated into Gu.

### CP-04 - Model power, bounded authority

Let models reason, diagnose, synthesize and adapt broadly inside explicit policy, capability, tenancy, risk, evidence and human-authority boundaries. Intelligence and authority are separate design dimensions.

**Design test:** Anti-pattern: either hard-coding all judgment or treating model confidence as permission to act.

### CP-05 - Put judgment in models/Skills; put repeatable guarantees in deterministic code/tools

Semantic interpretation, contextual judgment, synthesis and adaptation belong in model/Skill space; calculations, validation, permissions, stable transforms, state invariants and mechanical postconditions belong in testable deterministic mechanisms.

**Design test:** Preferred composition: model semantic interpreter -> structured result -> deterministic contract executor. Anti-pattern: expanding regex/dictionary/rule cascades that imitate semantic understanding.

### CP-06 - Request capabilities, not executor identities

Workflows and Work Items should express the capability needed. The runtime resolves an allowed executor: model/agent, deterministic service, human or external provider.

**Design test:** Anti-pattern: hard-coding a particular agent/provider into business semantics when the capability is the durable contract.

### CP-07 - Evidence - not agent assertion - closes consequential work

Model/tool claims may guide the loop, but completion depends on admissible evidence and verification appropriate to the business/risk contract.

**Design test:** Anti-pattern: treating a fluent answer, successful tool return or status string as proof that the real-world postcondition occurred.

### CP-08 - Version consequential behavior, pin execution and preserve rollback

Published governed behavior should be reproducible. Running consequential work knows which definition/version it used; change creates a new version rather than mutating history.

**Design test:** Anti-pattern: changing live behavior underneath running work with no version/provenance/rollback path.

### CP-09 - Evolve brownfield, additively and behind reversible boundaries

Preserve proven Gu behavior while progressively absorbing it into shared Gu OS primitives. Prefer additive migrations, flags, adapters and reversible transitions over big-bang rewrites.

**Design test:** Anti-pattern: replacing working customer flows merely because the target architecture is cleaner.

### CP-10 - Use the same runtime contracts for production, simulation, replay and testing

Verification environments should invoke the same transition evaluators, dispatchers, guards and verifiers as production wherever practical.

**Design test:** Anti-pattern: lab-only behavior that cannot establish what production will actually do.

### CP-11 - Human involvement is risk-justified and role-specific, not blanket

Differentiate action authorization, business decision, human contribution/task and exception review. Use blocking HITL, human-as-executor or human-on-the-loop according to the actual role and risk.

**Design test:** Anti-pattern: approval on every step, which creates fatigue without meaningful control.

### CP-12 - Authorize first; preserve provenance; treat external content as untrusted

Filter authority/scope before retrieval or action. Preserve source scope and provenance. External messages/content do not become internal authority because they sound plausible or name an internal entity.

**Design test:** Anti-pattern: retrieve broadly and attempt to filter later; merge identities or scopes by names/semantics alone.

### CP-13 - Compile the relevant context; do not maximize context by default

Context is a scarce operational resource. Retrieve and assemble the smallest authoritative set needed for the decision, with scope and provenance, rather than dumping all history into the model.

**Design test:** Anti-pattern: equating more tokens with more intelligence.

### CP-14 - Resolve continuity conservatively; ambiguity cannot silently authorize action

Use explicit structural references and deterministic/stage-aware evidence first; use constrained semantic resolution only after narrowing; clarify real ambiguity. Prefer no action to a wrong association.

**Design test:** Anti-pattern: an LLM silently choosing among ambiguous Cases, identities or prior result sets.

### CP-15 - Own differentiated business responsibility; orchestrate replaceable capabilities

Gu retains responsibility, continuity, context, governance, evidence and outcome feedback whether the underlying mechanism is owned inside Gu OS or provided by a replaceable specialist.

**Design test:** Anti-pattern: confusing verticalization with building every underlying capability.

### CP-16 - Govern self-improvement as a versioned, evidence-gated lifecycle

Detect -> classify owning artifact -> propose versioned change -> evaluate/simulate -> approve -> publish/canary -> measure -> retain or rollback. Autonomy is earned per operation through measured evidence.

**Design test:** Anti-pattern: equating cron repetition, prompt rewriting or runtime self-editing with governed learning.

### CP-17 - Repair selectively from declared dependencies

When an input/fact changes, invalidate and repair only the artifacts, approvals or work that the declared business methodology says depend on it.

**Design test:** Anti-pattern: global recomputation, heuristic field-name dependencies or leaving stale artifacts silently valid.

## 4. High-confidence invariants

Invariants are stronger than principles: a design that violates one is not an acceptable implementation merely because another trade-off looks attractive.

| ID | Invariant |
|---|---|
| I-01 | Tenant-owned data or knowledge does not cross a tenant boundary without an explicit authorized sharing model. |
| I-02 | Privileged backend credentials do not substitute for user/tenant authorization. |
| I-03 | A published governed behavior version is immutable; change creates a new version and running consequential work pins the version it uses. |
| I-04 | Business truth and executable-work state remain distinct; Case and Work planes are not collapsed into one status/table vocabulary. |
| I-05 | Operational responsibility lives in governed durable roots - not in Brain, memory, chat transcripts or UI projections; Brain is not an action queue or duplicate operational status store. |
| I-06 | Where evidence is required, a model claim cannot substitute for admissible evidence. |
| I-07 | Changing channel or surface cannot widen action authority, approval policy or data scope. |
| I-08 | Ambiguous identity, Case or antecedent resolution cannot authorize side effects; clarify or fail closed. |
| I-09 | Imported or generated code/scripts do not gain execution authority merely by being generated, stored, imported or published as content. |
| I-10 | Runtime AI cannot silently self-publish production code, permissions/policies or other protected governing behavior. |
| I-11 | Catalog, scope or metadata labels describe/limit capability discovery; they do not themselves grant authorization. |

## 5. Reusable patterns

Patterns are preferred solution shapes, not universal laws. Use them when the problem matches; do not force them where the semantics differ.

| ID | Pattern | Why it exists |
|---|---|---|
| RP-01 | **Append-only history/event stream + mutable projection** | Keep auditable history while exposing efficient current-state projections. |
| RP-02 | **Capability-first dispatch + executor/provider adapter** | Separate business-required capability from the runtime/provider that executes it. |
| RP-03 | **Version pin + hash/evidence binding** | Tie execution/evidence to immutable behavior/artifact versions. |
| RP-04 | **Semantic model interpreter + deterministic contract/gate/executor** | Use model intelligence to interpret; use deterministic contracts to authorize and enforce. |
| RP-05 | **Event/wake-up continuation instead of continuously running an LLM** | Durable work sleeps and resumes from events/timers rather than holding a model loop open. |
| RP-06 | **Provenance-tagged artifacts/results** | Every consequential artifact/result carries origin, scope, time/version and relevant evidence linkage. |
| RP-07 | **Brownfield adapter / progressive absorption** | Wrap and progressively move proven behavior into the common architecture rather than replacing it at once. |
| RP-08 | **Quiet provenance + useful human labels** | Expose provenance when it matters without drowning users in technical IDs/planes. |
| RP-09 | **Same semantic contract, different channel/surface renderer** | Web, messaging, voice or generated views may render differently while preserving one decision/artifact meaning. |

### Human involvement taxonomy

Human involvement is an operating taxonomy, not one undifferentiated HITL pattern:

- **Action / tool authorization:** may Gu execute this side effect?
- **Business decision:** what commercial/legal outcome does the human choose?
- **Human contribution / task:** what input or action must the person supply?
- **Exception review / intervention:** what should happen after failure or ambiguity?

Modes include **blocking HITL**, **human as executor**, and **human-on-the-loop**. Do not collapse them into one pending-approval abstraction.

## 6. Specialized canonical supplements

Not every important rule belongs in the cross-cutting core. The following are canonical within their scope:

| ID | Rule | Scope / interpretation |
|---|---|---|
| UX-01 | **Shared semantics, surface-specific rendering** | One decision/artifact meaning may render differently in web, messaging, voice or generated views. Conversation remains primary, and richer interfaces appear where the work requires them. |
| NET-01 | **Rights, routing, attribution and economics must be explicit** | Shared inventory, referrals, representation, commission, routing and cross-company economic rights cannot be improvised by the model. |
| SEC/DEV-01 | **Generated code is not execution authority** | Generation/import/publication of code or scripts does not grant runtime authority. Isolation, capability contracts, security review, verification and release controls govern execution. |
| DOC-01 | **Separate current, next/evolving and vision precisely** | Status precision prevents both overclaiming unproven capability and rebuilding foundations that already exist. |

### Durable-work root decision (ADR, not a universal principle)

Use explicit durable roots according to **truth kind**, not wall-clock duration or HITL presence: a **Case** owns what is commercially/operationally true about an entity/process now; a **Durable Task** owns progress/result of an independent job; a **Skill** is reusable procedure; a **Schedule** says when underlying work starts/repeats. This remains an accepted architecture decision with reevaluation triggers, not a timeless cross-domain principle.

## 7. Development Doctrine supplement

The full operating method lives in `docs/development/agentic-product-software-development-methodology.md`. The following principles are canonical for building Gu OS with humans + coding agents:

| ID | Development principle |
|---|---|
| DM-01 | Investigate and clarify before coding |
| DM-02 | PRD/Brief frames product intent; an approved Spec owns intended behavior for consequential change |
| DM-03 | Keep artifact responsibilities distinct and linked |
| DM-04 | Plan before non-trivial implementation |
| DM-05 | Concentrate human review at high-leverage boundaries |
| DM-06 | Build vertical, demonstrable slices |
| DM-07 | Define verification early; completion requires evidence, not agent confidence |
| DM-08 | Keep coding-agent context intentional |
| DM-09 | Preserve decisions/rejected alternatives and keep governing artifacts synchronized |
| DM-10 | Release consequential changes reversibly |
| DM-11 | AI-generated code remains inside engineering governance |
| DM-12 | Repair the owning artifact after verification failure |

Two useful operating patterns remain playbook guidance rather than universal principles: **Implement -> verify -> checkpoint -> continue**, and **parallelize only isolatable work with explicit contracts**.

## 8. Representative mechanism map

Mechanisms show how doctrine becomes real today or in accepted target design. They are intentionally replaceable implementation choices.

| Doctrine | Representative mechanisms / evidence surfaces |
|---|---|
| CP-02 / I-05 | `operational_cases`, `case_facts`, declared transactional SORs, Brain boundary, projections/views |
| CP-04 / CP-11 | Tool risk levels, policy/approval contracts, HITL interrupt/resume, human-executor work, operator supervision |
| CP-05 | Skills for judgment/procedure; tools/adapters/wrappers for stable execution; typed schemas; fixed parameterized queries/validators |
| CP-07 / I-06 | Evidence records, postconditions, readiness N0-N5, replay/simulation, tool/result audit |
| CP-08 / I-03 | Immutable published versions, definition/content hashes, version pins, fork/new-version lifecycle |
| CP-10 | Shared transition evaluator/dispatcher/guards/verifiers across production, Studio, simulation, replay and tests |
| CP-12 / I-01/I-02/I-11 | user/tenant authorization, RLS defense-in-depth, scope-filter-before-ranking, provenance, explicit grants |
| CP-14 / I-08 | Structural routing first, stage-aware deterministic matching, constrained classifier, clarification/fail-closed on ambiguity |
| CP-16 / I-10 | PR/tests/security gates, proposal -> eval -> approval -> canary -> measure -> rollback improvement lifecycle |
| CP-17 | Declared artifact/input dependency edges, hashes/staleness, selective invalidation and minimum repair |

## 9. Relationship to the original Ten Principles

The original ten Product & Architecture Principles remain foundational. v1.0 normalizes them into the doctrine taxonomy rather than discarding them.

| Original guardrail | v1.0 home | Interpretation |
|---|---|---|
| Original 1 - Start from responsibility and outcome | CP-01 + V-04 | Preserved and strengthened: downstream outcome is explicit; activity is diagnostic. |
| Original 2 - Define operational truth before the prompt | CP-02 | Preserved; broadened into explicit truth ownership boundaries. |
| Original 3 - Reuse the Gu OS operating core | CP-03 | Preserved. |
| Original 4 - Model power, bounded authority | CP-04 + CP-05 + CP-11 | Preserved and decomposed into authority, model-vs-deterministic boundary and human involvement. |
| Original 5 - UI as a surface of the same work context | UX-01 + RP-09 | Preserved as canonical UI/UX supplement rather than universal runtime principle. |
| Original 6 - Orchestrate replaceable capabilities; own differentiation | CP-15 | Preserved. |
| Original 7 - Design for outcomes, not activity | V-04 + CP-01 + CP-07 | Preserved across value, product decision rule and evidence requirement. |
| Original 8 - Compile relevant context, do not maximize tokens | CP-13 | Preserved. |
| Original 9 - Govern network rules explicitly | NET-01 + CP-12 + I-08 | Preserved as Network/Ecosystem doctrine. |
| Original 10 - Separate current from target precisely | DOC-01 | Preserved as documentation/planning doctrine. |

## 10. Decision checklist

For a new product/architecture initiative, ask in order:

1. **Responsibility/outcome:** what business responsibility becomes delegable and what outcome proves value?
2. **Truth:** which artifact/system owns each kind of operational, transactional and knowledge truth?
3. **Reuse:** which shared Gu OS primitives apply before inventing a new subsystem?
4. **Intelligence boundary:** what requires semantic/contextual judgment versus deterministic guarantees?
5. **Authority:** what may the model decide, what may it execute, and where must a human or policy gate intervene?
6. **Capability boundary:** what capability is required and should it be owned or orchestrated?
7. **Evidence:** how is success mechanically or operationally demonstrated?
8. **Context/provenance:** what is the minimum authoritative context and who is authorized to see/use it?
9. **Change/repair:** what becomes stale when inputs change; how is behavior versioned, tested and rolled back?
10. **Status:** what is implemented, evolving/next, tentative/open and vision?

## 11. Governance of the doctrine

- The Doctrine changes only through an explicit reviewed diff; implementation may not silently redefine it.
- If a principle becomes too local, move it to a supplement/ADR/pattern rather than keeping it universal.
- If a mechanism changes while the principle remains valid, update the mechanism map/architecture - not the principle wording merely to match the stack.
- A new invariant should be testable or enforceable in principle, even if the enforcement mechanism is not fully implemented yet.
- Conflicts between principles are resolved through explicit trade-offs in Specs/Architecture Analysis/ADRs, preserving the competing values rather than pretending the tension does not exist.
- Current product truth remains in the Product PRD; intended feature behavior in Specs; architecture decisions in ADRs; implemented reality in code/migrations/config; verification in tests/evals/readiness.

## 12. Known tensions the doctrine must preserve

Good Gu OS design does not eliminate these tensions; it makes them explicit and governed:

- model flexibility vs deterministic guarantees;
- autonomy vs human authority;
- bounded one-turn work vs durable responsibility;
- conversational simplicity vs explicit operational state;
- contextual/dynamic UI vs one coherent product experience;
- richer context vs context cost/noise;
- owned differentiation vs replaceable providers;
- event-driven responsiveness vs timers/polling where needed;
- reusable primitives vs over-generalization;
- fast brownfield evolution vs long-term architecture purity.

## Appendix A - Provenance and authority

Primary internal sources used to publish v1.0:

- `10 Principios de Arquitectura y Producto - v0.1` - foundational Product/Architecture guardrails.
- `Gu OS Principle Mining & Doctrine Candidate Registry v0.3` - evidence-rich mining, adjudication and lineage.
- `docs/manuals/agentic-principles-alignment.md` - repo mapping of model/Skill vs deterministic code/tool, harness responsibilities and guarded learning.
- `docs/skills-tools-architecture.md` - canonical Skill/tool/adapter boundary.
- `docs/manuals/ai-native-loops.md` - governed loop contract, autonomy earned by evidence and safe improvement lifecycle.
- `docs/manuals/gu-os-flexible-workflows-technical-plan.md` - accepted workflow principles including Case != Work, capability-first, evidence, shared runtime primitives and risk-justified HITL.
- `docs/brain/business-and-platform-brain-boundary.md` - operational responsibility vs Business Brain and governed platform-learning boundaries.
- `docs/manuals/knowledge-scope-and-ownership.md` - knowledge ownership/authorization/provenance semantics.
- `docs/manuals/gu-os-cross-channel-continuity-architecture.md` - conservative continuity, ambiguity and channel authority rules.
- `docs/manuals/adr/0001-durable-work-roots.md` - accepted durable-root taxonomy.
- `docs/product/PRD.md` (Product PRD v0.1.1 approved working copy) - product intent and product-level guardrails.
- `docs/development/agentic-product-software-development-methodology.md` - development lifecycle and artifact governance.

External frameworks/papers previously reviewed remain **reference lenses**, not sources of Gu OS authority. Where an external idea is useful, it is canonical only after being reconciled into the repo/Doctrine/ADR/Methodology.

## Appendix B - Status vocabulary

- **Canonical:** approved and governs recurring decisions in its scope.
- **Invariant:** non-negotiable boundary; implementation must fail/clarify rather than violate it.
- **Pattern:** preferred reusable shape where the problem matches.
- **ADR-only:** concrete accepted architecture choice with reevaluation trigger.
- **Mechanism:** current/target enforcement technique; replaceable.
- **Reference:** useful evidence/inspiration; not authoritative by itself.
- **Deprecated / Superseded:** retained for provenance but not active authority.
