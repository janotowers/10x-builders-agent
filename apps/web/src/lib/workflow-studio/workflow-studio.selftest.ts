/**
 * UI selftest del Workflow Studio shell (Slice 2.7-8): mapeos de
 * status/labels del catálogo, resolver definición-vs-fallback [D 2.7-4] y
 * agregación de readiness de assets del tenant.
 *
 * Ejecutar: npm run test:workflow-studio --workspace @agents/web
 */
import assert from "node:assert/strict";
import type {
  AccountAsset,
  OperationalCaseFlowStep,
  ToolDefinition,
  WorkflowDefinition,
  WorkflowGraph,
} from "@agents/types";
import {
  definitionStatusLabel,
  forkLineageLabel,
  ownerScopeLabel,
  pinnedCasesLabel,
  shortDefinitionHash,
  toDefinitionCatalogRow,
} from "./definition-catalog";
import {
  aggregateTenantAssets,
  resolveRequiredAssetsForDefinition,
  tenantAssetReadinessLabel,
} from "./required-assets";

// ---------------------------------------------------------------------------
// 1. Labels del catálogo: todos los estados/scopes mapeados, sin jerga interna.
// ---------------------------------------------------------------------------

assert.equal(definitionStatusLabel("draft"), "Borrador");
assert.equal(definitionStatusLabel("validated"), "Validada");
assert.equal(definitionStatusLabel("published"), "Publicada");
assert.equal(definitionStatusLabel("deprecated"), "Obsoleta");

assert.equal(ownerScopeLabel("global"), "Global");
assert.equal(ownerScopeLabel("user"), "Privada");
assert.equal(ownerScopeLabel("organization"), "Organización");

assert.equal(shortDefinitionHash("abcdef0123456789deadbeef"), "abcdef012345");

assert.equal(pinnedCasesLabel(0), "Sin casos activos");
assert.equal(pinnedCasesLabel(1), "1 caso activo");
assert.equal(pinnedCasesLabel(3), "3 casos activos");

assert.equal(
  forkLineageLabel({ derived_from_definition_id: null, derived_from_version: null }),
  null
);
assert.equal(
  forkLineageLabel({
    derived_from_definition_id: "11112222333344445555666677778888",
    derived_from_version: 2,
  }),
  "Derivada de 111122223333… v2"
);

const readinessLabels = [
  tenantAssetReadinessLabel("configured"),
  tenantAssetReadinessLabel("missing"),
  tenantAssetReadinessLabel("optional_missing"),
];
assert.deepEqual(readinessLabels, [
  "Configurado",
  "Falta subir",
  "Opcional (sin archivo)",
]);
for (const label of readinessLabels) {
  assert.ok(
    !/heartbeat|jsonb|graph_jsonb/i.test(label),
    "los labels no exponen jerga interna"
  );
}

// ---------------------------------------------------------------------------
// Fixtures compartidas para resolver + agregación.
// ---------------------------------------------------------------------------

const CONTRACT_ASSET = {
  asset_key: "commission_contract_template",
  label: "Plantilla de contrato de comisión",
  accept: [".docx"],
  max_size_mb: 15,
  required: true,
};

const WATERMARK_ASSET = {
  asset_key: "listing_photo_watermark",
  label: "Marca de agua para fotos",
  required: false,
};

function makeGraph(withAssets: boolean): WorkflowGraph {
  return {
    states: [
      { key: "intake", label: "Registro", kind: "operational" },
      { key: "contract_pending", label: "Preparar contrato", kind: "operational" },
      { key: "done", label: "Terminado", kind: "terminal" },
    ],
    transitions: [
      {
        from: "intake",
        to: "contract_pending",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
      {
        from: "contract_pending",
        to: "done",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
    ],
    step_bindings: [
      { state: "intake", skill: null },
      {
        state: "contract_pending",
        skill: "prepare-commission-contract",
        ...(withAssets ? { required_assets: [CONTRACT_ASSET] } : {}),
      },
    ],
    work_templates: [],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["done"], required_evidence: [] },
  };
}

function makeDefinition(withAssets: boolean): WorkflowDefinition {
  return {
    id: "def-1",
    owner_scope: "global",
    user_id: null,
    organization_id: null,
    case_type: "property_optioning",
    workflow_key: "property_optioning",
    version: 3,
    status: "published",
    industry: null,
    domain_tags: [],
    business_spec_jsonb: {},
    implementation_spec_jsonb: {},
    graph_jsonb: makeGraph(withAssets),
    definition_hash: "feedfacecafebeef0011223344556677",
    derived_from_definition_id: null,
    derived_from_version: null,
    visibility: "shared_template",
    published_at: "2026-08-01T00:00:00Z",
    published_by: null,
    provenance_jsonb: {},
    created_at: "2026-08-01T00:00:00Z",
  };
}

const labFlow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Registro" },
  {
    step_key: "contract_pending",
    step_label: "Preparar contrato",
    step_skills: [
      {
        skill_slug: "prepare-commission-contract",
        skill_tools: [
          {
            tool_id: "generate_document_from_template",
            required_assets: [CONTRACT_ASSET],
          },
        ],
      },
    ],
  },
  {
    step_key: "photos",
    step_label: "Fotos",
    step_skills: [
      {
        skill_slug: "request-property-photos",
        skill_tools: [{ tool_id: "image_watermark" }],
      },
    ],
  },
];

// Catálogo de tools: image_watermark declara la marca de agua como default de
// cuenta (igual que TOOL_CATALOG real) — el fallback debe hacer ese merge.
const catalogById = new Map<string, ToolDefinition>([
  [
    "image_watermark",
    {
      id: "image_watermark",
      asset_profile: { account: [WATERMARK_ASSET] },
    } as unknown as ToolDefinition,
  ],
]);

// ---------------------------------------------------------------------------
// 2. Resolver [D 2.7-4]: la definición publicada con required_assets gana.
// ---------------------------------------------------------------------------

const fromDefinition = resolveRequiredAssetsForDefinition({
  definition: makeDefinition(true),
  fallback: { flow: labFlow, catalogById },
});
assert.equal(fromDefinition.length, 1, "solo los assets del grafo");
assert.equal(fromDefinition[0].source, "definition");
assert.equal(fromDefinition[0].requirement.asset_key, "commission_contract_template");
assert.equal(fromDefinition[0].stepKey, "contract_pending");
assert.equal(fromDefinition[0].stepLabel, "Preparar contrato");
assert.equal(fromDefinition[0].definitionVersion, 3);

// ---------------------------------------------------------------------------
// 3. Resolver: sin assets en el grafo → fallback del lab (flow + catálogo).
// ---------------------------------------------------------------------------

const fromFallback = resolveRequiredAssetsForDefinition({
  definition: makeDefinition(false),
  fallback: { flow: labFlow, catalogById },
});
assert.deepEqual(
  fromFallback.map((item) => [item.requirement.asset_key, item.source, item.stepKey]),
  [
    ["commission_contract_template", "lab_fallback", "contract_pending"],
    ["listing_photo_watermark", "lab_fallback", "photos"],
  ],
  "el fallback merge-a overrides del flow + defaults del catálogo, por paso"
);

// Sin fallback disponible → lista vacía, jamás inventa assets.
assert.deepEqual(
  resolveRequiredAssetsForDefinition({ definition: makeDefinition(false) }),
  []
);

// ---------------------------------------------------------------------------
// 4. Agregación de readiness: dedupe por asset_key, gana el detalle de la
//    definición, faltantes primero.
// ---------------------------------------------------------------------------

function makeAccountAsset(assetKey: string): AccountAsset {
  return {
    id: `asset-${assetKey}`,
    user_id: "user-1",
    asset_key: assetKey,
    display_name: assetKey,
    description: null,
    storage_bucket: "account-assets",
    storage_path: `user-1/${assetKey}/file.bin`,
    content_type: "application/octet-stream",
    file_size_bytes: 1024,
    source_tool_id: null,
    case_type_id: null,
    metadata_jsonb: {},
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  } as AccountAsset;
}

// El contrato aparece por dos fuentes (definición y fallback de otro case
// type): una sola entrada, requirement de la definición, dos consumidores.
const aggregated = aggregateTenantAssets(
  [
    ...fromDefinition,
    {
      requirement: { ...CONTRACT_ASSET, label: "Otro label del lab" },
      source: "lab_fallback",
      caseType: "other_case",
      stepKey: "contract_pending",
    },
    ...fromFallback.filter(
      (item) => item.requirement.asset_key === "listing_photo_watermark"
    ),
  ],
  [makeAccountAsset("listing_photo_watermark")]
);

assert.equal(aggregated.length, 2, "dedupe por asset_key");

const contractEntry = aggregated.find(
  (entry) => entry.assetKey === "commission_contract_template"
);
assert.ok(contractEntry);
assert.equal(
  contractEntry.status.label,
  "Plantilla de contrato de comisión",
  "en conflicto de detalle gana el requirement con fuente definition"
);
assert.equal(contractEntry.consumers.length, 2);
assert.equal(contractEntry.readiness, "missing", "requerido sin archivo");
assert.equal(contractEntry.status.configured, false);

const watermarkEntry = aggregated.find(
  (entry) => entry.assetKey === "listing_photo_watermark"
);
assert.ok(watermarkEntry);
assert.equal(watermarkEntry.readiness, "configured");
assert.equal(watermarkEntry.status.asset?.asset_key, "listing_photo_watermark");

// Orden: faltantes antes que configurados.
assert.deepEqual(
  aggregated.map((entry) => entry.readiness),
  ["missing", "configured"]
);

// Opcional sin archivo → optional_missing (no alarma como faltante duro).
const optionalOnly = aggregateTenantAssets(
  fromFallback.filter(
    (item) => item.requirement.asset_key === "listing_photo_watermark"
  ),
  []
);
assert.equal(optionalOnly[0].readiness, "optional_missing");

// ---------------------------------------------------------------------------
// 5. Fila del catálogo: mapping completo.
// ---------------------------------------------------------------------------

const row = toDefinitionCatalogRow(makeDefinition(true), { "def-1": 2 });
assert.equal(row.statusLabel, "Publicada");
assert.equal(row.scopeLabel, "Global");
assert.equal(row.shortHash, "feedfacecafe");
assert.equal(row.pinnedActiveCases, 2);
assert.equal(row.pinnedLabel, "2 casos activos");
assert.equal(row.lineage, null);

console.log("workflow-studio.selftest: OK");
