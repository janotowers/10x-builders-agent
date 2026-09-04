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

## 4. Correction: the appointments collection is in `gu2`, not `bot`

The provisioning scope recorded before issuance said the appointment record was "the `appointments` collection in the primary database (`MONGO_DB_NAME`)", and that `bot` is what `MONGO_DB_NAME` resolves to.

Verified first-hand on 2026-09-04 through the delivered identity: **`bot` has no `appointments` collection at all**. Appointments live in `gu2` — the guv3 runtime database — with roughly 9,400 documents. `bot` holds `chats`, `messages`, `property_data`, `users` and related collections; `gu2` holds the guv3 runtime, including `appointments`.

Two consequences worth stating plainly:

- **The accepted least-privilege deviation is what makes SL-1 work.** Its recorded rationale said `gu2` "holds reminder, template-retry, ads and bug-informer collections SL-1 never queries". That premise was wrong in the direction that matters: had the recommendation been followed exactly — a collection-level `find` on `bot.appointments` — SL-1 would have been unable to read appointments at all. The deviation is not merely tolerable here; without it the appointment capability has no source.
- **The narrower grant is still the right target.** The correct minimal grant is a collection-level `find` on **`gu2.appointments`**. That is what should replace the current database-level grant if the deviation is tightened before its retirement condition.

The code allowlist follows the verified source; it names `gu2.appointments` and nothing else in Mongo.

## 5. Production boundary, as it now stands

The prerequisite record states that production IAM provisioning occurred but that no production data was read. That is still true of **Firestore**: the production key is issued and valid, and nothing in the setup path references it. It stays unwired until the hosted evidence run for SA-1.2/SA-1.3, which is the only step needing a real Alebrixe lead.

It is **no longer true of Mongo**, and the record needs that correction: there is only **one** Atlas cluster. There is no stage Mongo. The shape-discovery reads that produced the recorded contracts in [`source-contracts.ts`](../../../../apps/web/src/lib/legacy-gateway/source-contracts.ts) therefore read the production cluster — read-only, `find`/`estimatedDocumentCount` only, sampling field names and counts, with no value leaving the machine and nothing written. That is inside what the identity was issued for, and it has no prospect-facing effect, but "no production data read" is not an accurate description of the Mongo side and should not be carried forward as one.

## 6. Storage, rotation and the operator path

Credentials are stored per Organization in `organization_tool_secrets`, encrypted with AES-256-GCM, service-role only in both directions. The split is deliberate:

- **`config_jsonb`** carries identity metadata — Firestore project and client email, Mongo host and database. Knowing *which* identity is bound is an operational question that must be answerable without decrypting anything.
- **`encrypted_secret_jsonb`** carries the private key and the password-bearing URI, and nothing else. No read path in the codebase can select this column: the projection is a literal, so a future `select("*")` cannot widen it.

```bash
npx tsx scripts/bootstrap-legacy-credentials.ts --env-file .env.staging.local --env staging --legacy-env stage --organization <uuid>
```

Dry-run is the default. `--apply` stores, and every stored credential lands in `pending_test` — including a replacement, because new material has not been proven and inheriting `active` would assert exactly what was not checked. The script then performs one narrow read per provider and flips `pending_test → active`, or records `invalid` with the reason. **Rotation is the same command run again.**

Operational notes:

- `GUOS_<ENV>_ENCRYPTION_KEY` must be the key the target environment's runtime decrypts with. An ambient `ENCRYPTION_KEY` is refused: material encrypted with a developer's local key stores cleanly and then fails to decrypt where it is needed. It is required only on `--apply`.
- A machine whose resolver refuses direct DNS cannot look up `mongodb+srv` records. Supply a non-SRV seedlist URI there. The Mongo connection check treats a zero-document `appointments` as a **failure**, because that is precisely how the `bot`-versus-`gu2` mistake presents.
- Local key material is git-ignored (`gu-os-sl1-reader.*.json`, `*.password.txt`) and referenced by path, so no key value sits inside an environment value. `git clean -fdx` removes ignored files too — keep a copy outside the repo.

## 7. Retirement

The credentials retire with the adapters they justify, not later.

**Condition:** revisit and retire the direct credential path **no later than the C6 transition, before assisted effects** — the same boundary TD-5 sets for the bootstrap adapters. Once any prospect-facing effect is enabled, pre-effect freshness reads run exclusively on the C6 bounded path.

**Mechanism:** `disconnectOrganizationToolSecret` blanks the ciphertext while keeping the row, so what was once bound stays auditable and no material remains at rest. Revoking the IAM grant and the Atlas user is the second half and is a human action.

**Interim tightening, if the window lengthens:** narrow the Atlas grant from database-level `read` on `bot` + `gu2` to a collection-level `find` on `gu2.appointments`. Firestore cannot be narrowed by IAM at all; its containment stays the code allowlist plus the per-read Organization binding check, which is the arrangement TD-5 accepted.
