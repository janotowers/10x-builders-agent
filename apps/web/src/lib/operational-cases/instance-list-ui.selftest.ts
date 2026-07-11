import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import { operationalCaseDisplayTitle } from "./instance-list-ui";

function caseWithContext(context: Record<string, unknown>): OperationalCase {
  return {
    id: "case-1",
    user_id: "user-1",
    case_type_id: "type-1",
    status: "waiting_internal",
    current_step: "package_ready",
    version: 1,
    context_jsonb: context,
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
  } as OperationalCase;
}

assert.equal(
  operationalCaseDisplayTitle(
    caseWithContext({
      title: "Casa",
      property_type: "Casa",
      property_title: "Casa en venta en Las Fuentes",
    })
  ),
  "Casa en venta en Las Fuentes"
);

assert.equal(
  operationalCaseDisplayTitle(
    caseWithContext({
      title: "Casa",
      property_type: "Casa",
      property_data: {
        address: "Calle Circunvalacion Sur 3668, Fraccionamiento Las Fuentes",
      },
    })
  ),
  "Calle Circunvalacion Sur 3668, Fraccionamiento Las Fuentes"
);

assert.equal(
  operationalCaseDisplayTitle(
    caseWithContext({
      title: "Casa Sendas 12",
      property_type: "Casa",
    })
  ),
  "Casa Sendas 12"
);

console.log("instance-list-ui.selftest: ok");
