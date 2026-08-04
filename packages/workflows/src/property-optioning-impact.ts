/**
 * `impact_dependencies` de property_optioning v2 (Slice 3.2-3), codificadas
 * desde la METODOLOGÍA VERIFICADA (§X finding 3 del plan detallado) — nunca
 * inferidas por nombre de campo (Technical Plan §11, principio de edges
 * declarados).
 *
 * Vocabulario de entradas (parseado por el motor de impacto):
 *   - `artifact:<tipo>`         → el artefacto vigente de ese tipo en el caso
 *   - `account_asset:<clave>`   → la versión vigente del asset del tenant
 *   - cualquier otra cosa       → fact key en `case_facts` (p. ej.
 *     `property.bedrooms`)
 *
 * Metodología (comparable-search-contract.ts + skill
 * perform-comparable-analysis L100–101): los filtros duros de valuación son
 * zona/colonia, operación, tipo de propiedad y banda de área
 * (area_construida_m2 preferida, si no area_total_m2). Recámaras, baños y
 * estacionamientos NUNCA son entradas de valuación
 * (`sanitizeComparableSearchFilters` los descarta; su selftest lo asegura) —
 * pero SÍ alimentan descripción, payload de publicación, copy comercial y
 * filtros de matching.
 */

/** Entradas duras de la cadena de valuación (finding 3). */
export const PROPERTY_OPTIONING_VALUATION_FACTS: readonly string[] = [
  "property.search_zone",
  "property.neighborhood",
  "property.operation",
  "property.property_type",
  "property.area_construida_m2",
  "property.area_total_m2",
];

/** Política de metodología/bandas: entrada declarada, no un artefacto. */
export const PROPERTY_OPTIONING_METHODOLOGY_FACT = "methodology.band_policy";

/** Hechos que alimentan la capa comercial/listing (NO la valuación). */
export const PROPERTY_OPTIONING_LISTING_FACTS: readonly string[] = [
  "property.bedrooms",
  "property.bathrooms",
  "property.parking_spots",
  "property.amenities",
  "property.neighborhood",
  "property.search_zone",
];

/** Hechos relevantes del contrato de comisión (extracción comercial 0.3). */
export const PROPERTY_OPTIONING_CONTRACT_FACTS: readonly string[] = [
  "property.address",
  "property.neighborhood",
  "contact.owner_name",
  "contact.owner_email",
  "contract.commission_pct",
  "contract.duration_months",
  "contract.exclusive",
];

export const PROPERTY_OPTIONING_IMPACT_DEPENDENCIES: Record<string, string[]> =
  {
    // Cadena de valuación: hechos duros + metodología; cada eslabón declara
    // además el artefacto anterior para que el staleness cascadee.
    comparable_set: [
      ...PROPERTY_OPTIONING_VALUATION_FACTS,
      PROPERTY_OPTIONING_METHODOLOGY_FACT,
    ],
    valuation: [
      ...PROPERTY_OPTIONING_VALUATION_FACTS,
      PROPERTY_OPTIONING_METHODOLOGY_FACT,
      "artifact:comparable_set",
    ],
    price_recommendation: [
      ...PROPERTY_OPTIONING_VALUATION_FACTS,
      PROPERTY_OPTIONING_METHODOLOGY_FACT,
      "artifact:comparable_set",
      "artifact:valuation",
    ],
    // Capa comercial: recámaras/baños/estacionamientos viven AQUÍ.
    listing_description: [...PROPERTY_OPTIONING_LISTING_FACTS],
    listing_payload: [
      ...PROPERTY_OPTIONING_LISTING_FACTS,
      "artifact:listing_description",
    ],
    commercial_copy: [...PROPERTY_OPTIONING_LISTING_FACTS],
    matching_filters: [...PROPERTY_OPTIONING_LISTING_FACTS],
    // Contrato: pineado a la versión consumida de la plantilla del tenant
    // (finding 16) + hechos contractuales.
    contract_draft: [
      "account_asset:commission_contract_template",
      ...PROPERTY_OPTIONING_CONTRACT_FACTS,
    ],
    // Fotos con marca de agua: dependen del watermark del tenant.
    watermarked_photos: ["account_asset:listing_photo_watermark"],
  };

/**
 * Evidencia de la aprobación de precio (3.2-3): entradas de la valuación +
 * la recomendación. Si cualquiera cambia, el evidence_hash deja de coincidir
 * y el motor SUSPENDE (acto mecánico reversible; revocar es humano).
 */
export const PROPERTY_OPTIONING_PRICE_APPROVAL_EVIDENCE_INPUTS: string[] = [
  ...PROPERTY_OPTIONING_VALUATION_FACTS,
  PROPERTY_OPTIONING_METHODOLOGY_FACT,
  "artifact:valuation",
  "artifact:price_recommendation",
];
