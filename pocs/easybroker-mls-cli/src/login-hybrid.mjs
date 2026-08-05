import "dotenv/config";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchEasyBrokerContext } from "./steps.mjs";

/**
 * Login híbrido: autollenado de credenciales (mismo stealth que el POC) +
 * espera asistida. Si aparece un reCAPTCHA de checkbox intenta marcarlo; si
 * escala a desafío de imágenes o MFA, la ventana visible permite resolverlo
 * a mano sin reiniciar el flujo. Al detectar sesión activa guarda
 * storage-state.json, que reutilizan search-mls y las tools del agente.
 */

const LOGIN_URL =
  process.env.EASYBROKER_WEB_URL?.trim() ||
  "https://www.easybroker.com/mx/account/authentication/new";
const MLS_URL =
  "https://www.easybroker.com/agent/mls_properties/search/propiedades-en-venta-o-renta?network_search=true";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultStateFile = path.resolve(here, "..", "storage-state.json");
const stateFile =
  process.env.EASYBROKER_MLS_STORAGE_STATE?.trim() || defaultStateFile;

const EMAIL = process.env.EASYBROKER_WEB_EMAIL?.trim();
const PASSWORD = process.env.EASYBROKER_WEB_PASSWORD?.trim();
if (!EMAIL || !PASSWORD) {
  console.log(JSON.stringify({ ok: false, error: "missing_credentials" }));
  process.exit(1);
}

const LOGGED_IN_PATTERNS = [
  /\/manager(?:\/|$|\?)/i,
  /\/agent\/mls_properties/i,
  /\/dashboard/i,
];

function looksLoggedIn(url) {
  return LOGGED_IN_PATTERNS.some((re) => re.test(url));
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function clickIfVisible(page, locators) {
  const item = await firstVisible(locators);
  if (!item) return false;
  await item.click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function tryCheckRecaptcha(page) {
  // Checkbox clásico dentro del iframe anchor. Si escala a imágenes, queda
  // en manos del humano frente a la ventana.
  try {
    const frame = page.frameLocator('iframe[src*="recaptcha/api2/anchor"]');
    const box = frame.locator("#recaptcha-anchor");
    if (await box.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await box.click({ timeout: 5_000 }).catch(() => {});
      console.log("  · reCAPTCHA checkbox: click intentado");
      await page.waitForTimeout(2_500);
      return true;
    }
  } catch {
    /* noop */
  }
  return false;
}

async function fillLoginForm(page) {
  await clickIfVisible(page, [
    page.getByRole("button", { name: /^ignorar$/i }),
    page.getByText(/^ignorar$/i),
  ]);
  await clickIfVisible(page, [
    page.getByText(/continuar con email/i),
    page.getByRole("button", { name: /email/i }),
    page.getByRole("link", { name: /email/i }),
  ]);

  const emailInput = await firstVisible([
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.getByLabel(/email|correo/i),
  ]);
  if (emailInput) {
    await emailInput.click({ timeout: 5_000 }).catch(() => {});
    await emailInput.fill("");
    await emailInput.type(EMAIL, { delay: 35 });
    if (!(await page.locator('input[type="password"]').first().isVisible().catch(() => false))) {
      const cont = await firstVisible([
        page.getByRole("button", { name: /^\s*continuar\s*$/i }),
        page.locator('button[type="submit"]'),
      ]);
      if (cont) await cont.click({ timeout: 8_000 }).catch(() => {});
      else await emailInput.press("Enter").catch(() => {});
      await page
        .waitForSelector('input[type="password"]', { timeout: 15_000, state: "visible" })
        .catch(() => {});
    }
  }

  const passwordInput = await firstVisible([
    page.locator('input[type="password"]'),
    page.getByLabel(/contraseña|password/i),
  ]);
  if (!passwordInput) return false;
  await passwordInput.click({ timeout: 5_000 }).catch(() => {});
  await passwordInput.fill("");
  await passwordInput.type(PASSWORD, { delay: 35 });

  await tryCheckRecaptcha(page);

  const submit = await firstVisible([
    page.getByRole("button", { name: /iniciar\s*sesi[oó]n|ingresar|entrar|login/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (submit) await submit.click({ timeout: 8_000 }).catch(() => {});
  else await passwordInput.press("Enter").catch(() => {});
  return true;
}

async function waitForLoggedIn(page, context) {
  const maxMs = Number(process.env.EASYBROKER_ASSISTED_TIMEOUT_MS ?? "480000");
  const deadline = Date.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 480_000);
  let lastUrl = "";
  let recaptchaRetries = 0;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      console.log(`  · URL actual: ${url}`);
      lastUrl = url;
    }
    if (looksLoggedIn(url)) {
      const cookies = await context.cookies();
      const hasSession = cookies.some(
        (cookie) =>
          typeof cookie.domain === "string" &&
          /easybroker\.com$/i.test(cookie.domain) &&
          !/_grecaptcha/i.test(cookie.name ?? "")
      );
      if (hasSession) {
        const body = await page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
        if (!/403\s*Forbidden|Access denied/i.test(body)) return true;
      }
    }
    if (recaptchaRetries < 3 && (await tryCheckRecaptcha(page))) {
      recaptchaRetries += 1;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

let browser;
try {
  const session = await launchEasyBrokerContext({
    headless: false,
    useStorageState: false,
  });
  browser = session.browser;
  const { context, page } = session;
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  const filled = await fillLoginForm(page);
  console.log(
    filled
      ? "Credenciales enviadas; esperando sesión (si hay CAPTCHA/MFA, resuélvelo en la ventana)…"
      : "No se encontró formulario; completa el login manualmente en la ventana…"
  );
  const ok = await waitForLoggedIn(page, context);
  if (!ok) {
    throw new Error(
      "Tiempo de espera agotado sin sesión de EasyBroker. Reintenta y completa CAPTCHA/MFA en la ventana."
    );
  }
  // Asegurar que la sesión cubre el MLS antes de persistir.
  await page.goto(MLS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await mkdir(path.dirname(stateFile), { recursive: true });
  const state = await context.storageState();
  const cookieCount = state.cookies.filter(
    (cookie) =>
      typeof cookie.domain === "string" && /easybroker\.com$/i.test(cookie.domain)
  ).length;
  if (cookieCount === 0) {
    throw new Error("Sin cookies de easybroker.com; no se guardó el estado.");
  }
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        message: "Sesión guardada.",
        storage_state: stateFile,
        easybroker_cookies: cookieCount,
        final_url: page.url(),
      },
      null,
      2
    )
  );
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
