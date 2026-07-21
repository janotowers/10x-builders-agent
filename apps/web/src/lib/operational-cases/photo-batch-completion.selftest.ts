import {
  RAW_PHOTOS_MIN_COUNT,
  countRawPhotos,
  formatPhotosUploadRequestNotifyText,
  looksLikePhotoBatchComplete,
  photosBatchInsufficientAckText,
  photosUploadProgressAckText,
} from "./photo-batch-completion";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

assert(countRawPhotos({ raw_photos: [{ id: "1" }, { id: "2" }] }) === 2, "count");
assert(countRawPhotos({}) === 0, "empty");
assert(looksLikePhotoBatchComplete("listo"), "listo");
assert(!looksLikePhotoBatchComplete("hola"), "not listo");

const notify = formatPhotosUploadRequestNotifyText({
  propertyLabel: "CIRCUNVALACION SUR 3668",
  caseId: "2744bf73-1796-4cee-9e70-d2ab180e4cfc",
});
assert(notify.includes("Solicitud de fotos"), "notify title");
assert(notify.includes(String(RAW_PHOTOS_MIN_COUNT)), "notify min");
assert(notify.includes("«listo»"), "notify listo");
assert(notify.includes("**«listo»**"), "notify listo bold");
assert(notify.includes("Fachada"), "notify checklist");
assert(!/panel/i.test(notify), "notify must not mention panel");
assert(notify.includes("aquí"), "notify channel-neutral aquí");
assert(!notify.includes("Referencia del caso"), "notify must omit case ref");

const notifyWithAppUrl = formatPhotosUploadRequestNotifyText({
  propertyLabel: "CIRCUNVALACION SUR 3668",
  caseId: "2744bf73-1796-4cee-9e70-d2ab180e4cfc",
  appUrl: "https://example.com",
});
assert(!/panel/i.test(notifyWithAppUrl), "appUrl must not add panel link");
assert(!/chat\/pending/i.test(notifyWithAppUrl), "no pending panel URL");
assert(
  !notifyWithAppUrl.includes("Referencia del caso"),
  "appUrl must not restore case ref"
);

assert(
  photosUploadProgressAckText(3).includes("«listo»"),
  "progress ack mentions listo"
);
assert(
  photosBatchInsufficientAckText(2).includes(`2/${RAW_PHOTOS_MIN_COUNT}`),
  "insufficient ack"
);

console.log("photo-batch-completion.selftest.ts: ok");
