# Gu OS Experience Architecture — Design System, Agentic UX & Adaptive Experience

> **Version:** v0.1  
> **Status:** APPROVED — canonical target architecture; implementation remains incremental  
> **Scope:** Cross-domain Gu OS Experience Architecture  
> **Related:** `docs/principles/gu-os-principles-and-design-doctrine.md` · `docs/manuals/gu-os-cross-channel-continuity-architecture.md` · `docs/talk-to-gu/vision.md` · `docs/product/initiatives/relationship-operations/specs/work-portfolio-supervisory-experience.md`  
> **Intended repo path:** `docs/manuals/gu-os-experience-architecture.md`

---

## 1. Purpose

Gu OS Experience Architecture defines how valid business meaning, human interaction and work products become understandable, actionable and adaptable across conversational, visual and future multimodal surfaces.

It is broader than a traditional Design System. It coordinates:

- Brand foundations;
- Design System;
- Agentic UX / Semantic Interaction;
- Adaptive and Generative Experience;
- identity, representation and disclosure;
- Contextual Views and Artifacts;
- personalization and reusable Experience Patterns;
- cross-surface continuity and attention delivery;
- Experience context resolution;
- Experience governance, accessibility, testing and evolution;
- integration of domain-owned UX semantics.

The central invariant is:

> **Experience Architecture governs representation and interaction expression; it does not own business truth, durable responsibility, planning or business authority.**

Domain Specs and accepted Facts define what is true. Cases and Case Supervisors own durable responsibility and determine useful work/interaction needs. Platform authority, Organization Policy and governed capabilities determine what may be done. Skills/models provide bounded procedure, judgment and synthesis. Experience Architecture determines how the resulting valid interaction becomes understandable and actionable for a human.

---

## 2. Core principles

1. **Governed does not mean predefined.** A Contextual View may be completely novel at runtime.
2. **Conversational-first does not mean text-only.** Conversation may invoke visual UI, Artifacts, documents, maps, tables, calculators, dashboards or other representations.
3. **Reuse, adapt and generate are all valid runtime strategies.** Gu should not invent novelty merely to appear generative.
4. **User direction is first-class.** Gu may author the experience, the human may direct it, or both may co-author it conversationally.
5. **Shared semantics, surface-specific rendering.** One Human Interaction may render differently across Web, Telegram, WhatsApp, Voice, Phone or future surfaces while preserving one semantic identity.
6. **Surface/channel, modality and representation capability are distinct dimensions.**
7. **Generated executable code is not execution authority.** Rich Artifacts remain capability-bounded and sandboxed.
8. **Generation, persistence, freshness, reuse and learning are independent concerns.**
9. **Personalization adapts valid expression; it does not create private forks of business truth or authority.**
10. **Learning modifies the artifact that owns the meaning being learned.** Brain, Policy, Skills, Facts, Experience and Preferences remain distinct authority classes.
11. **Experience quality includes truth, authority, evidence, comprehension, accessibility, trust calibration, reliability and useful outcomes—not only visual polish.**
12. **The architecture is cross-domain.** Relationship, Property, Demand, Transaction and Network/Ecosystem domains consume shared Experience capabilities while retaining domain-specific semantics.

---

## 3. Canonical terminology

### 3.1 Experience

**Experience** = the complete experience an actor perceives and uses while interacting with Gu in a given situation. It may combine conversation, voice, text, visual UI, Contextual Views, Artifacts, Human Interactions, notifications and cross-surface handoffs.

### 3.2 Contextual View

**Contextual View** = a dynamic representation constructed, reused or adapted for a specific situation. It is usually a composition of information representations, semantic Human Interactions and/or Work Products rather than a fixed screen.

### 3.3 Contextual View Instance

**Contextual View Instance** = a concrete realization of a Contextual View for a particular actor, audience, situation and moment.

### 3.4 Snapshot

**Snapshot** = a persisted historical representation of how a View/Artifact or situation appeared at a specific time. It preserves historical meaning and does not silently refresh to current truth.

### 3.5 Live View

**Live View** = a persistent lens whose purpose/configuration remains while its content may be recomputed against current truth and current viewer authorization.

### 3.6 Work Product

**Work Product** = a useful result produced by Gu, a human or both as a consequence of work, for example a comparison, report, document, analysis, dashboard or plan.

### 3.7 Artifact

**Artifact** = an identifiable Work Product or structured experience object with its own lifecycle, semantics and provenance. An Artifact may be ephemeral or persistent and may be inspectable, versionable, shareable, reusable or executable depending on its type.

> **Artifactness is about identity/lifecycle, not visual form or permanent storage.**

### 3.8 Turn Artifact

**Turn Artifact** = a bounded Artifact associated with a conversational turn/result, typically used for attribution, exact result-set continuation or cross-surface recovery and potentially subject to finite retention.

### 3.9 Live Artifact

**Live Artifact** = an Artifact whose content can be refreshed/reconstructed from current authorized data according to an explicit freshness contract.

### 3.10 Executable Artifact

**Executable Artifact** = an Artifact containing interactive/computational behavior within a governed sandbox/runtime. It does not receive ambient credentials or Gu OS authority merely because it is generated or rendered inside Gu OS.

### 3.11 Experience Preference

**Experience Preference** = a durable, generally soft and potentially context-conditioned tendency about how an actor prefers valid experiences to be expressed when appropriate.

### 3.12 Experience Pattern

**Experience Pattern** = a reusable and adaptable strategy/structure for representing or conducting a class of semantically similar experiences.

An Experience Pattern is not necessarily a rigid template. It guides generation and adaptation.

### 3.13 Experience Definition

**Experience Definition** = a governed, versioned specification formalizing a reusable Experience Pattern/configuration for an authoritative scope such as Organization or Platform.

Published versions are immutable; change creates a new version.

### 3.14 Human Interaction

**Human Interaction** = the semantic mechanism through which a human receives meaning or contributes, decides, authorizes, supplies evidence, performs work or intervenes. It is distinct from the Human Involvement taxonomy and from the surface that renders it.

### 3.15 Surface / Channel

**Surface / Channel** = where an experience is materialized or delivered, for example Web, Telegram, WhatsApp, Phone or a future mobile app.

### 3.16 Modality

**Modality** = how humans and Gu communicate or perceive, for example Voice, Text, Visual, Touch, Image or Document.

### 3.17 Representation Capability

**Representation Capability** = what a surface/runtime can express, for example Table, Map, Timeline, Contextual View, Artifact, Document, Chart or interactive control.

### 3.18 Mnemonic

```text
VIEW          → representation
ARTIFACT      → lifecycle / identifiable work object
PATTERN       → reuse
EXPERIENCE    → whole human interaction
WORK PRODUCT  → work value
```

---

## 4. Authority and ownership model

Each layer owns a different class of truth or authority.

| Question | Owning layer |
| --- | --- |
| What is true? | Domain Specs + accepted Facts / declared SORs |
| What durable responsibility exists? | Case / domain lifecycle |
| What work or interaction is useful now? | Case Supervisor + domain semantics + bounded Skill/model judgment |
| May Gu or a human do it? | Platform authority + Organization Policy + grants + governed capability contracts |
| How should Gu reason/perform? | Skills/models + governed capabilities |
| What Human Interaction is needed? | Domain/Supervisor intent interpreted through Agentic UX |
| How should it be represented? | Experience Architecture |
| How may the Organization customize it? | Organization Experience Profile |
| How may the user personalize it? | User Working Preferences |
| How should it adapt here? | Current situation + Surface/Modality/Representation capabilities |

### 4.1 Cross-layer governance rule

> **Brain, Organization Policy, Skills, Domain Specs, Experience and User Preferences may all contribute to an experience, but none is an alternative mechanism to redefine authority belonging to another layer.**

Examples:

- Brain may inform context but cannot silently become Organization Policy.
- A Skill may require assumptions/caveats but cannot decide durable brand identity.
- An Experience Pattern may include a `Send` interaction but cannot grant the actor send authority.
- User styling preferences cannot rewrite `Unknown` as a confirmed fact.

### 4.2 Domain UX integration

Domain UX semantics remain owned by Domain Specs. Experience Architecture provides the cross-domain semantic interaction language and expression system.

> **Domain Specs own business interaction semantics; Experience Architecture owns the governed language through which those semantics become understandable and actionable.**

This avoids creating a separate domain UI engine for each Gu OS operating domain.

---

## 5. Functional Experience system vs customization/inheritance

Two dimensions are orthogonal.

### 5.1 Functional classes

```text
GU OS EXPERIENCE ARCHITECTURE
│
├── Brand foundations
├── Design System
├── Agentic UX / Semantic Interaction System
├── Adaptive / Generative Experience
├── identity / representation / disclosure
├── cross-surface Experience
└── Domain UX integration contracts
```

### 5.2 Customization/inheritance levels

```text
PLATFORM EXPERIENCE SYSTEM
        ↓ constrains
ORGANIZATION EXPERIENCE PROFILE
        ↓ defaults / constrains
USER WORKING PREFERENCES
        ↓ personalize where allowed
SITUATIONAL / SURFACE CONTEXT
        ↓ adapts
EFFECTIVE EXPERIENCE
```

Platform/Organization/User/Situation describes **who may adapt/configure** the Experience. It is not the same hierarchy as Brand/Design/Agentic UX/Domain UX.

---

## 6. Identity, representation and brand

### 6.1 Canonical identity hierarchy

```text
UNGGA
company / platform provider
   │
   └── GU OS
       enabling operating system / product platform
           │
           └── AI REPRESENTATIVE ROLE
               ├── Gu   — default AI coworker / representative
               └── Lía / Vera / other configured identity
```

- **Ungga** is the company/platform-provider identity.
- **Gu OS** is the enabling system.
- **Gu** is the default AI coworker / AI Representative Identity.
- An Organization may configure another presented identity occupying the same representative role.

A configured representative such as **Lía** is not a child product “by Gu.” Where corporate attribution is appropriate, `by Ungga` represents provider attribution; `Powered by Gu OS` expresses enabling-system attribution.

### 6.2 Brand layers

Keep distinct:

- Ungga platform/corporate brand;
- Gu OS product/system attribution;
- Organization brand;
- AI Representative identity;
- AI Representative visual identity/avatar;
- user presentation preferences.

Changing `Gu → Lía` or the Gu avatar does not replace Ungga or alter Gu OS provenance.

### 6.3 Representation Context

Conceptually resolve:

- platform provider;
- underlying system/runtime;
- current actor;
- intended audience;
- actual executor/generator;
- presented AI identity;
- represented Organization;
- represented human, when applicable;
- Organization brand;
- Representative visual identity;
- channel/sender identity;
- communication identity;
- effective disclosure;
- platform provenance;
- Experience/identity versions.

These dimensions may coincide but must not be collapsed into a generic `speaker` field.

### 6.4 Branding vs provenance

> **Platform branding is what the audience visibly sees; platform provenance is the attributable origin/system context of the interaction.**

Brand visibility may vary according to surface, audience, Experience mode and commercial entitlement. Provenance remains attributable.

White-label changes expression; it does not erase business authority, audit history or canonical truth.

### 6.5 AI Representative vs delegated human representation

Gu may communicate on behalf of an authorized human without becoming or falsely claiming to be that human.

> **AI Representative Mode ≠ delegated human representation.**

Materially deceptive human impersonation is not an allowed Experience mode.

### 6.6 Disclosure

Disclosure should be governed and proportional to audience, surface, consequence, representation mode, Organization requirements and applicable requirements. It need not repeat maximal AI disclosure every turn, but it cannot be designed to materially deceive.

### 6.7 History and versioning

Historical representation remains attributable to the identity, Experience and Policy versions effective at the time. Later branding/representative changes do not silently rewrite historical messages, decisions, Snapshots or provenance.

---

## 7. Semantic Interaction Language

Gu OS should define a cross-domain Semantic Interaction Language independent of visual implementation.

### 7.1 Semantic primitive vs renderer

```text
SEMANTIC INTERACTION
        ↓
SURFACE-SPECIFIC REPRESENTATION
        ↓
UI / VOICE / ARTIFACT COMPONENTS
```

For example, `ApprovalRequest` means a protected decision requires explicit human authorization under current context. It does **not** mean “render a modal with Yes/No buttons.”

### 7.2 Representative families

The language may include families such as:

**Inform / explain**
- SituationSummary
- Explanation
- ProgressUpdate
- OutcomeUpdate
- Warning
- ExceptionNotice

**Evidence / truth inspection**
- EvidenceView
- SourceAttribution
- ConflictView
- UnknownState
- ExternalEffectStatus
- Timeline

**Recommendation / judgment**
- Recommendation
- OptionComparison
- ScenarioAnalysis
- RiskAssessment

**Human contribution**
- InformationRequest
- JudgmentRequest
- ArtifactRequest
- EvidenceRequest
- HumanWorkRequest

**Decision / authorization**
- DecisionRequest
- ApprovalRequest
- ChoiceRequest
- ConfirmationRequest

**Responsibility / coordination**
- AssignmentRequest
- DelegationInteraction
- ClaimInteraction
- TakeoverInteraction
- ReturnToGuInteraction

**Work / responsibility state**
- WorkStatus
- WorkResult
- CommitmentView
- WaitingState
- WatchingState

**Artifact interaction**
- ArtifactView
- ArtifactEdit
- ArtifactCompare
- ArtifactShare
- ArtifactSave
- ArtifactPromote

This is not a frozen exhaustive catalog.

### 7.3 Shared primitives, domain-specific semantics

Create a new semantic primitive because the **interaction meaning differs**, not merely because the domain noun differs.

A Visit claim may render using an EvidenceView specialized by S3 semantics; Gu OS need not invent `VisitEvidenceCard` as a universal semantic primitive.

### 7.4 Human Involvement seam

Human Involvement answers what human contribution is needed and how the human participates operationally.

Human Interaction answers through what semantic interaction that contribution is obtained or expressed.

```text
WHAT?
Action authorization / Business decision / Human contribution / Exception review

HOW?
HITL / Human as executor / Human-on-the-loop

EXPERIENCE SEMANTIC INTERACTION
ApprovalRequest / DecisionRequest / HumanWorkRequest / EvidenceRequest / ...
```

### 7.5 Needs Attention correction

> **Needs Attention is not a Human Interaction primitive.**

It is a supervisory projection indicating that one or more underlying Human Interactions are materially relevant now.

### 7.6 Semantic invariants survive rendering

Examples:

- Recommendation ≠ Fact ≠ Approval.
- Unknown/conflict semantics must survive rendering.
- Approval must preserve what is being approved and relevant consequence/context.
- Uncertain external effect cannot be rendered as confirmed success.
- Visual hierarchy cannot materially contradict semantic/consequence hierarchy.
- Progressive disclosure may hide detail but not remove decision-sufficient context.

### 7.7 Explainability

Explainability should expose relevant facts, evidence, provenance and uncertainty—not private chain-of-thought.

---

## 8. Adaptive and Generative Experience

### 8.1 Experience resolution strategies

At runtime Gu chooses among:

- **Reuse** — an existing authorized Live View/Artifact/Pattern is already the best fit.
- **Adapt** — an existing Pattern/View is useful but needs contextual changes.
- **Generate** — construct a novel Contextual View/Artifact because no existing representation sufficiently serves the situation.

Selection is based on semantic fit, audience, authority, current business truth, disclosure, Organization Experience, user intent/preferences, surface capabilities and entitlement—not merely visual similarity.

### 8.2 Governed does not mean predefined

Gu may dynamically construct novel Contextual Views at runtime, choosing:

- content;
- hierarchy;
- grouping;
- comparison dimensions;
- progressive disclosure;
- visualization type;
- map/table/cards/timeline choice;
- artifacts to include;
- contextual actions.

The resulting View does not need to pre-exist as a screen or template.

### 8.3 User-directed, Gu-directed and collaborative authorship

Experience authoring may be:

- **Gu-directed:** user asks “show me what is happening” and Gu chooses the representation.
- **User-directed / Gu-authored:** user specifies “give me a two-column comparison table.”
- **Collaborative:** user specifies parts and Gu completes/adapts the rest.
- **User-specified / Gu-executed:** user specifies nearly exact structure and Gu materializes it within bounds.

Users may direct content, representation type, composition, styling, interactivity and persistence/reuse intent in natural language.

Explicit current representation intent normally outranks Gu’s stylistic preference, but not semantic truth, authority, accessibility, safety, Organization requirements or Platform invariants.

### 8.4 Natural-language iteration is first-class

A user should be able to say:

- “put properties in columns”;
- “remove amenities”;
- “show over-budget values in red”;
- “add distance to the office”;
- “save this”;
- “use this format again.”

Gu updates the current Experience without requiring the human to operate a dashboard builder.

### 8.5 Trusted Semantic Experience Runtime

For Experience directly tied to business truth, Human Interactions and authority, the default target is a trusted semantic runtime.

Gu has broad freedom over composition, while semantic contracts and capability/authorization checks remain governed.

> **Governance constrains meaning and capability more strongly than layout.**

### 8.6 Sandboxed Generative Artifact Runtime

Gu OS should also support richer generated Artifacts such as:

- calculators;
- simulators;
- dashboards;
- scenario explorers;
- bespoke visualizations;
- interactive reports;
- specialized mini-tools.

These may use generated HTML/CSS/JavaScript/React or other supported executable representations in a sandbox.

Generated executable code is untrusted with respect to Gu OS authority.

### 8.7 No ambient authority

Executable Artifacts receive bounded host capabilities—not raw service credentials, OAuth tokens or implicit viewer authority.

```text
Artifact
  ↓ declared semantic capability
Host / capability bridge
  ↓ current actor authorization
Policy + current-state validation
  ↓
Governed effect
```

Rendering an Artifact inside an authorized Gu OS surface does not give its generated code the viewer’s ambient permissions.

### 8.8 Artifact computation is not canonical truth

Calculations, recommendations or extracted candidate facts inside an Artifact do not automatically become accepted business Facts. They may produce candidate claims/evidence for the owning domain mechanism.

### 8.9 Rich generation is utility-driven

Do not generate complex dashboards when a one-line answer serves the user better. Representational complexity should be proportional to the user’s objective, cognitive load, latency and cost.

---

## 9. Artifact lifecycle semantics

Artifact existence and delivery states are distinct.

Conceptually preserve:

```text
GENERATED
≠ PERSISTED
≠ RENDERED
≠ PRESENTED
≠ DELIVERED
≠ SEEN
```

An Artifact may exist without having been rendered or delivered. Gu may say “I prepared the comparison” when it exists; it may only claim “I sent it to Telegram” after appropriate delivery evidence.

This generalizes the Talk to Gu rule that Artifact content and delivery receipt remain conceptually distinct.

### 9.1 Ephemeral Artifacts

An Artifact may begin as session-scoped/ephemeral. Persistence is a later lifecycle choice, not a prerequisite for Artifact identity.

### 9.2 Contextual View may contain Artifact

A Contextual View can compose:

```text
SituationSummary
+ EvidenceView
+ Recommendation
+ [Executable ROI Artifact]
+ DecisionRequest
```

Artifact and View are orthogonal roles, not mutually exclusive categories.

---

## 10. Persistence, reuse and Experience learning

### 10.1 Distinct intents

A generated experience can evolve in different ways:

```text
Generated View / Artifact
   ├── preserve this moment → Snapshot
   ├── keep this live object → Live View / Live Artifact
   └── use this way again → Experience Pattern
```

Saving a current state, keeping a live object and teaching Gu a reusable representation strategy are different intents.

### 10.2 Persistence scopes

- Instance/local;
- User;
- Organization;
- Platform.

Clear natural-language intent may establish persistence. Ambiguous feedback defaults to the narrower/local scope.

> **Ambiguous presentation feedback should not silently create durable learning.**

### 10.3 Preferences vs Patterns vs Definitions

- **Preference** = soft tendency, often contextual.
- **Pattern** = reusable adaptive strategy/structure.
- **Definition** = governed/versioned formalization for an authoritative scope.

Example:

```text
Preference:
prefer compact internal tables

Pattern:
Opportunity Review
Situation → Material Progress → Comparison → Recommendation

Published Organization Definition:
Opportunity Review v3
required / preferred / optional / prohibited semantics
```

### 10.4 Required / preferred / optional / prohibited

Experience Definitions/Patterns may distinguish:

- **Required** — must survive adaptation;
- **Preferred** — preserve when useful;
- **Optional** — contextually included;
- **Prohibited** — must not appear for that audience/purpose.

Patterns guide semantic/compositional behavior rather than necessarily prescribing pixel coordinates.

### 10.5 Learning and overlearning

Explicit statements such as “always do it this way for me” may create durable user-level preferences/patterns within authority.

Repeated implicit behavior may influence soft adaptation or lead Gu to suggest formalization, but it does not silently become Organization or Platform standard.

> **Learning ≠ silent publication.**

### 10.6 Learning updates the owning artifact

Examples:

- presentation preference → User/Organization Experience;
- organization approval rule → Organization Policy;
- Visit fact → domain Fact/evidence;
- reusable reasoning procedure → Skill;
- general business knowledge → Brain.

Experience configuration should not hide inside generic Brain entries when Experience is the proper owner.

### 10.7 Promotion

Reuse, sharing and promotion are distinct.

```text
Personal Pattern
  ↓ propose
Organization Pattern / Definition
  ↓ product insight / governance
Candidate Platform Pattern
```

Organization publication requires appropriate Organization authority. Platform publication requires Ungga/platform authority.

Promotion generalizes reusable behavior; it must not copy instance-specific customer data into the Pattern by default.

### 10.8 Versioning

Published Experience Definition versions are immutable. Changes create new versions. Historical Snapshots do not silently re-render under newer definitions.

A Live View/Artifact may intentionally follow the latest compatible Pattern/Definition, pin a version or fork, according to an explicit lifecycle contract.

---

## 11. Cross-surface Experience, attention and continuity

### 11.1 Attention semantics vs delivery

Business/domain supervision determines whether human attention is warranted and why. Experience Architecture determines how, when and where that need is expressed.

> **Needs Attention ≠ Notification.**

A Needs Attention item may be surfaced in Portfolio, a digest, Web, Telegram, mobile push or another surface. A Notification may also communicate a status/outcome without requiring intervention.

### 11.2 Notification semantics

Target semantics:

> **Notification = a delivery expression that brings an underlying event, result or Human Interaction to an actor’s awareness.**

Current brownfield structures such as `internal_user_notifications` may currently combine decision persistence and delivery/discovery responsibilities. Technical Design must not infer final target semantics from current table names.

### 11.3 Distinct delivery concepts

- ambient availability;
- status/outcome update;
- attention request;
- reminder/follow-up;
- escalation.

Escalation may change visibility, routing or intensity; it does not widen authority.

### 11.4 Delivered / Seen / Acknowledged / Resolved

These remain distinct. Snooze changes delivery/presentation state unless the user statement also changes a real business commitment.

### 11.5 Dedupe / coalescing / digests

Raw runtime events should not mechanically generate notifications. Gu should surface meaningful human-relevant change, deduplicate repeated delivery attempts and coalesce where obligations remain semantically distinct.

### 11.6 Surface/channel vs modality

Surface/channel, modality and representation capabilities must not be conflated.

Examples:

```text
Web
├── Voice
├── Text
├── Visual UI
├── Contextual Views
├── Artifacts
└── governed actions
```

Voice as a modality does not itself display a table, but a voice interaction may coexist with visual output on a multimodal surface or orchestrate a context-preserving handoff to another authorized visual surface.

### 11.7 Companion-surface handoff

When the current surface cannot adequately express a useful representation, Gu may create or resolve the required Contextual View/Artifact on an authorized companion surface.

```text
Phone / Voice
   ↓
"This is easier to see visually."
   ↓
Web / Telegram / WhatsApp / future mobile
```

The interaction preserves current Case/context, Human Interaction identity, Artifact identity, authority and Representation Context.

### 11.8 No universal conversation object required

> **Continuous Experience does not require a universal durable conversation identity.**

Continuity may be reconstructed from stronger semantic identities such as:

- Case;
- Human Interaction/pending decision;
- Artifact/Turn Artifact;
- Turn;
- actor;
- current business context;
- channel bindings.

This is consistent with current cross-channel architecture, which deliberately defers a universal `conversation_id`.

### 11.9 Conversation continuity ≠ Case continuity

Chat/session history is not durable business truth. A Case may survive many sessions/surfaces, and a conversational session may reference multiple Cases.

### 11.10 Stale delivery revalidates current truth

A notification may be historically valid but no longer actionable. Opening/acting on it always re-resolves current canonical state and current authorization.

### 11.11 Internal vs external engagement

Internal supervisory delivery and prospect/external engagement share Experience capabilities such as identity, surface adaptation and continuity, but retain different business/authority semantics. Prospect outreach is governed external communication, not merely another internal notification channel.

---

## 12. Experience Context Compiler

### 12.1 Purpose

The **Experience Context Compiler** is a conceptual architectural responsibility that resolves the valid, applicable and relevant context for the current Experience. It is not necessarily one runtime service.

```text
CURRENT BUSINESS SITUATION
+
Domain semantics / accepted Facts
+
Current actor / authority
+
Organization Policy
+
Platform Experience
+
Organization Experience
+
AI Representative / Representation Context
+
Applicable Experience Definitions / Patterns
+
Current User Experience Intent
+
User Working Preferences
+
Relevant Brain context
+
Skill / Human Interaction requirements
+
Surface / Channel
+
Available Modalities
+
Representation Capabilities
+
Accessibility / localization / freshness
        ↓
EFFECTIVE EXPERIENCE CONTEXT
```

### 12.2 Not prompt concatenation

Compilation is structured resolution, not a mega-prompt that asks the model to reconcile competing instructions informally.

Where possible, authorization and capability filtering should happen structurally before model composition.

> **The safest context is often capability-shaped, not instruction-shaped.**

Examples:

- unauthorized fields are absent from the authorized projection;
- unavailable actions are absent from the capability set;
- invalid Patterns are not candidates;
- entitlements are resolved before selecting an unavailable runtime.

### 12.3 Authority precedence

Cross-layer precedence remains:

1. Platform hard invariants;
2. canonical Domain semantics;
3. published Organization Policy;
4. governed capability/action contract;
5. published Platform + Organization Experience;
6. Skill/model procedure;
7. relevant Brain context;
8. authorized User preferences;
9. situational/surface adaptation.

This is **authority precedence**, not conversational relevance or prompt-order precedence.

### 12.4 Applicability before precedence

Before resolving conflicts, determine whether a Policy/Pattern/Preference applies to the current:

- Organization;
- user/role;
- audience;
- domain/Case/entity;
- interaction/purpose;
- surface/modality;
- consequence;
- language/locale;
- representation mode.

Semantic similarity is never an authorization mechanism.

### 12.5 Experience-specific constraint classes

Within Experience, distinguish:

- **Hard constraints** — cannot be violated;
- **Required configuration** — authoritative Experience semantics;
- **Soft defaults/preferences** — guide but may adapt;
- **Current explicit user intent** — strong local direction where allowed;
- **Contextual model choices** — fill remaining design space.

Soft conflicts may be harmonized by model judgment. Hard authority conflicts are structurally resolved.

### 12.6 Current actor vs intended audience

The current viewer/author and intended audience are distinct.

Example: an internal advisor authors a prospect-facing comparison. The authoring controls may use internal context while the final Artifact must compile against prospect-facing audience rules.

Conceptually support `preview as audience` for safe authoring.

### 12.7 Freshness

Live Experiences must not imply current truth without a credible freshness mechanism appropriate to each claim/source. Freshness may be claim-specific; not every source needs true real-time updates.

Current canonical state outranks persisted Live View UI state.

Snapshots are the deliberate historical exception.

### 12.8 Failure behavior

- invalid soft Preference → fall back to Organization/Platform default;
- incompatible Pattern → use alternative/generate safely;
- invalid AI identity → governed Gu fallback;
- authority uncertainty for consequential action → fail closed;
- missing optional Brain context → continue if valid;
- missing required domain truth → express Unknown/request evidence, never fabricate.

---

## 13. Organization Experience Profile

Conceptually includes:

### 13.1 Visual Identity

- Organization logo/brand assets;
- palette/tokens within Platform bounds;
- typography/layout tendencies where allowed;
- approved imagery/assets.

### 13.2 AI Representative Identity

- presented name;
- avatar/visual persona;
- optional voice persona;
- representation mode;
- identity assets.

### 13.3 Communication Identity

- tone/formality;
- terminology;
- language defaults;
- communication style tendencies;
- greetings/sign-offs where appropriate.

### 13.4 Expression Assets / Patterns

- approved documents/templates;
- Experience Patterns/Definitions;
- reusable views;
- presentation assets.

Organization Experience changes expression, not business truth or authority.

---

## 14. Experience entitlement

Experience capability and commercial entitlement are distinct.

Gu OS may technically support:

- custom representative identity;
- deeper branding;
- custom voice;
- Organization Patterns;
- executable Artifact runtime;

without every Organization being entitled to every capability.

Commercial packaging must not be hardcoded as the semantic meaning of the capability itself.

---

## 15. Experience governance, quality and evals

### 15.1 Quality dimensions

Experience quality includes:

- semantic correctness;
- authority correctness;
- evidence/provenance integrity;
- interaction correctness;
- comprehension/usability;
- accessibility;
- representation quality;
- cross-surface continuity;
- cognitive load/efficiency;
- trust calibration;
- useful outcome;
- technical reliability;
- latency/cost proportionality.

No single UX score should own release truth.

### 15.2 Hard vs soft evals

**Hard/invariant examples:**

- unauthorized action exposed;
- cross-tenant data leakage;
- Unknown represented as Fact;
- required approval semantics absent;
- prohibited data exposed;
- materially deceptive completion state.

**Quality examples:**

- clarity;
- information hierarchy;
- appropriate visualization;
- concision;
- preference fit;
- cognitive load.

Hard failures may block. Quality scores are contextual.

### 15.3 Evaluation methods

Use complementary mechanisms:

- deterministic validation for schemas, authorization/capabilities and mechanically testable invariants;
- model-based evals for contextual clarity, appropriateness, hierarchy and decision sufficiency;
- human review for novel, high-scope/high-consequence or subtle trust/design changes.

No monolithic AI UX judge should be sole release authority.

### 15.4 Runtime validation vs offline eval

Runtime validation protects each concrete interaction efficiently.

Offline scenario suites evaluate the Experience System across representative/edge/adversarial cases.

### 15.5 Scenario coverage

Include:

- empty/partial data;
- Unknown/conflicting evidence;
- stale data;
- unauthorized viewers;
- changed authority;
- mobile/narrow surfaces;
- voice-started multimodal interaction;
- cross-surface handoff;
- large entity sets;
- long content;
- localization;
- accessibility requirements;
- renderer/artifact/delivery failure.

### 15.6 Accessibility

Accessibility is a Platform Experience constraint, not late-stage QA.

Examples include:

- do not communicate only through color;
- meaningful semantic structure/labels;
- sufficient contrast;
- appropriate keyboard/access path;
- reduced-motion support where relevant;
- semantic alternatives for material visualizations.

Organization branding and user styling remain inside these bounds.

### 15.7 Trust calibration

Gu must not present more certainty, autonomy, authority or completion than evidence supports.

Examples:

- provider acceptance ≠ delivery/read;
- recommendation from incomplete data should be qualified;
- blocked Gu work should not appear “in progress” without explanation.

### 15.8 Executable Artifact evals

Require security/runtime, functional and semantic evaluation appropriate to generated untrusted code.

Persistent executable Artifacts should preserve version/provenance/capability attribution sufficient to understand material computation changes.

### 15.9 Evolution governance proportional to scope

Scope amplifies risk:

```text
one Contextual View
< User Pattern
< Organization Definition
< Platform semantic primitive/runtime capability
```

Instance-level adaptation may remain highly dynamic. Organization and Platform promotion require broader validation, versioning, rollout and rollback.

### 15.10 AI-assisted Experience evolution

Gu may detect that existing grammar is insufficient and propose/prototype:

- new semantic primitives;
- new visual capabilities;
- new composition patterns.

Promotion to Platform capability follows sandbox/tests/evals/accessibility/security/semantic review and versioned registration.

> **Production Experience grammar does not silently self-modify from runtime model behavior.**

### 15.11 Metrics

Prefer:

- required human needs surfaced appropriately;
- interaction resolution;
- comprehension/error/confusion;
- unnecessary interruption avoided;
- semantic fallback success;
- latency/cost;
- reuse value;
- meaningful task/outcome support.

Do not optimize raw notification count, click count or dashboard engagement as primary success.

---

## 16. Brownfield alignment and current seams

This document is target architecture and must distinguish implemented/current seams from future capabilities.

### 16.1 Current verified supporting directions

Existing canonical doctrine already supports:

- model power with bounded authority;
- model judgment + deterministic guarantees;
- evidence over agent assertion;
- versioned governed behavior;
- generated code not gaining execution authority;
- same semantic contract with different channel/surface renderer;
- context compilation rather than maximal context;
- surface changes not widening authority.

Current cross-channel architecture already supports shared business state across Web/Telegram while explicitly rejecting a premature universal conversation object.

Talk to Gu vision/plan already defines multimodal voice + visual experience, structured visual Artifacts and confirmed delivery semantics.

### 16.2 Brownfield terms that must not dictate target semantics

Examples:

- current `channel='voice'` implementation plan does not mean Voice and Web are the same conceptual dimension;
- `internal_user_notifications` may currently carry more than target Notification delivery semantics;
- current Web/Telegram renderers do not define the final Semantic Interaction contract;
- `tool_calls` / `structured_payload` may serve as brownfield seams but are not automatically the final Experience payload schema.

### 16.3 Target / not yet assumed implemented

The following are target architectural concepts unless separately verified in code:

- Experience Context Compiler;
- Semantic Interaction Language as first-class platform contract;
- Contextual View generation/runtime;
- Sandboxed Generative Artifact Runtime;
- Experience Preferences/Patterns/Definitions and promotion lifecycle;
- full cross-surface companion handoff;
- Experience-specific eval framework.

---

## 17. Technical Design boundaries

This architecture intentionally does not choose exact:

- database tables/schemas;
- payload JSON schemas;
- React/component APIs;
- Artifact sandbox technology;
- capability bridge protocol;
- Experience renderer service decomposition;
- Pattern retrieval/matching algorithm;
- caching/incremental compilation;
- notification/presence provider;
- exact access-control implementation;
- telemetry storage;
- model/provider selection for Experience composition;
- CI/eval framework implementation.

Those mechanics belong in Technical Plans and vertical slices grounded in this architecture and the owning domain Specs.

---

## 18. Relationship Operations consumption boundary

Relationship Operations consumes this architecture rather than creating parallel Experience infrastructure.

```text
GU OS EXPERIENCE ARCHITECTURE
cross-domain
    │
    ├── Semantic Interaction Language
    ├── Contextual Views / Artifacts
    ├── identity / representation
    ├── adaptive/generative composition
    ├── persistence / Patterns
    ├── cross-surface Experience
    └── Experience Context resolution
             ↑ consumed by
RELATIONSHIP OPERATIONS
    ├── S1 lifecycle semantics
    ├── S2 situational progression / human authority
    ├── S3 Visit truth/evidence
    └── S4 Work Portfolio / Needs Attention
```

Relationship Operations may define domain-specific meaning, but should not create lead-specific notification engines, Artifact runtimes, Pattern engines or approval UI semantics where the cross-domain Experience system owns the shared meaning.

---

## 19. High-confidence invariants

1. Experience configuration cannot redefine business truth or mint authority.
2. Governed does not mean predefined; runtime Contextual Views may be novel.
3. UI components, Artifacts and Experience Patterns are not workflows or authority holders.
4. Recommendation ≠ Fact ≠ Approval.
5. Unknown/conflict/provenance semantics survive surface changes.
6. Needs Attention is a supervisory projection, not a Human Interaction primitive.
7. Surface/channel, modality and representation capability remain distinct.
8. Changing surface does not widen authority or data scope.
9. Continuous Experience does not require a universal conversation entity.
10. Generated executable code receives no ambient Gu OS authority or credentials.
11. Artifact computation/extraction does not automatically become canonical Fact.
12. Generated/Persisted/Rendered/Presented/Delivered/Seen are distinct Artifact/delivery states.
13. Clear user representation intent is first-class but remains inside higher bounds.
14. Local edits do not silently become durable preferences/Patterns.
15. Learning does not silently become Organization/Platform publication.
16. Published Experience Definition versions are immutable.
17. Sharing ≠ reuse ≠ promotion.
18. Live shared experiences re-resolve current viewer authorization.
19. Snapshots preserve historical meaning.
20. Current canonical truth outranks stale persisted Live UI state.
21. Effective Experience resolution is structured authority/applicability resolution, not prompt-order conflict resolution.
22. Semantic similarity is never authorization.
23. Capability-shaped context is preferred over ambient authority plus prompt prohibitions.
24. Accessibility is a Platform Experience constraint.
25. Experience quality includes truth/authority/evidence and not only visual polish.
26. Production Experience grammar does not silently self-modify at runtime.
27. Exact mechanisms remain Technical Design and may evolve without changing these semantics.

---

## 20. Development and implementation discipline

For consequential Experience work use the repository methodology:

```text
Spec
→ Plan
→ Tasks / Vertical Slices
→ Implement
→ Tests / Evals
→ Review / Release
→ Observe / Learn
→ Repair the owning artifact
```

The Technical Plan should read this architecture together with Domain Specs, ADRs, current code/migrations, Talk to Gu and cross-channel architecture. It must distinguish CURRENT / REPO-VERIFIED, TARGET-APPROVED and OPEN TECHNICAL DESIGN rather than silently treating target concepts as implemented.
