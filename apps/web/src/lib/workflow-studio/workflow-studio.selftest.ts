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
  approvalKindLabel,
  checkLabel,
  definitionStatusLabel,
  emptyWorkTemplatesMessage,
  evidenceInputLabel,
  filterCatalogDefinitions,
  findIdenticalOwnFork,
  forkLineageLabel,
  friendlyCaseTypeLabel,
  groupDefinitionFamilies,
  happyPathStates,
  isInternalTestDefinition,
  ownerScopeLabel,
  pinnedCasesLabel,
  resolveForkLineageLabel,
  shortDefinitionHash,
  toDefinitionCatalogRow,
  transitionSummary,
} from "./definition-catalog";
import {
  applyGraphOnlyStepFallbacks,
  helpCatalogFromFlow,
  looksLikeTechnicalSkillCopy,
  mergeSkillRegistryHelp,
  resolveSkillDescription,
  resolveSkillRoutingHint,
  resolveSkillTechnicalNotes,
  resolveStepDescription,
  softenSkillCopyForOperator,
  splitSkillDescriptionForStudio,
  studioLabelsEquivalent,
  withRootSkill,
} from "./definition-help";
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

// ---------------------------------------------------------------------------
// 6. Filtro soak, familias, linaje amigable, dedupe fork, copy work_templates.
// ---------------------------------------------------------------------------

assert.equal(isInternalTestDefinition({ case_type: "work_plane_soak_synthetic" }), true);
assert.equal(isInternalTestDefinition({ case_type: "property_optioning" }), false);
assert.equal(
  friendlyCaseTypeLabel("property_optioning"),
  "Opcionamiento de propiedad"
);
assert.equal(friendlyCaseTypeLabel("lead_follow_up"), "Seguimiento de leads");
assert.equal(friendlyCaseTypeLabel("custom_flow_x"), "Custom Flow X");
assert.equal(approvalKindLabel("price"), "Aprobación de precio");
assert.equal(checkLabel("publication_preflight"), "Verificación previa a la publicación");
assert.equal(evidenceInputLabel("comparables_analysis"), "Análisis de comparables");
assert.ok(
  emptyWorkTemplatesMessage().includes("plano de trabajo"),
  "mensaje estable cuando no hay work_templates"
);

const globalPublished = makeDefinition(true);
const soakV1: WorkflowDefinition = {
  ...makeDefinition(false),
  id: "soak-1",
  case_type: "work_plane_soak_synthetic",
  workflow_key: "work_plane_soak_synthetic",
  version: 1,
  status: "published",
  definition_hash: "soakhash0001",
};
const soakV2: WorkflowDefinition = {
  ...soakV1,
  id: "soak-2",
  version: 2,
  definition_hash: "soakhash0002",
};
const privateDraftV1: WorkflowDefinition = {
  ...globalPublished,
  id: "priv-1",
  owner_scope: "user",
  user_id: "user-1",
  version: 1,
  status: "draft",
  definition_hash: globalPublished.definition_hash,
  derived_from_definition_id: globalPublished.id,
  derived_from_version: 3,
  published_at: null,
  visibility: "private",
};
const privateDraftV2: WorkflowDefinition = {
  ...privateDraftV1,
  id: "priv-2",
  version: 2,
};

const filtered = filterCatalogDefinitions(
  [globalPublished, soakV1, soakV2, privateDraftV1],
  { showTests: false }
);
assert.deepEqual(
  filtered.map((definition) => definition.id).sort(),
  ["def-1", "priv-1"]
);
assert.equal(
  filterCatalogDefinitions([globalPublished, soakV1], { showTests: true }).length,
  2
);

const families = groupDefinitionFamilies(
  [globalPublished, privateDraftV1, privateDraftV2, soakV1, soakV2],
  { "def-1": 3, "soak-2": 0 }
);
assert.equal(families.length, 3, "tres familias: privada, global, soak");
const privateFamily = families.find((family) => family.ownerScope === "user");
assert.ok(privateFamily);
assert.equal(privateFamily.head.id, "priv-2", "draft de mayor versión es cabeza");
assert.equal(privateFamily.draftCount, 2);
assert.equal(privateFamily.pinnedActiveCases, 0, "drafts no aportan pins; sin published propia");
const globalFamily = families.find(
  (family) =>
    family.ownerScope === "global" && family.caseType === "property_optioning"
);
assert.ok(globalFamily);
assert.equal(globalFamily.head.id, "def-1");
assert.equal(globalFamily.pinnedActiveCases, 3);
assert.equal(families[0].ownerScope, "user", "Mis flujos primero");

const byId = new Map(
  [globalPublished, privateDraftV2].map((definition) => [definition.id, definition])
);
assert.equal(
  resolveForkLineageLabel(privateDraftV2, byId),
  "Fork de property_optioning Global v3"
);
assert.equal(
  resolveForkLineageLabel(
    {
      derived_from_definition_id: "missing-id-000000000000000000000000",
      derived_from_version: 1,
    },
    byId
  ),
  "Derivada de missing-id-0… v1"
);

const identical = findIdenticalOwnFork(
  [privateDraftV1, privateDraftV2],
  globalPublished
);
assert.ok(identical);
assert.equal(identical.id, "priv-2", "elige el de mayor versión");
assert.equal(
  findIdenticalOwnFork(
    [{ ...privateDraftV2, definition_hash: "otro-hash" }],
    globalPublished
  ),
  null,
  "hash distinto no es idéntico"
);

const path = happyPathStates(globalPublished.graph_jsonb);
assert.equal(path[0].label, "Registro");
assert.equal(path[path.length - 1].isTerminal, true);
const transitions = transitionSummary(globalPublished.graph_jsonb);
assert.equal(transitions[0].fromLabel, "Registro");
assert.equal(transitions[0].toLabel, "Preparar contrato");

// ---------------------------------------------------------------------------
// 7. Ayudas/descripciones: prioriza copy de operador; jerga → notas técnicas.
// ---------------------------------------------------------------------------

const helpFromFlow = helpCatalogFromFlow([
  {
    step_key: "intake",
    step_label: "Registro",
    step_description: "Recolecta los datos mínimos del caso.",
    step_skills: [
      {
        skill_slug: "request-property-documents",
        skill_label: "Pedir documentos",
        skill_description: "Prepara el mensaje al propietario.",
      },
    ],
  },
]);
assert.equal(
  resolveStepDescription("intake", helpFromFlow),
  "Recolecta los datos mínimos del caso."
);
assert.equal(
  resolveSkillDescription("request-property-documents", helpFromFlow),
  "Prepara el mensaje al propietario."
);

const merged = mergeSkillRegistryHelp(helpFromFlow, [
  {
    name: "request-property-documents",
    description: "Descripción del registry que NO debe sobrescribir el flow.",
  },
  {
    name: "prepare-listing-price",
    description: "Primera línea del registry.\n\nPárrafo largo ignorado.",
  },
]);
assert.equal(
  resolveSkillDescription("request-property-documents", merged),
  "Prepara el mensaje al propietario.",
  "el flow humano no se sobrescribe"
);
assert.equal(
  resolveSkillDescription("prepare-listing-price", merged),
  "Primera línea del registry. Párrafo largo ignorado."
);
assert.equal(resolveStepDescription("missing", merged), null);

const technicalFlow = helpCatalogFromFlow([
  {
    step_key: "awaiting_documents",
    step_label: "Reunir documentos",
    step_skills: [
      {
        skill_slug: "request-property-documents",
        skill_label: "Solicitud de documentos",
        skill_description:
          "Según `document_request_target`: pide subida al equipo interno (`notify_user`) o Telegram.",
      },
    ],
  },
]);
assert.ok(
  looksLikeTechnicalSkillCopy(
    "Según `document_request_target`: pide (`notify_user`)."
  )
);
assert.equal(
  resolveSkillTechnicalNotes("request-property-documents", technicalFlow),
  "Según `document_request_target`: pide subida al equipo interno (`notify_user`) o Telegram."
);
assert.ok(
  !resolveSkillDescription(
    "request-property-documents",
    technicalFlow
  )?.includes("document_request_target"),
  "el summary suaviza tokens de lab"
);
assert.ok(
  resolveSkillDescription(
    "request-property-documents",
    technicalFlow
  )?.includes("quién debe aportar los documentos")
);

const operatorOverTechnical = mergeSkillRegistryHelp(technicalFlow, [
  {
    name: "request-property-documents",
    description: "Reúne el expediente documental del inmueble para el asesor.",
  },
]);
assert.equal(
  resolveSkillDescription(
    "request-property-documents",
    operatorOverTechnical
  ),
  "Reúne el expediente documental del inmueble para el asesor.",
  "registry humano gana sobre flow técnico"
);
assert.ok(
  resolveSkillTechnicalNotes(
    "request-property-documents",
    operatorOverTechnical
  )?.includes("document_request_target"),
  "la jerga del flow queda como nota técnica"
);

const softened = softenSkillCopyForOperator(
  "En `awaiting_documents` usa notify_user según document_request_target."
);
assert.equal(
  softened.summary,
  "En el paso de espera de documentos usa notificación al asesor según quién debe aportar los documentos."
);
assert.ok(softened.technicalNotes);

assert.ok(studioLabelsEquivalent("Reunir documentos", "reunir documentos"));
assert.ok(!studioLabelsEquivalent("Reunir documentos", "Solicitud de documentos"));

const splitMixed = splitSkillDescriptionForStudio(
  "Procedimiento end-to-end para obtener la exclusiva. Use when the case_type is `property_optioning`. Do not use for other workflows."
);
assert.equal(
  splitMixed.summary,
  "Procedimiento end-to-end para obtener la exclusiva."
);
assert.equal(
  splitMixed.routing,
  "Use when the case_type is `property_optioning`. Do not use for other workflows."
);
assert.equal(
  splitSkillDescriptionForStudio("Solo descripción humana.").routing,
  null
);

const withRoot = withRootSkill(merged, "property-optioning-coach", [
  {
    name: "property-optioning-coach",
    description:
      "Coach end-to-end del flujo.\nUse when the user wants to opcionar una propiedad.",
    includes: ["request-property-documents", "prepare-listing-price"],
  },
]);
assert.ok(withRoot.rootSkill);
assert.equal(withRoot.rootSkill.slug, "property-optioning-coach");
assert.equal(withRoot.rootSkill.description, "Coach end-to-end del flujo.");
assert.equal(
  withRoot.rootSkill.routingHint,
  "Use when the user wants to opcionar una propiedad."
);
assert.equal(withRoot.rootSkill.technicalNotes, null);
assert.deepEqual(withRoot.rootSkill.includes, [
  "request-property-documents",
  "prepare-listing-price",
]);

const registrySplit = mergeSkillRegistryHelp(helpCatalogFromFlow([]), [
  {
    name: "publish-listing-package",
    description:
      "Publica el paquete final. Use when the case reaches package_ready.",
  },
]);
assert.equal(
  resolveSkillDescription("publish-listing-package", registrySplit),
  "Publica el paquete final."
);
assert.equal(
  resolveSkillRoutingHint("publish-listing-package", registrySplit),
  "Use when the case reaches package_ready."
);

const withFallback = applyGraphOnlyStepFallbacks(merged, {
  ...globalPublished.graph_jsonb,
  states: [
    ...globalPublished.graph_jsonb.states,
    {
      key: "property_data_review",
      label: "Revisión de datos",
      kind: "operational",
    },
  ],
});
assert.ok(
  resolveStepDescription("property_data_review", withFallback)?.includes(
    "Revisión humana"
  ),
  "fallback para estados solo-del-grafo"
);
assert.equal(
  resolveStepDescription("intake", applyGraphOnlyStepFallbacks(helpFromFlow, {
    ...globalPublished.graph_jsonb,
    states: [{ key: "intake", kind: "operational" }],
  })),
  "Recolecta los datos mínimos del caso.",
  "el fallback no sobrescribe el flow"
);

console.log("workflow-studio.selftest: OK");
