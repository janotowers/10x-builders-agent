# ADR-0011 — Governed hybrid storage for private skill packages

**Status:** Accepted direction; implementation deferred  
**Date:** 2026-08-11  
**Related:** [`../gu-os-flexible-workflows-technical-plan.md`](../gu-os-flexible-workflows-technical-plan.md) §9.2; [`../gu-os-flexible-workflows-detailed-implementation-plan.md`](../gu-os-flexible-workflows-detailed-implementation-plan.md) Slice 4.3; [`../../business-brain-evolution-roadmap.md`](../../business-brain-evolution-roadmap.md) V2

## Context

Global skills already use a portable package shape: required `SKILL.md`, optional `references/` and `assets/`, and a reserved `scripts/` directory. Gu OS adds tenant, tool, HITL, heartbeat, memory, and guardrail metadata around that portable core.

Private `account_skills` are currently a V1 single-row representation (`body_md` plus metadata). They cannot preserve a complete package, immutable reviewed versions, or reference/asset bytes. Storing every byte in Postgres would make large assets and package delivery awkward; treating object storage alone as the catalog would weaken transactional governance, RLS-aware discovery, version pinning, and auditability.

## Decision

Adopt a hybrid private-package architecture when Slice 4.3 is implemented:

1. **Postgres is the control plane.**
   - `account_skill_versions` records are immutable content versions owned by an explicit tenant/account skill. They carry the canonical manifest hash, lifecycle state, provenance, required/granted capabilities, review/publish evidence, and lineage/rollback metadata.
   - `account_skill_files` is the queryable manifest index for each version. At minimum it records normalized relative path, file role, media type, byte size, content hash, and private storage object key.
   - The canonical manifest hash is computed from a deterministic, path-sorted manifest covering every file plus security-relevant path/type/executable metadata. Reviewing or publishing binds to that exact hash, not only to `SKILL.md`.

2. **Private Supabase Storage is the byte plane.**
   - Package bytes for `SKILL.md`, `references/`, and inert `assets/` live in a private bucket, partitioned by tenant, skill, and immutable version.
   - Storage objects are not the lifecycle source of truth and are never public. A database row or object key alone does not grant access.
   - Published bytes are immutable. Any content change creates new objects, a new manifest, and a new draft version.

3. **Runtime resolution is version-pinned.**
   - Skill selection resolves a published account skill to a specific `account_skill_versions.id` and manifest hash. A case/run that needs reproducibility persists that pin; it does not follow a mutable “latest” package during execution.
   - `read_skill_reference` resolves against the active run's pinned version, looks up the normalized reference path in `account_skill_files`, fetches the object from private storage, and verifies its content hash before returning bounded content.
   - Resolution rejects traversal, absolute paths, unindexed objects, non-reference file roles, hash mismatches, and cross-tenant/version lookups. Global Git-backed references remain a separate supported resolver.

4. **Isolation is enforced at both planes.**
   - Postgres RLS scopes skills, versions, files, and lifecycle records to the owning tenant/account and authorized members.
   - Supabase Storage policies mirror the tenant boundary. Browser/client flows use only narrowly scoped access; no service-role credential reaches a client.
   - Server runtime may use the service role only after receiving trusted tenant/user context and verifying the requested skill version belongs to that tenant. Service-role bypass is not authorization and must not infer tenancy from a caller-supplied object key.

5. **Review, publish, rollback, and promotion are explicit.**
   - The target lifecycle is `draft → reviewed → published → deprecated|archived`.
   - Review records the manifest hash. Any edit creates a new draft and requires review again. Publish fails closed unless the same hash was reviewed, required capabilities are granted, and required evidence passes.
   - Activation points to an immutable published version. Rollback changes that pointer to a prior published version; it never edits history. Scope promotion creates a new governed version with lineage and remains admin-gated.

6. **Package scripts never become runtime code by publication.**
   - Imported `scripts/` may be retained only in a separate quarantine with provenance and no credentials, network access, or runtime visibility.
   - A script can leave quarantine only through engineering/security review and promotion into a registered Gu tool or deterministic service with an explicit capability contract, tenancy enforcement, tests, observability, and rollback.
   - The model never chooses or executes arbitrary package scripts.

## Consequences

- Portable skill content remains interoperable while Gu-specific governance stays outside the package format.
- Postgres supports transactional lifecycle checks and tenant-aware lookup; private object storage carries package bytes efficiently.
- Published behavior is reproducible because runs resolve immutable versions and reference hashes.
- Import means validate, adapt, quarantine, review, and publish; it never means download and activate.
- Retention, garbage collection, signed-delivery details, exact schemas, migration from V1 `account_skills`, and UI/API work require a separate implementation plan and security review.

## Deferred implementation boundary

This ADR documents a future target only. It does **not** add or authorize migrations, storage buckets/policies, runtime resolvers, import endpoints, script execution, or changes to the current `account_skills` remediation. Those changes remain the separately scheduled Slice 4.3 and must ship with tenant-isolation, hash-tampering, lifecycle-transition, capability-gating, pinning, and rollback tests.

## Reevaluate when

- Supabase Storage cannot meet package-size, retention, regional, or customer-managed-key requirements.
- Organization ownership replaces the current account/user tenant boundary.
- A vetted sandbox is proposed; even then, package scripts require a new ADR before direct execution is allowed.
