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
  handleTitularidadReviewDecision,
  parseTitularidadReviewDecision,
} from "./titularidad-review";
import {
  handleListingDescriptionReviewDecision,
  parseListingDescriptionReviewDecision,
} from "./listing-description-review";
import {
  handlePublishDestinationApprovalDecision,
  parsePublishDestinationApprovalDecision,
} from "./publish-destination-approval";
import { handlePublicationReviewDecision } from "./publication-review";
import {
  handleApprovalSuspendedDecision,
  parseApprovalSuspendedDecision,
} from "./approval-suspended";
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
  /** Typed commercial patch for contract_data_review (partial capture). */
  patch?: Record<string, unknown>;
  /** Action id canónico del contrato HITL (web buttons / Telegram callbacks). */
  action?: string;
  /** Canal de origen para auditoría / remediaciones (titularidad, etc.). */
  source?: "web" | "telegram";
  /**
   * Lo usan decisiones que avanzan flujo en casos E2E controlados (por ejemplo
   * `price_approval`, `contract_review`, `listing_description_review`,
   * `publish_destination_approval`):
   * difiere el tick del agente para que el caller (webhook de Telegram) envíe
   * primero la confirmación al usuario.
   */
  deferControlledE2ETick?: boolean;
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
  titularidad_review: {
    kind: "titularidad_review",
    notificationKind: "titularidad_review",
    label: BUSINESS_DECISION_LABELS.titularidad_review,
    parse: parseTitularidadReviewDecision,
    handle: handleTitularidadReviewDecision,
  },
  listing_description_review: {
    kind: "listing_description_review",
    notificationKind: "listing_description_review",
    label: BUSINESS_DECISION_LABELS.listing_description_review,
    parse: parseListingDescriptionReviewDecision,
    handle: handleListingDescriptionReviewDecision,
  },
  publish_destination_approval: {
    kind: "publish_destination_approval",
    notificationKind: "easybroker_publish_approval",
    label: BUSINESS_DECISION_LABELS.publish_destination_approval,
    parse: parsePublishDestinationApprovalDecision,
    handle: handlePublishDestinationApprovalDecision,
  },
  publication_review: {
    kind: "publication_review",
    notificationKind: "publication_review_required",
    label: BUSINESS_DECISION_LABELS.publication_review,
    parse: (text: string) => {
      const normalized = text.trim().toLowerCase();
      if (/\b(aprobar|continuar|approve|continue)\b/.test(normalized)) {
        return { intent: "approve_continue" };
      }
      if (/\b(detener|stop|rechazar)\b/.test(normalized)) {
        return { intent: "stop" };
      }
      return { intent: "unclear", reason: "Respuesta no reconocida." };
    },
    handle: handlePublicationReviewDecision,
  },
  approval_suspended: {
    kind: "approval_suspended",
    notificationKind: "approval_suspended",
    label: BUSINESS_DECISION_LABELS.approval_suspended,
    parse: parseApprovalSuspendedDecision,
    handle: handleApprovalSuspendedDecision,
  },
};

export function businessDecisionHandler(
  kind: BusinessDecisionKind
): BusinessDecisionHandlerConfig {
  return BUSINESS_DECISION_HANDLERS[kind];
}
