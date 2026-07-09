import assert from "node:assert/strict";
import {
  canCompleteListingPublishedSummaryFromContext,
  formatListingPublishedSummaryNotifyText,
} from "./listing-published-summary";

const context = {
  property_data: {
    legal_address: "Privada del Tulipán, Zapopan",
    currency: "MXN",
  },
  pricing_proposal: {
    salida: 24500,
    currency: "MXN",
  },
  listing_description_approved: {
    headline: "Departamento en renta en Colomos Providencia",
  },
  published: {
    easybroker: {
      listing_id: "EB-123",
      public_url: "https://www.easybroker.com/mx/listings/eb-123",
    },
  },
};

assert.deepEqual(canCompleteListingPublishedSummaryFromContext(context), { ok: true });

const text = formatListingPublishedSummaryNotifyText({
  id: "case-123",
  context_jsonb: context,
});

assert.match(text, /\*\*Resumen final de publicación\*\*/);
assert.match(text, /Departamento en renta en Colomos Providencia/);
assert.match(text, /EasyBroker: https:\/\/www\.easybroker\.com\/mx\/listings\/eb-123/);
assert.doesNotMatch(text, /Aprobar descripción/);

const incomplete = canCompleteListingPublishedSummaryFromContext({});
assert.equal(incomplete.ok, false);
assert.match(incomplete.reason ?? "", /destino publicado/);

console.log("listing-published-summary selftest ok");
