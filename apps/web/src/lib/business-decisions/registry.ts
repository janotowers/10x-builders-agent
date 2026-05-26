import {
  handlePriceApprovalDecision,
  parsePriceApprovalDecision,
} from "./price-approval";
import type { DbClient } from "@agents/db";

export type BusinessDecisionKind = "price_approval";

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
    label: "Aprobacion de precio",
    parse: parsePriceApprovalDecision,
    handle: handlePriceApprovalDecision,
  },
};

export function businessDecisionHandler(
  kind: BusinessDecisionKind
): BusinessDecisionHandlerConfig {
  return BUSINESS_DECISION_HANDLERS[kind];
}
