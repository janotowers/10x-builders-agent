/**
 * Mapeo puro estado/etiqueta para la vista de impacto (Slice 3.5).
 *
 * Dos superficies con vocabularios DISTINTOS que este módulo mantiene
 * separados a propósito:
 *   - Operador (/operations/impact): puede ver vocabulario técnico
 *     traducido (artefactos, staleness, hashes).
 *   - Broker (case view): wording broker-safe — las palabras "stale",
 *     "artifact", "plano de impacto", "hash" JAMÁS se renderizan ahí
 *     (regla 6 del plan: el vocabulario de planos no se filtra al caso).
 *     El UI selftest lo verifica.
 */
import type { ImpactStatus } from "@agents/types";

// ============================================================
// Superficie del operador
// ============================================================

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  comparable_set: "Análisis de comparables",
  valuation: "Valuación",
  price_recommendation: "Recomendación de precio",
  listing_description: "Descripción comercial",
  listing_payload: "Paquete de publicación",
  commercial_copy: "Copy comercial",
  matching_filters: "Filtros de matching",
  contract_draft: "Borrador de contrato",
  watermarked_photos: "Fotos con marca de agua",
};

export function artifactTypeLabel(artifactType: string): string {
  const known = ARTIFACT_TYPE_LABELS[artifactType];
  if (known) return known;
  const humanized = artifactType.replace(/[_-]+/g, " ").trim();
  if (!humanized) return artifactType;
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

export function impactStatusLabel(status: ImpactStatus): string {
  switch (status) {
    case "current":
      return "Vigente";
    case "stale":
      return "Desactualizado";
    case "suspended":
      return "En pausa";
    case "invalid":
      return "Invalidado";
    case "superseded":
      return "Reemplazado";
    default:
      return status;
  }
}

const FACT_KEY_LABELS: Record<string, string> = {
  "property.search_zone": "Zona de búsqueda",
  "property.neighborhood": "Colonia",
  "property.operation": "Operación",
  "property.property_type": "Tipo de propiedad",
  "property.area_construida_m2": "Área construida (m²)",
  "property.area_total_m2": "Área total (m²)",
  "property.bedrooms": "Recámaras",
  "property.bathrooms": "Baños",
  "property.parking_spots": "Estacionamientos",
  "property.amenities": "Amenidades",
  "property.address": "Dirección",
  "methodology.band_policy": "Política de bandas de la metodología",
  "contact.owner_name": "Nombre del propietario",
  "contact.owner_email": "Correo del propietario",
  "contract.commission_pct": "Comisión (%)",
  "contract.duration_months": "Duración del contrato (meses)",
  "contract.exclusive": "Exclusividad",
};

const ACCOUNT_ASSET_LABELS: Record<string, string> = {
  commission_contract_template: "Plantilla de contrato de comisión",
  listing_photo_watermark: "Marca de agua de fotos",
};

/**
 * Etiqueta legible de una entrada declarada del plano de impacto:
 * fact key, `artifact:<tipo>` o `account_asset:<clave>`.
 */
export function changedInputLabel(entry: string): string {
  if (entry.startsWith("artifact:")) {
    return `Artefacto: ${artifactTypeLabel(entry.slice("artifact:".length))}`;
  }
  if (entry.startsWith("account_asset:")) {
    const key = entry.slice("account_asset:".length);
    return `Recurso de la cuenta: ${ACCOUNT_ASSET_LABELS[key] ?? key}`;
  }
  const known = FACT_KEY_LABELS[entry];
  if (known) return known;
  const tail = entry.includes(".") ? entry.slice(entry.indexOf(".") + 1) : entry;
  const humanized = tail.replace(/[_-]+/g, " ").trim();
  return humanized
    ? humanized.charAt(0).toUpperCase() + humanized.slice(1)
    : entry;
}

/**
 * Ratio de sobre-invalidación (Phase 3 exit check): de todo el trabajo de
 * reparación creado por el motor, qué fracción resultó innecesaria (el
 * operador la canceló en lugar de completarla). 0 = cada invalidación
 * produjo trabajo real; alto = el motor invalida de más.
 */
export function overInvalidationRatio(
  repairItems: ReadonlyArray<{ status: string }>
): { total: number; cancelled: number; ratio: number } | null {
  const total = repairItems.length;
  if (total === 0) return null;
  const cancelled = repairItems.filter((i) => i.status === "cancelled").length;
  return { total, cancelled, ratio: cancelled / total };
}

export function overInvalidationRatioLabel(
  summary: { total: number; cancelled: number; ratio: number } | null
): string {
  if (!summary) return "Sin reparaciones generadas todavía";
  const pct = Math.round(summary.ratio * 100);
  return `${summary.cancelled} de ${summary.total} reparaciones canceladas (${pct}% sobre-invalidación)`;
}

// ============================================================
// Superficie del broker (case view) — wording broker-safe
// ============================================================

export interface CaseImpactSummaryCounts {
  staleArtifacts: number;
  invalidArtifacts: number;
  suspendedApprovals: number;
}

/**
 * Indicadores broker-safe para la case view (3.5-2). Nada de vocabulario de
 * planos: se habla de "información" y "aprobaciones", nunca de artefactos,
 * staleness ni hashes.
 */
export function caseImpactIndicators(
  counts: CaseImpactSummaryCounts
): string[] {
  const indicators: string[] = [];
  const outdated = counts.staleArtifacts + counts.invalidArtifacts;
  if (outdated > 0) {
    indicators.push(
      outdated === 1
        ? "Hay 1 resultado por actualizar tras un cambio de datos"
        : `Hay ${outdated} resultados por actualizar tras un cambio de datos`
    );
  }
  if (counts.suspendedApprovals > 0) {
    indicators.push(
      counts.suspendedApprovals === 1
        ? "Una aprobación espera tu confirmación porque cambió la información"
        : `${counts.suspendedApprovals} aprobaciones esperan tu confirmación porque cambió la información`
    );
  }
  return indicators;
}
