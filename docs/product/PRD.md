# Gu / Gu OS Product Requirements Document

> **Version:** v0.1.1  
> **Status:** Approved — canonical product intent  
> **Product:** Gu / Gu OS  
> **Category:** The AI Operating System for Real Estate  
> **Purpose:** Canonical owner of product intent. This document does not replace architecture manuals, ADRs, technical plans, Feature / Business Specs, roadmaps, or verification evidence.

## 1. Product thesis

Ungga is building **The AI Operating System for Real Estate**, with **Gu** as the AI coworker real-estate professionals work with.

The objective is not to build more software for users to operate. It is to make an increasing share of real-estate work delegable to Gu with **control, context, continuity and verifiable outcomes**.

The intended end-state is not “better software with AI features.” It is an operating environment in which an increasing share of economically meaningful real-estate work can be understood, coordinated and executed by Gu, while humans remain responsible for strategy, judgment, relationships, negotiation, physical-world interactions and accountable decisions.

**Product philosophy:** *Humans lead. Gu gets work done.*

**Direction in one sentence:** **One Gu. One operating system. An increasing share of real-estate operations delegable to AI — without losing human control, relationship or accountability.**

**Commercial architecture:** `Ungga → Gu → Gu OS`.

- **Gu** — who the user works with.
- **Gu OS** — what enables Gu to understand, coordinate and execute increasingly complex business work.
- **External world** — people, inventory, systems, channels and specialized services Gu OS can mobilize.

This is not a branding pivot from a lead product to an “OS.” Doing real work with Gu exposed the operating infrastructure required for Gu to assume more responsibility.

## 2. Problem

### 2.1 Core business problem

Brokerages struggle to generate enough qualified opportunities predictably and consistently convert enough of them into visits and transactions.

A useful operating description is: **the person is still the operating system**.

The problem is not primarily lack of software. Real-estate companies already use CRMs, portals, WhatsApp, calendars, spreadsheets, documents and specialized providers. The persistent problem is that people still have to connect those pieces, remember what must happen, decide what comes next and ensure that work actually happens.

For many small and medium brokerages, the first pain begins even earlier: qualified demand can be difficult and expensive to generate. Once opportunities arrive, value leaks because response, matching, follow-up, coordination and progression remain highly dependent on human availability, memory and discipline.

### 2.2 Structural factors

- Demand originates across portals, paid social, organic activity, referrals, offline sources and partner channels.
- Acquisition and conversion are often managed separately, limiting downstream attribution.
- Work and data are fragmented across conversations, CRM, inventory, calendars, documents, portals and providers.
- Digital demand is asynchronous while human availability is finite.
- Existing software digitizes pieces of work but still requires substantial human operation and coordination.

### 2.3 Business and human impact

- Lost commissions and opportunities.
- Wasted acquisition spend when demand is mishandled or optimized only to upstream metrics.
- Slow response and inconsistent follow-up.
- Growth constrained by human attention and coordination capacity.
- Management overhead and limited operational visibility.
- Less human time for relationship, visits, negotiation and strategic judgment.

## 3. Target users and ICP

Primary users are real-estate brokerages and developers whose work includes enough operational volume, opportunity value or workflow complexity for delegated AI work to create measurable economic value.

### 3.1 Primary user roles

- Brokerage owner / principal.
- Real-estate advisor / broker.
- Sales or operations coordinator.
- Property/transaction operations staff.
- Teams responsible for lead acquisition, conversion, inventory and transaction progression.

### 3.2 ICP dimensions

The ICP should not be defined only by company size or monthly lead count. Product fit depends on at least:

`operational intensity × economic value per opportunity × repeatability of the work × willingness to delegate`

Lead volume matters because it creates workload and measurable opportunity preservation. Transaction economics matter because rent and sale commissions can support very different spend. Productization also matters: Gu OS should be repeatedly deployable without turning every customer into bespoke consulting.

## 4. Current wedge and earned insight

### 4.1 Gu today

Gu entered through a concrete workflow close to brokerage revenue: moving a buyer or renter from initial inquiry toward a property visit.

Gu already performs meaningful work around:
- engaging prospects;
- understanding requirements;
- profiling budget, zones, timing and constraints;
- searching/matching brokerage inventory;
- extending search to Shared Inventory when permitted;
- following up;
- coordinating appointments and visit progression.

This wedge is primarily **conversion-centric**: it begins after demand arrives.

The current follow-up model remains limited and partly pre-programmed. The next product leap is to replace fixed follow-up rules with situational operation: understand each opportunity’s state, detect events, decide when to act, choose the appropriate work and involve the professional when needed.

### 4.2 Earned insight

A bounded conversational interaction can be useful with chat + tools + data. Durable business responsibility is different.

When the user says:
- “take care of this opportunity until we get the visit,” or
- “capture this property and leave it published,”

the work survives the conversation. It can span days/weeks, systems, humans, waits, approvals, retries, changed facts and evidence requirements.

Therefore:

**The conversation can guide the work. Gu OS holds the durable truth about the work.**

This is the transition from the human acting as middleware across software toward an AI-native operating model in which the human defines intent, objectives and limits; Gu understands context and advances work within policy; and humans intervene where relationship, judgment or authority matter.

## 5. Product model

Gu OS is a **vertical operating environment**, not primarily a generic agent-building platform and not “another app.”

At an executive product level, Gu OS should fulfill six responsibilities:

1. **Maintain persistent operational state** for important work.
2. **Understand business context and company-specific knowledge** relevant to the work.
3. **Decide and coordinate what should happen next** within policies and authority boundaries.
4. **Execute through Skills, tools, systems and providers.**
5. **Involve humans when judgment, relationship or authority matter.**
6. **Close the loop with evidence and real outcomes**, not merely activity.

These responsibilities are supported by more detailed technical capabilities such as operating truth, execution, governance, intelligence, continuity, outcomes, network reach and interfaces. Those technical decompositions belong in the architecture layer rather than expanding the public/product mental model.

## 6. Product principles

This PRD does not replace the future Gu OS Principles & Design Doctrine. The following product-level guardrails are included because they materially shape product intent.

1. **Start from responsibility and outcome.** Do not start with a feature, screen, tool or agent. Ask what business work should become delegable and what outcome proves useful progress/completion.
2. **Define operational truth before the prompt.** Conversation and model interpretation are context, not the sole source of business truth.
3. **Reuse one operating core.** New domains add business semantics, not independent workflow engines.
4. **Powerful model, bounded authority.** Use models for reasoning, diagnosis and adaptation; enforce permissions, invariants, economic rights and consequential commitments deterministically or with explicit human authority.
5. **Treat UI as a surface over the same work context.** Conversation remains primary, with rich/contextual views when useful.
6. **Own differentiating capabilities; orchestrate replaceable external capabilities.** Gu retains responsibility and continuity in both cases.
7. **Design for outcomes, not activity.** Messages, searches and tool calls are not success by themselves.
8. **Compile relevant context; do not maximize tokens.**
9. **Govern network/economic rules explicitly.**
10. **Separate current, next/evolving and vision precisely.**

## 7. Operating domains and revenue loop

### 7.1 Revenue loop

The product should expand around one economic loop rather than a pile of unrelated workflows:

`Property Onboarding → Demand Generation → Conversion → Transaction → Outcome Feedback → Better Decisions`

This is a business-stage model, not the same thing as runtime domains.

### 7.2 Operating domains

- **Property Operations** — get inventory understood, prepared, governed and market-ready.
- **Demand Operations** — generate and improve qualified demand tied to downstream outcomes.
- **Relationship Operations** — keep relationships/opportunities alive and moving toward the best achievable outcome.
- **Transaction Operations** — preserve continuity through negotiation, documents, services, financing and closing.
- **Network / Ecosystem Operations** — mobilize shared inventory, cross-brokerage opportunities and specialized providers.

These should feel like different responsibilities that **the same Gu** can progressively assume, not five applications the user has to learn and operate.

All domains should reuse the shared Gu OS operating core.

## 8. Major product journeys

### 8.1 Bounded work

Not every user request needs a durable Case.

Example: “Compare these five properties and tell me which three best fit this buyer.”

Gu may gather context, use tools/Skills, generate a comparison and render a contextual view. If no durable responsibility remains afterward, no Case is required.

### 8.2 Property Onboarding / Optioning

This is the first generalization proof for durable operational work.

Illustrative path:
`registration → documentation → property information → comparables/pricing → approvals → contract/commercial preparation → photos → publication`

The durable business responsibility is to take a property from intake/capture to correct publication and operational availability.

### 8.3 Relationship Operations / Lead Opportunity

Relationship Operations should absorb the operational responsibility of traditional CRM relationship management, not necessarily rebuild its interface.

A traditional CRM records the relationship and displays a pipeline. Relationship Operations should assume responsibility for advancing the opportunity.

A Lead Opportunity can remain alive for weeks/months. Gu should progressively understand current intent, facts, commitments, next actions, matching possibilities, visits, escalations and outcomes.

The product transition is from:
- user scanning stale leads → Gu identifying which opportunities need attention and why;
- user creating follow-up tasks → Gu maintaining/advancing next action within policy;
- user manually updating stages → facts/events updating operational state;
- user remembering commitments → commitments remaining explicit and persistent;
- software recommending → Gu acting where allowed, with the human entering where judgment/authority adds value.

### 8.4 Demand Operations

Demand Operations should pursue acquisition outcomes, not simply report CPL.

A campaign objective may be defined in terms of qualified opportunities, visit requests or attended visits within budget/policy. External ad platforms remain rails/capabilities; Gu OS owns the operating objective, downstream feedback and decisioning.

The product should connect:
`campaign → lead → conversation → qualification → matching → visit → transaction signal`

A campaign with a higher CPL may be better if it produces more visits or transactions.

### 8.5 Transaction Operations

When a concrete transaction emerges, it may deserve its own durable Transaction Case rather than forcing the relationship/opportunity Case to become every downstream process. A transaction can fail while the broader relationship remains alive.

### 8.6 Network / Ecosystem

Shared Inventory already provides an early cross-brokerage mechanism. Gu can also bring specialized providers into work.

Network rules affecting attribution, representation, routing, permissions and commission-sharing must be explicit; the LLM should not improvise economic rights.

#### Consumer discovery: strategic option, not immediate priority

Consumer discovery is a future strategic option rather than the near-term wedge.

The staged direction is:
1. **First:** grow inventory density, freshness and liquidity in concrete micro-markets.
2. **Then:** use broker sites, property pages, WhatsApp, organic/search/AI discovery and shared links as distribution nodes.
3. **Later:** if demand originates directly in Ungga/Gu, Gu can continue serving the consumer while governed network rules route the opportunity to eligible broker participants.

A buyer or renter should not need to install another rarely used app for the journey. If consumer discovery emerges, it should be conversational and persistent.

**Strategic constraint:** Ungga should not position itself as competing against the broker. The network should increase brokers’ reach and capacity. Attribution, representation, commission and routing must remain explicitly governed.

## 9. Human + Gu operating model

Gu is not only about delegation. The product should create value through five dimensions:

- **Capacity** — more work without proportional headcount growth.
- **Intelligence** — understand, prioritize and recommend.
- **Coordination** — connect people, systems, decisions and work.
- **Reach** — mobilize network inventory and specialized capabilities.
- **Learning & Improvement** — under governance, use outcomes/evidence to improve recommendations, Skills and workflows.

Human involvement varies by decision type:

- **Strategic / relationship-sensitive:** Gu analyzes/recommends; human leads/decides; Gu executes consequences.
- **Routine operational:** Gu may understand/decide/execute within delegated policy.
- **High-risk / authority-sensitive:** Gu prepares context; human authorizes; Gu continues execution.

The goal is not less human relationship. It is better use of human attention at the moments where relationship, negotiation, judgment and responsibility create the most value.

## 10. Product experience and UI/UX

### 10.1 One Gu experience

The user should primarily experience one Gu, not a catalog of bots or modules.

Internally Gu OS can contain specialized Skills, tools, workers, Cases and domains; this complexity should not become user cognitive overhead.

### 10.2 Conversation as primary surface

Conversation should remain a primary control surface across web, WhatsApp, Telegram and future voice surfaces.

### 10.3 Contextual / dynamic interfaces

When chat is insufficient for comparison, charts, maps, documents, approvals, portfolio review or Case work, Gu should surface a richer contextual view tied to the same work context and, when present, the same Case.

Views should generally be projections/interfaces over product truth rather than independent truth stores.

### 10.4 UX principle

**The interface appears where the work requires it.**

**The user should not navigate modules to find the work. Gu should bring the work — and the right interface — to the user.**

## 11. Capability strategy: OWN vs ORCHESTRATE

Strategic ownership and implementation choice are separate decisions.

### OWN

A capability should tend to live/evolve inside Gu OS when its mechanism materially compounds differentiation such as:
- vertical operating semantics;
- operational continuity;
- governance;
- customer experience;
- cumulative intelligence;
- outcome feedback;
- strategic network control.

### ORCHESTRATE

A capability may remain external/replaceable when Gu OS can consume it behind a clear contract without losing:
- responsibility;
- continuity;
- context;
- governance;
- evidence;
- learning about the work.

### Initial strategic directions

| Capability | Direction |
|---|---|
| Relationship opportunity management / follow-up | **OWN** the differentiating capability in Gu OS. |
| Property inventory | **OWN** the operating model/semantics Gu needs; **ORCHESTRATE** external inventory sources while they add value and remain replaceable. |
| Portal publication infrastructure | **ORCHESTRATE** external rails; Gu preserves intent, context, status, retry/evidence and downstream consequences. |
| Shared Inventory | **OWN + SCALE** as a strategic network capability; the challenge is liquidity, density, freshness and coverage. |
| Valuation | **ORCHESTRATE today** as a specialized replaceable engine; Gu preserves context, inputs, authorization, interpretation and work continuity. |
| Foundation models, calendar, advertising rails | **ORCHESTRATE** through replaceable integrations/providers unless the capability mechanism itself later becomes differentiating. |

These directions are strategic defaults, not irreversible commitments. Capability boundaries should be revisited when evidence changes.

## 12. Business Brain and company-specific intelligence

Business Brain is an internal intelligence layer, not a separate product and not the operational action queue.

Its role is to help Gu progressively understand:
- the company;
- customers and relationships;
- ways of working;
- decisions;
- historical signals;
- reusable knowledge/patterns.

It must not replace:
- Cases;
- `case_facts`;
- declared transactional systems of record;
- explicit policies;
- authoritative decisions.

**Business Brain informs operational decisions; it does not replace operational truth.**

## 13. Product scope and non-goals

Gu OS is **not**:
- a generic arbitrary-agent development platform for end users;
- another chatbot;
- a set of disconnected AI features;
- a new separate SaaS module for every domain;
- a mandatory rip-and-replace of every CRM/provider;
- an unconstrained autonomous system;
- a system where chat history or memory is the only operational truth;
- a system where the model can improvise permissions, ownership, commission or irreversible business commitments;
- a product whose value is measured mainly by number of tool calls/messages/tasks;
- an immediate mass-market consumer marketplace or “another portal” before supply/liquidity justify it;
- a product that disintermediates the broker as a default strategic posture.

## 14. Current / evolving / vision discipline

Every product initiative and external/internal statement should distinguish:

| Area | Current / today | Next / evolving | Vision |
|---|---|---|---|
| Gu | Attention, matching, rules-based/limited follow-up, visit support. | More cross-workflow work and contextual decisions. | Persistent coworker across the operation. |
| Operating Core | Operational Cases, events, waits, permissions/HITL, Skills/tools, memory and multiple channels exist in varying maturity. | More flexible work, supervision, explicit human participation and stronger context/outcome handling. | Reusable core across multiple operating domains. |
| Relationship Operations | Gu already performs real conversion work. | Lead Opportunity Cases, contextual next action and portfolio supervision. | Continuous operation of relationships/opportunities. |
| Property Operations | Property Optioning, inventory synchronization and Shared Inventory exist in varying maturity. | More robust property state, publication/orchestration and selective repair. | Broader coverage of the property lifecycle. |
| Demand Operations | Partial source information; not end-to-end operating responsibility. | Campaign experiments and downstream attribution. | Continuous optimization toward visits/transactions. |
| Business Brain | Limited memory/business_brain mechanisms; broader Brain Layer is not fully implemented. | Richer organizational context, relationships, signals and cross-Case knowledge. | Governed company-specific intelligence/learning. |
| Network | Shared Inventory + integrated services. | Greater liquidity and governed opportunity rules. | A broader real-estate operating network/ecosystem. |

Architecture designed or partially implemented is not automatically a broadly validated product capability.

## 15. Success metrics

### 15.1 Business outcomes

The product should optimize toward downstream economic outcomes rather than activity.

Examples:
- visit requests;
- attended visits;
- properties correctly published;
- approvals obtained;
- opportunities advanced;
- transactions/signals of transaction progression;
- revenue/opportunity preserved.

### 15.2 Operational outcomes

- time/capacity returned to team;
- fewer stale/missed opportunities;
- lower manual coordination burden;
- fewer corrections/rework;
- reliable completion/evidence;
- bounded escalation/human attention where it matters.

### 15.3 Product/commercial proof

A central unresolved business proof is repeatability:

`acquire → activate → first valuable work → pay → consume → reload → retain → expand`

The product/deployment engine must also prove Gu OS can be configured, integrated and operated repeatedly without becoming bespoke consulting.

A particularly important product metric family should measure whether customers are willing to delegate **more economically meaningful work** to Gu over time, not merely whether they use more screens or messages.

## 16. Pricing/economic implications

Pricing and model-routing economics should reflect customer heterogeneity.

A useful framing is:
`operational intensity × economic value per opportunity`

A low-ticket rental workflow and a high-value sale can support very different product spend. The move toward prepaid credits/work/results should be evaluated through repeated consumption/reload and business value, not first load alone.

## 17. Competitive positioning

The alternatives include:
- human-coordinated status quo;
- outsourced services/BPO/agencies;
- vertical SaaS/CRM adding AI;
- point AI/vertical agents;
- general-purpose AI coworkers/agents;
- vertical AI platforms/operating systems;
- DIY automation/agent platforms;
- networks/marketplaces/ecosystems.

The differentiation thesis is not “others talk, Gu acts.” Many systems can act.

The strategic bet is:

**productized real-estate operating intelligence = vertical semantics + durable operational work + company-specific context + governed execution + outcome feedback + network/ecosystem reach**

Foundation-model improvements should strengthen Gu OS rather than threaten its core architecture.

## 18. Product roadmap framing

This PRD defines direction, not detailed delivery sequencing.

Near-term roadmap work should prioritize high-value responsibilities that:
- connect the brokerage revenue loop;
- reuse the shared operating core;
- can be verified with downstream outcomes;
- are repeatable across customers;
- avoid bespoke consulting;
- create compounding context/evidence/learning potential;
- fit an executable sequence for a small team rather than expanding into every plausible domain at once.

Detailed sequencing belongs in the canonical roadmap and topic Technical Plans.

## 19. Open product questions

1. What is the precise near-term ICP by operational intensity, opportunity economics and deployment complexity?
2. What minimum Relationship Operations responsibility should become productized first and create a visibly better outcome for customers?
3. What product boundary distinguishes a Lead Opportunity Case from bounded lead turns and from a downstream Transaction Case?
4. Which downstream outcomes are sufficiently observable/verified today for optimization and pricing?
5. How should Demand Operations enter without diluting the conversion wedge before product repeatability is proven?
6. Which contextual views create the highest leverage while preserving One Gu?
7. Which capabilities should shift from ORCHESTRATE to OWN as product evidence accumulates?
8. What evidence should justify graduating autonomy operation by operation?
9. What minimum Business Brain capability creates user value before broad organizational cognition exists?
10. What customer/deployment metrics define “repeatable Gu OS” versus a successful custom pilot?
11. When does consumer discovery become justified by Shared Inventory density/liquidity?
12. What is the canonical product metric hierarchy beneath the overall “work delegated and outcomes produced” thesis?
13. Where can real network effects be created without premature distraction toward a mass consumer marketplace?
14. How should an ambitious long-term vision be translated into an executable roadmap for a small team?

## 20. Relationship to other canonical artifacts

- **Principles & Design Doctrine** — owns canonical values, principles, invariants and reusable design patterns.
- **Agentic Product & Software Development Methodology** — owns how humans + coding agents design, build, verify, release and evolve the product.
- **Feature / Business Specs** — own exact intended behavior.
- **Architecture manuals / ADRs** — own technical boundaries and accepted design decisions.
- **Technical Plans** — own implementation design.
- **Code/migrations/config** — own implemented reality.
- **Tests/evals/readiness/release evidence** — own verification.
- **Roadmap** — owns sequencing and evidence gates.
- **Investor Narrative / Team Primer / Cofounder Strategic Vision** — audience-specific narrative/alignment sources reconciled into this product intent.

## 21. Source-status discipline

This PRD intentionally separates:
- **Current / demonstrated**
- **Evolving / next**
- **Hypothesis / strategic bet**
- **Vision**

A capability described in architecture is not automatically a product capability proven in production. Likewise, a narrative document marked “future” may become status-stale if implementation has advanced. Current product statements should be revalidated against the repository and real customer evidence as the system evolves.

---

## Appendix A — Primary sources reconciled into v0.1.1

- Ungga Investor Narrative Backbone v0.6.
- Ungga — From Gu to Gu OS Team Primer v1.2.
- Ungga — Gu to Gu OS Visión Estratégica para Cofundadores v1.1.
- 10 Principios de Arquitectura y Producto v0.1.
- Gu OS Technical Architecture, Operating Model & Evolution Blueprint v1.0.
- Current repo documentation authority map (`docs/README.md`).
- Historical `docs/brief.md` used only for still-valid provenance, not as current product definition.
- Gu OS Documentation & Agent Context Architecture Audit v0.1.

## Appendix B — What this PRD deliberately does not absorb

- detailed runtime architecture;
- table schemas/migrations;
- detailed Workflow Studio contracts;
- exhaustive workflow/Case specs;
- ADR rationale;
- implementation slices;
- testing framework detail;
- CI/release mechanics;
- agent instruction files;
- investor-specific traction/fundraising copy.

Those remain linked, separately governed artifacts.
