import assert from "node:assert/strict";
import { classifyListingDescriptionChange } from "./listing-description-change-classifier";

const mock = {
  async classify() {
    return {
      change_type: "mixed",
      editorial_instructions: ["Hazlo más ejecutivo"],
      new_facts_or_highlights: ["Patio techado", "Cercano a hospitales"],
      replacement_text: null,
      confidence: "high",
      requires_clarification: false,
    };
  },
};

async function run() {
  const result = await classifyListingDescriptionChange(
    {
      text: "Hazlo más ejecutivo y agrega patio techado y cercanía a hospitales.",
    },
    mock
  );

  assert.ok(result);
  assert.equal(result?.change_type, "mixed");
  assert.deepEqual(result?.new_facts_or_highlights, [
    "Patio techado",
    "Cercano a hospitales",
  ]);
  assert.equal(result?.requires_clarification, false);

  console.log("listing-description-change-classifier selftest ok");
}

void run();
