# SL-1 — hosted evidence record

> **Status:** Partial. **Preliminary run 2026-09-04:** SA-1.2 and SA-1.3 passed, but through the declared legacy target rather than through the Organization-scoped credential path. That path is a Definition-of-Done item in its own right, so this run is **not yet the required RS-2 evidence** — it is superseded by the run that follows credential provisioning. See §4 and §5.
> **Artifact:** [`evidence/sl1-hosted-reads-2026-09-04.json`](evidence/sl1-hosted-reads-2026-09-04.json) — machine-readable run output.
> **Governing contract:** [`slice-plan.md`](slice-plan.md) §4, SL-1 Slice Acceptance Contract.
> **Command:** `npm run verify:legacy-reads` — see [`release-path-playbook.md`](../../../development/release-path-playbook.md) §5.

## 1. Topology — five things that are not the same "staging"

| Moving part | Where it actually is |
|---|---|
| The verifier process | the operator workstation. There is **no deployed Gu OS application runtime in staging**; the gateway code executes inside this script. |
| Gu OS hosted state | **Gu OS staging** (`Gu-OS-Stage`, Supabase project `wdtjqlbsxwiijasicint`) — the only place this run mutates anything |
| Legacy Firestore source | **Traditional Gu production**, project `ungga-full`, via `gu-os-sl1-reader@ungga-full.iam.gserviceaccount.com` (`roles/datastore.viewer`) — **read-only** |
| Legacy Mongo source | a **single Atlas cluster**, production by construction — **read-only**, not consulted by this run |
| Gu OS production | **untouched**. No deployment, no migration, no read |

Every legacy operation was a read. The only hosted mutations in the whole run are Gu OS staging configuration and storage, listed in §5.

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

## 4. Why this run is preliminary, not the required RS-2 evidence

The Definition of Done requires the Organization-scoped credential path itself: lookup and runtime resolution, provider validation, encrypted storage, the `pending_test → active` lifecycle, and hosted evidence *using that path*.

This run did not use it. It built its readers from the explicitly declared legacy target, which exercises the adapters and the capabilities and says **nothing** about whether `organization_tool_secrets` resolves correctly. The run records that honestly — `declared-incomplete`, and the credential path under `notExercised` — and it must not be presented as proof of a path it bypassed.

The blocker is narrow: storing credentials needs `GUOS_STAGING_ENCRYPTION_KEY`, and staging had no canonical application encryption key, because **no Gu OS application runtime is deployed in staging at all**. Establishing that key is a human secret-provisioning action.

The verifier now defaults to the Organization-scoped path (`--readers-from-declared-target` is the explicit opt-out, and it refuses to be combined with a silent assumption), and additionally asserts that the stored credential binds to the declared legacy environment. **SL-1 cannot be Done until the run is repeated through that path.**

## 5. Hosted mutations this run made, and their restoration

Two, both in Gu OS staging, neither in any legacy store:

| Mutation | Prior state | Now |
|---|---|---|
| `organization_feature_flags.relationship_ops` for Alebrixe | **absent** (no row) | **absent** — row removed after the run |
| `organization_tool_secrets` | absent | absent — nothing was stored |

The gateway is inert unless `relationship_ops` is on, so the run had to switch it on. The approved Slice does not require it to stay on, and Technical Plan §5 makes it the Organization-scoped master switch for all of R1 — not something a verifier should leave behind. It was therefore restored to exactly the state it was found in: the row was removed rather than set to `false`, because a row that did not exist before is still a configuration change if it is left behind.

This is now built into the verifier rather than remembered: `--activate-flag-for-run` records the prior state, activates only if needed, and restores it in both the success and the failure path.
