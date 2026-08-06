import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  checklistKeyForDocumentKind,
  documentsAckText,
  formatUploadBatchConfirmationReminderText,
  isUploadBatchNotificationKind,
  missingIdealDocumentLabels,
  resolveUploadBatchKind,
  uploadBatchKindFromNotificationKind,
} from "./upload-batch-completion";

const docsCase = {
  id: "c1",
  current_step: "awaiting_documents",
  status: "waiting_internal",
  context_jsonb: { document_request_target: "internal_user" },
} as unknown as OperationalCase;

assert.equal(resolveUploadBatchKind(docsCase), "documents");
assert.equal(
  resolveUploadBatchKind({
    ...docsCase,
    context_jsonb: { document_request_target: "external_contact" },
  } as unknown as OperationalCase),
  null
);
assert.equal(
  resolveUploadBatchKind({
    ...docsCase,
    current_step: "photos_requested",
  } as unknown as OperationalCase),
  "photos"
);

assert.equal(isUploadBatchNotificationKind("photos_upload_requested"), true);
assert.equal(
  isUploadBatchNotificationKind(DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND),
  true
);
assert.equal(isUploadBatchNotificationKind("case_update"), false);
assert.equal(
  uploadBatchKindFromNotificationKind("photos_upload_requested"),
  "photos"
);
assert.equal(
  uploadBatchKindFromNotificationKind(DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND),
  "documents"
);

const docsReminder = formatUploadBatchConfirmationReminderText({
  batchKind: "documents",
  fileCount: 3,
  context: {
    property_data: {
      street: "Circunvalación Sur",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
    },
    property_title: "Casa",
  },
});
assert.match(docsReminder, /Circunvalación Sur 3668, Las Fuentes/);
assert.match(docsReminder, /Terminé de subir/);
assert.match(docsReminder, /documentos/);
assert.doesNotMatch(docsReminder, /06d323da/);

const photosOk = formatUploadBatchConfirmationReminderText({
  batchKind: "photos",
  fileCount: 6,
  context: { property_title: "Depto Condesa" },
});
assert.match(photosOk, /6 fotos/);
assert.match(photosOk, /Depto Condesa/);

const photosShort = formatUploadBatchConfirmationReminderText({
  batchKind: "photos",
  fileCount: 3,
  context: { property_title: "Depto Condesa" },
});
assert.match(photosShort, /3 de las 5/);

assert.equal(checklistKeyForDocumentKind("escritura_primera_hoja"), "escritura_descripcion");
assert.equal(checklistKeyForDocumentKind("ine_anverso"), "ine");
{
  const missing = missingIdealDocumentLabels({
    coveredKinds: ["boleta_registral", "predial"],
  });
  assert.ok(missing.some((label) => /Escritura/i.test(label)));
  assert.ok(missing.some((label) => /Identificación/i.test(label)));
  assert.ok(!missing.some((label) => /Boleta/i.test(label)));
}
{
  const ack = documentsAckText({
    status: "advanced",
    propertyLabel: "Propiedad en Zapopan",
    missingIdealLabels: ["Comprobante de domicilio (≤ 3 meses)"],
  });
  assert.match(ack, /Propiedad en Zapopan/);
  assert.match(ack, /Comprobante de domicilio/);
  assert.doesNotMatch(ack, /[0-9a-f]{8}-[0-9a-f]{4}/i);
}

console.log("upload-batch-completion.selftest.ts: ok");
