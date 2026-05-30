/**
 * Compat layer para consumidores UI. La fuente de verdad completa vive en
 * `step-test-scenario-registry.ts` (metadata + seed + expect + mensaje).
 */
export type {
  StepTestExecutionMode,
  StepTestScenarioDef,
  StepTestScenarioMeta,
} from "./step-test-scenario-registry";

export {
  DEFAULT_STEP_TEST_CATALOG_SLUG_BY_ROOT_SKILL,
  STEP_TEST_SCENARIO_CATALOG,
  stepTestAvailable,
  stepTestCatalogSlugForRootSkill,
  stepTestMilestoneScenariosFor,
  stepTestScenarioCountsTowardMilestone,
  stepTestScenarioMetasFor as stepTestScenariosFor,
  stepTestScenariosFor as stepTestScenarioDefsFor,
} from "./step-test-scenario-registry";
