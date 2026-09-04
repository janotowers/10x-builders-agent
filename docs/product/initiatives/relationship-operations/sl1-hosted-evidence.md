# SL-1 — hosted evidence record

> **Status:** Partial. **SA-1.2 and SA-1.3 evidenced 2026-09-04.** SL-1 is not Done: the Organization-scoped credential path is not yet configured in the target environment, so one Definition-of-Done item remains open. See §4.
> **Artifact:** [`evidence/sl1-hosted-reads-2026-09-04.json`](evidence/sl1-hosted-reads-2026-09-04.json) — machine-readable run output.
> **Governing contract:** [`slice-plan.md`](slice-plan.md) §4, SL-1 Slice Acceptance Contract.
> **Command:** `npm run verify:legacy-reads` — see [`release-path-playbook.md`](../../../development/release-path-playbook.md) §5.

## 1. Environment reached, stated precisely

| Side | Environment | Identity |
|---|---|---|
| Gu OS | **staging** (`Gu-OS-Stage`, project `wdtjqlbsxwiijasicint`) | service credential, this run only |
| Traditional Gu | **production** Firestore project `ungga-full` | `gu-os-sl1-reader@ungga-full.iam.gserviceaccount.com`, `roles/datastore.viewer` |

**Why the legacy side is production.** Alebrixe's records exist only there: the stage Firestore project (`unggafb`) holds no document for the Alebrixe owner uid, so no lead in it resolves to the Alebrixe Organization. SA-1.2 asks for a *real Alebrixe lead*, and there is no other place one exists. This is the run the Slice Plan anticipated when it recorded that the production key "stays unwired until the hosted evidence run".

The read was **read-only**, produced **no prospect-facing effect**, wrote nothing to any legacy store, and touched exactly two allowlisted paths: `leads/{id}` and `leads/{id}/wsp_messeges`, plus `users/{uid}` for owner resolution.

**Human authorization.** The production read was authorized explicitly by the human Accountable for SL-1 before the run, including the delegation of choosing which lead to use.

## 2. What passed

9 of 9 required checks.

**SA-1.2 — a real Alebrixe lead, with provenance and freshness.**

- read through `legacy_lead_get_context`, not through any ad-hoc query;
- provenance complete: `traditional_gu` / `firestore` / `leads/<lead>` / `legacy_lead_get_context` / `bootstrap_direct` / Organization id;
- freshness present and derived from a named source field — `edited_time`, age **32,606,499 s** (~377 days). The lead is genuinely old; the metadata reports that rather than hiding it, which is the point of carrying the field at all;
- containment held: the record's `Asesor` reference resolved through `users/{uid}.organization_id` to the bare owner uid, and that uid resolved through `external_identity_bindings` to the Alebrixe Organization.

**SA-1.3 — thread-aware messages.**

- 50 items returned of 62 present (`truncated: true` at the requested bound), across 1 thread;
- every item names its thread, and every item carries a delivery status;
- direction was inferred for all 50 (24 inbound / 26 outbound).

## 3. What the run did NOT observe, and must not be read as proving

Recorded because an evidence file that only lists successes is not evidence.

- **No `asesor_<phone>` thread on this lead.** The capability models the advisor-thread dimension and the fixture selftests exercise it, but the hosted sample contained only a Gu-number thread. Across the 80 Alebrixe leads examined while choosing one, **none** carried an advisor thread. The audit records advisor threads as a 2026-08-31 addition; either they are rarer than the audit's framing suggests for this Organization, or they post-date these leads. **SL-6 should not assume advisor threads are populated for the pilot.**
- **No `delivery_status`, `source` or `wamid` on any item.** All 50 items normalized to `deliveryStatus: "unknown"` — which is the correct reading of "the source recorded nothing", and exactly why `unknown` is a first-class value rather than a gap. The §15.7 writeback the audit describes was not observed on this lead. **SL-9's delivery-evidence design should verify this on recent traffic before depending on it.**
- **`bindingState: "unbound"`.** No `legacy_lead` binding exists for this lead — SL-2 creates those. The read was safe because ownership containment, not a binding, carried it. This is the discovery case the gateway was designed for, exercised for real.
- **`appointment_get` and `property_get_details` were not exercised against hosted data.** The approved DoD does not require it, and the Slice contract explicitly disclaims the claim. They remain fixture-verified only.
- **The stored-credential path was not exercised.** See §4.

## 4. Open Definition-of-Done item

The DoD requires Organization-scoped secret handling **and** its use. The code exists and is deterministically evidenced — encrypt/decrypt round trip, the `pending_test → active` transition, per-Organization scoping and the fail-closed resolver all pass in `test:organization-tool-secrets`. What has **not** happened is storing the two credentials in the staging environment, because that requires `GUOS_STAGING_ENCRYPTION_KEY` to be the same key the staging runtime decrypts with, and **no staging application runtime, and therefore no staging encryption key, exists yet**.

This run therefore built its readers from the explicitly declared legacy target rather than from a stored credential, and says so: the check is recorded as `declared-incomplete`, and the credential path appears under `notExercised`. It is deliberately not counted as a pass.

**SL-1 cannot be declared Done until that item closes.** What it needs is a decision recorded in the release-path playbook's §8 human-setup table: whether `ENCRYPTION_KEY` becomes a `staging` environment secret now, and where a staging runtime will consume it.
