import assert from "node:assert/strict";
import { isUsableLatLng } from "./realestate-adapters";

assert.equal(isUsableLatLng(0, 0), false, "reject null island");
assert.equal(isUsableLatLng(0.0, 0.0), false);
assert.equal(isUsableLatLng(null, null), false);
assert.equal(isUsableLatLng(20.62, null), false);
assert.equal(isUsableLatLng(20.6200855, -103.4256502), true);
assert.equal(isUsableLatLng(19.43, -99.13), true);

console.log("realestate-adapters-latlng.selftest: ok");
