import assert from "node:assert/strict";
import {
  extractOwnerCharacteristics,
  type OwnerCharacteristicsExtractorModel,
} from "./owner-characteristics-extraction";
import { parseOwnerCharacteristics } from "./parse-owner-characteristics";

const OWNER_MESSAGE =
  "2 pisos, 3 recamaras, 2 baños completos sin medios baños. Sí tiene cocina integral";

async function main() {
  // 1) Valid LLM extraction on first attempt.
  const validModel: OwnerCharacteristicsExtractorModel = {
    async extract(input) {
      assert.equal(input.text, OWNER_MESSAGE);
      return {
        patch: {
          floors: 2,
          bedrooms: 3,
          bathrooms: 2,
          half_bathrooms: 0,
          integral_kitchen: true,
        },
        confidence: "high",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const valid = await extractOwnerCharacteristics(
    { text: OWNER_MESSAGE, propertyType: "Casa" },
    validModel
  );
  assert.equal(valid.method, "llm");
  assert.equal(valid.attempts, 1);
  assert.deepEqual(valid.patch, {
    floors: 2,
    bedrooms: 3,
    bathrooms: 2,
    half_bathrooms: 0,
    integral_kitchen: true,
  });

  // 2) LLM can be incomplete; deterministic parser backfills explicit fields.
  const incompleteModel: OwnerCharacteristicsExtractorModel = {
    async extract() {
      return {
        patch: {
          bedrooms: 3,
          bathrooms: 2,
        },
        confidence: "medium",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const completed = await extractOwnerCharacteristics(
    { text: OWNER_MESSAGE },
    incompleteModel
  );
  assert.equal(completed.method, "llm");
  assert.deepEqual(completed.patch, {
    floors: 2,
    bedrooms: 3,
    bathrooms: 2,
    half_bathrooms: 0,
    integral_kitchen: true,
  });
  assert.ok(
    (completed.assumptions ?? []).includes(
      "Se completaron campos explícitos con parser determinístico."
    )
  );

  // 3) First attempt invalid, retry succeeds => method llm_retry.
  let calls = 0;
  const retryModel: OwnerCharacteristicsExtractorModel = {
    async extract() {
      calls += 1;
      if (calls === 1) {
        return { patch: { bedrooms: "tres" }, confidence: "high" };
      }
      return {
        patch: { bedrooms: 3, bathrooms: 2 },
        confidence: "medium",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const retried = await extractOwnerCharacteristics(
    { text: OWNER_MESSAGE },
    retryModel
  );
  assert.equal(retried.method, "llm_retry");
  assert.equal(retried.attempts, 2);
  assert.deepEqual(retried.patch, {
    floors: 2,
    bedrooms: 3,
    bathrooms: 2,
    half_bathrooms: 0,
    integral_kitchen: true,
  });
  assert.ok((retried.validationErrors ?? []).length === 1);

  // 4) All attempts invalid => deterministic fallback parses what it can.
  const brokenModel: OwnerCharacteristicsExtractorModel = {
    async extract() {
      return { not: "a valid shape" };
    },
  };
  const fallback = await extractOwnerCharacteristics(
    { text: OWNER_MESSAGE },
    brokenModel
  );
  assert.equal(fallback.method, "deterministic_fallback");
  assert.equal(fallback.patch.floors, 2);
  assert.equal(fallback.patch.bedrooms, 3);
  assert.equal(fallback.patch.bathrooms, 2);
  assert.equal(fallback.patch.half_bathrooms, 0);
  assert.equal(fallback.patch.integral_kitchen, true);
  assert.ok((fallback.validationErrors ?? []).length >= 1);

  // 5) Empty input => no work, no crash.
  const empty = await extractOwnerCharacteristics({ text: "   " }, validModel);
  assert.deepEqual(empty.patch, {});
  assert.equal(empty.attempts, 0);

  // 6) Deterministic parser directly covers the regression case.
  const parsed = parseOwnerCharacteristics(OWNER_MESSAGE);
  assert.equal(parsed.floors, 2);
  assert.equal(parsed.bedrooms, 3);
  assert.equal(parsed.bathrooms, 2);
  assert.equal(parsed.half_bathrooms, 0);
  assert.equal(parsed.integral_kitchen, true);

  const negatedKitchen = parseOwnerCharacteristics(
    "una planta, no tiene cocina integral"
  );
  assert.equal(negatedKitchen.floors, 1);
  assert.equal(negatedKitchen.integral_kitchen, false);
  assert.ok(!("half_bathrooms" in negatedKitchen));

  console.log("owner-characteristics-extraction.selftest.ts: ok");
}

void main();
