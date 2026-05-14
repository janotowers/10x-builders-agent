import "dotenv/config";
import {
  loginToUngga,
  createTestListing,
  deleteTestListing,
} from "./steps.mjs";

const baseUrl = (process.env.UNGGA_STAGING_URL ?? "").trim();
const email = (process.env.UNGGA_STAGING_EMAIL ?? "").trim();
const password = (process.env.UNGGA_STAGING_PASSWORD ?? "").trim();
const title =
  (process.env.UNGGA_TEST_PROPERTY_TITLE ?? "POC test - DELETE ME").trim();
const cleanup =
  (process.env.UNGGA_TEST_CLEANUP ?? "true").trim().toLowerCase() === "true";

if (!baseUrl || !email || !password) {
  console.error(
    "Missing env: set UNGGA_STAGING_URL, UNGGA_STAGING_EMAIL, UNGGA_STAGING_PASSWORD."
  );
  process.exit(1);
}

const metrics = [];
const t0 = Date.now();
let listingId = null;
let browser;
try {
  const session = await loginToUngga({ baseUrl, email, password }, metrics);
  browser = session.browser;
  listingId = await createTestListing(session.page, { title }, metrics);
  if (cleanup && listingId) {
    await deleteTestListing(session.page, listingId, metrics);
  }
} catch (err) {
  console.error("[create-listing-poc] failed:", err?.message ?? err);
} finally {
  if (browser) await browser.close();
}

const duration_ms = Date.now() - t0;
console.log(
  JSON.stringify(
    { run: "create-listing", duration_ms, listing_id: listingId, metrics },
    null,
    2
  )
);
