/**
 * Selftests del motor de impacto (Slice 3.2-5), sobre un store en memoria
 * que implementa `ImpactPlaneStore` — el MISMO objeto de producción corre
 * aquí (regla de paridad).
 *
 * Escenarios de aceptación del plan:
 *   C1 — corrección de recámaras: artefactos de listing → stale; la cadena
 *        de valuación y la aprobación de precio NO se tocan.
 *   C2 — corrección de área/ubicación: comparable_set + valuation +
 *        price_recommendation → stale; aprobación de precio → suspended;
 *        trabajo de revaluación creado; el trabajo no relacionado sigue
 *        válido.
 *   C3 — reemplazo de plantilla (account_asset): SOLO contract_draft →
 *        stale + repair; valuación y aprobaciones intactas.
 *   Guardia de sobre-invalidación: un artefacto sin edges declarados jamás
 *        se stalea.
 */
import assert from "node:assert/strict";
import type {
  CaseApproval,
  CaseArtifact,
  CaseFact,
  WorkItem,
  WorkItemTemplateSpec,
} from "@agents/types";
import { computeImpactInputHash, normalizeImpactValue } from "./impact-hash";
import {
  affectedArtifactTypes,
  applyInputChange,
  computeApprovalEvidenceHash,
  computeExpectedInputHashForType,
  parseImpactInputRef,
  type ImpactPlaneStore,
  type ImpactSnapshot,
} from "./impact-engine";
import {
  PROPERTY_OPTIONING_IMPACT_DEPENDENCIES,
  PROPERTY_OPTIONING_METHODOLOGY_FACT,
  PROPERTY_OPTIONING_PRICE_APPROVAL_EVIDENCE_INPUTS,
} from "./property-optioning-impact";

const USER = "user-1";
const CASE = "case-1";
const DEPS = PROPERTY_OPTIONING_IMPACT_DEPENDENCIES;
const GRAPH = {
  impact_dependencies: DEPS,
  approvals: [
    {
      kind: "price",
      evidence_inputs: [...PROPERTY_OPTIONING_PRICE_APPROVAL_EVIDENCE_INPUTS],
    },
  ],
};

// ============================================================
// impact-hash: normalización y estabilidad
// ============================================================

assert.equal(
  computeImpactInputHash({ a: "3" }),
  computeImpactInputHash({ a: 3 }),
  "string numérica y número deben hashear igual"
);
assert.equal(
  computeImpactInputHash({ a: " Centro  " }),
  computeImpactInputHash({ a: "Centro" }),
  "trim antes de hashear"
);
assert.notEqual(
  computeImpactInputHash({ a: "Calle 5" }),
  computeImpactInputHash({ a: 5 }),
  "texto con dígitos NO es un número"
);
assert.equal(normalizeImpactValue("1,234.505"), 1234.51, "parse + redondeo estable");
assert.equal(normalizeImpactValue(""), null, "vacío colapsa a null");
assert.match(computeImpactInputHash({}), /^sha256:[0-9a-f]{64}$/);

// parseo del vocabulario de entradas
assert.deepEqual(parseImpactInputRef("property.bedrooms"), {
  kind: "fact",
  key: "property.bedrooms",
});
assert.deepEqual(parseImpactInputRef("artifact:valuation"), {
  kind: "artifact",
  key: "valuation",
});
assert.deepEqual(parseImpactInputRef("account_asset:commission_contract_template"), {
  kind: "account_asset",
  key: "commission_contract_template",
});

// ============================================================
// Metodología verificada (§X finding 3): recámaras/baños/estacionamientos
// JAMÁS son entradas de la cadena de valuación; sí de la capa comercial.
// ============================================================

for (const chainType of ["comparable_set", "valuation", "price_recommendation"]) {
  for (const banned of [
    "property.bedrooms",
    "property.bathrooms",
    "property.parking_spots",
    "property.min_bedrooms",
  ]) {
    assert.ok(
      !DEPS[chainType].includes(banned),
      `${chainType} no debe declarar ${banned}`
    );
  }
}
for (const listingType of [
  "listing_description",
  "listing_payload",
  "commercial_copy",
  "matching_filters",
]) {
  for (const required of [
    "property.bedrooms",
    "property.bathrooms",
    "property.parking_spots",
  ]) {
    assert.ok(
      DEPS[listingType].includes(required),
      `${listingType} debe declarar ${required}`
    );
  }
}
assert.ok(
  DEPS.contract_draft.includes("account_asset:commission_contract_template"),
  "contract_draft declara la plantilla de comisión"
);
assert.ok(
  DEPS.watermarked_photos.includes("account_asset:listing_photo_watermark"),
  "watermarked_photos declara el watermark"
);
// La evidencia de precio jamás incluye recámaras.
assert.ok(
  !PROPERTY_OPTIONING_PRICE_APPROVAL_EVIDENCE_INPUTS.includes("property.bedrooms")
);

// clausura de afectados: bedrooms toca solo la capa comercial
{
  const affected = affectedArtifactTypes(DEPS, {
    kind: "fact",
    key: "property.bedrooms",
  });
  assert.ok(affected.has("listing_description"));
  assert.ok(affected.has("listing_payload"));
  assert.ok(!affected.has("valuation"));
  assert.ok(!affected.has("comparable_set"));
  assert.ok(!affected.has("price_recommendation"));
  assert.ok(!affected.has("contract_draft"));
}

// ============================================================
// Fixture: store en memoria con la semántica del plano de impacto
// ============================================================

interface Fixture {
  store: ImpactPlaneStore;
  facts: Map<string, CaseFact>;
  artifacts: CaseArtifact[];
  assets: Map<string, string | null>;
  approvals: CaseApproval[];
  events: Array<Record<string, unknown>>;
  workItems: Map<string, WorkItem>;
  lastRepairInput: { origin?: string; templates?: WorkItemTemplateSpec[] };
  setFact(key: string, value: unknown): void;
  snapshot(): ImpactSnapshot;
  addArtifact(type: string): CaseArtifact;
  grantPriceApproval(): CaseApproval;
  artifactByType(type: string): CaseArtifact;
}

function buildFixture(): Fixture {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const facts = new Map<string, CaseFact>();
  const artifacts: CaseArtifact[] = [];
  const assets = new Map<string, string | null>();
  const approvals: CaseApproval[] = [];
  const events: Array<Record<string, unknown>> = [];
  const workItems = new Map<string, WorkItem>();
  const lastRepairInput: Fixture["lastRepairInput"] = {};

  const snapshot = (): ImpactSnapshot => ({
    facts: new Map([...facts.entries()].map(([k, f]) => [k, f.value_jsonb])),
    assets,
  });

  const fixture: Fixture = {
    facts,
    artifacts,
    assets,
    approvals,
    events,
    workItems,
    lastRepairInput,
    snapshot,
    setFact(key, value) {
      facts.set(key, {
        id: nextId("fact"),
        case_id: CASE,
        user_id: USER,
        fact_key: key,
        value_jsonb: value,
        source_kind: "user",
        source_ref: null,
        confidence: null,
        superseded_by: null,
        recorded_at: new Date().toISOString(),
      });
    },
    addArtifact(type) {
      const artifact: CaseArtifact = {
        id: nextId("artifact"),
        case_id: CASE,
        user_id: USER,
        artifact_type: type,
        content_jsonb: {},
        // Los productores usan la MISMA función de hash que el motor.
        input_hash: computeExpectedInputHashForType(DEPS, type, snapshot()),
        status: "current",
        produced_by_work_item_id: null,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      artifacts.push(artifact);
      return artifact;
    },
    grantPriceApproval() {
      const approval: CaseApproval = {
        id: nextId("approval"),
        case_id: CASE,
        user_id: USER,
        approval_kind: "price",
        decision: "approved",
        decided_by: USER,
        decided_at: new Date().toISOString(),
        evidence_hash: computeApprovalEvidenceHash(
          DEPS,
          GRAPH.approvals[0].evidence_inputs,
          snapshot()
        ),
        evidence_snapshot_jsonb: {},
        superseded_by: null,
        rationale: null,
      };
      approvals.push(approval);
      return approval;
    },
    artifactByType(type) {
      const found = artifacts.find((a) => a.artifact_type === type);
      assert.ok(found, `fixture: falta artefacto ${type}`);
      return found;
    },
    store: {
      async getCurrentFacts() {
        return [...facts.values()];
      },
      async listCaseArtifacts() {
        return artifacts.map((a) => ({ ...a }));
      },
      async updateArtifactStatus(input) {
        const row = artifacts.find((a) => a.id === input.artifactId);
        if (!row || row.version !== input.expectedVersion) return null;
        row.status = input.status;
        row.version += 1;
        return { ...row };
      },
      async getLatestAssetVersionIdentity(_userId, assetKey) {
        return assets.get(assetKey) ?? null;
      },
      async listCurrentApprovals() {
        return approvals.map((a) => ({ ...a }));
      },
      async suspendApproval(input) {
        const row = approvals.find((a) => a.id === input.approvalId);
        if (!row || row.decision !== "approved") return false;
        row.decision = "suspended";
        return true;
      },
      async appendInvalidationEvent(input) {
        events.push(input.payload);
      },
      async createRepairWorkItems(input) {
        lastRepairInput.origin = input.origin;
        lastRepairInput.templates = input.templates;
        const created: WorkItem[] = [];
        const existing: WorkItem[] = [];
        for (const template of input.templates) {
          const key = template.idempotency_key as string;
          const prior = workItems.get(key);
          if (prior) {
            existing.push(prior);
            continue;
          }
          const item = {
            id: nextId("work"),
            case_id: CASE,
            user_id: USER,
            workflow_definition_version: input.workflowDefinitionVersion,
            work_type: template.work_type,
            origin: input.origin,
            status: "todo",
            priority: template.priority ?? 100,
            required_capability: template.required_capability,
            idempotency_key: key,
            input_contract_jsonb: template.input_contract ?? {},
          } as unknown as WorkItem;
          workItems.set(key, item);
          created.push(item);
        }
        return { created, existing };
      },
    },
  };
  return fixture;
}

function seedPropertyCase(fixture: Fixture) {
  fixture.setFact("property.search_zone", "Metepec");
  fixture.setFact("property.neighborhood", "La Asunción");
  fixture.setFact("property.operation", "venta");
  fixture.setFact("property.property_type", "casa");
  fixture.setFact("property.area_construida_m2", 220);
  fixture.setFact("property.area_total_m2", 300);
  fixture.setFact("property.bedrooms", 3);
  fixture.setFact("property.bathrooms", 2.5);
  fixture.setFact("property.parking_spots", 2);
  fixture.setFact("property.amenities", ["jardín", "cocina integral"]);
  fixture.setFact("property.address", "Calle Ficticia 123");
  fixture.setFact(PROPERTY_OPTIONING_METHODOLOGY_FACT, {
    band: "residential_strict",
    low_pct: -15,
    high_pct: 85,
  });
  fixture.assets.set("commission_contract_template", "sha256:template-v1");
  fixture.assets.set("listing_photo_watermark", "sha256:watermark-v1");
  fixture.addArtifact("comparable_set");
  fixture.addArtifact("valuation");
  fixture.addArtifact("price_recommendation");
  fixture.addArtifact("listing_description");
  fixture.addArtifact("commercial_copy");
  fixture.addArtifact("contract_draft");
  fixture.addArtifact("watermarked_photos");
  // Artefacto SIN edges declarados: guardia de sobre-invalidación.
  fixture.artifacts.push({
    id: "artifact-edgeless",
    case_id: CASE,
    user_id: USER,
    artifact_type: "freeform_note",
    content_jsonb: {},
    input_hash: "sha256:whatever",
    status: "current",
    produced_by_work_item_id: null,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  fixture.grantPriceApproval();
}

async function main() {
  // ============================================================
  // C1 — recámaras: capa comercial stale; valuación y aprobación intactas
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f);
    f.setFact("property.bedrooms", 4); // corrección

    const result = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.bedrooms" },
    });

    const staledTypes = result.staled.map((s) => s.artifact_type).sort();
    assert.deepEqual(
      staledTypes,
      ["commercial_copy", "listing_description"],
      "C1: solo la capa comercial presente se stalea"
    );
    const unaffectedTypes = result.unaffected.map((u) => u.artifact_type);
    for (const type of [
      "comparable_set",
      "valuation",
      "price_recommendation",
      "contract_draft",
      "watermarked_photos",
      "freeform_note",
    ]) {
      assert.ok(unaffectedTypes.includes(type), `C1: ${type} queda current`);
      assert.equal(f.artifactByType(type).status, "current");
    }
    assert.equal(result.suspended.length, 0, "C1: aprobación de precio intacta");
    assert.equal(f.approvals[0].decision, "approved");
    assert.equal(result.repairWork.length, 2, "C1: repair por artefacto staleado");
    assert.deepEqual(
      result.repairWork.map((w) => w.work_type).sort(),
      ["repair_commercial_copy", "repair_listing_description"]
    );
    assert.equal(f.lastRepairInput.origin, "impact_repair", "origin finding 17");
    for (const item of f.workItems.values()) {
      assert.equal((item as unknown as { origin: string }).origin, "impact_repair");
    }
    assert.ok(
      f.events.every((e) => e.kind === "impact_invalidation"),
      "C1: eventos de invalidación"
    );

    // Idempotencia: el mismo cambio reprocesado no re-stalea ni duplica.
    const again = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.bedrooms" },
    });
    assert.equal(again.staled.length, 0, "C1: segundo pass no re-stalea");
    assert.equal(again.repairWork.length, 0, "C1: sin repair duplicado");
    assert.equal(f.workItems.size, 2);
  }

  // ============================================================
  // C2 — área construida: cadena de valuación stale + aprobación suspendida
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f);
    f.setFact("property.area_construida_m2", 260); // corrección

    const result = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.area_construida_m2" },
    });

    assert.deepEqual(
      result.staled.map((s) => s.artifact_type).sort(),
      ["comparable_set", "price_recommendation", "valuation"],
      "C2: la cadena de valuación completa se stalea"
    );
    assert.deepEqual(
      result.suspended.map((s) => s.approval_kind),
      ["price"],
      "C2: la aprobación de precio se suspende (nunca se revoca)"
    );
    assert.equal(f.approvals[0].decision, "suspended");
    assert.deepEqual(
      result.repairWork.map((w) => w.work_type).sort(),
      ["repair_comparable_set", "repair_price_recommendation", "repair_valuation"],
      "C2: trabajo de revaluación creado"
    );
    // Trabajo/artefactos no relacionados siguen válidos.
    const unaffectedTypes = result.unaffected.map((u) => u.artifact_type);
    for (const type of [
      "listing_description",
      "commercial_copy",
      "contract_draft",
      "watermarked_photos",
      "freeform_note",
    ]) {
      assert.ok(unaffectedTypes.includes(type), `C2: ${type} queda current`);
    }
    assert.ok(
      f.events.some((e) => e.kind === "impact_approval_suspended"),
      "C2: evento de suspensión"
    );

    // Segundo pass: la aprobación ya suspendida no se re-suspende.
    const again = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.area_construida_m2" },
    });
    assert.equal(again.suspended.length, 0, "C2: sin re-suspensión");
  }

  // ============================================================
  // C3 — reemplazo de plantilla: SOLO contract_draft stale + repair
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f);
    f.assets.set("commission_contract_template", "sha256:template-v2");

    const result = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: {
        kind: "account_asset",
        key: "commission_contract_template",
        detail: { content_hash: "sha256:template-v2" },
      },
    });

    assert.deepEqual(
      result.staled.map((s) => s.artifact_type),
      ["contract_draft"],
      "C3: solo el dependiente declarado se stalea"
    );
    assert.deepEqual(result.repairWork.map((w) => w.work_type), [
      "repair_contract_draft",
    ]);
    assert.equal(result.suspended.length, 0, "C3: aprobaciones intactas");
    assert.equal(f.approvals[0].decision, "approved");
    for (const type of [
      "comparable_set",
      "valuation",
      "price_recommendation",
      "listing_description",
      "watermarked_photos",
      "freeform_note",
    ]) {
      assert.equal(f.artifactByType(type).status, "current", `C3: ${type} current`);
    }
  }

  // ============================================================
  // Guardia de sobre-invalidación: entrada sin edges declarados = no-op
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f);
    f.setFact("property.notes", "el propietario prefiere visitas por la tarde");

    const result = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.notes" },
    });

    assert.equal(result.staled.length, 0, "guardia: nada se stalea");
    assert.equal(result.suspended.length, 0);
    assert.equal(result.repairWork.length, 0);
    assert.equal(result.unaffected.length, 8, "guardia: todo queda current");
    assert.equal(f.events.length, 0, "guardia: sin eventos de invalidación");
    assert.equal(
      f.artifactByType("freeform_note").status,
      "current",
      "guardia: el artefacto sin edges jamás se stalea"
    );
  }

  // ============================================================
  // Cascada por referencia de artefacto: cambio de metodología stalea la
  // cadena aunque cada eslabón se recalcule de forma independiente.
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f);
    f.setFact(PROPERTY_OPTIONING_METHODOLOGY_FACT, {
      band: "residential_strict",
      low_pct: -10,
      high_pct: 60,
    });
    const result = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: PROPERTY_OPTIONING_METHODOLOGY_FACT },
    });
    assert.deepEqual(
      result.staled.map((s) => s.artifact_type).sort(),
      ["comparable_set", "price_recommendation", "valuation"],
      "metodología: cadena completa stale"
    );
    assert.deepEqual(result.suspended.map((s) => s.approval_kind), ["price"]);
  }

  // ============================================================
  // 3.3 — cadena grant → suspend → re-approve con evidencia
  // ============================================================
  {
    const f = buildFixture();
    seedPropertyCase(f); // seed ya otorga la aprobación de precio
    const original = f.approvals[0];

    // Cambio de base (C2): la aprobación original se suspende.
    f.setFact("property.area_construida_m2", 245);
    const first = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.area_construida_m2" },
    });
    assert.deepEqual(first.suspended.map((s) => s.id), [original.id]);
    assert.equal(original.decision, "suspended");

    // Re-aprobación humana (3.3-2): fila NUEVA anclada a la evidencia
    // VIGENTE que reemplaza la suspendida. La vieja jamás se reactiva.
    const regrant = f.grantPriceApproval();
    original.superseded_by = regrant.id;
    assert.notEqual(
      regrant.evidence_hash,
      original.evidence_hash,
      "3.3: la re-aprobación pinea una base distinta a la suspendida"
    );

    // Mismo cambio reprocesado: la evidencia nueva coincide con el estado
    // vigente ⇒ la re-aprobación NO se suspende.
    const second = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.area_construida_m2" },
    });
    assert.equal(
      second.suspended.length,
      0,
      "3.3: la re-aprobación con evidencia vigente permanece approved"
    );
    assert.equal(regrant.decision, "approved");
    assert.equal(original.decision, "suspended", "3.3: la fila vieja no se toca");

    // Un cambio de base POSTERIOR vuelve a suspender — ahora a la fila nueva.
    f.setFact("property.neighborhood", "San Salvador Tizatlalli");
    const third = await applyInputChange(f.store, {
      userId: USER,
      caseId: CASE,
      graph: GRAPH,
      workflowDefinitionVersion: 2,
      change: { kind: "fact", key: "property.neighborhood" },
    });
    assert.deepEqual(third.suspended.map((s) => s.id), [regrant.id]);
    assert.equal(regrant.decision, "suspended");
  }

  console.log("impact-engine.selftest: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
