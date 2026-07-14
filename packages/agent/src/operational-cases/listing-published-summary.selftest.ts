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
  publish_approvals: {
    easybroker: "approved",
    ungga: "pending",
  },
  publication: {
    destinations: {
      easybroker: { phase: "published" },
      ungga: { phase: "awaiting_approval" },
    },
  },
  published: {
    easybroker: {
      listing_id: "EB-123",
      public_url: "https://www.easybroker.com/mx/listings/eb-123",
      status: "published",
    },
  },
};

// EasyBroker alone while Ungga still pending must not close.
assert.equal(
  canCompleteListingPublishedSummaryFromContext(context).ok,
  false
);

// listing_id alone with not_published must not close.
assert.equal(
  canCompleteListingPublishedSummaryFromContext({
    publish_approvals: { easybroker: "approved", ungga: "skipped" },
    publication: {
      destinations: {
        easybroker: { phase: "draft_ready" },
        ungga: { phase: "skipped" },
      },
    },
    published: {
      easybroker: {
        listing_id: "EB-123",
        status: "not_published",
      },
    },
  }).ok,
  false
);

// Ungga GU-ID alone must not close.
assert.equal(
  canCompleteListingPublishedSummaryFromContext({
    publish_approvals: { easybroker: "skipped", ungga: "approved" },
    publication: {
      destinations: {
        easybroker: { phase: "skipped" },
        ungga: { phase: "draft_ready" },
      },
    },
    published: {
      ungga: {
        ungga_property_id: "GU-1",
        status: "draft",
      },
    },
  }).ok,
  false
);

// EasyBroker-imported Ungga ID must be rejected.
assert.equal(
  canCompleteListingPublishedSummaryFromContext({
    publish_approvals: { easybroker: "approved", ungga: "approved" },
    publication: {
      destinations: {
        easybroker: { phase: "published" },
        ungga: { phase: "published" },
      },
    },
    published: {
      easybroker: {
        listing_id: "EB-123",
        public_url: "https://www.easybroker.com/mx/listings/eb-123",
        status: "published",
      },
      ungga: {
        ungga_property_id: "vowMl9le6jQsOAYuSIIERGuOW1F2EB-WL9056",
        published_url:
          "https://ungga.com/app/propiedades/vowMl9le6jQsOAYuSIIERGuOW1F2EB-WL9056",
        status: "published",
      },
    },
  }).ok,
  false
);

// In-flight machine work blocks closure.
assert.equal(
  canCompleteListingPublishedSummaryFromContext(
    {
      ...context,
      publish_approvals: { easybroker: "approved", ungga: "approved" },
      publication: {
        destinations: {
          easybroker: { phase: "published" },
          ungga: { phase: "published" },
        },
      },
      published: {
        easybroker: context.published.easybroker,
        ungga: {
          ungga_property_id: "GU-1",
          published_url: "https://ungga.com/app/propiedades/GU-1",
          status: "published",
        },
      },
    },
    undefined,
    { machineWorkInFlight: true }
  ).ok,
  false
);

const bothOk = canCompleteListingPublishedSummaryFromContext({
  ...context,
  publish_approvals: { easybroker: "approved", ungga: "approved" },
  publication: {
    destinations: {
      easybroker: { phase: "published" },
      ungga: { phase: "published" },
    },
  },
  published: {
    easybroker: context.published.easybroker,
    ungga: {
      ungga_property_id: "GU-1",
      published_url: "https://ungga.com/app/propiedades/GU-1",
      status: "published",
    },
  },
});
assert.deepEqual(bothOk, { ok: true });

const text = formatListingPublishedSummaryNotifyText({
  id: "case-123",
  context_jsonb: context,
});

assert.match(text, /\*\*Resumen final de publicación\*\*/);
assert.match(text, /Avance de publicación para el caso case-123/);
assert.match(text, /Departamento en renta en Colomos Providencia/);
assert.match(text, /EasyBroker: https:\/\/www\.easybroker\.com\/mx\/listings\/eb-123/);
assert.match(text, /Ungga: sin publicación final registrada/);
assert.doesNotMatch(text, /Aprobar descripción/);

const bothDestinations = formatListingPublishedSummaryNotifyText({
  id: "case-456",
  context_jsonb: {
    ...context,
    publish_approvals: { easybroker: "approved", ungga: "approved" },
    published: {
      ...context.published,
      ungga: {
        ungga_property_id: "UG-1",
        published_url: "https://ungga.example/properties/UG-1",
      },
    },
  },
});
assert.match(bothDestinations, /Flujo completado para el caso case-456/);
assert.match(bothDestinations, /Ungga: https:\/\/ungga\.example\/properties\/UG-1/);

const incomplete = canCompleteListingPublishedSummaryFromContext({});
assert.equal(incomplete.ok, false);
assert.match(incomplete.reason ?? "", /publicaci/);

// Legacy relaxed still accepts listing_id for tool-readiness smoke.
assert.equal(
  canCompleteListingPublishedSummaryFromContext(
    {
      published: { easybroker: { listing_id: "EB-123" } },
    },
    undefined,
    { allowLegacyRelaxed: true }
  ).ok,
  true
);

console.log("listing-published-summary selftest ok");
