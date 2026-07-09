import { resolveImagePathsFromRawPhotos } from "./test-property-listing-photos";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function arraysEqualAsSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((item, index) => item === b[index]);
}

export function detectPhotoAnalysisStaleness(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!context) return false;
  const rawPhotoPaths = resolveImagePathsFromRawPhotos(context.raw_photos);
  const photoAnalysis = isRecord(context.photo_analysis) ? context.photo_analysis : {};
  const sourcePaths = normalizePathList(photoAnalysis.source_paths);
  if (rawPhotoPaths.length === 0 || sourcePaths.length === 0) return false;
  return !arraysEqualAsSet(rawPhotoPaths, sourcePaths);
}

