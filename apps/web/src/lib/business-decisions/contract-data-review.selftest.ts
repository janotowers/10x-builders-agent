import assert from "node:assert/strict";
import {
  extractOwnerEmailFromContractDataReply,
  parseContractDataReviewReply,
} from "./contract-data-review";

assert.equal(
  extractOwnerEmailFromContractDataReply("El correo es maria.castaneda@example.com"),
  "maria.castaneda@example.com"
);
assert.equal(
  extractOwnerEmailFromContractDataReply("alex@ungga.com,"),
  "alex@ungga.com"
);

assert.equal(parseContractDataReviewReply("").intent, "unclear");
assert.equal(parseContractDataReviewReply("sin correo aqui").intent, "unclear");

const parsed = parseContractDataReviewReply(
  "Correo del comitente: maria.castaneda@example.com"
);
assert.equal(parsed.intent, "provide_data");
assert.equal(parsed.owner_email, "maria.castaneda@example.com");
assert.equal(parsed.patch?.owner_email, "maria.castaneda@example.com");

const commercial = parseContractDataReviewReply(
  "Sí se comparte comisión. Comisión total 5%. Exclusiva. Duración 6 meses. dueno@example.com",
  [
    {
      key: "owner_email",
      label: "Correo",
      question: "Correo",
      kind: "email",
    },
    {
      key: "collaboration_enabled",
      label: "Compartir",
      question: "¿Se comparte?",
      kind: "boolean",
    },
    {
      key: "commission_pct",
      label: "Comisión",
      question: "Comisión cobrada al propietario",
      kind: "number",
    },
    {
      key: "exclusive",
      label: "Exclusividad",
      question: "¿Exclusiva?",
      kind: "boolean",
    },
    {
      key: "duration_months",
      label: "Duración",
      question: "Meses",
      kind: "number",
    },
  ]
);
assert.equal(commercial.intent, "provide_data");
assert.equal(commercial.patch?.owner_email, "dueno@example.com");
assert.equal(commercial.patch?.collaboration_enabled, true);
assert.equal(commercial.patch?.commission_pct, 5);
assert.equal(commercial.patch?.exclusive, true);
assert.equal(commercial.patch?.duration_months, 6);

const natural = parseContractDataReviewReply(
  "Comisión total pactada con el propietario: 5%. Duración: 6 meses. Se comparte el 50% de la comisión total. alex@ungga.com,",
  [
    {
      key: "owner_email",
      label: "Correo",
      question: "Correo",
      kind: "email",
    },
    {
      key: "collaboration_enabled",
      label: "Compartir",
      question: "¿Se comparte?",
      kind: "boolean",
    },
    {
      key: "commission_pct",
      label: "Comisión",
      question: "Comisión cobrada al propietario",
      kind: "number",
    },
    {
      key: "exclusive",
      label: "Exclusividad",
      question: "¿Exclusiva?",
      kind: "boolean",
    },
    {
      key: "duration_months",
      label: "Duración",
      question: "Meses",
      kind: "number",
    },
  ]
);
assert.equal(natural.intent, "provide_data");
assert.equal(natural.patch?.owner_email, "alex@ungga.com");
assert.equal(natural.patch?.commission_pct, 5);
assert.equal(natural.patch?.duration_months, 6);
assert.equal(natural.patch?.compensation_value, 50);
assert.equal(
  natural.patch?.compensation_mode,
  "percentage_of_total_commission"
);

console.log("contract-data-review.selftest: ok");
