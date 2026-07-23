/**
 * Pasos Playwright compartidos para el POC contra Ungga.
 * Los selectores son placeholders: ajústalos al DOM real de app.ungga.com.
 */
import { chromium } from "playwright";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  evaluatePrepareDraftSuccess,
  extractPropertyIdFromUrl,
  lastMeaningfulStep,
  MAX_UNGGA_IMAGE_BYTES,
  MAX_UNGGA_IMAGE_DOWNLOADS,
  resolveUnggaTimeoutMs,
} from "./prepare-draft-contract.mjs";
import {
  classifyLocationDistance,
  evaluateLocationAccuracy,
  haversineMeters,
  parseLatLngFromText,
  pickTargetLocation,
} from "./location-accuracy.mjs";

export {
  evaluatePrepareDraftSuccess,
  extractPropertyIdFromUrl,
  lastMeaningfulStep,
  resolveUnggaTimeoutMs,
} from "./prepare-draft-contract.mjs";
export {
  classifyLocationDistance,
  evaluateLocationAccuracy,
  haversineMeters,
  parseLatLngFromText,
  pickTargetLocation,
} from "./location-accuracy.mjs";

function envFlag(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveExpectedCommissionPct(listing) {
  const ops = Array.isArray(listing?.operations) ? listing.operations : [];
  for (const op of ops) {
    const pct = Number(op?.commission_pct);
    if (Number.isFinite(pct) && pct > 0) return pct;
  }
  const top = Number(listing?.commission_pct);
  if (Number.isFinite(top) && top > 0) return top;
  return null;
}

/**
 * EasyBroker auto-imports into Ungga often use IDs containing "EB-" or ending
 * with an EasyBroker public id. CLI-created drafts use Ungga-native GU-IDs.
 */
export function looksLikeEasyBrokerImportedUnggaId(propertyId) {
  const id = typeof propertyId === "string" ? propertyId.trim() : "";
  if (!id) return false;
  if (/EB-[A-Z0-9]+/i.test(id)) return true;
  if (/origen\s*easybroker/i.test(id)) return true;
  return false;
}

function cardLooksLikeEasyBrokerImport(text) {
  const raw = String(text ?? "");
  return (
    /tipo\s*importada/i.test(raw) ||
    /origen\s*easybroker/i.test(raw) ||
    /\bimportada\b/i.test(raw)
  );
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
      waitUntil: "domcontentloaded",
      timeout: resolveUnggaTimeoutMs("nav"),
    });
    const visibleInputs = page.locator("input:visible");
    await visibleInputs.nth(0).fill(creds.email, {
      timeout: resolveUnggaTimeoutMs("action"),
    });
    await visibleInputs.nth(1).fill(creds.password, {
      timeout: resolveUnggaTimeoutMs("action"),
    });
    await page
      .getByRole("button", { name: /^ingresar$|^entrar$|^iniciar sesión$|^login$|^sign in$/i })
      .click({ timeout: resolveUnggaTimeoutMs("action") });
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: resolveUnggaTimeoutMs("nav"),
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
  let predownloadedMedia = null;
  try {
    const expectedImageCount = Array.isArray(listing.image_urls)
      ? listing.image_urls.filter((u) => typeof u === "string" && u.trim()).length
      : 0;

    // Cheap media preflight: download (with retries) before opening the wizard
    // so a transient 404 does not burn ~3 minutes of Playwright form fill.
    if (expectedImageCount > 0) {
      const tPreflight = Date.now();
      try {
        predownloadedMedia = await downloadListingImagesToTemp(listing, metrics);
        metrics.push({
          step: "media_preflight",
          ok: true,
          duration_ms: Date.now() - tPreflight,
          expected_image_count: expectedImageCount,
          uploaded_image_count: predownloadedMedia.localPaths.length,
        });
      } catch (e) {
        const cause = e?.message ?? String(e);
        const msg = `ungga_media_source_unreachable: ${cause}`;
        metrics.push({
          step: "media_preflight",
          ok: false,
          duration_ms: Date.now() - tPreflight,
          expected_image_count: expectedImageCount,
          uploaded_image_count: 0,
          error: msg,
        });
        push("prepare_draft", false, Date.now() - t0, msg);
        return {
          ok: false,
          dry_run: dryRun,
          error: msg,
          expected_image_count: expectedImageCount,
          uploaded_image_count: 0,
          images_submitted: false,
          images_verified: false,
          last_step: lastMeaningfulStep(metrics),
        };
      }
    }

    const publishPath =
      process.env.UNGGA_CLI_PUBLISH_PATH?.trim() || "/app/propiedades/nueva";
    const publishUrl = resolveTargetUrl(page.url(), publishPath);
    await page.goto(publishUrl, {
      waitUntil: "domcontentloaded",
      timeout: resolveUnggaTimeoutMs("nav"),
    });
    const bodyText = await page.locator("body").innerText({
      timeout: resolveUnggaTimeoutMs("action"),
    });
    if (/\b404\b|page could not be found/i.test(bodyText)) {
      throw new Error(
        `Publish path not found: ${publishPath}. Set UNGGA_CLI_PUBLISH_PATH to the real listing creation route.`
      );
    }
    await clickCreatePropertyIfPresent(page, metrics);
    await page.waitForTimeout(500);

    const stages = [];
    let generalResult = await fillGeneralTab(page, listing, metrics);
    let generalFilled = generalResult.filled;
    let locationAccuracyWarning = generalResult.location_accuracy_warning ?? null;
    if (generalFilled.length === 0) {
      const fallbackUrl = resolveCreatePropertyFallbackUrl(page.url());
      const tFallback = Date.now();
      try {
        await page.goto(fallbackUrl, {
          waitUntil: "domcontentloaded",
          timeout: resolveUnggaTimeoutMs("nav"),
        });
        await page.waitForTimeout(500);
        generalResult = await fillGeneralTab(page, listing, metrics);
        generalFilled = generalResult.filled;
        locationAccuracyWarning =
          generalResult.location_accuracy_warning ?? locationAccuracyWarning;
        metrics.push({
          step: "open_create_property_fallback",
          ok: generalFilled.length > 0,
          duration_ms: Date.now() - tFallback,
          url: page.url(),
          ...(generalFilled.length === 0
            ? {
                error: `No listing fields found after fallback to ${fallbackUrl}`,
              }
            : {}),
        });
      } catch (e) {
        metrics.push({
          step: "open_create_property_fallback",
          ok: false,
          duration_ms: Date.now() - tFallback,
          url: page.url(),
          error: e?.message ?? String(e),
        });
      }
    }
    stages.push({ tab: "GENERAL", filled: generalFilled });
    if (stages[0].filled.length === 0) {
      throw new Error(
        `No listing fields found at ${page.url()}. Adjust UNGGA_CLI_PUBLISH_PATH/selectors.`
      );
    }
    const generalAdvanced = await advanceWizard(page, "GENERAL", metrics);
    if (!generalAdvanced) {
      const generalErrors = latestValidationErrors(metrics, "GENERAL");
      throw new Error(
        `GENERAL validation blocked draft: ${generalErrors.join("; ") || "unknown validation error"}`
      );
    }

    await clickWizardTab(page, "DETALLES");
    stages.push({ tab: "DETALLES", filled: await fillDetailsTab(page, listing) });
    await advanceWizard(page, "DETALLES", metrics);

    await clickWizardTab(page, "MEDIA");
    await page.waitForTimeout(800);
    const mediaFilled = await fillMediaTab(page, listing, metrics, {
      localPaths: predownloadedMedia?.localPaths ?? null,
    });
    stages.push({ tab: "MEDIA", filled: mediaFilled.filled });
    const uploadedImageCount = mediaFilled.uploaded_image_count;
    const placeholderImageCount =
      typeof mediaFilled.placeholder_image_count === "number"
        ? mediaFilled.placeholder_image_count
        : null;
    if (
      expectedImageCount > 0 &&
      uploadedImageCount < expectedImageCount
    ) {
      const cause =
        typeof mediaFilled.error === "string" && mediaFilled.error.trim()
          ? mediaFilled.error.trim()
          : null;
      const msg = cause
        ? `Media incomplete: expected ${expectedImageCount} photos, observed ${uploadedImageCount} (cause: ${cause})`
        : `Media incomplete: expected ${expectedImageCount} photos, observed ${uploadedImageCount}`;
      push("prepare_draft", false, Date.now() - t0, msg);
      await maybeCapture(page, "media-incomplete", metrics);
      return {
        ok: false,
        dry_run: dryRun,
        error: msg,
        url: page.url(),
        stages,
        expected_image_count: expectedImageCount,
        uploaded_image_count: uploadedImageCount,
        ...(placeholderImageCount != null
          ? { placeholder_image_count: placeholderImageCount }
          : {}),
        images_submitted: uploadedImageCount > 0,
        images_verified: false,
        last_step: lastMeaningfulStep(metrics),
        ...(locationAccuracyWarning
          ? { location_accuracy_warning: locationAccuracyWarning }
          : {}),
      };
    }
    await advanceWizard(page, "MEDIA", metrics);

    await clickWizardTab(page, "OPERACIÓN");
    const operationFilled = await fillOperationTab(page, listing);
    stages.push({ tab: "OPERACIÓN", filled: operationFilled });

    const expectedCommission = resolveExpectedCommissionPct(listing);
    const commissionStage = operationFilled.find(
      (row) => row?.commission_expected != null || row?.commission_verify
    );
    const commissionVerify = commissionStage?.commission_verify ?? {
      expected: expectedCommission,
      actual: commissionStage?.commission_actual ?? null,
      persisted:
        expectedCommission == null
          ? true
          : commissionStage?.commission_verified === true,
      filled: commissionStage?.commission_filled === true,
      edit_path: commissionStage?.edit_path ?? null,
      retried: false,
    };

    if (
      expectedCommission != null &&
      commissionVerify.persisted !== true
    ) {
      const msg = `Commission not verified: expected ${expectedCommission}%, got ${commissionVerify.actual ?? "null"}`;
      push("verify_commission", false, Date.now() - t0, msg);
      await maybeCapture(page, "commission-verify-failed", metrics);
      return {
        ok: false,
        dry_run: dryRun,
        error: msg,
        url: page.url(),
        stages,
        commission_expected: expectedCommission,
        commission_actual: commissionVerify.actual ?? null,
        commission_verified: false,
        commission_verify: commissionVerify,
        last_step: lastMeaningfulStep(metrics),
        ...(locationAccuracyWarning
          ? { location_accuracy_warning: locationAccuracyWarning }
          : {}),
      };
    }

    await maybeCapture(
      page,
      dryRun ? "publish-dry-run-ready" : "publish-before-draft",
      metrics
    );

    let saveOutcome = null;
    let draftLinks = null;
    if (!dryRun) {
      saveOutcome = await saveAsDraft(page, metrics);
      // Even on a soft save signal, try to resolve GU-ID from the properties list.
      if (saveOutcome?.ok || /\/propiedades/i.test(page.url())) {
        draftLinks = await resolveDraftLinks(page, listing, metrics);
        if (
          draftLinks?.ungga_property_id &&
          draftLinks?.draft_url &&
          (!saveOutcome || saveOutcome.ok !== true)
        ) {
          saveOutcome = {
            ok: true,
            url: page.url(),
            signal: "resolved_via_list",
          };
        }
      }
    }

    const verdict = evaluatePrepareDraftSuccess({
      dryRun,
      expectedImageCount,
      uploadedImageCount,
      saveOutcome,
      draftLinks,
      unggaPropertyId:
        draftLinks?.ungga_property_id ?? extractPropertyIdFromUrl(page.url()),
      draftUrl: draftLinks?.draft_url ?? null,
      expectedCommissionPct: expectedCommission,
      commissionActual: commissionVerify.actual ?? null,
      commissionVerified:
        expectedCommission == null ? true : commissionVerify.persisted === true,
    });

    push(
      "prepare_draft",
      verdict.ok,
      Date.now() - t0,
      verdict.error ?? undefined
    );
    if (!verdict.ok) {
      await maybeCapture(page, "publish-incomplete", metrics);
    }
    return {
      ok: verdict.ok,
      dry_run: dryRun,
      url: page.url(),
      ungga_listing_id: verdict.ungga_property_id,
      ungga_property_id: verdict.ungga_property_id,
      stages,
      save_outcome: saveOutcome,
      draft_url: verdict.draft_url,
      properties_url: draftLinks?.properties_url ?? null,
      draft_lookup: draftLinks?.lookup ?? null,
      expected_image_count: verdict.expected_image_count,
      uploaded_image_count: verdict.uploaded_image_count,
      image_count: verdict.uploaded_image_count,
      ...(placeholderImageCount != null
        ? { placeholder_image_count: placeholderImageCount }
        : {}),
      images_submitted: verdict.images_submitted,
      images_verified: verdict.images_verified,
      commission_expected: expectedCommission,
      commission_actual: commissionVerify.actual ?? null,
      commission_verified:
        expectedCommission == null ? true : commissionVerify.persisted === true,
      commission_verify: commissionVerify,
      last_step: lastMeaningfulStep(metrics),
      ...(locationAccuracyWarning
        ? { location_accuracy_warning: locationAccuracyWarning }
        : {}),
      ...(verdict.error ? { error: verdict.error } : {}),
    };
  } catch (e) {
    push("prepare_draft", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "publish-failed", metrics);
    throw e;
  } finally {
    if (predownloadedMedia?.tempDir) {
      await rm(predownloadedMedia.tempDir, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
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
      timeout: resolveUnggaTimeoutMs("nav"),
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

    const expectedCommission = resolveExpectedCommissionPct(opts.listing ?? opts);
    let commissionVerify = null;
    if (expectedCommission != null) {
      await clickWizardTab(page, "OPERACIÓN").catch(() => {});
      const op =
        Array.isArray(opts.listing?.operations) && opts.listing.operations[0]
          ? opts.listing.operations[0]
          : { type: "sale", commission_pct: expectedCommission };
      commissionVerify = await verifyAndFixOperationCommission(page, {
        op,
        expectedCommission,
        collaborationEnabled:
          opts.listing?.collaboration_enabled === true ||
          opts.collaboration_enabled === true,
      });
      metrics.push({
        step: "verify_commission",
        ok: commissionVerify.persisted === true,
        expected: expectedCommission,
        actual: commissionVerify.actual,
        retried: commissionVerify.retried,
        stage: commissionVerify.stage ?? null,
        ...(commissionVerify.error ? { error: commissionVerify.error } : {}),
      });
      if (commissionVerify.persisted !== true) {
        const msg = `Commission not verified before publish: expected ${expectedCommission}%, got ${commissionVerify.actual ?? "null"}`;
        push("publish_draft", false, Date.now() - t0, msg);
        await maybeCapture(page, "commission-verify-before-publish-failed", metrics);
        return {
          ok: false,
          error: msg,
          property_id: propertyId,
          url: page.url(),
          commission_expected: expectedCommission,
          commission_actual: commissionVerify.actual,
          commission_verified: false,
          commission_verify: commissionVerify,
        };
      }
      // Persist commission before navigating to Publicar (pencil confirm alone
      // is not always enough on Ungga's published/edit flow).
      if (!dryRun) {
        const saveOutcome = await saveAsDraft(page, metrics);
        if (saveOutcome?.ok !== true) {
          // Soft: some edit surfaces lack "Guardar como borrador"; re-read after
          // a short wait still helps when the palomita already persisted.
          metrics.push({
            step: "commission_save_before_publish",
            ok: false,
            error: saveOutcome?.error ?? "save_as_draft_unavailable",
          });
        } else {
          metrics.push({
            step: "commission_save_before_publish",
            ok: true,
          });
        }
        // Read-only re-check after save attempt.
        await clickWizardTab(page, "OPERACIÓN").catch(() => {});
        const card = await findOperationCard(page, op);
        if (card) {
          const pencil = await findPencilInCard(card);
          if (pencil) {
            await pencil.click({ timeout: 5_000 }).catch(() => {});
            await page.waitForTimeout(800);
            const reread = await readCommissionInputValue(page);
            await page.keyboard.press("Escape").catch(() => {});
            commissionVerify = {
              ...commissionVerify,
              actual: reread.actual,
              persisted:
                reread.ok &&
                reread.actual != null &&
                Number(reread.actual) === Number(expectedCommission),
              error:
                reread.ok &&
                reread.actual != null &&
                Number(reread.actual) === Number(expectedCommission)
                  ? null
                  : "commission_not_persisted_after_save",
            };
            metrics.push({
              step: "commission_reread_after_save",
              ok: commissionVerify.persisted === true,
              expected: expectedCommission,
              actual: commissionVerify.actual,
              ...(commissionVerify.error
                ? { error: commissionVerify.error }
                : {}),
            });
            if (commissionVerify.persisted !== true) {
              const msg = `Commission not persisted after save: expected ${expectedCommission}%, got ${commissionVerify.actual ?? "null"}`;
              push("publish_draft", false, Date.now() - t0, msg);
              await maybeCapture(
                page,
                "commission-not-persisted-after-save",
                metrics
              );
              return {
                ok: false,
                error: msg,
                property_id: propertyId,
                url: page.url(),
                commission_expected: expectedCommission,
                commission_actual: commissionVerify.actual,
                commission_verified: false,
                commission_verify: commissionVerify,
              };
            }
          }
        }
      }
    }

    // Real Ungga publish path (2026 UI):
    // 1) Editor → PUBLICAR tab → "Guardar cambios" (ready, still draft)
    // 2) Catalog → Borrador → open listing modal
    // 3) Modal action icon "PUBLICAR" (not the wizard tab)
    // 4) Verify badge PUBLICADO (never trust click alone)
    const listingTitle =
      typeof opts.listing?.title === "string" && opts.listing.title.trim()
        ? opts.listing.title.trim()
        : typeof opts.title === "string" && opts.title.trim()
          ? opts.title.trim()
          : null;

    await page.goto(`${origin}/app/propiedades/${propertyId}/editar`, {
      waitUntil: "domcontentloaded",
      timeout: resolveUnggaTimeoutMs("nav"),
    });
    await page.waitForTimeout(800);
    await dismissStrayModals(page);
    await clickWizardTab(page, "PUBLICAR").catch(() => {});
    await page.waitForTimeout(500);

    const saveChanges = await firstVisible([
      page.getByRole("button", { name: /^guardar cambios$/i }),
      page.locator("button").filter({ hasText: /^guardar cambios$/i }),
    ]);
    if (!saveChanges) {
      const msg = "Botón 'Guardar cambios' no encontrado en pestaña PUBLICAR.";
      push("publish_draft", false, Date.now() - t0, msg);
      await maybeCapture(page, "publish-save-changes-missing", metrics);
      return { ok: false, error: msg, property_id: propertyId, url: page.url() };
    }

    if (dryRun) {
      // Dry-run only proves the ready CTA exists; catalog modal publish is live-only.
      push("publish_draft", true, Date.now() - t0);
      return {
        ok: true,
        dry_run: true,
        publish_ready: true,
        property_id: propertyId,
        draft_url: targetUrl,
        url: page.url(),
        next_step: "catalog_modal_publicar",
      };
    }

    await saveChanges.click({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    metrics.push({
      step: "publish_save_changes",
      ok: true,
      url: page.url(),
    });
    await maybeCapture(page, "publish-after-save-changes", metrics);

    const modalPublish = await openDraftCardAndClickPublish(page, {
      origin,
      propertyId,
      listingTitle,
      metrics,
    });
    if (!modalPublish.ok) {
      push("publish_draft", false, Date.now() - t0, modalPublish.error);
      await maybeCapture(page, "publish-draft-missing-button", metrics);
      return {
        ok: false,
        error: modalPublish.error,
        property_id: propertyId,
        url: page.url(),
        stage: modalPublish.stage ?? null,
      };
    }

    const confirmBtn = await firstVisible([
      page.getByRole("button", { name: /^confirmar$|^aceptar$|^sí$|^si$|^publicar$/i }),
      page.locator('button[class*="brand-purple"]').filter({
        hasText: /^confirmar$|^aceptar$|^publicar$/i,
      }),
    ]);
    if (confirmBtn) {
      await confirmBtn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      metrics.push({ step: "publish_confirm_dialog", ok: true });
    }

    await page.waitForLoadState("networkidle", {
      timeout: resolveUnggaTimeoutMs("nav"),
    }).catch(() => {});
    await page.waitForTimeout(1500);
    await maybeCapture(page, "publish-draft-after", metrics);

    const status = await verifyListingPublishedStatus(page, {
      origin,
      propertyId,
      listingTitle,
    });
    metrics.push({
      step: "publish_status_verify",
      ok: status.published === true,
      ...(status.error ? { error: status.error } : {}),
      evidence: status.evidence ?? null,
    });
    if (status.published !== true) {
      const msg =
        status.error ||
        "Click PUBLICAR no confirmó estado PUBLICADO (sigue en borrador).";
      push("publish_draft", false, Date.now() - t0, msg);
      await maybeCapture(page, "publish-draft-still-borrador", metrics);
      return {
        ok: false,
        error: msg,
        property_id: propertyId,
        url: page.url(),
        remote_status: status.remote_status ?? "draft",
      };
    }

    const publishedId = propertyId;
    const publishedUrl = `${origin}/app/propiedades/${publishedId}`;
    push("publish_draft", true, Date.now() - t0);
    return {
      ok: true,
      dry_run: false,
      property_id: publishedId,
      published_url: publishedUrl,
      properties_url: `${origin}/app/propiedades`,
      url: page.url(),
      remote_status: "published",
      ...(expectedCommission != null
        ? {
            commission_expected: expectedCommission,
            commission_actual: commissionVerify?.actual ?? expectedCommission,
            commission_verified: true,
            commission_verify: commissionVerify,
          }
        : {}),
    };
  } catch (e) {
    push("publish_draft", false, Date.now() - t0, e?.message ?? String(e));
    await maybeCapture(page, "publish-draft-failed", metrics);
    throw e;
  }
}

/**
 * Catalog → Borrador → open listing card modal → click PUBLICAR action icon.
 * Must match the exact GU-ID in the modal: titles can collide with EasyBroker
 * imports that keep PUBLICAR disabled ("gestiona desde tu portal o CRM").
 */
/**
 * Click PUBLICAR inside a modal/scope already confirmed to carry the target
 * GU-ID. Returns a terminal result (ok / disabled / action-missing).
 */
async function clickModalPublishAction(page, scope, params) {
  const { propertyId, metrics = [], step, cardIndex } = params;
  await maybeCapture(page, "publish-catalog-modal", metrics);
  const publishProbe = await resolveModalPublishAction(scope);
  if (!publishProbe.action) {
    return {
      ok: false,
      error: "Acción PUBLICAR no encontrada en el modal del catálogo.",
      stage: "modal_publicar",
      property_id: propertyId,
    };
  }
  if (publishProbe.disabled) {
    const reason =
      publishProbe.title || "PUBLICAR deshabilitado en el modal del catálogo";
    metrics.push({
      step,
      ok: false,
      property_id: propertyId,
      error: reason,
    });
    return {
      ok: false,
      error: `ungga_publish_button_disabled:${reason}`,
      stage: "modal_publicar_disabled",
      property_id: propertyId,
    };
  }
  await publishProbe.action.click({ timeout: 8_000 });
  await page.waitForTimeout(1500);
  metrics.push({
    step,
    ok: true,
    property_id: propertyId,
    ...(cardIndex != null ? { card_index: cardIndex } : {}),
  });
  return { ok: true, stage: "modal_publicar", property_id: propertyId };
}

/**
 * Strategy 1: publish straight from the listing detail page
 * (`/app/propiedades/{GU-ID}`). Using the GU-ID URL sidesteps twin cards
 * entirely — no title matching, no risk of a duplicate. Returns:
 *   - ok:true                      → published action clicked
 *   - stage:modal_publicar_disabled → correct listing but PUBLICAR disabled
 *   - {ok:false, terminal:false}    → detail path unavailable; caller falls
 *                                     back to the catalog search
 */
async function tryPublishFromDetailModal(page, params) {
  const { origin, propertyId, metrics = [] } = params;
  await page
    .goto(`${origin}/app/propiedades/${propertyId}`, {
      waitUntil: "domcontentloaded",
      timeout: resolveUnggaTimeoutMs("nav"),
    })
    .catch(() => {});
  await page.waitForTimeout(1000);
  await dismissStrayModals(page);

  const detailText =
    ((await page.locator("body").innerText().catch(() => "")) || "").trim();
  // Confirm this is the right listing before touching any publish action.
  if (!detailText.includes(propertyId)) {
    metrics.push({
      step: "detail_publish_guid_absent",
      ok: false,
      property_id: propertyId,
    });
    return { ok: false, terminal: false, stage: "detail_guid_absent" };
  }
  if (/\bPUBLICADO\b/i.test(detailText) && !/\bBORRADOR\b/i.test(detailText)) {
    // Already published (e.g. a prior tick's click landed). Let the caller's
    // verify step confirm; report success so we don't loop.
    metrics.push({
      step: "detail_publish_already_published",
      ok: true,
      property_id: propertyId,
    });
    return { ok: true, stage: "modal_publicar_detail", property_id: propertyId };
  }

  const modal = await findCatalogPropertyModal(page);
  const scope = modal ?? page.locator("body");
  const probe = await resolveModalPublishAction(scope);
  if (!probe.action) {
    metrics.push({
      step: "detail_publish_action_absent",
      ok: false,
      property_id: propertyId,
    });
    return { ok: false, terminal: false, stage: "detail_action_absent" };
  }
  const result = await clickModalPublishAction(page, scope, {
    propertyId,
    metrics,
    step: "detail_modal_publicar_click",
  });
  // A disabled button on the exact GU-ID URL is terminal (right listing).
  return result;
}

/**
 * Scan Borrador cards, open each and require the exact GU-ID in the modal
 * before clicking PUBLICAR. Never publishes a card whose modal GU-ID differs
 * (twin/imported listings). Returns { done, result?, tried }.
 */
async function scanDraftCandidatesForGuid(page, params) {
  const { propertyId, titleNeedle, metrics = [] } = params;
  const needleSource = titleNeedle
    ? `${escapeRegex(propertyId)}|${escapeRegex(titleNeedle)}`
    : escapeRegex(propertyId);
  let cardCandidates = page
    .locator("div, article, a, li")
    .filter({ hasText: new RegExp(needleSource, "i") });
  let count = await cardCandidates.count().catch(() => 0);
  // After a GU-ID search narrowed the catalog, the card DOM may not echo the
  // GU-ID/title text; fall back to GU-ID anchor hrefs, then generic cards.
  if (count === 0) {
    cardCandidates = page.locator(
      `a[href*="/app/propiedades/${propertyId}"]`
    );
    count = await cardCandidates.count().catch(() => 0);
  }
  const tried = [];
  for (let i = 0; i < Math.min(count, 40); i += 1) {
    const candidate = cardCandidates.nth(i);
    const text = ((await candidate.innerText().catch(() => "")) || "").trim();
    if (text.length > 1200) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    await dismissStrayModals(page);
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    await candidate.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const modal = await findCatalogPropertyModal(page);
    if (!modal) {
      tried.push({ i, reason: "no_modal" });
      continue;
    }
    const modalText = ((await modal.innerText().catch(() => "")) || "").trim();
    if (!modalText.includes(propertyId)) {
      tried.push({
        i,
        reason: "guid_mismatch",
        sample: modalText.slice(0, 180).replace(/\s+/g, " "),
      });
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    const result = await clickModalPublishAction(page, modal, {
      propertyId,
      metrics,
      step: "catalog_modal_publicar_click",
      cardIndex: i,
    });
    return { done: true, result, tried };
  }
  return { done: false, tried };
}

/**
 * Catalog → Borrador → open listing card modal → click PUBLICAR action icon.
 * Must match the exact GU-ID in the modal: titles can collide with EasyBroker
 * imports that keep PUBLICAR disabled ("gestiona desde tu portal o CRM").
 */
async function openDraftCardAndClickPublish(page, params) {
  const { origin, propertyId, listingTitle, metrics = [] } = params;

  // Strategy 1: detail page by GU-ID URL (no twin risk).
  const detail = await tryPublishFromDetailModal(page, {
    origin,
    propertyId,
    metrics,
  });
  if (detail.ok || detail.stage === "modal_publicar_disabled") return detail;

  // Strategy 2/3: catalog Borrador, search by GU-ID first, then by title.
  await page.goto(`${origin}/app/propiedades`, {
    waitUntil: "domcontentloaded",
    timeout: resolveUnggaTimeoutMs("nav"),
  });
  await page.waitForTimeout(1000);
  await dismissStrayModals(page);

  const draftTab = await firstVisible([
    page.getByRole("button", { name: /^borrador/i }),
    page.getByRole("tab", { name: /^borrador/i }),
    page.locator("button, a, [role='tab']").filter({ hasText: /^borrador/i }),
  ]);
  if (draftTab) {
    await draftTab.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  const titleNeedle = listingTitle
    ? listingTitle.split(",")[0].trim().slice(0, 48)
    : "";
  const searchQueries = [propertyId, ...(listingTitle ? [listingTitle] : [])];
  const allTried = [];
  let sawSearchBox = false;
  for (const query of searchQueries) {
    const search = await firstVisible([
      page.getByPlaceholder(/buscar por título|buscar/i),
      page.locator('input[type="search"], input[placeholder*="Buscar" i]'),
    ]);
    if (search) {
      sawSearchBox = true;
      await search.fill("").catch(() => {});
      await search.fill(query).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(1000);
    }
    const scan = await scanDraftCandidatesForGuid(page, {
      propertyId,
      titleNeedle,
      metrics,
    });
    if (scan.done) return scan.result;
    allTried.push(...scan.tried);
    // No search box: one full pass over the list is all we can do.
    if (!search && !sawSearchBox) break;
  }

  await maybeCapture(page, "publish-modal-missing", metrics);
  metrics.push({
    step: "catalog_modal_guid_search",
    ok: false,
    property_id: propertyId,
    tried: allTried,
  });
  return {
    ok: false,
    error: `Modal del borrador con GU-ID ${propertyId} no encontrado (hay fichas con título similar; no se usó un duplicado).`,
    stage: "open_modal_guid_mismatch",
    tried_count: allTried.length,
  };
}

async function findCatalogPropertyModal(page) {
  const modal = page
    .locator("div.fixed.inset-0, [role='dialog']")
    .filter({ hasText: /publicar|gu-id|link para redes|archivar|editar/i })
    .first();
  if (
    (await modal.count().catch(() => 0)) === 0 ||
    !(await modal.isVisible().catch(() => false))
  ) {
    return null;
  }
  return modal;
}

async function resolveModalPublishAction(modal) {
  let action = await firstVisible([
    modal.getByRole("button", { name: /^publicar$/i }),
    modal.locator("button, [role='button'], a").filter({ hasText: /^publicar$/i }),
  ]);
  if (!action) {
    const iconButtons = modal.locator("button, [role='button']").filter({
      hasText: /archivar|publicar|editar|detalle|cerrar/i,
    });
    const n = await iconButtons.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const el = iconButtons.nth(i);
      const label = ((await el.innerText().catch(() => "")) || "").trim();
      if (/^publicar$/i.test(label)) {
        action = el;
        break;
      }
    }
  }
  if (!action) return { action: null, disabled: false, title: null };
  const disabled = await action.isDisabled().catch(async () => {
    const cls = (await action.getAttribute("class").catch(() => "")) || "";
    return /cursor-not-allowed|opacity-50/i.test(cls);
  });
  const title = (await action.getAttribute("title").catch(() => null)) || null;
  return { action, disabled: Boolean(disabled), title };
}

async function verifyListingPublishedStatus(page, params) {
  const { origin, propertyId, listingTitle } = params;
  // Close modal if still open, then check detail + catalog tabs.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);

  await page.goto(`${origin}/app/propiedades/${propertyId}`, {
    waitUntil: "domcontentloaded",
    timeout: resolveUnggaTimeoutMs("nav"),
  });
  await page.waitForTimeout(1200);
  const detailText = ((await page.locator("body").innerText().catch(() => "")) || "").trim();
  if (/\bPUBLICADO\b/i.test(detailText) && !/\bBORRADOR\b/i.test(detailText)) {
    return {
      published: true,
      remote_status: "published",
      evidence: "detail_page_publicado",
    };
  }

  await page.goto(`${origin}/app/propiedades`, {
    waitUntil: "domcontentloaded",
    timeout: resolveUnggaTimeoutMs("nav"),
  });
  await page.waitForTimeout(1000);
  const mineTab = await firstVisible([
    page.getByRole("button", { name: /mis propiedades/i }),
    page.getByRole("tab", { name: /mis propiedades/i }),
  ]);
  if (mineTab) {
    await mineTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const needle = listingTitle || propertyId;
  const cardText = await page
    .locator("div, article, a")
    .filter({ hasText: new RegExp(escapeRegex(needle), "i") })
    .first()
    .innerText()
    .catch(() => "");
  if (/\bPUBLICADO\b/i.test(cardText) && !/\bBORRADOR\b/i.test(cardText)) {
    return {
      published: true,
      remote_status: "published",
      evidence: "catalog_card_publicado",
    };
  }

  const draftTab = await firstVisible([
    page.getByRole("button", { name: /^borrador/i }),
    page.getByRole("tab", { name: /^borrador/i }),
  ]);
  if (draftTab) {
    await draftTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const stillDraft = await page
    .locator("div, article, a")
    .filter({ hasText: new RegExp(escapeRegex(needle), "i") })
    .filter({ hasText: /borrador/i })
    .count()
    .catch(() => 0);

  if (stillDraft > 0) {
    return {
      published: false,
      remote_status: "draft",
      error: "La ficha sigue en Borrador tras PUBLICAR.",
      evidence: "still_in_borrador_tab",
    };
  }

  // Not in draft and not clearly PUBLICADO → unknown, treat as failure.
  return {
    published: false,
    remote_status: "unknown",
    error: "No se pudo confirmar PUBLICADO tras el click.",
    evidence: "unconfirmed",
  };
}

/**
 * Llena la pestaña "GENERAL" del wizard usando los labels reales mapeados en
 * artifacts/wizard-map.json. Devuelve `{ filled, location_accuracy_warning }`.
 */
export async function fillGeneralTab(page, listing, metrics = []) {
  const filled = [];
  let location_accuracy_warning = null;
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
  if (listing.land_m2 != null) {
    const landFilled = await fillLandArea(page, listing.land_m2, listing.land_unit);
    if (landFilled.land_m2) filled.push("land_m2");
    if (landFilled.land_unit) filled.push("land_unit");
  }
  if (
    listing.condition &&
    (await selectByLabel(page, /ESTADO DE LA PROPIEDAD/i, listing.condition))
  ) {
    filled.push("condition");
  } else {
    for (const fallback of ["Bueno", "Excelente", "Regular", "Muy bueno"]) {
      if (await selectByLabel(page, /ESTADO DE LA PROPIEDAD/i, fallback)) {
        filled.push("condition");
        break;
      }
    }
  }
  if (
    listing.age_range &&
    (await selectByLabel(page, /ANTIGÜEDAD/i, listing.age_range))
  ) {
    filled.push("age_range");
  } else {
    for (const fallback of [
      "1-5 años",
      "5-10 años",
      "A estrenar",
      "10-20 años",
      "Menos de 1 año",
      "Más de 20 años",
    ]) {
      if (await selectByLabel(page, /ANTIGÜEDAD/i, fallback)) {
        filled.push("age_range");
        break;
      }
    }
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
    const pin = await verifyAndCorrectMapPin(page, listing, metrics);
    if (pin?.location_accuracy_warning) {
      location_accuracy_warning = pin.location_accuracy_warning;
    }
  }
  return { filled, location_accuracy_warning };
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
 * Ungga pairs land area + unit under similar "terreno" labels; prefer a numeric
 * input and only then set the unit select.
 */
async function fillLandArea(page, landM2, landUnit) {
  const value = String(landM2);
  const areaCandidates = [
    page.getByLabel(/área del terreno|area del terreno|terreno \(m/i).first(),
    page.getByPlaceholder(/área del terreno|area del terreno|terreno/i).first(),
    page
      .locator('label')
      .filter({ hasText: /terreno/i })
      .locator('input[type="number"], input[type="text"], input:not([type])')
      .first(),
    page.locator('input[name*="land" i], input[name*="terreno" i]').first(),
  ];

  let filledArea = false;
  for (const candidate of areaCandidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    const visible = await candidate.isVisible().catch(() => false);
    // Area inputs can be present but not yet "visible" in Ungga wizard.
    try {
      await candidate.click({ timeout: 2_000 }).catch(() => {});
      await candidate.fill("");
      await candidate.fill(value);
      const current = await candidate.inputValue().catch(() => "");
      if (String(current).replace(/[^\d.]/g, "") === String(landM2)) {
        filledArea = true;
        break;
      }
      // Some controls ignore fill(); type as fallback.
      await candidate.press("Control+A").catch(() => {});
      await candidate.type(value, { delay: 20 });
      const typed = await candidate.inputValue().catch(() => "");
      if (String(typed).replace(/[^\d.]/g, "") === String(landM2)) {
        filledArea = true;
        break;
      }
    } catch {
      // try next candidate
    }
    void visible;
  }

  if (!filledArea) {
    filledArea = await fillByLabel(page, /TERRENO/i, value, { nth: 0 });
  }

  let filledUnit = false;
  if (filledArea && landUnit) {
    filledUnit =
      (await selectByLabel(page, /unidad|terreno/i, String(landUnit), { nth: 0 })) ||
      (await selectByLabel(page, /TERRENO/i, String(landUnit), { nth: 0 }));
  }

  return { land_m2: filledArea, land_unit: filledUnit };
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

async function readObservedMapCenter(page) {
  const snippets = [];
  snippets.push(page.url());
  try {
    const iframeSrcs = await page
      .locator("iframe[src*='google'], iframe[src*='maps'], iframe[src*='ungga']")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("src") || ""));
    snippets.push(...iframeSrcs);
  } catch {
    // ignore
  }
  try {
    const hrefs = await page
      .locator("a[href*='maps'], a[href*='@']")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") || "").slice(0, 8));
    snippets.push(...hrefs);
  } catch {
    // ignore
  }
  try {
    const html = await page.content();
    // Prefer map-ish substrings to avoid scanning the whole DOM repeatedly.
    const mapChunks = html.match(
      /(?:google\.com\/maps|maps\.google|@-?\d+\.\d+,-?\d+\.\d+|!3d-?\d+\.\d+!4d-?\d+\.\d+|center=-?\d+\.\d+,-?\d+\.\d+)[^"'<\s]{0,120}/gi
    );
    if (mapChunks) snippets.push(...mapChunks.slice(0, 12));
  } catch {
    // ignore
  }
  for (const text of snippets) {
    const parsed = parseLatLngFromText(String(text ?? ""));
    if (parsed) return parsed;
  }
  return null;
}

/**
 * After Places autocomplete: if listing has usable lat/lng, verify pin distance
 * and attempt one non-blocking correction. Never fails prepare_draft.
 */
async function verifyAndCorrectMapPin(page, listing, metrics = []) {
  const target = pickTargetLocation(listing);
  if (!target) return { location_accuracy_warning: null };

  const t0 = Date.now();
  let observed = await readObservedMapCenter(page);
  let corrected = false;

  if (observed) {
    const distance_m = haversineMeters(
      target.latitude,
      target.longitude,
      observed.latitude,
      observed.longitude
    );
    const bucket = classifyLocationDistance(distance_m);
    metrics.push({
      step: "location_pin_check",
      ok: bucket !== "retry",
      duration_ms: Date.now() - t0,
      distance_m,
      bucket,
      expected: {
        latitude: target.latitude,
        longitude: target.longitude,
      },
      observed,
      source: target.source,
    });

    if (bucket === "retry") {
      const coordQuery = `${target.latitude}, ${target.longitude}`;
      const tCorr = Date.now();
      const correctedViaAutocomplete = await fillAddressAutocomplete(
        page,
        coordQuery
      );
      if (!correctedViaAutocomplete) {
        // Soft fallback: click near map canvas if present (best-effort).
        const map = page
          .locator(
            "canvas, [aria-label*='mapa' i], [class*='map' i], iframe[src*='maps']"
          )
          .first();
        if ((await map.count().catch(() => 0)) > 0) {
          await map.click({ timeout: 2_000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      }
      corrected = true;
      await page.waitForTimeout(1200);
      observed = (await readObservedMapCenter(page)) ?? observed;
      const afterDistance =
        observed &&
        haversineMeters(
          target.latitude,
          target.longitude,
          observed.latitude,
          observed.longitude
        );
      metrics.push({
        step: "location_pin_correction",
        ok:
          typeof afterDistance === "number" &&
          classifyLocationDistance(afterDistance) !== "retry",
        duration_ms: Date.now() - tCorr,
        distance_m: afterDistance ?? null,
        method: correctedViaAutocomplete ? "coords_autocomplete" : "map_click",
        source: target.source,
      });
    }
  } else {
    metrics.push({
      step: "location_pin_check",
      ok: true,
      duration_ms: Date.now() - t0,
      distance_m: null,
      bucket: "unreadable",
      expected: {
        latitude: target.latitude,
        longitude: target.longitude,
      },
      observed: null,
      source: target.source,
    });
  }

  const verdict = evaluateLocationAccuracy({
    expected: target,
    observed,
    source: target.source,
    corrected,
  });
  if (verdict.location_accuracy_warning) {
    metrics.push({
      step: "location_accuracy_warning",
      ok: true,
      duration_ms: Date.now() - t0,
      ...verdict.location_accuracy_warning,
    });
  }
  return {
    location_accuracy_warning: verdict.location_accuracy_warning,
    status: verdict.status,
    distance_m: verdict.distance_m,
  };
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

/** Llena pestaña MEDIA: video/tour opcionales + carga real de image_urls. */
export async function fillMediaTab(page, listing, metrics = [], options = {}) {
  const filled = [];
  const t0 = Date.now();
  if (listing.video_url) {
    if (await fillByLabel(page, /^VIDEO/i, listing.video_url)) filled.push("video_url");
  }
  if (listing.tour_url) {
    if (await fillByLabel(page, /TOUR VIRTUAL/i, listing.tour_url)) filled.push("tour_url");
  }

  const imageUrls = Array.isArray(listing.image_urls)
    ? listing.image_urls
        .filter((u) => typeof u === "string" && u.trim())
        .map((u) => u.trim())
        .slice(0, MAX_UNGGA_IMAGE_DOWNLOADS)
    : [];

  if (imageUrls.length === 0) {
    metrics.push({
      step: "media_upload",
      ok: true,
      duration_ms: Date.now() - t0,
      expected_image_count: 0,
      uploaded_image_count: 0,
      placeholder_image_count: 0,
    });
    return {
      filled,
      uploaded_image_count: 0,
      expected_image_count: 0,
      placeholder_image_count: 0,
    };
  }

  const providedLocalPaths = Array.isArray(options.localPaths)
    ? options.localPaths.filter((p) => typeof p === "string" && p.trim())
    : null;
  let ownedTempDir = null;
  try {
    let localPaths = providedLocalPaths;
    if (!localPaths || localPaths.length !== imageUrls.length) {
      ownedTempDir = await mkdtemp(path.join(tmpdir(), "ungga-media-"));
      localPaths = [];
      for (let i = 0; i < imageUrls.length; i += 1) {
        const localPath = await downloadImageToTemp(imageUrls[i], ownedTempDir, i);
        localPaths.push(localPath);
      }
    }

    const baseline = await countVisibleMediaThumbnails(page);
    let fileInput = await firstVisible([
      page.locator('input[type="file"][accept*="image"]'),
      page.locator('input[type="file"]'),
    ]);
    if (!fileInput) {
      const uploadTrigger = await firstVisible([
        page.getByRole("button", {
          name: /subir|cargar|agregar foto|añadir foto|seleccionar foto|agregar imagen/i,
        }),
        page.getByRole("link", {
          name: /subir|cargar|agregar foto|añadir foto|seleccionar foto|agregar imagen/i,
        }),
        page.locator('[data-testid*="upload" i], [class*="upload" i]').first(),
      ]);
      if (uploadTrigger) {
        await uploadTrigger.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
      fileInput = await firstVisible([
        page.locator('input[type="file"][accept*="image"]'),
        page.locator('input[type="file"]'),
      ]);
    }
    if (!fileInput) {
      // Hidden inputs are common in Ungga; firstVisible ignores them.
      const hiddenInput = page.locator('input[type="file"]').first();
      if ((await hiddenInput.count()) > 0) {
        fileInput = hiddenInput;
      }
    }
    if (!fileInput) {
      const msg = "No se encontró input[type=file] en la pestaña MEDIA.";
      metrics.push({
        step: "media_upload",
        ok: false,
        duration_ms: Date.now() - t0,
        expected_image_count: imageUrls.length,
        uploaded_image_count: 0,
        placeholder_image_count: baseline,
        error: msg,
      });
      filled.push({ media_upload: false, error: msg });
      return {
        filled,
        uploaded_image_count: 0,
        expected_image_count: imageUrls.length,
        placeholder_image_count: baseline,
        error: msg,
      };
    }

    await fileInput.setInputFiles(localPaths, {
      timeout: resolveUnggaTimeoutMs("upload"),
    });
    await page.waitForTimeout(1500);

    const afterCount = await waitForVisibleImageCount(
      page,
      baseline + imageUrls.length,
      resolveUnggaTimeoutMs("upload")
    );
    // Count only newly observed thumbnails; placeholders that already existed
    // stay reported separately. Accept >= expected (extra cover thumbs OK).
    const uploadedCount = Math.max(0, afterCount - baseline);
    const ok = uploadedCount >= imageUrls.length;
    metrics.push({
      step: "media_upload",
      ok,
      duration_ms: Date.now() - t0,
      expected_image_count: imageUrls.length,
      uploaded_image_count: uploadedCount,
      placeholder_image_count: baseline,
      total_visible_image_count: afterCount,
      ...(ok
        ? {}
        : {
            error: `expected ${imageUrls.length} new photos, observed ${uploadedCount} (total visible ${afterCount}, baseline ${baseline})`,
          }),
    });
    filled.push({
      media_upload: ok,
      expected_image_count: imageUrls.length,
      uploaded_image_count: uploadedCount,
      placeholder_image_count: baseline,
    });
    return {
      filled,
      uploaded_image_count: uploadedCount,
      expected_image_count: imageUrls.length,
      placeholder_image_count: baseline,
      ...(ok
        ? {}
        : {
            error: `expected ${imageUrls.length} new photos, observed ${uploadedCount}`,
          }),
    };
  } catch (e) {
    const msg = e?.message ?? String(e);
    metrics.push({
      step: "media_upload",
      ok: false,
      duration_ms: Date.now() - t0,
      expected_image_count: imageUrls.length,
      uploaded_image_count: 0,
      error: msg,
    });
    filled.push({ media_upload: false, error: msg });
    return {
      filled,
      uploaded_image_count: 0,
      expected_image_count: imageUrls.length,
      error: msg,
    };
  } finally {
    if (ownedTempDir) {
      await rm(ownedTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const IMAGE_DOWNLOAD_MAX_ATTEMPTS = 3;
const IMAGE_DOWNLOAD_RETRY_BACKOFF_MS = 1500;

function isRetryableImageDownloadError(error) {
  const msg = String(error?.message ?? error ?? "").toLowerCase();
  if (!msg) return false;
  if (/image download http (404|408|429|5\d\d)/i.test(msg)) return true;
  if (/abort|timed?\s*out|network|econnreset|enotfound|fetch failed/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Download all listing image_urls into a temp dir (with per-URL retries).
 * Caller owns cleanup of `tempDir`.
 */
async function downloadListingImagesToTemp(listing, metrics = []) {
  const imageUrls = Array.isArray(listing.image_urls)
    ? listing.image_urls
        .filter((u) => typeof u === "string" && u.trim())
        .map((u) => u.trim())
        .slice(0, MAX_UNGGA_IMAGE_DOWNLOADS)
    : [];
  if (imageUrls.length === 0) {
    return { tempDir: null, localPaths: [], expected_image_count: 0 };
  }
  const tempDir = await mkdtemp(path.join(tmpdir(), "ungga-media-preflight-"));
  try {
    const localPaths = [];
    for (let i = 0; i < imageUrls.length; i += 1) {
      const localPath = await downloadImageToTemp(imageUrls[i], tempDir, i);
      localPaths.push(localPath);
    }
    return {
      tempDir,
      localPaths,
      expected_image_count: imageUrls.length,
    };
  } catch (e) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    metrics.push({
      step: "media_download_batch",
      ok: false,
      error: e?.message ?? String(e),
      expected_image_count: imageUrls.length,
    });
    throw e;
  }
}

async function downloadImageToTemp(url, tempDir, index) {
  let lastError = null;
  for (let attempt = 1; attempt <= IMAGE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await downloadImageToTempOnce(url, tempDir, index);
    } catch (e) {
      lastError = e;
      const retryable = isRetryableImageDownloadError(e);
      if (!retryable || attempt >= IMAGE_DOWNLOAD_MAX_ATTEMPTS) {
        throw e;
      }
      await sleepMs(IMAGE_DOWNLOAD_RETRY_BACKOFF_MS);
    }
  }
  throw lastError ?? new Error(`image download failed for index ${index}`);
}

async function downloadImageToTempOnce(url, tempDir, index) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    resolveUnggaTimeoutMs("upload")
  );
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`image download HTTP ${res.status} for index ${index}`);
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(
        `image download rejected content-type ${contentType} for index ${index}`
      );
    }
    const ext = extensionFromContentType(contentType) || "jpg";
    const localPath = path.join(tempDir, `image-${String(index).padStart(2, "0")}.${ext}`);
    const contentLength = Number(res.headers.get("content-length") || "");
    if (Number.isFinite(contentLength) && contentLength > MAX_UNGGA_IMAGE_BYTES) {
      throw new Error(`image too large (${contentLength} bytes) for index ${index}`);
    }
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_UNGGA_IMAGE_BYTES) {
        throw new Error(`image too large (${buf.length} bytes) for index ${index}`);
      }
      await writeFile(localPath, buf);
      return localPath;
    }
    let written = 0;
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on("data", (chunk) => {
      written += chunk.length;
      if (written > MAX_UNGGA_IMAGE_BYTES) {
        controller.abort();
        throw new Error(`image too large (>${MAX_UNGGA_IMAGE_BYTES}) for index ${index}`);
      }
    });
    await pipeline(nodeStream, createWriteStream(localPath));
    return localPath;
  } finally {
    clearTimeout(timer);
  }
}

function extensionFromContentType(contentType) {
  if (!contentType) return null;
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return null;
}

async function waitForVisibleImageCount(page, expected, timeoutMsValue) {
  const started = Date.now();
  let lastCount = 0;
  while (Date.now() - started < timeoutMsValue) {
    lastCount = await countVisibleMediaThumbnails(page);
    if (lastCount >= expected) return lastCount;
    await page.waitForTimeout(750);
  }
  return lastCount;
}

async function countVisibleMediaThumbnails(page) {
  return page.evaluate(() => {
    const selectors = [
      'img[src*="blob:"]',
      'img[src*="http"]',
      '[data-testid*="image"] img',
      '[class*="thumbnail"] img',
      '[class*="preview"] img',
      'input[type="file"] ~ * img',
    ];
    const seen = new Set();
    for (const sel of selectors) {
      for (const img of document.querySelectorAll(sel)) {
        if (!(img instanceof HTMLImageElement)) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) continue;
        const key = img.src || `${rect.left}:${rect.top}:${rect.width}`;
        if (key) seen.add(key);
      }
    }
    return seen.size;
  });
}

/**
 * Llena pestaña OPERACIÓN. Por cada entrada de listing.operations abre el modal
 * "Elije el tipo de operación" (alta), selecciona el tab (Venta/Renta/...), captura
 * precio y moneda, y confirma. Luego edita/verifica comisión vía el lápiz de la
 * tarjeta (flujo real de Ungga: Operación → lápiz → COMISIÓN (%)).
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
    const commissionPct =
      op.commission_pct != null
        ? Number(op.commission_pct)
        : listing.commission_pct != null
          ? Number(listing.commission_pct)
          : null;
    const expectedCommission =
      Number.isFinite(commissionPct) && commissionPct > 0 ? commissionPct : null;

    // If a card already exists for this operation, skip add and edit via pencil.
    const existingCard = await findOperationCard(page, op);
    let tabClicked = false;
    let priceFilled = false;
    let currencySet = false;
    let confirmed = false;
    let editPath = "pencil";

    if (!existingCard) {
      editPath = "add_modal";
      const addBtn = await firstVisible([
        page.getByRole("button", { name: /agregar tipo de operación/i }),
        page.locator('button:has-text("Agregar tipo de operación")'),
        page.locator('[role="button"]:has-text("Agregar tipo de operación")'),
        page.locator("button, a").filter({ hasText: /agregar tipo de operaci[oó]n/i }),
        page.getByText(/agregar tipo de operaci[oó]n/i),
        page.getByRole("button", { name: /agregar otra operación/i }),
        page.locator("button, a").filter({ hasText: /agregar otra operaci[oó]n/i }),
      ]);
      if (!addBtn) {
        filled.push({
          op,
          ok: false,
          error: "no 'Agregar tipo de operación' button",
          edit_path: editPath,
        });
        break;
      }
      await addBtn.click().catch(() => {});
      await page.waitForTimeout(800);

      const MODAL_TITLE = /Elije el tipo de operación|Elige el tipo de operación/i;
      const addModal = await waitForOperationModal(page, MODAL_TITLE);
      const scope = addModal ?? page;

      const tabRegex = TAB_BY_TYPE[op.type] ?? null;
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
      if ((await priceInput.count()) > 0 && op.price != null) {
        await priceInput.fill(String(op.price));
        priceFilled = true;
      }

      const addScope = scope;

      if (op.currency) {
        const currencySelect = addScope
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

      // Prefer Contado so the confirm control can enable.
      const contado = await firstVisible([
        addScope.getByLabel(/^contado$/i),
        addScope.getByRole("checkbox", { name: /contado/i }),
        addScope.locator("label").filter({ hasText: /^contado$/i }),
      ]);
      if (contado) {
        await contado.click({ timeout: 3_000 }).catch(() => {});
      }

      // Share commission = Sí only when collaboration is enabled (not merely
      // because a commission_pct value exists). Enable before filling %.
      if (listing.collaboration_enabled === true) {
        await selectShareCommissionYes(addScope);
      }

      // Best-effort commission fill in add modal (may be absent; pencil is canonical).
      if (expectedCommission != null) {
        await fillCommissionInputInScope(addScope, expectedCommission);
      }

      confirmed = await confirmOperationModal(page, { op });
      if (!confirmed) {
        // One more attempt: click the rightmost enabled purple control in the overlay.
        const overlay = page.locator("div.fixed.inset-0").last();
        const retryBtn = overlay
          .locator('button[class*="bg-gradient-to-r"], button[class*="brand-purple"]')
          .last();
        if ((await retryBtn.count().catch(() => 0)) > 0) {
          await retryBtn.click({ timeout: 5_000, force: true }).catch(() => {});
          await page.waitForTimeout(1200);
          confirmed = Boolean(await findOperationCard(page, op));
        }
      }
      if (!confirmed) {
        await maybeCapture(page, "operation-confirm-failed", []);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(400);
      }
    } else {
      tabClicked = true;
      priceFilled = true;
      confirmed = true;
    }

    // Canonical path: open pencil on the operation card and set/verify commission.
    let commissionVerify = {
      expected: expectedCommission,
      actual: null,
      filled: false,
      persisted: false,
      edit_path: "pencil",
      retried: false,
    };
    if (expectedCommission != null) {
      commissionVerify = await verifyAndFixOperationCommission(page, {
        op,
        expectedCommission,
        collaborationEnabled: listing.collaboration_enabled === true,
      });
    }

    const commissionOk =
      expectedCommission == null || commissionVerify.persisted === true;
    filled.push({
      op,
      ok: (existingCard ? true : tabClicked && priceFilled && confirmed) && commissionOk,
      tab_clicked: tabClicked,
      price_filled: priceFilled,
      commission_filled: commissionVerify.filled || commissionVerify.persisted,
      commission_verified: commissionVerify.persisted,
      commission_expected: expectedCommission,
      commission_actual: commissionVerify.actual,
      commission_pct: expectedCommission,
      currency_set: currencySet,
      confirmed: existingCard ? true : confirmed,
      edit_path: existingCard ? "pencil" : editPath,
      commission_verify: commissionVerify,
    });
    if (!confirmed && !existingCard) break;
    if (!commissionOk) break;
  }
  return filled;
}

async function findOperationCard(page, op) {
  const typeLabel =
    op?.type === "rent"
      ? /renta(?!\s*temporal)/i
      : op?.type === "rent_temporary"
        ? /renta temporal/i
        : op?.type === "presale"
          ? /preventa/i
          : /venta/i;
  const priceHint =
    op?.price != null
      ? String(op.price).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      : null;

  // Prefer compact operation cards that already expose an edit affordance.
  const cards = page
    .locator("div, li, article, section")
    .filter({ hasText: typeLabel })
    .filter({ has: page.locator("button") });
  const count = await cards.count().catch(() => 0);
  let fallback = null;
  for (let i = 0; i < Math.min(count, 16); i += 1) {
    const card = cards.nth(i);
    const text = ((await card.innerText().catch(() => "")) || "").trim();
    if (!typeLabel.test(text)) continue;
    // Skip oversized containers that wrap the whole OPERATION tab.
    if (text.length > 600) continue;
    const pencil = await findPencilInCard(card);
    if (!pencil) continue;
    const priceMatches =
      !priceHint ||
      text.includes(priceHint) ||
      text.includes(String(op.price));
    if (priceMatches) return card;
    if (!fallback) fallback = card;
  }
  return fallback;
}

async function findPencilInCard(card) {
  const candidates = [
    card.getByRole("button", { name: /editar|edit|lápiz|lapiz/i }),
    card.locator(
      'button[aria-label*="editar" i], button[aria-label*="edit" i], button[title*="editar" i], button[title*="edit" i]'
    ),
    card.locator("button").filter({ hasText: /^✎$|^✏$/ }),
  ];
  for (const loc of candidates) {
    if ((await loc.count().catch(() => 0)) > 0) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  // Prefer icon buttons that are not trash/delete.
  const iconButtons = card.locator("button").filter({
    has: card.page().locator("svg"),
  });
  const n = await iconButtons.count().catch(() => 0);
  for (let idx = 0; idx < n; idx += 1) {
    const el = iconButtons.nth(idx);
    if (!(await el.isVisible().catch(() => false))) continue;
    const label = (
      (await el.getAttribute("aria-label").catch(() => "")) ||
      (await el.getAttribute("title").catch(() => "")) ||
      (await el.innerText().catch(() => "")) ||
      ""
    ).toLowerCase();
    if (/eliminar|borrar|delete|trash|remover/.test(label)) continue;
    if (/editar|edit|lápiz|lapiz|pencil/.test(label) || !label.trim()) {
      return el;
    }
  }
  return null;
}

function commissionInputCandidates(scope) {
  return [
    scope
      .locator("label")
      .filter({ hasText: /comisi[oó]n\s*\(%\)/i })
      .locator('input:not([type="hidden"]), [role="spinbutton"]')
      .first(),
    scope
      .locator("label")
      .filter({ hasText: /comisi[oó]n/i })
      .locator('input[type="number"], input:not([type]), [role="spinbutton"]')
      .first(),
    scope.locator('input[type="number"][name*="comision" i], input[type="number"][id*="comision" i]').first(),
    scope.locator('input[placeholder*="comisi" i], input[aria-label*="comisi" i]').first(),
    scope.getByLabel(/comisi[oó]n\s*\(%\)?/i).first(),
    scope.getByRole("spinbutton", { name: /comisi[oó]n/i }).first(),
    scope.getByPlaceholder(/comisi[oó]n|%/i).first(),
  ];
}

async function sleepMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fillCommissionInputInScope(scope, expectedCommission) {
  const started = Date.now();
  let lastStage = "locate_input";
  let commissionInput = null;
  while (Date.now() - started < 6_000) {
    commissionInput = await firstVisible(commissionInputCandidates(scope));
    if (commissionInput) {
      const enabled = await commissionInput.isEnabled().catch(() => false);
      if (enabled) break;
      lastStage = "input_disabled";
      commissionInput = null;
    } else {
      lastStage = "locate_input";
    }
    await sleepMs(200);
  }
  if (!commissionInput) {
    return {
      ok: false,
      actual: null,
      stage: lastStage,
      error: "commission_input_not_found",
    };
  }
  await commissionInput.click({ timeout: 2_000 }).catch(() => {});
  await commissionInput.fill("").catch(() => {});
  await commissionInput.fill(String(expectedCommission));
  await commissionInput.dispatchEvent("input").catch(() => {});
  await commissionInput.dispatchEvent("change").catch(() => {});
  await commissionInput.blur().catch(() => {});
  const current = await commissionInput.inputValue().catch(() => "");
  const numeric = String(current).replace(/[^\d.]/g, "");
  const ok =
    numeric === String(expectedCommission) ||
    Number(numeric) === Number(expectedCommission);
  return {
    ok,
    actual: numeric ? Number(numeric) : null,
    input: commissionInput,
    stage: ok ? "filled" : "value_mismatch",
    ...(ok ? {} : { error: "commission_input_value_mismatch" }),
  };
}

function operationModalRoot(page) {
  // Prefer true overlays/dialogs; avoid matching the whole OPERACIÓN tab via "precio".
  return page
    .locator("div.fixed.inset-0, [role='dialog']")
    .filter({
      hasText:
        /elige el tipo de operaci[oó]n|elije el tipo de operaci[oó]n|compartir comisi[oó]n|comisi[oó]n\s*\(%\)/i,
    });
}

async function waitForOperationModal(page, titleRegex = null) {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const root = operationModalRoot(page);
    const count = await root.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 4); i += 1) {
      const candidate = root.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (titleRegex) {
        const text = ((await candidate.innerText().catch(() => "")) || "").trim();
        if (!titleRegex.test(text)) continue;
      }
      return candidate;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function selectShareCommissionYes(scope) {
  const shareRegion = scope
    .locator("div, fieldset, section, label")
    .filter({ hasText: /compartir comisi[oó]n/i })
    .first();
  const region =
    (await shareRegion.count().catch(() => 0)) > 0 ? shareRegion : scope;
  const shareYes = await firstVisible([
    region.getByRole("radio", { name: /^sí$|^si$/i }),
    region.locator("label").filter({ hasText: /^sí$|^si$/i }),
    region.getByText(/^sí$|^si$/i),
  ]);
  if (!shareYes) return false;
  await shareYes.click({ timeout: 2_000 }).catch(() => {});
  await sleepMs(200);
  return true;
}

async function readCommissionInputValue(scope) {
  const commissionInput = await firstVisible(commissionInputCandidates(scope));
  if (!commissionInput) {
    return { ok: false, actual: null, stage: "locate_input", error: "commission_input_not_found" };
  }
  const raw = await commissionInput.inputValue().catch(() => "");
  const numeric = String(raw).replace(/[^\d.]/g, "");
  return {
    ok: true,
    actual: numeric ? Number(numeric) : null,
    input: commissionInput,
    stage: "read",
  };
}

async function looksLikeDismissControl(el) {
  const label = (
    (await el.getAttribute("aria-label").catch(() => "")) ||
    (await el.getAttribute("title").catch(() => "")) ||
    (await el.innerText().catch(() => "")) ||
    ""
  )
    .trim()
    .toLowerCase();
  return /^(x|×)$/.test(label) || /cancelar|cerrar|dismiss|cancel/.test(label);
}

/**
 * Confirm the operation modal via the purple check ("palomita") button.
 * Returns false if the confirm control could not be clicked or the modal stayed open.
 */
async function confirmOperationModal(page, opts = {}) {
  const modalRoot = operationModalRoot(page);
  let modal =
    (await modalRoot.count().catch(() => 0)) > 0 ? modalRoot.first() : null;
  if (!modal) {
    // Fallback: any visible fixed overlay that contains PRECIO / operación fields.
    modal = await firstVisible([
      page.locator("div.fixed.inset-0").filter({ hasText: /PRECIO|MONEDA|VENTA/i }),
      page.locator("[role='dialog']").filter({ hasText: /PRECIO|MONEDA|VENTA/i }),
    ]);
  }
  if (!modal) return false;

  const stillOpenBefore = await modal.isVisible().catch(() => false);
  if (!stillOpenBefore) return true;

  // Ungga's palomita is often an SVG-only purple/gradient button (no accessible name).
  // Prefer named confirms, then gradient/purple buttons that are not dismiss controls.
  let confirmBtn = await firstVisible([
    modal.getByRole("button", {
      name: /^confirmar$|^aceptar$|^guardar$|^✓$|^✔$/i,
    }),
    modal.locator("button").filter({ hasText: /^✓$|^✔$/ }).first(),
  ]);

  if (!confirmBtn) {
    const candidates = modal.locator(
      'button[class*="bg-gradient-to-r"], button[class*="brand-purple"], button'
    );
    const n = await candidates.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i -= 1) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if (await looksLikeDismissControl(el)) continue;
      const disabled = await el.isDisabled().catch(() => false);
      if (disabled) continue;
      const className = (await el.getAttribute("class").catch(() => "")) || "";
      const hasConfirmLook =
        /bg-gradient|brand-purple|from-|to-/.test(className) ||
        (await el.locator("svg").count().catch(() => 0)) > 0;
      if (!hasConfirmLook && i < n - 1) continue;
      confirmBtn = el;
      break;
    }
  }

  if (!confirmBtn) return false;

  try {
    await confirmBtn.click({ timeout: 5_000 });
  } catch {
    const forced = await confirmBtn
      .click({ timeout: 5_000, force: true })
      .then(() => true)
      .catch(() => false);
    if (!forced) return false;
  }
  await page.waitForTimeout(1200);

  const modalStillVisible =
    (await operationModalRoot(page).count().catch(() => 0)) > 0 &&
    (await operationModalRoot(page).first().isVisible().catch(() => false));
  if (!modalStillVisible) return true;

  // Success can also mean the operation card appeared even if an overlay heuristic lags.
  if (opts.op) {
    const card = await findOperationCard(page, opts.op);
    if (card) return true;
  }
  return false;
}

/**
 * Open operation card pencil, set COMISIÓN (%), confirm with palomita,
 * reopen and read-only verify persistence (never rewrite on re-read).
 */
export async function verifyAndFixOperationCommission(page, params) {
  const expected = Number(params?.expectedCommission);
  const collaborationEnabled = params?.collaborationEnabled === true;
  const result = {
    expected: Number.isFinite(expected) && expected > 0 ? expected : null,
    actual: null,
    filled: false,
    persisted: false,
    edit_path: "pencil",
    retried: false,
    error: null,
    stage: null,
  };
  if (result.expected == null) {
    result.persisted = true;
    return result;
  }

  await clickWizardTab(page, "OPERACIÓN").catch(() => {});
  await page.waitForTimeout(400);

  const attempt = async () => {
    const card = await findOperationCard(page, params.op ?? {});
    if (!card) {
      return { ok: false, error: "operation_card_not_found", stage: "find_card" };
    }
    const pencil = await findPencilInCard(card);
    if (!pencil) {
      return { ok: false, error: "pencil_not_found", stage: "find_pencil" };
    }
    await pencil.click({ timeout: 5_000 }).catch(() => {});
    const modal = await waitForOperationModal(page);
    if (!modal) {
      return { ok: false, error: "operation_modal_not_visible", stage: "wait_modal" };
    }

    // Enable share-commission only when collaboration is requested.
    if (collaborationEnabled) {
      await selectShareCommissionYes(modal);
    }

    const fill = await fillCommissionInputInScope(modal, result.expected);
    result.filled = fill.ok;
    result.actual = fill.actual;
    result.stage = fill.stage ?? null;
    if (!fill.ok) {
      await page.keyboard.press("Escape").catch(() => {});
      return {
        ok: false,
        error: fill.error || "commission_input_not_filled",
        stage: fill.stage ?? "fill_input",
      };
    }
    const confirmed = await confirmOperationModal(page);
    if (!confirmed) {
      await page.keyboard.press("Escape").catch(() => {});
      return { ok: false, error: "commission_confirm_palomita_failed", stage: "confirm" };
    }

    // Re-open and READ-ONLY verify (do not rewrite the field).
    await page.waitForTimeout(600);
    const card2 = await findOperationCard(page, params.op ?? {});
    if (!card2) {
      return { ok: false, error: "operation_card_missing_after_save", stage: "reopen_card" };
    }
    const pencil2 = await findPencilInCard(card2);
    if (!pencil2) {
      return { ok: false, error: "pencil_missing_after_save", stage: "reopen_pencil" };
    }
    await pencil2.click({ timeout: 5_000 }).catch(() => {});
    const modal2 = await waitForOperationModal(page);
    if (!modal2) {
      return { ok: false, error: "operation_modal_missing_after_save", stage: "reopen_modal" };
    }

    const reread = await readCommissionInputValue(modal2);
    result.actual = reread.actual;
    result.stage = reread.stage ?? "reread";
    const persisted =
      reread.ok &&
      reread.actual != null &&
      Number(reread.actual) === Number(result.expected);
    // Close without rewriting: Escape is enough for a read-only check.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    return {
      ok: persisted,
      error: persisted ? null : "commission_not_persisted",
      stage: persisted ? "verified" : "reread_mismatch",
    };
  };

  let first = await attempt();
  if (!first.ok) {
    result.retried = true;
    first = await attempt();
  }
  result.persisted = first.ok === true;
  result.error = first.error ?? null;
  result.stage = first.stage ?? result.stage;
  return result;
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
    await dismissStrayModals(page);
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
    await button.click({ timeout: resolveUnggaTimeoutMs("action") });
    // Prefer deterministic draft signals over networkidle (which can hang forever).
    const draftReady = await Promise.race([
      page
        .waitForURL(/\/propiedades\/(?!nueva(?:\/|$))[^/?#]+/i, {
          timeout: resolveUnggaTimeoutMs("nav"),
        })
        .then(() => "url")
        .catch(() => null),
      page
        .getByText(/GU-ID/i)
        .first()
        .waitFor({ state: "visible", timeout: resolveUnggaTimeoutMs("nav") })
        .then(() => "gu_id")
        .catch(() => null),
      page
        .getByText(/borrador\s+guardado|guardado\s+como\s+borrador|propiedad\s+creada/i)
        .first()
        .waitFor({ state: "visible", timeout: resolveUnggaTimeoutMs("nav") })
        .then(() => "toast")
        .catch(() => null),
      page
        .waitForURL(/\/app\/propiedades\/?(?:\?|#|$)/i, {
          timeout: resolveUnggaTimeoutMs("nav"),
        })
        .then(() => "properties_list")
        .catch(() => null),
      page
        .waitForLoadState("networkidle", {
          timeout: Math.min(resolveUnggaTimeoutMs("nav"), 20_000),
        })
        .then(() => "networkidle")
        .catch(() => null),
    ]);
    await page.waitForTimeout(800);
    await maybeCapture(page, "after-save-draft", metrics);
    const urlId = extractPropertyIdFromUrl(page.url());
    const onPropertiesList =
      /\/app\/propiedades\/?(?:\?|#|$)/i.test(page.url()) && !urlId;
    const ok = Boolean(draftReady || urlId || onPropertiesList);
    metrics.push({
      step: "save_draft",
      ok,
      duration_ms: Date.now() - t0,
      url: page.url(),
      signal: draftReady ?? (onPropertiesList ? "properties_list" : null),
      ...(ok
        ? {}
        : { error: "No se confirmó guardado de borrador (URL/GU-ID/toast)." }),
    });
    return ok
      ? {
          ok: true,
          url: page.url(),
          signal: draftReady ?? (onPropertiesList ? "properties_list" : null),
        }
      : {
          ok: false,
          error: "No se confirmó guardado de borrador (URL/GU-ID/toast).",
          url: page.url(),
        };
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
    if (looksLikeEasyBrokerImportedUnggaId(postSaveId)) {
      out.lookup.fallback_reason =
        "post_save_url looked like EasyBroker import; ignoring";
      metrics.push({
        step: "resolve_draft_links",
        ok: false,
        via: "post_save_url_rejected_import",
        error: out.lookup.fallback_reason,
        duration_ms: Date.now() - t0,
        rejected_id: postSaveId,
      });
    } else {
      out.draft_url = `${origin}/app/propiedades/${postSaveId}`;
      out.ungga_property_id = postSaveId;
      out.lookup.method = "post_save_url";
      out.lookup.creation_source = "cli";
      metrics.push({
        step: "resolve_draft_links",
        ok: true,
        via: "post_save_url",
        duration_ms: Date.now() - t0,
        draft_url: out.draft_url,
        creation_source: "cli",
      });
      return out;
    }
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
      timeout: resolveUnggaTimeoutMs("nav"),
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
      if (looksLikeEasyBrokerImportedUnggaId(modalGuId)) {
        out.lookup.fallback_reason =
          "modal GU-ID looked like EasyBroker import; rejecting";
        metrics.push({
          step: "resolve_draft_links",
          ok: false,
          via: "modal_gu_id_rejected_import",
          error: out.lookup.fallback_reason,
          duration_ms: Date.now() - t0,
          rejected_id: modalGuId,
        });
        return out;
      }
      out.ungga_property_id = modalGuId;
      out.draft_url = `${origin}/app/propiedades/${modalGuId}`;
      out.lookup.method = "listing_search";
      out.lookup.via = "modal_gu_id";
      out.lookup.creation_source = "cli";
      metrics.push({
        step: "resolve_draft_links",
        ok: true,
        via: "modal_gu_id",
        duration_ms: Date.now() - t0,
        draft_url: out.draft_url,
        ungga_property_id: out.ungga_property_id,
        creation_source: "cli",
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
            timeout: resolveUnggaTimeoutMs("action"),
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
    if (
      out.ungga_property_id &&
      looksLikeEasyBrokerImportedUnggaId(out.ungga_property_id)
    ) {
      out.lookup.fallback_reason =
        "detalle GU-ID looked like EasyBroker import; rejecting";
      out.ungga_property_id = null;
      out.draft_url = null;
    }
    if (!out.ungga_property_id) {
      out.lookup.fallback_reason =
        out.lookup.fallback_reason ||
        "could not resolve GU-ID from modal or DETALLE navigation";
    } else {
      out.lookup.creation_source = "cli";
    }
    metrics.push({
      step: "resolve_draft_links",
      ok: Boolean(out.ungga_property_id),
      via: out.ungga_property_id ? "detalle_navigation" : "listing_search",
      duration_ms: Date.now() - t0,
      draft_url: out.draft_url,
      ungga_property_id: out.ungga_property_id,
      ...(out.lookup.creation_source
        ? { creation_source: out.lookup.creation_source }
        : {}),
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
  const overlay = page.locator("div.fixed.inset-0.z-50").first();
  if ((await overlay.count()) > 0 && (await overlay.isVisible().catch(() => false))) {
    const closeBtn = await firstVisible([
      overlay.getByRole("button", { name: /^cancelar$|^cerrar$|^✕$|^x$/i }),
      overlay.locator("button").first(),
    ]);
    if (closeBtn) {
      await closeBtn.click({ timeout: 2_000, force: true }).catch(() => {});
      await page.waitForTimeout(400);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    }
  }
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
    for (let i = 0; i < Math.min(total, 8); i += 1) {
      const candidate = loc.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await candidate.innerText().catch(() => "")) || "";
      if (cardLooksLikeEasyBrokerImport(text)) continue;
      return candidate;
    }
  }
  const textNode = page.locator(`text="${safeTitle}"`).first();
  if ((await textNode.count().catch(() => 0)) > 0) {
    const ancestor = textNode.locator(
      "xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]"
    );
    const text = (await ancestor.innerText().catch(() => "")) || "";
    if (!cardLooksLikeEasyBrokerImport(text)) return ancestor;
  }
  return null;
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
  const wanted = String(value).trim();
  if (!wanted) return false;
  const control = page
    .locator(`label:has-text("${labelHint(label)}")`)
    .locator("select")
    .nth(nth);
  const target =
    (await control.count()) > 0 ? control : page.getByLabel(label).first();
  if ((await target.count()) === 0) return false;

  const attempts = [
    wanted,
    { label: wanted },
    { label: new RegExp(`^${escapeRegex(wanted)}$`, "i") },
  ];
  for (const attempt of attempts) {
    try {
      await target.selectOption(attempt);
      return true;
    } catch {
      // try next strategy
    }
  }

  try {
    const matched = await target.evaluate((el, needle) => {
      const norm = (s) =>
        String(s || "")
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      const n = norm(needle);
      const options = [...(el.options || [])];
      const hit = options.find((opt) => {
        const text = norm(opt.textContent || opt.label || "");
        const val = norm(opt.value || "");
        return text === n || val === n || text.includes(n) || val.includes(n);
      });
      if (!hit) return null;
      el.value = hit.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return hit.value;
    }, wanted);
    if (matched != null) return true;
  } catch {
    // fall through
  }

  try {
    await target.fill(wanted);
    return true;
  } catch {
    return false;
  }
}

function latestValidationErrors(metrics, fromTab) {
  const step = `continue_after_${fromTab}`;
  for (let i = metrics.length - 1; i >= 0; i -= 1) {
    const row = metrics[i];
    if (row?.step === step && Array.isArray(row.validation_errors)) {
      return row.validation_errors.filter((e) => typeof e === "string" && e.trim());
    }
  }
  return [];
}

function labelHint(label) {
  if (label instanceof RegExp) {
    return label.source
      .split("|")[0]
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
  const urlBefore = page.url();
  if (looksLikeCreatePropertyWizard(urlBefore)) {
    metrics.push({
      step: "open_create_property",
      ok: true,
      duration_ms: Date.now() - t0,
      url: urlBefore,
      already_on_wizard: true,
    });
    return true;
  }
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
        timeout: resolveUnggaTimeoutMs("nav"),
      });
    } else {
      await createAction.click({ timeout: 10_000 });
    }
    await page.waitForLoadState("domcontentloaded", {
      timeout: resolveUnggaTimeoutMs("nav"),
    });
    await page.waitForTimeout(500);
    const urlAfter = page.url();
    const navigated =
      urlAfter !== urlBefore ||
      looksLikeCreatePropertyWizard(urlAfter) ||
      (await hasWizardGeneralFields(page));
    metrics.push({
      step: "open_create_property",
      ok: navigated,
      duration_ms: Date.now() - t0,
      url: urlAfter,
      ...(navigated
        ? {}
        : {
            error:
              "Create action did not open the listing wizard (URL/fields unchanged)",
          }),
    });
    return navigated;
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

function looksLikeCreatePropertyWizard(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    return /\/propiedades\/(?:nueva|new)$/i.test(pathname);
  } catch {
    return /\/propiedades\/(?:nueva|new)\b/i.test(String(url ?? ""));
  }
}

function resolveCreatePropertyFallbackUrl(currentUrl) {
  try {
    const origin = new URL(currentUrl).origin;
    return `${origin}/app/propiedades/nueva`;
  } catch {
    return "https://ungga.com/app/propiedades/nueva";
  }
}

async function hasWizardGeneralFields(page) {
  const title = page.getByLabel(/T[ÍI]TULO/i).first();
  if (await title.isVisible().catch(() => false)) return true;
  const propertyType = page.getByLabel(/TIPO DE PROPIEDAD/i).first();
  if (await propertyType.isVisible().catch(() => false)) return true;
  const wizardTab = page.getByRole("button", { name: /^GENERAL$/i }).first();
  return wizardTab.isVisible().catch(() => false);
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
