import assert from "node:assert/strict";
import {
  extractContractCommercialReply,
  mergeContractCommercialPatches,
  type ContractCommercialExtractorModel,
} from "./contract-commercial-extraction";
import type { ContractCommercialMissingField } from "@agents/agent";

const ALL_MISSING: ContractCommercialMissingField[] = [
  {
    key: "owner_email",
    label: "Correo del propietario",
    question: "Correo electrónico del propietario.",
    kind: "email",
  },
  {
    key: "collaboration_enabled",
    label: "Compartir comisión",
    question: "¿Se compartirá comisión con otro asesor o inmobiliaria?",
    kind: "boolean",
  },
  {
    key: "commission_pct",
    label: "Comisión cobrada al propietario",
    question: "Comisión cobrada al propietario (% del precio de venta o renta).",
    kind: "number",
  },
  {
    key: "exclusive",
    label: "Exclusividad",
    question: "¿La captación es exclusiva?",
    kind: "boolean",
  },
  {
    key: "duration_months",
    label: "Duración del encargo",
    question: "Duración del encargo en meses.",
    kind: "number",
  },
];

const REAL_MESSAGE =
  "Comisión total pactada con el propietario: 5%. Duración: 6 meses. Se comparte el 50% de la comisión total. alex@ungga.com, exclusiva";

async function main() {
  // 1) Valid LLM extraction on first attempt.
  const validModel: ContractCommercialExtractorModel = {
    async extract(input) {
      assert.equal(input.text, REAL_MESSAGE);
      return {
        patch: {
          owner_email: "alex@ungga.com",
          commission_pct: 5,
          duration_months: 6,
          exclusive: true,
          collaboration_enabled: true,
          compensation_mode: "percentage_of_total_commission",
          compensation_value: 50,
        },
        confidence: "high",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const valid = await extractContractCommercialReply(
    { text: REAL_MESSAGE, missingFields: ALL_MISSING },
    validModel
  );
  assert.equal(valid.method, "llm");
  assert.equal(valid.intent, "provide_data");
  assert.equal(valid.patch.owner_email, "alex@ungga.com");
  assert.equal(valid.patch.commission_pct, 5);
  assert.equal(valid.patch.duration_months, 6);
  assert.equal(valid.patch.exclusive, true);
  assert.equal(valid.patch.collaboration_enabled, true);
  assert.equal(valid.patch.compensation_mode, "percentage_of_total_commission");
  assert.equal(valid.patch.compensation_value, 50);

  // 2) LLM incomplete; deterministic backfill fills explicit fields.
  const incompleteModel: ContractCommercialExtractorModel = {
    async extract() {
      return {
        patch: {
          collaboration_enabled: true,
          exclusive: true,
        },
        confidence: "medium",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const completed = await extractContractCommercialReply(
    { text: REAL_MESSAGE, missingFields: ALL_MISSING },
    incompleteModel
  );
  assert.equal(completed.method, "llm");
  assert.equal(completed.patch.commission_pct, 5);
  assert.equal(completed.patch.duration_months, 6);
  assert.equal(completed.patch.owner_email, "alex@ungga.com");
  assert.equal(completed.patch.compensation_value, 50);

  // 3) First attempt invalid, retry succeeds.
  let calls = 0;
  const retryModel: ContractCommercialExtractorModel = {
    async extract() {
      calls += 1;
      if (calls === 1) {
        return { patch: { commission_pct: "cinco" }, confidence: "high" };
      }
      return {
        patch: {
          commission_pct: 5,
          duration_months: 6,
          owner_email: "alex@ungga.com",
        },
        confidence: "medium",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const retried = await extractContractCommercialReply(
    { text: REAL_MESSAGE, missingFields: ALL_MISSING },
    retryModel
  );
  assert.equal(retried.method, "llm_retry");
  assert.equal(retried.attempts, 2);
  assert.equal(retried.patch.commission_pct, 5);
  assert.ok((retried.validationErrors ?? []).length === 1);

  // 4) Broken LLM => deterministic fallback.
  const brokenModel: ContractCommercialExtractorModel = {
    async extract() {
      return { not: "a valid shape" };
    },
  };
  const fallback = await extractContractCommercialReply(
    {
      text:
        "Sí se comparte comisión. Comisión total 5%. Exclusiva. Duración 6 meses. dueno@example.com",
      missingFields: ALL_MISSING,
    },
    brokenModel
  );
  assert.equal(fallback.method, "deterministic_fallback");
  assert.equal(fallback.intent, "provide_data");
  assert.equal(fallback.patch.owner_email, "dueno@example.com");
  assert.equal(fallback.patch.commission_pct, 5);
  assert.equal(fallback.patch.duration_months, 6);

  // 5) Explicit Spanish negation survives an incorrect LLM polarity.
  const nonExclusive = await extractContractCommercialReply(
    {
      text:
        "No, la captación no es exclusiva y el porcentaje de esa comisión que se comparte es de la mitad",
      missingFields: ALL_MISSING.filter((item) => item.key === "exclusive"),
    },
    {
      async extract() {
        return {
          patch: { exclusive: true },
          confidence: "medium",
          unresolved: [],
          assumptions: [],
        };
      },
    }
  );
  assert.equal(nonExclusive.patch.exclusive, false);

  // 6) Empty text.
  const empty = await extractContractCommercialReply({
    text: "   ",
    missingFields: ALL_MISSING,
  });
  assert.equal(empty.intent, "unclear");
  assert.equal(Object.keys(empty.patch).length, 0);

  // 7) Filter fields not requested.
  const filteredModel: ContractCommercialExtractorModel = {
    async extract() {
      return {
        patch: {
          exclusive: true,
          commission_pct: 5,
        },
        confidence: "high",
        unresolved: [],
        assumptions: [],
      };
    },
  };
  const filtered = await extractContractCommercialReply(
    {
      text: "sí, exclusiva",
      missingFields: ALL_MISSING.filter((item) => item.key === "exclusive"),
    },
    filteredModel
  );
  assert.equal(filtered.patch.exclusive, true);
  assert.equal(filtered.patch.commission_pct, undefined);

  // 8) Numeric conflict between LLM and deterministic => drop field.
  const conflict = mergeContractCommercialPatches({
    llmPatch: { commission_pct: 5 },
    deterministicPatch: { commission_pct: 8 },
    missingFields: ALL_MISSING,
  });
  assert.equal(conflict.patch.commission_pct, undefined);
  assert.ok(conflict.unresolved.some((item) => item.field === "commission_pct"));

  // 9) Explicit deterministic boolean polarity wins over an LLM contradiction.
  const booleanConflict = mergeContractCommercialPatches({
    llmPatch: { exclusive: true },
    deterministicPatch: { exclusive: false },
    missingFields: ALL_MISSING,
    sourceText: "No es en exclusiva",
  });
  assert.equal(booleanConflict.patch.exclusive, false);
  assert.ok(
    booleanConflict.assumptions.some((item) => item.includes("exclusive"))
  );

  // 9b) Without explicit polarity in source text, keep LLM on boolean conflict.
  const weakDetConflict = mergeContractCommercialPatches({
    llmPatch: { exclusive: false },
    deterministicPatch: { exclusive: true },
    missingFields: ALL_MISSING,
    sourceText: "revisar tema de exclusiva luego",
  });
  assert.equal(weakDetConflict.patch.exclusive, false);
  assert.ok(
    weakDetConflict.assumptions.some((item) =>
      item.includes("conservó la interpretación del LLM")
    )
  );

  // 9c) E2E phrase: deterministic parse alone must not invent exclusive=true.
  const e2eExtract = await extractContractCommercialReply(
    {
      text:
        "alex@ungga.com, sí se comparte comisión del 5% del total y de ese el 50% es para cada parte. No es en exclusiva y es por 8 meses.",
      missingFields: ALL_MISSING,
    },
    {
      async extract() {
        return {
          patch: { exclusive: true },
          confidence: "medium",
          unresolved: [],
          assumptions: [],
        };
      },
    }
  );
  assert.equal(e2eExtract.patch.exclusive, false);

  // 10) Ambiguous text without mutation.
  const unclear = await extractContractCommercialReply(
    { text: "hola", missingFields: ALL_MISSING },
    {
      async extract() {
        return {
          patch: {},
          confidence: "low",
          unresolved: [{ field: "commission_pct", reason: "not stated" }],
          assumptions: [],
        };
      },
    }
  );
  assert.equal(unclear.intent, "unclear");
  assert.equal(Object.keys(unclear.patch).length, 0);

  console.log("contract-commercial-extraction.selftest: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
