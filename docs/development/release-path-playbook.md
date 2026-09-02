# Gu OS Development & Release Path — operational playbook

> **Version:** v1.1
> **Status:** Canonical operational playbook for migration, CI, staging delivery and release execution
> **Artifact role:** Tool- and environment-specific execution detail. The **HOW Gu OS development is governed** lives in [`agentic-product-software-development-methodology.md`](agentic-product-software-development-methodology.md); the deterministic **enforcement** lives in `scripts/` and `.github/workflows/`. This document is the third thing: how to actually run them.
> **Scope:** does not decide product behavior, architecture or release authority.

## 1. The path

```
approved Spec / Architecture / Technical Plan / Slice contract + DoD + Release Scope
  → agent implementation, including the tests the DoD requires
  → local verification
  → commit / push
  → CI: deterministic verification in a clean disposable environment
  → controlled delivery to staging          (manual dispatch)
  → hosted staging verification / evidence
  → human release gate where consequential
  → controlled production delivery
  → post-deploy verification / canary / observability
```

Humans keep product intent, consequential architecture decisions, acceptable risk and production release authority. The coding agent executes autonomously inside approved scope and escalates only on a real contradiction, a missing consequential decision, an architecture or product-behavior change, an authority/risk increase, or a release gate.

**Not every slice runs the whole path.** How far a slice must go is its declared Release Scope (§5). A slice is Done when its own acceptance contract, DoD and Release Scope evidence are satisfied — merged, CI green and delivered-to-staging are each evidence at one layer, not Done.

## 2. Two migration eras (B′)

| | Frozen legacy era | Forward era |
|---|---|---|
| Location | `packages/db/supabase/migrations` | `packages/db/forward/supabase/migrations` |
| Files | 87, historical, **immutable** | timestamped, growing |
| Versions | 5-digit, three duplicated (`00036`/`00044`/`00045`) | 14-digit UTC, globally unique |
| Applied by | ordered-apply (`npm run deliver:legacy`) | Supabase CLI (`npm run deliver:forward`) |
| CLI history | none, and never | `supabase_migrations.schema_migrations` |

**Why.** `schema_migrations` keys on `version`. Two legacy files share a version, so `db push` over that directory aborts at the first duplicate with a primary-key violation, and `migration repair` does not help. Those files are already applied to deployed environments, so renumbering is not available. The CLI's `--workdir` makes the split clean: it sees only the forward era.

**No baseline.** A remote-only baseline row produces `Remote migration versions not found in local migrations directory` — synthetic drift the CLI then polices forever. `schema_migrations` is created by the **first genuine post-cutover migration**. Until then the forward directory is legitimately empty.

**Ordering.** 14-digit timestamps sort after every 5-digit version, so `legacy → forward` is one deterministic total order across two directories.

## 3. Everyday commands

```bash
npm run migration:new -- add_widget_table      # forward-era migration, correct version
npm run validate:migrations                    # frozen integrity + forward structure
npm run test:migration-path                    # the mechanisms' own selftests
npm run test:rls                               # LOCAL ONLY — see the warning below
```

**`npm run test:rls` is local-only, permanently.** It begins by dropping the `public`, `storage` and `auth` schemas. Against a hosted Supabase project that would destroy the auth service, not merely the data. Its `DATABASE_URL` guard rejecting hosted hostnames is a backstop, not a licence.

### Adding a migration

1. `npm run migration:new -- <name>` — writes into the forward workdir with a unique timestamp.
2. Edit it. Keep it additive and reversible-by-flag where it carries behavior.
3. `npm run validate:migrations` and `npm run test:rls` locally.
4. Commit → CI rebuilds a fresh database through **both eras** and reruns the suites.
5. Deliver to staging by manual dispatch, then verify.

### Changing a legacy migration

You cannot, and **two independent invariants** enforce that. Either alone is insufficient:

| Invariant | Where | What it catches |
|---|---|---|
| **Content** | `npm run validate:migrations` | the on-disk chain no longer matches the manifest — an edit, addition, removal or rename |
| **Change** | `node scripts/check-frozen-paths.mjs <base> <head>` in CI | the diff touches a frozen migration *or the manifest itself* |

The content check alone is defeatable: edit a frozen migration, run `migrations:freeze -- --confirm`, and it passes again. `--confirm` is **not** a governance boundary — an agent can supply it too. The change invariant fails on the diff regardless, so a coordinated migration+manifest edit cannot land through a normal PR or push.

There is deliberately **no routine override flag**. Regenerating the manifest is break-glass repository maintenance: it requires a human with authority to bypass the check at the repository level (admin merge or a temporary branch-protection exception), which is visible and auditable rather than a switch any change can flip. Introducing the manifest for the first time is allowed, because it did not exist at the base commit.

**Forward migrations are the only normal migration path.**

## 4. Target configuration — fail closed

Every script that can reach a hosted database resolves its target through `scripts/lib/target-env.ts`:

| Variable | Purpose |
|---|---|
| `GUOS_TARGET_ENV` | environment name, e.g. `staging` |
| `GUOS_TARGET_PROJECT_REF` | positive binding — asserted before any write |
| `GUOS_TARGET_DATABASE_URL` | session pooler, port 5432 |
| `GUOS_TARGET_SUPABASE_URL` | optional, for hosted API checks |
| `GUOS_TARGET_PUBLISHABLE_KEY` | optional, public client credential |
| `GUOS_TARGET_SERVICE_ROLE_KEY` | optional, **only** where a slice genuinely needs admin operations |

A missing variable is a **hard error**, never a fallback. Locally, `--env-file .env.staging.local --env staging` maps `GUOS_STAGING_SUPABASE_*` onto those names.

**Naming.** New infrastructure uses `PUBLISHABLE_KEY`, matching the modern Supabase key form (`sb_publishable_…`), rather than institutionalising the legacy `anon` wording. The old envelope name `GUOS_*_ANON_KEY` is **rejected, not aliased** — two names for one thing is the ambiguity the rename removes. Unrelated application runtime naming is unchanged: `runtimeEnvFor()` maps the publishable value onto `NEXT_PUBLIC_SUPABASE_ANON_KEY` for child processes that expect it.

**Least privilege.** The generic staging workflow supplies only the project ref, URL, publishable key and database URL. No privileged service credential is provided; slice-specific verification that genuinely requires admin operations adds one under its own governed configuration.

This matters because `scripts/bootstrap-organization.ts` merges `apps/web/.env.local` beneath `process.env`: an unset variable there resolves to the application's configuration — production. When invoking it against a non-default environment, map **all four** runtime names (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) so nothing can fall through, and assert the project ref before writing.

Secrets never enter tracked files, logs or command output. `.env.staging.local` is git-ignored via `.env.*.local`. Never reuse a production credential for another environment.

## 5. Four verification layers — do not collapse them

| Layer | Runs where | Answers |
|---|---|---|
| Local tests | developer machine | does my implementation behave? |
| **CI** | clean disposable environment | is it deterministically correct, independent of my machine? |
| **Hosted verification** | real hosted environment | does the deployed thing behave in a real project? |
| **Post-release** | production, after release | did the release do what we expected? |

Hosted and post-release verification are **additional layers**, never substitutes for implementation tests or CI. The deterministic suites remain the release-gating evidence.

**Release Scope selects how far down this list a slice must go; it does not collapse the list.** A slice declares RS-1 (deterministic), RS-2 (hosted) or RS-3 (production) at readiness — see Methodology §14.2 — and each scope *adds* a layer rather than excusing an earlier one. RS-2 does not retire the CI evidence RS-1 owes; RS-3 does not retire either.

| Release Scope | Layers this playbook runs | Sections |
|---|---|---|
| RS-1 | local tests + CI | §3, §10 |
| RS-2 | RS-1 + staging delivery and hosted verification | §6 |
| RS-3 | RS-2 + the production release path | §7 |

`npm run verify:hosted -- --env staging --groups smoke,schema,security --json evidence.json` is read-only, non-destructive, and emits an evidence file. Slice-specific business assertions belong in that slice's own evidence run, not hardcoded here as universal CI.

## 6. Staging delivery

Manual dispatch: **Actions → Deliver to staging**, with `sha` (required), `apply` (default `false` = dry-run) and `verify` (default `true`).

**Dispatch is the trigger, not the authority.** For a mutating APPLY the invariant is:

```
requested SHA == current main HEAD   AND   green required CI for that exact SHA
```

not `workflow_dispatch → eligible`, and not merely main-line ancestry. Ancestry is deliberately too weak here: a historical commit may have had green CI while carrying a **forward-migration era that has since moved on**, so delivering it would apply a stale set. Compare status must be `identical`, not `behind`.

A **dry-run** cannot mutate hosted state, so it relaxes to main-line ancestry (`identical` or `behind`) and is useful for diagnostics against historical commits.

**The approval-time race is closed by revalidating.** The eligibility job runs before the deployment waits on the environment's protection rules, and `main` can advance during that wait. The mutating job therefore re-runs the same `--require-head --require-green` check **immediately before the hosted write**. If `main` moved, it fails closed and a new dispatch for the new HEAD is required — the older SHA is never silently delivered.

The delivery job checks out the requested SHA explicitly rather than the branch tip.

GitHub applies a second, independent layer: the `staging` Environment's deployment branch policy must permit only `main`.

**Serialization.** Two mutating deliveries can never overlap: the workflow carries `concurrency: deliver-staging` and the mutating job carries `deliver-staging-mutate`, both with `cancel-in-progress: false`. A queued dispatch waits; a running migration is never cancelled because another delivery was requested.

Green CI still does not *entitle* a commit to mutate a hosted environment — it only makes it eligible. Delivery remains a decision, which is why this is not automated on push.

## 7. Production release path — defined, not automated

```
CI green
  → staging evidence green
  → explicit production authorization (human)
  → READ-ONLY production preflight        npm run preflight:schema
  → migrate / deploy
  → post-deploy smoke + invariant checks  npm run verify:hosted
  → canary / flags / observability
  → widen, or roll back / disable
```

There is deliberately **no production delivery workflow**. Creating one is a separate decision requiring its own review.

This path runs **only for RS-3 slices**. A slice that declared RS-1 or RS-2 does not enter it, and raising a slice to RS-3 mid-flight is a human decision at the authority boundary its change class implies — never an agent one.

**Never assume production's migration state.** Production has no `supabase_migrations.schema_migrations` — its chain was applied by hand — so the absence of history proves nothing about what is applied. `npm run preflight:schema` establishes actual state read-only and reports `READY` / `PARTIAL` / `ALREADY APPLIED` / `BLOCKED`.

**R1 specifically:** Gate B requires that preflight before `00080`–`00084` reach production.

## 8. Human setup that cannot be done from the repo

| What | Kind | Where | Why it cannot be automated here |
|---|---|---|---|
| Environment `staging` | — | Settings → Environments | Environments and their protection rules are repository settings |
| Required reviewers on `staging` | protection rule | that environment | This is the approval control itself; weakening it to automate it defeats it |
| Deployment branches: **`main` only** | protection rule | that environment | Second, independent layer under the eligibility check |
| `GUOS_STAGING_SUPABASE_PROJECT_REF` | **variable** | that environment | Public identifier — not a secret |
| `GUOS_STAGING_SUPABASE_URL` | **variable** | that environment | Public identifier — not a secret |
| `GUOS_STAGING_SUPABASE_PUBLISHABLE_KEY` | **variable** | that environment | Publishable by design — not a secret |
| `GUOS_STAGING_SUPABASE_DATABASE_URL` | **secret** | that environment | Embeds the database password |
| Branch protection on `main` | protection rule | Settings → Branches | Repository setting; also what makes the frozen-era bypass auditable |
| A production environment | — | not yet | Deliberately absent until Gate B is authorized |

Classifying public identifiers as secrets is not free: it makes them unreadable in logs and harder to debug for no security gain. Only the connection string is a secret here.

Until the `staging` environment and its configuration exist, the delivery workflow fails closed. That is the intended behavior: document the control rather than weaken it.

**Reviewer policy.** Required reviewers on `staging` are an intentionally conservative starting point for v1. They can be relaxed later if evidence supports autonomous staging delivery — that is a governed decision, not a default. **Production release authority remains explicitly human-gated regardless**, and no amount of staging evidence changes that.

Both `deliver` **and** `verify` sit behind that gate, so a delivery costs two approvals. That is known friction, and it is deliberate: `verify-hosted` is read-only *by mechanism*, but the `GUOS_STAGING_SUPABASE_DATABASE_URL` credential it receives is itself write-capable. Moving that credential to an ungated environment would weaken the real authority boundary even though the current script only reads. Removing the second approval therefore requires a genuinely read-only database credential or role for verification, or another design preserving equivalent authority isolation — not merely a second environment without reviewers.

## 9. Destructive Git experiments run in an isolated worktree

Destructive Git operations — `reset --hard`, `clean -fd`, checkout over local work, deliberate tamper tests of the frozen migration era, freeze/regenerate experiments, or anything that rewrites tracked state to prove a control works — **must not run in the primary working tree** that holds user or implementation work.

They are indistinguishable from ordinary commands until after they have destroyed something: `git reset --hard <base>` reverts *every* tracked file to that commit, not just the experiment's, and silently discards uncommitted implementation work along with it.

Use a throwaway location instead:

```bash
git worktree add --detach /tmp/demo HEAD   # isolated checkout, shares history
# …tamper, commit, run the check, observe the failure…
git worktree remove --force /tmp/demo
```

Copy any not-yet-committed scripts the demonstration needs into that worktree rather than running the experiment where they live. When a worktree has a junctioned or symlinked `node_modules`, remove the link **before** removing the worktree, or the deletion can follow it into the real dependency tree.

If a destructive command has already run in the primary tree, stop and inventory what was lost before continuing — untracked files usually survive, tracked edits do not.

## 10. Tests are part of implementation

A slice's approved DoD decides which tests exist — unit, integration, contract, workflow/eval/replay, E2E, security, migration, or other proportional verification. Writing and running them is inside the agent's autonomous scope, not a separate permission. CI then reruns the deterministic suites independently in a clean environment.
