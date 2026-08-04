export type BusinessDecisionKind =
  | "price_approval"
  | "contract_review"
  | "contract_data_review"
  | "contract_owner_signed"
  | "titularidad_review"
  | "listing_description_review"
  | "publish_destination_approval"
  | "publication_review"
  | "approval_suspended";

export const BUSINESS_DECISION_LABELS: Record<BusinessDecisionKind, string> = {
  price_approval: "Aprobación de precio",
  contract_review: "Revisión de contrato",
  contract_data_review: "Datos contractuales faltantes",
  contract_owner_signed: "Contrato firmado por el dueño",
  titularidad_review: "Verificación de titularidad",
  listing_description_review: "Revisión de descripción comercial",
  publish_destination_approval: "Aprobación por destino de publicación",
  publication_review: "Revisión condicional de publicación",
  approval_suspended: "Aprobación en pausa por cambio de base",
};

export function businessDecisionLabel(kind: BusinessDecisionKind): string {
  return BUSINESS_DECISION_LABELS[kind];
}
