/**
 * Selftest para skills que sirven como `default_skill_slug` de
 * `operational_case_types`. Su contrato es más estricto que el de skills
 * conversacionales normales: el selector LLM tiene que ser capaz de
 * routear hacia ellas desde texto libre del usuario, y deben poder crear
 * el caso si no existe (camino conversacional).
 *
 * Este selftest valida convenciones estructurales (no llama al LLM):
 *   1. La skill existe y es composite.
 *   2. Su `description` contiene marcadores de intención en español
 *      reconocibles (sinónimos para que el selector la elija).
 *   3. Su `allowed_tools` incluye las herramientas mínimas para el
 *      camino conversacional: operational_case_create, _update_state,
 *      _add_event, notify_user.
 *   4. Su cuerpo (body_md) contiene la sección "Camino conversacional"
 *      que instruye al LLM a pedir los campos required del intake.
 *
 * Si en el futuro agregamos más skills operacionales (lead_follow_up,
 * etc.), se extiende `OPERATIONAL_SKILL_CONTRACTS` con su slug y los
 * marcadores de intención esperados.
 */
import assert from "node:assert/strict";
import { getGlobalSkillRegistry, resetGlobalSkillRegistryForTests } from "./runtime";

interface OperationalSkillContract {
  readonly slug: string;
  /** Frases en minúsculas que la description debe contener. */
  readonly intentMarkers: readonly string[];
  /** Tools que la skill debe declarar en allowed_tools. */
  readonly mustHaveTools: readonly string[];
  /** Fragmentos de texto que el body debe contener. */
  readonly bodyMarkers: readonly string[];
}

const OPERATIONAL_SKILL_CONTRACTS: readonly OperationalSkillContract[] = [
  {
    slug: "property-optioning-coach",
    intentMarkers: [
      "opcionar",
      "exclusiva",
      "captación",
      "propiedad",
      "comparables",
      "publicar",
    ],
    mustHaveTools: [
      "operational_case_create",
      "operational_case_update_state",
      "operational_case_add_event",
      "notify_user",
    ],
    bodyMarkers: ["Camino conversacional", "intake_schema"],
  },
];

async function testOperationalSkillContracts(): Promise<void> {
  resetGlobalSkillRegistryForTests();
  const registry = await getGlobalSkillRegistry();

  for (const contract of OPERATIONAL_SKILL_CONTRACTS) {
    const record = registry.get(contract.slug);
    assert.ok(
      record,
      `operational skill '${contract.slug}' must be present in the global registry`
    );
    if (!record) continue;

    const descLower = record.metadata.description.toLowerCase();
    for (const marker of contract.intentMarkers) {
      assert.ok(
        descLower.includes(marker.toLowerCase()),
        `skill '${contract.slug}' description must mention '${marker}' so the selector LLM routes to it from natural Spanish text. Got: ${record.metadata.description.slice(0, 200)}`
      );
    }

    const allowed = new Set(record.metadata.allowedTools ?? []);
    for (const tool of contract.mustHaveTools) {
      assert.ok(
        allowed.has(tool),
        `skill '${contract.slug}' must declare '${tool}' in allowed_tools; missing it means the conversational create path will fail`
      );
    }

    const body = await record.loadBody();
    for (const marker of contract.bodyMarkers) {
      assert.ok(
        body.includes(marker),
        `skill '${contract.slug}' body must contain '${marker}' for the conversational intake path to be discoverable by the LLM`
      );
    }
  }
}

async function main(): Promise<void> {
  await testOperationalSkillContracts();
  console.log(
    `skills/operational-skills.selftest: all ${OPERATIONAL_SKILL_CONTRACTS.length} contracts validated`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
