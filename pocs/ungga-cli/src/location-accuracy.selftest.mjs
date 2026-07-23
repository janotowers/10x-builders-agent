import assert from "node:assert/strict";
import {
  classifyLocationDistance,
  evaluateLocationAccuracy,
  haversineMeters,
  isUsableLatLng,
  parseLatLngFromText,
  pickTargetLocation,
} from "./location-accuracy.mjs";

assert.equal(isUsableLatLng(0, 0), false);
assert.equal(isUsableLatLng(20.62, -103.42), true);

{
  const d = haversineMeters(20.6200855, -103.4256502, 20.621281, -103.428369);
  assert.ok(d > 80, `expected >80m, got ${d}`);
  assert.equal(classifyLocationDistance(d), "retry");
}

assert.equal(classifyLocationDistance(20), "ok");
assert.equal(classifyLocationDistance(55), "soft_ok");
assert.equal(classifyLocationDistance(90), "retry");

{
  const parsed = parseLatLngFromText(
    "https://www.google.com/maps/@20.6200855,-103.4256502,17z"
  );
  assert.ok(parsed);
  assert.equal(parsed.latitude, 20.6200855);
  assert.equal(parsed.longitude, -103.4256502);
}

{
  const parsed = parseLatLngFromText(
    "https://maps.google.com/?q=20.62,-103.42&z=17"
  );
  assert.ok(parsed);
  assert.equal(parsed.latitude, 20.62);
  assert.equal(parsed.longitude, -103.42);
}

{
  const target = pickTargetLocation({
    location: {
      latitude: 20.6200855,
      longitude: -103.4256502,
      source: "zone_context",
    },
  });
  assert.equal(target?.source, "zone_context");

  const far = evaluateLocationAccuracy({
    expected: target,
    observed: { latitude: 20.621281, longitude: -103.428369 },
    source: "zone_context",
    corrected: true,
  });
  assert.equal(far.status, "warning");
  assert.ok(far.location_accuracy_warning);
  assert.equal(
    far.location_accuracy_warning.reason,
    "pin_still_far_after_correction"
  );
}

{
  const close = evaluateLocationAccuracy({
    expected: { latitude: 20.62, longitude: -103.42 },
    observed: { latitude: 20.6201, longitude: -103.4201 },
    source: "geocode",
  });
  assert.ok(close.status === "ok" || close.status === "soft_ok");
  assert.equal(close.location_accuracy_warning, null);
}

{
  const unread = evaluateLocationAccuracy({
    expected: { latitude: 20.62, longitude: -103.42 },
    observed: null,
    source: "zone_context",
  });
  assert.equal(unread.status, "unreadable");
  assert.equal(unread.location_accuracy_warning?.reason, "map_center_unreadable");
}

console.log("location-accuracy.selftest: ok");
