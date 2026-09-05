# SL-1 — hosted evidence record

> **Status:** **RS-2 hosted evidence — complete and closed.** SA-1.2 and SA-1.3 were satisfied on 2026-09-05 through the Organization-scoped credential path, with the `pending_test → active` lifecycle observed in hosted staging. This is the record of what those runs established; SL-1's completion is recorded in [`slice-plan.md`](slice-plan.md) §6.
> **Artifacts:** [`evidence/sl1-credential-lifecycle-2026-09-05.json`](evidence/sl1-credential-lifecycle-2026-09-05.json) · [`evidence/sl1-hosted-reads-2026-09-05-organization-credential.json`](evidence/sl1-hosted-reads-2026-09-05-organization-credential.json) · preliminary run: [`evidence/sl1-hosted-reads-2026-09-04.json`](evidence/sl1-hosted-reads-2026-09-04.json)
> **Governing contract:** [`slice-plan.md`](slice-plan.md) §4, SL-1 Slice Acceptance Contract.
> **Commands:** `npm run bootstrap:legacy-credentials`, then `npm run verify:legacy-reads` — see [`release-path-playbook.md`](../../../development/release-path-playbook.md) §4.1 and §5.

## 1. Topology — five things that are not the same "staging"

| Moving part | Where it actually is |
|---|---|
| The verifier process | the operator workstation. There is **no deployed Gu OS application runtime in staging**; the gateway code executes inside this script. |
| Gu OS hosted state | **Gu OS staging** (`Gu-OS-Stage`, Supabase project `wdtjqlbsxwiijasicint`) — the only place these runs mutate anything. The Organization is identified in the artifacts by a stable digest rather than its uuid |
| Legacy Firestore source | **Traditional Gu production**, project `ungga-full`, via `gu-os-sl1-reader@ungga-full.iam.gserviceaccount.com` (`roles/datastore.viewer`) — **read-only** |
| Legacy Mongo source | a **single Atlas cluster**, production by construction — **read-only**, one `estimatedDocumentCount` during the credential check |
| Gu OS production | **untouched**. No deployment, no migration, no read |

Every legacy operation was a read. The only hosted mutations are Gu OS staging configuration and storage, listed in §5.

**Why the legacy side is production.** Alebrixe's records exist only there: the stage Firestore project (`unggafb`) holds no document for the Alebrixe owner uid, so no lead in it resolves to the Alebrixe Organization. SA-1.2 asks for a *real Alebrixe lead*, and there is no other place one exists. This is the run the Slice Plan anticipated when it recorded that the production key would stay deliberately unwired until the hosted evidence run, and the reads sit inside approved SL-1 execution authority as set out in [`sl1-legacy-read-credentials.md`](sl1-legacy-read-credentials.md) §5.

**Human authorization.** The production read was authorized explicitly by the human Accountable for SL-1, including the delegation of selecting the lead.

## 2. Credential lifecycle, observed in hosted staging

Before any read, the two read identities were stored as Organization-scoped credentials and proven. The lifecycle was captured **as a transition**, not inferred from its end state — the row is read back between storage and the connection check:

| Provider | After upsert | Connection check | After check | Identity metadata stored |
|---|---|---|---|---|
| `traditional_gu_firestore` | `pending_test` | **passed** — `leads` readable | **`active`** | project `ungga-full`, `gu-os-sl1-reader@ungga-full…` |
| `traditional_gu_mongo` | `pending_test` | **passed** — `gu2.appointments` reachable, ~9,379 documents | **`active`** | Atlas host `sha256:3c877b0464148c63`, database `gu2` |

Three things this establishes beyond the deterministic selftests:

- **New material is never born trusted.** Both providers landed `pending_test` even though this was a re-run over existing rows — a replacement does not inherit `active`. That re-run is also the rotation path, exercised.
- **The Mongo source is `gu2.appointments`**, reached by the delivered identity, matching what the Traditional Gu team confirmed.
- **Only identity metadata is readable without decrypting.** The stored `config_jsonb` carries project, client email, host and database — the Atlas host is digested in the committed artifact, since the evidence needs the cluster to be *stable*, not readable. The private key and the password-bearing URI live in `encrypted_secret_jsonb`. No **metadata** projection selects that column - `PUBLIC_COLUMNS` is a literal, so a future `select("*")` cannot widen it - while the **server-only runtime resolver** necessarily does select and decrypt it, which is how an adapter gets a credential at all. Those are different paths, and the distinction is the point: nothing that can reach a browser or a user JWT touches the column.

The connection check distinguishes three outcomes rather than two. `unreachable` — a network-shaped failure occurring before any credential is evaluated — leaves the credential at `pending_test` rather than marking it `invalid`, because "this machine cannot reach the provider" is not evidence that a credential is bad. Both checks here returned `passed`.

## 3. The RS-2 run — 13 of 13 required checks

Readers were resolved **through `organization_tool_secrets`**: the run supplied no credential of its own, only the declared environment's encryption key, which is what makes the decrypt half of that path real rather than simulated. Two assertions exist specifically to keep that honest:

- `readerSource: "organization_credential"` is recorded in the artifact;
- the stored credential is asserted to bind to the declared legacy environment (`stored project ungga-full, declared prod = ungga-full`), so a run cannot produce evidence labelled with the wrong environment.

**SA-1.2 — a real Alebrixe lead, with provenance and freshness.**

- read through `legacy_lead_get_context`, not through any ad-hoc query;
- provenance complete: `traditional_gu` / `firestore` / `leads/<lead>` / `legacy_lead_get_context` / `bootstrap_direct` / Organization id;
- freshness present and derived from a named source field — `edited_time`, age **32,621,809 s** (~377 days). The lead is genuinely old; the metadata reports that rather than hiding it, which is the point of carrying the field;
- containment held: the record's `Asesor` resolved through `users/{uid}.organization_id` to the bare owner uid, and that uid resolved through `external_identity_bindings` to the Alebrixe Organization.

**SA-1.3 — thread-aware messages.**

- 50 items of 62 present (`truncated: true` at the requested bound), across 1 thread;
- every item names its thread; every item carries a delivery status;
- direction inferred for all 50 (24 inbound / 26 outbound).

## 4. What the run did NOT observe, and must not be read as proving

Recorded because an evidence file that only lists successes is not evidence.

- **No `asesor_<phone>` thread on this lead.** The capability models the advisor-thread dimension and the fixture selftests exercise it, but the hosted sample contained only a Gu-number thread. Across the 80 Alebrixe leads examined while selecting one, **none** carried an advisor thread. The audit records advisor threads as a 2026-08-31 addition; either they are rarer for this Organization than that framing suggests, or they post-date these leads. **SL-6 should not assume advisor threads are populated for the pilot.**
- **No `delivery_status`, `source` or `wamid` on any item.** All 50 normalized to `deliveryStatus: "unknown"` — the correct reading of "the source recorded nothing", and exactly why `unknown` is a first-class value rather than a gap. The §15.7 writeback the audit describes was not observed on this lead. **SL-9's delivery-evidence design should verify it on recent traffic before depending on it.**
- **`bindingState: "unbound"`.** No `legacy_lead` binding exists for this lead — SL-2 creates those. The read was safe because ownership containment, not a binding, carried it: the discovery case the gateway was designed for, exercised for real.
- **`appointment_get` and `property_get_details` were not exercised against hosted data.** The approved DoD does not require it and the Slice contract explicitly disclaims the claim; they remain fixture-verified. The Mongo *credential* was proven; the Mongo *capability* was not.
- **The cross-tenant / RLS suite did not run locally.** It requires a disposable PostgreSQL, which this machine cannot provide (no Docker daemon). It is not gating here: SL-1 adds no table, policy or RLS change and is not a multi-seat surface — the shared baseline gates those from SL-7 — and CI runs `test:rls` against a pgvector service on every pull request.

## 5. Hosted mutations, and their restoration

All in Gu OS staging. None in any legacy store.

| Mutation | Prior state | Now |
|---|---|---|
| `organization_tool_secrets` (2 rows, Alebrixe) | absent | **present, both `active`** — intended, and part of the Definition of Done |
| `organization_feature_flags.relationship_ops` for Alebrixe | **absent** (no row) | **absent** — row removed after the run |

The gateway is inert unless `relationship_ops` is on, so the run had to switch it on. The approved Slice does not require it to stay on, and Technical Plan §5 makes it the Organization-scoped master switch for all of R1 — not something a verifier leaves behind. It was restored to exactly the state it was found in: the row was **removed** rather than set to `false`, because a row that did not exist before is still a configuration change if it is left behind.

This is built into the verifier rather than remembered. `--activate-flag-for-run` records the prior state, activates only if needed, and restores it on both the success and the failure path.

## 6. The preliminary run of 2026-09-04

Kept, and clearly classified. It passed 9 of 9 checks against the same lead but built its readers from the **declared legacy target**, which exercises the adapters and says nothing about whether `organization_tool_secrets` resolves. It is **not** the required RS-2 evidence and was never counted as such — it recorded `declared-incomplete` and listed the credential path under `notExercised`.

The verifier now defaults to the Organization-scoped path; reading from the declared target is an explicit opt-out that refuses to combine with a silent assumption.

## 7. What this record does and does not settle

This document is **evidence, not status**. It states what two hosted runs established, on which environments, with which identities — facts that do not change afterwards.

Two things it deliberately leaves to their owners:

- **Completion.** Whether the Slice is Done is a judgement against the Acceptance Contract, the Definition of Done and the declared Release Scope, and it belongs to the Done record in [`slice-plan.md`](slice-plan.md) §6. That record cites this evidence; it is not written here.
- **CI and PR state.** RS-2 is "RS-1 plus hosted evidence", and RS-1 includes the required deterministic CI evidence — which runs against a specific commit and is owned by GitHub (Methodology §19.1). No SHA, run number or check verdict is duplicated into this file, because a document that mirrors CI is stale the moment the head moves.

What this evidence supports is narrower and durable: on 2026-09-05, reading through the Organization-scoped credential path, a real Alebrixe lead and its conversation were read from Traditional Gu production into Gu OS staging, with provenance, freshness and Organization containment — and the two credentials reached `active` only after a real connection check proved them.
