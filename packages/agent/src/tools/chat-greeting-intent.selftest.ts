import assert from "node:assert/strict";
import { userMessageIsPresenceOrGreetingOnly } from "./chat-greeting-intent";

assert.equal(userMessageIsPresenceOrGreetingOnly("Hola, sigues ahi?"), true);
assert.equal(userMessageIsPresenceOrGreetingOnly("¿Sigues ahí?"), true);
assert.equal(userMessageIsPresenceOrGreetingOnly("sigues ahí"), true);
assert.equal(userMessageIsPresenceOrGreetingOnly("hola"), true);
assert.equal(userMessageIsPresenceOrGreetingOnly("ping"), true);
assert.equal(userMessageIsPresenceOrGreetingOnly("gracias"), true);

assert.equal(
  userMessageIsPresenceOrGreetingOnly("hola, muéstrame mis repos de github"),
  false
);
assert.equal(userMessageIsPresenceOrGreetingOnly("lista mis repositorios"), false);
assert.equal(userMessageIsPresenceOrGreetingOnly("eventos de hoy"), false);

console.log("chat-greeting-intent.selftest: passed");
