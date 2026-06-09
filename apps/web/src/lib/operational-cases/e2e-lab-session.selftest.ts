import assert from "node:assert/strict";
import {
  E2E_LAB_SESSION_DURATION_MS,
  e2eLabSessionExpiresAt,
  isE2ELabSessionUsable,
  shouldCreateControlledE2ECase,
} from "@agents/db";

const startedAt = new Date("2026-06-05T18:00:00.000Z");
const expiresAt = e2eLabSessionExpiresAt(startedAt);

assert.equal(
  expiresAt,
  new Date(startedAt.getTime() + E2E_LAB_SESSION_DURATION_MS).toISOString(),
  "default lab session duration should be 2 hours"
);

assert.equal(
  shouldCreateControlledE2ECase(
    { status: "active", expires_at: expiresAt },
    new Date("2026-06-05T19:59:59.000Z")
  ),
  true,
  "active non-expired session should mark new case as controlled E2E"
);

assert.equal(
  shouldCreateControlledE2ECase(
    { status: "active", expires_at: expiresAt },
    new Date("2026-06-05T20:00:00.000Z")
  ),
  false,
  "session is not usable at its exact expiration instant"
);

assert.equal(
  shouldCreateControlledE2ECase(
    { status: "cancelled", expires_at: expiresAt },
    new Date("2026-06-05T19:00:00.000Z")
  ),
  false,
  "cancelled session should not mark new case as controlled E2E"
);

assert.equal(
  isE2ELabSessionUsable(null, new Date("2026-06-05T19:00:00.000Z")),
  false,
  "missing session should use production behavior"
);

console.log("e2e-lab-session selftest passed");
