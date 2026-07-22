import assert from "node:assert/strict";
import {
  formatPublishDestinationApprovalNotifyText,
  publicationDestinationLabelFromKind,
} from "./publication-destination-approval-copy";

assert.equal(
  publicationDestinationLabelFromKind("easybroker_publish_approval"),
  "EasyBroker"
);
assert.equal(
  publicationDestinationLabelFromKind("ungga_publish_approval"),
  "Ungga"
);
assert.equal(publicationDestinationLabelFromKind("other"), null);

const easybroker = formatPublishDestinationApprovalNotifyText({
  destination: "EasyBroker",
});
assert.match(easybroker, /Aprobación de publicación en EasyBroker/);
assert.match(easybroker, /¿Quieres continuar con EasyBroker\?/);
assert.match(easybroker, /este destino/);
assert.doesNotMatch(easybroker, /portal/i);
assert.doesNotMatch(easybroker, /Usa los botones/i);
assert.match(easybroker, /Elige una opción:/);
assert.doesNotMatch(easybroker, /- Publicar en EasyBroker\n/);

const ungga = formatPublishDestinationApprovalNotifyText({
  destination: "Ungga",
});
assert.match(ungga, /EasyBroker ya quedó publicado/);
assert.match(ungga, /¿Quieres continuar con Ungga\?/);
assert.match(ungga, /finaliza el proceso sin publicar en Ungga/);
assert.doesNotMatch(ungga, /portal/i);
assert.doesNotMatch(ungga, /Usa los botones/i);

console.log("publication-destination-approval-copy.selftest: ok");
