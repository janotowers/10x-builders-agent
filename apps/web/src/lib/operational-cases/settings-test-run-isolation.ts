/**
 * Aislamiento controlado entre corridas N3/N4 sobre el mismo caso de prueba.
 *
 * El fixture de Settings es mutable por diseño, pero cada corrida debe partir
 * de entradas determinísticas. Estas helpers limpian marcadores de pruebas
 * anteriores y artefactos de salida que pueden contaminar el siguiente tick.
 */

function withoutKeys(
  context: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const next = { ...context };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

const RUN_MARKER_KEYS = [
  "skill_test_n3_seed",
  "skill_test_n4_seed",
  "skill_test_repairs",
] as const;

const SKILL_OUTPUT_KEYS: Record<string, readonly string[]> = {
  "perform-comparable-analysis": [
    "comparables_analysis",
    "pricing_proposal",
  ],
  "prepare-listing-price": ["pricing_proposal"],
  "prepare-commission-contract": ["contract_draft", "contract_review"],
  "request-property-photos": ["photo_session"],
  "publish-listing-package": [
    "listing_publication",
    "publication_result",
    "published_listing",
    "listing_package",
  ],
};

const STEP_OUTPUT_KEYS: Array<{
  match: (scenarioId: string) => boolean;
  keys: readonly string[];
}> = [
  {
    match: (scenarioId) => scenarioId.startsWith("comparables_in_progress_"),
    keys: ["comparables_analysis", "pricing_proposal"],
  },
  {
    match: (scenarioId) => scenarioId.startsWith("price_proposal_pending_"),
    keys: ["comparables_analysis", "pricing_proposal", "contract_draft"],
  },
  {
    match: (scenarioId) => scenarioId.startsWith("contract_pending_"),
    keys: ["contract_draft", "contract_review"],
  },
  {
    match: (scenarioId) => scenarioId.startsWith("photos_requested_"),
    keys: ["photo_session"],
  },
  {
    match: (scenarioId) => scenarioId.startsWith("package_ready_"),
    keys: [
      "listing_publication",
      "publication_result",
      "published_listing",
      "listing_package",
    ],
  },
  {
    match: (scenarioId) => scenarioId.startsWith("documents_received_"),
    keys: ["property_data"],
  },
];

/**
 * Tras sembrar property_data incompleto, quita campos que deben faltar en N4
 * (el merge superficial deja valores de una corrida N3 anterior).
 */
export function applyPropertyDataSeedRules(
  propertyData: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...propertyData };
  const missing = next.missing_critical_fields;
  if (!Array.isArray(missing)) return next;
  for (const field of missing) {
    if (typeof field === "string" && field.trim()) {
      delete next[field.trim()];
    }
  }
  return next;
}

export function isolateContextForSkillTest(
  context: Record<string, unknown>,
  skillSlug: string
): Record<string, unknown> {
  return withoutKeys(context, [
    ...RUN_MARKER_KEYS,
    ...(SKILL_OUTPUT_KEYS[skillSlug] ?? []),
  ]);
}

export function isolateContextForStepTest(
  context: Record<string, unknown>,
  scenarioId: string
): Record<string, unknown> {
  const scenarioKeys =
    STEP_OUTPUT_KEYS.find((item) => item.match(scenarioId))?.keys ?? [];
  return withoutKeys(context, [...RUN_MARKER_KEYS, ...scenarioKeys]);
}
