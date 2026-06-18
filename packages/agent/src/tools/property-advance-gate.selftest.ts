import assert from "node:assert/strict";
import { evaluatePropertyAdvanceGate } from "./operational-cases-adapters";
import type { OperationalCaseDocument } from "@agents/types";

function doc(partial: Partial<OperationalCaseDocument>): OperationalCaseDocument {
  return {
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {},
    ...partial,
  } as unknown as OperationalCaseDocument;
}

const casaContext = {
  property_type: "Casa",
  property_title: "Casa en Las Fuentes",
  property_zone: "Las Fuentes, Zapopan",
  operation_type: "Venta",
};

// --- comparables_in_progress: predial pendiente -> deterministic ---------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "predial-1",
        kind: "predial",
        display_name: "PREDIAL 2023.pdf",
        original_name: "PREDIAL 2023.pdf",
        extraction_status: "pending",
      }),
    ],
    context: casaContext,
    targetTransition: "comparables_in_progress",
  });
  assert.equal(gate.satisfied, false);
  assert.equal(gate.blocks.length, 1);
  assert.equal(gate.blocks[0]!.reason, "predial_extraction_pending");
  assert.equal(gate.blocks[0]!.remediation.owner, "deterministic");
  assert.deepEqual(gate.blocks[0]!.remediation.document_ids, ["predial-1"]);
}

// --- comparables_in_progress: corroboración NO bloquea aquí (WS2) --------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "predial-1",
        kind: "predial",
        display_name: "PREDIAL 2023.pdf",
        original_name: "PREDIAL 2023.pdf",
        extraction_status: "ok",
        extraction_jsonb: { area_total_m2: 200, area_construida_m2: 150 },
      }),
      // INE sin extraer: en comparables NO debe bloquear.
      doc({
        id: "ine-1",
        kind: "ine",
        display_name: "INE",
        original_name: "INE CONCHIS.pdf",
        extraction_status: "pending",
      }),
    ],
    context: {
      ...casaContext,
      property_data: {
        property_type: "Casa",
        area_total_m2: 200,
        area_construida_m2: 150,
        floors: 1,
        bedrooms: 3,
        bathrooms: 2,
        half_bathrooms: 0,
        parking_spots: 2,
        integral_kitchen: true,
        owner_names: ["Ana"],
        address: { street: "Las Fuentes 1" },
      },
    },
    targetTransition: "comparables_in_progress",
  });
  assert.equal(
    gate.satisfied,
    true,
    `corroboración pendiente no debe bloquear comparables; blocks=${JSON.stringify(
      gate.blocks
    )}`
  );
}

// --- comparables_in_progress: faltan mínimos -> external -----------------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "boleta-1",
        kind: "boleta_registral",
        display_name: "boleta",
        original_name: "boleta.pdf",
        extraction_status: "ok",
        extraction_jsonb: { owner_names: ["Ana"], area_total_m2: 200 },
      }),
    ],
    context: { ...casaContext, property_data: { property_type: "Casa" } },
    targetTransition: "comparables_in_progress",
  });
  assert.equal(gate.satisfied, false);
  const minimumsBlock = gate.blocks.find(
    (block) => block.reason === "characteristics_minimums_missing"
  );
  assert.ok(minimumsBlock, "debe reportar mínimos faltantes");
  assert.equal(minimumsBlock!.remediation.owner, "external");
  assert.ok((minimumsBlock!.remediation.missing_fields ?? []).length > 0);
}

// --- contract_pending: titularidad mismatch -> human ---------------------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "boleta-1",
        kind: "boleta_registral",
        display_name: "boleta",
        original_name: "boleta.pdf",
        extraction_status: "ok",
        extraction_jsonb: {
          owner_names: ["Maria Concepcion Castañeda Garcia"],
          document_kind: "boleta_registral",
        },
      }),
      doc({
        id: "ine-1",
        kind: "ine",
        display_name: "ine",
        original_name: "ine.jpg",
        extraction_status: "ok",
        extraction_jsonb: {
          owner_names: ["Teresa Campos"],
          document_kind: "identificacion_oficial",
        },
      }),
    ],
    context: casaContext,
    targetTransition: "contract_pending",
  });
  assert.equal(gate.satisfied, false);
  const titularidadBlock = gate.blocks.find(
    (block) => block.reason === "titularidad_unverified"
  );
  assert.ok(titularidadBlock, "mismatch debe bloquear contract_pending");
  assert.equal(titularidadBlock!.remediation.owner, "human");
  assert.equal(titularidadBlock!.remediation.titularidad_status, "mismatch");
}

// --- contract_pending: titularidad match -> satisfecho -------------------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "boleta-1",
        kind: "boleta_registral",
        display_name: "boleta",
        original_name: "boleta.pdf",
        extraction_status: "ok",
        extraction_jsonb: {
          owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
          document_kind: "boleta_registral",
        },
      }),
      doc({
        id: "ine-1",
        kind: "ine",
        display_name: "ine",
        original_name: "ine.jpg",
        extraction_status: "ok",
        extraction_jsonb: {
          holder_name: "Maria Concepcion Castaneda Garcia",
          document_kind: "identificacion_oficial",
        },
      }),
    ],
    context: casaContext,
    targetTransition: "contract_pending",
  });
  assert.equal(
    gate.satisfied,
    true,
    `match debe satisfacer contract_pending; blocks=${JSON.stringify(gate.blocks)}`
  );
}

// --- contract_pending: override del asesor desbloquea mismatch -----------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "boleta-1",
        kind: "boleta_registral",
        display_name: "boleta",
        original_name: "boleta.pdf",
        extraction_status: "ok",
        extraction_jsonb: {
          owner_names: ["Maria Concepcion Castañeda Garcia"],
          document_kind: "boleta_registral",
        },
      }),
      doc({
        id: "ine-1",
        kind: "ine",
        display_name: "ine",
        original_name: "ine.jpg",
        extraction_status: "ok",
        extraction_jsonb: {
          owner_names: ["Teresa Campos"],
          document_kind: "identificacion_oficial",
        },
      }),
    ],
    context: {
      ...casaContext,
      titularidad: { override: { approved: true, by: "advisor" } },
    },
    targetTransition: "contract_pending",
  });
  assert.equal(
    gate.satisfied,
    true,
    `override aprobado debe desbloquear; blocks=${JSON.stringify(gate.blocks)}`
  );
}

// --- contract_pending: INE pendiente -> deterministic --------------------
{
  const gate = evaluatePropertyAdvanceGate({
    documents: [
      doc({
        id: "ine-1",
        kind: "ine",
        display_name: "ine",
        original_name: "INE CONCHIS.pdf",
        extraction_status: "pending",
      }),
    ],
    context: casaContext,
    targetTransition: "contract_pending",
  });
  assert.equal(gate.satisfied, false);
  assert.equal(gate.blocks[0]!.reason, "owner_corroboration_extraction_pending");
  assert.equal(gate.blocks[0]!.remediation.owner, "deterministic");
  assert.deepEqual(gate.blocks[0]!.remediation.document_ids, ["ine-1"]);
}

console.log("property-advance-gate.selftest.ts: ok");
