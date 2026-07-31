import {
  createServerClient,
  getOperationalCase,
  updateOperationalCase,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import type { IngestedCaseDocument } from "./case-document-ingestion";

type DbClient = ReturnType<typeof createServerClient>;

const PHOTO_FILE_EXTENSION = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Imagen de publicación (MIME image/* o extensión típica). */
export function looksLikeRawPhotoUpload(params: {
  contentType: string;
  fileName: string;
}): boolean {
  const contentType = params.contentType.toLowerCase();
  if (contentType.startsWith("image/")) return true;
  return PHOTO_FILE_EXTENSION.test(params.fileName);
}

/**
 * Kind del evento de timeline al registrar media interna.
 * Fotos del inmueble (`photos_requested`) → photo_registered;
 * resto del lote documental → document_registered.
 */
export function internalCaseMediaRegisteredKind(
  currentStep: string | null | undefined
): "photo_registered" | "document_registered" {
  return currentStep === "photos_requested"
    ? "photo_registered"
    : "document_registered";
}

export interface AppendRawPhotoResult {
  opCase: OperationalCase;
  photoAdded: boolean;
  photoCount: number;
}

/**
 * Añade la foto ingestada a `context.raw_photos` cuando el caso está en
 * `photos_requested`. Reintentos con optimistic lock (álbumes / subidas
 * concurrentes en Telegram o web).
 */
export async function appendRawPhoto(params: {
  db: DbClient;
  opCase: OperationalCase;
  ingested: IngestedCaseDocument;
}): Promise<AppendRawPhotoResult> {
  if (
    !looksLikeRawPhotoUpload({
      contentType: params.ingested.document.content_type ?? "",
      fileName: params.ingested.document.original_name ?? "",
    })
  ) {
    return { opCase: params.opCase, photoAdded: false, photoCount: 0 };
  }

  const maxAttempts = 4;
  let current = params.opCase;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (current.current_step !== "photos_requested") {
      return { opCase: current, photoAdded: false, photoCount: 0 };
    }
    const currentContext = isObjectRecord(current.context_jsonb)
      ? (current.context_jsonb as Record<string, unknown>)
      : {};
    const existingRawPhotos = Array.isArray(currentContext.raw_photos)
      ? currentContext.raw_photos.filter(
          (item): item is Record<string, unknown> => isObjectRecord(item)
        )
      : [];
    const duplicate = existingRawPhotos.some((item) => {
      const sameDocument =
        typeof item.document_id === "string" &&
        item.document_id === params.ingested.document.id;
      const samePath =
        typeof item.storage_path === "string" &&
        item.storage_path === params.ingested.document.storage_path;
      return sameDocument || samePath;
    });
    if (duplicate) {
      return {
        opCase: current,
        photoAdded: false,
        photoCount: existingRawPhotos.length,
      };
    }

    const nextRawPhotos = [
      ...existingRawPhotos,
      {
        document_id: params.ingested.document.id,
        storage_bucket: params.ingested.document.storage_bucket,
        storage_path: params.ingested.document.storage_path,
        original_name: params.ingested.document.original_name,
        content_type: params.ingested.document.content_type,
        sha256: params.ingested.sha256,
        source: params.ingested.document.source,
        uploaded_at: new Date().toISOString(),
      },
    ];
    const nextCase = await updateOperationalCase(
      params.db,
      current.id,
      current.version,
      {
        currentStep: "photos_requested",
        status: "waiting_internal",
        context: {
          ...currentContext,
          raw_photos: nextRawPhotos,
        },
      }
    );
    if (nextCase) {
      return {
        opCase: nextCase,
        photoAdded: true,
        photoCount: nextRawPhotos.length,
      };
    }
    const fresh = await getOperationalCase(params.db, current.id);
    if (!fresh) {
      return {
        opCase: current,
        photoAdded: false,
        photoCount: existingRawPhotos.length,
      };
    }
    current = fresh;
  }

  const fallbackContext = isObjectRecord(current.context_jsonb)
    ? (current.context_jsonb as Record<string, unknown>)
    : {};
  const fallbackCount = Array.isArray(fallbackContext.raw_photos)
    ? fallbackContext.raw_photos.length
    : 0;
  return { opCase: current, photoAdded: false, photoCount: fallbackCount };
}
