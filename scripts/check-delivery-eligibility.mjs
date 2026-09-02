#!/usr/bin/env node
/**
 * Staging delivery eligibility.
 *
 * A manual dispatch is not, by itself, authority to mutate a hosted
 * environment. For a MUTATING apply the invariant is:
 *
 *   requested SHA == current main HEAD
 *     AND required CI is green for that exact SHA
 *
 * Ancestry alone is deliberately too weak for a forward-only migration path: a
 * historical commit may have had green CI while carrying a migration set that
 * has since moved on, so delivering it would apply a stale forward era.
 *
 * Non-mutating diagnostics (dry-run) may relax to main-line ancestry, since
 * they cannot change hosted state.
 *
 * This check is run TWICE for an apply: once to gate the deployment, and again
 * inside the mutating job immediately before the hosted write. The second run
 * closes the approval-time race — if `main` advanced while the deployment
 * waited for environment approval, the older SHA must not be silently
 * delivered; the run fails closed and a new dispatch is required.
 *
 * Fails closed: any unknown, unreachable or ambiguous state is ineligible.
 *
 * Usage:
 *   node scripts/check-delivery-eligibility.mjs --sha <sha> \
 *        [--require-head] [--require-green] \
 *        [--repo owner/name] [--branch main] [--workflow CI]
 *
 * Reads GITHUB_TOKEN / GH_TOKEN when present (required for private repos).
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const sha = arg("sha", process.env.GITHUB_SHA ?? "");
const repo = arg("repo", process.env.GITHUB_REPOSITORY ?? "");
const branch = arg("branch", "main");
const workflowName = arg("workflow", "CI");
const requireGreen = args.includes("--require-green");
/** Mutating deliveries require the SHA to BE current main HEAD, not merely an ancestor. */
const requireHead = args.includes("--require-head");

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const headers = {
  accept: "application/vnd.github+json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} → HTTP ${res.status}`);
  }
  return res.json();
}

let failed = false;
function check(label, ok, detail = "") {
  if (!ok) failed = true;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    console.error("check-delivery-eligibility: --sha must be a full 40-character commit SHA");
    process.exit(1);
  }
  if (!repo.includes("/")) {
    console.error("check-delivery-eligibility: --repo owner/name is required (or GITHUB_REPOSITORY)");
    process.exit(1);
  }
  console.log(
    `repo=${repo} sha=${sha.slice(0, 7)} branch=${branch} ` +
      `require-head=${requireHead} require-green=${requireGreen}`
  );

  // 1. The commit must be on the allowed main line. compare(base=main, head=sha)
  //    reports "identical" when sha IS main's tip and "behind" when sha is an
  //    ancestor of main. "ahead"/"diverged" means it is not on main.
  let status = "unknown";
  try {
    const cmp = await api(`/compare/${branch}...${sha}`);
    status = cmp.status ?? "unknown";
  } catch (error) {
    check(`commit is reachable on ${branch}`, false, String(error.message));
    console.log("\nINELIGIBLE — fail closed.");
    process.exitCode = 1;
    return;
  }
  if (requireHead) {
    // "identical" means the SHA IS the branch tip. "behind" means it is merely
    // an ancestor — valid history, but a stale forward-migration era.
    check(
      `commit is the current ${branch} HEAD`,
      status === "identical",
      status === "behind"
        ? `compare status: behind — this is a historical ancestor of ${branch}, not its HEAD. ` +
          `Dispatch again for the current HEAD.`
        : `compare status: ${status}`
    );
  } else {
    check(
      `commit is on the ${branch} line`,
      status === "identical" || status === "behind",
      `compare status: ${status}`
    );
  }

  // 2. A successful run of the required workflow for this EXACT sha.
  if (requireGreen) {
    let runs = { workflow_runs: [] };
    try {
      runs = await api(`/actions/runs?head_sha=${sha}&per_page=50`);
    } catch (error) {
      check("required CI run is green for this SHA", false, String(error.message));
    }
    const matching = (runs.workflow_runs ?? []).filter((r) => r.name === workflowName);
    const green = matching.filter((r) => r.status === "completed" && r.conclusion === "success");
    check(
      `"${workflowName}" completed successfully for this exact SHA`,
      green.length > 0,
      matching.length === 0
        ? "no such run found"
        : `${green.length} green of ${matching.length} run(s): ${matching
            .map((r) => `${r.status}/${r.conclusion ?? "-"}`)
            .join(", ")}`
    );
  } else {
    console.log("  ----  green-CI requirement not requested (dry-run path)");
  }

  if (failed) {
    console.log("\nINELIGIBLE — fail closed. A manual dispatch is not sufficient authority to mutate staging.");
    process.exitCode = 1;
    return;
  }
  console.log("\nELIGIBLE for delivery.");
}

main().catch((error) => {
  console.error(`check-delivery-eligibility: ${error.message}`);
  process.exitCode = 1;
});
