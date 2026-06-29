import {
  handlePriceApprovalDecision,
  parsePriceApprovalDecision,
} from "./price-approval";
import {
  handleContractReviewDecision,
  parseContractReviewDecision,
} from "./contract-review";
import {
  handleContractDataReviewDecision,
  parseContractDataReviewReply,
} from "./contract-data-review";
import { handleContractOwnerSignedDecision } from "./contract-owner-signed";
import {
  BUSINESS_DECISION_LABELS,
  type BusinessDecisionKind,
} from "./business-decision-kinds";
import type { DbClient } from "@agents/db";

export type { BusinessDecisionKind } from "./business-decision-kinds";

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
    label: BUSINESS_DECISION_LABELS.price_approval,
    parse: parsePriceApprovalDecision,
    handle: handlePriceApprovalDecision,
  },
  contract_review: {
    kind: "contract_review",
    notificationKind: "contract_review",
    label: BUSINESS_DECISION_LABELS.contract_review,
    parse: parseContractReviewDecision,
    handle: handleContractReviewDecision,
  },
  contract_data_review: {
    kind: "contract_data_review",
    notificationKind: "contract_data_review",
    label: BUSINESS_DECISION_LABELS.contract_data_review,
    parse: parseContractDataReviewReply,
    handle: handleContractDataReviewDecision,
  },
  contract_owner_signed: {
    kind: "contract_owner_signed",
    notificationKind: "contract_owner_signed",
    label: BUSINESS_DECISION_LABELS.contract_owner_signed,
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
