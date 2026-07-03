export type BusinessDecisionKind =
  | "price_approval"
  | "contract_review"
  | "contract_data_review"
  | "contract_owner_signed"
  | "titularidad_review";

export const BUSINESS_DECISION_LABELS: Record<BusinessDecisionKind, string> = {
  price_approval: "Aprobación de precio",
  contract_review: "Revisión de contrato",
  contract_data_review: "Datos contractuales faltantes",
  contract_owner_signed: "Contrato firmado por el dueño",
  titularidad_review: "Verificación de titularidad",
};

export function businessDecisionLabel(kind: BusinessDecisionKind): string {
  return BUSINESS_DECISION_LABELS[kind];
}
