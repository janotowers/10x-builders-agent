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

const summary = buildContractCommercialMinimumsSummaryMessage(empty);
assert.match(summary, /Faltantes/);
assert.match(summary, /Correo electrónico del propietario/);

console.log("contract-commercial-terms.selftest: ok");
