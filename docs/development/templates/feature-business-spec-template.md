# {{Feature / Business Spec title}}

> **Version:** v0.1  
> **Status:** Draft  
> **Owner / decision owner:** {{product/domain owner}}  
> **Contributors:** {{engineering / design / domain participants as applicable}}  
> **Initiative:** {{initiative name + link}}  
> **Parent product intent:** {{PRD link}}  
> **Initiative Brief:** {{brief link, if applicable}}  
> **Roadmap:** {{roadmap link / increment}}  
> **Doctrine:** {{Principles & Design Doctrine link}}  
> **Development method:** {{Methodology link}}  
> **Architecture Analysis / ADRs:** {{links if available; otherwise "Pending / not yet required"}}  
> **Intended repo path:** `{{path}}`  
> **Artifact role:** Governing contract for intended user/business behavior. This Spec does not own implementation design, exact schemas, migration order, incidental function signatures, or technical mechanisms unless they are themselves part of an externally meaningful contract.



## 1. Summary and decision



{{summary}}

**Approval of this Spec means:** {{plain-language statement of what behavior becomes approved}}

**Approval of this Spec does not mean:** {{architecture / implementation decisions not yet approved}}

## 2. User and business objective



### 2.1 User objective

{{What should the user, customer, operator, prospect, or stakeholder be able to accomplish?}}

### 2.2 Business objective

{{What economically or operationally meaningful outcome should improve?}}

### 2.3 Success signal

{{What observable result would indicate that this behavior is useful? Avoid activity-only metrics where a downstream outcome is available.}}

## 3. Actors, responsibilities, and authority


| Actor / system | Responsibility in this Spec | Authority / limits                             |
| -------------- | --------------------------- | ---------------------------------------------- |
| {{actor}}      | {{responsibility}}          | {{what they may decide/do; what they may not}} |




## 4. Terminology and domain concepts


| Term     | Definition in this Spec | Not to be confused with |
| -------- | ----------------------- | ----------------------- |
| {{term}} | {{definition}}          | {{nearby concept}}      |




## 5. Source-status and evidence basis




| Statement / area                     | Status                                                                                                                  | Source / evidence          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| {{current fact or target direction}} | CURRENT — REPO VERIFIED / CURRENT — DOMAIN CONFIRMED / TARGET — SPEC PROPOSED / TARGET — APPROVED / OPEN — ARCHITECTURE | {{link / evidence / note}} |


**Status rule:** absence from inspected evidence is not proof of absence. Product/domain-confirmed facts must not be silently converted into low-level implementation facts until source-audited where that distinction matters.

## 6. Preconditions and triggering context



### 6.1 Preconditions

- {{condition that must already be true}}
- {{required permissions / known identity / available context}}



### 6.2 Triggering situations

- {{event, user action, external event, schedule, or state that invokes this behavior}}



### 6.3 Situations that do **not** trigger this behavior

- {{explicit negative trigger}}



## 7. Scope



### 7.1 In scope

- {{behavior / user outcome}}
- {{business rule}}
- {{human involvement}}
- {{evidence or outcome requirement}}



### 7.2 Non-goals

- {{related capability deliberately excluded}}
- {{technical mechanism that belongs later}}
- {{future maturity intentionally deferred}}



## 8. Behavioral contract



### 8.1 Core invariants

1. {{behavioral invariant that must remain true}}
2. {{authority / safety / truth invariant}}
3. {{business invariant}}



### 8.2 Decision rules


| Condition / context | Required behavior | Must not happen        | Notes       |
| ------------------- | ----------------- | ---------------------- | ----------- |
| {{condition}}       | {{behavior}}      | {{forbidden behavior}} | {{context}} |




### 8.3 State / lifecycle behavior



{{state/lifecycle model}}



### 8.4 Policy and configuration behavior



**Policy layers / precedence:** {{e.g. platform hard bounds → organization policy → contextual/model judgment}}

**Defaults:** {{safe/recommended default behavior}}

**Configurable choices:** {{what the organization/user may tighten or customize}}

**Non-overridable bounds:** {{what tenant/user configuration may not weaken}}

**Ambiguity rule:** {{what happens when policy or context is insufficient}}



### 8.5 Model judgment vs deterministic guarantees


| Concern                         | Model / Skill may judge | Deterministic / governed mechanism must guarantee               |
| ------------------------------- | ----------------------- | --------------------------------------------------------------- |
| {{semantic/contextual concern}} | {{interpretation}}      | {{permission, validation, invariant, mechanical postcondition}} |




### 8.6 Human involvement and authority


| Situation     | Human role                                                                       | Required mode                                                                           | Why                          |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| {{situation}} | action authorization / business decision / human contribution / exception review | autonomous / act+inform / prepare+approval / human takeover / human-as-executor / other | {{risk/authority rationale}} |




### 8.7 Data, evidence, provenance, and freshness


| Business claim / outcome | Required evidence or admissible source | Freshness requirement                 | If missing / conflicting                     |
| ------------------------ | -------------------------------------- | ------------------------------------- | -------------------------------------------- |
| {{claim}}                | {{source/provenance}}                  | {{fresh / historical / time-bounded}} | {{unknown / reconcile / ask / do not infer}} |


Rules:

- Positive evidence may establish a fact when the source is admissible.
- Absence of evidence must not be treated as negative evidence unless the source contract explicitly supports that inference.
- Conflicting claims preserve provenance and follow an explicit reconciliation rule; generic last-write-wins is not a business rule.
- Conversation/model interpretation is context or derived evidence, not automatically authoritative truth.



### 8.8 External effects and commitments



- {{side effect and required authority}}
- {{idempotency / duplicate-prevention expectation if user-visible}}
- {{what evidence proves the effect occurred}}
- {{rollback / correction behavior if externally meaningful}}



### 8.9 Non-functional product requirements (optional)



- {{requirement}}



## 9. Happy paths



### HP-01 — {{name}}

**Given**

- {{precondition}}

**When**

- {{trigger/action}}

**Then**

- {{observable behavior}}
- {{evidence/outcome}}



### HP-02 — {{name}}

{{repeat as needed}}



## 10. Unhappy, ambiguous, and edge cases


| ID    | Situation                          | Required behavior | Forbidden shortcut                 |
| ----- | ---------------------------------- | ----------------- | ---------------------------------- |
| EC-01 | {{ambiguous or failure situation}} | {{behavior}}      | {{what must not be inferred/done}} |




## 11. Acceptance scenarios




| ID    | Given       | When             | Then                             | Required evidence / verifier               |
| ----- | ----------- | ---------------- | -------------------------------- | ------------------------------------------ |
| AC-01 | {{context}} | {{event/action}} | {{expected observable behavior}} | {{test / eval / replay / source evidence}} |
| AC-02 | {{context}} | {{event/action}} | {{expected behavior}}            | {{evidence}}                               |




### Acceptance quality bar

This Spec is not accepted merely because the happy path works. The acceptance set must cover the material authority, ambiguity, failure, provenance, and recovery cases implied by this capability.



## 12. User experience / supervisory surface (optional)



- **Primary surface:** {{conversation / web / WhatsApp / voice / contextual view / etc.}}
- **What the user must understand:** {{state, reason, next action, evidence}}
- **What the user may do:** {{approve, correct, take over, inspect, etc.}}
- **What should remain hidden/automatic:** {{implementation/system complexity}}
- **Accessibility / channel-specific constraints:** {{if applicable}}



## 13. Observability, outcome, and economic telemetry



### 13.1 Operating evidence

- {{what proves the mechanism behaved correctly}}
- {{failure/recovery signals}}



### 13.2 Business / outcome evidence

- {{downstream outcome(s)}}
- {{mechanism evidence that helps attribute why the outcome occurred}}



### 13.3 Resource / cost correlation (if applicable)

- Material resource usage must be correlatable to the appropriate durable root / Case / Work Item / Attempt / account or other causal object where defensible.
- Shared cost must not be forced into false precision when no defensible allocation driver exists.
- Internal cost-to-serve is distinct from customer price, credits, wallet, billing, or recharge behavior unless explicitly in scope.



## 14. Security, privacy, tenancy, and data-sharing behavior



- {{tenant/org boundary}}
- {{role/permission behavior}}
- {{data minimization/provenance}}
- {{cross-tenant/cross-company sharing rule}}
- {{fail-closed ambiguity rule}}
- {{platform-staff/admin distinction if relevant}}



## 15. Verification expectations


| Behavior type                        | Minimum expected verification                                                |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Deterministic invariant / regression | Unit/integration/fixture test where practical                                |
| Model-mediated semantic judgment     | Representative eval/scenario set + rubric/threshold                          |
| User/business workflow               | Acceptance scenarios + integration/replay/readiness proportional to maturity |
| Consequential external effect        | Evidence of actual postcondition + permission/authority checks               |
| Production evolution                 | Controlled E2E/canary/telemetry/rollback evidence proportional to risk       |


**Independent verification:** {{state whether high-risk behavior requires CI, independent reviewer, isolated verification-agent pass, or other independent evidence}}



## 16. Architecture dependencies and open structural questions




| ID   | Question / dependency     | Why it matters to behavior | Owning artifact / status           |
| ---- | ------------------------- | -------------------------- | ---------------------------------- |
| A-01 | {{architecture question}} | {{behavioral consequence}} | Architecture Analysis / ADR — OPEN |


**Rule:** Architecture may reveal that this Spec is unsafe, impossible, or underspecified. If so, revise the Spec explicitly; architecture must not silently redefine behavior.



## 17. Deferred / future behavior

- {{deliberately later capability}}
- {{maturity expansion}}
- {{adjacent initiative}}



## 18. Spec exit criteria

Before this Spec can be marked **Approved**, confirm:

- [ ] User/business objective and responsibility are explicit.
- [ ] Actors, identity/authority distinctions, and relevant terminology are unambiguous.
- [ ] Scope and non-goals prevent adjacent architecture/product leakage.
- [ ] Core decision rules are observable and testable.
- [ ] Policy/default/override behavior is explicit where configuration matters.
- [ ] Model judgment is separated from deterministic/governed guarantees.
- [ ] Human involvement is tied to authority/risk/knowledge need rather than blanket approval.
- [ ] Data/evidence/provenance/freshness rules prevent unsupported inference.
- [ ] Happy, unhappy, ambiguous, duplicate/retry, and recovery behavior are covered proportionally.
- [ ] Acceptance scenarios are sufficient for a coding agent to derive a plan without inventing product behavior.
- [ ] Security/privacy/tenancy/data-sharing behavior is explicit where relevant.
- [ ] Observability/outcome/economic requirements are explicit where relevant.
- [ ] Open architecture questions are identified rather than silently answered.
- [ ] No implementation detail is included solely because it is convenient for the current codebase.
- [ ] Relevant PRD / Brief / Roadmap / Doctrine / ADR links are current.



## 19. Decision / change log


| Version / date  | Decision or change | Owner / approver | Notes     |
| --------------- | ------------------ | ---------------- | --------- |
| v0.1 / {{date}} | Initial draft      | {{name/role}}    | {{notes}} |


