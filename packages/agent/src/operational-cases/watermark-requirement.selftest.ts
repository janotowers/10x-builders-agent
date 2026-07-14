import assert from "node:assert/strict";
import { contextRequiresWatermark } from "./watermark-requirement";

assert.equal(contextRequiresWatermark(null), false);
assert.equal(contextRequiresWatermark({}), false);
assert.equal(
  contextRequiresWatermark({ watermark_configured: false }),
  false,
  "explicit no-asset must not require watermark"
);
assert.equal(
  contextRequiresWatermark({
    watermark_configured: false,
    watermark_required: true,
  }),
  false,
  "configured=false wins over required=true"
);
assert.equal(contextRequiresWatermark({ watermark_configured: true }), true);
assert.equal(contextRequiresWatermark({ watermark_required: true }), true);
assert.equal(contextRequiresWatermark({ require_watermark: true }), true);
assert.equal(
  contextRequiresWatermark({ publication_requirements: { watermark: true } }),
  true
);
assert.equal(
  contextRequiresWatermark({ watermarked_photos: [] }),
  false,
  "empty watermarked_photos alone is not enough"
);
assert.equal(
  contextRequiresWatermark({ watermarked_photos: ["account-assets:wm/a.jpg"] }),
  true
);
assert.equal(
  contextRequiresWatermark({
    watermark_missing: ["case-documents:a.jpg"],
  }),
  true
);

console.log("watermark-requirement.selftest: ok");
