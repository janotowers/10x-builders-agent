import assert from "node:assert/strict";
import {
  applyCommissionTermsPatch,
  buildContractCommercialMinimumsSummaryMessage,
  emptyCommissionTerms,
  evaluateContractCommercialMinimums,
  mapCollaborationToEasyBroker,
  mapCollaborationToUngga,
  parseCommissionTerms,
  parseContractCommercialReply,
} from "./contract-commercial-terms";

const empty = evaluateContractCommercialMinimums({});
assert.equal(empty.ok, false);
assert.ok(empty.missing.some((item) => item.key === "owner_email"));
assert.ok(empty.missing.some((item) => item.key === "collaboration_enabled"));
assert.ok(empty.missing.some((item) => item.key === "commission_pct"));
assert.ok(empty.missing.some((item) => item.key === "exclusive"));
assert.ok(empty.missing.some((item) => item.key === "duration_months"));
// Optional compensation is not listed until enabled=true
assert.equal(
  empty.missing.some((item) => item.key === "compensation_mode"),
  false
);

const withEmail = evaluateContractCommercialMinimums({
  context: { owner_email: "dueno@example.com" },
});
assert.equal(
  withEmail.missing.some((item) => item.key === "owner_email"),
  false
);
assert.ok(withEmail.known.some((item) => item.key === "owner_email"));

let terms = emptyCommissionTerms();
terms = applyCommissionTermsPatch(terms, {
  collaboration_enabled: false,
  commission_pct: 5,
  exclusive: true,
  duration_months: 6,
  confirm: true,
  confirmed_by: "asesor",
});
assert.equal(terms.collaboration.enabled, false);
assert.equal(terms.collaboration.compensation.value, null);
assert.equal(terms.collaboration.notes, null);

const noShare = evaluateContractCommercialMinimums({
  context: {
    owner_email: "dueno@example.com",
    commission_terms: terms,
  },
});
assert.equal(noShare.ok, true);
assert.equal(
  noShare.missing.some((item) => item.key === "compensation_mode"),
  false
);

terms = applyCommissionTermsPatch(emptyCommissionTerms(), {
  collaboration_enabled: true,
  commission_pct: 5,
  exclusive: false,
  duration_months: 3,
  confirm: true,
});
assert.equal(terms.collaboration.compensation.mode, "not_specified");
const shareWithoutDetail = evaluateContractCommercialMinimums({
  context: {
    owner_email: "dueno@example.com",
    commission_terms: terms,
  },
});
assert.equal(shareWithoutDetail.ok, true);
assert.ok(
  shareWithoutDetail.missing.some(
    (item) => item.key === "compensation_mode" && item.optional === true
  )
);

terms = applyCommissionTermsPatch(terms, {
  compensation_mode: "percentage_of_total_commission",
  compensation_value: 40,
});
const mapped = mapCollaborationToEasyBroker(terms);
assert.equal(mapped.share_commission, true);
assert.equal(mapped.shared_commission_percentage, undefined);
assert.ok(
  mapped.warnings.some(
    (warning) => warning.code === "destination_commission_mapping_unsupported"
  )
);

terms = applyCommissionTermsPatch(terms, {
  compensation_value: 50,
});
const mapped50 = mapCollaborationToEasyBroker(terms);
assert.equal(mapped50.share_commission, true);
assert.equal(mapped50.shared_commission_percentage, 50);
assert.equal(mapped50.warnings.length, 0);

const unggaMapped = mapCollaborationToUngga(terms);
assert.equal(unggaMapped.collaboration_enabled, true);
assert.ok(
  unggaMapped.warnings.some(
    (warning) => warning.code === "destination_commission_mapping_unsupported"
  )
);

terms = applyCommissionTermsPatch(terms, {
  compensation_mode: "fixed_amount",
  compensation_value: 10000,
  compensation_currency: "MXN",
});
const unggaFixed = mapCollaborationToUngga(terms);
assert.equal(unggaFixed.collaboration_enabled, true);
assert.ok(
  unggaFixed.warnings.some(
    (warning) => warning.code === "destination_commission_mapping_unsupported"
  )
);

const parsedLegacy = parseCommissionTerms({
  commission_pct: 5,
  exclusive: true,
  duration_months: 6,
  share_commission: true,
  shared_commission_percentage: 50,
});
assert.equal(parsedLegacy.collaboration.enabled, true);
assert.equal(parsedLegacy.collaboration.compensation.value, 50);

const reply = parseContractCommercialReply(
  "Sí se comparte comisión. Comisión total 5%. Exclusiva. Duración 6 meses. dueno@example.com",
  empty.missing
);
assert.equal(reply.intent, "provide_data");
assert.equal(reply.patch.owner_email, "dueno@example.com");
assert.equal(reply.patch.collaboration_enabled, true);
assert.equal(reply.patch.commission_pct, 5);
assert.equal(reply.patch.exclusive, true);
assert.equal(reply.patch.duration_months, 6);

const replyNatural = parseContractCommercialReply(
  "alex@ungga.com, sí se comparte comisión, del 50% del total de la comisión, exclusiva, 6 meses",
  empty.missing
);
assert.equal(replyNatural.intent, "provide_data");
assert.equal(replyNatural.patch.owner_email, "alex@ungga.com");
assert.equal(replyNatural.patch.collaboration_enabled, true);
assert.equal(replyNatural.patch.exclusive, true);
assert.equal(replyNatural.patch.duration_months, 6);
assert.equal(replyNatural.patch.compensation_mode, "percentage_of_total_commission");
assert.equal(replyNatural.patch.compensation_value, 50);
// Still missing owner commission % — must not confuse shared 50 with commission_pct.
assert.equal(replyNatural.patch.commission_pct, undefined);

const replyNonExclusive = parseContractCommercialReply(
  "alex@ungga.com, sí se comparte comisión, la comisión es del 5% del precio de venta. No es exclusiva y es por 6 meses.",
  empty.missing
);
assert.equal(replyNonExclusive.patch.exclusive, false);

const replyExplicitNonExclusive = parseContractCommercialReply(
  "No, la captación no es exclusiva y el porcentaje de esa comisión que se comparte es de la mitad",
  [
    {
      key: "exclusive",
      label: "Exclusividad",
      question: "¿La captación es exclusiva?",
      kind: "boolean",
    },
    {
      key: "compensation_value",
      label: "Comisión compartida",
      question: "¿Qué porcentaje se comparte?",
      kind: "number",
      optional: true,
    },
  ]
);
assert.equal(replyExplicitNonExclusive.patch.exclusive, false);

const replyOwnerCommission = parseContractCommercialReply(
  "Comisión total pactada con el propietario: 5%. Duración: 6 meses. Se comparte el 50% de la comisión total.",
  [
    ...empty.missing,
    {
      key: "compensation_mode",
      label: "Detalle",
      question: "detalle",
      kind: "choice",
      optional: true,
    },
    {
      key: "compensation_value",
      label: "Valor",
      question: "valor",
      kind: "number",
      optional: true,
    },
  ]
);
assert.equal(replyOwnerCommission.patch.commission_pct, 5);
assert.equal(replyOwnerCommission.patch.duration_months, 6);
assert.equal(replyOwnerCommission.patch.compensation_value, 50);
assert.equal(
  replyOwnerCommission.patch.compensation_mode,
  "percentage_of_total_commission"
);

const replySixMonthsWord = parseContractCommercialReply("seis meses", [
  {
    key: "duration_months",
    label: "Duración",
    question: "Duración",
    kind: "number",
  },
]);
assert.equal(replySixMonthsWord.patch.duration_months, 6);

const replyBareMonths = parseContractCommercialReply("Exclusiva. 6 meses. dueno@example.com,", [
  {
    key: "owner_email",
    label: "Correo",
    question: "Correo",
    kind: "email",
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
    question: "Duración",
    kind: "number",
  },
]);
assert.equal(replyBareMonths.patch.owner_email, "dueno@example.com");
assert.equal(replyBareMonths.patch.exclusive, true);
assert.equal(replyBareMonths.patch.duration_months, 6);

const replySharedOnly = parseContractCommercialReply("Comisión compartida 40%", [
  {
    key: "commission_pct",
    label: "Comisión",
    question: "Comisión cobrada al propietario",
    kind: "number",
  },
  {
    key: "compensation_value",
    label: "Compartida",
    question: "Porcentaje compartido",
    kind: "number",
    optional: true,
  },
]);
assert.equal(replySharedOnly.patch.commission_pct, undefined);
assert.equal(replySharedOnly.patch.compensation_value, 40);

const summary = buildContractCommercialMinimumsSummaryMessage(empty);
assert.match(summary, /Para preparar el contrato de comisión, necesito estos datos/);
assert.match(summary, /Correo electrónico del propietario/);
assert.match(summary, /Comisión cobrada al propietario/);
assert.equal(summary.includes("Datos conocidos"), false);
assert.equal(summary.includes("Sin datos contractuales consolidados todavía"), false);
assert.equal(summary.includes("Faltantes:"), false);
assert.match(summary, /Puedes responder todo en un solo mensaje/);

const summaryWithKnown = buildContractCommercialMinimumsSummaryMessage({
  ...empty,
  known: [
    {
      key: "owner_email",
      label: "Correo del propietario",
      value: "dueno@example.com",
    },
  ],
  missing: empty.missing.filter((item) => item.key !== "owner_email"),
});
assert.match(summaryWithKnown, /Datos ya registrados/);
assert.match(summaryWithKnown, /Correo del propietario: dueno@example.com/);
assert.match(summaryWithKnown, /Aún necesito/);

const summaryPartial = buildContractCommercialMinimumsSummaryMessage(
  {
    ...empty,
    known: [
      {
        key: "owner_email",
        label: "Correo del propietario",
        value: "dueno@example.com",
      },
    ],
    missing: empty.missing.filter((item) => item.key !== "owner_email"),
  },
  { mode: "partial" }
);
assert.match(summaryPartial, /Gracias\. Con lo que enviaste aún falta completar el contrato/);
assert.match(summaryPartial, /Datos ya registrados/);
assert.match(summaryPartial, /Aún necesito/);
assert.match(summaryPartial, /Puedes responder solo los pendientes/);
assert.equal(summaryPartial.includes("Faltantes:"), false);

const shareKnown = evaluateContractCommercialMinimums({
  context: {
    owner_email: "dueno@example.com",
    commission_terms: applyCommissionTermsPatch(emptyCommissionTerms(), {
      collaboration_enabled: true,
      compensation_mode: "percentage_of_total_commission",
      compensation_value: 50,
      commission_pct: 5,
      exclusive: true,
      duration_months: 6,
      confirm: true,
    }),
  },
});
assert.equal(shareKnown.ok, true);
const sharedKnownLine = shareKnown.known.find(
  (item) => item.key === "compensation_detail"
);
assert.ok(sharedKnownLine);
assert.match(sharedKnownLine!.value, /50%/);
assert.match(sharedKnownLine!.value, /Porcentaje de la comisión total/);
assert.equal(sharedKnownLine!.value.includes("percentage_of_total_commission"), false);

console.log("contract-commercial-terms.selftest: ok");
