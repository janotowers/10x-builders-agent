import {
  handlePriceApprovalDecision,
  parsePriceApprovalDecision,
} from "./price-approval";
import {
  handleContractReviewDecision,
  parseContractReviewDecision,
} from "./contract-review";
import { handleContractOwnerSignedDecision } from "./contract-owner-signed";
import type { DbClient } from "@agents/db";

export type BusinessDecisionKind =
  | "price_approval"
  | "contract_review"
  | "contract_owner_signed";

export interface BusinessDecisionHandlerInput {
  userId: string;
  notificationId: string;
  text: string;
}

export interface BusinessDecisionResult {
  ok?: boolean;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

export interface BusinessDecisionHandlerConfig {
  kind: BusinessDecisionKind;
  notificationKind: string;
  label: string;
  parse: (text: string) => { intent: string; reason?: string };
  handle: (
    db: DbClient,
    input: BusinessDecisionHandlerInput
  ) => Promise<BusinessDecisionResult>;
}

export const BUSINESS_DECISION_HANDLERS: Record<
  BusinessDecisionKind,
  BusinessDecisionHandlerConfig
> = {
  price_approval: {
    kind: "price_approval",
    notificationKind: "price_approval",
    label: "Aprobación de precio",
    parse: parsePriceApprovalDecision,
    handle: handlePriceApprovalDecision,
  },
  contract_review: {
    kind: "contract_review",
    notificationKind: "contract_review",
    label: "Revisión de contrato",
    parse: parseContractReviewDecision,
    handle: handleContractReviewDecision,
  },
  contract_owner_signed: {
    kind: "contract_owner_signed",
    notificationKind: "contract_owner_signed",
    label: "Contrato firmado por el dueño",
    parse: (text: string) => ({
      intent: text.trim() ? "signed" : "unclear",
      reason: text.trim() ? undefined : "Respuesta vacía.",
    }),
    handle: handleContractOwnerSignedDecision,
  },
};

export function businessDecisionHandler(
  kind: BusinessDecisionKind
): BusinessDecisionHandlerConfig {
  return BUSINESS_DECISION_HANDLERS[kind];
}
