/**
 * Canonical, file-identity based photo manifest shared by agent and web.
 * Entries are always ordered by raw_photos, but merged by source path/hash.
 */
export type PhotoManifestError = {
  code: string;
  message: string;
  stage: "load" | "classify" | "watermark" | "publish";
};

export type PhotoManifestEntry = {
  source_path: string;
  sha256?: string | null;
  sequence: number;
  space_label?: string | null;
  confidence?: number | null;
  uncertain?: boolean;
  error?: PhotoManifestError | null;
  watermarked_path?: string | null;
  public_url?: string | null;
  title?: string | null;
  destinations?: {
    easybroker?: { uploaded?: boolean; title?: string | null; error?: string | null };
    ungga?: { uploaded?: boolean; title?: string | null; error?: string | null };
  };
};

export type PhotoUploadPair = {
  source_path: string;
  upload_path: string;
  title: string | null;
};

export const PHOTO_LABEL_CONFIDENCE_THRESHOLD = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizePhotoSourcePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9._-]+:/i.test(trimmed)) return trimmed;
  return `case-documents:${trimmed.replace(/^\/+/, "")}`;
}

export function resolveRawPhotoPaths(rawPhotos: unknown): string[] {
  if (!Array.isArray(rawPhotos)) return [];
  const paths: string[] = [];
  for (const item of rawPhotos) {
    if (typeof item === "string") {
      const normalized = normalizePhotoSourcePath(item);
      if (normalized) paths.push(normalized);
      continue;
    }
    if (!isRecord(item)) continue;
    const bucket =
      typeof item.storage_bucket === "string" ? item.storage_bucket.trim() : "";
    const storagePath =
      typeof item.storage_path === "string" ? item.storage_path.trim() : "";
    if (bucket && storagePath) {
      paths.push(`${bucket}:${storagePath.replace(/^\/+/, "")}`);
    } else if (storagePath) {
      const normalized = normalizePhotoSourcePath(storagePath);
      if (normalized) paths.push(normalized);
    }
  }
  return paths;
}

function parseManifestError(value: unknown): PhotoManifestError | null {
  if (!isRecord(value)) return null;
  const stage = value.stage;
  if (
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    (stage !== "load" &&
      stage !== "classify" &&
      stage !== "watermark" &&
      stage !== "publish")
  ) {
    return null;
  }
  return { code: value.code, message: value.message, stage };
}

export function parsePhotoManifest(value: unknown): PhotoManifestEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PhotoManifestEntry[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const sourcePath =
      typeof item.source_path === "string"
        ? normalizePhotoSourcePath(item.source_path)
        : "";
    if (!sourcePath) continue;
    out.push({
      source_path: sourcePath,
      sha256: typeof item.sha256 === "string" ? item.sha256 : null,
      sequence: typeof item.sequence === "number" ? item.sequence : index,
      space_label:
        typeof item.space_label === "string" ? item.space_label.trim() : null,
      confidence: typeof item.confidence === "number" ? item.confidence : null,
      uncertain: item.uncertain === true,
      error: parseManifestError(item.error),
      watermarked_path:
        typeof item.watermarked_path === "string" ? item.watermarked_path : null,
      public_url: typeof item.public_url === "string" ? item.public_url : null,
      title: typeof item.title === "string" ? item.title.trim() : null,
      destinations: isRecord(item.destinations)
        ? (item.destinations as PhotoManifestEntry["destinations"])
        : undefined,
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

export function buildPhotoManifestFromRawPhotos(
  rawPhotos: unknown,
  existing?: PhotoManifestEntry[]
): PhotoManifestEntry[] {
  const paths = resolveRawPhotoPaths(rawPhotos);
  const byPath = new Map(
    (existing ?? []).map((entry) => [normalizePhotoSourcePath(entry.source_path), entry])
  );
  return paths.map((sourcePath, sequence) => {
    const prev = byPath.get(sourcePath);
    return {
      source_path: sourcePath,
      sha256: prev?.sha256 ?? null,
      sequence,
      space_label: prev?.space_label ?? null,
      confidence: prev?.confidence ?? null,
      uncertain: prev?.uncertain ?? true,
      error: prev?.error ?? null,
      watermarked_path: prev?.watermarked_path ?? null,
      public_url: prev?.public_url ?? null,
      title: prev?.title ?? null,
      destinations: prev?.destinations,
    };
  });
}

export function mergePhotoEntries(
  manifest: PhotoManifestEntry[],
  updates: Array<Partial<PhotoManifestEntry> & { source_path: string }>
): PhotoManifestEntry[] {
  const byPath = new Map(
    updates.map((entry) => [normalizePhotoSourcePath(entry.source_path), entry])
  );
  return manifest.map((entry) => {
    const update = byPath.get(entry.source_path);
    return update ? { ...entry, ...update, source_path: entry.source_path } : entry;
  });
}

export function mergePhotoLabelsIntoManifest(
  manifest: PhotoManifestEntry[],
  labels: Array<{
    source_path: string;
    sha256?: string | null;
    space_label: string | null;
    confidence?: number | null;
    uncertain?: boolean;
    error?: PhotoManifestError | null;
  }>
): PhotoManifestEntry[] {
  return mergePhotoEntries(
    manifest,
    labels.map((label) => {
      const confidence = label.confidence ?? null;
      const title = label.space_label?.trim() || null;
      return {
        ...label,
        space_label: title,
        confidence,
        uncertain:
          label.uncertain === true ||
          !title ||
          confidence == null ||
          confidence < PHOTO_LABEL_CONFIDENCE_THRESHOLD,
        title,
      };
    })
  );
}

export function applyWatermarkOutputsToManifest(
  manifest: PhotoManifestEntry[],
  outputs: Array<{
    input_path: string;
    output_path?: string;
    output_bucket?: string;
    ok?: boolean;
    error?: string;
  }>
): { manifest: PhotoManifestEntry[]; ok: boolean; missing: string[] } {
  const byInput = new Map(
    outputs.map((item) => [normalizePhotoSourcePath(item.input_path), item])
  );
  const missing: string[] = [];
  const next = manifest.map((entry) => {
    const output = byInput.get(entry.source_path);
    if (!output || output.ok === false || !output.output_path) {
      missing.push(entry.source_path);
      return output?.error
        ? {
            ...entry,
            error: {
              code: "watermark_failed",
              message: output.error,
              stage: "watermark" as const,
            },
          }
        : entry;
    }
    const outputPath = output.output_path;
    const watermarkedPath =
      outputPath.includes(":") || !output.output_bucket
        ? outputPath
        : `${output.output_bucket}:${outputPath}`;
    return { ...entry, watermarked_path: watermarkedPath };
  });
  return { manifest: next, ok: missing.length === 0, missing };
}

export function applyPublicUrlsToManifest(
  manifest: PhotoManifestEntry[],
  urls: Array<{ source_path: string; public_url: string; title?: string | null }>,
  destination?: "easybroker" | "ungga"
): PhotoManifestEntry[] {
  const byPath = new Map(
    urls.map((item) => [normalizePhotoSourcePath(item.source_path), item])
  );
  return manifest.map((entry) => {
    const item = byPath.get(entry.source_path);
    if (!item) return entry;
    return {
      ...entry,
      public_url: item.public_url,
      destinations: destination
        ? {
            ...entry.destinations,
            [destination]: {
              ...entry.destinations?.[destination],
              uploaded: true,
              title: item.title ?? entry.title ?? null,
              error: null,
            },
          }
        : entry.destinations,
    };
  });
}

export function photoUploadPairsFromManifest(
  manifest: PhotoManifestEntry[],
  preferWatermarked = true
): PhotoUploadPair[] {
  return manifest.map((entry) => ({
    source_path: entry.source_path,
    upload_path:
      preferWatermarked && entry.watermarked_path
        ? entry.watermarked_path
        : entry.source_path,
    title:
      entry.uncertain === true ||
      entry.confidence == null ||
      entry.confidence < PHOTO_LABEL_CONFIDENCE_THRESHOLD
        ? null
        : entry.title || entry.space_label || null,
  }));
}

export function imageTitlesFromManifest(
  manifest: PhotoManifestEntry[],
  imagePaths: string[]
): Array<string | null> {
  const byPath = new Map<string, PhotoManifestEntry>();
  for (const entry of manifest) {
    byPath.set(entry.source_path, entry);
    if (entry.watermarked_path) {
      byPath.set(normalizePhotoSourcePath(entry.watermarked_path), entry);
    }
  }
  return imagePaths.map((path) => {
    const entry = byPath.get(normalizePhotoSourcePath(path));
    if (
      !entry ||
      entry.uncertain ||
      entry.confidence == null ||
      entry.confidence < PHOTO_LABEL_CONFIDENCE_THRESHOLD
    ) {
      return null;
    }
    return entry.title || entry.space_label || null;
  });
}

export function imagePathsForUpload(
  manifest: PhotoManifestEntry[],
  preferWatermarked = true
): string[] {
  return photoUploadPairsFromManifest(manifest, preferWatermarked).map(
    (item) => item.upload_path
  );
}

export function publicImageUrlsFromManifest(
  manifest: PhotoManifestEntry[]
): string[] {
  return manifest
    .map((entry) => entry.public_url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

export function manifestNeedsLabelReview(
  manifest: PhotoManifestEntry[],
  threshold = PHOTO_LABEL_CONFIDENCE_THRESHOLD
): boolean {
  return manifest.some(
    (entry) =>
      !entry.space_label ||
      entry.uncertain === true ||
      entry.confidence == null ||
      entry.confidence < threshold
  );
}

export function manifestsMatchRawPhotosInOrder(
  manifest: PhotoManifestEntry[],
  rawPhotos: unknown
): boolean {
  const paths = resolveRawPhotoPaths(rawPhotos);
  return (
    paths.length === manifest.length &&
    paths.every((photoPath, index) => manifest[index]?.source_path === photoPath)
  );
}

export function manifestsMatchRawPhotosSet(
  manifest: PhotoManifestEntry[],
  rawPhotos: unknown
): boolean {
  const paths = resolveRawPhotoPaths(rawPhotos);
  return (
    paths.length === manifest.length &&
    new Set(paths).size === paths.length &&
    paths.every((photoPath) =>
      manifest.some((entry) => entry.source_path === photoPath)
    )
  );
}
