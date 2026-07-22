import assert from "node:assert/strict";
import {
  classifyPendingDecisionUnclear,
  shouldReleaseUnclearToAgent,
  type PendingDecisionUnclearClassifierModel,
} from "./pending-decision-unclear-classifier";

async function main() {
  assert.equal(shouldReleaseUnclearToAgent(null), false);
  assert.equal(
    shouldReleaseUnclearToAgent({
      disposition: "keep_clarifying",
      confidence: "high",
    }),
    false
  );
  assert.equal(
    shouldReleaseUnclearToAgent({
      disposition: "release_to_agent",
      confidence: "low",
    }),
    false,
    "low confidence must not release"
  );
  assert.equal(
    shouldReleaseUnclearToAgent({
      disposition: "release_to_agent",
      confidence: "medium",
    }),
    true
  );
  assert.equal(
    shouldReleaseUnclearToAgent({
      disposition: "release_to_agent",
      confidence: "high",
    }),
    true
  );

  const releaseModel: PendingDecisionUnclearClassifierModel = {
    async classify() {
      return {
        disposition: "release_to_agent",
        confidence: "high",
        reason: "side question",
      };
    },
  };
  const keepModel: PendingDecisionUnclearClassifierModel = {
    async classify() {
      return {
        disposition: "keep_clarifying",
        confidence: "high",
        reason: "fuzzy approval",
      };
    },
  };
  const invalidModel: PendingDecisionUnclearClassifierModel = {
    async classify() {
      return { disposition: "approve", confidence: "high" };
    },
  };
  const throwModel: PendingDecisionUnclearClassifierModel = {
    async classify() {
      throw new Error("boom");
    },
  };

  {
    const result = await classifyPendingDecisionUnclear(
      {
        message: "¿por qué necesitas el correo?",
        gate: "contract_data_review",
      },
      releaseModel
    );
    assert.equal(result?.disposition, "release_to_agent");
    assert.equal(shouldReleaseUnclearToAgent(result), true);
  }

  {
    const result = await classifyPendingDecisionUnclear(
      {
        message: "ok gracias",
        gate: "listing_description_review",
      },
      keepModel
    );
    assert.equal(result?.disposition, "keep_clarifying");
    assert.equal(shouldReleaseUnclearToAgent(result), false);
  }

  {
    const result = await classifyPendingDecisionUnclear(
      {
        message: "hola",
        gate: "listing_description_review",
      },
      invalidModel
    );
    assert.equal(result, null, "invalid schema must fail open");
    assert.equal(shouldReleaseUnclearToAgent(result), false);
  }

  {
    const result = await classifyPendingDecisionUnclear(
      {
        message: "hola",
        gate: "contract_data_review",
      },
      throwModel
    );
    assert.equal(result, null, "model errors must fail open");
  }

  {
    const result = await classifyPendingDecisionUnclear(
      {
        message: "   ",
        gate: "contract_data_review",
      },
      releaseModel
    );
    assert.equal(result, null, "empty message must not classify");
  }

  console.log("pending-decision-unclear-classifier.selftest: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
