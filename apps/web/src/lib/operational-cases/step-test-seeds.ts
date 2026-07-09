/**
 * Semillas de contexto para escenarios N4 (paso).
 * Complementa context_patch en run-step cuando el caso de prueba aún no trae artefactos.
 */

import {
  mergePropertyDataForComparables,
  resolveEffectiveSearchZone,
  settingsTestPropertyDataSeed,
} from "./property-search-zone";
import { COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID } from "./comparables-analysis-validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function packageReadyBaseSeed(
  context: Record<string, unknown>,
  propertyData: Record<string, unknown>,
  scenarioId: string
) {
  const approvedPricing = isRecord(context.pricing_proposal)
    ? {
        ...settingsTestApprovedPricingProposalSeed(),
        ...(context.pricing_proposal as Record<string, unknown>),
        approval_status: "approved",
      }
    : settingsTestApprovedPricingProposalSeed();
  return {
    property_data: propertyData,
    pricing_proposal: approvedPricing,
    contract_review: isRecord(context.contract_review)
      ? { status: "sent_by_email", ...(context.contract_review as Record<string, unknown>) }
      : { status: "sent_by_email" },
    ...(Array.isArray(context.raw_photos) && context.raw_photos.length > 0
      ? { raw_photos: context.raw_photos }
      : {}),
    skill_test_n4_seed: scenarioId,
  };
}

/** property_data restrictivo (~8 m²) para N4 «sin comparables usables». */
export function settingsTestInsufficientComparablesPropertyDataSeed(
  context?: Record<string, unknown>
): Record<string, unknown> {
  const zone =
    context != null ? resolveEffectiveSearchZone(context) : null;
  const fallbackZone = "Colomos Providencia, Guadalajara, Jalisco";
  const effectiveZone = zone ?? fallbackZone;
  return mergePropertyDataForComparables(context ?? {}, {
    property_data: {
      operation: "rent",
      property_type: "departamento",
      area_total_m2: 8,
      bedrooms: 3,
      bathrooms: 2,
      parking_spots: 1,
      address: {
        street: "Privada del Tulipán",
        exterior_number: "1501",
        neighborhood: effectiveZone,
        city: "Zapopan",
        state: "Jalisco",
        country: "MX",
        postal_code: "45050",
      },
      search_zone: effectiveZone,
      notes:
        "Semilla N4: filtros intencionalmente estrechos (~8 m²) para escenario sin comparables usables.",
    },
  });
}

/** Muestra defendible mínima para prepare-listing-price (N4 paso 4). */
export function settingsTestComparablesAnalysisSeed() {
  return {
    filters_used: {
      operation: "rent",
      property_type: "departamento",
      area_total_m2: 116.93,
    },
    stats: {
      price: { p25: 18000, p50: 22000, p75: 24000, available: true },
      price_per_m2: { available: false },
      active_count: 5,
      historical_reference_count: 2,
      internal_inventory_count: 1,
      data_quality: { usable_count: 8 },
    },
    data_quality: { usable_count: 8, warnings: [] },
    usable_count: 8,
    active_listings: [{ id: "eb-seed-1", usable_as_comparable: true, price: 22000 }],
    historical_references: [{ id: "eb-seed-h1", usable_as_comparable: true }],
    internal_inventory: [{ id: "bq-seed-1", usable_as_comparable: true }],
    notes: "Semilla N4: muestra defendible para propuesta de precio.",
  };
}

/** Propuesta pendiente típica tras N4/N3 de HITL en Paso 4. */
export function settingsTestPendingPricingProposalSeed() {
  return {
    salida: 25200,
    ideal: 24000,
    minimo: 21000,
    currency: "MXN",
    rationale:
      "Semilla N4: propuesta pendiente de aprobación HITL (comparables Colomos Providencia).",
    comparables_used: ["eb-seed-1", "eb-seed-h1"],
    approval_status: "pending",
  };
}

export function settingsTestApprovedPricingProposalSeed() {
  return {
    salida: 23500,
    ideal: 22000,
    minimo: 18000,
    currency: "MXN",
    rationale:
      "Semilla N4: precio aprobado desde p25/p50 de comparables de prueba.",
    comparables_used: ["eb-seed-1", "eb-seed-h1"],
    approval_status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: "settings_test_seed",
  };
}

export function settingsTestCommissionTermsSeed() {
  return {
    commission_pct: 5,
    exclusive: true,
    duration_months: 6,
  };
}

/** Parche de context_jsonb según escenario N4 (fusionar tras applyStepSeed). */
export function stepTestContextEnrichment(
  scenarioId: string,
  context: Record<string, unknown>
): Record<string, unknown> | null {
  const propertyData = settingsTestPropertyDataSeed(context);

  switch (scenarioId) {
    case "price_proposal_pending_hitl":
      return {
        property_data: propertyData,
        comparables_analysis: isRecord(context.comparables_analysis)
          ? context.comparables_analysis
          : settingsTestComparablesAnalysisSeed(),
        skill_test_n4_seed: scenarioId,
      };
    case "price_proposal_pending_advisor_approves":
    case "price_proposal_pending_advisor_adjusts":
      return {
        property_data: propertyData,
        comparables_analysis: isRecord(context.comparables_analysis)
          ? context.comparables_analysis
          : settingsTestComparablesAnalysisSeed(),
        pricing_proposal: isRecord(context.pricing_proposal)
          ? {
              ...settingsTestPendingPricingProposalSeed(),
              ...(context.pricing_proposal as Record<string, unknown>),
              approval_status: "pending",
            }
          : settingsTestPendingPricingProposalSeed(),
        skill_test_n4_seed: scenarioId,
      };
    case "contract_pending_draft_review":
    case "contract_pending_template_missing":
      return {
        property_data: propertyData,
        pricing_proposal: isRecord(context.pricing_proposal)
          ? {
              ...settingsTestApprovedPricingProposalSeed(),
              ...(context.pricing_proposal as Record<string, unknown>),
              approval_status: "approved",
            }
          : settingsTestApprovedPricingProposalSeed(),
        commission_terms: isRecord(context.commission_terms)
          ? {
              ...settingsTestCommissionTermsSeed(),
              ...(context.commission_terms as Record<string, unknown>),
            }
          : settingsTestCommissionTermsSeed(),
        skill_test_n4_seed: scenarioId,
      };
    case "contract_pending_advisor_approves_send":
    case "contract_pending_advisor_requests_changes":
      return {
        property_data: propertyData,
        pricing_proposal: isRecord(context.pricing_proposal)
          ? {
              ...settingsTestApprovedPricingProposalSeed(),
              ...(context.pricing_proposal as Record<string, unknown>),
              approval_status: "approved",
            }
          : settingsTestApprovedPricingProposalSeed(),
        commission_terms: isRecord(context.commission_terms)
          ? {
              ...settingsTestCommissionTermsSeed(),
              ...(context.commission_terms as Record<string, unknown>),
            }
          : settingsTestCommissionTermsSeed(),
        skill_test_n4_seed: scenarioId,
      };
    case "contract_pending_owner_signed":
      return {
        property_data: propertyData,
        pricing_proposal: settingsTestApprovedPricingProposalSeed(),
        commission_terms: settingsTestCommissionTermsSeed(),
        contract_review: { status: "approved_for_owner" },
        skill_test_n4_seed: scenarioId,
      };
    case COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID:
      return {
        property_data: settingsTestInsufficientComparablesPropertyDataSeed(
          context
        ),
        skill_test_n4_seed: scenarioId,
      };
    case "photos_requested_request_internal_photos":
      return {
        property_data: propertyData,
        raw_photos: [],
        skill_test_n4_seed: scenarioId,
      };
    case "package_ready_preflight_blocked":
      return {
        property_data: propertyData,
        pricing_proposal: settingsTestApprovedPricingProposalSeed(),
        raw_photos: [],
        skill_test_n4_seed: scenarioId,
      };
    case "package_ready_description_review_requested":
      return {
        ...packageReadyBaseSeed(context, propertyData, scenarioId),
      };
    case "package_ready_description_approved":
      return {
        ...packageReadyBaseSeed(context, propertyData, scenarioId),
        photo_analysis: isRecord(context.photo_analysis)
          ? context.photo_analysis
          : {
              visible_spaces: ["sala", "cocina", "recámara principal", "baño"],
              features_by_space: {
                sala: ["buena iluminación natural", "acabados neutros"],
                cocina: ["cocina integral"],
              },
              visible_features: ["buena iluminación", "acabados neutros"],
              photo_coverage: {
                facade: "unclear",
                kitchen: "visible",
                dining_room: "unclear",
                living_room: "visible",
                primary_bedroom: "visible",
                bathroom: "not_visible",
                outdoor: "not_visible",
                parking: "not_visible",
              },
              do_not_claim: ["roof garden", "amenidades no visibles"],
            },
        zone_context: isRecord(context.zone_context)
          ? context.zone_context
          : {
              points_of_interest: [
                "Parque Colomos (~950 m)",
                "Hospital Puerta de Hierro (~1.4 km)",
              ],
              area_summary: "Zona residencial consolidada con servicios cercanos.",
            },
        listing_description_draft: isRecord(context.listing_description_draft)
          ? context.listing_description_draft
          : {
              headline: "Departamento con ubicación estratégica en zona consolidada",
              short_description: "Borrador para revisión del asesor.",
              description:
                "Departamento con distribución funcional, iluminación natural y cercanía a servicios y vialidades.",
            },
      };
    case "package_ready_easybroker_approval_requested":
      return {
        ...packageReadyBaseSeed(context, propertyData, scenarioId),
        listing_description_approved: isRecord(context.listing_description_approved)
          ? context.listing_description_approved
          : {
              headline: "Departamento listo para habitar en zona con alta conectividad",
              description:
                "Propiedad con espacios bien distribuidos, buena iluminación y cercanía a servicios clave.",
              approved_at: new Date().toISOString(),
              approved_by: "settings_test_seed",
            },
        publish_approvals: isRecord(context.publish_approvals)
          ? { ...(context.publish_approvals as Record<string, unknown>), easybroker: "pending" }
          : { easybroker: "pending", ungga: "pending", manual: "pending" },
      };
    case "package_ready_easybroker_published":
      return {
        ...packageReadyBaseSeed(context, propertyData, scenarioId),
        listing_description_approved: {
          headline: "Departamento listo para habitar en zona con alta conectividad",
          description:
            "Propiedad con espacios bien distribuidos, buena iluminación y cercanía a servicios clave.",
          approved_at: new Date().toISOString(),
          approved_by: "settings_test_seed",
        },
        publish_approvals: { easybroker: "pending", ungga: "pending", manual: "pending" },
      };
    case "package_ready_completed_summary_sent":
      return {
        ...packageReadyBaseSeed(context, propertyData, scenarioId),
        listing_description_approved: {
          headline: "Departamento listo para habitar en zona con alta conectividad",
          description:
            "Propiedad con espacios bien distribuidos, buena iluminación y cercanía a servicios clave.",
          approved_at: new Date().toISOString(),
          approved_by: "settings_test_seed",
        },
        published: {
          easybroker: {
            listing_id: "EB-TEST-123",
            public_url: "https://www.easybroker.com/mx/listings/EB-TEST-123",
            status: "not_published",
          },
        },
      };
    default:
      return null;
  }
}
