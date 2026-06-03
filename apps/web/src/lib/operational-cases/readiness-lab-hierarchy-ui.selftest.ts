import assert from "node:assert/strict";
import { readinessLabToolShellClass } from "./readiness-lab-hierarchy-ui";

assert.match(readinessLabToolShellClass("ready"), /bg-white/);
assert.match(readinessLabToolShellClass("ready"), /border-l-emerald/);
assert.doesNotMatch(readinessLabToolShellClass("ready"), /bg-emerald-50/);

assert.match(readinessLabToolShellClass("needs_config"), /border-l-amber/);

console.log("readiness-lab-hierarchy-ui.selftest: ok");
