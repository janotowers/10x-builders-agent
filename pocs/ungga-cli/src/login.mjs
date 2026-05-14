import "dotenv/config";
import { loginToUngga } from "./steps.mjs";

const baseUrl = (process.env.UNGGA_STAGING_URL ?? "").trim();
const email = (process.env.UNGGA_STAGING_EMAIL ?? "").trim();
const password = (process.env.UNGGA_STAGING_PASSWORD ?? "").trim();

if (!baseUrl || !email || !password) {
  console.error(
    "Missing env: set UNGGA_STAGING_URL, UNGGA_STAGING_EMAIL, UNGGA_STAGING_PASSWORD (see README)."
  );
  process.exit(1);
}

const metrics = [];
const t0 = Date.now();
try {
  const { browser } = await loginToUngga({ baseUrl, email, password }, metrics);
  await browser.close();
} catch (err) {
  console.error("[login-poc] failed:", err?.message ?? err);
}
const duration_ms = Date.now() - t0;
console.log(JSON.stringify({ run: "login", duration_ms, metrics }, null, 2));
