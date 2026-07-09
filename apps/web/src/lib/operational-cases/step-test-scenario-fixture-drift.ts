/**
 * Detecta cuando el estado actual del caso de laboratorio ya no calza con la
 * semilla esperada de un escenario N4 (p. ej. tras pruebas N1 que mutan el fixture).
 */

import { rawPhotosCount } from "./package-ready-preflight-validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function pricingApproved(context: Record<string, unknown>): boolean {
  const proposal = isRecord(context.pricing_proposal) ? context.pricing_proposal : {};
  return cleanText(proposal.approval_status).toLowerCase() === "approved";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Avisos legibles para UI antes de ejecutar N4. Vacío = sin conflicto detectado. */
export function detectStepScenarioFixtureDrift(
  scenarioId: string,
  context: Record<string, unknown> | null | undefined
): string[] {
  if (!context) return [];
  const warnings: string[] = [];
  const photoCount = rawPhotosCount(context);

  switch (scenarioId) {
    case "package_ready_preflight_blocked":
    case "photos_requested_request_internal_photos":
      if (photoCount >= 5) {
        warnings.push(
          `Este escenario prueba faltantes con menos de 5 fotos; el caso actual tiene ${photoCount}. Regenera el caso de laboratorio o elige otro escenario.`
        );
      }
      break;

    case "package_ready_description_review_requested":
      if (photoCount < 5) {
        warnings.push(
          `Este escenario espera al menos 5 fotos en raw_photos; el caso tiene ${photoCount}.`
        );
      }
      if (!pricingApproved(context)) {
        warnings.push(
          "Este escenario espera pricing_proposal con approval_status=approved."
        );
      }
      break;

    case "package_ready_description_approved":
      if (!hasNonEmptyRecord(context.listing_description_draft)) {
        warnings.push(
          "Este escenario espera listing_description_draft persistido en el caso."
        );
      }
      break;

    case "package_ready_easybroker_approval_requested":
      if (!hasNonEmptyRecord(context.listing_description_approved)) {
        warnings.push(
          "Este escenario espera listing_description_approved en el caso."
        );
      }
      break;

    case "package_ready_easybroker_published":
    case "package_ready_completed_summary_sent":
      if (scenarioId === "package_ready_completed_summary_sent") {
        const published = isRecord(context.published) ? context.published : {};
        const easybroker = isRecord(published.easybroker) ? published.easybroker : null;
        if (!hasNonEmptyRecord(easybroker) && !hasNonEmptyRecord(context.manual_publish_package)) {
          warnings.push(
            "Este escenario espera published.easybroker o manual_publish_package; el caso aún no los tiene (run-step aplicará semilla al iniciar)."
          );
        }
      }
      break;

    default:
      break;
  }

  return warnings;
}
