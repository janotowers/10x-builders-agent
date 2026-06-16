import assert from "node:assert/strict";
import {
  classifyOperationalConversationMessage,
  type OperationalConversationClassifierModel,
} from "./operational-conversation-classifier";

async function main() {
  const startCaseModel: OperationalConversationClassifierModel = {
    async classify(input) {
      assert.equal(input.stage, "no_case");
      return {
        route: "property_optioning",
        confidence: "high",
        intent: "start_case",
        reason: "user wants to capture a property",
      };
    },
  };
  assert.deepEqual(
    await classifyOperationalConversationMessage(
      { message: "Necesito meter un inmueble al proceso", stage: "no_case" },
      startCaseModel
    ),
    {
      route: "property_optioning",
      confidence: "high",
      intent: "start_case",
      reason: "user wants to capture a property",
    }
  );

  const correctionModel: OperationalConversationClassifierModel = {
    async classify() {
      return {
        route: "existing_case",
        confidence: "high",
        intent: "review_correction",
        patch: {
          operation_type: "Venta",
          property_zone: "",
        },
      };
    },
  };
  assert.deepEqual(
    await classifyOperationalConversationMessage(
      {
        message: "No es opción, es venta normal",
        stage: "property_data_review",
      },
      correctionModel
    ),
    {
      route: "existing_case",
      confidence: "high",
      intent: "review_correction",
      patch: { operation_type: "Venta" },
    }
  );

  const invalidModel: OperationalConversationClassifierModel = {
    async classify() {
      return { route: "nonsense" };
    },
  };
  assert.equal(
    await classifyOperationalConversationMessage(
      { message: "hola", stage: "no_case" },
      invalidModel
    ),
    null
  );

  const intakeModel: OperationalConversationClassifierModel = {
    async classify(input) {
      assert.equal(input.stage, "intake");
      return {
        route: "existing_case",
        confidence: "high",
        intent: "provide_intake",
        patch: {
          property_title: "Casa en venta en Las Fuentes",
          property_zone: "Las Fuentes, Zapopan, Jalisco",
          operation_type: "Venta",
          property_type: "Casa",
        },
      };
    },
  };
  assert.deepEqual(
    await classifyOperationalConversationMessage(
      {
        message: "Casa en venta en Las Fuentes, zona Las Fuentes Zapopan, operación venta",
        stage: "intake",
      },
      intakeModel
    ),
    {
      route: "existing_case",
      confidence: "high",
      intent: "provide_intake",
      patch: {
        property_title: "Casa en venta en Las Fuentes",
        property_zone: "Las Fuentes, Zapopan, Jalisco",
        operation_type: "Venta",
        property_type: "Casa",
      },
    }
  );

  console.log("operational-conversation-classifier.selftest.ts: ok");
}

void main();
