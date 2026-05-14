/**
 * Reúne N corridas del POC y produce un reporte agregado: latencia P50/P95
 * por paso, tasa de fallo, errores útiles.
 *
 * Uso: N=20 npm run poc:report
 */
import "dotenv/config";
import {
  loginToUngga,
  createTestListing,
  deleteTestListing,
} from "./steps.mjs";

const N = Math.max(1, Math.min(Number(process.env.N ?? "10") || 10, 200));
const baseUrl = (process.env.UNGGA_STAGING_URL ?? "").trim();
const email = (process.env.UNGGA_STAGING_EMAIL ?? "").trim();
const password = (process.env.UNGGA_STAGING_PASSWORD ?? "").trim();
const title =
  (process.env.UNGGA_TEST_PROPERTY_TITLE ?? "POC test - DELETE ME").trim();

if (!baseUrl || !email || !password) {
  console.error("Missing env vars (see README).");
  process.exit(1);
}

const allMetrics = [];
let failures = 0;

for (let i = 0; i < N; i++) {
  const metrics = [];
  let browser;
  try {
    const session = await loginToUngga({ baseUrl, email, password }, metrics);
    browser = session.browser;
    const id = await createTestListing(session.page, { title }, metrics);
    if (id) await deleteTestListing(session.page, id, metrics);
  } catch {
    failures++;
  } finally {
    if (browser) await browser.close();
  }
  allMetrics.push(metrics);
  console.log(`[poc-report] run ${i + 1}/${N} done (failures so far: ${failures})`);
}

const byStep = new Map();
for (const run of allMetrics) {
  for (const m of run) {
    if (!byStep.has(m.step)) byStep.set(m.step, []);
    byStep.get(m.step).push(m);
  }
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  );
  return sorted[idx];
}

const summary = [];
for (const [step, ms] of byStep) {
  const durations = ms.filter((x) => x.ok).map((x) => x.duration_ms);
  const failed = ms.filter((x) => !x.ok).length;
  summary.push({
    step,
    n: ms.length,
    failures: failed,
    p50_ms: pct(durations, 50),
    p95_ms: pct(durations, 95),
  });
}

console.log(
  JSON.stringify(
    {
      runs: N,
      failures,
      failure_rate: Math.round((failures / N) * 1000) / 10 + "%",
      per_step: summary,
    },
    null,
    2
  )
);
