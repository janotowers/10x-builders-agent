import assert from "node:assert/strict";
import { isOperationalContinueNudge } from "./operational-case-post-turn";

assert.equal(isOperationalContinueNudge("continua"), true);
assert.equal(isOperationalContinueNudge("Continuar"), true);
assert.equal(isOperationalContinueNudge("sigue."), true);
assert.equal(isOperationalContinueNudge("listo"), true);
assert.equal(isOperationalContinueNudge("hola"), false);
assert.equal(isOperationalContinueNudge("continua mañana"), false);

console.log("operational-case-post-turn.selftest: ok");
