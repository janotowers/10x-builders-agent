import {
  getProfile,
  getInternalUserNotification,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  resolveInternalNotificationWithReminders,
  shortOperationalCaseId,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
import { isControlledE2EOperationalCase } from "@agents/types";
import { sendGmailMessage } from "@/lib/gmail/send-message";
import { notify } from "@/lib/notify";
import { buildExternalCaseDocumentDownloadUrl } from "@/lib/operational-cases/case-document-download-token";
import { resolveContractDraftDeliveryUrl } from "@/lib/operational-cases/contract-draft-document";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  GENERATED_DOCUMENT_BUCKET,
  buildFriendlyGeneratedDocumentFilename,
  dedupeConcatenatedSiteOriginInUrl,
  resolveGeneratedDocumentOutputPathFromCase,
} from "@/lib/operational-cases/generated-case-document";
import { resolveShortPropertyAddress } from "@/lib/operational-cases/property-display-label";

export type ContractReviewIntent =
  | "approve_send"
  | "request_changes"
  | "unclear";

export type ParsedContractReviewDecision = {
  intent: ContractReviewIntent;
  change_notes?: string;
  reason?: string;
  /**
   * Remanente del texto que el parser NO consumió (slice 0.1, preservación de
   * intención residual). `null` cuando la decisión consumió todo el texto.
   */
  residual?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
  );
}

async function triggerControlledE2EAgentTick(
  db: DbClient,
  updated: NonNullable<Awaited<ReturnType<typeof updateOperationalCase>>>,
  source: string
) {
  const { runSettingsTestCaseAgentTick } = await import(
    "@/lib/operational-cases/run-settings-test-case-tick"
  );
  await runSettingsTestCaseAgentTick(db, updated, updated.user_id, { source });
}

export async function runDeferredContractControlledE2ETick(
  db: DbClient,
  caseId: string,
  source: string
): Promise<void> {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) return;
  await triggerControlledE2EAgentTick(db, opCase, source);
}

export function parseContractReviewDecision(text: string): ParsedContractReviewDecision {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) {
    return { intent: "unclear", reason: "Respuesta vacía." };
  }

  // Slice 0.1: la parte del texto que el patrón de decisión no cubrió se
  // reporta como remanente para que la respuesta lo reconozca.
  const residualAfterMatch = (match: RegExpMatchArray): string | null => {
    if (match.index == null) return null;
    const remainder =
      `${trimmed.slice(0, match.index)} ${trimmed.slice(match.index + match[0].length)}`;
    return remainder.trim() ? remainder : null;
  };

  const approveSendPatterns = [
    /^(s[ií]|ok|va|dale|perfecto)\s*[,.]?\s*(m[aá]ndalo|env[ií]alo|enviar|mandar)/i,
    /^(m[aá]ndalo|env[ií]alo|enviar al due[nñ]o|mandar al due[nñ]o)/i,
    /^(aprobar|aprobado|apruebo)\s*(y\s*)?(m[aá]ndar|enviar)/i,
    /no\s+necesita\s+cambios.*(m[aá]ndar|enviar)/i,
    /sin\s+cambios.*(m[aá]ndar|enviar)/i,
    /listo.*(m[aá]ndar|enviar)/i,
    /enviar\s+por\s+email/i,
    /enviar\s+por\s+correo/i,
  ];
  for (const pattern of approveSendPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return { intent: "approve_send", residual: residualAfterMatch(match) };
    }
  }

  const changePatterns = [
    /(necesita\s+cambios|haz\s+cambios|hay\s+que\s+cambiar|ajusta|corrige|modifica)/i,
    /(no\s+lo\s+mandes|no\s+env[ií]es|espera|detente)/i,
    /(revisar\s+de\s+nuevo|vuelve\s+a\s+generar)/i,
    /(subir|sube|cargar|carga)\s+contrato\s+corregido/i,
    /contrato\s+corregido\s+y\s+enviar/i,
  ];
  if (changePatterns.some((pattern) => pattern.test(normalized))) {
    // Las notas de cambio consumen todo el texto: sin remanente.
    return {
      intent: "request_changes",
      change_notes: trimmed,
      residual: null,
    };
  }

  const bareApproveMatch = trimmed.match(/^(aprobar|aprobado|apruebo)(\s+contrato)?\b/i);
  if (bareApproveMatch) {
    return {
      intent: "approve_send",
      residual: residualAfterMatch(bareApproveMatch),
    };
  }

  return {
    intent: "unclear",
    reason:
      "No entendí si quieres enviarlo por email o subir una versión corregida. Ejemplos: «enviar por email» o «subir contrato corregido y enviar».",
  };
}

async function resolveContractDocUrl(
  db: DbClient,
  caseId: string,
  context: Record<string, unknown>
): Promise<string | null> {
  const fromContext = await resolveContractDraftDeliveryUrl(db, {
    caseId,
    context,
    forExternalAudience: true,
  });
  if (fromContext) {
    if (fromContext.includes("/api/public/operational-cases/documents/download")) {
      return fromContext;
    }
    if (
      fromContext.includes("/api/operational-cases/") &&
      fromContext.includes("/download")
    ) {
      const opCase = await getOperationalCase(db, caseId);
      if (opCase?.user_id) {
        const ref = await resolveGeneratedDocumentOutputPathFromCase(db, {
          caseId,
          context,
          binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
        });
        if (ref?.output_path) {
          const external = buildExternalCaseDocumentDownloadUrl({
            caseId,
            userId: opCase.user_id,
            documentKey: CONTRACT_DRAFT_DOCUMENT_BINDING.documentKey,
            outputPath: ref.output_path,
          });
          if (external) return external;
        }
      }
    }
    return fromContext;
  }

  const events = await getRecentOperationalCaseEvents(db, caseId, 30);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type !== "human_decision") continue;
    const payload = event.payload_jsonb;
    if (!isRecord(payload)) continue;
    if (payload.kind !== "contract_drafted") continue;
    const outputPath =
      typeof payload.output_path === "string" ? payload.output_path.trim() : "";
    if (outputPath) {
      const merged = {
        ...context,
        contract_draft: {
          ...(isRecord(context.contract_draft) ? context.contract_draft : {}),
          output_path: outputPath,
          output_bucket:
            typeof payload.output_bucket === "string"
              ? payload.output_bucket
              : undefined,
        },
      };
      const fromEvent = await resolveContractDraftDeliveryUrl(db, {
        caseId,
        context: merged,
        forExternalAudience: true,
      });
      if (fromEvent) return fromEvent;
    }
    const docUrl = payload.doc_url;
    if (typeof docUrl === "string" && docUrl.trim() && !docUrl.includes("example.test")) {
      return dedupeConcatenatedSiteOriginInUrl(docUrl.trim());
    }
  }
  return null;
}

function cleanString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item))
    .filter((item): item is string => Boolean(item));
}

function resolveOwnerEmail(context: Record<string, unknown>): string {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  return (
    cleanString(context.owner_email) ||
    cleanString(propertyData.owner_email) ||
    cleanString(propertyData.email) ||
    cleanString(context.email)
  );
}

function resolveOwnerName(context: Record<string, unknown>): string {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const ownerNames = [
    ...cleanStringArray(context.owner_names),
    ...cleanStringArray(propertyData.owner_names),
  ];
  return (
    cleanString(context.owner_name) ||
    cleanString(context.owner_full_name) ||
    ownerNames[0] ||
    cleanString(context.lead_name) ||
    cleanString(context.contact_name) ||
    cleanString(propertyData.owner_name) ||
    cleanString(propertyData.owner_full_name) ||
    cleanString(propertyData.lead_name) ||
    cleanString(propertyData.contact_name)
  );
}

function resolvePropertyReference(context: Record<string, unknown>): string {
  return resolveShortPropertyAddress(context);
}

function resolveLegalPropertyAddress(context: Record<string, unknown>): string {
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const directLegalAddress = firstNonEmptyString([
    propertyData.legal_address,
    cleanStringArray(propertyData.legal_addresses)[0],
    context.legal_address,
    cleanStringArray(context.legal_addresses)[0],
  ]);
  if (directLegalAddress) return directLegalAddress;

  const street = firstNonEmptyString([propertyData.street, propertyData.address_street]);
  const exterior = firstNonEmptyString([
    propertyData.exterior_number,
    propertyData.outdoor_number,
    propertyData.number,
  ]);
  const interior = firstNonEmptyString([
    propertyData.interior_number,
    propertyData.indoor_number,
    propertyData.apartment_number,
  ]);
  const neighborhood = firstNonEmptyString([
    propertyData.neighborhood,
    propertyData.fraccionamiento,
    propertyData.suburb,
  ]);
  const municipality = firstNonEmptyString([propertyData.municipality, propertyData.city]);
  const state = cleanString(propertyData.state);

  const components = [
    street ? `CALLE ${street}` : "",
    exterior ? `NUMERO ${exterior}` : "",
    interior ? `INTERIOR ${interior}` : "",
    neighborhood ? `FRACCIONAMIENTO ${neighborhood}` : "",
    municipality,
    state,
  ].filter(Boolean);
  return components.join(", ");
}

const MAX_GMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type ContractEmailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

function contentTypeForAttachmentName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith(".pdf")) return "application/pdf";
  if (normalized.endsWith(".doc"))
    return "application/msword";
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

async function loadContractAttachment(params: {
  db: DbClient;
  opCase: {
    id: string;
    context_jsonb?: unknown;
    external_contact_jsonb?: { display_name?: string } | null;
    created_at?: string | null;
  };
  storagePath: string;
  storageBucket?: string;
  originalName?: string | null;
}): Promise<{ ok: true; attachment: ContractEmailAttachment } | { ok: false; message: string }> {
  const bucket = params.storageBucket?.trim() || GENERATED_DOCUMENT_BUCKET;
  const { data, error } = await params.db.storage
    .from(bucket)
    .download(params.storagePath);
  if (error || !data) {
    return {
      ok: false,
      message: "No pude descargar el contrato desde storage para adjuntarlo al correo.",
    };
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength <= 0) {
    return {
      ok: false,
      message: "El archivo del contrato está vacío; no pude adjuntarlo al correo.",
    };
  }
  if (bytes.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      message:
        "El contrato excede el tamaño permitido para adjunto por email. Reduce el archivo y vuelve a intentarlo.",
    };
  }
  const filename =
    cleanString(params.originalName) ||
    buildFriendlyGeneratedDocumentFilename({
      opCase: params.opCase,
      binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
      storagePath: params.storagePath,
      fallbackName: `${CONTRACT_DRAFT_DOCUMENT_BINDING.documentKey}.docx`,
    });
  return {
    ok: true,
    attachment: {
      filename,
      contentType: contentTypeForAttachmentName(filename),
      content: bytes,
    },
  };
}

async function sendContractByEmail(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  context: Record<string, unknown>;
  ownerEmail: string;
  ownerName: string;
  docUrl: string;
  attachment: ContractEmailAttachment;
}) {
  const recipientName = params.ownerName || "Propietario/a";
  const propertyReference = resolvePropertyReference(params.context);
  const legalAddress = resolveLegalPropertyAddress(params.context) || propertyReference;
  const caseRef = shortOperationalCaseId(params.caseId);
  let senderName = "Alejandro Torres Padilla";
  try {
    const profile = await getProfile(params.db, params.userId);
    senderName = cleanString(profile.name) || senderName;
  } catch {
    // No bloqueamos envío por un fallo de perfil; usamos firma por defecto.
  }
  const subject = [
    "Contrato de comisión para revisión",
    propertyReference ? `Propiedad: ${propertyReference}` : null,
    caseRef ? `Caso ${caseRef}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const intro = legalAddress
    ? `Te comparto el contrato de comisión para revisión de tu propiedad en ${legalAddress}.`
    : "Te comparto el contrato de comisión para revisión.";
  return sendGmailMessage({
    db: params.db,
    userId: params.userId,
    to: params.ownerEmail,
    subject,
    body: [
      `Estimada ${recipientName},`,
      "",
      intro,
      caseRef ? `Referencia interna: caso ${caseRef}.` : "",
      "",
      "Puedes descargarlo aquí:",
      params.docUrl,
      "",
      "También te lo adjunto en este correo para que lo revises fácilmente.",
      "",
      "Cuando esté firmado, por favor compártelo conmigo.",
      "",
      "Saludos,",
      senderName,
      "Ungga",
      "",
      "Av. Del Tule 839 L-11,",
      "Col. Puertas del Tule,",
      "45017 Zapopan, Jalisco, México.",
      "",
      "Tel. (+52) 33 - 3110 0083",
      "Sitio Web: https://ungga.com",
      "",
      "La informacion contenida en este correo electronico esta destinada unicamente al uso del destinatario. Queda prohibido a cualquier persona o entidad que no sea el destinatario realizar cualquier modificacion, copia o distribucion de esta informacion. Si lo recibe por error, elimine el mensaje y notifique al remitente.",
    ].join("\n"),
    attachments: [params.attachment],
  });
}

export async function handleContractReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    deferControlledE2ETick?: boolean;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (
    notification.kind !== "contract_review" &&
    notification.kind !== "contract_pending"
  ) {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es una revisión de contrato.",
    };
  }
  const metadata = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  if (
    notification.kind === "contract_pending" &&
    Array.isArray(metadata.missing_required_fields) &&
    metadata.missing_required_fields.length > 0
  ) {
    return {
      ok: false,
      status: "wrong_kind",
      message:
        "Este pendiente pide datos contractuales faltantes, no revisión del borrador.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no está asociado a un caso.",
    };
  }

  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);

  const parsed = parseContractReviewDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const settingsTestCase = isSettingsTestCase(context);

  if (parsed.intent === "request_changes") {
    const ownerEmail = resolveOwnerEmail(context);
    const updated = await advisedUpdateCase(db, opCase, opCase.version, {
      status: "waiting_internal",
      currentStep: "contract_pending",
      nextActionAt: new Date().toISOString(),
      context: {
        ...context,
        contract_review: {
          status: "awaiting_revision_upload",
          notes: parsed.change_notes ?? params.text.trim(),
          requested_at: new Date().toISOString(),
        },
      },
    });
    if (!updated) {
      return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
    }
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: {
        kind: "contract_revision_upload_requested",
        notes: parsed.change_notes ?? params.text.trim(),
      },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    await notify(
      db,
      params.userId,
      {
        kind: "contract_revision_upload",
        text: ownerEmail
          ? `Sube el contrato corregido en DOCX o PDF para enviarlo automaticamente por email a ${ownerEmail}.`
          : "Sube el contrato corregido en DOCX o PDF para enviarlo automaticamente por email al propietario.",
        data: {
          case_id: opCase.id,
          owner_email: ownerEmail || null,
        },
      },
      "normal"
    );
    return {
      ok: true,
      status: "changes_requested",
      message: ownerEmail
        ? `Listo. Sube el contrato corregido (DOCX/PDF) por este chat o por Telegram y lo enviaré automaticamente por email a ${ownerEmail}.`
        : "Listo. Sube el contrato corregido (DOCX/PDF) por este chat o por Telegram y lo enviaré automaticamente por email al propietario.",
    };
  }

  const docUrl = await resolveContractDocUrl(db, opCase.id, context);
  if (!docUrl) {
    return {
      ok: false,
      status: "missing_doc_url",
      message:
        "No encontré el enlace del borrador (contract_drafted). Vuelve a generar el contrato antes de enviarlo al dueño.",
    };
  }
  const contractRef = await resolveGeneratedDocumentOutputPathFromCase(db, {
    caseId: opCase.id,
    context,
    binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
  });
  const storagePath = contractRef?.output_path?.trim() ?? "";
  if (!storagePath) {
    return {
      ok: false,
      status: "missing_contract_attachment",
      message:
        "No encontré el archivo del contrato para adjuntarlo al correo. Vuelve a generar el borrador antes de enviarlo.",
    };
  }
  const attachmentResult = await loadContractAttachment({
    db,
    opCase,
    storagePath,
    storageBucket: contractRef?.output_bucket,
    originalName: isRecord(context.contract_draft)
      ? cleanString(context.contract_draft.original_name)
      : "",
  });
  if (!attachmentResult.ok) {
    return {
      ok: false,
      status: "contract_attachment_error",
      message: attachmentResult.message,
    };
  }

  const ownerEmail = resolveOwnerEmail(context);
  if (!ownerEmail) {
    return {
      ok: false,
      status: "missing_owner_email",
      message:
        "Falta owner_email en el caso para enviar el contrato por email.",
    };
  }
  const externalContact = isRecord(opCase.external_contact_jsonb)
    ? opCase.external_contact_jsonb
    : {};
  const ownerName =
    resolveOwnerName(context) ||
    cleanString(externalContact.display_name) ||
    cleanString(externalContact.name);
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_email_send_attempted",
      channel: "email",
      owner_email: ownerEmail,
      doc_url: docUrl,
      attachment_name: attachmentResult.attachment.filename,
    },
  });
  const sent = await sendContractByEmail({
    db,
    userId: params.userId,
    caseId: opCase.id,
    context,
    ownerEmail,
    ownerName,
    docUrl,
    attachment: attachmentResult.attachment,
  });
  if (!sent.ok) {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_email_send_failed",
        channel: "email",
        owner_email: ownerEmail,
        status: sent.status,
        error_code: sent.errorCode ?? null,
        error_reason: sent.errorReason ?? null,
      },
    });
    return {
      ok: false,
      status: sent.status,
      message: sent.message,
    };
  }

  const shouldPauseAfterContractSent = settingsTestCase && !controlledE2ECase;
  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
    status: shouldPauseAfterContractSent ? "paused" : "active",
    currentStep: "photos_requested",
    nextActionAt: shouldPauseAfterContractSent ? null : new Date().toISOString(),
    context: {
      ...context,
      contract_draft: {
        ...(isRecord(context.contract_draft) ? context.contract_draft : {}),
        doc_url: docUrl,
      },
      contract_review: {
        status: "sent_by_email",
        approved_at: new Date().toISOString(),
        sent_channel: "email",
        sent_message_id: sent.messageId,
        owner_email: ownerEmail,
      },
      ...(shouldPauseAfterContractSent
        ? {
            controlled_test_status: "contract_sent_to_owner_email_and_advanced",
            controlled_test_note:
              "Contrato enviado por email al propietario en caso de prueba; flujo avanzado y detenido en paused para no mezclar settings con operación real.",
          }
        : {}),
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_approved_for_email_send",
      doc_url: docUrl,
      owner_email: ownerEmail,
      message_id: sent.messageId,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      purpose: "contract_sent_to_owner",
      channel: "email",
      doc_url: docUrl,
      owner_email: ownerEmail,
      message_id: sent.messageId,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "step_completed",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_sent_to_owner_email",
      advanced_to_step: "photos_requested",
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  const deferTick = controlledE2ECase && params.deferControlledE2ETick === true;
  if (controlledE2ECase && !deferTick) {
    void triggerControlledE2EAgentTick(db, updated, "contract_email_sent").catch(
      (tickError) => {
        console.error("[contract-review] e2e tick failed:", tickError);
      }
    );
  }

  return {
    ok: true,
    status: shouldPauseAfterContractSent ? "approved_send_simulated" : "approved_send",
    message: shouldPauseAfterContractSent
      ? "Contrato enviado por email (simulado) y flujo avanzado a photos_requested. El caso quedó en paused."
      : "Listo: envié el contrato por email al propietario y avancé el caso al siguiente paso.",
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick
      ? { source: "contract_email_sent" as const }
      : null,
  };
}

export async function handleContractRevisionUploadAndSend(
  db: DbClient,
  params: {
    userId: string;
    caseId: string;
    storagePath: string;
    storageBucket?: string;
    fileName?: string;
    deferControlledE2ETick?: boolean;
  }
) {
  const opCase = await getOperationalCase(db, params.caseId);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  const controlledE2ECase = isControlledE2EOperationalCase(opCase);
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const review = isRecord(context.contract_review) ? context.contract_review : {};
  if (review.status !== "awaiting_revision_upload") {
    return {
      ok: false,
      status: "not_waiting_revision_upload",
      message: "El caso no está esperando un contrato corregido.",
    };
  }

  const mergedContext: Record<string, unknown> = {
    ...context,
    contract_draft: {
      ...(isRecord(context.contract_draft) ? context.contract_draft : {}),
      output_path: params.storagePath,
      output_bucket: params.storageBucket ?? "case-documents",
      source: "advisor_revision_upload",
      original_name: params.fileName ?? null,
    },
  };

  const docUrl = await resolveContractDocUrl(db, opCase.id, mergedContext);
  if (!docUrl) {
    return {
      ok: false,
      status: "missing_doc_url",
      message: "No pude resolver el enlace del contrato corregido.",
    };
  }
  const attachmentResult = await loadContractAttachment({
    db,
    opCase,
    storagePath: params.storagePath,
    storageBucket: params.storageBucket ?? "case-documents",
    originalName: params.fileName ?? null,
  });
  if (!attachmentResult.ok) {
    return {
      ok: false,
      status: "contract_attachment_error",
      message: attachmentResult.message,
    };
  }

  const ownerEmail = resolveOwnerEmail(mergedContext);
  if (!ownerEmail) {
    return {
      ok: false,
      status: "missing_owner_email",
      message: "Falta owner_email para enviar el contrato corregido.",
    };
  }

  const externalContact = isRecord(opCase.external_contact_jsonb)
    ? opCase.external_contact_jsonb
    : {};
  const ownerName =
    resolveOwnerName(mergedContext) ||
    cleanString(externalContact.display_name) ||
    cleanString(externalContact.name);
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_email_send_attempted",
      channel: "email",
      owner_email: ownerEmail,
      doc_url: docUrl,
      attachment_name: attachmentResult.attachment.filename,
      from_revision_upload: true,
    },
  });
  const sent = await sendContractByEmail({
    db,
    userId: params.userId,
    caseId: opCase.id,
    context: mergedContext,
    ownerEmail,
    ownerName,
    docUrl,
    attachment: attachmentResult.attachment,
  });
  if (!sent.ok) {
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: "contract_pending",
      payload: {
        kind: "contract_email_send_failed",
        channel: "email",
        owner_email: ownerEmail,
        status: sent.status,
        error_code: sent.errorCode ?? null,
        error_reason: sent.errorReason ?? null,
        from_revision_upload: true,
      },
    });
    return {
      ok: false,
      status: sent.status,
      message: sent.message,
    };
  }

  const settingsTestCase = isSettingsTestCase(mergedContext);
  const shouldPauseAfterContractSent = settingsTestCase && !controlledE2ECase;
  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
    status: shouldPauseAfterContractSent ? "paused" : "active",
    currentStep: "photos_requested",
    nextActionAt: shouldPauseAfterContractSent ? null : new Date().toISOString(),
    context: {
      ...mergedContext,
      contract_review: {
        ...(isRecord(mergedContext.contract_review)
          ? mergedContext.contract_review
          : {}),
        status: "sent_by_email",
        sent_channel: "email",
        sent_message_id: sent.messageId,
        sent_after_revision_upload: true,
        owner_email: ownerEmail,
      },
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId: opCase.id,
    kind: "contract_revision_upload",
    status: "actioned",
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_revised_uploaded_and_sent",
      owner_email: ownerEmail,
      doc_url: docUrl,
      message_id: sent.messageId,
      storage_path: params.storagePath,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      purpose: "contract_sent_to_owner",
      channel: "email",
      owner_email: ownerEmail,
      doc_url: docUrl,
      message_id: sent.messageId,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "step_completed",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_sent_to_owner_email",
      advanced_to_step: "photos_requested",
      from_revision_upload: true,
    },
  });
  const deferTick = controlledE2ECase && params.deferControlledE2ETick === true;
  if (controlledE2ECase && !deferTick) {
    void triggerControlledE2EAgentTick(db, updated, "contract_revision_uploaded_and_sent").catch(
      (tickError) => {
        console.error("[contract-review] e2e tick failed:", tickError);
      }
    );
  }

  return {
    ok: true,
    status: "revision_uploaded_and_sent",
    message:
      "Contrato corregido recibido y enviado por email al propietario. Avancé el caso al siguiente paso.",
    ownerEmail,
    case_id: opCase.id,
    deferredControlledE2ETick: deferTick
      ? { source: "contract_revision_uploaded_and_sent" as const }
      : null,
  };
}
