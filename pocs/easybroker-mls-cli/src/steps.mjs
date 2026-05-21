import { chromium } from "playwright";
import { mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

const REAL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

function envFlag(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storageStatePath() {
  const fromEnv = process.env.EASYBROKER_MLS_STORAGE_STATE?.trim();
  if (fromEnv) return fromEnv;
  return "storage-state.json";
}

async function fileExists(p) {
  if (!p) return false;
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function launchEasyBrokerContext({ headless, useStorageState = true } = {}) {
  const effectiveHeadless =
    headless ?? envFlag("EASYBROKER_MLS_HEADLESS", false);
  const channel = process.env.EASYBROKER_MLS_CHANNEL?.trim() || "chrome";
  let browser;
  try {
    browser = await chromium.launch({
      headless: effectiveHeadless,
      channel,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  } catch {
    browser = await chromium.launch({
      headless: effectiveHeadless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  const storage = storageStatePath();
  const useStorage = useStorageState && await fileExists(storage);
  const context = await browser.newContext({
    userAgent: REAL_USER_AGENT,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    viewport: { width: 1366, height: 820 },
    extraHTTPHeaders: { "accept-language": "es-MX,es;q=0.9,en;q=0.8" },
    ...(useStorage ? { storageState: storage } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", {
      get: () => ["es-MX", "es", "en-US", "en"],
    });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
  const page = await context.newPage();
  return { browser, context, page, usedStorage: useStorage };
}

export async function loginToEasyBroker(creds, metrics = [], options = {}) {
  const session = await launchEasyBrokerContext({
    useStorageState: options.useStorageState !== false,
  });
  const { browser, context, page, usedStorage } = session;
  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };

  const tLogin = Date.now();
  try {
    const targetMlsUrl = resolveMlsUrl(creds.loginUrl, creds.loginUrl);

    if (usedStorage) {
      const origin = safeOrigin(targetMlsUrl) || "https://www.easybroker.com";
      const managerUrl = `${origin}/manager`;
      await page.goto(managerUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
      }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const managerForbidden = await isForbidden(page);
      metrics.push({
        step: "open_manager_with_storage",
        ok: !managerForbidden,
        url: page.url(),
        ...(managerForbidden ? { error: "403 en /manager" } : {}),
      });
      if (managerForbidden) {
        metrics.push({
          step: "page_diagnostics",
          ok: true,
          ...(await collectPageDiagnostics(page)),
        });
        await maybeCapture(page, "manager-forbidden", metrics, true);
        if (canRetryLoginWithoutStorage(creds, options)) {
          metrics.push({
            step: "storage_state_fallback_to_password_login",
            ok: true,
            reason: "403 en /manager con storageState",
          });
          await browser.close();
          return loginToEasyBroker(creds, metrics, { useStorageState: false });
        }
        throw new Error(antibotMessage(page.url()));
      }
      const navigated = await openMlsFromManager(page, targetMlsUrl, metrics);
      if (navigated && (await isLoggedIn(page, targetMlsUrl))) {
        metrics.push({ step: "login_via_storage_state", ok: true });
        push("login", true, Date.now() - tLogin, undefined);
        return { browser, context, page };
      }
      metrics.push({
        step: "page_diagnostics",
        ok: true,
        ...(await collectPageDiagnostics(page)),
      });
      await maybeCapture(page, "storage-manager-no-mls", metrics, true);
      metrics.push({
        step: "login_via_storage_state",
        ok: false,
        error: "storageState abre /manager pero no llega al MLS sin error.",
      });
      if (canRetryLoginWithoutStorage(creds, options)) {
        metrics.push({
          step: "storage_state_fallback_to_password_login",
          ok: true,
          reason: "storageState no llegó al MLS autenticado",
        });
        await browser.close();
        return loginToEasyBroker(creds, metrics, { useStorageState: false });
      }
      throw new Error(
        "La sesión guardada abre EasyBroker, pero no se pudo navegar a Bolsa Inmobiliaria/MLS desde /manager."
      );
    }

    await page.goto(creds.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
    });
    await page.waitForTimeout(1000);

    if (await isLoggedIn(page, targetMlsUrl)) {
      push("login", true, Date.now() - tLogin, undefined);
      return { browser, context, page };
    }

    if (await isForbidden(page)) {
      metrics.push({
        step: "page_diagnostics",
        ok: true,
        ...(await collectPageDiagnostics(page)),
      });
      await maybeCapture(page, "login-forbidden", metrics, true);
      throw new Error(antibotMessage(page.url()));
    }

    if (!(await hasLoginForm(page))) {
      const openedLogin = await openLoginPage(page, creds.loginUrl, metrics);
      if (!openedLogin) {
        if (await isForbidden(page)) {
          metrics.push({
            step: "page_diagnostics",
            ok: true,
            ...(await collectPageDiagnostics(page)),
          });
          await maybeCapture(page, "login-forbidden", metrics, true);
          throw new Error(antibotMessage(page.url()));
        }
        const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        throw new Error(
          `No se pudo abrir la página de login EasyBroker. Página actual: ${page.url()} — ${body.slice(0, 300)}`
        );
      }
      await prepareEasyBrokerLoginLanding(page, metrics);
      if (!(await hasLoginForm(page))) {
        metrics.push({
          step: "page_diagnostics",
          ok: true,
          ...(await collectPageDiagnostics(page)),
        });
        await maybeCapture(page, "login-no-email-form", metrics, true);
        const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        throw new Error(
          `No se encontró formulario de login EasyBroker tras abrir email. Página actual: ${page.url()} — ${body.slice(0, 300)}`
        );
      }
    } else {
      await dismissEasyBrokerLoginBanners(page, metrics);
    }

    await clickIfVisible(page, [
      page.getByText(/continuar con email/i),
      page.getByRole("button", { name: /email/i }),
      page.getByRole("link", { name: /email/i }),
    ]);

    if (await hasEmailField(page)) {
      const emailInput =
        (await firstVisible([
          page.locator('input[type="email"]'),
          page.locator('input[name*="email" i]'),
          page.getByLabel(/email|correo/i),
          page.locator("input:visible").nth(0),
        ])) ?? page.locator("input:visible").nth(0);
      await emailInput.click({ timeout: 5_000 }).catch(() => {});
      await emailInput.fill("");
      await emailInput.type(creds.email, { delay: 30 });

      if (!(await hasPasswordField(page))) {
        await submitEmailStep(page, emailInput, metrics);
      }
    }

    if (!(await hasPasswordField(page))) {
      metrics.push({
        step: "page_diagnostics",
        ok: true,
        ...(await collectPageDiagnostics(page)),
      });
      await maybeCapture(page, "login-no-password-step", metrics, true);
      throw new Error(antibotMessage(page.url()));
    }

    const passwordInput =
      (await firstVisible([
        page.locator('input[type="password"]'),
        page.getByLabel(/contraseña|password/i),
        page.locator("input:visible").nth(1),
        page.locator("input:visible").nth(0),
      ])) ?? page.locator("input:visible").nth(0);
    await passwordInput.click({ timeout: 5_000 }).catch(() => {});
    await passwordInput.fill("");
    await passwordInput.type(creds.password, { delay: 30 });

    const submitted = await trySubmitLogin(page, passwordInput, metrics);
    if (!submitted) throw new Error("No EasyBroker password submit button found");
    await page.waitForLoadState("domcontentloaded", {
      timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
    }).catch(() => {});
    await page.waitForTimeout(2500);

    await page.goto(targetMlsUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
    }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1200);

    if (!(await isLoggedIn(page, targetMlsUrl))) {
      const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      throw new Error(`EasyBroker login did not reach MLS/authenticated page: ${body.slice(0, 300)}`);
    }
    await saveStorageStateIfRequested(context, metrics);
    push("login", true, Date.now() - tLogin, undefined);
    return { browser, context, page };
  } catch (e) {
    push("login", false, Date.now() - tLogin, e?.message ?? String(e));
    await maybeCapture(page, "login-failed", metrics);
    await browser.close();
    throw e;
  }
}

function canRetryLoginWithoutStorage(creds, options) {
  return (
    options.useStorageState !== false &&
    typeof creds?.email === "string" &&
    creds.email.trim() &&
    typeof creds?.password === "string" &&
    creds.password.trim()
  );
}

function antibotMessage(url) {
  return [
    `EasyBroker bloqueó el acceso automatizado (403 Forbidden o reCAPTCHA) en ${url}.`,
    "Solución: genera una sesión persistente ejecutando una sola vez",
    "`npm --prefix pocs/easybroker-mls-cli run poc:login:assisted` y completa el login",
    "manualmente. El archivo `storage-state.json` resultante se reutilizará en cada",
    "ejecución (configura EASYBROKER_MLS_STORAGE_STATE si lo guardas en otra ruta).",
  ].join(" ");
}

async function saveStorageStateIfRequested(context, metrics = []) {
  const target = storageStatePath();
  if (!target) return;
  try {
    const state = await context.storageState();
    const easyBrokerCookies = state.cookies.filter(
      (cookie) =>
        typeof cookie.domain === "string" &&
        /easybroker\.com$/i.test(cookie.domain)
    ).length;
    if (easyBrokerCookies === 0) {
      metrics.push({
        step: "save_storage_state",
        ok: false,
        error: "No hay cookies de easybroker.com; no se sobreescribió.",
      });
      return;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, JSON.stringify(state, null, 2), "utf8");
    metrics.push({
      step: "save_storage_state",
      ok: true,
      path: target,
      easybroker_cookies: easyBrokerCookies,
    });
  } catch (e) {
    metrics.push({
      step: "save_storage_state",
      ok: false,
      error: e?.message ?? String(e),
    });
  }
}

async function isLoggedIn(page, targetMlsUrl) {
  const url = page.url();
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (isForbiddenText(body)) return false;
  if (await hasLoginForm(page)) return false;
  const onMls = /\/agent\/mls_properties/i.test(url) || url === targetMlsUrl;
  return (
    onMls &&
    /MLS|Bolsa inmobiliaria|Mis propiedades|Cerrar sesión|Publicar propiedad|Propiedades/i.test(body)
  );
}

async function isForbidden(page) {
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return isForbiddenText(body);
}

function isForbiddenText(body) {
  return /403\s*Forbidden|Access denied/i.test(body);
}

async function hasLoginForm(page) {
  return (await hasEmailField(page)) || (await hasPasswordField(page));
}

async function hasEmailField(page) {
  return Boolean(
    await firstVisible([
      page.locator('input[type="email"]'),
      page.locator('input[name*="email" i]'),
      page.locator('input[placeholder*="email" i]'),
      page.locator('input[aria-label*="email" i]'),
      page.getByLabel(/email|correo/i),
    ])
  );
}

async function hasPasswordField(page) {
  return Boolean(
    await firstVisible([
      page.locator('input[type="password"]'),
      page.locator('input[placeholder*="contraseña" i]'),
      page.locator('input[placeholder*="password" i]'),
      page.getByLabel(/contraseña|password/i),
    ])
  );
}

async function submitEmailStep(page, emailInput, metrics = []) {
  const button = await firstVisible([
    page.getByRole("button", { name: /^\s*continuar\s*$/i }),
    page.getByRole("link", { name: /^\s*continuar\s*$/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.locator("button").filter({ hasText: /continuar/i }),
    page.getByText(/^\s*continuar\s*$/i),
  ]);
  if (button) {
    await button.click({ timeout: 10_000 }).catch(() => {});
  } else {
    metrics.push({ step: "email_continue_fallback_enter", ok: true });
    await emailInput.press("Enter").catch(() => {});
  }
  await page.waitForLoadState("domcontentloaded", {
    timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
  }).catch(() => {});
  await page
    .waitForSelector('input[type="password"]', { timeout: 20_000, state: "visible" })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function trySubmitLogin(page, passwordInput, metrics = []) {
  const button = await firstVisible([
    page.getByRole("button", { name: /iniciar\s*sesi[oó]n|ingresar|entrar|login/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.locator("button").filter({ hasText: /iniciar|ingresar|entrar/i }),
  ]);
  if (button) {
    await button.click({ timeout: 10_000 }).catch(() => {});
    return true;
  }
  metrics.push({ step: "password_submit_fallback_enter", ok: true });
  try {
    await passwordInput.press("Enter");
    return true;
  } catch {
    return false;
  }
}

async function openLoginPage(page, configuredUrl, metrics = []) {
  const origin = safeOrigin(configuredUrl) || "https://www.easybroker.com";
  const candidates = [
    configuredUrl,
    `${origin}/mx/account/authentication/new`,
    "https://www.easybroker.com/mx/account/authentication/new",
  ].filter((url, index, list) => url && list.indexOf(url) === index);
  for (const url of candidates) {
    const t0 = Date.now();
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
      });
      await page.waitForTimeout(1200);
      const currentUrl = page.url();
      const ok =
        (await hasLoginForm(page)) || /authentication|sign_in|login/i.test(currentUrl);
      metrics.push({
        step: "open_login_candidate",
        ok,
        duration_ms: Date.now() - t0,
        url: currentUrl,
      });
      if (ok) return true;
    } catch (e) {
      metrics.push({
        step: "open_login_candidate",
        ok: false,
        duration_ms: Date.now() - t0,
        url,
        error: e?.message ?? String(e),
      });
    }
  }
  return false;
}

async function dismissEasyBrokerLoginBanners(page, metrics = []) {
  const dismissed = await clickIfVisible(page, [
    page.getByRole("button", { name: /^ignorar$/i }),
    page.getByText(/^ignorar$/i),
    page.locator("button,a").filter({ hasText: /^ignorar$/i }),
  ]);
  if (dismissed) {
    metrics.push({ step: "dismiss_browser_update_banner", ok: true });
    await page.waitForTimeout(500);
  }
}

async function prepareEasyBrokerLoginLanding(page, metrics = []) {
  await dismissEasyBrokerLoginBanners(page, metrics);
  const clickedEmail = await clickIfVisible(page, [
    page.getByText(/continuar con email/i),
    page.getByRole("button", { name: /continuar con email/i }),
    page.getByRole("link", { name: /continuar con email/i }),
    page.getByRole("button", { name: /^email$/i }),
    page.getByRole("link", { name: /^email$/i }),
    page.locator("button,a,div,span").filter({ hasText: /continuar con email/i }),
  ]);
  metrics.push({ step: "open_email_login", ok: clickedEmail });
  await page.waitForTimeout(1000);
  if (!(await hasEmailField(page)) && clickedEmail) {
    await page.waitForSelector('input[type="email"], input[name*="email" i]', {
      timeout: 10_000,
      state: "visible",
    }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

export async function searchMlsProperties(page, input, metrics = []) {
  const t0 = Date.now();
  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };
  try {
    const mlsUrl = resolveMlsUrl(page.url(), input.mls_url);
    const alreadyInMls = /\/agent\/mls_properties/i.test(page.url());
    const navigated = alreadyInMls
      ? true
      : await openMlsFromManager(page, mlsUrl, metrics);
    if (!navigated || (await isForbidden(page))) {
      metrics.push({
        step: "page_diagnostics",
        ok: true,
        ...(await collectPageDiagnostics(page)),
      });
      await maybeCapture(page, "mls-forbidden", metrics, true);
      throw new Error(antibotMessage(page.url()));
    }
    push("open_mls", true, Date.now() - t0, undefined);

    const filters = await applySearchFilters(page, input);
    const results = await extractResults(page, input.limit ?? 20, input);
    if (filters.length === 0 || results.length === 0) {
      metrics.push({
        step: "page_diagnostics",
        ok: true,
        ...(await collectPageDiagnostics(page)),
      });
      await maybeCapture(page, "mls-no-results", metrics, true);
    }
    push("search_mls", true, Date.now() - t0, undefined);
    return {
      ok: true,
      url: page.url(),
      filters,
      count: results.length,
      results,
    };
  } catch (e) {
    push("search_mls", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "search-failed", metrics);
    throw e;
  }
}

function resolveMlsUrl(currentUrl, configuredUrl) {
  const configured = typeof configuredUrl === "string" ? configuredUrl.trim() : "";
  if (/\/agent\/mls_properties/i.test(configured)) return configured;
  const origin = safeOrigin(configured || currentUrl) || "https://www.easybroker.com";
  return `${origin}/agent/mls_properties/search/propiedades-en-venta-o-renta?network_search=true`;
}

async function openMlsFromManager(page, targetMlsUrl, metrics = []) {
  await page.keyboard.press("Escape").catch(() => {});
  const link = await firstVisible([
    page.getByRole("link", { name: /bolsa\s*inmobiliaria/i }),
    page.locator('nav a').filter({ hasText: /bolsa\s*inmobiliaria/i }),
    page.locator('a').filter({ hasText: /bolsa\s*inmobiliaria/i }),
    page.locator('a[href*="/agent/mls_properties"]'),
  ]);
  if (link) {
    const t0 = Date.now();
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const inMls = /\/agent\/mls_properties/i.test(page.url());
    metrics.push({
      step: "click_mls_link",
      ok: inMls && !(await isForbidden(page)),
      duration_ms: Date.now() - t0,
      url: page.url(),
    });
    if (inMls && !(await isForbidden(page))) return true;
  }

  const textTarget = await firstVisible([
    page.getByText(/bolsa\s*inmobiliaria/i),
  ]);
  if (textTarget) {
    const t0 = Date.now();
    await textTarget.scrollIntoViewIfNeeded().catch(() => {});
    await textTarget.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const inMls = /\/agent\/mls_properties/i.test(page.url());
    metrics.push({
      step: "click_mls_text",
      ok: inMls && !(await isForbidden(page)),
      duration_ms: Date.now() - t0,
      url: page.url(),
    });
    if (inMls && !(await isForbidden(page))) return true;
  }
  const candidates = [
    targetMlsUrl,
    "https://www.easybroker.com/agent/mls_properties/search/propiedades-en-venta-o-renta?network_search=true",
    "https://www.easybroker.com/agent/mls_properties",
  ].filter((url, idx, list) => url && list.indexOf(url) === idx);
  for (const url of candidates) {
    const t0 = Date.now();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
    }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const forbidden = await isForbidden(page);
    const inMls = /\/agent\/mls_properties/i.test(page.url());
    metrics.push({
      step: "open_mls_candidate",
      ok: inMls && !forbidden,
      duration_ms: Date.now() - t0,
      url,
      current_url: page.url(),
    });
    if (inMls && !forbidden) return true;
  }
  return false;
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function applySearchFilters(page, input) {
  const filled = [];
  await page.keyboard.press("Escape").catch(() => {});

  if (input.zona && await applyLocationFilter(page, input.zona)) {
    filled.push("location");
  }

  const operations = [
    ...(input.operation ? [input.operation] : []),
    ...(Array.isArray(input.operations) ? input.operations : []),
  ];
  const preferredOperation = operations.includes("rent")
    ? "rent"
    : operations.includes("sale")
      ? "sale"
      : null;

  const priceApplied = await applyPriceFilter(page, {
    operation: preferredOperation,
    min: input.min_price,
    max: input.max_price,
  });
  if (priceApplied.operation) filled.push(`operation:${priceApplied.operation}`);
  if (priceApplied.min) filled.push("min_price");
  if (priceApplied.max) filled.push("max_price");

  const propertyTypes = [
    ...(input.property_type ? [input.property_type] : []),
    ...(Array.isArray(input.property_types) ? input.property_types : []),
  ].filter((value) => typeof value === "string" && value.trim());
  const typeApplied = await applyPropertyTypeFilter(page, propertyTypes);
  for (const type of typeApplied) filled.push(`property_type:${type}`);

  const moreApplied = await applyMoreFilter(page, input);
  filled.push(...moreApplied);
  const needsUrlSync =
    moreApplied.length > 0 ||
    (input.zona && !(await urlIncludesLocation(page, input.zona)));
  if (needsUrlSync) {
    const synced = await enforceFiltersInSearchUrl(page, input);
    if (synced.location) filled.push("location:reapplied");
    for (const param of synced.exactParams) filled.push(param);
  }
  return filled;
}

async function applyLocationFilter(page, zona) {
  if (!(await openExactTopFilter(page, "Ubicación"))) return false;
  const input = await firstVisible([
    page.getByPlaceholder(/busca una o m[aá]s ubicaciones/i),
    page.locator('input[name*="location" i]:visible'),
    page.locator('input[placeholder*="ubicaciones" i]:visible'),
  ]);
  if (!input) return false;
  await input.fill("");
  await input.type(String(zona), { delay: 25 });
  await page.waitForTimeout(1200);
  await clickLocationSuggestion(page, zona);
  await page.waitForTimeout(700);
  await clickApplyInOpenFilter(page);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return locationLooksApplied(page, zona);
}

async function clickLocationSuggestion(page, zona) {
  const primary = String(zona).split(",")[0]?.trim();
  const suggestion = primary
    ? await firstVisible([
        page.locator("a,li,div,[role=option]").filter({
          hasText: new RegExp(escapeRegex(primary), "i"),
        }),
      ])
    : null;
  if (suggestion) {
    await suggestion.click({ timeout: 10_000 }).catch(() => {});
    return true;
  }
  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  return false;
}

async function locationLooksApplied(page, zona) {
  const primary = String(zona).split(",")[0]?.trim().toLowerCase();
  if (!primary) return false;
  const current = `${page.url()} ${await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const needle = primary
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return current.includes(needle);
}

async function urlIncludesLocation(page, zona) {
  const primary = String(zona).split(",")[0]?.trim();
  if (!primary) return false;
  const needle = primary
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, "-");
  const current = page.url()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return current.includes(needle);
}

async function enforceFiltersInSearchUrl(page, input) {
  const current = new URL(page.url());
  let locationApplied = false;
  if (input.zona) {
    const slug = slugifyLocation(input.zona);
    if (slug) {
      const operation = normalizeOperationHint(input.operation);
      const operationSlug =
        operation === "rent"
          ? "renta"
          : operation === "sale"
            ? "venta"
            : "venta-o-renta";
      current.pathname = `/agent/mls_properties/search/propiedades-en-${operationSlug}-en-${slug}`;
      locationApplied = true;
    }
  }
  const exactParams = [];
  const bedroomParam = applyRoomParam(current, "bedroom", input.bedrooms, input.min_bedrooms, 4);
  if (bedroomParam) exactParams.push(bedroomParam);
  const bathroomParam = applyRoomParam(current, "bathroom", input.bathrooms, input.min_bathrooms, 5);
  if (bathroomParam) exactParams.push(bathroomParam);
  const parkingParam = applyRoomParam(
    current,
    "parking_spaces",
    input.parking_spaces,
    input.min_parking_spaces,
    5
  );
  if (parkingParam) exactParams.push(parkingParam);
  if (!locationApplied && exactParams.length === 0) {
    return { location: false, exactParams: [] };
  }
  await page.goto(current.toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs("EASYBROKER_MLS_TIMEOUT_MS", 60_000),
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return {
    location: locationApplied
      ? await urlIncludesLocation(page, input.zona)
      : false,
    exactParams,
  };
}

function applyRoomParam(url, key, exactValue, minValue, plusAt) {
  const hasExact = exactValue != null;
  const value = hasExact ? exactValue : minValue;
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return false;
  const floored = Math.floor(numeric);
  url.searchParams.set(`min_${key}`, String(floored));
  if (hasExact && floored < plusAt) {
    url.searchParams.set(`max_${key}`, String(floored));
    return `exact:${key}`;
  } else {
    url.searchParams.delete(`max_${key}`);
    return `min:${key}`;
  }
}

function slugifyLocation(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function applyPriceFilter(page, { operation, min, max }) {
  const applied = { operation: null, min: false, max: false };
  if (!(await openTopFilter(page, /precio/i))) return applied;

  if (operation === "rent") {
    if (await clickVisibleText(page, /renta|en\s+renta/i)) applied.operation = "rent";
  } else if (operation === "sale") {
    if (await clickVisibleText(page, /venta|en\s+venta/i)) applied.operation = "sale";
  }

  const inputs = await visibleInputsNear(page, /precio|mínimo|minimo|máximo|maximo|m[ií]nimo|m[aá]ximo/i);
  const visibleInputs = inputs.length
    ? inputs
    : await visibleInputs(page, 'input[type="text"], input[type="number"]', 4);
  if (visibleInputs[0] && min != null) {
    await visibleInputs[0].fill(String(min)).catch(() => {});
    applied.min = true;
  }
  if (visibleInputs[1] && max != null) {
    await visibleInputs[1].fill(String(max)).catch(() => {});
    applied.max = true;
  }

  await clickApplyInOpenFilter(page);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return applied;
}

async function applyPropertyTypeFilter(page, propertyTypes) {
  const applied = [];
  if (!propertyTypes.length) return applied;
  if (!(await openTopFilter(page, /^tipo$/i))) return applied;
  for (const type of propertyTypes) {
    const escaped = escapeRegex(type);
    if (await clickVisibleText(page, new RegExp(`^\\s*${escaped}\\s*$`, "i"))) {
      applied.push(type);
    }
  }
  await clickApplyInOpenFilter(page);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return applied;
}

async function applyMoreFilter(page, input) {
  const applied = [];
  const needsMore =
    input.bedrooms != null ||
    input.min_bedrooms != null ||
    input.bathrooms != null ||
    input.min_bathrooms != null ||
    input.parking_spaces != null ||
    input.min_parking_spaces != null ||
    input.min_area_m2 != null ||
    input.max_area_m2 != null ||
    input.shared_commission_only === true;
  if (!needsMore) return applied;
  if (!(await openExactTopFilter(page, "Más"))) return applied;

  const bedroomFilter = roomFilterValue(input.bedrooms, input.min_bedrooms, 4);
  if (await clickSegmentedFilterOption(page, /rec[aá]maras/i, bedroomFilter.option)) {
    applied.push(`${bedroomFilter.kind}_bedrooms:${bedroomFilter.option}`);
  }
  const bathroomFilter = roomFilterValue(input.bathrooms, input.min_bathrooms, 5);
  if (await clickSegmentedFilterOption(page, /baños|banos/i, bathroomFilter.option)) {
    applied.push(`${bathroomFilter.kind}_bathrooms:${bathroomFilter.option}`);
  }
  const parkingFilter = roomFilterValue(input.parking_spaces, input.min_parking_spaces, 5);
  if (
    await clickSegmentedFilterOption(
      page,
      /estacionamientos|parking/i,
      parkingFilter.option
    )
  ) {
    applied.push(`${parkingFilter.kind}_parking_spaces:${parkingFilter.option}`);
  }

  if (input.min_area_m2 != null) {
    const minConstruction = page.locator('input[name="search_criteria[min_total_square_meters]"]:visible');
    if (await minConstruction.first().isVisible().catch(() => false)) {
      await minConstruction.first().fill(String(input.min_area_m2)).catch(() => {});
      applied.push("min_area_m2");
    }
  }
  if (input.max_area_m2 != null) {
    const maxConstruction = page.locator('input[name="search_criteria[max_total_square_meters]"]:visible');
    if (await maxConstruction.first().isVisible().catch(() => false)) {
      await maxConstruction.first().fill(String(input.max_area_m2)).catch(() => {});
      applied.push("max_area_m2");
    }
  }

  if (input.shared_commission_only === true && await applySharedCommissionFilter(page)) {
    applied.push("shared_commission_only");
  }

  if (applied.length === 0) {
    await page.keyboard.press("Escape").catch(() => {});
    return applied;
  }

  const apply = await firstVisible([
    page.getByRole("button", { name: /aplicar filtros/i }),
    page.locator("button,a").filter({ hasText: /aplicar filtros/i }),
  ]);
  if (apply) {
    await apply.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  return applied;
}

function roomFilterValue(exactValue, minValue, plusAt) {
  if (exactValue != null) {
    return { kind: "exact", option: roomOption(exactValue, plusAt) };
  }
  return { kind: "min", option: roomOption(minValue, plusAt) };
}

function roomOption(value, plusAt) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed >= plusAt) return `${plusAt}+`;
  return String(Math.floor(parsed));
}

async function applySharedCommissionFilter(page) {
  return clickVisibleText(
    page,
    /comparte(?:n)?\s+comisi[oó]n|comisi[oó]n\s+compartida|compartir\s+comisi[oó]n/i
  );
}

async function clickSegmentedFilterOption(page, labelRegex, optionLabel) {
  if (!optionLabel) return false;
  const labels = page.locator("label").filter({ hasText: labelRegex });
  const labelCount = await labels.count().catch(() => 0);
  for (let i = 0; i < Math.min(labelCount, 3); i += 1) {
    const row = labels.nth(i).locator("xpath=ancestor::div[1]");
    const option = row.locator("a").filter({
      hasText: new RegExp(`^\\s*${escapeRegex(optionLabel)}\\s*$`, "i"),
    }).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(250);
      return true;
    }
  }
  return false;
}

async function openTopFilter(page, nameRegex) {
  await page.keyboard.press("Escape").catch(() => {});
  const button = await firstVisible([
    page.getByRole("button", { name: nameRegex }),
    page.locator("button").filter({ hasText: nameRegex }),
    page.locator('[role="button"]').filter({ hasText: nameRegex }),
    page.locator("a").filter({ hasText: nameRegex }),
    page.locator("span").filter({ hasText: nameRegex }),
    page.locator("div").filter({ hasText: nameRegex }),
  ]);
  if (!button) return false;
  await button.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function openExactTopFilter(page, label) {
  await page.keyboard.press("Escape").catch(() => {});
  const clicked = await page.evaluate((targetLabel) => {
    const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll("button,a,[role=button],div,span"))
      .filter(visible)
      .map((el) => ({ el, text: normalize(el.innerText || el.textContent), rect: el.getBoundingClientRect() }))
      .filter(({ text, rect }) =>
        text.toLowerCase() === targetLabel.toLowerCase() &&
        rect.y >= 55 &&
        rect.y <= 125 &&
        rect.width <= 160 &&
        rect.height <= 70
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    const candidate = candidates[0];
    if (!candidate) return false;
    const rect = candidate.rect;
    candidate.el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      })
    );
    return true;
  }, label);
  if (!clicked) return false;
  await page.waitForTimeout(500);
  return true;
}

async function clickApplyInOpenFilter(page) {
  const apply = await firstVisible([
    page.getByRole("button", { name: /^aplicar$/i }),
    page.locator("button").filter({ hasText: /^aplicar$/i }),
  ]);
  if (apply) {
    await apply.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function clickVisibleText(page, regex) {
  const item = await firstVisible([
    page.getByRole("button", { name: regex }),
    page.getByRole("checkbox", { name: regex }),
    page.getByText(regex),
  ]);
  if (!item) return false;
  await item.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

async function visibleInputs(page, selector, limit = 4) {
  const locator = page.locator(`${selector}:visible`);
  const count = await locator.count().catch(() => 0);
  return Promise.all(
    Array.from({ length: Math.min(count, limit) }, (_, idx) => locator.nth(idx))
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function extractResults(page, limit, input = {}) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await autoScroll(page);
  const requestedLimit = Math.min(Number(limit) || 20, 50);
  const scanLimit = Math.min(requestedLimit * 20, 200);
  const raw = await page.evaluate((maxItems) => {
    function visibleText(el) {
      const rects = el.getClientRects();
      if (!rects.length) return "";
      const text = (el.innerText || el.textContent || "").trim();
      return text.replace(/\s+/g, " ");
    }
    function hrefFor(el) {
      const link = el.matches("a") ? el : el.querySelector("a[href]");
      return link?.href || null;
    }
    function propertyHref(link) {
      if (!link?.href) return null;
      if (!/\/agent\/mls_properties\//i.test(link.href)) return null;
      if (/\/agent\/mls_properties\/search\//i.test(link.href)) return null;
      if (/#$/.test(link.href)) return null;
      return link.href;
    }
    function hrefCount(el) {
      return Array.from(el.querySelectorAll("a[href]")).filter((link) =>
        propertyHref(link)
      ).length;
    }
    function ebCodeCount(text) {
      return (text.match(/\bEB-[A-Z0-9]+\b/gi) ?? []).length;
    }
    function looksLikePropertyText(text) {
      return /\bEB-[A-Z0-9]+\b/i.test(text) &&
        /(?:MXN|USD|\$|EN\s+VENTA|EN\s+RENTA|m²|m2)/i.test(text);
    }
    function bestCardForLink(link) {
      let current = link;
      for (let depth = 0; current && depth < 7; depth += 1) {
        const text = visibleText(current);
        const codes = ebCodeCount(text);
        const links = hrefCount(current);
        if (
          looksLikePropertyText(text) &&
          text.length >= 40 &&
          text.length <= 900 &&
          codes <= 1 &&
          links <= 2
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return link;
    }
    const seen = new Set();
    const rows = [];
    function addCandidate(el) {
      const text = visibleText(el);
      if (!text || text.length < 30) return null;
      const href = hrefFor(el);
      if (!href || !/\/agent\/mls_properties\//i.test(href)) return null;
      if (/\/agent\/mls_properties\/search\//i.test(href)) return null;
      if (!looksLikePropertyText(text)) return null;
      const key = href || text.slice(0, 160);
      if (seen.has(key)) return null;
      seen.add(key);
      rows.push({
        text,
        url: href,
        id: el.getAttribute("data-property-id") || null,
      });
      return rows.length >= maxItems ? rows : null;
    }
    const propertyLinks = Array.from(
      document.querySelectorAll(
        'a[href*="/agent/mls_properties/"]'
      )
    ).filter((link) => propertyHref(link));
    for (const link of propertyLinks) {
      const card = bestCardForLink(link);
      if (!card) continue;
      const done = addCandidate(card);
      if (Array.isArray(done)) return done;
    }
    return rows;
  }, scanLimit);

  const normalized = raw.map((item) => normalizeMlsItem(item, input)).filter(Boolean);
  return filterMlsResults(normalized, input).slice(0, requestedLimit);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 600;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight || totalHeight >= 10000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve(undefined);
        }
      }, 120);
    });
  }).catch(() => {});
}

async function collectPageDiagnostics(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const sample = (items, max = 20) =>
      Array.from(items)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, max);
    return {
      title: document.title,
      url: location.href,
      body_excerpt: text.slice(0, 1800),
      input_candidates: sample(
        Array.from(document.querySelectorAll("input, textarea, select")).map((el) =>
          [
            el.tagName.toLowerCase(),
            el.getAttribute("type"),
            el.getAttribute("name"),
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
          ]
            .filter(Boolean)
            .join(" | ")
        )
      ),
      button_candidates: sample(
        Array.from(document.querySelectorAll("button, a")).map((el) =>
          (el.innerText || el.textContent || "").replace(/\s+/g, " ")
        )
      ),
      href_candidates: sample(
        Array.from(document.querySelectorAll("a[href]")).map((el) => el.href)
      ),
      selector_counts: {
        data_property_id: document.querySelectorAll("[data-property-id]").length,
        article: document.querySelectorAll("article").length,
        li: document.querySelectorAll("li").length,
        tr: document.querySelectorAll("tr").length,
        cards: document.querySelectorAll("[class*='card' i]").length,
        property_links: document.querySelectorAll(
          "a[href*='properties'], a[href*='propiedades'], a[href*='mls_properties'], a[href*='property']"
        ).length,
      },
    };
  }).catch((e) => ({ error: e?.message ?? String(e) }));
}

function normalizeMlsItem(item, input = {}) {
  const text = String(item.text ?? "").trim();
  if (!text) return null;
  const preferredOperation = normalizeOperationHint(input.operation);
  const priceInfo = parsePriceInfo(text, preferredOperation);
  const price = priceInfo?.price ?? null;
  const areaM2 = parseArea(text);
  const details = parsePropertyDetails(text);
  const operation =
    priceInfo?.operation ??
    (/renta|rent/i.test(text) ? "rent" : /venta|sale/i.test(text) ? "sale" : null);
  const title = text.split(/(?:\s{2,}|[\n\r]+)/)[0]?.slice(0, 140) || text.slice(0, 140);
  return {
    source: "easybroker_mls",
    id: item.id ?? idFromUrl(item.url),
    title,
    url: item.url ?? null,
    location: parseLocation(text),
    property_type: parsePropertyType(text),
    operation,
    price,
    formatted_price: priceInfo?.formatted_price ?? null,
    currency: priceInfo?.currency ?? null,
    area_m2: areaM2,
    bedrooms: details.bedrooms,
    bathrooms: details.bathrooms,
    parking_spaces: details.parking_spaces,
    price_per_m2: price && areaM2 ? Math.round(price / areaM2) : null,
    raw_text: text,
  };
}

function normalizeOperationHint(value) {
  if (value === "rent" || value === "renta") return "rent";
  if (value === "sale" || value === "venta") return "sale";
  return null;
}

function parsePriceInfo(text, preferredOperation = null) {
  const matches = [];
  const priceRe =
    /((?:USD|MXN|\$)\s?[\d,]+(?:\.\d+)?)\s*(MXN|USD)?(?:\s+por\s+m²)?\s+EN\s+(VENTA|RENTA)/gi;
  for (const match of text.matchAll(priceRe)) {
    const raw = match[1] ?? "";
    const currency = /USD/i.test(`${raw} ${match[2] ?? ""}`) ? "USD" : "MXN";
    const operation = /RENTA/i.test(match[3] ?? "") ? "rent" : "sale";
    const price = parseLocalizedNumber(raw.replace(/(?:MXN|USD|\$)/gi, ""));
    if (price != null) {
      matches.push({
        formatted_price: raw.trim(),
        currency,
        operation,
        price,
      });
    }
  }
  if (preferredOperation) {
    const preferred = matches.find((item) => item.operation === preferredOperation);
    if (preferred) return preferred;
  }
  if (matches.length > 0) return matches[0];
  const fallback = text.match(/(?:MXN|USD|\$)\s?[\d,]+(?:\.\d+)?/i)?.[0] ?? null;
  if (!fallback) return null;
  const price = parseLocalizedNumber(fallback.replace(/(?:MXN|USD|\$)/gi, ""));
  if (price == null) return null;
  return {
    formatted_price: fallback,
    currency: /USD/i.test(fallback) ? "USD" : "MXN",
    operation: null,
    price,
  };
}

function parseArea(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros)/i);
  if (!match) return null;
  return parseLocalizedNumber(match[1]);
}

function parsePropertyDetails(text) {
  const afterType = text.match(
    /\b(?:Casa|Departamento|Terreno|Oficina|Local(?:\s+comercial)?|Bodega)\s+en\b[\s\S]*?(?:,\s*[^0-9$]+)?\s+((?:Estudio|\d+(?:\.\d+)?)(?:\s+\d+(?:\.\d+)?){0,3})\s+\d+(?:[.,]\d+)?\s*m(?:2|²)/i
  )?.[1];
  const tokens = String(afterType ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const numbers = tokens.map((token) =>
    /^estudio$/i.test(token) ? 0 : Number(token.replace(",", "."))
  );
  return {
    bedrooms: Number.isFinite(numbers[0]) ? numbers[0] : null,
    bathrooms: Number.isFinite(numbers[1]) ? numbers[1] : null,
    parking_spaces: Number.isFinite(numbers[2]) ? numbers[2] : null,
  };
}

function parseLocalizedNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.includes(".")
    ? raw.replace(/,/g, "")
    : raw.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parsePropertyType(text) {
  const structured = text.match(
    /\b(casa|departamento|terreno|oficina|local(?:\s+comercial)?|bodega)\s+en\b/i
  )?.[1];
  if (structured) return canonicalPropertyType(structured);
  return canonicalPropertyType(
    text.match(/\b(casa|departamento|terreno|oficina|local(?:\s+comercial)?|bodega)\b/i)?.[1]
  );
}

function roomCountMatches(actual, requested, plusAt) {
  if (requested == null) return true;
  if (actual == null) return true;
  const target = Math.floor(Number(requested));
  if (!Number.isFinite(target) || target < 0) return true;
  if (target >= plusAt) return actual >= target;
  return actual === target;
}

function minRoomCountMatches(actual, requested) {
  if (requested == null) return true;
  if (actual == null) return true;
  const target = Math.floor(Number(requested));
  if (!Number.isFinite(target) || target < 0) return true;
  return actual >= target;
}

function canonicalPropertyType(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized.startsWith("local")) return "Local comercial";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function filterMlsResults(results, input = {}) {
  return results.filter((result) => mlsResultMatchesInput(result, input));
}

function mlsResultMatchesInput(result, input = {}) {
  const operations = [
    normalizeOperationHint(input.operation),
    ...(Array.isArray(input.operations) ? input.operations.map(normalizeOperationHint) : []),
  ].filter(Boolean);
  if (operations.length > 0) {
    if (!result.operation) return false;
    if (!operations.includes(result.operation)) return false;
  }

  const propertyTypes = [
    input.property_type,
    ...(Array.isArray(input.property_types) ? input.property_types : []),
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());
  if (propertyTypes.length > 0) {
    const actual = String(result.property_type ?? "").toLowerCase();
    if (!actual || !propertyTypes.some((type) => actual.includes(type))) return false;
  }

  if (input.min_price != null && result.price != null && result.price < input.min_price) {
    return false;
  }
  if (input.max_price != null && result.price != null && result.price > input.max_price) {
    return false;
  }
  if (input.min_area_m2 != null && result.area_m2 != null && result.area_m2 < input.min_area_m2) {
    return false;
  }
  if (input.max_area_m2 != null && result.area_m2 != null && result.area_m2 > input.max_area_m2) {
    return false;
  }
  if (!roomCountMatches(result.bedrooms, input.bedrooms, 4)) return false;
  if (input.bedrooms == null && !minRoomCountMatches(result.bedrooms, input.min_bedrooms)) return false;
  if (!roomCountMatches(result.bathrooms, input.bathrooms, 5)) return false;
  if (input.bathrooms == null && !minRoomCountMatches(result.bathrooms, input.min_bathrooms)) return false;
  if (!roomCountMatches(result.parking_spaces, input.parking_spaces, 5)) return false;
  if (
    input.parking_spaces == null &&
    !minRoomCountMatches(result.parking_spaces, input.min_parking_spaces)
  ) return false;

  if (typeof input.zona === "string" && input.zona.trim()) {
    const haystack = `${result.location ?? ""} ${result.title ?? ""}`.toLowerCase();
    const primaryTokens = input.zona
      .toLowerCase()
      .split(",")[0]
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    if (primaryTokens.length > 0 && !primaryTokens.every((token) => haystack.includes(token))) {
      return false;
    }
  }

  return true;
}

function parseLocation(text) {
  const parts = text.split(/[•|]/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => /,\s*[A-ZÁÉÍÓÚÑ]/i.test(part)) ?? null;
}

function idFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/(?:properties|propiedades|mls_properties)\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function visibleInputsNear(page, labelRegex) {
  const labels = page.locator("label, div, span").filter({ hasText: labelRegex });
  const count = await labels.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 5); i += 1) {
    const candidate = labels.nth(i);
    const root = candidate.locator("xpath=ancestor-or-self::*[self::form or self::div][1]");
    const inputs = root.locator("input:visible");
    const inputCount = await inputs.count().catch(() => 0);
    if (inputCount > 0) {
      return Promise.all(
        Array.from({ length: Math.min(inputCount, 2) }, (_, idx) => inputs.nth(idx))
      );
    }
  }
  return [];
}

async function clickText(page, regex) {
  const target = await firstVisible([
    page.getByRole("button", { name: regex }),
    page.getByRole("link", { name: regex }),
    page.getByText(regex),
  ]);
  if (!target) return false;
  await target.click().catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function clickIfVisible(page, locators) {
  const item = await firstVisible(locators);
  if (!item) return false;
  await item.click().catch(() => {});
  await page.waitForTimeout(800);
  return true;
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

async function maybeCapture(page, name, metrics, force = false) {
  if (!force && !envFlag("EASYBROKER_MLS_SCREENSHOTS")) return;
  const safeName = name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const path = `artifacts/${Date.now()}-${safeName}.png`;
  try {
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({ path, fullPage: true });
    metrics.push({ step: "screenshot", ok: true, path });
  } catch (e) {
    metrics.push({ step: "screenshot", ok: false, error: e?.message ?? String(e) });
  }
}

export async function closeSession(session) {
  try {
    await session?.browser?.close();
  } catch {
    /* noop */
  }
}
