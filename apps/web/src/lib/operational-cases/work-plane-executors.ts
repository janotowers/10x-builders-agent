/**
 * Resolución de ejecutores del plano de trabajo (Slices 2.3/2.4; perfiles y
 * scopes en 3.4).
 *
 * Convención de `required_capability` → modo de ejecución:
 *   - `human` o `human:<detalle>`   → executor human (notifica + review)
 *   - `service` o `service:<detalle>` → deterministic_service (registro en
 *     código por `work_type`; NUNCA dispatch dinámico de strings de DB a
 *     funciones arbitrarias)
 *   - `agent:valuation_verifier`    → specialized_agent (3.4-3)
 *   - `agent` o `agent:<detalle>`   → main_agent (case-runner existente)
 *   - cualquier otra capability     → null ⇒ el dispatcher bloquea el item
 *     explícitamente (`no_executor_for_capability:<capability>`).
 *
 * Slice 3.4-5: `createWorkerScopeEnforcement` evalúa los worker profiles
 * (allowed_tools / allowed_data_scopes) EN LA SELECCIÓN — deny ⇒ blocked con
 * razón explícita, nunca "recorte de prompt" como sustituto de permiso.
 */
import type { DbClient } from "@agents/db";
import {
  getCurrentCaseFacts,
  getOperationalCase,
  insertOperationalCaseEvent,
  listCaseArtifactsForCase,
  listOperationalCaseDocuments,
  resolveWorkerProfileForCapability,
  updateCaseArtifactStatus,
  upsertActiveInternalUserNotification,
} from "@agents/db";
import type { ExecutorAdapter } from "@agents/workflows";
import {
  createDeterministicServiceExecutor,
  createHumanExecutor,
  createMainAgentExecutor,
  createSpecializedAgentExecutor,
  type DeterministicWorkFn,
  type SpecializedAgentWorkFn,
} from "@agents/workflows";
import {
  runWithAiUsageContext,
  verifyValuationRecommendation,
} from "@agents/agent";
import type { WorkItem, WorkerProfile } from "@agents/types";
import { makeWorkItemAgentTurnRunner } from "./work-plane-agent-turn";
import { reconcilePublicationCaseRecord } from "./publication-reconcile";
import { consolidateDocumentExtractionIntoCase } from "./property-optioning-post-agent-invariants";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Registro de funciones deterministas (por `work_type`), definido en código.
 * Los `work_plane_synthetic_*` existen para el soak 2.6 (casos sintéticos):
 * devuelven el input contract como resultado, sin efectos. Los tres tipos de
 * rama componen el fixture de rama paralela + fan-in del soak vivo.
 */
const syntheticEcho: DeterministicWorkFn = async ({ item }) => ({
  echo: item.input_contract_jsonb,
  work_type: item.work_type,
  completed_at: new Date().toISOString(),
});

/**
 * Servicio determinista `publication_reconciliation` (3.4-2): envuelve
 * `reconcilePublicationCaseRecord` — el MISMO código que corre el path
 * legacy, detrás del contrato work-item. Sin verificación remota por
 * default (el tick del plano no debe colgarse de APIs externas).
 */
function makePublicationReconciliationFn(db: DbClient): DeterministicWorkFn {
  return async ({ userId, item }) => {
    const opCase = await getOperationalCase(db, item.case_id);
    if (!opCase || opCase.user_id !== userId) {
      throw new Error("case_not_found_for_publication_reconciliation");
    }
    const input = isRecord(item.input_contract_jsonb)
      ? item.input_contract_jsonb
      : {};
    const outcome = await reconcilePublicationCaseRecord(db, opCase, {
      verifyRemote: input.verify_remote === true,
    });
    return {
      ok: outcome.ok,
      case_id: outcome.case_id,
      destination_phases: Object.fromEntries(
        Object.entries(outcome.publication.destinations).map(
          ([destination, state]) => [destination, state.phase]
        )
      ),
      changes: outcome.changes,
      ...(outcome.message ? { message: outcome.message } : {}),
    };
  };
}

/**
 * Servicio determinista `extraction_consolidation` (3.4-2): la sección de
 * consolidación de post-agent-invariants extraída tras contrato explícito.
 */
function makeExtractionConsolidationFn(db: DbClient): DeterministicWorkFn {
  return async ({ userId, item }) => {
    const opCase = await getOperationalCase(db, item.case_id);
    if (!opCase || opCase.user_id !== userId) {
      throw new Error("case_not_found_for_extraction_consolidation");
    }
    const documents = await listOperationalCaseDocuments(db, {
      caseId: opCase.id,
      statuses: ["received"],
    });
    const consolidated = await consolidateDocumentExtractionIntoCase({
      db,
      opCase,
      documents,
      source: "work_plane_extraction_consolidation",
    });
    return {
      changed: consolidated.changed,
      case_version: consolidated.case.version,
      document_field_keys: Object.keys(consolidated.documentFields),
    };
  };
}

function proposalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Worker `verify_valuation` (3.4-3): contexto AISLADO = comparable set +
 * hechos de la propiedad + números propuestos. Nunca lee el razonamiento de
 * la recomendación. En fail invalida el artefacto price_recommendation
 * (evidence gates the artifact) y deja el item en review humano.
 */
function makeValuationVerifierFn(db: DbClient): SpecializedAgentWorkFn {
  return async ({ userId, item }) => {
    const opCase = await getOperationalCase(db, item.case_id);
    if (!opCase || opCase.user_id !== userId) {
      throw new Error("case_not_found_for_valuation_verifier");
    }
    // Política de modelo del perfil (seed 00071); sin perfil el resolver
    // §9.1 cae al env del rol y luego a MAIN_AGENT_MODEL_ID.
    let profile: WorkerProfile | null = null;
    try {
      profile = await resolveWorkerProfileForCapability(
        db,
        userId,
        item.required_capability
      );
    } catch {
      profile = null;
    }
    const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};

    // Comparable set: artefacto v2 vigente si existe; fallback al contexto.
    const artifacts = await listCaseArtifactsForCase(db, userId, opCase.id);
    const comparableArtifact = artifacts.find(
      (a) => a.artifact_type === "comparable_set" && a.status === "current"
    );
    const comparableSet =
      comparableArtifact && isRecord(comparableArtifact.content_jsonb)
        ? comparableArtifact.content_jsonb
        : isRecord(context.comparables_analysis)
          ? context.comparables_analysis
          : {};

    // Hechos: case_facts v2 (property.*) con fallback a property_data.
    const propertyFacts: Record<string, unknown> = {};
    try {
      const facts = await getCurrentCaseFacts(db, userId, opCase.id);
      for (const fact of facts.values()) {
        if (fact.fact_key.startsWith("property.")) {
          propertyFacts[fact.fact_key] = fact.value_jsonb;
        }
      }
    } catch {
      // Sin plano de hechos: fallback abajo.
    }
    if (Object.keys(propertyFacts).length === 0 && isRecord(context.property_data)) {
      for (const [key, value] of Object.entries(context.property_data)) {
        propertyFacts[`property.${key}`] = value;
      }
    }

    const proposal = isRecord(context.pricing_proposal)
      ? context.pricing_proposal
      : {};
    const verification = await runWithAiUsageContext(
      {
        userId,
        channel: "case_runner",
        operationalCaseId: opCase.id,
        workflowDefinitionId: opCase.workflow_definition_id ?? null,
        workItemId: item.id,
        workItemAttemptId: item.current_attempt_id,
      },
      db,
      () =>
        verifyValuationRecommendation(
          {
            comparableSet,
            propertyFacts,
            proposedPrices: {
              salida: proposalNumber(proposal.salida),
              ideal: proposalNumber(proposal.ideal),
              minimo: proposalNumber(proposal.minimo),
            },
          },
          { modelPolicy: profile?.model_policy_jsonb ?? null }
        )
    );

    // Contadores §9.1 (falso-accept/reject se auditan sobre estos eventos):
    // cada verdict queda en el stream del caso con el modelo RESUELTO.
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      stepKey: opCase.current_step ?? undefined,
      payload: {
        kind: "valuation_verifier_verdict",
        verdict: verification.verdict,
        findings: verification.findings,
        checks: verification.checks,
        model: verification.model,
        work_item_id: item.id,
      },
    });

    // Evidence gates the price recommendation: fail ⇒ artefacto invalid.
    if (verification.verdict === "fail") {
      const recommendation = artifacts.find(
        (a) => a.artifact_type === "price_recommendation" && a.status === "current"
      );
      if (recommendation) {
        await updateCaseArtifactStatus(db, {
          userId,
          artifactId: recommendation.id,
          status: "invalid",
          expectedVersion: recommendation.version,
        });
      }
    }

    return {
      result: {
        verdict: verification.verdict,
        findings: verification.findings,
        checks: verification.checks,
        model: verification.model,
      },
      evidence: {
        verdict: verification.verdict,
        findings: verification.findings,
      },
      requiresHumanReview: verification.verdict === "fail",
    };
  };
}

export function createWorkPlaneExecutorResolver(
  db: DbClient
): (item: WorkItem) => ExecutorAdapter | null {
  const mainAgent = createMainAgentExecutor(makeWorkItemAgentTurnRunner(db));
  const deterministic = createDeterministicServiceExecutor(
    new Map<string, DeterministicWorkFn>([
      ["work_plane_synthetic_echo", syntheticEcho],
      ["work_plane_synthetic_branch_a", syntheticEcho],
      ["work_plane_synthetic_branch_b", syntheticEcho],
      ["work_plane_synthetic_fan_in", syntheticEcho],
      ["publication_reconciliation", makePublicationReconciliationFn(db)],
      ["extraction_consolidation", makeExtractionConsolidationFn(db)],
    ])
  );
  const specialized = createSpecializedAgentExecutor(
    new Map<string, SpecializedAgentWorkFn>([
      ["verify_valuation", makeValuationVerifierFn(db)],
    ])
  );
  const human = createHumanExecutor(async ({ userId, item }) => {
    const objective = (item.input_contract_jsonb ?? {}).objective;
    await upsertActiveInternalUserNotification(db, {
      userId,
      caseId: item.case_id,
      kind: "work_item_review",
      title: `Trabajo pendiente de revisión: ${item.work_type}`,
      body:
        typeof objective === "string" && objective.trim()
          ? objective.trim()
          : `El trabajo «${item.work_type}» requiere intervención humana.`,
      metadata: { work_item_id: item.id },
    });
  });

  return (item: WorkItem): ExecutorAdapter | null => {
    const capability = item.required_capability;
    if (capability === "human" || capability.startsWith("human:")) return human;
    if (capability === "service" || capability.startsWith("service:")) {
      return deterministic;
    }
    if (capability === "agent:valuation_verifier") return specialized;
    if (capability === "agent" || capability.startsWith("agent:")) {
      return mainAgent;
    }
    return null;
  };
}

/**
 * Slice 3.4-5 — enforcement de scopes del worker profile en la selección.
 *
 * Reglas (fail closed en mismatch, fail open en ausencia de perfil para no
 * romper los items legacy `service`/`agent`/`human` sin perfil declarado):
 *   - Si la capability resuelve a un perfil, el modo del adapter debe
 *     coincidir con `execution_mode` del perfil.
 *   - `input_contract_jsonb.required_tools` ⊆ `allowed_tools` del perfil.
 *   - `input_contract_jsonb.required_data_scopes` ⊆ `allowed_data_scopes`.
 */
export function createWorkerScopeEnforcement(
  db: DbClient
): (
  item: WorkItem,
  adapter: ExecutorAdapter
) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return async (item, adapter) => {
    let profile: WorkerProfile | null = null;
    try {
      profile = await resolveWorkerProfileForCapability(
        db,
        item.user_id,
        item.required_capability
      );
    } catch {
      // Tabla aún no migrada / error transitorio: sin perfil no hay scopes
      // que hacer valer; la convención por prefijo sigue gobernando.
      return { ok: true };
    }
    if (!profile) return { ok: true };

    if (profile.execution_mode !== adapter.executionMode) {
      return {
        ok: false,
        reason: `scope_mismatch:execution_mode:${profile.execution_mode}!=${adapter.executionMode}`,
      };
    }

    const contract = isRecord(item.input_contract_jsonb)
      ? item.input_contract_jsonb
      : {};
    const requiredTools = Array.isArray(contract.required_tools)
      ? contract.required_tools.filter((t): t is string => typeof t === "string")
      : [];
    for (const tool of requiredTools) {
      if (!profile.allowed_tools.includes(tool)) {
        return { ok: false, reason: `scope_mismatch:tool_not_allowed:${tool}` };
      }
    }
    const requiredScopes = Array.isArray(contract.required_data_scopes)
      ? contract.required_data_scopes.filter(
          (s): s is string => typeof s === "string"
        )
      : [];
    for (const scope of requiredScopes) {
      if (!profile.allowed_data_scopes.includes(scope)) {
        return { ok: false, reason: `scope_mismatch:data_scope_not_allowed:${scope}` };
      }
    }
    return { ok: true };
  };
}
