import assert from "node:assert/strict";
import {
  buildPublicationAwareE2EToolApprovalPolicy,
  controlledE2EPublicationContextPatch,
  propertyOptioningPublicationEnablementPatch,
  shouldClearStalePublicationRunnerPendingAction,
} from "./publication-tool-policy";

const enableUnset = propertyOptioningPublicationEnablementPatch({
  caseType: "property_optioning",
  context: {},
});
assert.equal(enableUnset?.publication_mode, "active");
assert.equal(enableUnset?.publication_workflow_v1, true);

assert.equal(
  propertyOptioningPublicationEnablementPatch({
    caseType: "property_optioning",
    context: { publication_mode: "off" },
  }),
  null,
  "explicit off before listing approval must be respected"
);
assert.equal(
  propertyOptioningPublicationEnablementPatch({
    caseType: "property_optioning",
    context: {
      publication_mode: "off",
      listing_description_approved: { description: "ok" },
    },
  })?.publication_mode,
  "active",
  "after listing approval, recover from default-persisted off"
);
assert.equal(
  propertyOptioningPublicationEnablementPatch({
    caseType: "other",
    context: {},
  }),
  null
);

const easyBrokerCreateContext = {
  publication_mode: "active",
  listing_description_approved: { description: "Texto aprobado" },
  publish_approvals: { easybroker: "approved", ungga: "pending" },
  package_ready_machine_work_in_flight: true,
  publication_runner_pending_action: {
    destination: "easybroker",
    type: "create_draft",
  },
};

const createPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: easyBrokerCreateContext,
});
assert.equal(createPolicy.easybroker_create_listing, "auto_execute");
assert.equal(createPolicy.easybroker_upload_images, "deny");
assert.equal(createPolicy.easybroker_publish_listing, "deny");
assert.equal(createPolicy.ungga_publish_listing, "deny");
assert.equal(createPolicy.image_watermark, "deny");

const mediaPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: {
    ...easyBrokerCreateContext,
    publication_runner_pending_action: {
      destination: "easybroker",
      type: "process_media",
    },
  },
});
assert.equal(mediaPolicy.image_watermark, "auto_execute");
assert.equal(mediaPolicy.easybroker_upload_images, "auto_execute");
assert.equal(mediaPolicy.easybroker_create_listing, "deny");

const offPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: { ...easyBrokerCreateContext, publication_mode: "off" },
});
assert.equal(offPolicy.easybroker_create_listing, "deny");

const featureDisabledPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: {
    ...easyBrokerCreateContext,
    publication_workflow_v1: false,
  },
});
assert.equal(featureDisabledPolicy.easybroker_create_listing, "deny");

const wrongDestinationPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: {
    ...easyBrokerCreateContext,
    publish_approvals: { easybroker: "approved", ungga: "pending" },
    publication_runner_pending_action: {
      destination: "ungga",
      type: "create_draft",
    },
  },
});
assert.equal(wrongDestinationPolicy.easybroker_create_listing, "deny");
assert.equal(wrongDestinationPolicy.ungga_publish_listing, "deny");

const noMachineOwnershipPolicy = buildPublicationAwareE2EToolApprovalPolicy({
  context: {
    ...easyBrokerCreateContext,
    package_ready_machine_work_in_flight: false,
  },
});
assert.equal(noMachineOwnershipPolicy.easybroker_create_listing, "deny");

assert.deepEqual(
  controlledE2EPublicationContextPatch({
    caseType: "property_optioning",
    e2eControlled: true,
    context: { e2e_controlled: true },
  }),
  {
    publication_mode: "active",
    publication_workflow_v1: true,
    publication: { feature_enabled: true, mode: "active" },
  }
);
assert.equal(
  controlledE2EPublicationContextPatch({
    caseType: "property_optioning",
    e2eControlled: true,
    context: {
      e2e_controlled: true,
      publication_mode: "active",
      publication_workflow_v1: true,
      publication: { feature_enabled: true, mode: "active" },
    },
  }),
  null
);
assert.equal(
  controlledE2EPublicationContextPatch({
    caseType: "another_case",
    e2eControlled: true,
    context: {},
  }),
  null
);
assert.equal(
  controlledE2EPublicationContextPatch({
    caseType: "another_case",
    e2eControlled: true,
    context: {},
    includeControlMarkers: true,
  })?.e2e_controlled,
  true
);
assert.equal(
  controlledE2EPublicationContextPatch({
    caseType: "property_optioning",
    e2eControlled: false,
    context: {},
  }),
  null
);

assert.equal(
  shouldClearStalePublicationRunnerPendingAction({
    ...easyBrokerCreateContext,
    publish_approvals: { easybroker: "pending" },
  }),
  true
);
assert.equal(
  shouldClearStalePublicationRunnerPendingAction({
    ...easyBrokerCreateContext,
    package_ready_machine_work_in_flight: false,
  }),
  true
);
assert.equal(
  shouldClearStalePublicationRunnerPendingAction(easyBrokerCreateContext),
  false
);

console.log("publication-tool-policy.selftest: ok");
