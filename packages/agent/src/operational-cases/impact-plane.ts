/**
 * Wiring del plano de impacto (Slice 3.2-4): enlaza el `ImpactPlaneStore`
 * del motor (@agents/workflows) a las queries de @agents/db y expone los
 * dos puntos de entrada de producción:
 *
 *   - `recordCaseFactsAndApplyImpact`: escritura de hechos (case_facts, con
 *     clase de fuente y procedencia) junto al context_jsonb existente + un
 *     pass del motor por cada hecho realmente cambiado. Solo casos v2
 *     (tenant con `work_plane_v2` + caso pineado a definición publicada);
 *     para todo lo demás es un no-op explícito.
 *   - `applyAccountAssetImpact`: reemplazo de un asset del tenant → pass del
 *     motor sobre cada caso pineado cuya definición declara ese asset
 *     (escenario C3: solo los dependientes declarados se stalean).
 *
 * Ambos son best-effort desde el punto de vista del caller: los call sites
 * los envuelven en try/catch — una falla del plano de impacto jamás rompe
 * la escritura principal del caso.
 */
import {
  createWorkItemsFromTemplates,
  getCaseApprovalById,
  getCurrentCaseFacts,
  getLatestAccountAssetVersionByKey,
  getLatestCaseApproval,
  getPublishedDefinition,
  insertCaseApproval,
  insertCaseFact,
  insertOperationalCaseEvent,
  isWorkPlaneV2Enabled,
  listCaseApprovalsForCase,
  listCaseArtifactsForCase,
  listPinnedActiveOperationalCases,
  suspendCaseApproval,
  updateCaseArtifactStatus,
  upsertActiveInternalUserNotification,
  type DbClient,
  type InsertCaseApprovalResult,
} from "@agents/db";
import type {
  CaseApprovalDecision,
  CaseFactSourceKind,
  OperationalCase,
  WorkflowGraph,
} from "@agents/types";
import {
  applyInputChange,
  buildEvidenceEntries,
  canonicalizeJson,
  computeImpactInputHash,
  normalizeImpactValue,
  parseImpactInputRef,
  type ImpactChangeResult,
  type ImpactPlaneStore,
  type ImpactSnapshot,
} from "@agents/workflows";

export function bindImpactPlaneStore(db: DbClient): ImpactPlaneStore {
  return {
    getCurrentFacts: async (userId, caseId) => {
      const byKey = await getCurrentCaseFacts(db, userId, caseId);
      return [...byKey.values()];
    },
    listCaseArtifacts: (userId, caseId) =>
      listCaseArtifactsForCase(db, userId, caseId),
    updateArtifactStatus: (input) =>
      updateCaseArtifactStatus(db, {
        userId: input.userId,
        artifactId: input.artifactId,
        status: input.status,
        expectedVersion: input.expectedVersion,
      }),
    getLatestAssetVersionIdentity: async (userId, assetKey) => {
      const version = await getLatestAccountAssetVersionByKey(
        db,
        userId,
        assetKey
      );
      if (!version) return null;
      // content_hash pinea contenido; el fallback por id de versión cubre
      // filas pre-backfill (detecta reemplazo aunque no haya hash).
      return version.content_hash ?? `version:${version.id}`;
    },
    listCurrentApprovals: (userId, caseId) =>
      listCaseApprovalsForCase(db, userId, caseId),
    suspendApproval: async (input) => {
      const outcome = await suspendCaseApproval(db, input);
      return outcome.suspended;
    },
    appendInvalidationEvent: async (input) => {
      await insertOperationalCaseEvent(db, {
        caseId: input.caseId,
        eventType: "state_changed",
        actor: "system",
        payload: input.payload,
      });
    },
    createRepairWorkItems: (input) =>
      createWorkItemsFromTemplates(db, {
        userId: input.userId,
        caseId: input.caseId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        origin: input.origin,
        templates: input.templates,
      }),
  };
}

function sameNormalizedValue(a: unknown, b: unknown): boolean {
  return (
    canonicalizeJson(normalizeImpactValue(a)) ===
    canonicalizeJson(normalizeImpactValue(b))
  );
}

async function loadPinnedGraph(
  db: DbClient,
  opCase: OperationalCase
): Promise<WorkflowGraph | null> {
  if (!opCase.workflow_definition_id || !opCase.workflow_definition_version) {
    return null;
  }
  const definition = await getPublishedDefinition(
    db,
    opCase.workflow_definition_id,
    opCase.workflow_definition_version
  );
  if (!definition) return null;
  return definition.graph_jsonb as WorkflowGraph;
}

/**
 * Snapshot vigente del caso para hashing de evidencia: hechos actuales +
 * identidad de la versión vigente de cada asset referenciado por el grafo.
 */
async function buildCaseImpactSnapshot(
  db: DbClient,
  userId: string,
  caseId: string,
  graph: WorkflowGraph
): Promise<ImpactSnapshot> {
  const byKey = await getCurrentCaseFacts(db, userId, caseId);
  const facts = new Map<string, unknown>();
  for (const fact of byKey.values()) facts.set(fact.fact_key, fact.value_jsonb);

  const assetKeys = new Set<string>();
  const collect = (entries: readonly string[]) => {
    for (const entry of entries) {
      const ref = parseImpactInputRef(entry);
      if (ref.kind === "account_asset") assetKeys.add(ref.key);
    }
  };
  for (const entries of Object.values(graph.impact_dependencies ?? {})) {
    collect(entries);
  }
  for (const approval of graph.approvals ?? []) collect(approval.evidence_inputs);

  const assets = new Map<string, string | null>();
  for (const assetKey of assetKeys) {
    const version = await getLatestAccountAssetVersionByKey(db, userId, assetKey);
    assets.set(
      assetKey,
      version ? (version.content_hash ?? `version:${version.id}`) : null
    );
  }
  return { facts, assets };
}

export interface CaseApprovalEvidence {
  evidenceHash: string;
  /** Entradas resueltas al momento de construir (qué vio/vería el humano). */
  entries: Record<string, unknown>;
  evidenceInputs: string[];
}

/**
 * Evidencia vigente para una aprobación del caso (Slice 3.3). Null cuando el
 * tenant no está en v2, el caso no está pineado, o la definición no declara
 * esa clase de aprobación.
 */
export async function buildCaseApprovalEvidence(
  db: DbClient,
  params: { userId: string; opCase: OperationalCase; approvalKind: string }
): Promise<CaseApprovalEvidence | null> {
  if (!(await isWorkPlaneV2Enabled(db, params.userId))) return null;
  const graph = await loadPinnedGraph(db, params.opCase);
  if (!graph) return null;
  const spec = (graph.approvals ?? []).find(
    (approval) => approval.kind === params.approvalKind
  );
  if (!spec) return null;
  const snapshot = await buildCaseImpactSnapshot(
    db,
    params.userId,
    params.opCase.id,
    graph
  );
  const entries = buildEvidenceEntries(
    graph.impact_dependencies ?? {},
    spec.evidence_inputs,
    snapshot
  );
  return {
    evidenceHash: computeImpactInputHash(entries),
    entries,
    evidenceInputs: [...spec.evidence_inputs],
  };
}

/**
 * Registra una decisión de aprobación anclada a la evidencia vigente
 * (Slice 3.3-1). Inserta fila nueva y reemplaza (superseded_by) la anterior
 * no-reemplazada de la misma clase — historia siempre por inserción, nunca
 * edición. No-op (null) fuera de v2 o sin clase declarada en la definición.
 */
export async function grantCaseApprovalWithEvidence(
  db: DbClient,
  params: {
    userId: string;
    opCase: OperationalCase;
    approvalKind: string;
    decision: Extract<CaseApprovalDecision, "approved" | "rejected" | "revoked">;
    decidedBy?: string | null;
    rationale?: string | null;
  }
): Promise<InsertCaseApprovalResult | null> {
  const evidence = await buildCaseApprovalEvidence(db, {
    userId: params.userId,
    opCase: params.opCase,
    approvalKind: params.approvalKind,
  });
  if (!evidence) return null;
  const prior = await getLatestCaseApproval(
    db,
    params.userId,
    params.opCase.id,
    params.approvalKind
  );
  return insertCaseApproval(db, {
    userId: params.userId,
    caseId: params.opCase.id,
    approvalKind: params.approvalKind,
    decision: params.decision,
    evidenceHash: evidence.evidenceHash,
    evidenceSnapshot: {
      inputs: evidence.evidenceInputs,
      entries: evidence.entries,
    },
    decidedBy: params.decidedBy ?? null,
    rationale: params.rationale ?? null,
    supersedesApprovalId: prior?.id ?? null,
  });
}

/**
 * Slice 3.3-2: una suspensión mecánica aflora como pendiente humano
 * (`approval_suspended`) con base vieja (snapshot guardado en la aprobación)
 * y base nueva (evidencia recalculada). La decisión humana re-aprueba (fila
 * nueva que reemplaza) o revoca — nunca este código.
 */
async function surfaceSuspendedApprovals(
  db: DbClient,
  params: {
    userId: string;
    opCase: OperationalCase;
    suspended: ImpactChangeResult["suspended"];
    changedInput: string;
  }
): Promise<void> {
  for (const entry of params.suspended) {
    try {
      const approval = await getCaseApprovalById(db, params.userId, entry.id);
      if (!approval) continue;
      const evidence = await buildCaseApprovalEvidence(db, {
        userId: params.userId,
        opCase: params.opCase,
        approvalKind: approval.approval_kind,
      });
      await upsertActiveInternalUserNotification(db, {
        userId: params.userId,
        caseId: params.opCase.id,
        kind: "approval_suspended",
        title: `Aprobación en pausa: ${approval.approval_kind === "price" ? "precio" : approval.approval_kind}`,
        body: `Cambió la información que sustentaba la aprobación (${params.changedInput}). Revisa la base nueva y responde RE-APROBAR para confirmarla o REVOCAR para retirarla.`,
        metadata: {
          approval_id: approval.id,
          approval_kind: approval.approval_kind,
          changed_input: params.changedInput,
          prior_evidence_hash: approval.evidence_hash,
          old_basis: approval.evidence_snapshot_jsonb,
          ...(evidence
            ? {
                expected_evidence_hash: evidence.evidenceHash,
                new_basis: { inputs: evidence.evidenceInputs, entries: evidence.entries },
              }
            : {}),
        },
      });
    } catch (notifyError) {
      console.error(
        "[impact-plane] failed to surface suspended approval:",
        notifyError
      );
    }
  }
}

export interface RecordCaseFactsResult {
  /** Fact keys realmente cambiadas (las no-op no se escriben). */
  recorded: string[];
  impact: ImpactChangeResult[];
}

/**
 * Escribe hechos del caso y corre el motor de impacto por cada hecho que
 * cambió de verdad (comparación normalizada: "3" ≡ 3, trims). No-op cuando
 * el tenant no está en v2 o el caso no está pineado a una definición.
 */
export async function recordCaseFactsAndApplyImpact(
  db: DbClient,
  params: {
    userId: string;
    opCase: OperationalCase;
    /** Claves planas del patch (p. ej. intake) → valor nuevo. */
    factPatch: Record<string, unknown>;
    /** Prefijo del namespace de fact keys. Default: "property.". */
    factKeyPrefix?: string;
    sourceKind: CaseFactSourceKind;
    /** Procedencia (tool call id, mensaje, origen del merge…). */
    sourceRef?: string | null;
  }
): Promise<RecordCaseFactsResult | null> {
  const { userId, opCase } = params;
  const entries = Object.entries(params.factPatch).filter(
    ([, value]) => value !== undefined
  );
  if (entries.length === 0) return null;
  if (!(await isWorkPlaneV2Enabled(db, userId))) return null;
  const graph = await loadPinnedGraph(db, opCase);
  if (!graph) return null;

  const prefix = params.factKeyPrefix ?? "property.";
  const currentFacts = await getCurrentCaseFacts(db, userId, opCase.id);

  const changedKeys: string[] = [];
  for (const [key, value] of entries) {
    const factKey = `${prefix}${key}`;
    const prior = currentFacts.get(factKey);
    if (prior && sameNormalizedValue(prior.value_jsonb, value)) continue;
    await insertCaseFact(db, {
      userId,
      caseId: opCase.id,
      factKey,
      value,
      sourceKind: params.sourceKind,
      sourceRef: params.sourceRef ?? null,
    });
    changedKeys.push(factKey);
  }

  const store = bindImpactPlaneStore(db);
  const impact: ImpactChangeResult[] = [];
  for (const factKey of changedKeys) {
    const result = await applyInputChange(store, {
      userId,
      caseId: opCase.id,
      graph,
      workflowDefinitionVersion: opCase.workflow_definition_version as number,
      change: {
        kind: "fact",
        key: factKey,
        detail: { source_kind: params.sourceKind },
      },
    });
    if (result.suspended.length > 0) {
      await surfaceSuspendedApprovals(db, {
        userId,
        opCase,
        suspended: result.suspended,
        changedInput: factKey,
      });
    }
    impact.push(result);
  }
  return { recorded: changedKeys, impact };
}

export interface AccountAssetImpactResult {
  caseId: string;
  result: ImpactChangeResult;
}

/**
 * Reemplazo de un asset del tenant: corre el motor sobre cada caso pineado
 * cuya definición declara `account_asset:<assetKey>` en sus edges (C3).
 */
export async function applyAccountAssetImpact(
  db: DbClient,
  params: { userId: string; assetKey: string; detail?: Record<string, unknown> }
): Promise<AccountAssetImpactResult[]> {
  const { userId, assetKey } = params;
  if (!(await isWorkPlaneV2Enabled(db, userId))) return [];
  const marker = `account_asset:${assetKey}`;
  const results: AccountAssetImpactResult[] = [];
  const store = bindImpactPlaneStore(db);
  const graphCache = new Map<string, WorkflowGraph | null>();

  const pinned = await listPinnedActiveOperationalCases(db, userId);
  for (const opCase of pinned) {
    const cacheKey = `${opCase.workflow_definition_id}:${opCase.workflow_definition_version}`;
    let graph = graphCache.get(cacheKey);
    if (graph === undefined) {
      graph = await loadPinnedGraph(db, opCase);
      graphCache.set(cacheKey, graph);
    }
    if (!graph) continue;
    const declared = Object.values(graph.impact_dependencies ?? {}).some(
      (deps) => deps.includes(marker)
    );
    if (!declared) continue;
    const result = await applyInputChange(store, {
      userId,
      caseId: opCase.id,
      graph,
      workflowDefinitionVersion: opCase.workflow_definition_version as number,
      change: {
        kind: "account_asset",
        key: assetKey,
        detail: params.detail,
      },
    });
    if (result.suspended.length > 0) {
      await surfaceSuspendedApprovals(db, {
        userId,
        opCase,
        suspended: result.suspended,
        changedInput: marker,
      });
    }
    results.push({ caseId: opCase.id, result });
  }
  return results;
}
