/**
 * Motor de impacto (Slice 3.2; Technical Plan §11/§20 `ImpactEngine`).
 *
 * `applyInputChange` recibe UN cambio de entrada (hecho corregido o asset
 * reemplazado) y responde con precisión selectiva:
 *
 *   - Recalcula el input-hash SOLO de los artefactos cuyos edges declarados
 *     (`impact_dependencies` de la definición) incluyen la entrada cambiada
 *     — el sistema NUNCA infiere dependencias universales por nombre de
 *     campo. Hash distinto ⇒ `stale` + evento de invalidación + template de
 *     reparación mínimo (`origin='impact_repair'`, finding 17). Hash igual
 *     ⇒ el artefacto queda `current`: esa es la garantía anti
 *     sobre-invalidación.
 *   - Aprobaciones cuyo `evidence_hash` deja de coincidir se SUSPENDEN
 *     (acto mecánico reversible). El motor NUNCA revoca ni re-otorga: no
 *     existe camino de re-grant aquí — re-aprobar es una decisión humana
 *     (Slice 3.3), y ningún hecho de fuente externa satisface una
 *     postcondición de aprobación sin ese humano (Technical Plan §21).
 *
 * El hash esperado de un tipo es función PURA del estado vigente: hechos
 * actuales, versión vigente de assets y — recursivamente — el hash esperado
 * de los artefactos declarados como entrada. Así el staleness cascadea por
 * la cadena (comparable_set → valuation → price_recommendation) sin
 * necesidad de aristas inversas materializadas.
 *
 * Mismo patrón de ports que el dispatcher: este paquete no toca la base de
 * datos; el caller enlaza las queries de @agents/db (`ImpactPlaneStore`) y
 * producción, lab y selftests ejecutan exactamente este objeto (regla 7).
 */
import type {
  CaseApproval,
  CaseArtifact,
  CaseFact,
  WorkItem,
  WorkItemTemplateSpec,
  WorkflowGraph,
} from "@agents/types";
import { computeImpactInputHash } from "./impact-hash";

// ============================================================
// Vocabulario de entradas declaradas
// ============================================================

export type ImpactInputRef =
  | { kind: "fact"; key: string }
  | { kind: "artifact"; key: string }
  | { kind: "account_asset"; key: string };

/**
 * `artifact:<tipo>` y `account_asset:<clave>` son referencias tipadas; todo
 * lo demás es una fact key. Entradas legacy sin prefijo (p. ej.
 * `comparable_set` en definiciones v1 ya publicadas e inmutables) parsean
 * como fact keys que ningún hecho escribe: inofensivas (jamás sobre-
 * invalidan); el mapa completo entra al siguiente publish.
 */
export function parseImpactInputRef(entry: string): ImpactInputRef {
  if (entry.startsWith("artifact:")) {
    return { kind: "artifact", key: entry.slice("artifact:".length) };
  }
  if (entry.startsWith("account_asset:")) {
    return { kind: "account_asset", key: entry.slice("account_asset:".length) };
  }
  return { kind: "fact", key: entry };
}

// ============================================================
// Hash esperado por tipo (función pura del estado vigente)
// ============================================================

export interface ImpactSnapshot {
  /** fact_key → valor vigente (value_jsonb del case_fact no reemplazado). */
  facts: ReadonlyMap<string, unknown>;
  /**
   * asset_key → identidad de la versión vigente: `content_hash` si existe,
   * o un marcador estable de la versión (fallback pre-backfill). Ausente ⇒
   * el asset no existe para el tenant.
   */
  assets: ReadonlyMap<string, string | null>;
}

function resolveEntries(
  deps: Record<string, string[]>,
  artifactType: string,
  snapshot: ImpactSnapshot,
  memo: Map<string, string>,
  visiting: Set<string>
): string {
  const cached = memo.get(artifactType);
  if (cached) return cached;
  if (visiting.has(artifactType)) {
    // Ciclo declarado (inválido; §5.4 lo debe impedir aguas arriba). Marcador
    // estable para no recursar infinito ni tirar el pass.
    return "cycle";
  }
  visiting.add(artifactType);
  const entries: Record<string, unknown> = {};
  for (const entry of deps[artifactType] ?? []) {
    const ref = parseImpactInputRef(entry);
    if (ref.kind === "fact") {
      entries[entry] = snapshot.facts.get(ref.key) ?? null;
    } else if (ref.kind === "account_asset") {
      entries[entry] = snapshot.assets.get(ref.key) ?? null;
    } else {
      entries[entry] = resolveEntries(deps, ref.key, snapshot, memo, visiting);
    }
  }
  visiting.delete(artifactType);
  const hash = computeImpactInputHash(entries);
  memo.set(artifactType, hash);
  return hash;
}

/**
 * Hash esperado del artefacto de un tipo dado el estado vigente. Es la
 * MISMA función que los productores de artefactos deben usar al crear la
 * fila (`case_artifacts.input_hash`): artefacto current ⟺ su input_hash
 * coincide con este valor.
 */
export function computeExpectedInputHashForType(
  deps: Record<string, string[]>,
  artifactType: string,
  snapshot: ImpactSnapshot
): string {
  return resolveEntries(deps, artifactType, snapshot, new Map(), new Set());
}

/**
 * Entradas de evidencia resueltas al estado vigente (qué vería el humano si
 * decidiera AHORA): valores de hechos, identidad de assets y hash esperado
 * de los artefactos referenciados. Slice 3.3 las persiste como
 * `evidence_snapshot_jsonb` al otorgar, y las usa como "base nueva" al
 * mostrar una suspensión (base vieja = snapshot guardado en la aprobación).
 */
export function buildEvidenceEntries(
  deps: Record<string, string[]>,
  evidenceInputs: readonly string[],
  snapshot: ImpactSnapshot
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  const memo = new Map<string, string>();
  for (const entry of evidenceInputs) {
    const ref = parseImpactInputRef(entry);
    if (ref.kind === "fact") {
      entries[entry] = snapshot.facts.get(ref.key) ?? null;
    } else if (ref.kind === "account_asset") {
      entries[entry] = snapshot.assets.get(ref.key) ?? null;
    } else {
      entries[entry] = resolveEntries(deps, ref.key, snapshot, memo, new Set());
    }
  }
  return entries;
}

/**
 * Hash de evidencia de una aprobación (graph.approvals[].evidence_inputs),
 * con la misma resolución de entradas que los artefactos. Slice 3.3 lo usa
 * al otorgar; el motor lo usa para detectar bases cambiadas.
 */
export function computeApprovalEvidenceHash(
  deps: Record<string, string[]>,
  evidenceInputs: readonly string[],
  snapshot: ImpactSnapshot
): string {
  return computeImpactInputHash(
    buildEvidenceEntries(deps, evidenceInputs, snapshot)
  );
}

// ============================================================
// Contrato del store (lo implementa @agents/db vía el caller)
// ============================================================

export interface ImpactPlaneStore {
  /** Hechos vigentes del caso (superseded_by is null). */
  getCurrentFacts(userId: string, caseId: string): Promise<CaseFact[]>;
  /** Todos los artefactos del caso (el motor filtra por status). */
  listCaseArtifacts(userId: string, caseId: string): Promise<CaseArtifact[]>;
  /** CAS por versión (optimistic locking); null si la versión ya cambió. */
  updateArtifactStatus(input: {
    userId: string;
    artifactId: string;
    status: "stale";
    expectedVersion: number;
  }): Promise<CaseArtifact | null>;
  /** Identidad de la versión vigente del asset (content_hash o marcador). */
  getLatestAssetVersionIdentity(
    userId: string,
    assetKey: string
  ): Promise<string | null>;
  /** Aprobaciones vigentes (no reemplazadas) del caso. */
  listCurrentApprovals(userId: string, caseId: string): Promise<CaseApproval[]>;
  /** approved → suspended; false si ya no estaba en approved (carrera). */
  suspendApproval(input: {
    userId: string;
    approvalId: string;
  }): Promise<boolean>;
  /** Evento de invalidación append-only sobre el stream del caso. */
  appendInvalidationEvent(input: {
    userId: string;
    caseId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  /**
   * Trabajo de reparación. Las implementaciones DEBEN estampar el origin
   * recibido (`impact_repair`, finding 17); la idempotency key del template
   * evita duplicados si el mismo cambio se reprocesa.
   */
  createRepairWorkItems(input: {
    userId: string;
    caseId: string;
    workflowDefinitionVersion: number;
    origin: "impact_repair";
    templates: WorkItemTemplateSpec[];
  }): Promise<{ created: WorkItem[]; existing: WorkItem[] }>;
}

// ============================================================
// applyInputChange
// ============================================================

export interface ImpactInputChange {
  kind: "fact" | "account_asset";
  /** fact_key corregida o asset_key reemplazada. */
  key: string;
  /** Metadata para el evento (ids de filas nuevas/reemplazadas, fuente…). */
  detail?: Record<string, unknown>;
}

export interface ImpactChangeResult {
  staled: Array<{ id: string; artifact_type: string }>;
  suspended: Array<{ id: string; approval_kind: string }>;
  repairWork: Array<{ id: string; work_type: string }>;
  unaffected: Array<{ id: string; artifact_type: string }>;
}

function changedEntryKey(change: ImpactInputChange): string {
  return change.kind === "account_asset"
    ? `account_asset:${change.key}`
    : change.key;
}

/**
 * Clausura de tipos afectados: los que declaran la entrada cambiada, más —
 * transitivamente — los que declaran `artifact:<tipo afectado>`.
 */
export function affectedArtifactTypes(
  deps: Record<string, string[]>,
  change: ImpactInputChange
): Set<string> {
  const changed = changedEntryKey(change);
  const affected = new Set<string>();
  for (const [type, entries] of Object.entries(deps)) {
    if (entries.includes(changed)) affected.add(type);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [type, entries] of Object.entries(deps)) {
      if (affected.has(type)) continue;
      for (const entry of entries) {
        const ref = parseImpactInputRef(entry);
        if (ref.kind === "artifact" && affected.has(ref.key)) {
          affected.add(type);
          grew = true;
          break;
        }
      }
    }
  }
  return affected;
}

export interface ApplyInputChangeParams {
  userId: string;
  caseId: string;
  graph: Pick<WorkflowGraph, "impact_dependencies" | "approvals">;
  workflowDefinitionVersion: number;
  change: ImpactInputChange;
}

export async function applyInputChange(
  store: ImpactPlaneStore,
  params: ApplyInputChangeParams
): Promise<ImpactChangeResult> {
  const { userId, caseId, graph, change } = params;
  const deps = graph.impact_dependencies ?? {};
  const result: ImpactChangeResult = {
    staled: [],
    suspended: [],
    repairWork: [],
    unaffected: [],
  };

  const affected = affectedArtifactTypes(deps, change);
  const changed = changedEntryKey(change);
  const approvalsTouched = (graph.approvals ?? []).filter((approval) =>
    approval.evidence_inputs.some((entry) => {
      if (entry === changed) return true;
      const ref = parseImpactInputRef(entry);
      return ref.kind === "artifact" && affected.has(ref.key);
    })
  );

  const artifacts = await store.listCaseArtifacts(userId, caseId);
  const currentArtifacts = artifacts.filter((a) => a.status === "current");

  if (affected.size === 0 && approvalsTouched.length === 0) {
    // Entrada sin edges declarados: nada se invalida, por diseño.
    result.unaffected = currentArtifacts.map((a) => ({
      id: a.id,
      artifact_type: a.artifact_type,
    }));
    return result;
  }

  // Snapshot vigente: hechos + identidad de assets referenciados por el mapa.
  const factRows = await store.getCurrentFacts(userId, caseId);
  const facts = new Map<string, unknown>();
  for (const row of factRows) facts.set(row.fact_key, row.value_jsonb);

  const assetKeys = new Set<string>();
  const collectAssets = (entries: readonly string[]) => {
    for (const entry of entries) {
      const ref = parseImpactInputRef(entry);
      if (ref.kind === "account_asset") assetKeys.add(ref.key);
    }
  };
  for (const entries of Object.values(deps)) collectAssets(entries);
  for (const approval of graph.approvals ?? []) {
    collectAssets(approval.evidence_inputs);
  }
  const assets = new Map<string, string | null>();
  for (const assetKey of assetKeys) {
    assets.set(
      assetKey,
      await store.getLatestAssetVersionIdentity(userId, assetKey)
    );
  }
  const snapshot: ImpactSnapshot = { facts, assets };

  // ---- Artefactos: recompute selectivo + stale + repair templates ----
  const repairTemplates: WorkItemTemplateSpec[] = [];
  const staledIds = new Set<string>();
  for (const artifact of currentArtifacts) {
    if (!affected.has(artifact.artifact_type)) continue;
    const expected = computeExpectedInputHashForType(
      deps,
      artifact.artifact_type,
      snapshot
    );
    if (expected === artifact.input_hash) continue; // selectividad: current
    const updated = await store.updateArtifactStatus({
      userId,
      artifactId: artifact.id,
      status: "stale",
      expectedVersion: artifact.version,
    });
    if (!updated) continue; // carrera: otro pass ya lo tocó
    staledIds.add(artifact.id);
    result.staled.push({ id: artifact.id, artifact_type: artifact.artifact_type });
    await store.appendInvalidationEvent({
      userId,
      caseId,
      payload: {
        kind: "impact_invalidation",
        artifact_id: artifact.id,
        artifact_type: artifact.artifact_type,
        changed_input: changed,
        change_kind: change.kind,
        prior_input_hash: artifact.input_hash,
        expected_input_hash: expected,
        ...(change.detail ?? {}),
      },
    });
    repairTemplates.push({
      work_type: `repair_${artifact.artifact_type}`,
      // Phase 3.2: reparación como trabajo humano-revisable; 3.4 asigna
      // worker profiles específicos por tipo. Nunca auto-ejecución opaca.
      required_capability: "human:impact_repair",
      input_contract: {
        objective: `Regenerar ${artifact.artifact_type}: cambió ${changed}.`,
        artifact_id: artifact.id,
        artifact_type: artifact.artifact_type,
        changed_input: changed,
        expected_input_hash: expected,
      },
      // Un item por (tipo, base esperada): el mismo cambio reprocesado no
      // duplica; un cambio posterior (hash distinto) sí crea trabajo nuevo.
      idempotency_key: `impact_repair:${artifact.artifact_type}:${expected.replace(/^sha256:/, "").slice(0, 16)}`,
    });
  }

  result.unaffected = currentArtifacts
    .filter((a) => !staledIds.has(a.id))
    .map((a) => ({ id: a.id, artifact_type: a.artifact_type }));

  if (repairTemplates.length > 0) {
    const repair = await store.createRepairWorkItems({
      userId,
      caseId,
      workflowDefinitionVersion: params.workflowDefinitionVersion,
      origin: "impact_repair",
      templates: repairTemplates,
    });
    result.repairWork = repair.created.map((item) => ({
      id: item.id,
      work_type: item.work_type,
    }));
  }

  // ---- Aprobaciones: evidencia cambiada ⇒ suspender (nunca revocar) ----
  if (approvalsTouched.length > 0) {
    const approvals = await store.listCurrentApprovals(userId, caseId);
    for (const spec of approvalsTouched) {
      const expectedEvidence = computeApprovalEvidenceHash(
        deps,
        spec.evidence_inputs,
        snapshot
      );
      for (const approval of approvals) {
        if (approval.approval_kind !== spec.kind) continue;
        if (approval.decision !== "approved") continue;
        if (approval.evidence_hash === expectedEvidence) continue;
        const suspended = await store.suspendApproval({
          userId,
          approvalId: approval.id,
        });
        if (!suspended) continue;
        result.suspended.push({
          id: approval.id,
          approval_kind: approval.approval_kind,
        });
        await store.appendInvalidationEvent({
          userId,
          caseId,
          payload: {
            kind: "impact_approval_suspended",
            approval_id: approval.id,
            approval_kind: approval.approval_kind,
            changed_input: changed,
            prior_evidence_hash: approval.evidence_hash,
            expected_evidence_hash: expectedEvidence,
            ...(change.detail ?? {}),
          },
        });
      }
    }
  }

  return result;
}
