/**
 * Input-hash del plano de impacto (Slice 3.2-2; Technical Plan §11).
 *
 * Generaliza la canonicalización que ya probó producción en
 * `property-identity-signature.ts` (apps/web): trim de textos, parseo
 * numérico tolerante a comas y redondeo estable a 2 decimales. Las
 * primitivas viven AQUÍ y el módulo original las importa — extraídas, no
 * reimplementadas — para que la firma de identidad y el input-hash no
 * puedan divergir en silencio.
 *
 * El hash es `sha256:<hex>` sobre la serialización canónica (llaves
 * ordenadas, sin whitespace — `canonicalizeJson`, la misma de
 * `definition_hash`) de las entradas normalizadas. Igual entrada ⇒ igual
 * hash: esa es la garantía de selectividad del motor de impacto (hash
 * igual ⇒ el artefacto sigue `current`).
 */
import { createHash } from "node:crypto";
import { canonicalizeJson } from "./hash";

/** Trim de textos; cualquier no-string se colapsa a "". */
export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parseo numérico tolerante ("1,234.5" → 1234.5); no-números → null. */
export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Redondeo estable a 2 decimales (150.004999 y 150.0 hashean igual). */
export function stableRounded(value: number | null): number | null {
  if (value == null) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Normalización recursiva previa al hash: strings se trimean (y si son
 * puramente numéricas se convierten — "3" y 3 son el mismo hecho), números
 * se redondean establemente, vacíos/undefined colapsan a null. Objetos y
 * arrays se normalizan por dentro; el orden de llaves lo resuelve
 * `canonicalizeJson`.
 */
export function normalizeImpactValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? stableRounded(value) : null;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = numberOrNull(trimmed);
    // Solo convertir strings íntegramente numéricas ("3", "1,234.50");
    // "Calle 5" ya devuelve null en numberOrNull y queda como texto.
    if (numeric !== null && /^-?[\d.,\s]+$/.test(trimmed)) {
      return stableRounded(numeric);
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeImpactValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) continue;
      out[key] = normalizeImpactValue(record[key]);
    }
    return out;
  }
  return null;
}

/**
 * Hash canónico de un conjunto de entradas declaradas (clave de entrada →
 * valor vigente). `sha256:<hex>`, mismo prefijo que `definition_hash`.
 */
export function computeImpactInputHash(
  entries: Record<string, unknown>
): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(entries)) {
    normalized[key] = normalizeImpactValue(entries[key]);
  }
  const digest = createHash("sha256")
    .update(canonicalizeJson(normalized), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
