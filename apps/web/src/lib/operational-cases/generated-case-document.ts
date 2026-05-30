/**
 * Patrón reutilizable: documento generado desde plantilla DOCX (generate_document_from_template).
 * Persistir output_path en context_jsonb + proxy de descarga estable (sin signed_url larga en mensajes).
 *
 * Cada caso de uso declara un `GeneratedCaseDocumentBinding` (clave de contexto, segmento URL, evento opcional).
 */

import path from "node:path";
import {
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { buildExternalCaseDocumentDownloadUrl } from "./case-document-download-token";
import type { OperationalCase } from "@agents/types";

export const GENERATED_DOCUMENT_BUCKET = "account-assets";

/** Firma directa de Storage (respaldo); el flujo principal usa proxy de la app. */
export const GENERATED_CASE_DOCUMENT_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export type GeneratedCaseDocumentRef = {
  template_slug?: string;
  output_bucket?: string;
  output_path?: string;
  doc_url?: string;
  download_label?: string;
  generated_at?: string;
};

/** Configuración por artefacto (contrato, ficha comercial, etc.). */
export type GeneratedCaseDocumentBinding = {
  /** Clave en context_jsonb, p. ej. contract_draft */
  contextKey: string;
  /** Segmento en /api/operational-cases/:caseId/documents/:documentKey/download */
  documentKey: string;
  defaultTemplateSlug?: string;
  defaultDownloadLabel: string;
  /** Si se define, sync inserta human_decision cuando aún no existe */
  draftedEventKind?: string;
  draftedEventSource?: string;
};

export const CONTRACT_DRAFT_DOCUMENT_BINDING: GeneratedCaseDocumentBinding = {
  contextKey: "contract_draft",
  documentKey: "contract_draft",
  defaultTemplateSlug: "commission_contract",
  defaultDownloadLabel: "Descargar borrador del contrato",
  draftedEventKind: "contract_drafted",
  draftedEventSource: "generated_case_document_sync",
};

/** Registro para notify / rutas; añadir bindings al incorporar nuevos pasos. */
export const GENERATED_CASE_DOCUMENT_BINDINGS: Record<
  string,
  GeneratedCaseDocumentBinding
> = {
  [CONTRACT_DRAFT_DOCUMENT_BINDING.documentKey]: CONTRACT_DRAFT_DOCUMENT_BINDING,
};

export function generatedCaseDocumentBindingForNotifyKind(
  kind?: string
): GeneratedCaseDocumentBinding | null {
  if (kind === "contract_review") return CONTRACT_DRAFT_DOCUMENT_BINDING;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function siteBaseUrl() {
  const vercel = process.env.VERCEL_URL?.trim();
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    process.env.APP_URL,
    process.env.NGROK_URL,
    vercel ? `https://${vercel.replace(/^https?:\/\//i, "")}` : undefined,
  ];
  for (const raw of candidates) {
    const base = raw?.trim();
    if (base) return base.replace(/\/$/, "");
  }
  return "";
}

export function caseDocumentDownloadPath(
  caseId: string,
  documentKey: string
) {
  return `/api/operational-cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentKey)}/download`;
}

export function buildCaseDocumentDownloadUrl(
  caseId: string,
  binding: Pick<GeneratedCaseDocumentBinding, "documentKey">
) {
  const base = siteBaseUrl();
  const path = caseDocumentDownloadPath(caseId, binding.documentKey);
  return base ? `${base}${path}` : path;
}

export function defaultDownloadLabel(
  storagePath: string | null | undefined,
  fallbackLabel: string
) {
  if (storagePath) {
    const name = path.basename(storagePath);
    if (name && name !== ".") return `Descargar ${name}`;
  }
  return fallbackLabel;
}

const SUPABASE_SIGNED_URL_RE =
  /https?:\/\/[^\s]+\/storage\/v1\/object\/sign\/account-assets\/[^\s)]+/gi;

/** Corrige URLs con el origen del sitio repetido (p. ej. ngrok duplicado al reescribir). */
export function dedupeConcatenatedSiteOriginInUrl(url: string): string {
  const base = siteBaseUrl();
  if (!base.startsWith("http") || !url.includes(base)) return url;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return url.replace(new RegExp(`(${escaped})+`, "g"), base);
}

/** Sustituye rutas relativas /api/.../download por URL absoluta cuando hay base de sitio. */
export function rewriteCaseDocumentDownloadLinksInText(params: {
  text: string;
  caseId: string;
  binding: GeneratedCaseDocumentBinding;
}): string {
  const absolute = buildCaseDocumentDownloadUrl(params.caseId, params.binding);
  if (!absolute.startsWith("http")) return params.text;
  const path = caseDocumentDownloadPath(params.caseId, params.binding.documentKey);
  if (!params.text.includes(path)) return params.text;
  if (params.text.includes(absolute)) {
    return dedupeConcatenatedSiteOriginInUrl(params.text);
  }
  const rewritten = params.text.split(path).join(absolute);
  return dedupeConcatenatedSiteOriginInUrl(rewritten);
}

/** Sustituye URLs firmadas largas por etiqueta + enlace corto del proxy. */
export function normalizeNotifyTextReplacingSignedUrls(params: {
  text: string;
  caseId?: string;
  storagePath?: string | null;
  binding: GeneratedCaseDocumentBinding;
}) {
  const caseId = params.caseId?.trim();
  if (!caseId) return params.text;
  const shortUrl = buildCaseDocumentDownloadUrl(caseId, params.binding);
  const label = defaultDownloadLabel(
    params.storagePath,
    params.binding.defaultDownloadLabel
  );
  let text = params.text;
  if (SUPABASE_SIGNED_URL_RE.test(text)) {
    text = text.replace(SUPABASE_SIGNED_URL_RE, `${label}: ${shortUrl}`);
  }
  return rewriteCaseDocumentDownloadLinksInText({
    text,
    caseId,
    binding: params.binding,
  });
}

export function parseGeneratedDocumentFromContext(
  context: unknown,
  binding: Pick<GeneratedCaseDocumentBinding, "contextKey">
): GeneratedCaseDocumentRef | null {
  if (!isRecord(context)) return null;
  const draft = context[binding.contextKey];
  if (!isRecord(draft)) return null;
  return {
    template_slug:
      typeof draft.template_slug === "string" ? draft.template_slug : undefined,
    output_bucket:
      typeof draft.output_bucket === "string" ? draft.output_bucket : undefined,
    output_path:
      typeof draft.output_path === "string" ? draft.output_path : undefined,
    doc_url: typeof draft.doc_url === "string" ? draft.doc_url : undefined,
    download_label:
      typeof draft.download_label === "string" ? draft.download_label : undefined,
    generated_at:
      typeof draft.generated_at === "string" ? draft.generated_at : undefined,
  };
}

/** output_path desde context_jsonb o eventos recientes (p. ej. antes de sync o de contract_drafted). */
export async function resolveGeneratedDocumentOutputPathFromCase(
  db: DbClient,
  params: {
    caseId: string;
    context: Record<string, unknown>;
    binding: GeneratedCaseDocumentBinding;
  }
): Promise<GeneratedCaseDocumentRef | null> {
  const fromContext = parseGeneratedDocumentFromContext(params.context, params.binding);
  if (fromContext?.output_path?.trim()) return fromContext;

  const events = await getRecentOperationalCaseEvents(db, params.caseId, 40);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = event.payload_jsonb;
    if (!isRecord(payload)) continue;

    if (
      event.event_type === "human_decision" &&
      payload.kind === params.binding.draftedEventKind
    ) {
      const outputPath =
        typeof payload.output_path === "string" ? payload.output_path.trim() : "";
      if (outputPath) {
        return {
          output_path: outputPath,
          output_bucket:
            typeof payload.output_bucket === "string"
              ? payload.output_bucket
              : GENERATED_DOCUMENT_BUCKET,
          template_slug:
            typeof payload.template_slug === "string"
              ? payload.template_slug
              : params.binding.defaultTemplateSlug,
        };
      }
    }

    if (
      event.event_type === "state_changed" &&
      payload.tool === "generate_document_from_template"
    ) {
      const outputPath =
        typeof payload.output_path === "string" ? payload.output_path.trim() : "";
      if (outputPath) {
        return {
          output_path: outputPath,
          output_bucket:
            typeof payload.output_bucket === "string"
              ? payload.output_bucket
              : GENERATED_DOCUMENT_BUCKET,
          template_slug: params.binding.defaultTemplateSlug,
        };
      }
    }
  }

  return fromContext;
}

export function parseGenerateDocumentRenderResult(
  result: unknown,
  defaultTemplateSlug?: string
): {
  output_bucket: string;
  output_path: string;
  template_slug: string;
} | null {
  if (!isRecord(result)) return null;
  if (result.ok !== true || result.status !== "rendered") return null;
  const outputPath =
    typeof result.output_path === "string" ? result.output_path.trim() : "";
  const outputBucket =
    typeof result.output_bucket === "string"
      ? result.output_bucket.trim()
      : GENERATED_DOCUMENT_BUCKET;
  if (!outputPath) return null;
  const templateSlug =
    typeof result.template_slug === "string"
      ? result.template_slug.trim()
      : (defaultTemplateSlug ?? "document");
  return {
    output_bucket: outputBucket,
    output_path: outputPath,
    template_slug: templateSlug,
  };
}

export function buildGeneratedDocumentContextPatch(params: {
  caseId: string;
  binding: GeneratedCaseDocumentBinding;
  render: {
    output_bucket: string;
    output_path: string;
    template_slug: string;
  };
}): Record<string, GeneratedCaseDocumentRef> {
  const downloadUrl = buildCaseDocumentDownloadUrl(params.caseId, params.binding);
  return {
    [params.binding.contextKey]: {
      template_slug: params.render.template_slug,
      output_bucket: params.render.output_bucket,
      output_path: params.render.output_path,
      doc_url: downloadUrl,
      download_label: defaultDownloadLabel(
        params.render.output_path,
        params.binding.defaultDownloadLabel
      ),
      generated_at: new Date().toISOString(),
    },
  };
}

export async function createSignedUrlForStoredDocument(
  db: DbClient,
  ref: GeneratedCaseDocumentRef
): Promise<string | null> {
  const bucket = ref.output_bucket?.trim() || GENERATED_DOCUMENT_BUCKET;
  const storagePath = ref.output_path?.trim();
  if (!storagePath) return null;
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(storagePath, GENERATED_CASE_DOCUMENT_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export function replaceCaseDocumentDownloadUrlsForExternalAudience(params: {
  text: string;
  caseId: string;
  binding: GeneratedCaseDocumentBinding;
  externalUrl: string;
}): string {
  const path = caseDocumentDownloadPath(params.caseId, params.binding.documentKey);
  const authUrl = buildCaseDocumentDownloadUrl(params.caseId, params.binding);
  let text = params.text;
  if (authUrl.startsWith("http")) {
    text = text.split(authUrl).join(params.externalUrl);
  }
  if (text.includes(path)) {
    text = text.split(path).join(params.externalUrl);
  }
  return dedupeConcatenatedSiteOriginInUrl(text);
}

export async function resolveGeneratedDocumentDeliveryUrl(
  db: DbClient,
  params: {
    caseId: string;
    context: Record<string, unknown>;
    binding: GeneratedCaseDocumentBinding;
    /** Telegram / correo: enlace con token (sin cookie de sesión). */
    forExternalAudience?: boolean;
  }
): Promise<string | null> {
  const ref =
    (await resolveGeneratedDocumentOutputPathFromCase(db, {
      caseId: params.caseId,
      context: params.context,
      binding: params.binding,
    })) ?? parseGeneratedDocumentFromContext(params.context, params.binding);
  if (ref?.output_path) {
    if (params.forExternalAudience) {
      const opCase = await getOperationalCase(db, params.caseId);
      if (opCase?.user_id) {
        const external = buildExternalCaseDocumentDownloadUrl({
          caseId: params.caseId,
          userId: opCase.user_id,
          documentKey: params.binding.documentKey,
          outputPath: ref.output_path,
        });
        if (external) return external;
      }
    }
    const proxy = buildCaseDocumentDownloadUrl(params.caseId, params.binding);
    if (proxy.startsWith("http")) return proxy;
    const signed = await createSignedUrlForStoredDocument(db, ref);
    if (signed) return signed;
  }
  if (ref?.doc_url?.trim()) {
    const url = dedupeConcatenatedSiteOriginInUrl(ref.doc_url.trim());
    if (url.includes("example.test")) return null;
    if (url.includes("/api/operational-cases/")) return url;
    if (url.includes("/storage/v1/object/sign/") && ref.output_path) {
      const fresh = await createSignedUrlForStoredDocument(db, ref);
      return fresh ?? url;
    }
    return url;
  }
  return null;
}

export function generatedDocumentHasStoredOutput(
  context: unknown,
  binding: Pick<GeneratedCaseDocumentBinding, "contextKey">
) {
  const ref = parseGeneratedDocumentFromContext(context, binding);
  return Boolean(ref?.output_path?.trim());
}

export type ToolCallLike = {
  tool_name: string;
  status: string;
  result_json?: unknown;
};

export async function syncGeneratedDocumentFromToolCalls(
  db: DbClient,
  opCase: OperationalCase,
  toolCalls: ToolCallLike[],
  binding: GeneratedCaseDocumentBinding
): Promise<OperationalCase> {
  const renderCall = [...toolCalls]
    .reverse()
    .find(
      (call) =>
        call.tool_name === "generate_document_from_template" &&
        call.status === "executed"
    );
  if (!renderCall) return opCase;

  const render = parseGenerateDocumentRenderResult(
    renderCall.result_json,
    binding.defaultTemplateSlug
  );
  if (!render) return opCase;

  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const patch = buildGeneratedDocumentContextPatch({
    caseId: opCase.id,
    binding,
    render,
  });
  const docRef = patch[binding.contextKey];

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: { ...context, ...patch },
  });
  if (!updated) return opCase;

  if (binding.draftedEventKind) {
    const events = await getRecentOperationalCaseEvents(db, opCase.id, 30);
    const outputPath = docRef?.output_path?.trim() ?? "";
    const hasDraftedForOutput = events.some((event) => {
      if (event.event_type !== "human_decision") return false;
      const payload = event.payload_jsonb;
      if (!isRecord(payload) || payload.kind !== binding.draftedEventKind) {
        return false;
      }
      const eventPath =
        typeof payload.output_path === "string" ? payload.output_path.trim() : "";
      return Boolean(outputPath && eventPath === outputPath);
    });
    if (!hasDraftedForOutput && docRef) {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "human_decision",
        actor: "system",
        payload: {
          kind: binding.draftedEventKind,
          source: binding.draftedEventSource ?? "generated_case_document_sync",
          doc_url: docRef.doc_url,
          output_path: docRef.output_path,
          output_bucket: docRef.output_bucket,
          template_slug: docRef.template_slug,
          document_key: binding.documentKey,
        },
      });
    }
  }

  return updated;
}

export async function assertOperationalCaseOwnedByUser(
  db: DbClient,
  caseId: string,
  userId: string
) {
  const opCase = await getOperationalCase(db, caseId);
  if (!opCase || opCase.user_id !== userId) return null;
  return opCase;
}

export function safeGeneratedDocumentFilename(
  storagePath: string,
  fallbackName = "documento.docx"
) {
  const base = path.basename(storagePath) || fallbackName;
  return base.endsWith(".docx") ? base : `${base}.docx`;
}

/** Descarga un documento generado del caso si el usuario es dueño y el path es válido. */
export async function downloadGeneratedCaseDocumentForUser(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  binding: GeneratedCaseDocumentBinding;
}) {
  const opCase = await assertOperationalCaseOwnedByUser(
    params.db,
    params.caseId,
    params.userId
  );
  if (!opCase) return { error: "not_found" as const };

  const ref = parseGeneratedDocumentFromContext(
    opCase.context_jsonb,
    params.binding
  );
  const bucket = ref?.output_bucket?.trim() || GENERATED_DOCUMENT_BUCKET;
  const storagePath = ref?.output_path?.trim();
  if (!storagePath) {
    return { error: "no_document" as const };
  }
  if (!storagePath.startsWith(`${params.userId}/generated-documents/`)) {
    return { error: "path_not_allowed" as const };
  }

  const { data, error } = await params.db.storage.from(bucket).download(storagePath);
  if (error || !data) {
    return { error: "download_failed" as const, message: error?.message };
  }

  return {
    data,
    filename: safeGeneratedDocumentFilename(
      storagePath,
      `${params.binding.documentKey}.docx`
    ),
  };
}
