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

    await clickWizardTab(page, "DETALLES");
    stages.push({ tab: "DETALLES", filled: await fillDetailsTab(page, listing) });
    await advanceWizard(page, "DETALLES", metrics);

    await clickWizardTab(page, "MEDIA");
    stages.push({ tab: "MEDIA", filled: await fillMediaTab(page, listing) });
    await advanceWizard(page, "MEDIA", metrics);

    await clickWizardTab(page, "OPERACIÓN");
    stages.push({ tab: "OPERACIÓN", filled: await fillOperationTab(page, listing) });

    await maybeCapture(
      page,
      dryRun ? "publish-dry-run-ready" : "publish-before-draft",
      metrics
    );

    let saveOutcome = null;
    let draftLinks = null;
    if (!dryRun) {
      saveOutcome = await saveAsDraft(page, metrics);
      if (saveOutcome?.ok) {
        draftLinks = await resolveDraftLinks(page, listing, metrics);
      }
    }

    const url = page.url();
    push("publish_listing", true, Date.now() - t0);
    return {
      dry_run: dryRun,
      url,
      ungga_listing_id:
        draftLinks?.ungga_property_id ?? extractIdFromUrl(url),
      stages,
      save_outcome: saveOutcome,
      draft_url: draftLinks?.draft_url ?? null,
      properties_url: draftLinks?.properties_url ?? null,
      draft_lookup: draftLinks?.lookup ?? null,
    };
  } catch (e) {
    push("publish_listing", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "publish-failed", metrics);
    throw e;
  }
}

/**
 * Publica un borrador existente navegando a /app/propiedades/{GU-ID}.
 * En dryRun sólo verifica que el botón Publicar esté disponible.
 */
export async function publishExistingDraft(page, opts, metrics = []) {
  const push = (step, ok, duration_ms, error) => {
    metrics.push({ step, ok, duration_ms, ...(error ? { error } : {}) });
  };
  const dryRun = opts.dryRun !== false;
  const propertyId = String(opts.propertyId ?? "").trim();
  if (!propertyId) {
    throw new Error("publishExistingDraft requires propertyId");
  }
  const t0 = Date.now();
  const origin = new URL(page.url()).origin;
  const targetUrl = `${origin}/app/propiedades/${propertyId}`;
  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    await page.waitForTimeout(800);
    await dismissStrayModals(page);

    const editBtn = await firstVisible([
      page.getByRole("button", { name: /^editar$/i }),
      page.getByRole("link", { name: /^editar$/i }),
      page.locator("button:has-text('EDITAR'), a:has-text('EDITAR')"),
    ]);
    if (editBtn) {
      try {
        await editBtn.click({ timeout: 5_000 });
        await page.waitForTimeout(1200);
      } catch {}
    }

    await maybeCapture(
      page,
      dryRun ? "publish-draft-preview" : "publish-draft-before",
      metrics
    );

    const publishStep = await firstVisible([
      page.getByRole("tab", { name: /^publicar$/i }),
      page.locator('[role="tab"]:has-text("PUBLICAR")'),
      page.locator("button:has-text('PUBLICAR')").filter({ hasText: /^PUBLICAR$/i }),
      page.getByText(/^PUBLICAR$/i),
    ]);
    if (publishStep) {
      try {
        await publishStep.click({ timeout: 5_000 });
        await page.waitForTimeout(800);
      } catch {}
    } else {
      for (let i = 0; i < 4; i += 1) {
        const cont = await firstVisible([
          page.getByRole("button", { name: /^continuar/i }),
          page.locator('button:has-text("Continuar")'),
        ]);
        if (!cont) break;
        try {
          await cont.click({ timeout: 5_000 });
          await page.waitForTimeout(800);
        } catch {
          break;
        }
      }
    }

    const publishBtn = await firstVisible([
      page.getByRole("button", { name: /^publicar$/i }),
      page.getByRole("button", { name: /publicar propiedad|publicar ficha|publicar ahora/i }),
      page.locator('button[class*="brand-purple"]:has-text("PUBLICAR")'),
      page.locator('button:has-text("PUBLICAR")').filter({ hasNotText: /continuar/i }),
    ]);
    if (!publishBtn) {
      const msg = "Botón Publicar no encontrado en la ficha.";
      push("publish_draft", false, Date.now() - t0, msg);
      await maybeCapture(page, "publish-draft-missing-button", metrics);
      return { ok: false, error: msg, property_id: propertyId, url: page.url() };
    }

    const disabled = await publishBtn.evaluate((el) => {
      const candidate = el.closest("button") ?? el;
      return Boolean(
        candidate.disabled ||
          candidate.getAttribute("disabled") !== null ||
          candidate.getAttribute("aria-disabled") === "true"
      );
    });
    if (disabled) {
      const msg = "Botón Publicar está deshabilitado.";
      push("publish_draft", false, Date.now() - t0, msg);
      return { ok: false, error: msg, property_id: propertyId, url: page.url() };
    }

    if (dryRun) {
      push("publish_draft", true, Date.now() - t0);
      return {
        ok: true,
        dry_run: true,
        publish_ready: true,
        property_id: propertyId,
        draft_url: targetUrl,
        url: page.url(),
      };
    }

    await publishBtn.click({ timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000) });
    await page.waitForTimeout(800);
    const confirmBtn = await firstVisible([
      page.getByRole("button", { name: /^confirmar$|^aceptar$|^sí$|^si$/i }),
      page.locator('button[class*="brand-purple"]:has-text("CONFIRMAR")'),
    ]);
    if (confirmBtn) {
      try {
        await confirmBtn.click({ timeout: 5_000 });
        await page.waitForTimeout(1200);
      } catch {}
    }
    await page.waitForLoadState("networkidle", {
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    }).catch(() => {});
    await page.waitForTimeout(1000);
    await maybeCapture(page, "publish-draft-after", metrics);

    const publishedId = extractPropertyIdFromUrl(page.url()) ?? propertyId;
    const publishedUrl = `${origin}/app/propiedades/${publishedId}`;
    push("publish_draft", true, Date.now() - t0);
    return {
      ok: true,
      dry_run: false,
      property_id: publishedId,
      published_url: publishedUrl,
      properties_url: `${origin}/app/propiedades`,
      url: page.url(),
    };
  } catch (e) {
    push("publish_draft", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "publish-draft-failed", metrics);
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
    .getByPlaceholder(/busca una dirección|arrastra el pin|dirección/i)
    .first();
  if ((await input.count()) === 0) return false;
  try {
    await input.click({ timeout: 5_000 });
    await input.fill("");
    await input.type(String(address), { delay: 45 });
    const suggestion = page
      .locator(".pac-item, .pac-container .pac-item, [role='listbox'] [role='option']")
      .first();
    try {
      await suggestion.waitFor({ state: "visible", timeout: 12_000 });
      await suggestion.click();
    } catch {
      await input.press("ArrowDown");
      await page.waitForTimeout(600);
      await input.press("Enter");
    }
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    if (/selecciona la ubicación exacta en el mapa/i.test(body)) {
      return false;
    }
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
    const addBtn = await firstVisible([
      page.getByRole("button", { name: /agregar tipo de operación/i }),
      page.locator('button:has-text("Agregar tipo de operación")'),
      page.locator('[role="button"]:has-text("Agregar tipo de operación")'),
      page.locator("button, a").filter({ hasText: /agregar tipo de operaci[oó]n/i }),
      page.getByText(/agregar tipo de operaci[oó]n/i),
    ]);
    if (!addBtn) {
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

/**
 * Tras guardar el borrador, intenta resolver el link directo a la ficha en
 * Ungga sin modificar el título del listing.
 *
 * Estrategia:
 *  1. Si la URL actual ya es /app/propiedades/{GU-ID}, úsala directo.
 *  2. Si no, navega a /app/propiedades, abre la pestaña "Borrador" y toma
 *     el primer card cuyo texto contenga el título exacto del listing
 *     (Ungga ordena por más reciente arriba, así que el recién creado es
 *     el primero). Abre el modal y sigue el botón "DETALLE" para capturar
 *     la URL real.
 *
 * Nunca lanza; ante cualquier problema retorna lo que haya podido capturar
 * y registra el motivo en metrics + screenshot.
 */
async function resolveDraftLinks(page, listing, metrics) {
  const t0 = Date.now();
  const origin = new URL(page.url()).origin;
  const propertiesUrl = `${origin}/app/propiedades`;
  const out = {
    draft_url: null,
    properties_url: propertiesUrl,
    ungga_property_id: null,
    lookup: { method: null, title_used: null, fallback_reason: null },
  };

  const postSaveId = extractPropertyIdFromUrl(page.url());
  if (postSaveId) {
    out.draft_url = `${origin}/app/propiedades/${postSaveId}`;
    out.ungga_property_id = postSaveId;
    out.lookup.method = "post_save_url";
    metrics.push({
      step: "resolve_draft_links",
      ok: true,
      via: "post_save_url",
      duration_ms: Date.now() - t0,
      draft_url: out.draft_url,
    });
    return out;
  }

  const title = typeof listing.title === "string" ? listing.title.trim() : "";
  out.lookup.method = "listing_search";
  out.lookup.title_used = title;
  if (!title) {
    out.lookup.fallback_reason = "no title to search";
    metrics.push({
      step: "resolve_draft_links",
      ok: false,
      via: "listing_search",
      error: out.lookup.fallback_reason,
      duration_ms: Date.now() - t0,
    });
    return out;
  }

  try {
    await page.goto(propertiesUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 60_000),
    });
    await page.waitForTimeout(800);
    await dismissStrayModals(page);

    const draftTab = await firstVisible([
      page.getByRole("tab", { name: /^borrador/i }),
      page.getByRole("button", { name: /^borrador/i }),
      page.locator("button:has-text('Borrador'), [role='tab']:has-text('Borrador')"),
    ]);
    if (draftTab) {
      try {
        await draftTab.click({ timeout: 5_000 });
      } catch {}
      await page.waitForTimeout(800);
    } else {
      out.lookup.fallback_reason = "Borrador tab not found";
    }
    await maybeCapture(page, "draft-listing", metrics);

    const card = await findDraftCardByTitle(page, title);
    if (!card) {
      out.lookup.fallback_reason = `card not found for title: ${title}`;
      metrics.push({
        step: "resolve_draft_links",
        ok: false,
        via: "listing_search",
        error: out.lookup.fallback_reason,
        duration_ms: Date.now() - t0,
        properties_url: propertiesUrl,
      });
      await maybeCapture(page, "resolve-draft-missing", metrics);
      return out;
    }
    await card.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await maybeCapture(page, "draft-modal", metrics);

    await page.waitForTimeout(500);
    await page.getByText(/GU-ID/i).first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
    const modalGuId = await extractGuIdFromModal(page, title);
    if (modalGuId) {
      out.ungga_property_id = modalGuId;
      out.draft_url = `${origin}/app/propiedades/${modalGuId}`;
      out.lookup.method = "listing_search";
      out.lookup.via = "modal_gu_id";
      metrics.push({
        step: "resolve_draft_links",
        ok: true,
        via: "modal_gu_id",
        duration_ms: Date.now() - t0,
        draft_url: out.draft_url,
        ungga_property_id: out.ungga_property_id,
      });
      await maybeCapture(page, "draft-detalle", metrics);
      return out;
    }

    const modalScope =
      (await firstVisible([
        page.locator('[role="dialog"]'),
        page.locator('[class*="modal"], [class*="Modal"]').filter({ hasText: /GU-ID/i }),
      ])) ?? page;

    const detalle = await firstVisible([
      modalScope.getByRole("link", { name: /^detalle$/i }),
      modalScope.getByRole("button", { name: /^detalle$/i }),
      modalScope.locator("a:has-text('DETALLE'), button:has-text('DETALLE')"),
    ]);
    if (!detalle) {
      out.lookup.fallback_reason = "DETALLE not found in modal";
      metrics.push({
        step: "resolve_draft_links",
        ok: false,
        via: "listing_search",
        error: out.lookup.fallback_reason,
        duration_ms: Date.now() - t0,
        properties_url: propertiesUrl,
      });
      return out;
    }

    const href = await detalle.getAttribute("href").catch(() => null);
    if (href && /\/propiedades\/[^/?#]+/i.test(href)) {
      out.draft_url = href.startsWith("http")
        ? href
        : `${origin}${href.startsWith("/") ? "" : "/"}${href}`;
    } else {
      try {
        await Promise.all([
          page.waitForURL(/\/propiedades\/[^/?#]+/i, {
            timeout: timeoutMs("UNGGA_CLI_TIMEOUT_MS", 30_000),
          }),
          detalle.click({ timeout: 5_000 }),
        ]);
      } catch {
        await detalle.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
      const navigatedId = extractPropertyIdFromUrl(page.url());
      if (navigatedId) {
        out.draft_url = page.url();
      }
    }

    out.ungga_property_id = extractPropertyIdFromUrl(out.draft_url || "") ?? null;
    if (!out.ungga_property_id) {
      out.lookup.fallback_reason = "could not resolve GU-ID from modal or DETALLE navigation";
    }
    metrics.push({
      step: "resolve_draft_links",
      ok: Boolean(out.ungga_property_id),
      via: out.ungga_property_id ? "detalle_navigation" : "listing_search",
      duration_ms: Date.now() - t0,
      draft_url: out.draft_url,
      ungga_property_id: out.ungga_property_id,
      ...(out.lookup.fallback_reason ? { error: out.lookup.fallback_reason } : {}),
    });
    await maybeCapture(page, "draft-detalle", metrics);
    return out;
  } catch (e) {
    out.lookup.fallback_reason = e?.message ?? String(e);
    metrics.push({
      step: "resolve_draft_links",
      ok: false,
      via: "listing_search",
      duration_ms: Date.now() - t0,
      error: out.lookup.fallback_reason,
      properties_url: propertiesUrl,
    });
    await maybeCapture(page, "resolve-draft-failed", metrics);
    return out;
  }
}

/**
 * Lee el GU-ID visible en el modal de detalle (ej. "GU-ID" + "CpJi0ZSVrOeNAlsHwxBE").
 * Ungga no siempre usa role=dialog; priorizamos el panel que contiene el título buscado.
 */
async function extractGuIdFromModal(page, title) {
  const fromDom = await page
    .evaluate((searchTitle) => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 40 && rect.height > 40 && rect.top >= 0 && rect.top < window.innerHeight;
      };
      const parseId = (text) => {
        if (!text) return null;
        const patterns = [
          /GU-ID\s*:?\s*([A-Za-z0-9_-]{10,})/i,
          /GU-ID[\s\n\r]+([A-Za-z0-9_-]{10,})/i,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m?.[1]) return m[1];
        }
        const lines = text.split(/\n/).map((s) => s.trim());
        const idx = lines.findIndex((l) => /^GU-ID/i.test(l));
        if (idx >= 0 && lines[idx + 1] && /^[A-Za-z0-9_-]{10,}$/.test(lines[idx + 1])) {
          return lines[idx + 1];
        }
        return null;
      };

      const candidates = [...document.querySelectorAll("div, section, article, aside")];
      let best = null;
      let bestArea = Infinity;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = el.innerText || "";
        if (!/GU-ID/i.test(text) || !/\bDETALLE\b/i.test(text)) continue;
        if (searchTitle && !text.includes(searchTitle)) continue;
        if (/Nueva propiedad|Crea una propiedad desde cero/i.test(text)) continue;
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area < bestArea) {
          bestArea = area;
          best = el;
        }
      }
      return best ? parseId(best.innerText || "") : null;
    }, title)
    .catch(() => null);
  if (fromDom) return fromDom;
  return null;
}

async function dismissStrayModals(page) {
  const cancel = await firstVisible([
    page.getByRole("button", { name: /^cancelar$/i }),
    page.locator("button:has-text('CANCELAR')"),
  ]);
  if (cancel) {
    try {
      await cancel.click({ timeout: 2_000 });
      await page.waitForTimeout(400);
    } catch {}
  }
}

function parseGuIdFromText(text) {
  if (!text) return null;
  const patterns = [
    /GU-ID\s*:?\s*([A-Za-z0-9_-]{10,})/i,
    /GU-ID[\s\n\r]+([A-Za-z0-9_-]{10,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && m[1].toLowerCase() !== "nueva" && m[1].toLowerCase() !== "new") {
      return m[1];
    }
  }
  return null;
}

/**
 * En la pestaña "Borrador" Ungga ordena por más reciente primero. Buscamos
 * el primer elemento clickable que contenga el título exacto del listing.
 * Devolvemos un Locator listo para click, o null si no hay match.
 */
async function findDraftCardByTitle(page, title) {
  const safeTitle = title.replace(/"/g, '\\"');
  const candidates = [
    page.locator(`article:has-text("${safeTitle}")`),
    page.locator(`div[class*="cursor-pointer"]:has-text("${safeTitle}")`),
    page.locator(`[role="button"]:has-text("${safeTitle}")`),
    page.locator(`button:has-text("${safeTitle}")`),
    page.locator(`a:has-text("${safeTitle}")`),
    page.locator(`li:has-text("${safeTitle}")`),
  ];
  for (const loc of candidates) {
    const total = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 5); i += 1) {
      const candidate = loc.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) return candidate;
    }
  }
  const textNode = page.locator(`text="${safeTitle}"`).first();
  if ((await textNode.count().catch(() => 0)) > 0) {
    return textNode.locator(
      "xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]"
    );
  }
  return null;
}

function extractPropertyIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/propiedades\/([^/?#]+)(?:[/?#]|$)/i);
  if (!m) return null;
  const id = m[1];
  if (!id || id === "nueva" || id === "new") return null;
  return id;
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

/** Navega a una pestaña del wizard (GENERAL, DETALLES, MEDIA, OPERACIÓN, PUBLICAR). */
async function clickWizardTab(page, tabName) {
  const escaped = tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tab = await firstVisible([
    page.getByRole("button", { name: new RegExp(`^${escaped}$`, "i") }),
    page.locator(`button:has-text("${tabName}")`),
  ]);
  if (!tab) return false;
  try {
    await tab.click({ timeout: 8_000 });
    await page.waitForTimeout(700);
    return true;
  } catch {
    return false;
  }
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
