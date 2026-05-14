/**
 * Pasos Playwright compartidos para el POC contra Ungga.
 * Los selectores son placeholders: ajústalos al DOM real de app.ungga.com.
 */
import { chromium } from "playwright";

/**
 * @param {{ baseUrl: string; email: string; password: string }} creds
 * @param {Array<Record<string, unknown>>} metrics
 */
export async function loginToUngga(creds, metrics = []) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };

  const tLogin = Date.now();
  try {
    const loginUrl = `${creds.baseUrl.replace(/\/$/, "")}/login`;
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60_000 });
    // TODO: reemplazar por selectores reales del formulario de Ungga
    await page.getByLabel(/correo|email/i).fill(creds.email);
    await page.getByLabel(/contraseña|password/i).fill(creds.password);
    await page.getByRole("button", { name: /entrar|iniciar|login|sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 60_000 });
    push("login", true, Date.now() - tLogin);
  } catch (e) {
    push("login", false, Date.now() - tLogin, e?.message ?? String(e));
    await browser.close();
    throw e;
  }

  return { browser, page };
}

/**
 * Crea un listing mínimo de prueba. Devuelve un id simulado o real si la UI lo expone.
 * @param {import('playwright').Page} page
 * @param {{ title: string }} opts
 * @param {Array<Record<string, unknown>>} metrics
 */
export async function createTestListing(page, opts, metrics = []) {
  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };

  const t0 = Date.now();
  try {
    // TODO: navegar al flujo real "nueva propiedad" en Ungga
    await page.goto(page.url(), { waitUntil: "domcontentloaded" });
    const titleField = page.getByLabel(/título|title/i).first();
    if (await titleField.count()) {
      await titleField.fill(opts.title);
    }
    const submit = page.getByRole("button", { name: /guardar|crear|publicar|save/i }).first();
    if (await submit.count()) await submit.click();
    push("create_listing", true, Date.now() - t0);
    return "unknown-listing-id";
  } catch (e) {
    push("create_listing", false, Date.now() - t0, e?.message ?? String(e));
    throw e;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} listingId
 * @param {Array<Record<string, unknown>>} metrics
 */
export async function deleteTestListing(page, listingId, metrics = []) {
  const t0 = Date.now();
  try {
    // TODO: implementar borrado si Ungga expone listado + eliminar
    if (listingId && listingId !== "unknown-listing-id") {
      /* noop until selectors exist */
    }
    metrics.push({ step: "delete_listing", ok: true, duration_ms: Date.now() - t0 });
  } catch (e) {
    metrics.push({
      step: "delete_listing",
      ok: false,
      duration_ms: Date.now() - t0,
      error: e?.message ?? String(e),
    });
  }
}
