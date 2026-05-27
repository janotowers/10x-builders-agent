/** Metadatos de escenarios N4 (paso). La lógica de ejecución vive en run-step/route.ts. */

export type StepTestScenarioMeta = {
  id: string;
  label: string;
};

export const STEP_TEST_SCENARIO_INDEX: Record<
  string,
  Record<string, StepTestScenarioMeta[]>
> = {
  property_optioning: {
    awaiting_documents: [
      {
        id: "awaiting_documents_outreach",
        label: "Solicitud inicial vía habilidad raíz",
      },
    ],
  },
};

export function stepTestScenariosFor(
  caseTypeSlug: string,
  stepKey: string
): StepTestScenarioMeta[] {
  return STEP_TEST_SCENARIO_INDEX[caseTypeSlug]?.[stepKey] ?? [];
}

export function stepTestAvailable(caseTypeSlug: string, stepKey: string) {
  return stepTestScenariosFor(caseTypeSlug, stepKey).length > 0;
}
