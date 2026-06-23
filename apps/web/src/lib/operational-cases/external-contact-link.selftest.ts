import assert from "node:assert/strict";
import {
  EXTERNAL_CONTACT_LINK_PREFIX,
  buildExternalContactSetupMessage,
  generateExternalContactLinkTokenValue,
  parseExternalContactLinkPayload,
} from "./external-contact-link";

// Token: hex suficientemente largo y único entre llamadas.
const t1 = generateExternalContactLinkTokenValue();
const t2 = generateExternalContactLinkTokenValue();
assert.ok(/^[a-f0-9]{32}$/.test(t1), `token inesperado: ${t1}`);
assert.notEqual(t1, t2);

// Parseo del payload de /start.
assert.equal(
  parseExternalContactLinkPayload(`${EXTERNAL_CONTACT_LINK_PREFIX}${t1}`),
  t1
);
assert.equal(parseExternalContactLinkPayload("ec_ABCD1234"), "ABCD1234");
assert.equal(parseExternalContactLinkPayload("ABC123"), null);
assert.equal(parseExternalContactLinkPayload(""), null);
assert.equal(parseExternalContactLinkPayload(null), null);
assert.equal(parseExternalContactLinkPayload("ec_"), null);
assert.equal(parseExternalContactLinkPayload("ec_short!"), null);

// Mensaje de setup: con deep link lo incluye y ofrece interno como alternativa.
const withLink = buildExternalContactSetupMessage({
  deepLink: "https://t.me/mybot?start=ec_abc123",
});
assert.ok(withLink.includes("https://t.me/mybot?start=ec_abc123"));
assert.ok(withLink.includes("«interno»"));

// Sin deep link: fallback honesto, sin prometer enlace.
const withoutLink = buildExternalContactSetupMessage({ deepLink: null });
assert.ok(!withoutLink.includes("https://t.me/"));
assert.ok(withoutLink.includes("«interno»"));

console.log("external-contact-link.selftest: ok");
