import assert from "node:assert/strict";
import {
  buildContractDataReviewTelegramMarkup,
  contractDataReviewBooleanButtonLabels,
  resolveSingleRequiredBooleanField,
} from "./contract-data-review-telegram-markup";

const multiMissing = [
  {
    key: "owner_email",
    label: "Correo",
    question: "Correo electrónico del propietario.",
    kind: "email",
  },
  {
    key: "collaboration_enabled",
    label: "Compartir comisión",
    question: "¿Se compartirá comisión?",
    kind: "boolean",
  },
  {
    key: "exclusive",
    label: "Exclusividad",
    question: "¿La captación es exclusiva?",
    kind: "boolean",
  },
];

assert.equal(resolveSingleRequiredBooleanField(multiMissing), null);
assert.equal(
  buildContractDataReviewTelegramMarkup("notif-1", multiMissing),
  undefined
);

const singleCollaboration = [
  {
    key: "collaboration_enabled",
    label: "Compartir comisión",
    question: "¿Se compartirá comisión?",
    kind: "boolean",
  },
];
const collaborationMarkup = buildContractDataReviewTelegramMarkup(
  "notif-2",
  singleCollaboration
);
assert.ok(collaborationMarkup);
assert.equal(
  collaborationMarkup?.inline_keyboard[0]?.[0]?.text,
  "Sí, compartir"
);
assert.equal(
  collaborationMarkup?.inline_keyboard[0]?.[1]?.text,
  "No compartir"
);
assert.equal(
  collaborationMarkup?.inline_keyboard[0]?.[0]?.callback_data,
  "cdr_yes:notif-2"
);

const singleExclusive = [
  {
    key: "exclusive",
    label: "Exclusividad",
    question: "¿La captación es exclusiva?",
    kind: "boolean",
  },
];
const exclusiveMarkup = buildContractDataReviewTelegramMarkup(
  "notif-3",
  singleExclusive
);
assert.equal(exclusiveMarkup?.inline_keyboard[0]?.[0]?.text, "Sí, exclusivo");
assert.equal(
  exclusiveMarkup?.inline_keyboard[0]?.[1]?.text,
  "No, sin exclusiva"
);

assert.deepEqual(contractDataReviewBooleanButtonLabels("other"), {
  yes: "Sí",
  no: "No",
});

// Optional boolean alongside required email → no generic Sí/No.
assert.equal(
  buildContractDataReviewTelegramMarkup("notif-4", [
    {
      key: "owner_email",
      kind: "email",
      question: "Correo",
    },
    {
      key: "collaboration_enabled",
      kind: "boolean",
      question: "¿Se comparte?",
      optional: true,
    },
  ]),
  undefined
);

console.log("contract-data-review-telegram-markup.selftest: ok");
