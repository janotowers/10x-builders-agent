/**
 * Preflight condicional común para EasyBroker y Ungga.
 * pass → publicar automáticamente
 * waiting → reintentar más tarde (p. ej. imágenes asíncronas)
 * review_required → HITL condicional
 * blocked → error no recuperable sin intervención
 */

import type {
  PublicationDestination,
  PublicationState,
} from "@/lib/operational-cases/publication-workflow";

export type PreflightSeverity = "info" | "warning" | "critical";

export type PreflightIssue = {
  code: string;
  field: string;
  expected?: unknown;
  actual?: unknown;
  severity: PreflightSeverity;
  confidence?: number;
  message: string;
};

export type PreflightResultStatus =
  | "pass"
  | "waiting"
  | "review_required"
  | "blocked";

export type PreflightResult = {
  status: PreflightResultStatus;
  issues: PreflightIssue[];
  summary: string;
};

export type PhotoManifestEntry = {
  source_path: string;
  sha256?: string | null;
  sequence: number;
  space_label?: string | null;
  confidence?: number | null;
  uncertain?: boolean;
  watermarked_path?: string | null;
  public_url?: string | null;
  title?: string | null;
};

export type PublicationPreflightInput = {
  destination: PublicationDestination;
  publication: PublicationState;
  context: Record<string, unknown>;
  photoManifest?: PhotoManifestEntry[];
  remote?: {
    status?: string | null;
    image_count?: number | null;
    images_ready?: boolean | null;
    listing_id?: string | null;
    ungga_property_id?: string | null;
    dry_run?: boolean;
    fields?: Record<string, unknown>;
  };
  options?: {
    labelConfidenceThreshold?: number;
    requireWatermark?: boolean;
    contractRequired?: boolean;
  };
};

const DEFAULT_LABEL_CONFIDENCE = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushIssue(
  issues: PreflightIssue[],
  issue: PreflightIssue
): void {
  issues.push(issue);
}

function resolvePhotoManifest(
  context: Record<string, unknown>,
  explicit?: PhotoManifestEntry[]
): PhotoManifestEntry[] {
  if (explicit && explicit.length > 0) return explicit;
  if (!Array.isArray(context.photo_manifest)) return [];
  const out: PhotoManifestEntry[] = [];
  for (const [index, item] of context.photo_manifest.entries()) {
    if (!isRecord(item)) continue;
    const sourcePath =
      typeof item.source_path === "string" ? item.source_path.trim() : "";
    if (!sourcePath) continue;
    out.push({
      source_path: sourcePath,
      sha256: typeof item.sha256 === "string" ? item.sha256 : null,
      sequence:
        typeof item.sequence === "number" ? item.sequence : index,
      space_label:
        typeof item.space_label === "string" ? item.space_label : null,
      confidence:
        typeof item.confidence === "number" ? item.confidence : null,
      uncertain: item.uncertain === true,
      watermarked_path:
        typeof item.watermarked_path === "string"
          ? item.watermarked_path
          : null,
      public_url:
        typeof item.public_url === "string" ? item.public_url : null,
      title: typeof item.title === "string" ? item.title : null,
    });
  }
  return out;
}

function countRawPhotos(context: Record<string, unknown>): number {
  return Array.isArray(context.raw_photos) ? context.raw_photos.length : 0;
}

function hasApprovedDescription(context: Record<string, unknown>): boolean {
  return (
    context.listing_description_approved === true ||
    isRecord(context.listing_description_approved)
  );
}

function hasApprovedPricing(context: Record<string, unknown>): boolean {
  const pricing = isRecord(context.pricing_proposal)
    ? context.pricing_proposal
    : {};
  const status =
    typeof pricing.approval_status === "string"
      ? pricing.approval_status.toLowerCase()
      : "";
  return status === "approved" || context.pricing_approved === true;
}

function contractSent(context: Record<string, unknown>): boolean {
  const review = isRecord(context.contract_review)
    ? context.contract_review
    : {};
  return (
    review.status === "sent_by_email" ||
    review.sent_by_email === true ||
    context.contract_sent_to_owner_email === true
  );
}

/**
 * Destination-specific commercial mapping issues.
 * Warnings for omitted optional detail; review_required only when a required
 * destination representation is impossible without override.
 */
function evaluateDestinationCommercialMapping(
  input: PublicationPreflightInput,
  issues: PreflightIssue[]
): void {
  const termsRaw = input.context.commission_terms;
  if (!isRecord(termsRaw)) return;
  const collaboration = isRecord(termsRaw.collaboration)
    ? termsRaw.collaboration
    : null;
  if (!collaboration || collaboration.enabled !== true) return;

  const compensation = isRecord(collaboration.compensation)
    ? collaboration.compensation
    : {};
  const mode =
    typeof compensation.mode === "string" ? compensation.mode : "not_specified";
  const value =
    typeof compensation.value === "number" && Number.isFinite(compensation.value)
      ? compensation.value
      : null;

  const destinations = isRecord(input.context.publication)
    ? isRecord(input.context.publication.destinations)
      ? input.context.publication.destinations
      : null
    : null;
  const destinationValue = destinations?.[input.destination];
  const destState: Record<string, unknown> | null = isRecord(destinationValue)
    ? destinationValue
    : null;
  const hasOverride =
    destState != null && isRecord(destState.commercial_override);

  if (input.destination === "easybroker") {
    if (
      mode === "percentage_of_total_commission" &&
      value != null &&
      value !== 50
    ) {
      pushIssue(issues, {
        code: "easybroker_shared_commission_detail_omitted",
        field: "commission_terms.collaboration.compensation",
        severity: "warning",
        expected: 50,
        actual: value,
        message:
          "EasyBroker no representa ese porcentaje compartido; se enviará share_commission=true sin detalle.",
      });
    } else if (
      mode === "percentage_of_sale_price" ||
      mode === "fixed_amount"
    ) {
      pushIssue(issues, {
        code: "easybroker_shared_commission_detail_omitted",
        field: "commission_terms.collaboration.compensation",
        severity: "warning",
        actual: { mode, value },
        message:
          "El detalle de compensación canónico no mapea a EasyBroker; se omite el porcentaje.",
      });
    }
  } else if (input.destination === "ungga") {
    if (mode !== "not_specified" && mode !== "negotiable") {
      pushIssue(issues, {
        code: "ungga_shared_commission_detail_omitted",
        field: "commission_terms.collaboration.compensation",
        severity: "warning",
        actual: { mode, value },
        message:
          "Ungga no expone un campo estable para el detalle de comisión compartida.",
      });
    }
  }

  // review_required only when destination explicitly needs an override that is missing.
  if (
    isRecord(destState) &&
    destState.requires_commercial_override === true &&
    !hasOverride
  ) {
    pushIssue(issues, {
      code: "destination_commercial_override_required",
      field: `publication.destinations.${input.destination}.commercial_override`,
      severity: "critical",
      message:
        "Este destino exige un commercial_override explícito que aún no está registrado.",
    });
  }
}

function evaluateCommon(
  input: PublicationPreflightInput,
  issues: PreflightIssue[]
): void {
  const { context } = input;
  const threshold =
    input.options?.labelConfidenceThreshold ?? DEFAULT_LABEL_CONFIDENCE;
  const requireContract = input.options?.contractRequired !== false;

  evaluateDestinationCommercialMapping(input, issues);

  if (!hasApprovedDescription(context)) {
    pushIssue(issues, {
      code: "description_not_approved",
      field: "listing_description_approved",
      severity: "critical",
      expected: true,
      actual: context.listing_description_approved ?? null,
      message: "La descripción comercial aún no está aprobada.",
    });
  }

  if (!hasApprovedPricing(context)) {
    pushIssue(issues, {
      code: "pricing_not_approved",
      field: "pricing_proposal.approval_status",
      severity: "critical",
      expected: "approved",
      actual: isRecord(context.pricing_proposal)
        ? context.pricing_proposal.approval_status
        : null,
      message: "El precio aún no está aprobado.",
    });
  }

  if (requireContract && !contractSent(context)) {
    pushIssue(issues, {
      code: "contract_not_sent",
      field: "contract_review.status",
      severity: "critical",
      expected: "sent_by_email",
      actual: isRecord(context.contract_review)
        ? context.contract_review.status
        : null,
      message: "El contrato aún no se envió por email al propietario.",
    });
  }

  const manifest = resolvePhotoManifest(context, input.photoManifest);
  const rawCount = countRawPhotos(context);
  if (rawCount > 0 && manifest.length === 0) {
    pushIssue(issues, {
      code: "photo_manifest_missing",
      field: "photo_manifest",
      severity: "critical",
      expected: rawCount,
      actual: 0,
      message:
        "Hay fotos en el caso pero no existe photo_manifest por archivo.",
    });
  } else if (rawCount > 0 && manifest.length !== rawCount) {
    pushIssue(issues, {
      code: "photo_manifest_count_mismatch",
      field: "photo_manifest",
      severity: "critical",
      expected: rawCount,
      actual: manifest.length,
      message: "El manifest de fotos no coincide 1:1 con raw_photos.",
    });
  }

  const labelCounts = new Map<string, number>();
  for (const entry of manifest) {
    if (entry.uncertain || (entry.confidence ?? 1) < threshold) {
      pushIssue(issues, {
        code: "photo_label_low_confidence",
        field: entry.source_path,
        severity: "critical",
        confidence: entry.confidence ?? undefined,
        expected: `confidence >= ${threshold}`,
        actual: entry.confidence ?? null,
        message: `Etiqueta de foto con baja confianza: ${entry.space_label ?? "sin etiqueta"}.`,
      });
    }
    if (!entry.space_label?.trim()) {
      pushIssue(issues, {
        code: "photo_label_missing",
        field: entry.source_path,
        severity: "critical",
        message: "Falta space_label en una foto del manifest.",
      });
    } else {
      const key = entry.space_label.trim().toLowerCase();
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }
    if (input.options?.requireWatermark && !entry.watermarked_path) {
      pushIssue(issues, {
        code: "watermark_missing",
        field: entry.source_path,
        severity: "critical",
        message: "Falta watermark en una foto del manifest.",
      });
    }
    if (entry.public_url && entry.public_url.length > 255) {
      pushIssue(issues, {
        code: "public_url_too_long",
        field: entry.source_path,
        severity: "critical",
        expected: "<=255",
        actual: entry.public_url.length,
        message: "La URL pública de la imagen supera 255 caracteres.",
      });
    }
  }

  for (const [label, count] of labelCounts) {
    if (count > 2 && (label === "fachada" || label === "cocina")) {
      pushIssue(issues, {
        code: "photo_label_suspicious_duplicates",
        field: "photo_manifest.space_label",
        severity: "warning",
        expected: "<=2",
        actual: count,
        message: `Muchas fotos etiquetadas como "${label}" (${count}).`,
      });
    }
  }

  const dest = input.publication.destinations[input.destination];
  if (dest.phase === "unknown_outcome") {
    pushIssue(issues, {
      code: "unknown_external_outcome",
      field: "publication.phase",
      severity: "critical",
      actual: dest.phase,
      message:
        "Hay una operación externa con resultado desconocido; no se puede auto-publicar.",
    });
  }
}

function evaluateEasyBroker(
  input: PublicationPreflightInput,
  issues: PreflightIssue[]
): void {
  const dest = input.publication.destinations.easybroker;
  if (!dest.artifact.listing_id && !input.remote?.listing_id) {
    pushIssue(issues, {
      code: "easybroker_listing_missing",
      field: "artifact.listing_id",
      severity: "critical",
      message: "No hay listing_id de EasyBroker para validar.",
    });
  }

  if (dest.media.required) {
    if (!dest.media.submitted) {
      pushIssue(issues, {
        code: "easybroker_images_not_submitted",
        field: "media.submitted",
        severity: "critical",
        message: "Las imágenes aún no se enviaron a EasyBroker.",
      });
    } else if (!dest.media.verified) {
      if (input.remote?.images_ready === false) {
        pushIssue(issues, {
          code: "easybroker_images_processing",
          field: "remote.images_ready",
          severity: "warning",
          message: "EasyBroker aún procesa las imágenes de forma asíncrona.",
        });
      } else if (
        typeof input.remote?.image_count === "number" &&
        input.remote.image_count < dest.media.expected_count
      ) {
        pushIssue(issues, {
          code: "easybroker_image_count_mismatch",
          field: "remote.image_count",
          severity: "warning",
          expected: dest.media.expected_count,
          actual: input.remote.image_count,
          message: "El conteo remoto de imágenes aún no coincide.",
        });
      } else if (input.remote?.images_ready !== true) {
        pushIssue(issues, {
          code: "easybroker_images_awaiting_verification",
          field: "media.verified",
          severity: "warning",
          message: "Esperando verificación remota de imágenes en EasyBroker.",
        });
      }
    }
  }

  const remoteStatus =
    input.remote?.status ?? dest.artifact.remote_status ?? null;
  if (remoteStatus === "published") {
    pushIssue(issues, {
      code: "easybroker_already_published",
      field: "remote.status",
      severity: "info",
      actual: remoteStatus,
      message: "EasyBroker ya figura como published.",
    });
  }
}

function evaluateUngga(
  input: PublicationPreflightInput,
  issues: PreflightIssue[]
): void {
  const dest = input.publication.destinations.ungga;
  const propertyId =
    dest.artifact.ungga_property_id ?? input.remote?.ungga_property_id ?? null;
  if (!propertyId) {
    pushIssue(issues, {
      code: "ungga_draft_missing",
      field: "artifact.ungga_property_id",
      severity: "critical",
      message: "No hay GU-ID de borrador Ungga para publicar.",
    });
  }

  if (input.remote?.dry_run === true) {
    pushIssue(issues, {
      code: "ungga_dry_run_not_persisted",
      field: "remote.dry_run",
      severity: "critical",
      message:
        "El CLI de Ungga corrió en dry-run; no se puede marcar draft listo ni publicar.",
    });
  }

  if (dest.media.required) {
    const manifest = resolvePhotoManifest(input.context, input.photoManifest);
    const withUrl = manifest.filter((item) => item.public_url);
    if (manifest.length > 0 && withUrl.length === 0) {
      pushIssue(issues, {
        code: "ungga_image_urls_missing",
        field: "photo_manifest.public_url",
        severity: "critical",
        message:
          "Ungga requiere URLs públicas del manifest; ninguna está disponible.",
      });
    }
    const expected =
      dest.media.expected_count > 0 ? dest.media.expected_count : manifest.length;
    if (expected > 0) {
      if (!dest.media.submitted) {
        pushIssue(issues, {
          code: "ungga_media_not_submitted",
          field: "media.submitted",
          severity: "critical",
          message:
            "Las fotos de Ungga aún no fueron confirmadas tras prepare_draft.",
        });
      }
      const remoteCount =
        typeof input.remote?.image_count === "number"
          ? input.remote.image_count
          : dest.media.remote_count;
      if (!dest.media.verified) {
        pushIssue(issues, {
          code: "ungga_media_not_verified",
          field: "media.verified",
          severity: "critical",
          expected,
          actual: remoteCount,
          message: `Ungga no verificó las ${expected} fotos esperadas antes de publicar.`,
        });
      } else if (
        typeof remoteCount === "number" &&
        remoteCount > 0 &&
        remoteCount < expected
      ) {
        // Ungga often shows extra thumbs (cover + uploads); only fewer is a mismatch.
        pushIssue(issues, {
          code: "ungga_media_count_mismatch",
          field: "remote.image_count",
          severity: "critical",
          expected,
          actual: remoteCount,
          message: `Conteo de fotos Ungga inconsistente: esperadas ${expected}, remotas ${remoteCount}.`,
        });
      }
    }
  }
}

function finalize(issues: PreflightIssue[]): PreflightResult {
  const critical = issues.filter((i) => i.severity === "critical");
  const waiting = issues.filter(
    (i) =>
      i.severity === "warning" &&
      (i.code.includes("processing") ||
        i.code.includes("awaiting") ||
        i.code.includes("mismatch"))
  );

  if (critical.some((i) => i.code === "unknown_external_outcome")) {
    return {
      status: "blocked",
      issues,
      summary: "Operación externa con resultado desconocido.",
    };
  }

  if (critical.length > 0) {
    return {
      status: "review_required",
      issues,
      summary: critical.map((i) => i.message).slice(0, 3).join(" "),
    };
  }

  if (waiting.length > 0) {
    return {
      status: "waiting",
      issues,
      summary: waiting[0]?.message ?? "Esperando procesamiento remoto.",
    };
  }

  return {
    status: "pass",
    issues,
    summary: "Preflight OK; se puede publicar automáticamente.",
  };
}

export function runPublicationPreflight(
  input: PublicationPreflightInput
): PreflightResult {
  const issues: PreflightIssue[] = [];
  evaluateCommon(input, issues);
  if (input.destination === "easybroker") {
    evaluateEasyBroker(input, issues);
  } else {
    evaluateUngga(input, issues);
  }
  return finalize(issues);
}

/**
 * Detects auth/credential failures that the advisor can fix in
 * Settings → Cuentas externas (not a data/labels review).
 */
export function looksLikePublicationCredentialAuthFailure(
  error: string | null | undefined
): boolean {
  if (!error || !error.trim()) return false;
  const lower = error.toLowerCase();
  if (lower.includes("api key is invalid")) return true;
  if (lower.includes("credential_failure")) return true;
  if (lower.includes("your api key is invalid")) return true;
  if (/\b401\b/.test(lower) && /(invalid|unauthorized|forbidden)/.test(lower)) {
    return true;
  }
  if (/\b403\b/.test(lower) && /(invalid|unauthorized|forbidden|api key)/.test(lower)) {
    return true;
  }
  return false;
}

export function formatPublicationCredentialFailureNotifyText(
  destination: PublicationDestination
): string {
  const label = destination === "easybroker" ? "EasyBroker" : "Ungga";
  const settingsTarget =
    destination === "easybroker"
      ? "EasyBroker (API)"
      : "Ungga (API o CLI, según uses)";
  return [
    `No pude continuar la publicación en ${label}: la API key / credencial no es válida.`,
    "",
    `Esto suele pasar cuando la key se regeneró o rotó en ${label} y aún no se actualizó aquí.`,
    "",
    "Qué hacer:",
    `1. En ${label}, confirma o genera una credencial válida (cuenta con permisos de administrador si aplica).`,
    `2. En Ajustes → Cuentas externas → ${settingsTarget}, pega la key/credencial nueva y guarda (se probará sola).`,
    "3. Cuando aparezca Conectada, usa el botón de abajo para reintentar.",
    "",
    "Usa los botones:",
    "• Ya actualicé la API key — reintentar",
    "• Pausar publicación",
  ].join("\n");
}

export function formatPublicationReviewNotifyText(
  destination: PublicationDestination,
  result: PreflightResult,
  extras?: {
    last_step?: { step?: string; ok?: boolean; error?: string } | null;
    expected_image_count?: number | null;
    uploaded_image_count?: number | null;
    has_draft_artifact?: boolean;
    ungga_property_id?: string | null;
    credential_failure?: boolean;
  }
): string {
  const label = destination === "easybroker" ? "EasyBroker" : "Ungga";
  const credentialFailure =
    extras?.credential_failure === true ||
    looksLikePublicationCredentialAuthFailure(extras?.last_step?.error);
  if (credentialFailure) {
    return formatPublicationCredentialFailureNotifyText(destination);
  }
  const lines = [
    `Revisión requerida antes de publicar en ${label}`,
    "",
    result.summary,
    "",
    "Incidencias:",
  ];
  for (const issue of result.issues.filter((i) => i.severity !== "info").slice(0, 8)) {
    lines.push(`- [${issue.severity}] ${issue.message}`);
  }
  if (extras?.last_step && typeof extras.last_step.step === "string") {
    lines.push(
      "",
      `Último paso: ${extras.last_step.step}${
        extras.last_step.ok === false ? " (falló)" : ""
      }${
        typeof extras.last_step.error === "string" && extras.last_step.error
          ? ` — ${extras.last_step.error}`
          : ""
      }`
    );
  }
  if (
    typeof extras?.expected_image_count === "number" ||
    typeof extras?.uploaded_image_count === "number"
  ) {
    lines.push(
      `Fotos: esperadas ${extras.expected_image_count ?? "?"}, observadas ${
        extras.uploaded_image_count ?? "?"
      }.`
    );
  }
  if (extras?.has_draft_artifact || extras?.ungga_property_id) {
    lines.push(
      "",
      extras.ungga_property_id
        ? `Ya existe un borrador (${extras.ungga_property_id}). No recrees: verifica en Ungga y reconcilia.`
        : "Puede existir un borrador remoto. Verifica en Ungga antes de reintentar create."
    );
  }
  lines.push(
    "",
    "Usa los botones:",
    extras?.has_draft_artifact || extras?.ungga_property_id
      ? "- Aprobar y continuar (solo si confirmaste el borrador existente; no recreará si ya hay GU-ID)"
      : "- Aprobar y continuar (autoriza reintento de create si no hay artifact)",
    "- Corregir etiquetas/datos",
    "- Detener y revisar"
  );
  return lines.join("\n");
}
