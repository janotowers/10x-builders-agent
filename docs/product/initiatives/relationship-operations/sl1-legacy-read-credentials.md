# SL-1 — Traditional Gu read credentials: scopes, containment and retirement

> **Status:** Operational record for R1 SL-1. Satisfies **SA-1.5** ("credential scopes are documented, including the accepted whole-database Firestore read and its time-boxed shadow-only bound").
> **Owner:** engineering owner (R1), with the human Accountable / DRI for SL-1.
> **Governing sources:** [`technical-plan.md`](technical-plan.md) TD-5 and §6 · [`slice-plan.md`](slice-plan.md) §4 (SL-1 dependencies) and §5 (prerequisite record) · [ADR-106](../../../adr/ADR-106-organization-native-multiseat-tenancy.md)
> **Artifact role:** Records **what access was actually granted, what contains it, and when it retires**. It does not grant anything, does not change TD-5, and is not a general secrets policy — it describes this specific bootstrap material.

## 1. Why this record exists

TD-5 sanctions direct Firestore/Mongo read adapters **only** as shadow/bootstrap, and only on conditions. One of them is that the blast radius is written down rather than assumed. The Firestore credential in particular is a **project-level reader**: GCP IAM has no per-collection read grant and the Admin SDK bypasses security rules, so the identity can technically read every collection in its project. TD-5 accepts that as time-boxed and shadow-only *because* Gu OS narrows it itself.

This document is where that narrowing is stated, and where the gap between "what the credential can reach" and "what Gu OS will read" is made explicit.

## 2. Identities as delivered

| Side | Identity | Grant | Reaches |
|---|---|---|---|
| Firestore (stage) | `gu-os-sl1-reader@unggafb.iam.gserviceaccount.com` | `roles/datastore.viewer`, read-only | every collection in the `unggafb` project |
| Firestore (production) | `gu-os-sl1-reader@ungga-full.iam.gserviceaccount.com` | `roles/datastore.viewer`, read-only | every collection in the `ungga-full` project |
| Mongo Atlas | `gu-os-sl1-reader` | database-level `read` on `bot` and `gu2`, read-only | one cluster, two databases |

No identity holds any write authority. No identity is shared with another purpose.

## 3. What Gu OS actually reads — the code allowlist

The containment TD-5 relies on lives in [`apps/web/src/lib/legacy-gateway/allowlist.ts`](../../../../apps/web/src/lib/legacy-gateway/allowlist.ts). It is the only place a source path may be named, and an unlisted path throws rather than degrading.

| Store | Path | Capability | Why |
|---|---|---|---|
| Firestore | `leads/{legacyLeadId}` | `legacy_lead_get_context` | the lead record; the id is a composite operational-context key used opaquely (audit §5.1) |
| Firestore | `leads/{legacyLeadId}/wsp_messeges` | `legacy_lead_get_recent_messages` | thread-aware conversation store (audit §10.1, §15.7) |
| Firestore | `users/{legacyUserId}` | lead + property reads | **owner resolution only** — read to normalize a record's legacy owner so containment can run |
| Firestore | `properties/{legacyPropertyId}` | `property_get_details` | the authoritative property record (audit §14.1) |
| Firestore | `deals/{legacyDealId}/appointments` | `appointment_get` | the Firestore appointment replica; a subcollection of the deal, not a root collection |
| Mongo | `gu2.appointments` | `appointment_get` | appointment persistence is not atomic across stores (audit §11.3) |

Deliberately excluded, with reasons, in the same module: Mongo `property_data` (serving mirror, not authority), `bot.chats` / `gu2.chats` / `gu2.chat_memory` (conversation mirrors — delivery status is read from Firestore), `gu2.users` / `gu2.deals` (conversation-authority signals belonging to SL-6), Firestore `users_sellers` (dropped before issuance — binding resolves through Gu OS `external_identity_bindings`), and BigQuery (AC-1 keeps it analytical).

Beyond the allowlist, every read is contained by the Organization gate in [`authorization.ts`](../../../../apps/web/src/lib/legacy-gateway/authorization.ts): flags, active membership, the Organization's own `legacy_organization_key` binding, refusal when the requested identity is bound to another Organization, and — after the fetch, before anything is returned — resolution of the record's legacy owner back to the calling Organization.

## 4. The Mongo appointment source is `gu2.appointments` (legacy-owner confirmed)

The scope recorded before issuance placed the appointment record in "the `appointments` collection in the primary database (`MONGO_DB_NAME`)", and `MONGO_DB_NAME` does resolve to `bot`. The assumption that the collection lived there was simply wrong about the physical source: **`bot` has no `appointments` collection.**

The correct location was observed during execution on 2026-09-04 through the delivered identity, and then **confirmed directly with the Traditional Gu team member responsible for the source**. It is therefore legacy-owner-confirmed information, not an implementation inference:

> The Mongo appointment source required by SL-1 is **`gu2.appointments`** — the guv3 runtime database, roughly 9,400 documents.

`bot` holds `chats`, `messages`, `property_data`, `users` and related collections; `gu2` holds the guv3 runtime, including `appointments`.

### Human revalidation of the temporary deviation, under the corrected fact

The deviation recorded in the Slice Plan was accepted while the source was believed to be `bot.appointments`. The human accountable for SL-1 revalidated it explicitly against the corrected fact on 2026-09-04, and that revalidation governs:

- the appointment source SL-1 requires is **`gu2.appointments`**;
- the current read-only identity **may continue to cover `bot` and `gu2`** for this bootstrap;
- **no Mongo identity reprovisioning is required** merely because the source is `gu2` — the existing identity already reaches it;
- this **remains a temporary bootstrap deviation**;
- the **C6 retirement boundary is unchanged**.

Two things that are easy to conflate, kept apart for whoever revisits this:

- **What SL-1 requires is access to `gu2.appointments`.** A grant confined to `bot` would not reach the appointment source at all.
- **What the deviation is** remains the broader **database-level `read` across `bot` and `gu2`**, rather than the least-privilege minimum. That is the human-accepted temporary condition, and the correction does not change its nature.

If it is ever narrowed before C6 — which the revalidation does not require — the minimum required Mongo grant is a collection-level `find` on `gu2.appointments`.

The code allowlist follows the confirmed source: it names `gu2.appointments` and nothing else in Mongo.

## 5. Production boundary — what was read, and under what authority

The prerequisite record states that production IAM provisioning occurred but that no production data was read. That remains true of **Firestore**: the production key stayed unwired until the authorized hosted evidence run of 2026-09-04 (recorded in [`sl1-hosted-evidence.md`](sl1-hosted-evidence.md)), which the human accountable authorized explicitly.

The **Mongo** side needs completing rather than correcting, because that paragraph was written in Firestore terms. Firestore has two projects, so stage-versus-production is a meaningful distinction there. Mongo has **one** Atlas cluster and no stage equivalent, so every Mongo read SL-1 performs is by construction a read of that production cluster. The shape-discovery reads that produced the contracts in [`source-contracts.ts`](../../../../apps/web/src/lib/legacy-gateway/source-contracts.ts) were such reads: `find` and `estimatedDocumentCount` only, sampling field names and counts, nothing written, no value retained, no prospect-facing effect.

**Those reads were inside approved SL-1 execution authority.** Four governing sources say so, and none of them is stretched to fit:

| Source | What it establishes |
|---|---|
| Methodology §14.2 | "Behavior/authority mode is not Release Scope." `shadow` means no external effects. RS-3 is defined by what a **Gu OS** production *release* adds — production authorization, schema preflight, controlled deploy, post-release verification, canary/rollback. Reading a source system Gu OS does not own is none of those. |
| Methodology §11.5 | Hosted verification adds "contract and pilot evidence a slice's DoD requires". Pilot evidence means the pilot's real records. The post-release layer runs against **production after a release** — a Gu OS release. |
| Technical Plan §8 | The approved verification strategy *requires* "gateway adapters against recorded fixtures **+ a staging pass with pilot credentials**". Recording a fixture and passing with pilot credentials both require reading the real source. |
| Slice Plan §4 + SL-1 DoD | The case-B prerequisite provisioned this identity for exactly this purpose, and the DoD requires a contract fixture for `appointment_get` — impossible to record without reading the appointment source. |

**A narrow documentation ambiguity, logged rather than resolved unilaterally.** What no governing source states is how the word "production" applies to a **legacy source system** Gu OS reads but does not own or deploy to. Every definition in the Methodology and the release-path playbook is written for Gu OS's own deployment target, which is why the prerequisite record's production-boundary paragraph addressed Firestore projects and was silent on the single Atlas cluster. A later methodology refinement could add one sentence distinguishing *a Gu OS production release* from *reading an external system's production data*. That is a process improvement, not a finding against this Slice.

## 6. Storage, rotation and the operator path

Credentials are stored per Organization in `organization_tool_secrets`, encrypted with AES-256-GCM, service-role only in both directions. The split is deliberate:

- **`config_jsonb`** carries identity metadata — Firestore project and client email, Mongo host and database. Knowing *which* identity is bound is an operational question that must be answerable without decrypting anything.
- **`encrypted_secret_jsonb`** carries the private key and the password-bearing URI, and nothing else. **No metadata projection selects it** - `PUBLIC_COLUMNS` is a literal, so a future `select("*")` cannot widen what a metadata read returns. The **server-only runtime resolver does** select and decrypt it, because that is the only way an adapter obtains a credential; it refuses to run anywhere a `window` exists, and it is unreachable from a browser bundle or a user-JWT path.

```bash
npx tsx scripts/bootstrap-legacy-credentials.ts --env-file .env.staging.local --env staging --legacy-env stage --organization <uuid>
```

**Only `active` credentials serve product reads.** `getOrganizationToolSecretForRuntime` - the path the gateway uses - resolves nothing but `active`, so a credential no connection check has proven produces a refusal rather than a gamble against a live source. The single sanctioned exception is named rather than flagged: `getOrganizationToolSecretForConnectionCheck` also accepts `pending_test`, and its only legitimate caller is the code that immediately proves or rejects that credential. `invalid`, `disconnected`, blank and undecryptable are unusable on both paths.

**Rotation takes effect without a restart.** Each resolved credential carries a non-secret fingerprint - a truncated digest of the effective material - and the adapters key their connection caches on it. Replacing a credential changes the fingerprint, so the cached driver client no longer matches and is retired; the Mongo client is closed, because it owns a connection pool that would otherwise keep authenticating with the retired credential. The fingerprint belongs in a cache key, never in a log line or an evidence artifact.

Dry-run is the default. `--apply` stores, and every stored credential lands in `pending_test` — including a replacement, because new material has not been proven and inheriting `active` would assert exactly what was not checked. The script then performs one narrow read per provider and flips `pending_test → active`, or records `invalid` with the reason. **Rotation is the same command run again.**

Both providers were stored and proven against Gu OS staging on 2026-09-05, with the transition observed rather than inferred; see [`sl1-hosted-evidence.md`](sl1-hosted-evidence.md) §2.

Operational notes:

- `GUOS_<ENV>_ENCRYPTION_KEY` must be the key the target environment's runtime decrypts with. An ambient `ENCRYPTION_KEY` is refused: material encrypted with a developer's local key stores cleanly and then fails to decrypt where it is needed. It is required only on `--apply`.
- A machine whose resolver refuses direct DNS cannot look up `mongodb+srv` records. Set `GUOS_LEGACY_MONGO_URI_DIRECT` to an equivalent seedlist URI: it is used **only for the connection check** and is never stored, so what lands in `organization_tool_secrets` stays the portable SRV form a real runtime would use.
- The check reports three outcomes, not two. `unreachable` — a network-shaped failure occurring before any credential is evaluated — leaves the credential at `pending_test` rather than marking it `invalid`, because "this machine cannot reach the provider" is not evidence that a credential is bad.
- The Mongo check treats a zero-document `appointments` as a **failure**, because that is precisely how a wrong database name presents.
- Local key material is git-ignored (`gu-os-sl1-reader.*.json`, `*.password.txt`) and referenced by path, so no key value sits inside an environment value. `git clean -fdx` removes ignored files too — keep a copy outside the repo.

## 7. Retirement

The credentials retire with the adapters they justify, not later.

**Condition:** revisit and retire the direct credential path **no later than the C6 transition, before assisted effects** — the same boundary TD-5 sets for the bootstrap adapters. Once any prospect-facing effect is enabled, pre-effect freshness reads run exclusively on the C6 bounded path.

**Mechanism:** `disconnectOrganizationToolSecret` blanks the ciphertext while keeping the row, so what was once bound stays auditable and no material remains at rest. Revoking the IAM grant and the Atlas user is the second half and is a human action.

**Interim tightening, if the window lengthens:** narrow the Atlas grant from database-level `read` on `bot` + `gu2` to a collection-level `find` on `gu2.appointments`. Firestore cannot be narrowed by IAM at all; its containment stays the code allowlist plus the per-read Organization binding check, which is the arrangement TD-5 accepted.
