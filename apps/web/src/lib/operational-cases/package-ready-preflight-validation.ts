/**
 * Validación N3/N4 cuando package_ready debe bloquear publicación (preflight).
 * Patrón: escenario package_ready_preflight_blocked
 */

const PUBLISH_TOOLS = [
  "image_watermark",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
] as const;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function rawPhotosCount(context: Record<string, unknown>): number {
  const raw = context.raw_photos;
  return Array.isArray(raw) ? raw.length : 0;
}

export function collectPackageReadyPreflightMissingData(
  context: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  const propertyData = asRecord(context.property_data);
  const pricingProposal = asRecord(context.pricing_proposal);
  const contractReview = asRecord(context.contract_review);

  const approvalStatus =
    cleanText(pricingProposal.approval_status) || cleanText(context.approval_status);
  if (approvalStatus !== "approved") {
    missing.push("pricing_proposal.approval_status=approved");
  }

  const contractStatus = cleanText(contractReview.status);
  if (contractStatus !== "sent_by_email") {
    missing.push("contract_review.status=sent_by_email");
  }

  if (rawPhotosCount(context) < 5) {
    missing.push("raw_photos>=5");
  }

  const propertyType = cleanText(propertyData.property_type || context.property_type);
  const operationType = cleanText(propertyData.operation || context.operation_type);
  const currency =
    cleanText(propertyData.currency) ||
    cleanText(pricingProposal.currency) ||
    cleanText(context.currency);
  const municipality = cleanText(propertyData.municipality || propertyData.city);
  const state = cleanText(propertyData.state);
  const hasAddress =
    cleanText(propertyData.legal_address) ||
    cleanText(propertyData.street) ||
    cleanText(propertyData.address);
  const targetPrice =
    typeof pricingProposal.target_price === "number" && Number.isFinite(pricingProposal.target_price)
      ? pricingProposal.target_price
      : typeof propertyData.target_price === "number" && Number.isFinite(propertyData.target_price)
        ? propertyData.target_price
        : null;

  if (!propertyType) missing.push("property_type");
  if (!operationType) missing.push("operation_type");
  if (!currency) missing.push("currency");
  if (!hasAddress || !municipality || !state) {
    missing.push("address_municipality_state");
  }
  if (!targetPrice || targetPrice <= 0) {
    missing.push("target_price");
  }

  const bedrooms =
    typeof propertyData.bedrooms === "number" ? propertyData.bedrooms : null;
  const bathrooms =
    typeof propertyData.bathrooms === "number" ? propertyData.bathrooms : null;
  const parkingSpots =
    typeof propertyData.parking_spots === "number" ? propertyData.parking_spots : null;
  const areaTotal =
    typeof propertyData.area_total_m2 === "number" ? propertyData.area_total_m2 : null;
  const areaBuilt =
    typeof propertyData.area_built_m2 === "number" ? propertyData.area_built_m2 : null;

  const normalizedType = propertyType.toLowerCase();
  if (normalizedType.includes("casa") || normalizedType.includes("depart")) {
    if (bedrooms == null || bedrooms < 0) missing.push("bedrooms");
    if (bathrooms == null || bathrooms < 0) missing.push("bathrooms");
    if (parkingSpots == null || parkingSpots < 0) missing.push("parking_spots");
    if ((areaBuilt == null || areaBuilt <= 0) && (areaTotal == null || areaTotal <= 0)) {
      missing.push("area_built_or_total_m2");
    }
  }
  if (normalizedType.includes("terreno") || normalizedType.includes("lote")) {
    if (areaTotal == null || areaTotal <= 0) missing.push("area_total_m2");
  }

  return missing;
}

export function publishToolExecuted(
  toolCalls: Array<{ tool_name: string; status: string }>
) {
  return PUBLISH_TOOLS.filter((toolName) =>
    toolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  );
}

export function validatePackageReadyPreflightOutcome(params: {
  current_step: string;
  status: string;
  context: Record<string, unknown>;
  notify_user_executed: boolean;
  toolCalls: Array<{ tool_name: string; status: string }>;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (params.current_step !== "package_ready") {
    errors.push("current_step debe ser package_ready.");
  }
  if (params.status !== "paused") {
    errors.push("status debe ser paused cuando el preflight bloquea publicación.");
  }
  if (!params.notify_user_executed) {
    errors.push("notify_user debe explicar qué falta para publicar.");
  }
  const missingPreflight = collectPackageReadyPreflightMissingData(params.context);
  if (missingPreflight.length === 0) {
    errors.push(
      "el escenario de preflight bloqueado debe tener faltantes reales antes de intentar publicar."
    );
  }
  const published = publishToolExecuted(params.toolCalls);
  if (published.length > 0) {
    errors.push(
      `No debe publicar ni procesar paquete en preflight bloqueado; tools ejecutadas de más: ${published.join(", ")}.`
    );
  }
  const photoCount = rawPhotosCount(params.context);
  if (photoCount >= 5) {
    errors.push(
      "raw_photos no debe tener 5+ fotos en el escenario de preflight bloqueado."
    );
  }
  return { ok: errors.length === 0, errors };
}
