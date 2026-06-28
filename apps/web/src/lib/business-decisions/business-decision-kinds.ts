export type BusinessDecisionKind =
  | "price_approval"
  | "contract_review"
  | "contract_owner_signed";

export const BUSINESS_DECISION_LABELS: Record<BusinessDecisionKind, string> = {
  price_approval: "Aprobación de precio",
  contract_review: "Revisión de contrato",
  contract_owner_signed: "Contrato firmado por el dueño",
};

export function businessDecisionLabel(kind: BusinessDecisionKind): string {
  return BUSINESS_DECISION_LABELS[kind];
}
