import type { DbClient } from "@agents/db";
import {
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCaseTypeById,
  getOperationalCaseTypeForUser,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseFlowStep,
  OperationalCaseType,
} from "@agents/types";

export type OperationalStepLabelMap = Record<string, string>;

/**
 * Fallback en español cuando el flow del tipo de caso no trae step_label
 * (o trae el slug técnico). Evita "Property Data Review" en UI broker-facing.
 */
export const DEFAULT_OPERATIONAL_STEP_LABELS: OperationalStepLabelMap = {
  intake: "Registro inicial",
  awaiting_documents: "Solicitar documentos",
  documents_received: "Revisión documental",
  property_data_review: "Revisión de datos de propiedad",
  comparables_in_progress: "Análisis de mercado",
  photos_requested: "Solicitar fotos",
  package_ready: "Paquete listo",
  contract_pending: "Datos para contrato",
  listing_description_review: "Revisión de descripción",
};

export function humanizeOperationalStepKey(value: string): string {
  return value
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildOperationalStepLabelMap(
  steps: Array<{ step_key: string; step_label?: string | null }>
): OperationalStepLabelMap {
  const map: OperationalStepLabelMap = {};
  for (const step of steps) {
    const key = step.step_key?.trim();
    const label = step.step_label?.trim();
    if (key && label) map[key] = label;
  }
  return map;
}

/**
 * Solo el nombre legible (para tarjetas de Trabajo durable / superficies
 * broker-facing). Null si no hay paso. Preferir step_label del flow; si no,
 * fallback español conocido; si no, humanizar el slug — nunca snake_case crudo.
 */
export function friendlyOperationalStepLabel(
  stepKey: string | null | undefined,
  stepLabels?: OperationalStepLabelMap
): string | null {
  if (!stepKey?.trim()) return null;
  const key = stepKey.trim();
  const fromFlow = stepLabels?.[key]?.trim();
  if (fromFlow && fromFlow !== key) return fromFlow;
  const fromDefault = DEFAULT_OPERATIONAL_STEP_LABELS[key]?.trim();
  if (fromDefault) return fromDefault;
  return humanizeOperationalStepKey(key);
}

/**
 * Formato con clave técnica (laboratorio / debug). Superficies broker-facing
 * deben preferir `friendlyOperationalStepLabel`.
 */
export function formatOperationalStepForDisplay(
  stepKey: string | null | undefined,
  stepLabels?: OperationalStepLabelMap
): string {
  if (!stepKey?.trim()) return "(sin paso)";
  const key = stepKey.trim();
  const friendly = friendlyOperationalStepLabel(key, stepLabels);
  return `${friendly} (${key})`;
}

export async function effectiveOperationalFlowForCaseType(
  db: DbClient,
  caseType: OperationalCaseType | null
): Promise<OperationalCaseFlowStep[]> {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? (caseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? (globalCaseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
}

/**
 * Resuelve labels de paso desde operational_flow_jsonb (tenant override → global).
 * Cachea por case_type_id dentro de un tick de cron o request.
 */
export class OperationalStepLabelResolver {
  private readonly cache = new Map<string, OperationalStepLabelMap>();

  constructor(private readonly db: DbClient) {}

  async labelsForCase(
    opCase: Pick<OperationalCase, "case_type_id" | "user_id" | "case_type">
  ): Promise<OperationalStepLabelMap> {
    const cacheKey = opCase.case_type_id?.trim();
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    let caseType = cacheKey
      ? await getOperationalCaseTypeById(this.db, cacheKey)
      : null;
    if (!caseType) {
      caseType = await getOperationalCaseTypeForUser(
        this.db,
        opCase.user_id,
        opCase.case_type
      );
    }
    const flow = await effectiveOperationalFlowForCaseType(this.db, caseType);
    const map = buildOperationalStepLabelMap(flow);
    if (cacheKey) this.cache.set(cacheKey, map);
    return map;
  }

  async formatForCase(
    opCase: Pick<OperationalCase, "case_type_id" | "user_id" | "case_type">,
    stepKey: string | null | undefined
  ): Promise<string> {
    const labels = await this.labelsForCase(opCase);
    return formatOperationalStepForDisplay(stepKey, labels);
  }
}
