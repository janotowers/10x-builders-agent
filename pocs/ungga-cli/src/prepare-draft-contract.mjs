/**
 * Pure helpers for Ungga prepare_draft success, timeouts and diagnostics.
 * Kept free of Playwright so selftests can run without a browser.
 */

export const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
export const DEFAULT_NAV_TIMEOUT_MS = 45_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 90_000;
export const MAX_UNGGA_IMAGE_DOWNLOADS = 30;
export const MAX_UNGGA_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Resolve a timeout from env with fallbacks.
 * Preference order for total: UNGGA_CLI_TOTAL_TIMEOUT_MS → UNGGA_CLI_TIMEOUT_MS → fallback.
 */
export function resolveUnggaTimeoutMs(kind, env = process.env) {
  const read = (name) => {
    const raw = Number(env?.[name] ?? "");
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
  };
  if (kind === "total") {
    return (
      read("UNGGA_CLI_TOTAL_TIMEOUT_MS") ??
      read("UNGGA_CLI_TIMEOUT_MS") ??
      DEFAULT_TOTAL_TIMEOUT_MS
    );
  }
  if (kind === "nav") {
    return (
      read("UNGGA_CLI_NAV_TIMEOUT_MS") ??
      Math.min(
        read("UNGGA_CLI_TIMEOUT_MS") ?? DEFAULT_NAV_TIMEOUT_MS,
        DEFAULT_NAV_TIMEOUT_MS
      )
    );
  }
  if (kind === "action") {
    return (
      read("UNGGA_CLI_ACTION_TIMEOUT_MS") ??
      Math.min(
        read("UNGGA_CLI_TIMEOUT_MS") ?? DEFAULT_ACTION_TIMEOUT_MS,
        DEFAULT_ACTION_TIMEOUT_MS
      )
    );
  }
  if (kind === "upload") {
    return (
      read("UNGGA_CLI_UPLOAD_TIMEOUT_MS") ??
      Math.max(
        DEFAULT_UPLOAD_TIMEOUT_MS,
        Math.min(read("UNGGA_CLI_TIMEOUT_MS") ?? DEFAULT_UPLOAD_TIMEOUT_MS, 120_000)
      )
    );
  }
  return DEFAULT_ACTION_TIMEOUT_MS;
}

export function extractPropertyIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/propiedades\/([^/?#]+)(?:[/?#]|$)/i);
  if (!m) return null;
  const id = m[1];
  if (!id || id === "nueva" || id === "new") return null;
  return id;
}

export function lastMeaningfulStep(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return null;
  for (let i = metrics.length - 1; i >= 0; i -= 1) {
    const entry = metrics[i];
    if (!entry || typeof entry !== "object") continue;
    if (entry.step === "screenshot") continue;
    return entry;
  }
  return null;
}

/**
 * Evaluate whether a prepare_draft CLI run may be treated as success.
 */
export function evaluatePrepareDraftSuccess(params) {
  const dryRun = params?.dryRun === true;
  const expectedImageCount =
    typeof params?.expectedImageCount === "number" && params.expectedImageCount > 0
      ? params.expectedImageCount
      : 0;
  const uploadedImageCount =
    typeof params?.uploadedImageCount === "number" ? params.uploadedImageCount : null;
  const saveOutcome = params?.saveOutcome ?? null;
  const draftLinks = params?.draftLinks ?? null;
  const unggaPropertyId =
    (typeof draftLinks?.ungga_property_id === "string" &&
      draftLinks.ungga_property_id.trim()) ||
    (typeof params?.unggaPropertyId === "string" && params.unggaPropertyId.trim()) ||
    null;
  const draftUrl =
    (typeof draftLinks?.draft_url === "string" && draftLinks.draft_url.trim()) ||
    (typeof params?.draftUrl === "string" && params.draftUrl.trim()) ||
    null;

  if (dryRun) {
    const mediaOk =
      expectedImageCount === 0 ||
      (uploadedImageCount != null && uploadedImageCount >= expectedImageCount);
    return {
      ok: mediaOk,
      dry_run: true,
      ungga_property_id: null,
      draft_url: null,
      expected_image_count: expectedImageCount,
      uploaded_image_count: uploadedImageCount,
      images_submitted: expectedImageCount > 0 && mediaOk,
      images_verified: expectedImageCount > 0 && mediaOk,
      error: mediaOk
        ? null
        : `Media incomplete in dry-run: expected ${expectedImageCount}, got ${uploadedImageCount ?? 0}`,
    };
  }

  if (!saveOutcome || saveOutcome.ok !== true) {
    return {
      ok: false,
      dry_run: false,
      ungga_property_id: null,
      draft_url: null,
      expected_image_count: expectedImageCount,
      uploaded_image_count: uploadedImageCount,
      images_submitted: false,
      images_verified: false,
      error:
        (typeof saveOutcome?.error === "string" && saveOutcome.error) ||
        "Guardar como borrador no confirmó éxito.",
    };
  }

  if (!unggaPropertyId || !draftUrl) {
    return {
      ok: false,
      dry_run: false,
      ungga_property_id: unggaPropertyId,
      draft_url: draftUrl,
      expected_image_count: expectedImageCount,
      uploaded_image_count: uploadedImageCount,
      images_submitted: false,
      images_verified: false,
      error:
        "Borrador guardado pero no se resolvió ungga_property_id/draft_url (GU-ID).",
    };
  }

  if (
    expectedImageCount > 0 &&
    (uploadedImageCount == null || uploadedImageCount < expectedImageCount)
  ) {
    return {
      ok: false,
      dry_run: false,
      ungga_property_id: unggaPropertyId,
      draft_url: draftUrl,
      expected_image_count: expectedImageCount,
      uploaded_image_count: uploadedImageCount,
      images_submitted: uploadedImageCount != null && uploadedImageCount > 0,
      images_verified: false,
      error: `Media incomplete: expected ${expectedImageCount} photos, observed ${uploadedImageCount ?? 0}`,
    };
  }

  const expectedCommission =
    typeof params?.expectedCommissionPct === "number" &&
    Number.isFinite(params.expectedCommissionPct) &&
    params.expectedCommissionPct > 0
      ? params.expectedCommissionPct
      : null;
  const commissionVerified = params?.commissionVerified === true;
  const commissionActual =
    typeof params?.commissionActual === "number" &&
    Number.isFinite(params.commissionActual)
      ? params.commissionActual
      : null;

  if (expectedCommission != null && !commissionVerified) {
    return {
      ok: false,
      dry_run: false,
      ungga_property_id: unggaPropertyId,
      draft_url: draftUrl,
      expected_image_count: expectedImageCount,
      uploaded_image_count: uploadedImageCount ?? expectedImageCount,
      images_submitted: expectedImageCount > 0,
      images_verified: expectedImageCount > 0,
      commission_expected: expectedCommission,
      commission_actual: commissionActual,
      commission_verified: false,
      error: `Commission not verified: expected ${expectedCommission}%, got ${commissionActual ?? "null"}`,
    };
  }

  return {
    ok: true,
    dry_run: false,
    ungga_property_id: unggaPropertyId,
    draft_url: draftUrl,
    expected_image_count: expectedImageCount,
    uploaded_image_count: uploadedImageCount ?? expectedImageCount,
    images_submitted: expectedImageCount > 0,
    images_verified: expectedImageCount > 0,
    commission_expected: expectedCommission,
    commission_actual:
      expectedCommission == null ? null : (commissionActual ?? expectedCommission),
    commission_verified: expectedCommission == null ? true : true,
    error: null,
  };
}

/**
 * Adapter-facing validation: reject incomplete CLI JSON even if ok:true.
 */
export function validateUnggaCliPrepareDraftResult(parsed) {
  const result =
    parsed && typeof parsed === "object" && parsed.result && typeof parsed.result === "object"
      ? parsed.result
      : parsed && typeof parsed === "object"
        ? parsed
        : {};
  const mode = typeof parsed?.mode === "string" ? parsed.mode : null;
  const dryRun = mode === "dry_run" || result.dry_run === true;
  const expected =
    typeof result.expected_image_count === "number"
      ? result.expected_image_count
      : Array.isArray(result.image_urls)
        ? result.image_urls.length
        : 0;
  const uploaded =
    typeof result.uploaded_image_count === "number"
      ? result.uploaded_image_count
      : typeof result.image_count === "number"
        ? result.image_count
        : null;
  const propertyId =
    (typeof result.ungga_property_id === "string" && result.ungga_property_id.trim()) ||
    (typeof result.ungga_listing_id === "string" && result.ungga_listing_id.trim()) ||
    (typeof result.property_id === "string" && result.property_id.trim()) ||
    null;
  const draftUrl =
    (typeof result.draft_url === "string" && result.draft_url.trim()) || null;

  const expectedCommission =
    typeof result.commission_expected === "number" &&
    Number.isFinite(result.commission_expected) &&
    result.commission_expected > 0
      ? result.commission_expected
      : null;
  const commissionActual =
    typeof result.commission_actual === "number" &&
    Number.isFinite(result.commission_actual)
      ? result.commission_actual
      : null;
  const commissionVerified =
    expectedCommission == null
      ? true
      : result.commission_verified === true;

  return evaluatePrepareDraftSuccess({
    dryRun,
    expectedImageCount: expected,
    uploadedImageCount: uploaded,
    saveOutcome: dryRun
      ? { ok: true }
      : result.save_outcome && typeof result.save_outcome === "object"
        ? result.save_outcome
        : parsed?.ok === true && propertyId && draftUrl
          ? { ok: true }
          : { ok: false, error: "save_outcome missing" },
    draftLinks: {
      ungga_property_id: propertyId,
      draft_url: draftUrl,
    },
    expectedCommissionPct: expectedCommission,
    commissionActual,
    commissionVerified,
  });
}
