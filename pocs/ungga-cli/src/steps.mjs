/**
 * Pasos Playwright compartidos para el POC contra Ungga.
 * Los selectores son placeholders: ajústalos al DOM real de app.ungga.com.
 */
import { chromium } from "playwright";

function envFlag(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function maybeCapture(page, name, metrics) {
  if (!envFlag("UNGGA_CLI_SCREENSHOTS")) return;
  const safeName = name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const path = `artifacts/${Date.now()}-${safeName}.png`;
  try {
    await page.screenshot({ path, fullPage: true });
    metrics.push({ step: "screenshot", ok: true, path });
  } catch (e) {
    metrics.push({
      step: "screenshot",
      ok: false,
      error: e?.message ?? String(e),
    });
  }
}

/**
 * @param {{ baseUrl: string; email: string; password: string }} creds
 * @param {Array<Record<string, unknown>>} metrics
 */
export async function loginToUngga(creds, metrics = []) {
  const headless = envFlag("UNGGA_CLI_HEADLESS", true);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };

  const tLogin = Date.now();
  try {
    const loginUrl = creds.baseUrl.endsWith("/login")
      ? creds.baseUrl
      : `${creds.baseUrl.replace(/\/$/, "")}/login`;
    await page.goto(loginUrl, {
      waitUntil: "networkidle",
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    const visibleInputs = page.locator("input:visible");
    await visibleInputs.nth(0).fill(creds.email);
    await visibleInputs.nth(1).fill(creds.password);
    await page
      .getByRole("button", { name: /^ingresar$|^entrar$|^iniciar sesión$|^login$|^sign in$/i })
      .click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    push("login", true, Date.now() - tLogin);
  } catch (e) {
    push("login", false, Date.now() - tLogin, e?.message ?? String(e));
    await maybeCapture(page, "login-failed", metrics);
    await browser.close();
    throw e;
  }

  return { browser, page };
}

/**
 * Publica o prepara una ficha usando el flujo web de Ungga. En `dryRun`
 * llena campos pero no presiona el botón final de publicación.
 * @param {import('playwright').Page} page
 * @param {{ listing: Record<string, unknown>; dryRun?: boolean }} opts
 * @param {Array<Record<string, unknown>>} metrics
 */
export async function publishListingDraft(page, opts, metrics = []) {
  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };
  const dryRun = opts.dryRun !== false;
  const listing = opts.listing;
  const t0 = Date.now();
  try {
    const publishPath = process.env.UNGGA_CLI_PUBLISH_PATH?.trim() || "/properties/new";
    const publishUrl = resolveTargetUrl(page.url(), publishPath);
    await page.goto(publishUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
    if (/\b404\b|page could not be found/i.test(bodyText)) {
      throw new Error(
        `Publish path not found: ${publishPath}. Set UNGGA_CLI_PUBLISH_PATH to the real listing creation route.`
      );
    }
    await clickCreatePropertyIfPresent(page, metrics);
    await page.waitForTimeout(500);

    const stages = [];
    stages.push({ tab: "GENERAL", filled: await fillGeneralTab(page, listing) });
    if (stages[0].filled.length === 0) {
      throw new Error(
        `No listing fields found at ${page.url()}. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.`
      );
    }
    await advanceWizard(page, "GENERAL", metrics);

    stages.push({ tab: "DETALLES", filled: await fillDetailsTab(page, listing) });
    await advanceWizard(page, "DETALLES", metrics);

    stages.push({ tab: "MEDIA", filled: await fillMediaTab(page, listing) });
    await advanceWizard(page, "MEDIA", metrics);

    stages.push({ tab: "OPERACIÓN", filled: await fillOperationTab(page, listing) });

    await maybeCapture(
      page,
      dryRun ? "publish-dry-run-ready" : "publish-before-draft",
      metrics
    );

    let saveOutcome = null;
    if (!dryRun) {
      saveOutcome = await saveAsDraft(page, metrics);
    }

    const url = page.url();
    push("publish_listing", true, Date.now() - t0);
    return {
      dry_run: dryRun,
      url,
      ungga_listing_id: extractIdFromUrl(url),
      stages,
      save_outcome: saveOutcome,
    };
  } catch (e) {
    push("publish_listing", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "publish-failed", metrics);
    throw e;
  }
}

/**
 * Llena la pestaña "GENERAL" del wizard usando los labels reales mapeados en
 * artifacts/wizard-map.json. Devuelve la lista de campos llenados.
 */
export async function fillGeneralTab(page, listing) {
  const filled = [];
  if (
    listing.property_type &&
    (await selectByLabel(page, /TIPO DE PROPIEDAD/i, listing.property_type))
  ) {
    filled.push("property_type");
  }
  if (listing.title && (await fillByLabel(page, /TÍTULO/i, listing.title))) {
    filled.push("title");
  }
  if (
    listing.description &&
    (await fillByLabel(page, /DESCRIPCIÓN DEL ANUNCIO/i, listing.description))
  ) {
    filled.push("description");
  }
  if (
    listing.construction_m2 != null &&
    (await fillByLabel(page, /CONSTRUCCIÓN/i, String(listing.construction_m2)))
  ) {
    filled.push("construction_m2");
  }
  if (
    listing.land_m2 != null &&
    (await fillByLabel(page, /TERRENO/i, String(listing.land_m2), { nth: 0 }))
  ) {
    filled.push("land_m2");
    if (
      listing.land_unit &&
      (await selectByLabel(page, /TERRENO/i, listing.land_unit, { nth: 0 }))
    ) {
      filled.push("land_unit");
    }
  }
  if (
    listing.condition &&
    (await selectByLabel(page, /ESTADO DE LA PROPIEDAD/i, listing.condition))
  ) {
    filled.push("condition");
  }
  if (
    listing.age_range &&
    (await selectByLabel(page, /ANTIGÜEDAD/i, listing.age_range))
  ) {
    filled.push("age_range");
  }
  if (
    listing.country &&
    (await selectByLabel(page, /ELIGE EL PAÍS DE LA PROPIEDAD/i, listing.country))
  ) {
    filled.push("country");
  }
  const address = pickAddress(listing);
  if (address && (await fillAddressAutocomplete(page, address))) {
    filled.push("address");
  }
  return filled;
}

function pickAddress(listing) {
  if (typeof listing.address === "string" && listing.address.trim()) {
    return listing.address.trim();
  }
  const loc = listing.location;
  if (!loc || typeof loc !== "object") return null;
  const candidates = [loc.address, loc.full_address, loc.zona, loc.colonia, loc.city];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Llena el autocomplete de Google Places en el wizard de Ungga. Escribe la
 * dirección, espera la primera sugerencia y la selecciona con ArrowDown+Enter.
 */
async function fillAddressAutocomplete(page, address) {
  const input = page
    .getByPlaceholder(/busca una dirección|arrastra el pin/i)
    .first();
  if ((await input.count()) === 0) return false;
  try {
    await input.click({ timeout: 5_000 });
    await input.fill("");
    await input.type(String(address), { delay: 60 });
    const suggestion = page.locator(".pac-item, [role='listbox'] [role='option']").first();
    try {
      await suggestion.waitFor({ state: "visible", timeout: 8_000 });
      await suggestion.click();
    } catch {
      await input.press("ArrowDown");
      await page.waitForTimeout(500);
      await input.press("Enter");
    }
    await page.waitForTimeout(1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hace click en "Continuar" si está habilitado. Si hay errores de validación
 * visibles después del intento, los reporta como métrica pero no aborta (deja
 * que el usuario humano complete lo faltante).
 */
async function advanceWizard(page, fromTab, metrics) {
  const t0 = Date.now();
  const button = page.getByRole("button", { name: /^continuar$/i }).first();
  if ((await button.count()) === 0) {
    metrics.push({ step: `continue_after_${fromTab}`, ok: false, error: "no Continuar button" });
    return false;
  }
  const disabled = await button.evaluate((el) => {
    const c = el.closest("button") ?? el;
    return Boolean(
      c.disabled ||
        c.getAttribute("disabled") !== null ||
        c.getAttribute("aria-disabled") === "true"
    );
  });
  if (disabled) {
    metrics.push({
      step: `continue_after_${fromTab}`,
      ok: false,
      error: "Continuar deshabilitado",
    });
    return false;
  }
  await button.click().catch(() => {});
  await page.waitForTimeout(1200);
  const errors = await detectValidationErrors(page);
  metrics.push({
    step: `continue_after_${fromTab}`,
    ok: errors.length === 0,
    duration_ms: Date.now() - t0,
    validation_errors: errors,
  });
  return errors.length === 0;
}

async function detectValidationErrors(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!(el instanceof Element)) return false;
      const rect = el.getClientRects();
      return Boolean(rect.length) && getComputedStyle(el).visibility !== "hidden";
    }
    const selectors = [
      ".text-red-500",
      ".text-red-600",
      ".text-red-700",
      "[aria-invalid='true']",
      "[role='alert']",
    ];
    const out = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        const t = el.innerText?.trim();
        if (t) out.add(t);
      }
    }
    return [...out];
  });
}

/** Llena pestaña DETALLES (todos los campos son opcionales). */
export async function fillDetailsTab(page, listing) {
  const filled = [];
  if (
    listing.bedrooms != null &&
    (await fillByLabel(page, /RECÁMARAS/i, String(listing.bedrooms)))
  ) {
    filled.push("bedrooms");
  }
  if (
    listing.bathrooms_full != null &&
    (await fillByLabel(page, /BAÑOS COMPLETOS/i, String(listing.bathrooms_full)))
  ) {
    filled.push("bathrooms_full");
  }
  if (
    listing.bathrooms_half != null &&
    (await fillByLabel(page, /MEDIOS BAÑOS/i, String(listing.bathrooms_half)))
  ) {
    filled.push("bathrooms_half");
  }
  if (
    listing.parking_spaces != null &&
    (await fillByLabel(page, /ESTACIONAMIENTOS/i, String(listing.parking_spaces)))
  ) {
    filled.push("parking_spaces");
  }
  if (listing.covered_parking) {
    const checkbox = page.getByLabel(/Estacionamiento techado/i).first();
    if ((await checkbox.count()) > 0) {
      await checkbox.check().catch(() => {});
      filled.push("covered_parking");
    }
  }
  if (listing.floor && (await fillByLabel(page, /^PISO$/i, String(listing.floor)))) {
    filled.push("floor");
  }
  if (
    listing.location_type &&
    (await selectByLabel(page, /TIPO DE UBICACIÓN/i, listing.location_type))
  ) {
    filled.push("location_type");
  }
  if (
    listing.current_status &&
    (await selectByLabel(page, /ESTADO ACTUAL/i, listing.current_status))
  ) {
    filled.push("current_status");
  }
  if (Array.isArray(listing.amenities)) {
    for (const amenity of listing.amenities) {
      const btn = page.getByRole("button", { name: new RegExp(`^${escapeRegex(amenity)}$`, "i") }).first();
      if ((await btn.count()) > 0) {
        await btn.click().catch(() => {});
        filled.push(`amenity:${amenity}`);
      }
    }
  }
  return filled;
}

/** Llena pestaña MEDIA (opcional). */
export async function fillMediaTab(page, listing) {
  const filled = [];
  if (listing.video_url) {
    if (await fillByLabel(page, /^VIDEO/i, listing.video_url)) filled.push("video_url");
  }
  if (listing.tour_url) {
    if (await fillByLabel(page, /TOUR VIRTUAL/i, listing.tour_url)) filled.push("tour_url");
  }
  return filled;
}

/**
 * Llena pestaña OPERACIÓN. Por cada entrada de listing.operations abre el modal
 * "Elije el tipo de operación", selecciona el tab (Venta/Renta/...), captura
 * precio y moneda, y confirma con el botón ✓.
 */
export async function fillOperationTab(page, listing) {
  const filled = [];
  const ops = Array.isArray(listing.operations) ? listing.operations : [];
  if (ops.length === 0) return filled;

  const TAB_BY_TYPE = {
    sale: /^venta$/i,
    rent: /^renta$/i,
    rent_temporary: /^renta temporal$/i,
    presale: /^preventa$/i,
  };

  for (const op of ops) {
    const addBtn = page
      .getByRole("button", { name: /agregar tipo de operación/i })
      .first();
    if ((await addBtn.count()) === 0) {
      filled.push({ op, ok: false, error: "no 'Agregar tipo de operación' button" });
      break;
    }
    await addBtn.click().catch(() => {});
    await page.waitForTimeout(800);

    const MODAL_TITLE = "Elije el tipo de operación";
    const titleLocator = page.locator(`text=${MODAL_TITLE}`).first();
    const scope = page;

    const tabRegex = TAB_BY_TYPE[op.type] ?? null;
    let tabClicked = false;
    if (tabRegex) {
      const tab = scope.getByRole("button", { name: tabRegex }).first();
      if ((await tab.count()) > 0) {
        await tab.click().catch(() => {});
        tabClicked = true;
        await page.waitForTimeout(300);
      }
    }

    const priceInput = scope
      .locator("label:has-text('PRECIO')")
      .locator("input")
      .first();
    let priceFilled = false;
    if ((await priceInput.count()) > 0 && op.price != null) {
      await priceInput.fill(String(op.price));
      priceFilled = true;
    }

    let currencySet = false;
    if (op.currency) {
      const currencySelect = scope
        .locator("label:has-text('MONEDA')")
        .locator("select")
        .first();
      if ((await currencySelect.count()) > 0) {
        try {
          await currencySelect.selectOption(String(op.currency));
          currencySet = true;
        } catch {
          /* moneda no disponible, ignorar */
        }
      }
    }

    // El modal tiene ✕ (cancelar) y ✓ (confirmar) en el footer. El ✓ es el
    // único con gradiente brand-purple en su className.
    const confirmBtn = await firstVisible([
      scope.locator('button[class*="bg-gradient-to-r"][class*="brand-purple"]'),
      scope.locator('button[class*="bg-gradient-to-r"]'),
      scope.getByRole("button", { name: /^confirmar$|^aceptar$|^guardar$/i }),
    ]);
    let confirmed = false;
    if (confirmBtn) {
      await confirmBtn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const stillOpen =
        (await titleLocator.count()) > 0 &&
        (await titleLocator.isVisible().catch(() => false));
      confirmed = !stillOpen;
    }

    filled.push({
      op,
      ok: tabClicked && priceFilled && confirmed,
      tab_clicked: tabClicked,
      price_filled: priceFilled,
      currency_set: currencySet,
      confirmed,
    });
    if (!confirmed) break;
  }
  return filled;
}

function escapeRegex(s) {
  return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Persiste el draft via "Guardar como borrador". No publica.
 */
async function saveAsDraft(page, metrics) {
  const t0 = Date.now();
  try {
    const button = page
      .getByRole("button", { name: /guardar como borrador/i })
      .first();
    if ((await button.count()) === 0) {
      const msg = "Botón 'Guardar como borrador' no encontrado.";
      metrics.push({ step: "save_draft", ok: false, duration_ms: Date.now() - t0, error: msg });
      return { ok: false, error: msg };
    }
    const disabled = await button.evaluate((el) => {
      const candidate = el.closest("button") ?? el;
      return Boolean(
        candidate.disabled ||
          candidate.getAttribute("disabled") !== null ||
          candidate.getAttribute("aria-disabled") === "true"
      );
    });
    if (disabled) {
      const msg = "Botón 'Guardar como borrador' está deshabilitado (faltan campos obligatorios).";
      metrics.push({
        step: "save_draft",
        ok: false,
        duration_ms: Date.now() - t0,
        error: msg,
      });
      await maybeCapture(page, "save-draft-disabled", metrics);
      return { ok: false, error: msg };
    }
    await button.click({ timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000) });
    await page.waitForLoadState("networkidle", {
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    await page.waitForTimeout(1500);
    await maybeCapture(page, "after-save-draft", metrics);
    metrics.push({ step: "save_draft", ok: true, duration_ms: Date.now() - t0, url: page.url() });
    return { ok: true, url: page.url() };
  } catch (e) {
    metrics.push({
      step: "save_draft",
      ok: false,
      duration_ms: Date.now() - t0,
      error: e?.message ?? String(e),
    });
    await maybeCapture(page, "save-draft-failed", metrics);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

async function fillByLabel(page, label, value, opts = {}) {
  const nth = opts.nth ?? 0;
  const control = page
    .locator(`label:has-text("${labelHint(label)}")`)
    .locator("input, textarea")
    .nth(nth);
  if ((await control.count()) === 0) {
    const fallback = page.getByLabel(label).first();
    if ((await fallback.count()) === 0) return false;
    await fallback.fill(String(value));
    return true;
  }
  await control.fill(String(value));
  return true;
}

async function selectByLabel(page, label, value, opts = {}) {
  const nth = opts.nth ?? 0;
  const control = page
    .locator(`label:has-text("${labelHint(label)}")`)
    .locator("select")
    .nth(nth);
  if ((await control.count()) === 0) {
    const fallback = page.getByLabel(label).first();
    if ((await fallback.count()) === 0) return false;
    try {
      await fallback.selectOption(String(value));
      return true;
    } catch {
      await fallback.fill(String(value));
      return true;
    }
  }
  try {
    await control.selectOption(String(value));
  } catch {
    return false;
  }
  return true;
}

function labelHint(label) {
  if (label instanceof RegExp) {
    return label.source
      .replace(/\\\\b|\\\\B|\\\\w|\\\\W|\\\\s|\\\\S|\\\\d|\\\\D|[\^$.|?*+()\[\]{}]/g, "")
      .replace(/\\\\/g, "")
      .trim();
  }
  return String(label);
}

async function fillIfPresent(page, label, value) {
  if (value == null || String(value).trim() === "") return false;
  const control = page.getByLabel(label).first();
  if ((await control.count()) === 0) return false;
  await control.fill(String(value));
  return true;
}

async function clickCreatePropertyIfPresent(page, metrics) {
  const t0 = Date.now();
  await page.waitForTimeout(500);
  const createAction =
    (await firstVisible([
      page.getByRole("link", {
        name: /nueva propiedad|crear propiedad|agregar propiedad|publicar propiedad/i,
      }),
      page.getByRole("button", {
        name: /nueva propiedad|crear propiedad|agregar propiedad|publicar propiedad/i,
      }),
    ])) ?? null;
  if (!createAction) return false;
  try {
    const href = await createAction.getAttribute("href").catch(() => null);
    if (href) {
      await page.goto(resolveTargetUrl(page.url(), href), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
      });
    } else {
      await createAction.click({ timeout: 10_000 });
    }
    await page.waitForLoadState("domcontentloaded", {
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    metrics.push({
      step: "open_create_property",
      ok: true,
      duration_ms: Date.now() - t0,
      url: page.url(),
    });
    return true;
  } catch (e) {
    metrics.push({
      step: "open_create_property",
      ok: false,
      duration_ms: Date.now() - t0,
      error: e?.message ?? String(e),
    });
    throw e;
  }
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function selectOrFillIfPresent(page, label, value) {
  if (value == null || String(value).trim() === "") return false;
  const control = page.getByLabel(label).first();
  if ((await control.count()) === 0) return false;
  try {
    await control.selectOption(String(value));
  } catch {
    await control.fill(String(value));
  }
  return true;
}

async function fillLocation(page, location) {
  if (!location || typeof location !== "object") return;
  for (const [key, value] of Object.entries(location)) {
    if (value == null || String(value).trim() === "") continue;
    await fillIfPresent(page, new RegExp(key, "i"), value);
  }
}

function extractIdFromUrl(url) {
  const match = url.match(/\/(?:properties|listings)\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

function resolveTargetUrl(currentUrl, configuredPath) {
  if (/^https?:\/\//i.test(configuredPath)) {
    return configuredPath;
  }
  const origin = new URL(currentUrl).origin;
  return `${origin}${configuredPath.startsWith("/") ? "" : "/"}${configuredPath}`;
}

export async function closeSession(session) {
  if (session?.browser) await session.browser.close();
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
