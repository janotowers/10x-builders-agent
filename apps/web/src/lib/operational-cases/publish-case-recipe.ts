/**
 * Resolución de payload de publicación desde context_jsonb del caso de laboratorio.
 * Alineado con publish-listing-package / adapters de producción.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.\-]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Igual que mergeContextForToolRecipes: property_data aplanado + raíz del caso. */
export function mergedPublishContext(context: Record<string, unknown>): Record<string, unknown> {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  return { ...propertyData, ...context };
}

export function resolvePublishListingPrice(context: Record<string, unknown>): number | null {
  const proposal = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
  const salida = numericValue(proposal.salida);
  if (salida != null && salida > 0) return salida;

  const merged = mergedPublishContext(context);
  for (const key of [
    "target_price",
    "expected_price",
    "asking_price",
    "price",
    "precio",
  ]) {
    const parsed = numericValue(merged[key]);
    if (parsed != null && parsed > 0) return parsed;
  }
  return null;
}

export function resolvePublishListingCurrency(context: Record<string, unknown>): string {
  const proposal = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
  const merged = mergedPublishContext(context);
  return (
    cleanText(proposal.currency) ||
    cleanText(merged.currency) ||
    cleanText(merged.moneda) ||
    "MXN"
  );
}

export type PublishListingCopySource = "approved" | "draft" | "markdown" | null;

export function resolvePublishListingCopy(context: Record<string, unknown>): {
  title: string | null;
  description: string | null;
  source: PublishListingCopySource;
} {
  const approved = isRecord(context.listing_description_approved)
    ? context.listing_description_approved
    : {};
  const approvedHeadline = cleanText(approved.headline);
  const approvedDescription = cleanText(approved.description);
  if (approvedDescription) {
    return {
      title: approvedHeadline || null,
      description: approvedDescription,
      source: "approved",
    };
  }

  const draft = isRecord(context.listing_description_draft)
    ? context.listing_description_draft
    : {};
  const draftHeadline = cleanText(draft.headline);
  const draftDescription = cleanText(draft.description);
  if (draftDescription) {
    return {
      title: draftHeadline || null,
      description: draftDescription,
      source: "draft",
    };
  }

  const markdown = cleanText(context.listing_description_md);
  if (markdown) {
    return { title: null, description: markdown, source: "markdown" };
  }

  return { title: null, description: null, source: null };
}

export function resolvePublishConstructionAreaM2(
  context: Record<string, unknown>
): number | null {
  const merged = mergedPublishContext(context);
  for (const key of [
    "area_built_m2",
    "built_area_m2",
    "construction_m2",
    "construction_size",
    "area_construida_m2",
    "superficie_construida",
    "area_m2",
    "superficie",
    "m2",
  ]) {
    const parsed = numericValue(merged[key]);
    if (parsed != null && parsed > 0) return parsed;
  }
  return null;
}

export function resolvePublishLandAreaM2(context: Record<string, unknown>): number | null {
  const merged = mergedPublishContext(context);
  for (const key of ["area_total_m2", "land_m2", "lot_size", "lot_size_m2", "terreno"]) {
    const parsed = numericValue(merged[key]);
    if (parsed != null && parsed > 0) return parsed;
  }
  return null;
}
