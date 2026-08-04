/**
 * Contrato único de acciones HITL de negocio (asesor interno).
 * Web y Telegram renderizan desde aquí; los handlers compartidos consumen
 * los mismos action ids canónicos.
 */
import {
  contractDataReviewBooleanButtonLabels,
  resolveSingleRequiredBooleanField,
} from "@/lib/notify/contract-data-review-telegram-markup";
import type {
  HitlTelegramKeyboardButton,
  HitlTelegramReplyMarkup,
} from "@/lib/notify/hitl-telegram-markup";
import { UPLOAD_BATCH_DONE_CALLBACK_PREFIX } from "./upload-batch-shared";

export type HitlActionVariant = "primary" | "secondary" | "danger";

export type HitlActionDef = {
  id: string;
  label: string;
  variant?: HitlActionVariant;
  acceptsNotes?: boolean;
  notesPlaceholder?: string;
  defaultNotes?: string;
  requiresNotes?: boolean;
  body?: Record<string, unknown>;
  /**
   * Prefijo de callback Telegram (`prefix:notificationId`).
   * Upload batch usa caseId vía `telegramUsesCaseId`.
   */
  telegramCallbackPrefix?: string;
  /** Prefijos legacy aceptados por el webhook (in-flight notifications). */
  telegramCallbackAliases?: string[];
  /** Frase canónica para texto libre / parsers. */
  freeText?: string;
  telegramUsesCaseId?: boolean;
};

/** Kinds con botones/adjunto en timeline; dedupe mirror por kind+caso. */
export const HITL_MIRROR_KINDS = new Set([
  "contract_review",
  "price_approval",
  "property_data_review",
  "contract_data_review",
  "listing_description_review",
  "easybroker_publish_approval",
  "ungga_publish_approval",
  "publication_review_required",
  "titularidad_review",
  "photos_upload_requested",
  "documents_upload_requested",
  "comparables_search_expansion_decision",
]);

const UPLOAD_BATCH_KINDS = new Set([
  "photos_upload_requested",
  "documents_upload_requested",
]);

/** Límite duro de Telegram para callback_data de botones inline. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export function isUploadBatchHitlKind(kind: string | undefined): boolean {
  return Boolean(kind && UPLOAD_BATCH_KINDS.has(kind));
}

function publishDestinationLabel(kind: string | undefined): string {
  if (kind === "easybroker_publish_approval") return "EasyBroker";
  if (kind === "ungga_publish_approval") return "Ungga";
  return "destino";
}

export function hitlEndpointForKind(kind: string): string | null {
  switch (kind) {
    case "price_approval":
      return "/api/business-decisions/price-approval";
    case "property_data_review":
      return "/api/business-decisions/property-data-review";
    case "contract_review":
    case "contract_pending":
      return "/api/business-decisions/contract-review";
    case "contract_data_review":
      return "/api/business-decisions/contract-data-review";
    case "listing_description_review":
      return "/api/business-decisions/listing-description-review";
    case "easybroker_publish_approval":
    case "ungga_publish_approval":
      return "/api/business-decisions/publish-destination-approval";
    case "publication_review_required":
      return "/api/business-decisions/publication-review";
    case "titularidad_review":
      return "/api/business-decisions/titularidad-review";
    case "photos_upload_requested":
    case "documents_upload_requested":
      return "/api/business-decisions/upload-batch-complete";
    case "comparables_search_expansion_decision":
      return "/api/business-decisions/comparables-expansion-decision";
    default:
      return null;
  }
}

/**
 * Acciones canónicas por kind. Labels y semantics son channel-agnostic;
 * cada canal solo adapta el render.
 */
export function buildHitlActionsForKind(
  kind: string | undefined,
  data?: Record<string, unknown>
): HitlActionDef[] {
  if (!kind) return [];

  if (kind === "contract_review" || kind === "contract_pending") {
    return [
      {
        id: "approve_send",
        label: "Enviar por email",
        variant: "primary",
        telegramCallbackPrefix: "contract_email",
        freeText: "enviar por email",
      },
      {
        id: "request_changes",
        label: "Subir contrato corregido y enviar",
        variant: "secondary",
        acceptsNotes: true,
        notesPlaceholder: "Opcional: comentario para la versión corregida",
        defaultNotes: "subir contrato corregido y enviar",
        telegramCallbackPrefix: "contract_upload",
        telegramCallbackAliases: ["contract_upload_adjusted_send"],
        freeText: "subir contrato corregido y enviar",
      },
    ];
  }

  if (kind === "price_approval") {
    return [
      {
        id: "approve",
        label: "Aprobar precio",
        variant: "primary",
        telegramCallbackPrefix: "price_approve",
        freeText: "aprobar precio",
      },
      {
        id: "adjust",
        label: "Ajustar",
        variant: "secondary",
        acceptsNotes: true,
        requiresNotes: true,
        notesPlaceholder:
          "Ej. AJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000",
        telegramCallbackPrefix: "price_adjust",
        freeText: "ajustar precio",
      },
    ];
  }

  if (kind === "property_data_review") {
    return [
      {
        id: "confirm",
        label: "Confirmar datos",
        variant: "primary",
        telegramCallbackPrefix: "property_data_confirm",
        freeText: "confirmar datos",
      },
      {
        id: "adjust",
        label: "Ajustar",
        variant: "secondary",
        acceptsNotes: true,
        requiresNotes: true,
        notesPlaceholder: "Indica qué dato corregir",
        telegramCallbackPrefix: "property_data_correct",
        freeText: "ajustar datos",
      },
    ];
  }

  if (kind === "listing_description_review") {
    return [
      {
        id: "approve",
        label: "Aprobar descripción",
        variant: "primary",
        telegramCallbackPrefix: "ld_approve",
        freeText: "aprobar descripcion",
      },
      {
        id: "request_changes",
        label: "Pedir cambios",
        variant: "secondary",
        acceptsNotes: true,
        notesPlaceholder:
          "Opcional: cambios concretos, o vacío para regenerar el borrador",
        defaultNotes: "Continuar: generar o regenerar el borrador comercial.",
        telegramCallbackPrefix: "ld_changes",
        freeText: "pedir cambios",
      },
    ];
  }

  if (
    kind === "easybroker_publish_approval" ||
    kind === "ungga_publish_approval"
  ) {
    const dest = publishDestinationLabel(kind);
    return [
      {
        id: "approve",
        label: `Publicar en ${dest}`,
        variant: "primary",
        telegramCallbackPrefix: "pub_approve",
        freeText: "publicar",
      },
      {
        id: "skip",
        label: `Omitir ${dest}`,
        variant: "secondary",
        telegramCallbackPrefix: "pub_skip",
        freeText: "omitir",
      },
      {
        id: "reject",
        label: "Pausar publicación",
        variant: "danger",
        telegramCallbackPrefix: "pub_reject",
        freeText: "pausar publicacion",
      },
    ];
  }

  if (kind === "publication_review_required") {
    const credentialFailure = data?.credential_failure === true;
    const prepareDraftFailure =
      data?.prepare_draft_failure === true || data?.safe_retry_prepare === true;
    return [
      {
        id: "approve_continue",
        label: credentialFailure
          ? "Ya actualicé la API key — reintentar"
          : prepareDraftFailure
            ? "Reintentar publicación en Ungga"
            : "Aprobar y continuar",
        variant: "primary",
        telegramCallbackPrefix: "pubrev_approve",
        freeText: "aprobar y continuar",
      },
      {
        id: "stop",
        label: credentialFailure
          ? "Pausar publicación"
          : prepareDraftFailure
            ? "Pausar y avisar a soporte"
            : "Detener y revisar",
        variant: "danger",
        telegramCallbackPrefix: "pubrev_stop",
        freeText: "detener y revisar",
      },
    ];
  }

  if (kind === "titularidad_review") {
    return [
      {
        id: "request_external_evidence",
        label: "Solicitar evidencia al propietario",
        variant: "primary",
        // Prefijo corto: `prefix:uuid` debe caber en los 64 bytes de
        // callback_data de Telegram (el prefijo largo daba 65 y Telegram
        // rechazaba el mensaje completo con BUTTON_DATA_INVALID).
        telegramCallbackPrefix: "tit_req_ext",
        telegramCallbackAliases: ["titularidad_request_external"],
        freeText: "solicitar evidencia al propietario",
      },
      {
        id: "request_internal_docs",
        label: "Yo subiré/corregiré documentos",
        variant: "secondary",
        telegramCallbackPrefix: "tit_req_int",
        telegramCallbackAliases: ["titularidad_request_internal"],
        freeText: "yo subire documentos",
      },
      {
        id: "continue_override",
        label: "Continuar bajo excepción",
        variant: "danger",
        acceptsNotes: true,
        requiresNotes: true,
        notesPlaceholder:
          "Motivo obligatorio de la excepción (qué revisaste y por qué continúas)",
        telegramCallbackPrefix: "titularidad_continue",
        telegramCallbackAliases: ["titularidad_approve"],
        freeText: "continuar bajo excepcion",
      },
    ];
  }

  if (UPLOAD_BATCH_KINDS.has(kind)) {
    return [
      {
        id: "upload_done",
        label: "Terminé de subir",
        variant: "primary",
        telegramCallbackPrefix: UPLOAD_BATCH_DONE_CALLBACK_PREFIX.replace(
          /:$/,
          ""
        ),
        telegramUsesCaseId: true,
        freeText: "listo",
      },
    ];
  }

  if (kind === "comparables_search_expansion_decision") {
    return [
      {
        id: "use_current_comparables",
        label: "1) Muestra actual",
        variant: "primary",
        telegramCallbackPrefix: "comp_current",
        freeText: "1",
      },
      {
        id: "use_avaclick_primary",
        label: "2) Avaclick base",
        variant: "secondary",
        telegramCallbackPrefix: "comp_avaclick",
        freeText: "2",
      },
      {
        id: "expand_search",
        label: "3) Ampliar búsqueda",
        variant: "secondary",
        telegramCallbackPrefix: "comp_expand",
        freeText: "3",
      },
    ];
  }

  if (kind === "contract_data_review") {
    const singleBoolean = resolveSingleRequiredBooleanField(
      data?.missing_fields
    );
    if (!singleBoolean) return [];
    const labels = contractDataReviewBooleanButtonLabels(singleBoolean.key);
    return [
      {
        id: "cdr_yes",
        label: labels.yes,
        variant: "primary",
        body: { patch: { [singleBoolean.key]: true } },
        telegramCallbackPrefix: "cdr_yes",
      },
      {
        id: "cdr_no",
        label: labels.no,
        variant: "secondary",
        body: { patch: { [singleBoolean.key]: false } },
        telegramCallbackPrefix: "cdr_no",
      },
    ];
  }

  return [];
}

function matchHitlActionByTelegramPrefix(
  actions: HitlActionDef[],
  callbackAction: string
): HitlActionDef | null {
  const needle = callbackAction.trim();
  if (!needle) return null;
  // Solo prefijos/aliases de Telegram — NUNCA action.id suelto
  // (`approve` colisionaría con tool-confirmation y price_approval).
  return (
    actions.find(
      (action) =>
        action.telegramCallbackPrefix === needle ||
        action.telegramCallbackAliases?.includes(needle)
    ) ?? null
  );
}

export function resolveHitlActionByTelegramCallback(params: {
  kind: string;
  callbackAction: string;
  data?: Record<string, unknown>;
}): HitlActionDef | null {
  return matchHitlActionByTelegramPrefix(
    buildHitlActionsForKind(params.kind, params.data),
    params.callbackAction
  );
}

/**
 * Resuelve un prefijo de callback Telegram (`comp_current`, `titularidad_continue`…)
 * al kind + action canónicos sin que el webhook hardcodee strings por decisión.
 */
export function resolveTelegramHitlCallback(params: {
  callbackAction: string;
  data?: Record<string, unknown>;
  /** Si se conoce el kind (p. ej. desde la notification), se busca primero ahí. */
  preferredKind?: string | null;
}): { kind: string; action: HitlActionDef } | null {
  const needle = params.callbackAction.trim();
  if (!needle) return null;

  const preferred =
    typeof params.preferredKind === "string" && params.preferredKind.trim()
      ? params.preferredKind.trim()
      : null;
  if (preferred) {
    const action = resolveHitlActionByTelegramCallback({
      kind: preferred,
      callbackAction: needle,
      data: params.data,
    });
    if (action) return { kind: preferred, action };
  }

  for (const kind of HITL_MIRROR_KINDS) {
    if (kind === preferred) continue;
    // contract_data_review / publication_review dependen de data para labels,
    // pero sus prefijos son estables; pasar data cuando exista.
    const action = resolveHitlActionByTelegramCallback({
      kind,
      callbackAction: needle,
      data: params.data,
    });
    if (action) return { kind, action };
  }
  return null;
}

export function buildTelegramInlineKeyboardForKind(params: {
  kind: string | undefined;
  notificationId: string;
  data?: Record<string, unknown>;
  caseId?: string | null;
}): HitlTelegramReplyMarkup | undefined {
  const kind = params.kind?.trim();
  if (!kind || !params.notificationId.trim()) return undefined;
  const actions = buildHitlActionsForKind(kind, params.data);
  if (actions.length === 0) return undefined;

  const rows: HitlTelegramKeyboardButton[][] = [];
  for (const action of actions) {
    const prefix = action.telegramCallbackPrefix?.trim();
    if (!prefix) continue;
    const targetId = action.telegramUsesCaseId
      ? (params.caseId ?? "").trim()
      : params.notificationId.trim();
    if (!targetId) continue;
    const callbackData = `${prefix}:${targetId}`;
    // Telegram rechaza el MENSAJE COMPLETO si un callback_data excede 64
    // bytes (BUTTON_DATA_INVALID); mejor omitir el botón que perder todos.
    if (Buffer.byteLength(callbackData, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
      console.warn(
        `[hitl-action-contract] callback_data supera ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes; botón omitido: ${callbackData}`
      );
      continue;
    }
    rows.push([
      {
        text: action.label,
        callback_data: callbackData,
      },
    ]);
  }
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

/** Action ids canónicos por kind (para selftests de paridad). */
export function hitlActionIdsForKind(
  kind: string,
  data?: Record<string, unknown>
): string[] {
  return buildHitlActionsForKind(kind, data).map((action) => action.id);
}
