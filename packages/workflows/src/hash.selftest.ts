import assert from "node:assert/strict";
import { canonicalizeJson, computeDefinitionHash } from "./hash";

// 1. Key order does not change the canonical form.
assert.equal(
  canonicalizeJson({ b: 1, a: 2 }),
  canonicalizeJson({ a: 2, b: 1 }),
  "canonical form must be key-order independent"
);

// 2. Nested objects are canonicalized recursively.
assert.equal(
  canonicalizeJson({ outer: { z: [1, { y: 2, x: 3 }], a: null } }),
  '{"outer":{"a":null,"z":[1,{"x":3,"y":2}]}}'
);

// 3. Arrays preserve order (order is semantic for states/transitions).
assert.notEqual(canonicalizeJson([1, 2]), canonicalizeJson([2, 1]));

// 4. undefined values are dropped like JSON.stringify does.
assert.equal(canonicalizeJson({ a: undefined, b: 1 }), '{"b":1}');

// 5. Hash is stable across runs and key orders, and prefixed.
const h1 = computeDefinitionHash({ b: 1, a: { d: 4, c: 3 } });
const h2 = computeDefinitionHash({ a: { c: 3, d: 4 }, b: 1 });
assert.equal(h1, h2, "hash must be canonical");
assert.match(h1, /^sha256:[0-9a-f]{64}$/);

// 6. Any semantic change changes the hash.
assert.notEqual(h1, computeDefinitionHash({ b: 1, a: { d: 4, c: 999 } }));

console.log("hash.selftest: OK");
