"use client";

import Image from "next/image";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  AccountAsset,
  AccountSkill,
  OperationalCaseConversationBinding,
  OperationalCaseE2ELabSession,
  OperationalCase,
  OperationalCaseActivationPolicy,
  OperationalCaseEvent,
  OperationalCaseFlowSkill,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  OperationalCaseIntakeField,
  OperationalCaseIntakeOption,
  OperationalCaseReminderPolicy,
  OperationalCaseStatus,
  OperationalCaseType,
  OperationalCaseTypeStatus,
  OperationalCaseTypeVisibility,
  ToolCall,
} from "@agents/types";
import { resolveOperationalCaseDocumentRequestTarget } from "@agents/types";
import { AccountToolConnectionForm } from "@/components/account-tool-connection-form";
import type { OwnerResponseBusinessOutcome } from "@/lib/operational-cases/evaluate-owner-response-outcome";
import {
  collectSkillTestNotifyUserCalls,
  collectSkillTestRenderedDocuments,
  collectSkillTestTelegramCalls,
  formatSkillTestCallGroupLabel,
  parseRenderedDocumentResult,
  formatSkillTestToolCallAuditTokenList,
  SkillTestNotifyUserCallDetails,
  SkillTestRenderedDocumentLinks,
  SkillTestTelegramCallDetails,
  skillTestExternalContactTelegramHint,
  skillTestNotifyMissingDocUrlNotice,
  skillTestNotifyUserNotice,
  skillTestTelegramNotice,
  type SkillTestToolCallDetail,
} from "@/lib/operational-cases/skill-test-call-details";
import {
  stepTestCatalogSlugForRootSkill,
  stepTestAvailable,
  stepTestScenariosFor,
} from "@/lib/operational-cases/step-test-scenarios";
import {
  flowProgressRuntimeBadgeLabel,
  flowProgressRuntimeBadgeTitle,
  formatFlowStepEvidenceSummaryLine,
  summarizeFlowStepEvidence,
  isStepTestBlocked,
  contractDraftScenarioOutcomeHint,
  formatStepScenarioChecklist,
  formatStepScenarioProgress,
  stepScenarioRunResultLabel,
  formatStepTestResultMetaLine,
  resolveStepTestExecutionMode,
  resolveStepTestUiCopy,
  readinessTestStatusPillClass,
  skillTestStatusLabel,
  SKILL_TEST_BLOCKED_TITLE,
  SKILL_TEST_PRIMARY_BUTTON_CLASS,
  stepAllSkillsN3Ok,
  stepTestStatusLabel,
  STEP_TEST_BLOCKED_TITLE,
  STEP_TEST_PRIMARY_BUTTON_CLASS,
  ACCOUNT_RESOURCES_PANEL_HINT,
  ACCOUNT_RESOURCES_TOGGLE_CLOSE_LABEL,
  ACCOUNT_RESOURCES_TOGGLE_OPEN_LABEL,
  TEST_ASSETS_PANEL_HINT,
  toolTestSectionSummaryHint,
  toolTestStatusLabel,
} from "@/lib/operational-cases/readiness-test-ui";
import {
  listUntestedReadinessToolIdsForStep,
  readinessTestShowActionRowStatusPill,
  skillN1Progress,
  skillTestSectionCollapseWhenAlreadyProven,
  skillTestSectionDefaultOpen,
  skillTestSectionState,
  skillTestSectionSummary,
  stepTestSectionCollapseWhenAlreadyProven,
  stepTestSectionDefaultOpen,
  stepTestSectionState,
  stepTestSectionSummary,
} from "@/lib/operational-cases/readiness-step-section-ui";
import {
  READINESS_LAB_SKILL_LABEL,
  READINESS_LAB_SKILL_SHELL,
  READINESS_LAB_STEP_BADGE,
  READINESS_LAB_STEP_BODY,
  READINESS_LAB_STEP_SHELL,
  READINESS_LAB_STEP_TOOLS_SECTION,
  READINESS_LAB_TOOL_CARD_WRAP,
  READINESS_LAB_TOOL_TEST_TOGGLE,
  READINESS_LAB_TOOL_TEST_TOGGLE_HINT,
  READINESS_LAB_TOOL_TEST_TOGGLE_TITLE,
  READINESS_LAB_TOOLS_LABEL,
  READINESS_LAB_TOOLS_SECTION,
  readinessLabToolShellClass,
} from "@/lib/operational-cases/readiness-lab-hierarchy-ui";
import { ReadinessTestSection } from "@/components/readiness-test-section";
import {
  OPERATIONAL_CASE_STATUS_LABELS,
  OperationalCaseInstanceList,
  operationalCaseLatestEventSummary,
  type OperationalCaseInstanceSkillMeta,
} from "@/lib/operational-cases/instance-list-ui";
import { stringifyToolArgsForDisplay } from "@/lib/tool-readiness/format-args-for-display";
import {
  flowProgressStepHeading,
  isInternalOperationalTool,
  isReadinessVisibleTool,
  isScenarioOnlyTool,
  partitionFlowSteps,
  toolSurfaceKind,
  toolSurfaceLabel,
} from "@/lib/operational-cases/tool-surface-classification";
import type { SettingsTestPendingAction } from "@/lib/operational-cases/settings-test-pending-actions";
import { settingsTestPlaythroughAnchorAt } from "@/lib/operational-cases/settings-test-pending-actions";
import type { FlowProgressEvidenceItem } from "@/lib/operational-cases/settings-test-flow-progress";
import {
  flowProgressForE2ESummary,
  toolCallFailureDetail,
  toolCallStatusLabel,
} from "@/lib/operational-cases/settings-test-flow-progress";
import type { LastE2ETransitionOutcome } from "@/lib/operational-cases/settings-test-e2e-transitions";
import { buildE2ETransitionGroups } from "@/lib/operational-cases/settings-test-e2e-transitions";
import {
  buildObservedConversationalCaseLabel,
  buildOperationalStepLabelMap,
  cleanupTargetLabel,
  countSettingsTestActionsByKind,
  formatLabToolArgsPreviewLine,
  formatLabTransitionBadge,
  formatLabTransitionSummary,
  formatLastE2ETransitionOutcome,
  formatSettingsTestCleanupResult,
  formatSettingsTestHistorySummary,
  type OperationalStepLabelMap,
  type SettingsTestCleanupTarget,
} from "@/lib/operational-cases/settings-test-history-ui";
import { internalNotificationKindConfig } from "@/lib/internal-notifications/registry";
import {
  caseActionUrl,
  pendientesDeepLink,
  pendingActionFocusId,
  pendingActionLinkLabel,
  prepareNotificationBodyMarkdown,
  shouldShowAssociatedActionLink,
} from "@/lib/notifications/pending-action-display";
import ReactMarkdown from "react-markdown";

type PageScrollPosition = {
  x: number;
  y: number;
  documentElement: number;
  body: number;
  readinessFlow: number;
};

function capturePageScroll(
  readinessFlowEl?: HTMLDivElement | null
): PageScrollPosition {
  return {
    x: window.scrollX,
    y: window.scrollY,
    documentElement: document.documentElement.scrollTop,
    body: document.body.scrollTop,
    readinessFlow: readinessFlowEl?.scrollTop ?? 0,
  };
}

function restorePageScroll(
  position: PageScrollPosition,
  readinessFlowEl?: HTMLDivElement | null
) {
  window.scrollTo(position.x, position.y);
  document.documentElement.scrollTop = position.documentElement;
  document.body.scrollTop = position.body;
  if (readinessFlowEl) {
    readinessFlowEl.scrollTop = position.readinessFlow;
  }
}

/** Restaura scroll tras cambios de layout (expandir panel, preview, refresh). */
function restorePageScrollAfterLayout(
  position: PageScrollPosition,
  readinessFlowEl?: HTMLDivElement | null
) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      restorePageScroll(position, readinessFlowEl);
    });
  });
}

function readinessExpandToggleHandlers(onToggle: () => void) {
  return {
    onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
    },
    onClick: () => {
      onToggle();
      (document.activeElement as HTMLElement | null)?.blur();
    },
  };
}

/** Abre el panel de upload de recursos de cuenta (operación real), no el bloque N1. */
function AccountResourcesExpandToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const toggleHandlers = readinessExpandToggleHandlers(onToggle);
  return (
    <button
      type="button"
      {...toggleHandlers}
      aria-expanded={expanded}
      className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800 hover:bg-violet-100"
    >
      {expanded
        ? ACCOUNT_RESOURCES_TOGGLE_CLOSE_LABEL
        : ACCOUNT_RESOURCES_TOGGLE_OPEN_LABEL}
    </button>
  );
}

/** Sustituye «Probar tool» / «Cerrar»: solo abre el panel N1 (ToolTestPanel). */
function ToolTestExpandToggle({
  expanded,
  onToggle,
  testStatus,
}: {
  expanded: boolean;
  onToggle: () => void;
  testStatus?: string;
}) {
  const toggleHandlers = readinessExpandToggleHandlers(onToggle);
  const hint = toolTestSectionSummaryHint(testStatus);
  return (
    <button
      type="button"
      {...toggleHandlers}
      aria-expanded={expanded}
      className={READINESS_LAB_TOOL_TEST_TOGGLE}
    >
      <span
        aria-hidden
        className={`mt-0.5 inline-block shrink-0 text-[10px] leading-none transition-transform ${
          expanded ? "rotate-90" : ""
        }`}
      >
        ▸
      </span>
      <span className="min-w-0 flex-1">
        <span className={READINESS_LAB_TOOL_TEST_TOGGLE_TITLE}>
          Prueba de herramienta
        </span>
        <span className={READINESS_LAB_TOOL_TEST_TOGGLE_HINT}>{hint}</span>
      </span>
    </button>
  );
}

/** Colapsa sin desmontar: al cerrar evita saltos por remount + mantiene estado del panel. */
function ReadinessExpandableSection({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const [everExpanded, setEverExpanded] = useState(expanded);

  useEffect(() => {
    if (!expanded) return undefined;
    const id = requestAnimationFrame(() => setEverExpanded(true));
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  if (!everExpanded) return null;

  return (
    <div
      className="mt-2 grid [overflow-anchor:none]"
      style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="space-y-2 [overflow-anchor:none]">{children}</div>
      </div>
    </div>
  );
}

const DEFAULT_INTAKE_SCHEMA: OperationalCaseIntakeField[] = [
  {
    name: "title",
    label: "Título",
    type: "text",
    required: true,
    placeholder: "Ej. Seguimiento de lead Mariana",
  },
  {
    name: "notes",
    label: "Notas iniciales",
    type: "textarea",
    required: false,
    placeholder: "Contexto que el agente debe considerar",
  },
];

const DEFAULT_ACTIVATION_POLICY: Required<OperationalCaseActivationPolicy> = {
  safe_test: {
    description:
      "Prepara un caso de prueba con datos del intake y valida el registro antes del flujo operativo, sin mezclarlo con operación real.",
    run_button_label: "Validar registro",
    synthetic_data_copy:
      "Caso de prueba en la misma fila de operational_cases (regenerar no crea otro registro). La prueba con agente puede invocar tools y crear pendientes de aprobación, pero el cron no debe continuar el caso automáticamente.",
    success_copy:
      "Prueba segura inicial pasada: registro validado. Usa la prueba con agente al final del laboratorio para una transición controlada.",
    timeline_note:
      "Validación segura: registro y paso inicial sin agente. Prueba con agente: una ejecución real desde el paso actual del caso; publicación o envíos pueden pedir aprobación humana.",
    next_action:
      "Revisar readiness de tools de envío/escritura/publicación antes de operación real completa.",
    start_step: "intake",
    success_step: "awaiting_documents",
  },
  activation_checks: {
    skill_valid_copy: "Skill válida: parser/rúbrica sin bloqueos.",
    readiness_ready_copy: "Tools listas: readiness sin bloqueos críticos.",
    readiness_blocked_copy:
      "Tools pendientes de validación: prueba o configura las herramientas requeridas antes de activar.",
    safe_test_success_copy:
      "Registro validado: prueba segura ejecutada o el caso de prueba ya avanzó al flujo operativo.",
    conversational_safe_copy:
      "Listo para chat/Telegram en modo controlado (plantilla activa, tools listas, registro validado).",
    real_operation_complete_copy:
      "Operación real completa: sin stubs técnicos pendientes.",
    real_operation_pending_copy:
      "Operación real completa: pendiente; quedan {stub_count} stubs/capacidades por resolver antes de operar sin restricciones.",
    real_operation_requires_no_stubs: true,
  },
};

type EditingCaseType = {
  case_type: string;
  display_name: string;
  default_skill_slug: string;
  description: string;
  status: OperationalCaseTypeStatus;
  visibility: Exclude<OperationalCaseTypeVisibility, "global">;
  intake_schema_jsonb: OperationalCaseIntakeField[];
  operational_flow_jsonb: OperationalCaseFlowStep[];
  activation_policy_jsonb: OperationalCaseActivationPolicy;
  default_reminder_policy_jsonb: OperationalCaseReminderPolicy;
  isNew: boolean;
};

type SkillSummary = {
  slug: string;
  description: string;
  scope: string;
  allowedTools: string[];
  includes: string[];
  kind: string;
};

type CaseTypeWorkspaceTab = "summary" | "lab" | "instances" | "activation";

const CASE_TYPE_WORKSPACE_TABS: Array<{
  id: CaseTypeWorkspaceTab;
  label: string;
}> = [
  { id: "summary", label: "Resumen" },
  { id: "lab", label: "Laboratorio" },
  { id: "instances", label: "Flujos generados" },
  { id: "activation", label: "Activación" },
];

function isCaseTypeWorkspaceTab(
  value: string | null
): value is CaseTypeWorkspaceTab {
  return CASE_TYPE_WORKSPACE_TABS.some((tab) => tab.id === value);
}

function caseTypeFromUrl(
  rows: OperationalCaseType[]
): OperationalCaseType | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const value = params.get("type") ?? params.get("case_type");
  if (!value) return null;
  return (
    rows.find((row) => row.id === value || row.case_type === value) ?? null
  );
}

function tabFromUrl(): CaseTypeWorkspaceTab | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const value = params.get("tab");
  return isCaseTypeWorkspaceTab(value) ? value : null;
}

function observedCaseIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const value = params.get("observe_case")?.trim();
  return value && value.length > 0 ? value : null;
}

function replaceObservedCaseUrl(caseId: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (caseId && caseId.trim().length > 0) {
    url.searchParams.set("observe_case", caseId);
  } else {
    url.searchParams.delete("observe_case");
  }
  window.history.replaceState(window.history.state, "", url);
}

type SkillAuthoringResult = {
  skillDraft: string;
  validationRubric: Array<{
    item?: string;
    status?: "PASS" | "WARN" | "FAIL" | "N/A" | string;
    note?: string;
  }>;
  suggestedEvals: Record<string, unknown>;
  operationalFlow?: OperationalCaseFlowStep[];
  activationPolicy?: OperationalCaseActivationPolicy;
  activationRecommendation: string;
  attemptsUsed?: number;
  elapsedMs?: number;
  metadataTruncated?: boolean;
};

type AuthoringProgressEvent = {
  type: "stage" | "error";
  stage?: string;
  message?: string;
  attempt?: number;
  error?: string;
  details?: string;
  ts?: number;
};

type ToolReadinessStatus =
  | "ready"
  | "needs_config"
  | "stub"
  | "missing"
  | "unknown";
type ToolReadinessCategory =
  | "product_integration"
  | "account_config"
  | "tenant_asset"
  | "technical_stub"
  | "skill_definition"
  | "ready";
type ToolReadinessActionKind =
  | "connect_integration"
  | "configure_account"
  | "upload_asset"
  | "request_global"
  | "edit_skill"
  | "none";

type ToolReadinessRequestKind =
  | "incorporate_to_catalog"
  | "enable_account_config"
  | "provide_tenant_asset";

type ToolAccountSecretStatus =
  | "pending_test"
  | "active"
  | "invalid"
  | "disconnected";

type ToolReadinessToolItem = {
  tool_id: string;
  status: ToolReadinessStatus;
  category: ToolReadinessCategory;
  blocking: boolean;
  action_kind: ToolReadinessActionKind;
  action_label: string | null;
  action_available: boolean;
  action_message: string;
  action_url: string | null;
  action_anchor: string | null;
  request_kind: ToolReadinessRequestKind | null;
  /** Si la tool admite conexión per-account, qué provider corresponde. */
  account_provider: string | null;
  account_secret_status: ToolAccountSecretStatus | null;
  exists_in_catalog: boolean;
  adapter_available: boolean;
  risk?: string;
  requires_integration?: string;
  notes: string[];
  test_status?: "ready_untested" | "tested_ok" | "tested_failed";
  last_tested_at?: string | null;
  asset_requirements?: ToolAssetRequirementStatus[];
  test_asset_requirements?: ToolAssetRequirementStatus[];
};

type ToolAssetRequirementStatus = {
  asset_key: string;
  label: string;
  description?: string;
  accept?: string[];
  max_size_mb?: number;
  required?: boolean;
  param?: string;
  min_count?: number;
  max_count?: number;
  collection?: boolean;
  configured: boolean;
  asset: AccountAsset | null;
  assets?: AccountAsset[];
  configured_count?: number;
};

type ToolReadinessResult = {
  summary: "ready" | "has_stubs" | "needs_config";
  case_e2e_status?: "not_ready" | "ready_for_e2e" | "e2e_passed" | "operational_ready";
  skill: {
    root: string;
    composedFrom: string[];
    allowedTools: string[];
  };
  tools: ToolReadinessToolItem[];
  flow?: ToolReadinessFlowStep[];
  flow_preparation?: ToolReadinessFlowStep[];
  flow_operational?: ToolReadinessFlowStep[];
};

type ToolReadinessFlowTool = OperationalCaseFlowTool & {
  readiness: ToolReadinessToolItem | null;
  test_status?: "ready_untested" | "tested_ok" | "tested_failed";
};

type ToolReadinessFlowSkill = Omit<OperationalCaseFlowSkill, "skill_tools"> & {
  skill_tools: ToolReadinessFlowTool[];
  test_status?: "blocked_by_tools" | "ready_to_test" | "tested_ok" | "tested_failed" | "partial";
};

type ToolReadinessFlowStep = Omit<
  OperationalCaseFlowStep,
  "step_skills" | "step_tools"
> & {
  step_skills: ToolReadinessFlowSkill[];
  step_tools: ToolReadinessFlowTool[];
  step_kind?: "preparation" | "operational";
  readiness_tool_ids?: string[];
  test_status?:
    | "blocked"
    | "ready_to_test"
    | "partially_tested"
    | "awaiting_n4"
    | "tested_ok"
    | "tested_failed";
  step_test_progress?: {
    scenarios_total: number;
    scenarios_passed: number;
    scenarios_failed: number;
    scenarios_partial: number;
    scenarios_pending: number;
    scenarios?: Array<{
      id: string;
      label?: string;
      status: "tested_ok" | "tested_failed" | "partial" | "pending";
    }>;
  };
};

function flowToolWithoutReadiness(
  tool: OperationalCaseFlowTool
): ToolReadinessFlowTool {
  return {
    ...tool,
    readiness: null,
  };
}

function flowSkillWithoutReadiness(
  skill: OperationalCaseFlowSkill
): ToolReadinessFlowSkill {
  return {
    ...skill,
    skill_tools: (skill.skill_tools ?? []).map(flowToolWithoutReadiness),
  };
}

function flowStepWithoutReadiness(
  step: OperationalCaseFlowStep
): ToolReadinessFlowStep {
  return {
    ...step,
    step_skills: (step.step_skills ?? []).map(flowSkillWithoutReadiness),
    step_tools: (step.step_tools ?? []).map(flowToolWithoutReadiness),
  };
}

type ToolReadinessRequestStatus =
  | "requested"
  | "in_review"
  | "in_progress"
  | "shipped"
  | "rejected";

type ToolReadinessRequestRecord = {
  id: string;
  tool_id: string;
  request_kind: ToolReadinessRequestKind;
  status: ToolReadinessRequestStatus;
  created_at: string;
};

type OperationalCaseTestResult = {
  case: OperationalCase | null;
  conversationBindings?: OperationalCaseConversationBinding[];
  e2eLabSession?: OperationalCaseE2ELabSession | null;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  pendingActions?: SettingsTestPendingAction[];
  blockingActions?: SettingsTestPendingAction[];
  historicalActions?: SettingsTestPendingAction[];
  transitionCount?: number;
  e2eStartEvents?: OperationalCaseEvent[];
  flowProgress?: OperationalCaseFlowProgressStep[];
  lastTransition?: LastE2ETransitionOutcome | null;
};

type LabPendingAction = SettingsTestPendingAction;

type TestContextDraft = Record<string, string | string[]>;

type OperationalCaseFlowProgressStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked";

type OperationalCaseFlowProgressStep = {
  step_key: string;
  step_label: string;
  status: OperationalCaseFlowProgressStatus;
  evidence: string[];
  evidenceItems?: FlowProgressEvidenceItem[];
};

type ConversationalLabMode =
  | "sin_caso"
  | "intake_conversacional"
  | "listo_para_tick_manual"
  | "accion_humana_pendiente";

function asTestCaseResult(data: {
  case: OperationalCase | null;
  conversationBindings?: OperationalCaseConversationBinding[];
  e2eLabSession?: OperationalCaseE2ELabSession | null;
  events?: OperationalCaseEvent[];
  toolCalls?: ToolCall[];
  pendingActions?: SettingsTestPendingAction[];
  blockingActions?: SettingsTestPendingAction[];
  historicalActions?: SettingsTestPendingAction[];
  transitionCount?: number;
  e2eStartEvents?: OperationalCaseEvent[];
  flowProgress?: OperationalCaseFlowProgressStep[];
}): OperationalCaseTestResult {
  return {
    case: data.case,
    conversationBindings: data.conversationBindings ?? [],
    e2eLabSession: data.e2eLabSession ?? null,
    events: data.events ?? [],
    toolCalls: data.toolCalls ?? [],
    pendingActions: data.pendingActions ?? [],
    blockingActions: data.blockingActions ?? [],
    historicalActions: data.historicalActions ?? [],
    transitionCount: data.transitionCount ?? 0,
    e2eStartEvents: data.e2eStartEvents ?? [],
    flowProgress: data.flowProgress ?? [],
    lastTransition: null,
  };
}

function pickActiveConversationalCase(
  cases: OperationalCase[]
): OperationalCase | null {
  const conversational = cases.filter(
    (opCase) => opCase.context_jsonb?.created_from === "agent_conversation"
  );
  if (conversational.length === 0) return null;
  const pool = conversational.filter(
    (opCase) =>
      opCase.status !== "paused" &&
      opCase.status !== "completed" &&
      opCase.status !== "failed"
  );
  if (pool.length === 0) return null;

  const score = (opCase: OperationalCase) => {
    let value = 0;
    const e2eControlled = opCase.context_jsonb?.e2e_controlled === true;
    const intakeIncomplete =
      opCase.current_step === "intake" &&
      opCase.context_jsonb?.intake_status !== "complete";
    if (e2eControlled) value += 50;
    if (intakeIncomplete) value += 40;
    if (opCase.status === "waiting_internal") value += 20;
    if (opCase.status === "active") value += 15;
    if (opCase.status === "waiting_external") value += 10;
    return value;
  };

  return [...pool].sort((a, b) => {
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  })[0]!;
}

function isAbandonedConversationalE2ECase(
  opCase: OperationalCase | null | undefined
): boolean {
  return (
    opCase?.context_jsonb?.e2e_controlled === true &&
    opCase?.status === "paused" &&
    opCase.context_jsonb?.e2e_control_status === "abandoned"
  );
}

function deriveConversationalLabMode(params: {
  opCase: OperationalCase | null;
  hasPendingLabActions: boolean;
}): ConversationalLabMode {
  if (!params.opCase) return "sin_caso";
  if (params.hasPendingLabActions) return "accion_humana_pendiente";
  const intakeIncomplete =
    params.opCase.current_step === "intake" &&
    params.opCase.context_jsonb?.intake_status !== "complete";
  if (intakeIncomplete) return "intake_conversacional";
  return "listo_para_tick_manual";
}

type EditingSnapshot = {
  editing: EditingCaseType;
  schemaText: string;
  flowText: string;
  activationPolicyText: string;
  procedureText: string;
  fieldListText: string;
  createPrivateSkill: boolean;
  generatedSkillBody: string;
};

function caseTypeToEditing(row: OperationalCaseType): EditingCaseType {
  return {
    case_type: row.case_type,
    display_name: row.display_name,
    default_skill_slug: row.default_skill_slug,
    description: row.description ?? "",
    status: row.status ?? "active",
    visibility:
      row.visibility === "shared" || row.visibility === "private"
        ? row.visibility
        : "private",
    intake_schema_jsonb: Array.isArray(row.intake_schema_jsonb)
      ? row.intake_schema_jsonb
      : [],
    operational_flow_jsonb: Array.isArray(row.operational_flow_jsonb)
      ? row.operational_flow_jsonb
      : [],
    activation_policy_jsonb: row.activation_policy_jsonb ?? {},
    default_reminder_policy_jsonb: row.default_reminder_policy_jsonb ?? {},
    isNew: false,
  };
}

function newCaseType(): EditingCaseType {
  return {
    case_type: "",
    display_name: "",
    default_skill_slug: "",
    description: "",
    status: "active",
    visibility: "private",
    intake_schema_jsonb: DEFAULT_INTAKE_SCHEMA,
    operational_flow_jsonb: [],
    activation_policy_jsonb: DEFAULT_ACTIVATION_POLICY,
    default_reminder_policy_jsonb: {},
    isNew: true,
  };
}

function toSlug(value: string, separator: "-" | "_") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

function labelFromFieldName(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function labelFromSlug(value: string) {
  return labelFromFieldName(value.replace(/-/g, " "));
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

function normalizeAssetRequirements(
  value: unknown
): OperationalCaseFlowTool["required_assets"] {
  if (!Array.isArray(value)) return undefined;
  const assets = value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const asset = item as Record<string, unknown>;
      const assetKey =
        typeof asset.asset_key === "string" ? asset.asset_key.trim() : "";
      const label = typeof asset.label === "string" ? asset.label.trim() : "";
      if (!assetKey || !label) return null;
      return {
        asset_key: assetKey,
        label,
        description:
          typeof asset.description === "string" && asset.description.trim()
            ? asset.description.trim()
            : undefined,
        accept: Array.isArray(asset.accept)
          ? asset.accept
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
        max_size_mb:
          typeof asset.max_size_mb === "number" ? asset.max_size_mb : undefined,
        required: typeof asset.required === "boolean" ? asset.required : undefined,
        param:
          typeof asset.param === "string" && asset.param.trim()
            ? asset.param.trim()
            : undefined,
        min_count:
          typeof asset.min_count === "number" ? asset.min_count : undefined,
        max_count:
          typeof asset.max_count === "number" ? asset.max_count : undefined,
        collection:
          typeof asset.collection === "boolean" ? asset.collection : undefined,
      };
    })
    .filter(isPresent);
  return assets.length ? assets : undefined;
}

function normalizeFlowTool(value: unknown): OperationalCaseFlowTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const toolId = typeof record.tool_id === "string" ? record.tool_id.trim() : "";
  if (!toolId) return null;
  const requiredAssets = normalizeAssetRequirements(record.required_assets);
  const testAssets = normalizeAssetRequirements(record.test_assets);
  return {
    tool_id: toolId,
    tool_label:
      typeof record.tool_label === "string" && record.tool_label.trim()
        ? record.tool_label.trim()
        : undefined,
    tool_description:
      typeof record.tool_description === "string" &&
      record.tool_description.trim()
        ? record.tool_description.trim()
        : undefined,
    required_assets: requiredAssets?.length ? requiredAssets : undefined,
    test_assets: testAssets?.length ? testAssets : undefined,
  };
}

function normalizeFlowSkill(value: unknown): OperationalCaseFlowSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const skillSlug =
    typeof record.skill_slug === "string" ? record.skill_slug.trim() : "";
  if (!skillSlug) return null;
  return {
    skill_slug: skillSlug,
    skill_label:
      typeof record.skill_label === "string" && record.skill_label.trim()
        ? record.skill_label.trim()
        : undefined,
    skill_description:
      typeof record.skill_description === "string" &&
      record.skill_description.trim()
        ? record.skill_description.trim()
        : undefined,
    skill_tools: Array.isArray(record.skill_tools)
      ? record.skill_tools.map(normalizeFlowTool).filter(isPresent)
      : [],
  };
}

function normalizeOperationalFlow(value: unknown): OperationalCaseFlowStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((step, index): OperationalCaseFlowStep | null => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return null;
      const record = step as Record<string, unknown>;
      const stepKey =
        typeof record.step_key === "string" && record.step_key.trim()
          ? toSlug(record.step_key, "_")
          : `step_${index + 1}`;
      const stepLabel =
        typeof record.step_label === "string" && record.step_label.trim()
          ? record.step_label.trim()
          : labelFromSlug(stepKey);
      return {
        step_key: stepKey,
        step_label: stepLabel,
        step_description:
          typeof record.step_description === "string" &&
          record.step_description.trim()
            ? record.step_description.trim()
            : undefined,
        step_skills: Array.isArray(record.step_skills)
          ? record.step_skills.map(normalizeFlowSkill).filter(isPresent)
          : [],
        step_tools: Array.isArray(record.step_tools)
          ? record.step_tools.map(normalizeFlowTool).filter(isPresent)
          : [],
      };
    })
    .filter(isPresent);
}

function mergeActivationPolicy(
  value: OperationalCaseActivationPolicy | null | undefined
): Required<OperationalCaseActivationPolicy> {
  return {
    safe_test: {
      ...DEFAULT_ACTIVATION_POLICY.safe_test,
      ...(value?.safe_test ?? {}),
    },
    activation_checks: {
      ...DEFAULT_ACTIVATION_POLICY.activation_checks,
      ...(value?.activation_checks ?? {}),
    },
  };
}

function formatPolicyCopy(template: string | undefined, values: Record<string, string>) {
  let result = template ?? "";
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function fallbackOperationalFlow(params: {
  defaultSkillSlug: string;
  skill?: SkillSummary;
}): OperationalCaseFlowStep[] {
  const skill = params.skill;
  const includedSkills = skill?.includes ?? [];
  const rootTools =
    skill?.allowedTools.map((tool) => ({
      tool_id: tool,
      tool_label: labelFromSlug(tool),
      tool_description: "Herramienta permitida por la habilidad asociada.",
    })) ?? [];

  if (includedSkills.length === 0) {
    return [
      {
        step_key: "main",
        step_label: "Flujo principal",
        step_description:
          "Vista inferida desde la habilidad asociada porque este caso de uso aún no tiene flujo estructurado.",
        step_skills: skill
          ? [
              {
                skill_slug: params.defaultSkillSlug,
                skill_label: labelFromSlug(params.defaultSkillSlug),
                skill_description: skill.description,
                skill_tools: rootTools,
              },
            ]
          : [],
        step_tools: skill ? [] : rootTools,
      },
    ];
  }

  return includedSkills.map((slug, index) => ({
    step_key: `step_${index + 1}`,
    step_label: labelFromSlug(slug),
    step_description:
      "Paso inferido desde una skill incluida. Revisa y ajusta el flujo estructurado antes de activar.",
    step_skills: [
      {
        skill_slug: slug,
        skill_label: labelFromSlug(slug),
        skill_tools: [],
      },
    ],
    step_tools: [],
  }));
}

function inferFieldType(label: string): OperationalCaseIntakeField["type"] {
  const normalized = label.toLowerCase();
  if (
    normalized.includes("nota") ||
    normalized.includes("descrip") ||
    normalized.includes("context") ||
    normalized.includes("interés") ||
    normalized.includes("interes")
  ) {
    return "textarea";
  }
  if (normalized.includes("canal") || normalized.includes("medio")) {
    return "select";
  }
  return "text";
}

function parseFieldList(value: string): OperationalCaseIntakeField[] {
  const parts = value
    .split(/\n|,|;/)
    .map((part) => part.trim())
    .filter(Boolean);

  const fields = parts.map((part, index) => {
    const name = toSlug(part, "_") || `campo_${index + 1}`;
    const type = inferFieldType(part);
    return {
      name,
      label: labelFromFieldName(part),
      type,
      required: index === 0,
      placeholder:
        type === "textarea"
          ? "Contexto relevante"
          : type === "select"
            ? undefined
            : `Ej. ${labelFromFieldName(part)}`,
      options:
        type === "select"
          ? ["telegram", "whatsapp", "email", "phone"]
          : undefined,
    } satisfies OperationalCaseIntakeField;
  });

  return fields.length > 0 ? fields : DEFAULT_INTAKE_SCHEMA;
}

function yamlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 900)}"`;
}

/**
 * YAML scalar para `description`. Si el texto tiene saltos de línea (típico
 * cuando el usuario lo escribe con bullets), un string entre comillas dobles
 * "fold" colapsa los saltos a espacios y junta los bullets en una sola línea
 * — eso rompe la legibilidad y la semántica. Usamos bloque literal `|` para
 * preservar las líneas tal cual.
 */
function yamlDescription(value: string, indent: number): string {
  const trimmed = value.trim();
  if (!trimmed) return yamlString("");
  if (!trimmed.includes("\n")) return yamlString(trimmed);
  const pad = " ".repeat(indent);
  const lines = trimmed
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
  return `|\n${lines}`;
}

function buildSkillBody(params: {
  slug: string;
  displayName: string;
  description: string;
  procedureText: string;
  fields: OperationalCaseIntakeField[];
  allowedTools?: string[];
  includes?: string[];
}) {
  const procedure =
    params.procedureText.trim() ||
    "Describe el procedimiento operativo que debe seguir Gu para este caso de uso.";
  const fieldLines = params.fields
    .map((field) => `- ${field.label} (${field.name})`)
    .join("\n");
  const toolLines =
    params.allowedTools && params.allowedTools.length > 0
      ? params.allowedTools.map((tool) => `  - ${tool}`).join("\n")
      : "[]";
  const includeLines =
    params.includes && params.includes.length > 0
      ? params.includes.map((slug) => `  - ${slug}`).join("\n")
      : "[]";

  return `---
name: ${params.slug}
description: ${yamlDescription(params.description || `Guía operativa para ${params.displayName}.`, 2)}
scope: business
allowed_tools:${toolLines === "[]" ? " []" : `\n${toolLines}`}
includes:${includeLines === "[]" ? " []" : `\n${includeLines}`}
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Sigue el procedimiento definido por la cuenta. Si falta información crítica, pide aclaración antes de avanzar. No ejecutes acciones externas sin confirmación cuando impliquen riesgo comercial, legal o reputacional.
---

# ${params.displayName}

## Procedimiento operativo

${procedure}

## Datos iniciales esperados

${fieldLines || "- Sin campos iniciales configurados."}

## Criterio de operación

Usa esta habilidad cuando exista un caso en operación de este tipo. Lee el contexto del caso, identifica el paso actual, decide la siguiente acción y registra avances mediante las herramientas operativas disponibles.
`;
}

function scopeLabel(row: OperationalCaseType) {
  if (row.visibility === "global" || !row.user_id) return "global";
  return row.visibility ?? "private";
}

/** Colores y etiquetas para distinguir plantilla de producto vs de cuenta a simple vista. */
function templateScopePresentation(isGlobal: boolean) {
  if (isGlobal) {
    return {
      badge:
        "bg-amber-100 text-amber-950 ring-1 ring-amber-300/80 dark:bg-amber-950/45 dark:text-amber-100 dark:ring-amber-700/50",
      listBadge: "Producto global",
      detailBadge: "Plantilla de producto (global)",
      hint: "Incluida con el producto; solo lectura.",
    };
  }
  return {
    badge:
      "bg-emerald-100 text-emerald-950 ring-1 ring-emerald-300/80 dark:bg-emerald-950/45 dark:text-emerald-100 dark:ring-emerald-700/50",
    listBadge: "Cuenta",
    detailBadge: "Plantilla de esta cuenta",
    hint: "Propia de tu cuenta; editable.",
  };
}

function skillKindLabel(kind: string) {
  if (kind === "composite") return "compuesta";
  if (kind === "atomic") return "atómica";
  return kind;
}

function scopeText(scope: string) {
  if (scope === "business") return "negocio";
  if (scope === "personal") return "personal";
  if (scope === "shared") return "compartido";
  return scope;
}

function descriptionParts(description: string) {
  const [intro, rest] = description.split(/:\s*/, 2);
  const steps = rest
    ?.split(/,\s*|;\s*/)
    .map((step) => step.trim())
    .filter(Boolean);

  if (!rest || !steps || steps.length < 2) {
    return { intro: description, steps: [] };
  }

  return { intro: `${intro}:`, steps };
}

function descriptionForEditing(description: string) {
  const { intro, steps } = descriptionParts(description);
  if (steps.length === 0) return description;
  return [intro, "", ...steps.map((step) => `- ${step}`)].join("\n");
}

function authoringHasStatus(
  result: SkillAuthoringResult | null,
  status: "WARN" | "FAIL"
) {
  return (
    result?.validationRubric.some(
      (item) => String(item.status ?? "").toUpperCase() === status
    ) ?? false
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function fallbackAuthoringMessage(elapsedMs: number) {
  if (elapsedMs > 120000) {
    return "Sigue trabajando; si hay reintentos, aparecerán abajo en detalles.";
  }
  if (elapsedMs > 60000) {
    return "Validando y compactando el borrador. Puede tardar un poco más.";
  }
  if (elapsedMs > 30000) {
    return "El modelo está componiendo el SKILL.md optimizado.";
  }
  return "Preparando contexto y ejecutando skill-authoring.";
}

function toolReadinessLabel(status: ToolReadinessStatus) {
  if (status === "ready") return "Lista";
  if (status === "needs_config") return "Configurar";
  if (status === "stub") return "Stub";
  if (status === "missing") return "Falta";
  return "Desconocida";
}

function toolReadinessClass(status: ToolReadinessStatus) {
  return readinessLabToolShellClass(status);
}

function toolReadinessSummaryLabel(summary?: ToolReadinessResult["summary"]) {
  if (summary === "ready") return "Herramientas listas";
  if (summary === "has_stubs") return "Pendientes técnicos";
  if (summary === "needs_config") return "Preparación incompleta";
  return "Sin diagnóstico";
}

function toolReadinessCounts(result: ToolReadinessResult | null) {
  const counts = {
    visibleTotal: 0,
    ready: 0,
    untested: 0,
    testedOk: 0,
    needs_config: 0,
    stub: 0,
    missing: 0,
    unknown: 0,
    blocking: 0,
  };
  for (const tool of result?.tools ?? []) {
    if (!isReadinessVisibleTool(tool.tool_id)) continue;
    counts.visibleTotal += 1;
    counts[tool.status] += 1;
    if (tool.status === "ready" && tool.test_status === "ready_untested") {
      counts.untested += 1;
    }
    if (tool.test_status === "tested_ok") counts.testedOk += 1;
    if (tool.blocking) counts.blocking += 1;
  }
  return counts;
}

function testCasePreparationStatus(params: {
  hasCase: boolean;
  registrationReady: boolean;
  safeCheckPassed: boolean;
  toolsHaveBlocks: boolean;
}): { label: string; tone: "pending" | "attention" | "ready" } {
  if (!params.hasCase) {
    return params.toolsHaveBlocks
      ? { label: "Tools pendientes", tone: "attention" }
      : { label: "Sin datos de caso de prueba", tone: "pending" };
  }
  if (params.toolsHaveBlocks) {
    return { label: "Tools pendientes", tone: "attention" };
  }
  if (!params.registrationReady) {
    return { label: "Caso creado · validar registro", tone: "attention" };
  }
  if (params.safeCheckPassed) {
    return { label: "Registro validado", tone: "ready" };
  }
  return { label: "Registro validado por avance", tone: "ready" };
}

function testCaseIntakePrepared(params: {
  hasCase: boolean;
  testPassed: boolean;
  currentStep: string | null | undefined;
}): boolean {
  if (!params.hasCase) return false;
  if (params.testPassed) return true;
  return Boolean(params.currentStep && params.currentStep !== "intake");
}

function activationSafeTestCheckCopy(params: {
  testPassed: boolean;
  intakePrepared: boolean;
  testStatus: string | undefined;
  policy: Required<OperationalCaseActivationPolicy>;
}): string {
  if (params.testPassed) {
    if (
      params.testStatus === "e2e_tick_completed" ||
      params.testStatus === "e2e_pending_hitl"
    ) {
      return "Prueba con agente ejecutada (una transición controlada sobre el caso de prueba).";
    }
    return (
      params.policy.activation_checks?.safe_test_success_copy ??
      DEFAULT_ACTIVATION_POLICY.activation_checks.safe_test_success_copy ??
      "Registro validado."
    );
  }
  if (params.intakePrepared) {
    return "Registro validado: el caso de prueba ya está en el flujo operativo (p. ej. tras pruebas de paso).";
  }
  return (
    params.policy.activation_checks?.safe_test_success_copy ??
    DEFAULT_ACTIVATION_POLICY.activation_checks.safe_test_success_copy ??
    "Registro pendiente de validar."
  );
}

function activationConversationalCheckCopy(params: {
  ready: boolean;
  policy: Required<OperationalCaseActivationPolicy>;
}): string {
  if (params.ready) {
    return (
      params.policy.activation_checks?.conversational_safe_copy ??
      DEFAULT_ACTIVATION_POLICY.activation_checks.conversational_safe_copy ??
      "Listo para chat/Telegram en modo controlado."
    );
  }
  return "Requiere plantilla activa, skill sin bloqueos, tools completas para operar y registro del caso validado.";
}

function operationalStepReadinessSummary(steps: ToolReadinessFlowStep[]) {
  return {
    total: steps.length,
    testedOk: steps.filter((s) => s.test_status === "tested_ok").length,
    testedFailed: steps.filter((s) => s.test_status === "tested_failed").length,
    blocked: steps.filter((s) => s.test_status === "blocked").length,
    readyToTest: steps.filter((s) => s.test_status === "ready_to_test").length,
    partial: steps.filter((s) => s.test_status === "partially_tested").length,
    awaitingN4: steps.filter((s) => s.test_status === "awaiting_n4").length,
  };
}

function activationStepProgressCheck(params: {
  steps: ToolReadinessFlowStep[];
}): { status: "ready" | "attention" | "pending"; label: string; copy: string } {
  const summary = operationalStepReadinessSummary(params.steps);
  if (summary.total === 0) {
    return {
      status: "pending",
      label: "Pendiente",
      copy: "Sin pasos operativos en el flujo; revisa operational_flow_jsonb.",
    };
  }
  const parts: string[] = [
    `${summary.testedOk} de ${summary.total} pasos con todos los escenarios probados`,
  ];
  if (summary.blocked > 0) {
    parts.push(
      `${summary.blocked} paso${summary.blocked === 1 ? "" : "s"} con integraciones pendientes`
    );
  }
  if (summary.partial > 0) {
    parts.push(
      `${summary.partial} paso${summary.partial === 1 ? "" : "s"} con escenarios en progreso`
    );
  }
  if (summary.awaitingN4 > 0) {
    parts.push(
      `${summary.awaitingN4} paso${summary.awaitingN4 === 1 ? "" : "s"} listos para probar escenarios`
    );
  }
  if (summary.readyToTest > 0) {
    parts.push(
      `${summary.readyToTest} paso${summary.readyToTest === 1 ? "" : "s"} aún sin prueba de habilidad`
    );
  }
  if (summary.testedFailed > 0) {
    parts.push(
      `${summary.testedFailed} con fallo en última prueba`
    );
  }
  if (summary.partial > 0) {
    parts.push(`${summary.partial} con validación parcial`);
  }
  const allOk = summary.testedOk === summary.total;
  return {
    status: allOk ? "ready" : summary.testedOk > 0 ? "attention" : "pending",
    label: allOk ? "✓ Listo" : summary.testedOk > 0 ? "En progreso" : "Pendiente",
    copy: parts.join(" · "),
  };
}

function testCaseStatusPillClass(tone: "pending" | "attention" | "ready") {
  if (tone === "ready") return "bg-emerald-50 text-emerald-800";
  if (tone === "attention") return "bg-amber-50 text-amber-800";
  return "bg-neutral-100 text-neutral-700";
}

function countReadinessVisibleToolsInStep(step: ToolReadinessFlowStep) {
  const ids = new Set<string>();
  for (const skill of step.step_skills ?? []) {
    for (const tool of skill.skill_tools ?? []) {
      if (isReadinessVisibleTool(tool.tool_id)) ids.add(tool.tool_id);
    }
  }
  for (const tool of step.step_tools ?? []) {
    if (isReadinessVisibleTool(tool.tool_id)) ids.add(tool.tool_id);
  }
  return ids.size;
}

function stepExpandableSummaryHint(step: ToolReadinessFlowStep) {
  const skillCount = step.step_skills?.length ?? 0;
  const toolCount = countReadinessVisibleToolsInStep(step);
  const parts: string[] = [];
  const scenarioProgress = formatStepScenarioProgress(step.step_test_progress);
  if (scenarioProgress) {
    parts.push(scenarioProgress);
  }
  const scenarioChecklist = formatStepScenarioChecklist(step.step_test_progress);
  if (scenarioChecklist) {
    parts.push(scenarioChecklist);
  }
  if (skillCount > 0) {
    parts.push(`${skillCount} habilidad${skillCount === 1 ? "" : "es"}`);
  }
  if (toolCount > 0) {
    parts.push(
      `${toolCount} integración${toolCount === 1 ? "" : "es"} / acción${toolCount === 1 ? "" : "es"}`
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function toolReadinessCategoryLabel(category: ToolReadinessCategory) {
  if (category === "product_integration") return "Integración del producto";
  if (category === "account_config") return "Configuración de cuenta";
  if (category === "tenant_asset") return "Recurso de cuenta";
  if (category === "technical_stub") return "Pendiente técnico";
  if (category === "skill_definition") return "Definición de skill";
  return "Lista";
}

function readinessRequestStatusLabel(status: ToolReadinessRequestStatus) {
  if (status === "requested") return "realizada";
  if (status === "in_review") return "En revisión";
  if (status === "in_progress") return "En desarrollo";
  if (status === "shipped") return "Lista";
  if (status === "rejected") return "No se incorporará";
  return status;
}

function operationCompletenessDescription(params: {
  readinessCounts: ReturnType<typeof toolReadinessCounts>;
  toolsPass: boolean;
  policy: Required<OperationalCaseActivationPolicy>;
}) {
  if (!params.toolsPass) {
    return params.policy.activation_checks.readiness_blocked_copy;
  }
  if (params.readinessCounts.stub > 0) {
    return formatPolicyCopy(
      params.policy.activation_checks.real_operation_pending_copy,
      { stub_count: String(params.readinessCounts.stub) }
    );
  }
  const technicalPending =
    params.readinessCounts.needs_config +
    params.readinessCounts.missing +
    params.readinessCounts.unknown;
  if (technicalPending > 0) {
    return `Operación real completa: pendiente; quedan ${technicalPending} tools por configurar, incorporar o revisar antes de operar sin restricciones.`;
  }
  return params.policy.activation_checks.real_operation_complete_copy;
}

function readinessActionUrl(item: ToolReadinessToolItem): string | null {
  if (!item.action_url) return null;
  if (item.action_anchor) {
    return `${item.action_url}#${item.action_anchor}`;
  }
  return item.action_url;
}

function readinessRequestActionLabel(item: ToolReadinessToolItem) {
  if (item.status === "stub" && item.category === "technical_stub") {
    return "Solicitar prioridad";
  }
  if (item.status === "stub" && item.category === "tenant_asset") {
    return "Solicitar recurso";
  }
  return item.action_label ?? "Solicitar incorporación";
}

function formatFileSize(bytes: number | null | undefined) {
  if (!bytes) return "tamaño no registrado";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TEST_PROPERTY_DOCUMENT_ASSET_KEY = "test_property_document";

const COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY = "commission_contract_template";
const DOCX_TEMPLATE_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Accept del input file; la plantilla de contrato solo admite DOCX en runtime. */
function effectiveAssetAccept(requirement: ToolAssetRequirementStatus): string[] {
  if (requirement.asset_key === COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY) {
    return [DOCX_TEMPLATE_MIME, ".docx"];
  }
  return requirement.accept ?? [];
}

const PROPERTY_DOCUMENT_KIND_OPTIONS = [
  { value: "escritura_descripcion", label: "Escritura - descripción" },
  { value: "predial", label: "Predial" },
  { value: "ine", label: "INE" },
  { value: "comprobante_domicilio", label: "Comprobante domicilio" },
  { value: "boleta_registral", label: "Boleta registral" },
  { value: "escritura_primera_hoja", label: "Escritura - primera hoja" },
  { value: "escritura_ultima_hoja", label: "Escritura - última hoja" },
  { value: "unknown", label: "Sin clasificar" },
] as const;

function isPropertyDocumentRequirement(requirement: ToolAssetRequirementStatus) {
  return (
    requirement.asset_key === TEST_PROPERTY_DOCUMENT_ASSET_KEY ||
    requirement.asset_key.startsWith(`${TEST_PROPERTY_DOCUMENT_ASSET_KEY}__`)
  );
}

function propertyDocumentKindLabel(value: unknown) {
  const kind = typeof value === "string" ? value : "";
  return (
    PROPERTY_DOCUMENT_KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    (kind || "Escritura - descripción")
  );
}

function requirementMinCount(requirement: ToolAssetRequirementStatus) {
  if (typeof requirement.min_count === "number") return requirement.min_count;
  return requirement.required === false ? 0 : 1;
}

function requirementMaxCount(requirement: ToolAssetRequirementStatus) {
  if (typeof requirement.max_count === "number") return requirement.max_count;
  return 1;
}

function isCollectionRequirement(requirement: ToolAssetRequirementStatus) {
  return requirement.collection === true || requirementMaxCount(requirement) > 1;
}

function collectionAssetKey(baseKey: string, index: number) {
  return `${baseKey}__${String(index + 1).padStart(3, "0")}`;
}

function nextCollectionAssetKey(requirement: ToolAssetRequirementStatus) {
  const used = new Set((requirement.assets ?? []).map((asset) => asset.asset_key));
  const maxCount = requirementMaxCount(requirement);
  for (let index = 0; index < maxCount; index += 1) {
    const key = collectionAssetKey(requirement.asset_key, index);
    if (!used.has(key)) return key;
  }
  return null;
}

function AccountAssetUploadPanel({
  item,
  row,
  title = "Recursos de cuenta",
  panelHint,
  requirements,
  successMessage = "Recurso guardado. Preparación operativa actualizada.",
  onBeforeUpload,
  onUploaded,
}: {
  item: ToolReadinessToolItem;
  row: OperationalCaseType;
  title?: string;
  panelHint?: string;
  requirements?: ToolAssetRequirementStatus[];
  successMessage?: string;
  onBeforeUpload?: () => void;
  onUploaded: () => Promise<void> | void;
}) {
  const effectiveRequirements = requirements ?? item.asset_requirements ?? [];
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [documentKindByRequirement, setDocumentKindByRequirement] = useState<
    Record<string, string>
  >({});

  function documentKindForRequirement(requirement: ToolAssetRequirementStatus) {
    return (
      documentKindByRequirement[requirement.asset_key] ?? "escritura_descripcion"
    );
  }

  async function uploadAsset(
    requirement: ToolAssetRequirementStatus,
    file: File,
    assetKey = requirement.asset_key,
    refreshAfterUpload = true
  ) {
    setMessage(null);
    const maxSize = (requirement.max_size_mb ?? 15) * 1024 * 1024;
    if (file.size > maxSize) {
      setMessage(`El archivo supera el máximo de ${requirement.max_size_mb ?? 15} MB.`);
      return;
    }
    setSubmittingKey(assetKey);
    onBeforeUpload?.();
    try {
      const formData = new FormData();
      formData.set("asset_key", assetKey);
      formData.set("display_name", requirement.label);
      formData.set("description", requirement.description ?? "");
      formData.set("source_tool_id", item.tool_id);
      formData.set("case_type_id", row.id);
      formData.set("file", file);
      if (isPropertyDocumentRequirement(requirement)) {
        formData.set("document_kind", documentKindForRequirement(requirement));
      }
      const res = await fetch("/api/account-assets", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "No se pudo subir el recurso.");
      }
      if (refreshAfterUpload) {
        setMessage("Recurso guardado. Recalculando preparación operativa...");
        await onUploaded();
        setMessage(successMessage);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingKey(null);
    }
  }

  async function uploadCollectionAssets(
    requirement: ToolAssetRequirementStatus,
    files: FileList | File[]
  ) {
    setMessage(null);
    const selectedFiles = Array.from(files);
    const maxCount = requirementMaxCount(requirement);
    const currentCount = requirement.assets?.length ?? 0;
    const availableSlots = Math.max(0, maxCount - currentCount);
    if (availableSlots <= 0) {
      setMessage(`Ya alcanzaste el máximo de ${maxCount} archivos.`);
      return;
    }
    const filesToUpload = selectedFiles.slice(0, availableSlots);
    if (filesToUpload.length < selectedFiles.length) {
      setMessage(`Sólo se agregarán ${availableSlots} archivo(s); máximo ${maxCount}.`);
    }
    const usedKeys = new Set((requirement.assets ?? []).map((asset) => asset.asset_key));
    try {
      for (const file of filesToUpload) {
        const tempRequirement = {
          ...requirement,
          assets: Array.from(usedKeys).map((assetKey) => ({ asset_key: assetKey }) as AccountAsset),
        };
        const assetKey = nextCollectionAssetKey(tempRequirement);
        if (!assetKey) break;
        usedKeys.add(assetKey);
        await uploadAsset(requirement, file, assetKey, false);
      }
      setMessage("Recursos guardados. Recalculando preparación operativa...");
      await onUploaded();
      setMessage(successMessage);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingKey(null);
    }
  }

  async function deleteAsset(asset: AccountAsset) {
    setMessage(null);
    setSubmittingKey(asset.asset_key);
    try {
      const res = await fetch(
        `/api/account-assets?asset_key=${encodeURIComponent(asset.asset_key)}`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "No se pudo eliminar el recurso.");
      }
      setMessage("Recurso eliminado. Recalculando preparación operativa...");
      await onUploaded();
      setMessage("Recurso eliminado. Preparación operativa actualizada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingKey(null);
    }
  }

  if (effectiveRequirements.length === 0) return null;
  const resolvedHint =
    panelHint ??
    (title === "Recursos de cuenta"
      ? ACCOUNT_RESOURCES_PANEL_HINT
      : title === "Activos de prueba"
        ? TEST_ASSETS_PANEL_HINT
        : undefined);
  return (
    <div className="space-y-2 rounded border border-white/70 bg-white/85 p-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          {title}
        </div>
        {resolvedHint ? (
          <p className="mt-1 text-[11px] leading-snug text-neutral-600">
            {resolvedHint}
          </p>
        ) : null}
      </div>
      {effectiveRequirements.map((requirement) => {
        const isCollection = isCollectionRequirement(requirement);
        const assets = requirement.assets?.length
          ? requirement.assets
          : requirement.asset
            ? [requirement.asset]
            : [];
        const minCount = requirementMinCount(requirement);
        const maxCount = requirementMaxCount(requirement);
        const canUpload = !isCollection || assets.length < maxCount;
        return (
        <div
          key={requirement.asset_key}
          className="rounded border border-neutral-200 bg-white p-2 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">{requirement.label}</div>
              <div className="font-mono text-[11px] text-neutral-500">
                {requirement.asset_key}
              </div>
            </div>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                requirement.configured
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-amber-50 text-amber-800"
              }`}
            >
              {isCollection
                ? `${assets.length}/${maxCount}`
                : requirement.configured
                  ? "Configurado"
                  : "Pendiente"}
            </span>
          </div>
          {requirement.description ? (
            <p className="mt-1 text-neutral-500">{requirement.description}</p>
          ) : null}
          {requirement.asset_key === COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY ? (
            <p className="mt-1 text-[11px] text-neutral-500">
              Formato admitido: .docx (Word con placeholders {"{{campo}}"}).
            </p>
          ) : null}
          {isCollection ? (
            <div className="mt-2 space-y-1">
              {assets.length > 0 ? (
                <div className="max-h-40 space-y-1 overflow-auto rounded border border-neutral-100 bg-neutral-50 p-1">
                  {assets.map((asset) => (
                    <div
                      key={asset.asset_key}
                      className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium">
                          {String(asset.metadata_jsonb?.original_name ?? asset.display_name)}
                        </div>
                        <div className="font-mono text-[10px] text-neutral-400">
                          {propertyDocumentKindLabel(asset.metadata_jsonb?.document_kind)} ·{" "}
                          {asset.content_type ?? "archivo"} ·{" "}
                          {formatFileSize(asset.file_size_bytes)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                        disabled={Boolean(submittingKey)}
                        onClick={() => void deleteAsset(asset)}
                      >
                        Quitar
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="text-[11px] text-neutral-500">
                {assets.length} archivo(s) listos · mínimo {minCount}, máximo {maxCount}.
              </p>
            </div>
          ) : requirement.asset ? (
            <p className="mt-1 text-[11px] text-neutral-500">
              Actual:{" "}
              {String(
                requirement.asset.metadata_jsonb?.original_name ??
                  requirement.asset.display_name
              )}{" "}
              ·{" "}
              {isPropertyDocumentRequirement(requirement)
                ? `${propertyDocumentKindLabel(requirement.asset.metadata_jsonb?.document_kind)} · `
                : ""}
              {requirement.asset.content_type ?? "archivo"} ·{" "}
              {formatFileSize(requirement.asset.file_size_bytes)}
            </p>
          ) : null}
          {isPropertyDocumentRequirement(requirement) ? (
            <label className="mt-2 block text-[11px] text-neutral-600">
              <span className="font-semibold">Tipo de documento</span>
              <select
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-[11px]"
                value={documentKindForRequirement(requirement)}
                onChange={(event) =>
                  setDocumentKindByRequirement((current) => ({
                    ...current,
                    [requirement.asset_key]: event.target.value,
                  }))
                }
              >
                {PROPERTY_DOCUMENT_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label
            className={`mt-2 inline-flex rounded px-2 py-1 text-[11px] font-semibold text-white ${
              canUpload
                ? "cursor-pointer bg-violet-700 hover:bg-violet-800"
                : "cursor-not-allowed bg-neutral-400"
            }`}
          >
            {submittingKey?.startsWith(requirement.asset_key)
              ? "Subiendo..."
              : isCollection
                ? "Agregar documento"
                : requirement.configured
                ? "Reemplazar recurso"
                : "Subir recurso"}
            <input
              type="file"
              className="hidden"
              accept={effectiveAssetAccept(requirement).join(",")}
              multiple={isCollection}
              disabled={Boolean(submittingKey) || !canUpload}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length === 0) return;
                if (isCollection) {
                  void uploadCollectionAssets(requirement, files);
                } else {
                  const file = files[0];
                  if (file) void uploadAsset(requirement, file);
                }
              }}
            />
          </label>
        </div>
        );
      })}
      {message ? <p className="text-[11px] text-neutral-600">{message}</p> : null}
    </div>
  );
}

type ToolTestMode = "smoke" | "case";

interface ToolTestResponse {
  ok: boolean;
  executed?: boolean;
  tool_id: string;
  risk: "low" | "medium" | "high";
  dry_run: boolean;
  reason: string;
  requested_mode?: ToolTestMode;
  mode_used?: ToolTestMode;
  mode_source?: string;
  case_id?: string | null;
  resolved_args: Record<string, unknown>;
  elapsed_ms?: number;
  error?: string | null;
  hint?: string;
  summary?: {
    ok: boolean | null;
    status: string | null;
    count: number | null;
    preview: unknown[] | null;
  } | null;
  result?: unknown;
  raw_text?: string;
}

const MODE_LABELS: Record<ToolTestMode, string> = {
  smoke: "Smoke test",
  case: "Caso de prueba",
};

const MODE_DESCRIPTIONS: Record<ToolTestMode, string> = {
  smoke:
    "Args mínimos genéricos (plantilla). Si la tool requiere un caso de prueba y existe, smoke puede enlazar case_id automáticamente. La tool recibe únicamente el JSON mostrado.",
  case:
    "Args armados desde el contexto del caso de prueba del laboratorio (más overrides en Avanzado). La tool recibe sólo ese JSON resuelto, no un formulario paralelo en runtime.",
};

function documentToolReadinessHint(toolId: string, flowStepKey?: string) {
  switch (toolId) {
    case "operational_case_list_documents":
      return flowStepKey === "awaiting_documents"
        ? "Lista documentos del caso. Si cargaste Activos de prueba, la ejecución puede sincronizar el PDF al caso antes de listar."
        : "Lista documentos recibidos y su estado de extracción para confirmar evidencia usable.";
    case "operational_case_extract_document_fields":
      return "Extrae campos visibles del documento. Si falta document_id en args, se usa el documento de prueba preferido del caso.";
    case "operational_case_register_document":
      return "Registra en el caso el archivo subido en Activos de prueba.";
    default:
      return null;
  }
}

const MODE_SOURCE_LABELS: Record<string, string> = {
  smoke_defaults: "smoke defaults",
  smoke_bound_test_case: "smoke con caso de prueba (case_id + versión)",
  manual_user_args: "args manuales",
  flow_test_inputs_mapping: "mapping del flow",
  tool_recipe: "recipe por tool",
  generic_param_name_match: "match por nombre de param",
  fallback_smoke_no_test_case: "fallback smoke (sin caso de prueba)",
  preview_only: "preview",
};

const CONTROLLED_WRITE_COPY: Record<
  string,
  {
    confirmation: string;
    title: string;
    description: string;
    button: string;
  }
> = {
  telegram_send_message_to_contact: {
    confirmation: "ENVIAR PRUEBA",
    title: "Prueba real controlada por Telegram",
    description:
      "Envía un mensaje real al chat_id externo mostrado en los args. El sistema agrega el prefijo [PRUEBA CONTROLADA]. Úsalo sólo con un contacto/chat de prueba. En paso 3 el texto pide características faltantes, no el checklist de documentos.",
    button: "Enviar prueba por Telegram",
  },
  easybroker_create_listing: {
    confirmation: "CREAR BORRADOR",
    title: "Prueba real controlada",
    description:
      "Crea una propiedad real en EasyBroker como not_published y fuerza el prefijo [PRUEBA - BORRAR] en el título. Úsalo sólo para validar la integración; después borra el borrador manualmente en EasyBroker.",
    button: "Ejecutar prueba real controlada",
  },
  easybroker_upload_images: {
    confirmation: "FOTOS A BORRADOR",
    title: "Prueba real controlada de fotos",
    description:
      "Envía las fotos temporales al borrador de EasyBroker resuelto. Si antes se creó un borrador desde easybroker_create_listing, se usará ese listing_id automáticamente; si no, indícalo en args avanzados. EasyBroker reemplaza el arreglo de imágenes de esa ficha.",
    button: "Subir fotos al borrador",
  },
  calendar_create_event: {
    confirmation: "CREAR EVENTO PRUEBA",
    title: "Crear evento de prueba en Google Calendar",
    description:
      "Crea un evento real en tu calendario primary con prefijo [PRUEBA CONTROLADA] en el título. El id queda en photo_session.calendar_event_id del caso de prueba para probar «Actualizar evento» después. Borra el evento en Google Calendar cuando termines.",
    button: "Crear evento de prueba",
  },
};

type OutcomeVariant = "success" | "warning" | "error" | "info";

const WIZARD_PRIMARY_BUTTON_CLASS =
  "rounded bg-violet-700 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-violet-300 disabled:text-violet-100 dark:disabled:bg-violet-900/50 dark:disabled:text-violet-300";

function outcomePanelClass(variant: OutcomeVariant) {
  switch (variant) {
    case "success":
      return "border-emerald-300 bg-emerald-50 text-emerald-950";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-950";
    case "error":
      return "border-red-300 bg-red-50 text-red-950";
    case "info":
      return "border-violet-300 bg-violet-50 text-violet-950";
  }
}

function OutcomePanel({
  variant,
  title,
  children,
  className = "",
  id,
}: {
  variant: OutcomeVariant;
  title: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`rounded border p-3 text-[11px] ${outcomePanelClass(variant)} ${className}`}
    >
      <div className="font-semibold">{title}</div>
      {children}
    </div>
  );
}

function summarizeUnggaWizardIssues(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const root = result as Record<string, unknown>;
  const cli = root.cli_result;
  if (!cli || typeof cli !== "object") return [];
  const metrics = (cli as Record<string, unknown>).metrics;
  if (!Array.isArray(metrics)) return [];
  const lines: string[] = [];
  for (const entry of metrics) {
    if (!entry || typeof entry !== "object") continue;
    const step = entry as Record<string, unknown>;
    if (step.ok !== false) continue;
    const name = typeof step.step === "string" ? step.step : "paso";
    const errs = Array.isArray(step.validation_errors)
      ? step.validation_errors.filter((e) => typeof e === "string" && e !== "*")
      : [];
    if (errs.length > 0) {
      lines.push(`${name}: ${errs.join("; ")}`);
      continue;
    }
    if (typeof step.error === "string" && step.error.trim()) {
      lines.push(`${name}: ${step.error}`);
    }
  }
  const inner = (cli as Record<string, unknown>).result;
  if (inner && typeof inner === "object") {
    const stages = (inner as Record<string, unknown>).stages;
    if (Array.isArray(stages)) {
      for (const stage of stages) {
        if (!stage || typeof stage !== "object") continue;
        const filled = (stage as Record<string, unknown>).filled;
        if (!Array.isArray(filled)) continue;
        for (const item of filled) {
          if (item && typeof item === "object" && (item as { ok?: boolean }).ok === false) {
            const err = (item as { error?: string }).error;
            const tab = (stage as { tab?: string }).tab ?? "tab";
            if (err) lines.push(`${tab}: ${err}`);
          }
        }
      }
    }
  }
  return [...new Set(lines)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validEasyBrokerListingId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim() !== "REEMPLAZA-CON-LISTING-ID"
  );
}

function easyBrokerListingIdFromResult(result: unknown) {
  const root = asRecord(result);
  if (!root) return null;
  const listingId = root.listing_id;
  if (validEasyBrokerListingId(listingId)) return listingId.trim();
  const publicId = root.public_id;
  if (validEasyBrokerListingId(publicId)) return publicId.trim();
  return null;
}

function resultItems(result: unknown): Record<string, unknown>[] {
  const root = asRecord(result);
  const results = root?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function imageOutputItems(result: unknown): Record<string, unknown>[] {
  const root = asRecord(result);
  const outputs = root?.outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs
    .map((item) => asRecord(item))
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(
          item?.ok === true &&
            typeof item.signed_url === "string" &&
            item.signed_url.trim()
        )
    );
}

function stringField(item: Record<string, unknown>, key: string) {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(item: Record<string, unknown>, key: string) {
  const value = item[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ToolResultPreview({ result }: { result: unknown }) {
  const renderedDocument = parseRenderedDocumentResult(result);
  if (renderedDocument) {
    return (
      <SkillTestRenderedDocumentLinks
        documents={[{ ...renderedDocument, callTimestamp: null }]}
        tone="emerald"
      />
    );
  }
  const imageOutputs = imageOutputItems(result);
  if (imageOutputs.length > 0) {
    return (
      <div className="space-y-2 rounded border border-emerald-100 bg-emerald-50/40 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900">
            Imágenes generadas
          </div>
          <span className="text-[11px] text-emerald-800">
            {imageOutputs.length} archivo{imageOutputs.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {imageOutputs.slice(0, 6).map((item, index) => {
            const url = stringField(item, "signed_url");
            const outputPath = stringField(item, "output_path");
            const bytes = numberField(item, "bytes");
            if (!url) return null;
            return (
              <div
                key={`${outputPath ?? url}-${index}`}
                className="space-y-2 rounded border border-emerald-100 bg-white p-2"
              >
                <a href={url} target="_blank" rel="noreferrer">
                  <Image
                    src={url}
                    alt={outputPath ?? `Imagen generada ${index + 1}`}
                    width={480}
                    height={320}
                    unoptimized
                    className="max-h-56 w-full rounded border border-neutral-100 object-contain"
                  />
                </a>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-violet-800 underline-offset-2 hover:underline"
                  >
                    Abrir imagen
                  </a>
                  {bytes != null ? (
                    <span className="text-neutral-500">{formatFileSize(bytes)}</span>
                  ) : null}
                </div>
                {outputPath ? (
                  <div className="break-all font-mono text-[10px] text-neutral-500">
                    {outputPath}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-emerald-800">
          Los enlaces firmados expiran; vuelve a ejecutar la prueba si necesitas
          regenerarlos.
        </p>
      </div>
    );
  }
  const items = resultItems(result);
  if (items.length === 0) return null;
  const shown = items.slice(0, 3);
  return (
    <div className="space-y-2 rounded border border-emerald-100 bg-emerald-50/40 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900">
          Propiedades encontradas
        </div>
        <span className="text-[11px] text-emerald-800">
          mostrando {shown.length} de {items.length}
        </span>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {shown.map((item, index) => {
          const title = stringField(item, "title") ?? `Resultado ${index + 1}`;
          const url = stringField(item, "url");
          const price =
            stringField(item, "formatted_price") ??
            (numberField(item, "price") != null
              ? `$${numberField(item, "price")?.toLocaleString("es-MX")}`
              : null);
          const location = stringField(item, "location");
          const propertyType = stringField(item, "property_type");
          const area = numberField(item, "area_m2");
          const bedrooms = numberField(item, "bedrooms");
          const bathrooms = numberField(item, "bathrooms");
          const parking = numberField(item, "parking_spaces");
          return (
            <div
              key={`${url ?? title}-${index}`}
              className="space-y-1 rounded border border-emerald-100 bg-white p-2"
            >
              <div className="font-semibold text-neutral-900">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-violet-800 underline-offset-2 hover:underline"
                  >
                    {title}
                  </a>
                ) : (
                  title
                )}
              </div>
              <div className="flex flex-wrap gap-2 text-neutral-600">
                {price ? <span>{price}</span> : null}
                {propertyType ? <span>{propertyType}</span> : null}
                {area != null ? <span>{area} m²</span> : null}
                {bedrooms != null ? <span>{bedrooms} rec.</span> : null}
                {bathrooms != null ? <span>{bathrooms} baños</span> : null}
                {parking != null ? <span>{parking} est.</span> : null}
              </div>
              {location ? <div className="text-neutral-500">{location}</div> : null}
            </div>
          );
        })}
      </div>
      {items.length > shown.length ? (
        <p className="text-[11px] text-emerald-800">
          El JSON completo conserva los {items.length} resultados.
        </p>
      ) : null}
    </div>
  );
}

function ToolTestPanel({
  item,
  row,
  panelActive,
  readinessFlowScrollEl,
  hasTestCase,
  caseId,
  caseContextVersion,
  readinessSkillSlug,
  readinessFlowStepKey,
  onFinished,
  onTestCaseUpdated,
  easyBrokerCreatedListingId,
  onEasyBrokerListingCreated,
}: {
  item: ToolReadinessToolItem;
  row: OperationalCaseType;
  panelActive: boolean;
  readinessFlowScrollEl?: HTMLDivElement | null;
  hasTestCase: boolean;
  caseId?: string | null;
  caseContextVersion?: string | null;
  readinessSkillSlug?: string;
  readinessFlowStepKey?: string;
  onFinished: () => Promise<void>;
  onTestCaseUpdated?: (result: OperationalCaseTestResult) => Promise<void>;
  easyBrokerCreatedListingId?: string | null;
  onEasyBrokerListingCreated?: (listingId: string) => void;
}) {
  const [mode, setMode] = useState<ToolTestMode>(hasTestCase ? "case" : "smoke");
  const [argsText, setArgsText] = useState("{}");
  const [confirm, setConfirm] = useState(false);
  const [controlledWriteText, setControlledWriteText] = useState("");
  const [showArgs, setShowArgs] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ToolTestResponse | null>(null);
  const [response, setResponse] = useState<ToolTestResponse | null>(null);
  const [validationResponse, setValidationResponse] =
    useState<ToolTestResponse | null>(null);
  const [controlledSendResponse, setControlledSendResponse] =
    useState<ToolTestResponse | null>(null);
  const [simulationResetVersion, setSimulationResetVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [aCaseSnapshot, setACaseSnapshot] = useState<OperationalCase | null>(null);
  const [messageValidated, setMessageValidated] = useState(false);
  const scrollLockRef = useRef<PageScrollPosition | null>(null);

  useLayoutEffect(() => {
    if (!scrollLockRef.current) return;
    const position = scrollLockRef.current;
    scrollLockRef.current = null;
    restorePageScroll(position, readinessFlowScrollEl);
  });

  const requiresConfirm = item.risk === "medium" && !confirm;

  function lockPageScrollForPanelLayout() {
    scrollLockRef.current = capturePageScroll(readinessFlowScrollEl);
  }

  function parseUserArgs(): {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: string;
  } {
    const trimmed = argsText.trim();
    if (!trimmed || trimmed === "{}") return { ok: true };
    try {
      const value = JSON.parse(trimmed);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "Los args deben ser un objeto JSON." };
      }
      return { ok: true, value: value as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function withScenarioArgs(args: Record<string, unknown> | undefined) {
    if (
      item.tool_id === "easybroker_upload_images" &&
      easyBrokerCreatedListingId &&
      !validEasyBrokerListingId(args?.listing_id)
    ) {
      return {
        ...(args ?? {}),
        listing_id: easyBrokerCreatedListingId,
      };
    }
    return args;
  }

  async function fetchPreview(targetMode: ToolTestMode) {
    lockPageScrollForPanelLayout();
    setPreviewing(true);
    setError(null);
    const parsed = parseUserArgs();
    if (!parsed.ok) {
      setError(parsed.error ?? "Args inválidos.");
      setPreviewing(false);
      return;
    }
    try {
      const res = await fetch("/api/tool-readiness/run-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_type_id: row.id,
          case_id: caseId ?? undefined,
          tool_id: item.tool_id,
          mode: targetMode,
          args: withScenarioArgs(parsed.value),
          preview: true,
          readiness_skill_slug: readinessSkillSlug,
          readiness_flow_step_key: readinessFlowStepKey,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ToolTestResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "No se pudo calcular la vista previa.");
      }
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  useEffect(() => {
    if (!panelActive) return;
    let cancelled = false;
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        if (!cancelled) void fetchPreview(mode);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelActive, mode, caseContextVersion]);

  function selectMode(next: ToolTestMode) {
    if (next === "case" && !hasTestCase) return;
    setMode(next);
    setResponse(null);
    setValidationResponse(null);
    setControlledSendResponse(null);
    setACaseSnapshot(null);
    setSimulationResetVersion((version) => version + 1);
    setMessageValidated(false);
  }

  async function run(options?: { controlledRealWrite?: boolean }) {
    lockPageScrollForPanelLayout();
    setRunning(true);
    setError(null);
    setResponse(null);
    if (showTelegramGuidedScenario) {
      if (options?.controlledRealWrite) {
        setControlledSendResponse(null);
      } else {
        setValidationResponse(null);
        setControlledSendResponse(null);
        setACaseSnapshot(null);
      }
      setSimulationResetVersion((version) => version + 1);
    }
    const parsed = parseUserArgs();
    if (!parsed.ok) {
      setError(parsed.error ?? "Args inválidos.");
      setRunning(false);
      return;
    }
    try {
      const res = await fetch("/api/tool-readiness/run-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_type_id: row.id,
          case_id: caseId ?? undefined,
          tool_id: item.tool_id,
          mode,
          args: withScenarioArgs(parsed.value),
          confirm,
          controlled_real_write: options?.controlledRealWrite === true,
          confirmation_text:
            options?.controlledRealWrite === true ? controlledWriteText : undefined,
          readiness_skill_slug: readinessSkillSlug,
          readiness_flow_step_key: readinessFlowStepKey,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ToolTestResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "No se pudo ejecutar la prueba.");
      }
      setResponse(data);
      if (data.resolved_args && Object.keys(data.resolved_args).length > 0) {
        setPreview({
          ok: true,
          executed: false,
          tool_id: item.tool_id,
          risk: data.risk ?? "medium",
          dry_run: true,
          reason: "preview_only",
          requested_mode: mode,
          mode_used: data.mode_used ?? mode,
          mode_source: data.mode_source,
          case_id: data.case_id ?? caseId ?? null,
          resolved_args: data.resolved_args,
        });
      }
      if (
        item.tool_id === "easybroker_create_listing" &&
        data.executed === true &&
        data.ok === true
      ) {
        const listingId = easyBrokerListingIdFromResult(data.result);
        if (listingId) onEasyBrokerListingCreated?.(listingId);
      }
      if (showTelegramGuidedScenario && !options?.controlledRealWrite) {
        setValidationResponse(data);
        setMessageValidated(data.ok === true);
      } else if (
        showTelegramGuidedScenario &&
        options?.controlledRealWrite
      ) {
        setControlledSendResponse(data);
      }
      if (data.executed === true && data.ok === true) {
        await onFinished();
        if (
          options?.controlledRealWrite === true &&
          showTelegramGuidedScenario &&
          caseId
        ) {
          try {
            const caseRes = await fetch(
              `/api/operational-case-tests?case_id=${encodeURIComponent(caseId)}`
            );
            const caseData = (await caseRes.json()) as {
              case?: OperationalCase | null;
            };
            setACaseSnapshot(caseData.case ?? null);
          } catch {
            setACaseSnapshot(null);
          }
        }
      }
      setShowRaw(data.executed === true || Boolean(data.result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const usedFallbackSmoke =
    response?.requested_mode === "case" && response?.mode_used === "smoke";
  const wizardIssues = response ? summarizeUnggaWizardIssues(response.result) : [];
  const executedResultItems = response?.executed ? resultItems(response.result) : [];
  const controlledWriteCopy = CONTROLLED_WRITE_COPY[item.tool_id] ?? null;
  const policyOnlyValidation =
    response?.executed === false &&
    response.reason === "high_risk_requires_hitl" &&
    item.tool_id === "telegram_send_message_to_contact";
  const isTelegramContactTool = item.tool_id === "telegram_send_message_to_contact";
  const isCharacteristicsTelegramScenario =
    isTelegramContactTool &&
    readinessSkillSlug === "extract-property-characteristics";
  const isDocumentRequestTelegramScenario =
    isTelegramContactTool && readinessSkillSlug === "request-property-documents";
  const isGenericTelegramGuidedScenario =
    isTelegramContactTool &&
    !isCharacteristicsTelegramScenario &&
    !isDocumentRequestTelegramScenario;
  const documentToolHint = documentToolReadinessHint(
    item.tool_id,
    readinessFlowStepKey
  );
  const showTelegramGuidedScenario =
    isTelegramContactTool &&
    hasTestCase &&
    Boolean(caseId);
  const isEasyBrokerPackageStep = readinessSkillSlug === "publish-listing-package";
  const isEasyBrokerCreateScenario =
    item.tool_id === "easybroker_create_listing" && isEasyBrokerPackageStep;
  const isEasyBrokerUploadScenario =
    item.tool_id === "easybroker_upload_images" && isEasyBrokerPackageStep;
  const easyBrokerUploadListingId =
    easyBrokerCreatedListingId ??
    (validEasyBrokerListingId(preview?.resolved_args?.listing_id)
      ? String(preview?.resolved_args?.listing_id).trim()
      : validEasyBrokerListingId(response?.resolved_args?.listing_id)
        ? String(response?.resolved_args?.listing_id).trim()
        : null);
  const showOwnerCharacteristicsSimulation =
    isCharacteristicsTelegramScenario && hasTestCase && Boolean(caseId);
  const isValidationResponse = Boolean(
    showTelegramGuidedScenario && validationResponse
  );
  const canControlledRealWrite =
    Boolean(controlledWriteCopy) &&
    controlledWriteText.trim() === controlledWriteCopy?.confirmation &&
    (!showTelegramGuidedScenario || messageValidated) &&
    (!isEasyBrokerUploadScenario || Boolean(easyBrokerUploadListingId));
  const controlledSendSucceeded =
    controlledSendResponse?.executed === true &&
    controlledSendResponse.ok === true &&
    controlledSendResponse.reason === "high_risk_controlled_real_write";
  const controlledWriteTitle = isCharacteristicsTelegramScenario
    ? "B · Enviar mensaje de prueba por Telegram"
    : isDocumentRequestTelegramScenario
      ? "B · Enviar solicitud de documentos de prueba"
      : isGenericTelegramGuidedScenario
        ? "B · Enviar mensaje de prueba por Telegram"
      : isEasyBrokerCreateScenario
        ? "A · Crear borrador de prueba en EasyBroker"
      : isEasyBrokerUploadScenario
        ? "B · Subir fotos al borrador de EasyBroker"
      : controlledWriteCopy?.title;
  const controlledWriteDescription = isCharacteristicsTelegramScenario
    ? "Envía el mensaje validado al chat_id externo mostrado en los args. El sistema agrega el prefijo [PRUEBA CONTROLADA]. Úsalo sólo con un contacto/chat de prueba."
    : isDocumentRequestTelegramScenario
      ? "Envía un mensaje real al chat_id externo mostrado en los args. El sistema agrega el prefijo [PRUEBA CONTROLADA]. Úsalo sólo con un contacto/chat de prueba. En este paso el texto solicita documentos del expediente."
      : isGenericTelegramGuidedScenario
        ? "Envía el mensaje validado al chat_id externo mostrado en los args. El sistema agrega el prefijo [PRUEBA CONTROLADA]. Úsalo sólo con un contacto/chat de prueba."
      : isEasyBrokerCreateScenario
        ? "Crea un borrador real controlado como not_published con prefijo [PRUEBA - BORRAR]. Si funciona, usa el listing_id para B."
      : isEasyBrokerUploadScenario
        ? "Sube fotos de prueba al borrador resuelto. B queda disponible cuando hay un listing_id de EasyBroker, normalmente creado en A."
      : controlledWriteCopy?.description;

  const controlledWriteSection = controlledWriteCopy ? (
    <div className="space-y-2 rounded border-2 border-violet-400 bg-violet-50/90 p-3 text-xs text-violet-950 shadow-sm dark:border-violet-700 dark:bg-violet-950/40">
      <div className="font-semibold text-violet-950 dark:text-violet-100">
        {controlledWriteTitle}
      </div>
      {controlledWriteDescription ? <p>{controlledWriteDescription}</p> : null}
      {item.tool_id === "easybroker_upload_images" ? (
        <p>
          Si la vista previa muestra{" "}
          <span className="font-mono">REEMPLAZA-CON-LISTING-ID</span>, abre
          avanzado y usa un override como{" "}
          <span className="font-mono">{'{"listing_id":"EB-XXXX"}'}</span>.
        </p>
      ) : null}
      <label className="block space-y-1">
        <span>
          Escribe{" "}
          <span className="font-mono font-semibold">
            {controlledWriteCopy.confirmation}
          </span>{" "}
          para habilitar:
        </span>
        <input
          value={controlledWriteText}
          onChange={(event) => setControlledWriteText(event.target.value)}
          className="w-full rounded border border-violet-300 bg-white px-2 py-1 font-mono text-[11px] dark:border-violet-800 dark:bg-neutral-900"
          placeholder={controlledWriteCopy.confirmation}
        />
      </label>
      <button
        type="button"
        onClick={() => void run({ controlledRealWrite: true })}
        disabled={running || !canControlledRealWrite}
        className={WIZARD_PRIMARY_BUTTON_CLASS}
      >
        {running ? "Ejecutando..." : controlledWriteCopy.button}
      </button>
      {showTelegramGuidedScenario && !messageValidated ? (
        <p className="text-[11px] text-violet-900 dark:text-violet-200">
          Primero completa A · Validar mensaje para habilitar el envío real.
        </p>
      ) : null}
      {isEasyBrokerUploadScenario ? (
        easyBrokerUploadListingId ? (
          <p className="text-[11px] text-violet-900 dark:text-violet-200">
            B usará el borrador{" "}
            <span className="font-mono">{easyBrokerUploadListingId}</span>.
          </p>
        ) : (
          <p className="text-[11px] text-violet-900 dark:text-violet-200">
            Primero completa A · Crear borrador o indica un{" "}
            <span className="font-mono">listing_id</span> real en args avanzados.
          </p>
        )
      ) : null}
      {showTelegramGuidedScenario && controlledSendResponse ? (
        <TelegramStepAOutcomePanel
          response={controlledSendResponse}
          caseSnapshot={aCaseSnapshot}
          nextActionLabel={
            showOwnerCharacteristicsSimulation
              ? "Siguiente: C · Simular respuesta y procesar"
              : undefined
          }
        />
      ) : null}
    </div>
  ) : null;

  const simulateSection =
    showOwnerCharacteristicsSimulation && caseId ? (
      <SimulateOwnerResponsePanel
        caseId={caseId}
        variant="inline"
        resetVersion={simulationResetVersion}
        disabled={!controlledSendSucceeded}
        disabledReason="Primero completa B · Enviar mensaje de prueba por Telegram para simular la respuesta."
        onProcessed={async (processedResult) => {
          if (onTestCaseUpdated) {
            await onTestCaseUpdated(processedResult);
          }
        }}
      />
    ) : null;

  const technicalValidationSection = (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {(["smoke", "case"] as ToolTestMode[]).map((option) => {
          const disabled = option === "case" && !hasTestCase;
          const active = mode === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => selectMode(option)}
              disabled={disabled}
              title={
                disabled
                  ? "Crea primero un caso de prueba en la sección de abajo."
                  : undefined
              }
              className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                active
                  ? "bg-violet-700 text-white"
                  : disabled
                    ? "border border-neutral-200 bg-neutral-100 text-neutral-400"
                    : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              {MODE_LABELS[option]}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-neutral-500">{MODE_DESCRIPTIONS[mode]}</p>
      {item.tool_id === "operational_case_create" ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
          Esta prueba crea un caso real adicional en{" "}
          <span className="font-mono">operational_cases</span> (contexto{" "}
          <span className="font-mono">created_from=tool_readiness_test</span>). No
          reemplaza el caso de prueba del laboratorio
          {caseId ? (
            <>
              {" "}
              (<span className="font-mono break-all">{caseId}</span>)
            </>
          ) : null}
          . Repetir la prueba genera más filas de prueba; el caso de prueba sigue
          siendo el que alimenta el resto del flow. Los args se muestran con
          claves ordenadas (alfabético dentro de context) para comparar Smoke vs
          Caso de prueba a simple vista.
        </p>
      ) : null}
      <p className="text-[10px] text-neutral-500">
        Vista previa: claves ordenadas para comparar modos (mismos valores, orden
        estable). Lo enviado a la tool es exactamente el JSON mostrado.
      </p>
      {mode === "case" && !hasTestCase ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          Aún no hay caso de prueba. Créalo desde la tarjeta &quot;Preparar caso
          de prueba&quot; para habilitar este modo.
        </p>
      ) : null}
      {preview && !error ? (
        <div className="rounded border border-violet-200 bg-violet-50 p-2 text-[11px] text-violet-900">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Args a usar:</span>
            <span className="text-violet-700">
              fuente: {MODE_SOURCE_LABELS[preview.mode_source ?? ""] ?? preview.mode_source ?? "—"}
            </span>
            {preview.case_id ? (
              <span
                className="break-all font-mono text-[10px] text-violet-700"
                title="Caso de prueba de Preparación operativa (fuente de args en modo Caso de prueba)"
              >
                caso: {preview.case_id}
              </span>
            ) : null}
            {previewing ? (
              <span className="text-violet-700">recalculando…</span>
            ) : null}
          </div>
          <pre className="mt-1 overflow-x-auto rounded bg-white/70 p-1 font-mono text-[11px]">
            {stringifyToolArgsForDisplay(preview.resolved_args)}
          </pre>
          {preview.requested_mode === "case" && preview.mode_used === "smoke" ? (
            <p className="mt-1 text-violet-700">
              No se encontró caso de prueba; se aplicó smoke como fallback.
            </p>
          ) : null}
        </div>
      ) : null}
      {item.tool_id === "telegram_send_message_to_contact" && item.risk === "high" ? (
        <p className="rounded border border-violet-200 bg-violet-50 p-2 text-[11px] text-violet-900">
          {readinessSkillSlug === "extract-property-characteristics"
            ? "Esta validación arma preguntas de características faltantes (purpose=characteristics_pending), no envía Telegram ni vuelve a pedir el checklist de documentos."
            : readinessSkillSlug === "request-property-documents"
              ? "Esta vista previa pide el checklist documental inicial (purpose=request_documents). La simulación de características se prueba en el siguiente paso."
              : "Esta validación sólo revisa args. Para enviar, usa la prueba controlada con un chat de prueba."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || requiresConfirm}
          className={WIZARD_PRIMARY_BUTTON_CLASS}
        >
          {running
            ? "Validando..."
            : showTelegramGuidedScenario
              ? `Validar mensaje (${MODE_LABELS[mode]})`
              : `Probar tool (${MODE_LABELS[mode]})`}
        </button>
        <button
          type="button"
          onClick={() => setShowArgs((prev) => !prev)}
          className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700"
        >
          {showArgs ? "Ocultar avanzado" : "Avanzado: modificar args JSON"}
        </button>
        {item.risk === "medium" ? (
          <label className="flex items-center gap-1 text-[11px] text-neutral-600">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
            />
            Confirmar ejecución (riesgo medio)
          </label>
        ) : item.risk === "high" ? (
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            {controlledWriteCopy
              ? "Riesgo alto: requiere confirmación explícita"
              : "Riesgo alto: sólo dry-run desde esta capa"}
          </span>
        ) : null}
      </div>
      {showArgs ? (
        <div className="space-y-1">
          <p className="text-[11px] text-neutral-500">
            Override JSON avanzado. Se mezcla encima de los args del modo elegido:
          </p>
          <textarea
            value={argsText}
            onChange={(event) => {
              setArgsText(event.target.value);
              setMessageValidated(false);
              setValidationResponse(null);
              setControlledSendResponse(null);
              setACaseSnapshot(null);
              setSimulationResetVersion((version) => version + 1);
            }}
            onBlur={() => void fetchPreview(mode)}
            rows={4}
            className="w-full rounded border border-neutral-300 bg-white p-2 font-mono text-[11px]"
            placeholder='{"zona": "Roma Norte", "limit": 5}'
          />
        </div>
      ) : null}
      {isValidationResponse ? (
        <TelegramStepValidationOutcomePanel
          response={validationResponse as ToolTestResponse}
          nextActionLabel={
            isDocumentRequestTelegramScenario
              ? "Siguiente: B · Enviar solicitud de documentos de prueba"
              : "Siguiente: B · Enviar mensaje de prueba por Telegram"
          }
        />
      ) : null}
    </>
  );

  const responseOutcomeVariant: OutcomeVariant = !response
    ? "info"
    : policyOnlyValidation
      ? "success"
      : response.reason === "placeholder_event_id"
        ? "warning"
      : response.executed === false
        ? "warning"
      : !response.ok
        ? "error"
      : wizardIssues.length > 0
        ? "warning"
      : "success";
  const responseOutcomeTitle = !response
    ? "Resultado de la prueba"
    : policyOnlyValidation
      ? "Args OK (esperado)"
      : response.reason === "placeholder_event_id"
        ? "Falta event_id real"
      : response.executed === false
        ? "Sin ejecutar (política)"
      : response.dry_run && response.executed
        ? response.ok
          ? wizardIssues.length > 0
            ? "Dry-run OK (con avisos)"
            : "Dry-run OK"
          : "Dry-run falló"
      : response.ok
        ? "Éxito"
      : "Error";

  const responseSection = response ? (
        <OutcomePanel
          variant={responseOutcomeVariant}
          title={responseOutcomeTitle}
          className="space-y-1"
          id={`tool-test-result-${item.tool_id}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {response.reason ? (
              <span className="text-neutral-500">motivo: {response.reason}</span>
            ) : null}
            {response.mode_used ? (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-800">
                modo: {MODE_LABELS[response.mode_used]}
              </span>
            ) : null}
            {response.summary?.status ? (
              <span className="text-neutral-500">
                status: {response.summary.status}
              </span>
            ) : null}
            {response.summary?.count != null ? (
              <span className="text-neutral-500">
                count: {response.summary.count}
              </span>
            ) : null}
            {response.elapsed_ms != null ? (
              <span className="text-neutral-500">
                {response.elapsed_ms} ms
              </span>
            ) : null}
          </div>
          {usedFallbackSmoke ? (
            <p className="text-amber-800">
              No se encontró caso de prueba; se ejecutó en modo smoke.
            </p>
          ) : null}
          {response.hint ? (
            <p className="rounded border border-amber-100 bg-amber-50/80 p-2 text-amber-900">
              {response.hint}
            </p>
          ) : null}
          {wizardIssues.length > 0 ? (
            <ul className="list-inside list-disc rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-950">
              <li className="list-none font-semibold">
                Avisos del wizard (revisa antes de un borrador real):
              </li>
              {wizardIssues.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {response.error ? (
            <p className="text-red-800">Error: {response.error}</p>
          ) : null}
          {response.executed === false ? (
            <p className="text-neutral-600">
              {policyOnlyValidation
                ? showOwnerCharacteristicsSimulation
                  ? "Comportamiento esperado: solo valida args y texto. Sigue con B (enviar mensaje) y C (simular respuesta) en este panel."
                  : "Comportamiento esperado: solo valida args. Usa la prueba controlada para enviar el mensaje de documentos."
                : response.reason === "placeholder_event_id"
                  ? response.hint ??
                    "Falta un event_id real en los args antes de llamar a Google Calendar."
                  : `La prueba no invocó la tool (${response.reason ?? "política de riesgo"}). ${response.hint ?? "Usa el flow completo con HITL para escritura real."}`}
            </p>
          ) : null}
          <details className="rounded border border-neutral-100 bg-neutral-50/50">
            <summary className="cursor-pointer px-2 py-1 font-semibold text-neutral-700">
              Args enviados a la tool
            </summary>
            <pre className="mx-2 mb-2 overflow-x-auto rounded border border-neutral-200 bg-white p-2 font-mono text-[11px]">
              {stringifyToolArgsForDisplay(response.resolved_args)}
            </pre>
          </details>
          {response.summary?.preview &&
          response.summary.preview.length > 0 &&
          executedResultItems.length === 0 ? (
            <details className="rounded border border-neutral-100">
              <summary className="cursor-pointer px-2 py-1 font-semibold text-neutral-700">
                Vista previa (primeros ítems)
              </summary>
              <pre className="mx-2 mb-2 overflow-x-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
                {JSON.stringify(response.summary.preview, null, 2)}
              </pre>
            </details>
          ) : null}
          {response.executed === false && response.resolved_args ? (
            <p className="text-neutral-500">
              Sin payload de ejecución; solo se validaron los args de arriba.
            </p>
          ) : null}
          {response.executed && response.result != null ? (
            <div className="space-y-2 rounded border border-violet-200 bg-violet-50/40 p-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-900">
                Resultado de la prueba
              </div>
              <p className="text-[11px] text-violet-800">
                Respuesta de la tool tras ejecutar (dry-run o real). Distinto de los
                args enviados.
              </p>
              <ToolResultPreview result={response.result} />
              <details className="rounded border border-violet-100 bg-white">
                <summary className="cursor-pointer px-2 py-1 font-semibold text-violet-900">
                  Ver JSON completo
                </summary>
                <pre className="mx-2 mb-2 max-h-96 overflow-auto rounded border border-violet-100 bg-white p-2 font-mono text-[11px]">
                  {JSON.stringify(response.result, null, 2)}
                </pre>
              </details>
            </div>
          ) : response.result != null ? (
            <>
              <button
                type="button"
                onClick={() => setShowRaw((prev) => !prev)}
                className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700"
              >
                {showRaw ? "Ocultar resultado" : "Ver resultado de la prueba"}
              </button>
              {showRaw ? (
                <div className="space-y-1 rounded border border-violet-200 bg-violet-50/40 p-2">
                  <div className="text-[11px] font-semibold text-violet-900">
                    Resultado de la prueba
                  </div>
                  <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px]">
                    {JSON.stringify(response.result, null, 2)}
                  </pre>
                </div>
              ) : null}
            </>
          ) : null}
          {response.raw_text ? (
            <pre className="overflow-x-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
              {response.raw_text}
            </pre>
          ) : null}
        </OutcomePanel>
  ) : null;

  return (
    <div className="space-y-2 rounded border border-white/70 bg-white/85 p-3 [overflow-anchor:none]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          {showOwnerCharacteristicsSimulation
            ? "Prueba de mensaje a contacto externo"
            : isDocumentRequestTelegramScenario
              ? "Prueba solicitud de documentos"
            : isGenericTelegramGuidedScenario
              ? "Prueba de mensaje a contacto externo"
            : "Prueba individual de tool"}
        </div>
        <span className="text-[11px] text-neutral-500">Riesgo: {riskLabel(item.risk)}</span>
      </div>
      {showOwnerCharacteristicsSimulation ? (
        <>
          <p className="text-[11px] text-neutral-600">
            Para este paso, el contacto externo es el dueño de la propiedad.
            Valida el mensaje, envíalo al chat de prueba y simula la respuesta
            para comprobar que el caso actualiza{" "}
            <span className="font-mono">property_data</span>.
          </p>
          <div className="rounded border-2 border-violet-400 bg-violet-50/90 p-3 text-xs shadow-sm dark:border-violet-700 dark:bg-violet-950/40">
            <div className="font-semibold text-violet-950">
              A · Validar mensaje
            </div>
            <p className="mt-1 text-[11px] text-violet-900">
              Revisa args, texto, chat_id, case_id y purpose sin enviar nada.
            </p>
            <div className="mt-2 space-y-2">{technicalValidationSection}</div>
          </div>
          {controlledWriteSection}
          {simulateSection}
        </>
      ) : isDocumentRequestTelegramScenario ? (
        <>
          <p className="text-[11px] text-neutral-600">
            En este paso se prueba el mensaje inicial de solicitud de documentos:
            primero valida el texto y luego envía una prueba controlada por
            Telegram al chat externo.
          </p>
          <div className="rounded border-2 border-violet-400 bg-violet-50/90 p-3 text-xs shadow-sm dark:border-violet-700 dark:bg-violet-950/40">
            <div className="font-semibold text-violet-950 dark:text-violet-100">
              A · Validar solicitud de documentos
            </div>
            <p className="mt-1 text-[11px] text-violet-900 dark:text-violet-200">
              Revisa args, texto, chat_id, case_id y purpose sin enviar nada.
            </p>
            <div className="mt-2 space-y-2">{technicalValidationSection}</div>
          </div>
          {controlledWriteSection}
        </>
      ) : isGenericTelegramGuidedScenario ? (
        <>
          <p className="text-[11px] text-neutral-600">
            En este paso se prueba un mensaje a contacto externo: primero valida
            el texto y luego envía una prueba controlada por Telegram al chat de
            prueba.
          </p>
          <div className="rounded border-2 border-violet-400 bg-violet-50/90 p-3 text-xs shadow-sm dark:border-violet-700 dark:bg-violet-950/40">
            <div className="font-semibold text-violet-950 dark:text-violet-100">
              A · Validar mensaje
            </div>
            <p className="mt-1 text-[11px] text-violet-900 dark:text-violet-200">
              Revisa args, texto, chat_id, case_id y purpose sin enviar nada.
            </p>
            <div className="mt-2 space-y-2">{technicalValidationSection}</div>
          </div>
          {controlledWriteSection}
        </>
      ) : (
        <>
          <p className="text-[11px] text-neutral-600">
            Valida la tool en aislamiento. Elige cómo construir los args y revisa
            el resultado antes de correr el flow completo.
          </p>
          {documentToolHint ? (
            <p className="text-[11px] text-neutral-500">{documentToolHint}</p>
          ) : null}
          {technicalValidationSection}
          {controlledWriteSection}
        </>
      )}
      {running && item.tool_id === "ungga_publish_listing" ? (
        <p className="rounded border border-violet-200 bg-violet-50 p-2 text-[11px] text-violet-900">
          Ejecutando dry-run en Ungga con Playwright (login + wizard). Suele tardar
          1–2 minutos; no cierres este panel.
        </p>
      ) : null}
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-800">
          {error}
        </p>
      ) : null}
      {!showTelegramGuidedScenario && responseSection ? responseSection : null}
    </div>
  );
}

function intakeOptionValue(option: string | OperationalCaseIntakeOption) {
  return typeof option === "string" ? option : option.value;
}

function intakeOptionLabel(option: string | OperationalCaseIntakeOption) {
  return typeof option === "string" ? option : (option.label ?? option.value);
}

function draftValue(value: unknown): string | string[] {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : String(item ?? "")))
      .filter(Boolean);
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function draftString(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function draftArray(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function TestCaseContextForm({
  fields,
  draft,
  saving,
  message,
  onChange,
  onSave,
}: {
  fields: OperationalCaseIntakeField[];
  draft: TestContextDraft;
  saving: boolean;
  message: string | null;
  onChange: (name: string, value: string | string[]) => void;
  onSave: () => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="rounded border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-neutral-700 dark:text-neutral-200">
            Datos del caso de prueba
          </div>
          <p className="mt-1 text-neutral-500">
            Estos valores alimentan el modo &quot;Datos del caso&quot; de las tools.
            Editarlos aquí evita tener que escribir JSON.
          </p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800 disabled:bg-neutral-400"
        >
          {saving ? "Guardando..." : "Guardar datos"}
        </button>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {fields.map((field) => {
          const value = draft[field.name] ?? "";
          const commonClass =
            "mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950";
          const headerNode = (
            <div className="flex flex-wrap items-baseline gap-1">
              <span className="font-semibold">
                {field.label}
                {field.required ? " *" : ""}
              </span>
              <span className="font-mono text-[10px] text-neutral-400">
                {field.name}
              </span>
            </div>
          );
          // Nota: NO usamos <label> exterior porque algunos tipos (multi_select)
          // renderizan <label> por cada checkbox y la anidación de <label> es
          // HTML inválido y provoca toggles dobles al hacer click en una opción.
          if (field.type === "multi_select") {
            return (
              <div key={field.name}>
                {headerNode}
                <div className="mt-1 flex flex-wrap gap-2 rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-950">
                  {(field.options ?? []).map((option) => {
                    const optionValue = intakeOptionValue(option);
                    const selected = draftArray(value).includes(optionValue);
                    return (
                      <label
                        key={optionValue}
                        className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-[11px] dark:bg-neutral-900"
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => {
                            const current = draftArray(value);
                            onChange(
                              field.name,
                              event.target.checked
                                ? Array.from(new Set([...current, optionValue]))
                                : current.filter((item) => item !== optionValue)
                            );
                          }}
                        />
                        {intakeOptionLabel(option)}
                      </label>
                    );
                  })}
                </div>
                {field.help_text ? (
                  <p className="mt-1 text-[11px] text-neutral-500">
                    {field.help_text}
                  </p>
                ) : null}
              </div>
            );
          }
          const helpNode = field.help_text ? (
            <p className="mt-1 text-[11px] text-neutral-500">
              {field.help_text}
            </p>
          ) : null;
          return (
            <label key={field.name} className="block">
              {headerNode}
              {field.type === "textarea" ? (
                <textarea
                  value={draftString(value)}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  rows={3}
                  placeholder={field.placeholder}
                  className={commonClass}
                />
              ) : field.type === "select" ? (
                <select
                  value={draftString(value)}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  className={commonClass}
                >
                  <option value="">Selecciona...</option>
                  {(field.options ?? []).map((option) => (
                    <option key={intakeOptionValue(option)} value={intakeOptionValue(option)}>
                      {intakeOptionLabel(option)}
                    </option>
                  ))}
                </select>
              ) : field.type === "number" ? (
                <div className="relative">
                  <input
                    type="number"
                    value={draftString(value)}
                    onChange={(event) => onChange(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    min={field.min ?? 0}
                    max={field.max}
                    step={field.step ?? 1}
                    onWheel={(event) => event.currentTarget.blur()}
                    className={`${commonClass} ${field.unit ? "pr-14" : ""}`}
                  />
                  {field.unit ? (
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500">
                      {field.unit}
                    </span>
                  ) : null}
                </div>
              ) : (
                <input
                  type="text"
                  value={draftString(value)}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  placeholder={field.placeholder}
                  className={commonClass}
                />
              )}
              {helpNode}
            </label>
          );
        })}
      </div>
      {message ? <p className="mt-2 text-[11px] text-neutral-600">{message}</p> : null}
    </div>
  );
}

function renderReadinessActions(params: {
  item: ToolReadinessToolItem;
  row: OperationalCaseType;
  expanded: boolean;
  existingRequest: ToolReadinessRequestRecord | undefined;
  submitting: boolean;
  onEditSkill: () => void;
  onToggleExpand: () => void;
  onRequestGlobal: () => void;
}) {
  const { item, expanded, existingRequest, submitting } = params;
  const toggleHandlers = readinessExpandToggleHandlers(params.onToggleExpand);
  const detailsToggle = (
    <button
      type="button"
      {...toggleHandlers}
      aria-expanded={expanded}
      className="rounded border border-current/40 bg-white/70 px-2 py-1 text-[11px] font-semibold hover:bg-white"
    >
      {expanded ? "Ocultar detalles" : "Detalles"}
    </button>
  );

  if (item.action_kind === "edit_skill") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={params.onEditSkill}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {item.action_label ?? "Editar skill"}
        </button>
        {detailsToggle}
      </div>
    );
  }

  // configure_account con provider per-cuenta → expandimos el form inline.
  // El botón principal hace el toggle del bloque expandido, donde el form
  // se renderiza junto al action_message.
  if (
    item.action_kind === "configure_account" &&
    item.account_provider
  ) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          {...toggleHandlers}
          aria-expanded={expanded}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {expanded
            ? "Cerrar"
            : (item.action_label ?? `Conectar ${item.account_provider}`)}
        </button>
        {!expanded && detailsToggle}
      </div>
    );
  }

  if (item.action_kind === "upload_asset") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          {...toggleHandlers}
          aria-expanded={expanded}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {expanded ? "Cerrar" : (item.action_label ?? "Subir recurso")}
        </button>
        {!expanded && detailsToggle}
      </div>
    );
  }

  if (
    (item.action_kind === "connect_integration" ||
      item.action_kind === "configure_account") &&
    readinessActionUrl(item)
  ) {
    const href = readinessActionUrl(item)!;
    const sameOrigin = href.startsWith("/");
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={href}
          target={sameOrigin ? undefined : "_blank"}
          rel={sameOrigin ? undefined : "noopener noreferrer"}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {item.action_label ?? "Conectar"}
        </a>
        {detailsToggle}
      </div>
    );
  }

  if (item.action_kind === "request_global" && item.request_kind) {
    const hasAssets = (item.asset_requirements?.length ?? 0) > 0;
    const manageAssetsButton = hasAssets ? (
      <AccountResourcesExpandToggle
        expanded={expanded}
        onToggle={params.onToggleExpand}
      />
    ) : null;
    if (existingRequest) {
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800">
            Solicitud {readinessRequestStatusLabel(existingRequest.status)}
            {existingRequest.status === "requested"
              ? " (registrada para Ungga)"
              : ""}
          </span>
          {manageAssetsButton}
          {detailsToggle}
        </div>
      );
    }
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={params.onRequestGlobal}
          disabled={submitting}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
        >
          {submitting ? "Enviando..." : readinessRequestActionLabel(item)}
        </button>
        {manageAssetsButton}
        {detailsToggle}
      </div>
    );
  }

  if ((item.asset_requirements?.length ?? 0) > 0) {
    if (item.status === "ready") {
      return (
        <div className="mt-2">
          <ToolTestExpandToggle
            expanded={expanded}
            onToggle={params.onToggleExpand}
            testStatus={item.test_status}
          />
        </div>
      );
    }
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AccountResourcesExpandToggle
          expanded={expanded}
          onToggle={params.onToggleExpand}
        />
        {!expanded ? detailsToggle : null}
      </div>
    );
  }

  // Tools listas: chevron abre el panel N1 (la ejecución va dentro de ToolTestPanel).
  if (item.status === "ready") {
    return (
      <div className="mt-2">
        <ToolTestExpandToggle
          expanded={expanded}
          onToggle={params.onToggleExpand}
          testStatus={item.test_status}
        />
      </div>
    );
  }

  return null;
}

function riskLabel(risk?: string) {
  if (risk === "low") return "bajo";
  if (risk === "medium") return "medio";
  if (risk === "high") return "alto";
  return risk ?? "n/d";
}


type SkillTestResponse = {
  ok: boolean;
  status: "tested_ok" | "tested_failed" | "partial";
  skill_slug: string;
  step_key: string;
  expected_context_keys: string[];
  expected_step_tools?: string[];
  validation?: {
    ok: boolean;
    expected_tool_calls?: string[];
    expected_internal_tool_calls?: string[];
    optional_tool_calls?: string[];
    missing_context_keys: string[];
    created_context_keys: string[];
    missing_events?: string[];
    missing_tool_calls?: string[];
    missing_internal_tool_calls?: string[];
    missing_any_tool_call?: string[];
    artifact_errors?: string[];
  };
  pending_confirmation?: boolean;
  deterministic_repair?: { applied: boolean; reason?: string };
  response_preview?: string | null;
  response_preview_truncated?: boolean;
  artifacts?: Record<string, unknown>;
  source_tool_calls?: Array<SkillTestToolCallDetail>;
  internal_tool_calls?: Array<SkillTestToolCallDetail>;
  other_tool_calls?: Array<SkillTestToolCallDetail>;
  tool_calls?: Array<SkillTestToolCallDetail>;
  error?: string;
  hint?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberFromRecord(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayCountFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.length : null;
}

function comparableContributionSummary(artifacts?: Record<string, unknown>) {
  const comparables = artifacts?.comparables_analysis;
  if (!isPlainRecord(comparables)) return null;
  const stats = isPlainRecord(comparables.stats) ? comparables.stats : {};
  const active =
    numberFromRecord(stats, "active_count") ??
    arrayCountFromRecord(comparables, "active_listings") ??
    0;
  const historical =
    numberFromRecord(stats, "historical_reference_count") ??
    arrayCountFromRecord(comparables, "historical_references") ??
    arrayCountFromRecord(comparables, "closed_deals") ??
    0;
  const internal =
    numberFromRecord(stats, "internal_inventory_count") ??
    arrayCountFromRecord(comparables, "internal_inventory") ??
    0;
  return `Datos aportados al analisis: activas ${active} · historicas ${historical} · internas ${internal}.`;
}

/** Contrato N3: el escenario no exige validar este bloque (no es "falta dato"). */
const SKILL_TEST_NOT_APPLICABLE = "no aplica";

function SkillTestPanel({
  skill,
  row,
  hasTestCase,
  caseId,
  onFinished,
}: {
  skill: ToolReadinessFlowSkill;
  row: OperationalCaseType;
  hasTestCase: boolean;
  caseId?: string | null;
  onFinished: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<SkillTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = skill.test_status === "blocked_by_tools";
  const sectionState = skillTestSectionState(skill);
  const aggregatedStatusLabel = skillTestStatusLabel(skill.test_status);
  const sectionSummaryHint = skillTestSectionSummary(skill);
  const [sectionOpen, setSectionOpen] = useState(() =>
    skillTestSectionDefaultOpen(skill)
  );
  const prevSkillTestStatusRef = useRef(skill.test_status);
  const wasBlockedRef = useRef(blocked);
  useEffect(() => {
    if (wasBlockedRef.current && !blocked) {
      setSectionOpen(true);
    }
    wasBlockedRef.current = blocked;
  }, [blocked]);
  useEffect(() => {
    if (sectionState === "expandedReady") {
      setSectionOpen(true);
    }
  }, [sectionState]);
  useEffect(() => {
    const prev = prevSkillTestStatusRef.current;
    prevSkillTestStatusRef.current = skill.test_status;
    if (skillTestSectionCollapseWhenAlreadyProven(prev, skill.test_status)) {
      setSectionOpen(false);
    }
  }, [skill.test_status]);
  const n1Progress = skillN1Progress(skill);
  const skillBlockedMessage =
    blocked &&
    (n1Progress.pendingIds.length > 0
      ? `${SKILL_TEST_BLOCKED_TITLE} Pendiente: ${n1Progress.pendingIds.join(", ")}.`
      : SKILL_TEST_BLOCKED_TITLE);
  const sourceToolCalls = response?.source_tool_calls ?? response?.tool_calls ?? [];
  const internalToolCalls = response?.internal_tool_calls ?? [];
  const otherToolCalls = response?.other_tool_calls ?? [];
  const executedSourceToolCount = sourceToolCalls.filter(
    (call) => call.status === "executed"
  ).length;
  const pendingSourceToolCount = sourceToolCalls.filter(
    (call) => call.status === "pending_confirmation"
  ).length;
  const artifactEntries = response?.artifacts ? Object.entries(response.artifacts) : [];
  const contributionSummary = comparableContributionSummary(response?.artifacts);
  const missingContextKeys = response?.validation?.missing_context_keys ?? [];
  const missingEvents = response?.validation?.missing_events ?? [];
  const missingToolCalls = response?.validation?.missing_tool_calls ?? [];
  const missingInternalToolCalls =
    response?.validation?.missing_internal_tool_calls ?? [];
  const missingAnyToolCall = response?.validation?.missing_any_tool_call ?? [];
  const artifactErrors = response?.validation?.artifact_errors ?? [];
  const expectedToolCalls = response?.validation?.expected_tool_calls ?? [];
  const expectedInternalToolCalls =
    response?.validation?.expected_internal_tool_calls ?? [];
  const optionalToolCalls = response?.validation?.optional_tool_calls ?? [];
  const coveredExpectedToolCount = expectedToolCalls.filter((toolName) =>
    sourceToolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  ).length;
  const coveredExpectedInternalToolCount = expectedInternalToolCalls.filter(
    (toolName) =>
      internalToolCalls.some(
        (call) =>
          call.tool_name === toolName &&
          (call.status === "executed" || call.status === "pending_confirmation")
      )
  ).length;
  const expectedContextKeys =
    response?.expected_context_keys ?? [];
  const telegramNotice = response
    ? skillTestTelegramNotice([...sourceToolCalls, ...otherToolCalls], "habilidad")
    : null;
  const externalContactHint = response
    ? skillTestExternalContactTelegramHint([...sourceToolCalls, ...otherToolCalls])
    : null;
  const telegramCallsForDetails = response
    ? collectSkillTestTelegramCalls([...sourceToolCalls, ...otherToolCalls])
    : [];
  const notifyUserCallsForDetails = response
    ? collectSkillTestNotifyUserCalls(sourceToolCalls)
    : [];
  const notifyUserNotice = response
    ? skillTestNotifyUserNotice([
        ...sourceToolCalls,
        ...otherToolCalls,
      ] as SkillTestToolCallDetail[])
    : null;
  const renderedDocuments = response
    ? collectSkillTestRenderedDocuments([
        ...sourceToolCalls,
        ...otherToolCalls,
      ])
    : [];
  const docUrlPlaceholderNotice = response
    ? skillTestNotifyMissingDocUrlNotice(
        [...sourceToolCalls, ...otherToolCalls],
        renderedDocuments
      )
    : null;
  const executedInternalToolCount = internalToolCalls.filter(
    (call) => call.status === "executed"
  ).length;
  const statusLabel =
    response?.pending_confirmation && response.status === "tested_ok"
      ? "Probada con acción externa pendiente"
      : response?.pending_confirmation && response.status === "partial"
        ? "Guardado pendiente"
      : response
        ? skillTestStatusLabel(response.status)
        : "";
  async function runSkill() {
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/tool-readiness/run-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_type_id: row.id,
          case_id: caseId ?? undefined,
          skill_slug: skill.skill_slug,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SkillTestResponse;
      if (!res.ok) {
        throw new Error(data.error ?? data.hint ?? "No se pudo probar la habilidad.");
      }
      setResponse(data);
      await onFinished();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const skillIntro =
    "Valida el contrato operativo de esta habilidad en una corrida controlada.";
  const skillButtonLabel =
    running
      ? "Probando..."
      : skill.test_status === "tested_ok"
        ? "Volver a probar habilidad"
        : "Probar habilidad";

  return (
    <ReadinessTestSection
      title="Prueba de habilidad"
      summaryHint={sectionSummaryHint}
      open={sectionOpen}
      onOpenChange={setSectionOpen}
      locked={blocked}
      intro={
        blocked ||
        skill.test_status === "tested_ok" ||
        skill.test_status === "tested_failed"
          ? null
          : skillIntro
      }
      blockedMessage={skillBlockedMessage || null}
      tone="violet"
    >
      <div className="flex flex-wrap items-center gap-2">
        {readinessTestShowActionRowStatusPill(skill.test_status) ? (
          <span
            className={`rounded px-1.5 py-0.5 font-semibold ${readinessTestStatusPillClass(
              skill.test_status
            )}`}
          >
            {aggregatedStatusLabel}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void runSkill()}
          disabled={running || !hasTestCase || blocked}
          title={
            !hasTestCase
              ? "Crea primero un caso de prueba."
              : blocked
                ? SKILL_TEST_BLOCKED_TITLE
                : undefined
          }
          className={SKILL_TEST_PRIMARY_BUTTON_CLASS}
        >
          {skillButtonLabel}
        </button>
      </div>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
          {error}
        </p>
      ) : null}
      {response ? (
        <div className="space-y-1 rounded border border-white bg-white/80 p-2">
          <div className="flex flex-wrap gap-2">
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${readinessTestStatusPillClass(
                response.status
              )}`}
            >
              {statusLabel}
            </span>
            {response.pending_confirmation ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800">
                Acción no enviada
              </span>
            ) : null}
          </div>
          <p className="text-neutral-700">
            {response.ok && response.pending_confirmation
              ? "La habilidad cubrió el contrato operativo esperado. Por seguridad, alguna acción externa quedó preparada pero no enviada desde la prueba de habilidad."
              : response.ok
              ? "La habilidad cubrió el contrato del escenario esperado."
              : response.pending_confirmation
                ? "La habilidad llegó a una acción pendiente, pero todavía no cubrió todo el contrato operativo esperado."
                : "La habilidad no cubrió el contrato operativo esperado; revisa respuesta, eventos y tools llamadas."}
          </p>
          {telegramNotice ? (
            <p className="rounded border border-violet-200 bg-violet-50/80 p-2 text-violet-900">
              {telegramNotice}
            </p>
          ) : null}
          {notifyUserNotice ? (
            <p className="text-amber-900">{notifyUserNotice}</p>
          ) : null}
          {externalContactHint ? (
            <p className="text-neutral-600">{externalContactHint}</p>
          ) : null}
          {response.validation ? (
            <div className="space-y-1 text-neutral-700">
              <p>
                Artefactos en{" "}
                <span className="font-mono">context_jsonb</span>:{" "}
                {expectedContextKeys.length > 0
                  ? expectedContextKeys.join(", ")
                  : SKILL_TEST_NOT_APPLICABLE}
                {missingContextKeys.length > 0
                  ? `. Faltan: ${missingContextKeys.join(", ")}.`
                  : expectedContextKeys.length > 0
                    ? ". OK."
                    : " (este escenario no exige artefactos nuevos)."}
              </p>
              <p>
                Tools de negocio:{" "}
                {expectedToolCalls.length > 0
                  ? `${coveredExpectedToolCount}/${expectedToolCalls.length} (${expectedToolCalls.join(", ")})`
                  : SKILL_TEST_NOT_APPLICABLE}
                {expectedToolCalls.length === 0
                  ? " (este escenario no exige tools de negocio concretas)."
                  : "."}
              </p>
              {expectedInternalToolCalls.length > 0 ? (
                <p>
                  Acciones internas esperadas:{" "}
                  {coveredExpectedInternalToolCount}/
                  {expectedInternalToolCalls.length} (
                  {expectedInternalToolCalls.join(", ")}).
                </p>
              ) : null}
              {optionalToolCalls.length > 0 ? (
                <p>Tools condicionales/opcionales: {optionalToolCalls.join(", ")}.</p>
              ) : null}
            </div>
          ) : null}
          {response.deterministic_repair?.applied ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              El artefacto fue corregido determinísticamente desde los datos
              guardados del caso porque la respuesta original del agente no
              cumplía el contrato. Revisa el artefacto guardado; el preview
              textual puede mostrar la respuesta original.
              {response.deterministic_repair.reason
                ? ` Motivo: ${response.deterministic_repair.reason}`
                : ""}
            </p>
          ) : null}
          {artifactErrors.length > 0 ? (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
              <p className="font-semibold">Errores del artefacto:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {artifactErrors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {missingEvents.length > 0 ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              Eventos esperados faltantes: {missingEvents.join(", ")}.
            </p>
          ) : null}
          {missingToolCalls.length > 0 ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              Tools obligatorias no ejecutadas: {missingToolCalls.join(", ")}.
            </p>
          ) : null}
          {missingInternalToolCalls.length > 0 ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              Acciones internas obligatorias no ejecutadas:{" "}
              {missingInternalToolCalls.join(", ")}.
            </p>
          ) : null}
          {missingAnyToolCall.length > 0 ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              Cobertura mínima de tools faltante: {missingAnyToolCall.join(", ")}.
            </p>
          ) : null}
          {contributionSummary ? (
            <p className="text-neutral-600">{contributionSummary}</p>
          ) : null}
          {renderedDocuments.length > 0 ? (
            <SkillTestRenderedDocumentLinks documents={renderedDocuments} />
          ) : null}
          {docUrlPlaceholderNotice ? (
            <p className="rounded border border-amber-200 bg-amber-50/90 p-2 text-amber-950">
              {docUrlPlaceholderNotice}
            </p>
          ) : null}
          {sourceToolCalls.length > 0 ||
          internalToolCalls.length > 0 ||
          otherToolCalls.length > 0 ? (
            <details className="text-neutral-600">
              <summary className="cursor-pointer font-semibold text-violet-900">
                Ver detalle tecnico de tools llamadas
              </summary>
              <div className="mt-1 space-y-1 font-mono text-[10px]">
                {sourceToolCalls.length > 0 ? (
                  <p>
                    {formatSkillTestCallGroupLabel({
                      label: "Negocio",
                      calls: sourceToolCalls,
                      executedCount: executedSourceToolCount,
                      pendingCount: pendingSourceToolCount,
                    })}
                    :{" "}
                    {formatSkillTestToolCallAuditTokenList(sourceToolCalls).join(
                      ", "
                    )}
                  </p>
                ) : null}
                {internalToolCalls.length > 0 ? (
                  <p>
                    {formatSkillTestCallGroupLabel({
                      label: "Persistencia",
                      calls: internalToolCalls,
                      executedCount: executedInternalToolCount,
                    })}
                    :{" "}
                    {formatSkillTestToolCallAuditTokenList(internalToolCalls).join(
                      ", "
                    )}
                  </p>
                ) : null}
                {otherToolCalls.length > 0 ? (
                  <p>
                    Otras:{" "}
                    {formatSkillTestToolCallAuditTokenList(otherToolCalls).join(
                      ", "
                    )}
                  </p>
                ) : null}
                {telegramCallsForDetails.length > 0 ? (
                  <SkillTestTelegramCallDetails calls={telegramCallsForDetails} />
                ) : null}
                {notifyUserCallsForDetails.length > 0 ? (
                  <SkillTestNotifyUserCallDetails calls={notifyUserCallsForDetails} />
                ) : null}
              </div>
            </details>
          ) : null}
          {artifactEntries.length ? (
            <details>
              <summary className="cursor-pointer font-semibold text-violet-900">
                Ver artefacto guardado
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto rounded bg-white p-2 font-mono">
                {JSON.stringify(Object.fromEntries(artifactEntries), null, 2)}
              </pre>
            </details>
          ) : null}
          {response.response_preview ? (
            <details>
              <summary className="cursor-pointer font-semibold text-violet-900">
                Ver resultado narrativo del agente
              </summary>
              <p className="mt-1 text-neutral-500">
                Resumen en lenguaje natural generado por el agente. Complementa
                la validación estructurada de contrato, tools y eventos de arriba.
              </p>
              {response.response_preview_truncated ? (
                <p className="mt-1 rounded bg-amber-50 p-2 text-amber-800">
                  Preview truncado para mantener la pantalla legible. Revisa el
                  resultado completo en el artefacto guardado.
                </p>
              ) : null}
              <pre className="mt-1 max-h-52 overflow-auto rounded bg-white p-2 font-mono">
                {response.response_preview}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </ReadinessTestSection>
  );
}

type StepTestResponse = {
  ok: boolean;
  status: "tested_ok" | "tested_failed" | "partial";
  run_id?: string;
  duration_ms?: number;
  step_key: string;
  scenario_id: string;
  scenario_label: string;
  scenario_summary?: string | null;
  scenario_seed_summary?: string | null;
  scenario_expect_summary?: string | null;
  root_skill_slug: string;
  validation?: {
    ok: boolean;
    missing_context_keys?: string[];
    missing_events?: string[];
    wrong_current_step?: string[];
    wrong_status?: string[];
    missing_tool_calls?: string[];
    comparables_outcome_errors?: string[];
    comparables_usable_count?: number | null;
    comparables_defensible?: boolean | null;
    step_outcome_errors?: string[];
    actual_current_step?: string | null;
    actual_status?: string;
  };
  expect?: {
    current_step?: string;
    status?: string;
    expected_events?: string[];
    expected_context_keys?: string[];
    expected_tool_calls?: string[];
  };
  seed_applied?: {
    current_step?: string;
    status?: string;
    context_patch?: Record<string, unknown>;
  } | null;
  before_step?: string | null;
  before_status?: string | null;
  pending_confirmation?: boolean;
  execution?: "agent" | "business_decision";
  business_decision_message?: string | null;
  response_preview?: string | null;
  response_preview_truncated?: boolean;
  tool_calls?: Array<SkillTestToolCallDetail>;
  error?: string;
  hint?: string;
};

type StepTestStartResponse =
  | StepTestResponse
  | {
      ok: boolean;
      async: true;
      run_id: string;
      run_status: "queued" | "running" | "completed" | "failed" | "timed_out";
      step_key: string;
      scenario_id: string;
      scenario_label: string;
      root_skill_slug: string;
      error?: string;
      hint?: string;
    };

type StepTestRunStatusResponse = {
  ok: boolean;
  run_id: string;
  run_status: "queued" | "running" | "completed" | "failed" | "timed_out";
  progress?: StepTestRunProgress;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  error?: string | null;
  result?: StepTestResponse;
};

type StepTestRunProgress = {
  phase?: string;
  label?: string;
  completed_tool_count?: number;
  total_tool_calls?: number;
  last_tool_call?: {
    tool_name: string;
    status: string;
    duration_ms?: number | null;
  } | null;
  tool_calls?: Array<{
    tool_name: string;
    status: string;
    duration_ms?: number | null;
  }>;
};

function formatDurationMs(ms: number | null | undefined) {
  if (ms == null) return "";
  return formatElapsed(ms);
}

const STEP_TEST_INTERNAL_TOOL_NAMES = new Set([
  "operational_case_update_intake",
  "operational_case_update_state",
  "operational_case_add_event",
]);

function StepTestPanel({
  step,
  row,
  caseTypeSlug,
  hasTestCase,
  caseId,
  onFinished,
}: {
  step: ToolReadinessFlowStep;
  row: OperationalCaseType;
  caseTypeSlug: string;
  hasTestCase: boolean;
  caseId?: string | null;
  onFinished: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<StepTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<number | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<string | null>(null);
  const [activeRunProgress, setActiveRunProgress] =
    useState<StepTestRunProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const onFinishedRef = useRef(onFinished);
  const scenarioCatalogSlug =
    stepTestCatalogSlugForRootSkill(row.default_skill_slug) ?? caseTypeSlug;
  const scenarios = stepTestScenariosFor(scenarioCatalogSlug, step.step_key);
  const [selectedScenarioId, setSelectedScenarioId] = useState(
    scenarios[0]?.id ?? ""
  );
  const available = stepTestAvailable(scenarioCatalogSlug, step.step_key);
  const blocked = isStepTestBlocked(step);
  const sectionState = stepTestSectionState(step);
  const aggregatedStepStatusLabel = stepTestStatusLabel(
    step.test_status,
    step.step_test_progress,
    { allSkillsN3Ok: stepAllSkillsN3Ok(step.step_skills) }
  );
  const sectionSummaryHint = stepTestSectionSummary(step);
  const [sectionOpen, setSectionOpen] = useState(() =>
    stepTestSectionDefaultOpen(step)
  );
  const prevStepTestStatusRef = useRef(step.test_status);
  const wasStepBlockedRef = useRef(blocked);
  useEffect(() => {
    if (wasStepBlockedRef.current && !blocked) {
      setSectionOpen(true);
    }
    wasStepBlockedRef.current = blocked;
  }, [blocked]);
  useEffect(() => {
    if (sectionState === "expandedReady") {
      setSectionOpen(true);
    }
  }, [sectionState]);
  useEffect(() => {
    const prev = prevStepTestStatusRef.current;
    prevStepTestStatusRef.current = step.test_status;
    if (stepTestSectionCollapseWhenAlreadyProven(prev, step.test_status)) {
      setSectionOpen(false);
    }
  }, [step.test_status]);
  const selectedScenario =
    scenarios.find((scenario) => scenario.id === selectedScenarioId) ??
    scenarios[0];
  const stepToolCalls = response?.tool_calls ?? [];
  const stepBusinessToolCalls = stepToolCalls.filter(
    (call) => !STEP_TEST_INTERNAL_TOOL_NAMES.has(call.tool_name)
  );
  const stepInternalToolCalls = stepToolCalls.filter((call) =>
    STEP_TEST_INTERNAL_TOOL_NAMES.has(call.tool_name)
  );
  const stepTelegramCalls = collectSkillTestTelegramCalls(stepToolCalls);
  const stepNotifyUserCalls = collectSkillTestNotifyUserCalls(stepToolCalls);
  const executedStepBusinessToolCount = stepBusinessToolCalls.filter(
    (call) => call.status === "executed"
  ).length;
  const pendingStepBusinessToolCount = stepBusinessToolCalls.filter(
    (call) => call.status === "pending_confirmation"
  ).length;
  const executedStepInternalToolCount = stepInternalToolCalls.filter(
    (call) => call.status === "executed"
  ).length;

  const statusLabel = response
    ? response.pending_confirmation && response.status === "tested_ok"
      ? "Escenario probado con acción pendiente"
      : stepScenarioRunResultLabel(response.status)
    : "";
  const contractDraftOutcomeHint =
    response && step.step_key === "contract_pending"
      ? contractDraftScenarioOutcomeHint({
          scenarioOk: response.ok,
          scenarioId: response.scenario_id,
          caseStatus: response.validation?.actual_status,
          toolCalls: response.tool_calls,
        })
      : null;

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!activeRunId || !running) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      if (activeRunStartedAt) {
        setElapsedMs(Date.now() - activeRunStartedAt);
      }
      try {
        const res = await fetch(`/api/tool-readiness/run-step/${activeRunId}`);
        const data = (await res.json().catch(() => ({}))) as StepTestRunStatusResponse;
        if (!res.ok) {
          throw new Error(data.error ?? "No se pudo consultar la prueba de paso.");
        }
        setActiveRunStatus(data.run_status);
        setActiveRunProgress(data.progress ?? null);
        if (data.run_status === "completed") {
          if (data.result) setResponse(data.result);
          await onFinishedRef.current();
          if (!cancelled) {
            setRunning(false);
            setActiveRunId(null);
          }
          return;
        }
        if (data.run_status === "failed" || data.run_status === "timed_out") {
          throw new Error(data.error ?? "La prueba de paso falló.");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setRunning(false);
          setActiveRunId(null);
        }
        return;
      }
      timeoutId = setTimeout(() => void poll(), 2000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [activeRunId, activeRunStartedAt, running]);

  if (!available) return null;

  async function runStep() {
    setRunning(true);
    setError(null);
    setResponse(null);
    setActiveRunId(null);
    setActiveRunStatus(null);
    setActiveRunProgress(null);
    setActiveRunStartedAt(Date.now());
    setElapsedMs(0);
    try {
      const res = await fetch("/api/tool-readiness/run-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_type_id: row.id,
          case_id: caseId ?? undefined,
          step_key: step.step_key,
          scenario_id: selectedScenario?.id,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as StepTestStartResponse;
      if (!res.ok) {
        throw new Error(data.hint ?? data.error ?? "No se pudo probar el paso.");
      }
      if ((data as { async?: boolean }).async === true) {
        const asyncData = data as Extract<StepTestStartResponse, { async: true }>;
        setActiveRunId(asyncData.run_id);
        setActiveRunStatus(asyncData.run_status);
        return;
      }
      setResponse(data as StepTestResponse);
      await onFinished();
      setRunning(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  const validation = response?.validation;
  const missingContextKeys = validation?.missing_context_keys ?? [];
  const missingEvents = validation?.missing_events ?? [];
  const expectedEvents = response?.expect?.expected_events ?? [];
  const expectedContextKeys = response?.expect?.expected_context_keys ?? [];
  const expectedToolCalls = response?.expect?.expected_tool_calls ?? [];
  const coveredExpectedToolCount = expectedToolCalls.filter((toolName) =>
    stepBusinessToolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  ).length;
  const stepTelegramNotice = response
    ? skillTestTelegramNotice(stepToolCalls, "paso")
    : null;
  const stepExternalContactHint = response
    ? skillTestExternalContactTelegramHint(stepToolCalls)
    : null;
  const stepNotifyUserNotice = response
    ? skillTestNotifyUserNotice(stepToolCalls)
    : null;
  const stepRenderedDocuments = response
    ? collectSkillTestRenderedDocuments(stepToolCalls)
    : [];
  const stepDocUrlPlaceholderNotice = response
    ? skillTestNotifyMissingDocUrlNotice(stepToolCalls, stepRenderedDocuments)
    : null;
  const scenarioForUi =
    scenarios.find((s) => s.id === (response?.scenario_id ?? selectedScenario?.id)) ??
    selectedScenario;
  const stepExecution = resolveStepTestExecutionMode({
    scenarioExecution: scenarioForUi?.execution,
    responseExecution: response?.execution,
  });
  const stepUiCopy = resolveStepTestUiCopy({
    execution: stepExecution,
    business_decision_kind: scenarioForUi?.business_decision_kind,
    ui: scenarioForUi?.ui,
  });
  const pendingN1ToolIds = listUntestedReadinessToolIdsForStep(step);
  const stepBlockedMessage =
    blocked &&
    (pendingN1ToolIds.length > 0
      ? `${STEP_TEST_BLOCKED_TITLE} Pendiente: ${pendingN1ToolIds.join(", ")}.`
      : STEP_TEST_BLOCKED_TITLE);
  const scenariosBlock = (
    <div className="space-y-1 rounded border border-indigo-100 bg-white/70 p-2 text-indigo-950">
      <p className="font-semibold">Escenarios contemplados</p>
      <div className="flex flex-wrap gap-1.5">
        {scenarios.map((scenario) => {
          const active = scenario.id === selectedScenario?.id;
          return (
            <button
              key={scenario.id}
              type="button"
              onClick={() => setSelectedScenarioId(scenario.id)}
              disabled={running || blocked}
              className={`rounded border px-2 py-1 text-left font-semibold ${
                active
                  ? "border-indigo-300 bg-indigo-100 text-indigo-950"
                  : "border-neutral-200 bg-white text-neutral-700 hover:border-indigo-200"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {scenario.label}
            </button>
          );
        })}
      </div>
      {selectedScenario ? (
        <div className="space-y-0.5 text-neutral-700">
          {selectedScenario.summary ? <p>{selectedScenario.summary}</p> : null}
          <p>
            {selectedScenario.seed_summary ?? "Entrada: escenario controlado."}{" "}
            {selectedScenario.expect_summary ??
              "Salida: contrato esperado del paso."}
          </p>
        </div>
      ) : null}
    </div>
  );

  const stepIntro = blocked
    ? "Disponible cuando las integraciones y la habilidad de este paso estén probadas."
    : stepUiCopy.panelIntro;
  const stepButtonLabel =
    running
      ? "Probando..."
      : step.test_status === "tested_ok"
        ? "Volver a probar paso"
        : "Probar paso";

  return (
    <ReadinessTestSection
      title="Prueba de paso"
      summaryHint={sectionSummaryHint}
      open={sectionOpen}
      onOpenChange={setSectionOpen}
      locked={blocked}
      intro={
        blocked || step.test_status === "tested_ok" ? null : stepIntro
      }
      blockedMessage={stepBlockedMessage || null}
      tone="indigo"
    >
      <div className="flex flex-wrap items-center gap-2">
        {readinessTestShowActionRowStatusPill(step.test_status) ? (
          <span
            className={`rounded px-1.5 py-0.5 font-semibold ${readinessTestStatusPillClass(
              step.test_status
            )}`}
          >
            {aggregatedStepStatusLabel}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void runStep()}
          disabled={running || !hasTestCase || blocked || !available}
          title={
            !hasTestCase
              ? "Crea primero un caso de prueba."
              : blocked
                ? STEP_TEST_BLOCKED_TITLE
                : !available
                  ? "Este paso no tiene escenarios de prueba configurados."
                  : undefined
          }
          className={STEP_TEST_PRIMARY_BUTTON_CLASS}
        >
          {stepButtonLabel}
        </button>
      </div>
      {blocked ? (
        <details className="rounded border border-indigo-100 bg-white/70 p-2 text-indigo-950">
          <summary className="cursor-pointer font-semibold text-indigo-900">
            Ver escenarios contemplados del paso
          </summary>
          <div className="mt-2">{scenariosBlock}</div>
        </details>
      ) : (
        scenariosBlock
      )}
      {running ? (
        <div className="rounded border border-indigo-200 bg-indigo-50 p-2 text-indigo-950">
          <div className="font-semibold">
            Prueba del paso en ejecución · {formatElapsed(elapsedMs)}
          </div>
          <p className="text-indigo-800">
            {activeRunProgress?.label ?? stepUiCopy.runningHint}
          </p>
          {activeRunProgress?.last_tool_call ? (
            <p className="mt-1 text-indigo-800">
              Última tool:{" "}
              <span className="font-mono">
                {activeRunProgress.last_tool_call.tool_name}:
                {activeRunProgress.last_tool_call.status}
              </span>
              {activeRunProgress.last_tool_call.duration_ms != null
                ? ` · ${formatDurationMs(activeRunProgress.last_tool_call.duration_ms)}`
                : ""}
            </p>
          ) : null}
          {elapsedMs > 120000 ? (
            <p className="mt-1 rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
              Este N4 está tardando más de 2 minutos. El run sigue vivo, pero
              conviene revisar la tool activa y los tiempos al terminar.
            </p>
          ) : null}
          {activeRunProgress?.tool_calls?.length ? (
            <div className="mt-2 space-y-1 rounded border border-indigo-100 bg-white/70 p-2">
              <div className="font-semibold text-indigo-950">
                Tools registradas ({activeRunProgress.completed_tool_count ?? 0}/
                {activeRunProgress.total_tool_calls ?? activeRunProgress.tool_calls.length} terminadas)
              </div>
              <div className="space-y-0.5 font-mono text-[10px] text-indigo-800">
                {activeRunProgress.tool_calls.map((call, index) => (
                  <div key={`${call.tool_name}-${index}`}>
                    {call.tool_name}:{call.status}
                    {call.duration_ms != null
                      ? ` · ${formatDurationMs(call.duration_ms)}`
                      : ""}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {activeRunId ? (
            <p className="mt-1 font-mono text-[10px] text-indigo-700">
              run_id={activeRunId} · estado={activeRunStatus ?? "queued"}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
          {error}
        </p>
      ) : null}
      {response ? (
        <div className="space-y-1 rounded border border-white bg-white/80 p-2">
          <div className="flex flex-wrap gap-2">
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${readinessTestStatusPillClass(
                response.status
              )}`}
            >
              {statusLabel}
            </span>
            {response.duration_ms != null ? (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-semibold text-neutral-700">
                duración {formatElapsed(response.duration_ms)}
              </span>
            ) : null}
          </div>
          <p className="text-neutral-700">
            {response.ok ? stepUiCopy.successSummary : stepUiCopy.failureSummary}
          </p>
          {contractDraftOutcomeHint ? (
            <p className="rounded border border-amber-200 bg-amber-50/90 p-2 text-amber-950">
              {contractDraftOutcomeHint}
            </p>
          ) : null}
          <p className="text-neutral-600">
            {formatStepTestResultMetaLine({
              execution: stepExecution,
              scenarioLabel: response.scenario_label,
              rootSkillSlug: response.root_skill_slug,
              ui: stepUiCopy,
            })}
          </p>
          {stepTelegramNotice ? (
            <p className="rounded border border-indigo-200 bg-indigo-50/80 p-2 text-indigo-950">
              {stepTelegramNotice}
            </p>
          ) : null}
          {stepNotifyUserNotice ? (
            <p className="rounded border border-amber-200 bg-amber-50/90 p-2 text-amber-950">
              {stepNotifyUserNotice}
            </p>
          ) : null}
          {stepRenderedDocuments.length > 0 ? (
            <SkillTestRenderedDocumentLinks
              documents={stepRenderedDocuments}
              tone="indigo"
            />
          ) : null}
          {stepDocUrlPlaceholderNotice ? (
            <p className="rounded border border-amber-200 bg-amber-50/90 p-2 text-amber-950">
              {stepDocUrlPlaceholderNotice}
            </p>
          ) : null}
          {stepExternalContactHint ? (
            <p className="text-neutral-600">{stepExternalContactHint}</p>
          ) : null}
          <div className="space-y-0.5 rounded border border-indigo-50 bg-indigo-50/60 p-2 text-neutral-700">
            <p>
              Entrada sembrada:{" "}
              <span className="font-mono">
                {response.seed_applied?.current_step ?? response.before_step ?? "n/d"} /{" "}
                {response.seed_applied?.status ?? response.before_status ?? "n/d"}
              </span>
              {response.seed_applied?.context_patch ? " · context_patch aplicado" : ""}
            </p>
            <p>
              Salida esperada:{" "}
              <span className="font-mono">
                {response.expect?.current_step ?? "no aplica"} /{" "}
                {response.expect?.status ?? "no aplica"}
              </span>
              {response.expect?.expected_tool_calls?.length
                ? ` · tools: ${response.expect.expected_tool_calls.join(", ")}`
                : ""}
            </p>
          </div>
          {validation ? (
            <div className="space-y-0.5 text-neutral-700">
              <p>
                Artefactos en{" "}
                <span className="font-mono">context_jsonb</span>:{" "}
                {expectedContextKeys.length > 0
                  ? expectedContextKeys.join(", ")
                  : SKILL_TEST_NOT_APPLICABLE}
                {missingContextKeys.length > 0
                  ? `. Faltan: ${missingContextKeys.join(", ")}.`
                  : expectedContextKeys.length > 0
                    ? ". OK."
                    : " (este escenario no exige claves en contexto)."}
              </p>
              <p>
                Tools de negocio:{" "}
                {expectedToolCalls.length > 0
                  ? `${coveredExpectedToolCount}/${expectedToolCalls.length} (${expectedToolCalls.join(", ")})`
                  : SKILL_TEST_NOT_APPLICABLE}
                {expectedToolCalls.length === 0 ? "." : "."}
              </p>
              <p>
                Eventos esperados:{" "}
                {expectedEvents.length > 0
                  ? expectedEvents.join(", ")
                  : SKILL_TEST_NOT_APPLICABLE}
                {missingEvents.length > 0
                  ? `. Faltan: ${missingEvents.join(", ")}.`
                  : expectedEvents.length > 0
                    ? ". OK."
                    : " (este escenario no exige eventos)."}
              </p>
              <p>
                Estado: {validation.actual_status ?? "n/d"}
                {validation.wrong_status?.length
                  ? ` (esperado: ${validation.wrong_status.join(", ")})`
                  : " OK."}
              </p>
              <p>
                current_step: {validation.actual_current_step ?? "n/d"}
                {validation.wrong_current_step?.length
                  ? ` (esperado: ${validation.wrong_current_step.join(", ")})`
                  : " OK."}
              </p>
              {validation.missing_tool_calls?.length ? (
                <p className="text-amber-800">
                  Tools esperadas faltantes: {validation.missing_tool_calls.join(", ")}.
                </p>
              ) : null}
              {validation.comparables_usable_count != null ? (
                <p>
                  Comparables usables en análisis:{" "}
                  <span className="font-mono">{validation.comparables_usable_count}</span>
                  {validation.comparables_defensible === true
                    ? " (muestra defendible)"
                    : validation.comparables_defensible === false
                      ? " (insuficiente)"
                      : ""}
                </p>
              ) : null}
              {validation.comparables_outcome_errors?.length ? (
                <p className="text-amber-800">
                  Reglas de comparables:{" "}
                  {validation.comparables_outcome_errors.join(" ")}
                </p>
              ) : null}
              {validation.step_outcome_errors?.length ? (
                <p className="text-amber-800">
                  Validación del paso: {validation.step_outcome_errors.join(" ")}
                </p>
              ) : null}
            </div>
          ) : null}
          {stepToolCalls.length ? (
            <details className="text-neutral-600">
              <summary className="cursor-pointer font-semibold text-indigo-900">
                Ver tools llamadas en el tick
              </summary>
              <div className="mt-1 space-y-1 font-mono text-[10px]">
                {stepBusinessToolCalls.length > 0 ? (
                  <p>
                    {formatSkillTestCallGroupLabel({
                      label: "Negocio",
                      calls: stepBusinessToolCalls,
                      executedCount: executedStepBusinessToolCount,
                      pendingCount: pendingStepBusinessToolCount,
                    })}
                    :{" "}
                    {formatSkillTestToolCallAuditTokenList(
                      stepBusinessToolCalls
                    ).join(", ")}
                  </p>
                ) : null}
                {stepInternalToolCalls.length > 0 ? (
                  <p>
                    {formatSkillTestCallGroupLabel({
                      label: "Persistencia",
                      calls: stepInternalToolCalls,
                      executedCount: executedStepInternalToolCount,
                    })}
                    :{" "}
                    {formatSkillTestToolCallAuditTokenList(
                      stepInternalToolCalls
                    ).join(", ")}
                  </p>
                ) : null}
                {stepTelegramCalls.length > 0 ? (
                  <SkillTestTelegramCallDetails calls={stepTelegramCalls} />
                ) : null}
                {stepNotifyUserCalls.length > 0 ? (
                  <SkillTestNotifyUserCallDetails calls={stepNotifyUserCalls} />
                ) : null}
              </div>
            </details>
          ) : null}
          {response.response_preview ? (
            <details>
              <summary className="cursor-pointer font-semibold text-indigo-900">
                {stepUiCopy.previewLabel}
              </summary>
              {stepExecution === "business_decision" ? (
                <p className="mt-1 rounded bg-white p-2 text-neutral-800">
                  {response.response_preview}
                </p>
              ) : (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-white p-2 font-mono text-[10px]">
                  {response.response_preview}
                </pre>
              )}
            </details>
          ) : null}
        </div>
      ) : null}
    </ReadinessTestSection>
  );
}

function ownerResponseVerdictClass(verdict: OwnerResponseBusinessOutcome["verdict"]) {
  switch (verdict) {
    case "success":
      return "border-emerald-300 bg-emerald-50 text-emerald-950";
    case "blocked":
      return "border-amber-300 bg-amber-50 text-amber-950";
    case "wrong_step":
      return "border-red-300 bg-red-50 text-red-950";
    default:
      return "border-violet-300 bg-violet-50 text-violet-950";
  }
}

function leadDeliveryLabel(
  delivery: OwnerResponseBusinessOutcome["lead_messages"][number]["delivery"]
) {
  switch (delivery) {
    case "sent":
      return "Enviado al lead";
    case "pending_approval":
      return "Preparado, pendiente de tu aprobación";
    case "failed":
      return "Falló al enviar";
    default:
      return "No enviado";
  }
}

function TelegramStepValidationOutcomePanel({
  response,
  nextActionLabel,
}: {
  response: ToolTestResponse;
  nextActionLabel: string;
}) {
  const args = response.resolved_args ?? {};
  const text = typeof args.text === "string" ? args.text : "";
  const purpose =
    typeof args.purpose === "string" ? args.purpose : "characteristics_pending";
  const success = response.ok === true;
  return (
    <OutcomePanel
      variant={success ? "success" : "error"}
      title={success ? "A · Mensaje validado" : "A · Validación falló"}
      className="mt-2"
    >
      <p className="mt-1">
        {success
          ? "Args y texto listos. No se envió Telegram en esta validación."
          : response.error ?? response.hint ?? "No se pudo validar el mensaje."}
      </p>
      <p className="mt-1">
        <span className="font-semibold">purpose:</span>{" "}
        <span className="font-mono">{purpose}</span>
        {" · "}
        <span className="font-semibold">modo:</span>{" "}
        <span className="font-mono">
          {response.mode_used ? MODE_LABELS[response.mode_used] : "n/d"}
        </span>
      </p>
      {text ? (
        <details className="mt-2 rounded border border-emerald-200 bg-white/80 p-2">
          <summary className="cursor-pointer font-semibold">
            Texto validado (preview)
          </summary>
          <p className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{text}</p>
        </details>
      ) : null}
      <details className="mt-2 rounded border border-emerald-200 bg-white/80 p-2">
        <summary className="cursor-pointer font-semibold">
          A · Detalle técnico de validación
        </summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
          {JSON.stringify(
            {
              ok: response.ok,
              executed: response.executed,
              reason: response.reason,
              resolved_args: response.resolved_args,
            },
            null,
            2
          )}
        </pre>
      </details>
      {success ? (
        <p className="mt-2 font-semibold">{nextActionLabel}</p>
      ) : null}
    </OutcomePanel>
  );
}

function TelegramStepAOutcomePanel({
  response,
  caseSnapshot,
  nextActionLabel,
}: {
  response: ToolTestResponse;
  caseSnapshot?: OperationalCase | null;
  nextActionLabel?: string;
}) {
  const args = response.resolved_args ?? {};
  const text = typeof args.text === "string" ? args.text : "";
  const purpose =
    typeof args.purpose === "string" ? args.purpose : "characteristics_pending";
  const success = response.executed === true && response.ok === true;
  const variant: OutcomeVariant = success
    ? "success"
    : response.ok === true
      ? "warning"
      : "error";
  return (
    <OutcomePanel
      variant={variant}
      title={
        success
          ? "B · Mensaje enviado al contacto externo"
          : "B · Envío no completado"
      }
      className="mt-2"
    >
      <p className="mt-1">
        {success ? (
          <>
            Telegram confirmó el envío. El caso queda en{" "}
            <span className="font-mono">waiting_external</span> esperando respuesta
            del contacto externo.
          </>
        ) : (
          response.error ??
          response.hint ??
          "La prueba controlada no confirmó el envío por Telegram."
        )}
      </p>
      <p className="mt-1">
        <span className="font-semibold">purpose:</span>{" "}
        <span className="font-mono">{purpose}</span>
        {caseSnapshot ? (
          <>
            {" · "}
            <span className="font-semibold">Estado actual:</span>{" "}
            <span className="font-mono">
              {caseSnapshot.current_step ?? "sin paso"} / {caseSnapshot.status}
            </span>
          </>
        ) : null}
      </p>
      {text ? (
        <details className="mt-2 rounded border border-emerald-200 bg-white/80 p-2">
          <summary className="cursor-pointer font-semibold">
            Texto enviado (preview)
          </summary>
          <p className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{text}</p>
        </details>
      ) : null}
      <details className="mt-2 rounded border border-emerald-200 bg-white/80 p-2">
        <summary className="cursor-pointer font-semibold">
          B · Detalle técnico del envío
        </summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
          {JSON.stringify(
            {
              ok: response.ok,
              executed: response.executed,
              reason: response.reason,
              result: response.result,
              elapsed_ms: response.elapsed_ms,
            },
            null,
            2
          )}
        </pre>
      </details>
      {success && nextActionLabel ? (
        <p className="mt-2 font-semibold">{nextActionLabel}</p>
      ) : null}
    </OutcomePanel>
  );
}

function OwnerResponseOutcomePanel({
  outcome,
}: {
  outcome: OwnerResponseBusinessOutcome;
}) {
  return (
    <div
      className={`mt-3 rounded border p-3 text-xs ${ownerResponseVerdictClass(outcome.verdict)}`}
    >
      <div className="font-semibold">{outcome.headline}</div>
      <p className="mt-1">{outcome.summary}</p>
      <p className="mt-2 text-[11px] opacity-90">
        Esperado:{" "}
        <span className="font-mono">{outcome.expected_step}</span>
        {" · "}
        Actual:{" "}
        <span className="font-mono">
          {outcome.actual_step ?? "sin paso"} / {outcome.actual_status ?? "n/d"}
        </span>
      </p>
      {outcome.actual_status === "waiting_internal" ? (
        <p className="mt-2 rounded border border-white/70 bg-white/80 p-2 text-[11px] dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-semibold">Siguiente acción del paso 3:</span>{" "}
          validación del asesor con{" "}
          <span className="font-mono">notify_user · property_data_review</span>{" "}
          antes de avanzar a comparables. El caso no cambia de paso todavía.
        </p>
      ) : null}
      {outcome.internal_review_sent ? (
        <p className="mt-2 text-[11px] font-semibold opacity-90">
          Revisión interna solicitada al asesor (notify_user).
        </p>
      ) : null}
      {outcome.owner_response_text ? (
        <div className="mt-2 rounded border border-white/70 bg-white/80 p-2 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="font-semibold">Respuesta simulada del dueño</div>
          <p className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
            {outcome.owner_response_text}
          </p>
        </div>
      ) : null}
      {outcome.lead_messages.length > 0 ? (
        <div className="mt-2 space-y-2">
          <div className="font-semibold">Lo que vería el lead por Telegram</div>
          {outcome.lead_messages.map((message, index) => (
            <div
              key={`${message.purpose ?? "msg"}-${index}`}
              className="rounded border border-white/70 bg-white/80 p-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">
                {leadDeliveryLabel(message.delivery)}
                {message.purpose ? (
                  <span className="ml-1 font-mono text-neutral-500">
                    ({message.purpose})
                  </span>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
                {message.text}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] opacity-90">
          En este tick el agente no preparó ni envió un mensaje nuevo al lead.
        </p>
      )}
      {outcome.next_actions.length > 0 ? (
        <ul className="mt-2 list-inside list-disc text-[11px]">
          {outcome.next_actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TestCaseBusinessSnapshot({
  opCase,
  events,
  compact,
}: {
  opCase: OperationalCaseTestResult["case"];
  events?: OperationalCaseTestResult["events"];
  compact?: boolean;
}) {
  if (!opCase) return null;
  const propertyData =
    opCase.context_jsonb && isPlainRecord(opCase.context_jsonb.property_data)
      ? opCase.context_jsonb.property_data
      : null;
  const missingCritical = propertyData
    ? [
        ["operation", "operación"],
        ["property_type", "tipo"],
        ["area_total_m2", "m² totales"],
        ["bedrooms", "recámaras"],
        ["bathrooms", "baños"],
      ]
        .filter(([key]) => propertyData[key] == null || propertyData[key] === "")
        .map(([, label]) => label)
    : [];
  const externalResponses = (events ?? [])
    .filter((event) => event.event_type === "external_response")
    .slice(-3);

  return (
    <div
      className={`rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900 ${
        compact ? "mt-2" : "mt-3"
      }`}
    >
      <div className="font-semibold text-neutral-800 dark:text-neutral-100">
        Estado de negocio del caso
      </div>
      <p className="mt-1 text-neutral-600 dark:text-neutral-300">
        Paso:{" "}
        <span className="font-mono">{opCase.current_step ?? "sin paso"}</span>
        {" · "}
        Estado: <span className="font-mono">{opCase.status}</span>
        {" · "}
        Actualizado: {formatDateTime(opCase.updated_at)}
      </p>
      <p className="mt-1 text-neutral-600 dark:text-neutral-300">
        Críticos faltantes en{" "}
        <span className="font-mono">property_data</span>:{" "}
        {propertyData
          ? missingCritical.length > 0
            ? missingCritical.join(", ")
            : "ninguno detectado"
          : "sin property_data aún"}
      </p>
      {externalResponses.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer font-semibold text-violet-800 dark:text-violet-200">
            Últimas respuestas externas ({externalResponses.length})
          </summary>
          <ul className="mt-1 space-y-1 font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
            {externalResponses.map((event) => {
              const payload = event.payload_jsonb as Record<string, unknown> | null;
              const preview =
                typeof payload?.text === "string"
                  ? payload.text.slice(0, 120)
                  : "(sin texto)";
              return (
                <li key={event.id}>
                  {formatDateTime(event.created_at)} — {preview}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {propertyData ? (
        <details className="mt-2">
          <summary className="cursor-pointer font-semibold text-violet-800 dark:text-violet-200">
            Ver property_data
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px] dark:bg-neutral-950">
            {JSON.stringify(propertyData, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function SimulateOwnerResponsePanel({
  caseId,
  onProcessed,
  variant = "standalone",
  resetVersion = 0,
  disabled = false,
  disabledReason,
}: {
  caseId: string;
  onProcessed: (result: OperationalCaseTestResult) => Promise<void>;
  variant?: "standalone" | "inline";
  resetVersion?: number;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [text, setText] = useState(
    "Es venta, departamento, 3 recámaras, 2 baños completos y 1 cajón de estacionamiento."
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OperationalCaseTestResult | null>(null);
  const [businessOutcome, setBusinessOutcome] =
    useState<OwnerResponseBusinessOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setBusinessOutcome(null);
    setError(null);
  }, [resetVersion]);

  async function submit() {
    setRunning(true);
    setError(null);
    setResult(null);
    setBusinessOutcome(null);
    try {
      const res = await fetch("/api/operational-case-tests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_id: caseId,
          mode: "agent_e2e",
          owner_response_text: text.trim(),
          readiness_skill_slug: "extract-property-characteristics",
          readiness_flow_step_key: "documents_received",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        agent?: {
          pending_confirmation?: boolean;
          response_preview?: string | null;
        };
        error?: string;
        hint?: string;
        message?: string;
        business_outcome?: OwnerResponseBusinessOutcome | null;
      } & OperationalCaseTestResult;
      if (!res.ok || data.ok !== true) {
        throw new Error(data.hint ?? data.error ?? "No se pudo simular la respuesta.");
      }
      const processedResult = {
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
        pendingActions: data.pendingActions ?? [],
        blockingActions: data.blockingActions ?? [],
        historicalActions: data.historicalActions ?? [],
        transitionCount: data.transitionCount ?? 0,
        e2eStartEvents: data.e2eStartEvents ?? [],
        flowProgress: data.flowProgress ?? [],
      };
      setResult(processedResult);
      setBusinessOutcome(data.business_outcome ?? null);
      await onProcessed(processedResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      id={variant === "inline" ? "telegram-scenario-c" : undefined}
      className={`rounded border-2 border-violet-400 bg-violet-50/90 p-3 text-xs shadow-sm dark:border-violet-700 dark:bg-violet-950/40 ${
        variant === "inline" ? "mt-3" : "mt-3"
      }`}
    >
      <div className="font-semibold text-violet-900 dark:text-violet-200">
        {variant === "inline"
          ? "C · Simular respuesta y procesar"
          : "Simular respuesta y procesar"}
      </div>
      <p className="mt-1 text-violet-900/80 dark:text-violet-200/80">
        {variant === "inline"
          ? "Como si el dueño respondiera por Telegram. Edita el texto si hace falta y pulsa el botón violeta."
          : "Registra un external_response de prueba y ejecuta un tick controlado del agente en una sola acción."}
      </p>
      <label className="mt-2 block space-y-1">
        <span className="font-semibold text-neutral-700 dark:text-neutral-200">
          Texto del dueño
        </span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          className="w-full rounded border border-violet-200 bg-white px-2 py-1.5 font-mono text-[11px] dark:border-violet-800 dark:bg-neutral-900"
        />
      </label>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={disabled || running || !text.trim()}
        className={`mt-2 ${WIZARD_PRIMARY_BUTTON_CLASS}`}
      >
        {running ? "Procesando respuesta del dueño..." : "Simular respuesta y procesar"}
      </button>
      {disabled && disabledReason ? (
        <p className="mt-2 text-[11px] text-violet-900 dark:text-violet-200">
          {disabledReason}
        </p>
      ) : null}
      {businessOutcome ? (
        <OwnerResponseOutcomePanel outcome={businessOutcome} />
      ) : null}
      {result?.case ? (
        <TestCaseBusinessSnapshot
          opCase={result.case}
          events={result.events}
          compact
        />
      ) : null}
      {error ? (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function renderFlowToolReadiness(params: {
  item: ToolReadinessToolItem;
  row: OperationalCaseType;
  expanded: boolean;
  existingRequest: ToolReadinessRequestRecord | undefined;
  submitting: boolean;
  hasTestCase: boolean;
  caseId?: string | null;
  caseContextVersion?: string | null;
  readinessSkillSlug?: string;
  readinessFlowStepKey?: string;
  onEditSkill: () => void;
  onToggleExpand: () => void;
  onRequestGlobal: () => void;
  refreshToolReadiness: (
    row: OperationalCaseType,
    options?: { silent?: boolean }
  ) => Promise<void>;
  onBeforeAssetUpload?: () => void;
  onAssetUploaded?: () => Promise<void>;
  refreshTestCase?: (row: OperationalCaseType) => Promise<void>;
  onTestCaseUpdated?: (result: OperationalCaseTestResult) => Promise<void>;
  easyBrokerCreatedListingId?: string | null;
  onEasyBrokerListingCreated?: (listingId: string) => void;
  readinessFlowScrollEl?: HTMLDivElement | null;
}) {
  const { item, row, expanded, existingRequest, submitting } = params;
  const metaParts = [`Riesgo: ${riskLabel(item.risk)}`];
  if (item.requires_integration) {
    metaParts.push(`Integración: ${item.requires_integration}`);
  }
  if (item.category !== "ready") {
    metaParts.push(toolReadinessCategoryLabel(item.category));
  }

  return (
    <div className={`rounded border p-2 ${toolReadinessClass(item.status)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs">{item.tool_id}</span>
        <div className="flex flex-wrap gap-1">
          <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold">
            Estado: {toolReadinessLabel(item.status)}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${readinessTestStatusPillClass(
              item.test_status
            )}`}
          >
            {toolTestStatusLabel(item.test_status)}
          </span>
        </div>
      </div>
      <div className="mt-1 text-[11px]">{metaParts.join(" · ")}</div>
      {item.blocking && isReadinessVisibleTool(item.tool_id) ? (
        <p className="mt-1 text-xs font-semibold">Bloquea la prueba end-to-end.</p>
      ) : item.status !== "ready" && isReadinessVisibleTool(item.tool_id) ? (
        <p className="mt-1 text-xs font-semibold">
          No bloquea la prueba segura, pero debe resolverse antes de operación real.
        </p>
      ) : null}
      {item.status !== "ready" && item.notes.length > 0 ? (
        <p className="mt-1 text-xs">{item.notes.join(" ")}</p>
      ) : null}
      {renderReadinessActions({
        item,
        row,
        expanded,
        existingRequest,
        submitting,
        onEditSkill: params.onEditSkill,
        onToggleExpand: params.onToggleExpand,
        onRequestGlobal: params.onRequestGlobal,
      })}
      <ReadinessExpandableSection expanded={expanded}>
        {item.action_message ? (
          <p className="rounded border border-white/70 bg-white/70 p-2 text-[11px] leading-snug">
            {item.action_message}
          </p>
        ) : null}
        {item.account_provider && item.action_kind === "configure_account" ? (
          <div className="rounded border border-white/70 bg-white/85 p-3">
            <AccountToolConnectionForm
              provider={item.account_provider}
              compact
              onChanged={() => {
                void params.refreshToolReadiness(row);
              }}
            />
          </div>
        ) : null}
        {(item.asset_requirements?.length ?? 0) > 0 ? (
          <AccountAssetUploadPanel
            item={item}
            row={row}
            onBeforeUpload={params.onBeforeAssetUpload}
            onUploaded={
              params.onAssetUploaded ??
              (() => params.refreshToolReadiness(row))
            }
          />
        ) : null}
        {(item.test_asset_requirements?.length ?? 0) > 0 &&
        item.status === "ready" ? (
          <AccountAssetUploadPanel
            item={item}
            row={row}
            title="Activos de prueba"
            requirements={item.test_asset_requirements}
            successMessage="Activo de prueba guardado. Preparación operativa actualizada."
            onBeforeUpload={params.onBeforeAssetUpload}
            onUploaded={
              params.onAssetUploaded ??
              (() => params.refreshToolReadiness(row))
            }
          />
        ) : null}
        {item.status === "ready" ? (
          <ToolTestPanel
            item={item}
            row={row}
            panelActive={expanded}
            readinessFlowScrollEl={params.readinessFlowScrollEl}
            hasTestCase={params.hasTestCase}
            caseId={params.caseId}
            caseContextVersion={params.caseContextVersion}
            readinessSkillSlug={params.readinessSkillSlug}
            readinessFlowStepKey={params.readinessFlowStepKey}
            onFinished={async () => {
              await params.refreshToolReadiness(row);
              if (params.refreshTestCase) {
                await params.refreshTestCase(row);
              }
            }}
            onTestCaseUpdated={params.onTestCaseUpdated}
            easyBrokerCreatedListingId={params.easyBrokerCreatedListingId}
            onEasyBrokerListingCreated={params.onEasyBrokerListingCreated}
          />
        ) : null}
      </ReadinessExpandableSection>
    </div>
  );
}

function flowProgressSummaryBadge(status: OperationalCaseFlowProgressStatus) {
  let badge;
  if (status === "completed" || status === "in_progress") {
    badge = activationStatusBadge(
      status === "completed" ? "ready" : "attention",
      flowProgressRuntimeBadgeLabel(status)
    );
  } else if (status === "blocked") {
    badge = activationStatusBadge("attention", flowProgressRuntimeBadgeLabel(status));
  } else {
    badge = activationStatusBadge("pending", flowProgressRuntimeBadgeLabel(status));
  }
  return (
    <span title={flowProgressRuntimeBadgeTitle(status)} className="inline-flex">
      {badge}
    </span>
  );
}

function conversationalCaseStatusLabel(params: {
  status?: OperationalCaseStatus | null;
  intakeIncomplete?: boolean;
}) {
  if (params.intakeIncomplete) {
    return "Recolectando datos (Telegram)";
  }
  if (!params.status) return null;
  return OPERATIONAL_CASE_STATUS_LABELS[params.status];
}

function countConversationalActivity(
  events: OperationalCaseEvent[],
  opCase: OperationalCase | null
): number {
  const count = conversationalActivityItems(events, opCase).length;
  if (count > 0) return count;
  if (opCase?.current_step === "intake") return 1;
  return 0;
}

function conversationalActivityItems(
  events: OperationalCaseEvent[],
  opCase: OperationalCase | null
): Array<{ id: string; label: string; detail: string; createdAt?: string }> {
  const items = events.flatMap((event) => {
    const payload = (event.payload_jsonb ?? {}) as Record<string, unknown>;
    const source = String(payload.source ?? "");
    const isConversational =
      source === "deterministic_conversational_intake" ||
      source.includes("telegram") ||
      source === "agent_conversation" ||
      event.event_type === "external_response" ||
      event.event_type === "human_decision";
    if (!isConversational) return [];

    const kind = String(payload.kind ?? event.event_type);
    const currentStep =
      typeof payload.current_step === "string" ? payload.current_step : null;
    const intakeStatus =
      typeof payload.intake_status === "string" ? payload.intake_status : null;
    const status = typeof payload.status === "string" ? payload.status : null;
    const label =
      source === "deterministic_conversational_intake"
        ? "Caso conversacional creado"
        : source.includes("telegram")
          ? "Actividad de Telegram"
          : event.event_type === "external_response"
            ? "Respuesta externa registrada"
            : event.event_type === "human_decision"
              ? "Acción humana registrada"
              : kind;
    const detailParts = [
      source ? `source=${source}` : null,
      status ? `status=${status}` : null,
      currentStep ? `current_step=${currentStep}` : null,
      intakeStatus ? `intake_status=${intakeStatus}` : null,
    ].filter(Boolean);
    return [
      {
        id: event.id,
        label,
        detail: detailParts.join(" · ") || kind,
        createdAt: event.created_at,
      },
    ];
  });

  if (items.length > 0) return items;
  if (opCase?.current_step === "intake") {
    return [
      {
        id: `case:${opCase.id}:intake`,
        label: "Caso en intake conversacional",
        detail: `status=${opCase.status} · current_step=${opCase.current_step}`,
        createdAt: opCase.updated_at,
      },
    ];
  }
  return [];
}

function TestCaseFlowProgressSummary({
  caseStatus,
  caseStatusTechnical,
  currentStepTechnical,
  flowProgress,
  e2eScoped,
  hasTransitions,
  intakeIncomplete,
  manualTransitionCount = 0,
  conversationalActivityCount = 0,
  conversationalActivity = [],
}: {
  caseStatus?: OperationalCaseStatus | null;
  caseStatusTechnical?: string | null;
  currentStepTechnical?: string | null;
  flowProgress: OperationalCaseFlowProgressStep[];
  e2eScoped?: boolean;
  hasTransitions?: boolean;
  intakeIncomplete?: boolean;
  manualTransitionCount?: number;
  conversationalActivityCount?: number;
  conversationalActivity?: Array<{
    id: string;
    label: string;
    detail: string;
    createdAt?: string;
  }>;
}) {
  const stepsWithHistory = flowProgress.filter(
    (step) => step.evidence.length > 0
  ).length;
  const currentSteps = flowProgress.filter(
    (step) => step.status === "in_progress"
  );
  const currentStepBadgeLabel =
    currentSteps.length === 1
      ? `En: ${currentSteps[0]!.step_label}`
      : currentSteps.length > 1
        ? `${currentSteps.length} posiciones activas`
        : null;
  const caseStatusLabel = conversationalCaseStatusLabel({
    status: caseStatus,
    intakeIncomplete,
  });
  const currentStepCode = currentSteps.length === 1 ? currentSteps[0]!.step_key : null;

  const visibleSteps = intakeIncomplete
    ? flowProgress.filter((step) => step.step_key === "intake")
    : flowProgress;
  const hiddenStepsCount = Math.max(0, flowProgress.length - visibleSteps.length);

  return (
    <details className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <summary className="cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden">
        <div className="text-center">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
              Resumen del recorrido con agente
            </span>
            {intakeIncomplete ? (
              <span className="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
                Paso 0 en curso
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                {stepsWithHistory}/{flowProgress.length} pasos con actividad
              </span>
            )}
            <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
              Revisiones manuales: {manualTransitionCount}
            </span>
            {intakeIncomplete ? (
              <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                Actividad conversacional: {conversationalActivityCount}
              </span>
            ) : null}
            {caseStatusLabel ? (
              <span className="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
                Estado: {caseStatusLabel}
                {caseStatus && !intakeIncomplete ? ` (${caseStatus})` : ""}
              </span>
            ) : null}
            {!intakeIncomplete && currentStepBadgeLabel ? (
              <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                {currentStepBadgeLabel}
                {currentStepCode ? ` (${currentStepCode})` : ""}
              </span>
            ) : null}
            {caseStatusTechnical || currentStepTechnical ? (
              <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                Técnico: {caseStatusTechnical ?? "sin_status"} /{" "}
                {currentStepTechnical ?? "sin_step"}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Actividad E2E agrupada por paso del flujo operativo. Incluye Paso 0
            conversacional y revisiones manuales del runner; excluye
            preparación/safe_check y pruebas aisladas de tools, habilidades o
            pasos.
          </p>
          {!hasTransitions ? (
            <p className="mt-1 text-xs text-neutral-500">
              {intakeIncomplete
                ? "Aún no hay revisiones manuales. El Paso 0 avanza por Telegram mientras completas el intake."
                : "Aún no hay revisiones manuales del runner en este recorrido."}
            </p>
          ) : null}
        </div>
      </summary>
      <ol className="mt-3 space-y-2 border-t border-neutral-200 pt-3 text-xs dark:border-neutral-800">
        {visibleSteps.map((step) => {
          const summary = summarizeFlowStepEvidence(step.evidence);
          return (
            <li
              key={step.step_key}
              className="rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="font-semibold">
                {flowProgressStepHeading(step, flowProgress)}
              </div>
              <div className="mt-1">{flowProgressSummaryBadge(step.status)}</div>
              <p className="mt-1 text-neutral-600 dark:text-neutral-300">
                {intakeIncomplete &&
                step.step_key === "intake" &&
                step.evidence.length === 0
                  ? "Actividad conversacional en curso por Telegram. Esta línea muestra transiciones manuales, por eso aún no hay evidencia E2E."
                  : formatFlowStepEvidenceSummaryLine(summary, {
                      cycleScoped: Boolean(e2eScoped),
                    })}
              </p>
              {intakeIncomplete && step.step_key === "intake" ? (
                <div className="mt-2 rounded border border-sky-100 bg-sky-50/70 p-2 text-[11px] text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
                  <div className="font-semibold">
                    Detalle de actividad conversacional y estado técnico
                  </div>
                  <ul className="mt-1 space-y-1">
                    {conversationalActivity.map((item) => (
                      <li
                        key={item.id}
                        className="rounded border border-sky-100 bg-white/80 px-2 py-1 dark:border-sky-900 dark:bg-neutral-950/50"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium">{item.label}</span>
                          {item.createdAt ? (
                            <span className="text-[10px] text-sky-700 dark:text-sky-300">
                              {formatDateTime(item.createdAt)}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-sky-800 dark:text-sky-200">
                          {item.detail}
                        </div>
                      </li>
                    ))}
                    {caseStatusTechnical || currentStepTechnical ? (
                      <li className="rounded border border-sky-100 bg-white/80 px-2 py-1 dark:border-sky-900 dark:bg-neutral-950/50">
                        <div className="font-medium">Estado actual del caso</div>
                        <div className="mt-0.5 font-mono text-[10px] text-sky-800 dark:text-sky-200">
                          status={caseStatusTechnical ?? "sin_status"} ·
                          current_step={currentStepTechnical ?? "sin_step"}
                        </div>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
                {summary.uniqueTools.length > 0 ? (
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Tools: {summary.uniqueTools.slice(0, 6).join(", ")}
                    {summary.uniqueTools.length > 6
                      ? ` (+${summary.uniqueTools.length - 6} más)`
                      : ""}
                  </p>
                ) : null}
                {step.evidence.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] font-semibold text-violet-700 hover:underline">
                      Ver actividad ({step.evidence.length})
                    </summary>
                    <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-[11px] text-neutral-600 dark:text-neutral-300">
                      {(step.evidenceItems ?? []).map((item) => (
                        <li
                          key={`${item.kind}:${item.id}`}
                          className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 rounded border border-neutral-100 bg-neutral-50/80 px-2 py-1 dark:border-neutral-800 dark:bg-neutral-950/50"
                        >
                          <span>
                            {item.kind === "event" ? (
                              <span className="font-medium text-neutral-800 dark:text-neutral-100">
                                {item.summary}
                              </span>
                            ) : (
                              <>
                                <span className="font-mono text-neutral-800 dark:text-neutral-100">
                                  {item.tool_name}
                                </span>
                                <span className="ml-1 text-neutral-500">
                                  · {toolCallStatusLabel(item.status)}
                                </span>
                                {item.failure_detail ? (
                                  <span className="ml-1 text-red-700 dark:text-red-300">
                                    · {item.failure_detail}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-400">
                            {formatDateTime(item.created_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
            </li>
          );
        })}
      </ol>
      {intakeIncomplete && hiddenStepsCount > 0 ? (
        <p className="mt-2 text-[11px] text-neutral-500">
          Los pasos operativos (1-{hiddenStepsCount}) se mostrarán cuando se
          complete el intake y empiecen transiciones manuales.
        </p>
      ) : null}
    </details>
  );
}

function labPendingActionDisplayLabel(action: LabPendingAction) {
  if (action.kind === "internal_notification") {
    return internalNotificationKindConfig(action.notification_kind, {
      body: action.body,
      title: action.label,
    }).label;
  }
  return action.label;
}

const LAB_PENDING_TOOL_LABELS: Record<string, string> = {
  telegram_send_message_to_contact: "Enviar mensaje por Telegram",
};

function humanizeToolSlugForLab(toolName: string): string {
  return toolName
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function labPendingToolDisplay(toolName: string): string {
  const trimmed = toolName.trim();
  const friendly = LAB_PENDING_TOOL_LABELS[trimmed] ?? humanizeToolSlugForLab(trimmed);
  return `${friendly} (${trimmed})`;
}

function LabPendingActionItem({
  action,
  caseId,
  showTelegramHint,
  variant = "blocking",
  operationalStepLabels,
  realCaseMode = false,
}: {
  action: LabPendingAction;
  caseId: string;
  showTelegramHint: boolean;
  variant?: "blocking" | "historical";
  operationalStepLabels?: OperationalStepLabelMap;
  realCaseMode?: boolean;
}) {
  const isHistorical = variant === "historical";
  const focusId = pendingActionFocusId(action);
  const showAssociatedLink =
    action.kind === "internal_notification" &&
    shouldShowAssociatedActionLink({
      kind: "internal_notification",
      notification_kind: action.notification_kind,
      action_url: action.action_url,
      body: action.body,
      caseId,
      suppressGenericPendingCaseLink: true,
    });
  const badgeClass = isHistorical
    ? "rounded bg-neutral-100 px-1.5 py-0.5 font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
    : "rounded bg-amber-100 px-1.5 py-0.5 font-semibold";
  const metaClass = isHistorical
    ? "text-[11px] text-neutral-500 dark:text-neutral-400"
    : "text-[11px] text-amber-700";
  const bodyClass = isHistorical
    ? "prose prose-sm mt-1 max-w-none break-words text-[11px] text-neutral-700 dark:text-neutral-300 prose-a:break-words prose-a:font-semibold prose-a:underline"
    : "prose prose-sm mt-1 max-w-none break-words text-[11px] text-amber-800 prose-a:break-words prose-a:font-semibold prose-a:underline";
  const linkClass = isHistorical
    ? "text-[11px] font-semibold text-neutral-700 underline dark:text-neutral-200"
    : "text-[11px] font-semibold text-amber-900 underline";
  const toolArgsPreview =
    action.kind === "tool_confirmation"
      ? formatLabToolArgsPreviewLine(action.tool_name, action.args_preview, {
          operationalStepLabels,
        })
      : null;
  return (
    <li
      className={`min-w-0 rounded border p-2 ${
        variant === "blocking"
          ? "border-amber-200 bg-white/80"
          : "border-neutral-200 bg-white/70 dark:border-neutral-700 dark:bg-neutral-950/20"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={badgeClass}>
          {action.kind === "tool_confirmation"
            ? isHistorical
              ? "Aprobación previa del agente"
              : "Aprobación del agente"
            : isHistorical
              ? realCaseMode
                ? "Aviso del sistema"
                : "Notificación de prueba"
              : "Pendiente interno"}
        </span>
        <span className="font-semibold">{labPendingActionDisplayLabel(action)}</span>
        <span className={metaClass}>{formatDateTime(action.created_at)}</span>
        {showTelegramHint && action.telegram_delivered ? (
          <span
            className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800"
            title="Si vinculaste Telegram, revisa el chat del bot para aprobar desde ahí."
          >
            También en Telegram
          </span>
        ) : null}
      </div>
      {action.kind === "tool_confirmation" ? (
        <>
          <p className={`mt-1 ${metaClass}`}>
            {isHistorical ? (
              <>
                {realCaseMode
                  ? "Herramienta usada en aviso previo: "
                  : "Herramienta usada en prueba previa: "}
                <span>{labPendingToolDisplay(action.tool_name)}</span>.
              </>
            ) : (
              <>
                Ejecución pendiente:{" "}
                <span>{labPendingToolDisplay(action.tool_name)}</span>. Resuélvela en
                Pendientes o Telegram.
              </>
            )}
          </p>
          {toolArgsPreview ? (
            <p
              className={`mt-1 break-words font-mono text-[10px] leading-snug ${
                isHistorical
                  ? "text-neutral-600 dark:text-neutral-400"
                  : "text-amber-800"
              }`}
            >
              {toolArgsPreview}
            </p>
          ) : null}
        </>
      ) : (
        <div className={bodyClass}>
          <ReactMarkdown
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {prepareNotificationBodyMarkdown(action.body)}
          </ReactMarkdown>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={caseActionUrl(caseId)}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          {pendingActionLinkLabel(action, "case")}
        </a>
        {!isHistorical && focusId ? (
          <a
            href={pendientesDeepLink({ caseId, focus: focusId })}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            {pendingActionLinkLabel(action, "pendientes")}
          </a>
        ) : null}
        {action.kind === "internal_notification" && showAssociatedLink ? (
          <a
            href={action.action_url ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            {pendingActionLinkLabel(action, "action_url")}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function LabStepDetails({
  defaultOpen,
  className,
  summary,
  children,
}: {
  defaultOpen: boolean;
  className?: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  function toggleOpen() {
    const scrollPosition = capturePageScroll();
    setOpen((current) => !current);
    restorePageScrollAfterLayout(scrollPosition);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  return (
    <details
      className={`[overflow-anchor:none] ${className ?? ""}`.trim()}
      open={open}
    >
      <summary
        className="cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          toggleOpen();
        }}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
}

function LabCaseHistoryDetails({
  historicalActions,
  caseId,
  summaryToneClass,
  operationalStepLabels,
  realCaseMode = false,
}: {
  historicalActions: LabPendingAction[];
  caseId: string;
  summaryToneClass: string;
  operationalStepLabels?: OperationalStepLabelMap;
  realCaseMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const historySummary = formatSettingsTestHistorySummary(
    countSettingsTestActionsByKind(historicalActions)
  );

  function toggleOpen() {
    const scrollPosition = capturePageScroll();
    setOpen((current) => !current);
    restorePageScrollAfterLayout(scrollPosition);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  return (
    <details className="mt-2 [overflow-anchor:none]" open={open}>
      <summary
        className={`flex cursor-pointer list-none items-center gap-1 marker:content-none text-[11px] font-semibold [&::-webkit-details-marker]:hidden ${summaryToneClass}`}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          toggleOpen();
        }}
      >
        <span
          aria-hidden
          className={`inline-block text-[10px] leading-none transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ▸
        </span>
        <span>
          {historySummary}
        </span>
      </summary>
      <div className="[overflow-anchor:none]">
        <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
          {realCaseMode
            ? "Avisos y aprobaciones registradas anteriormente para este caso. Puedes limpiarlos si ya no aplican."
            : "Notificaciones y aprobaciones de pruebas previas. Puedes limpiarlas si ya no aplican."}
        </p>
        <ul className="mt-1 space-y-1.5">
          {historicalActions.map((action) => (
            <LabPendingActionItem
              key={action.id}
              action={action}
              caseId={caseId}
              showTelegramHint={false}
              variant="historical"
              operationalStepLabels={operationalStepLabels}
              realCaseMode={realCaseMode}
            />
          ))}
        </ul>
      </div>
    </details>
  );
}

function LabPendingActionPanel({
  blockingActions,
  historicalActions,
  caseId,
  onRefresh,
  refreshing,
  operationalStepLabels,
  transitionCount,
  currentStep,
  currentStepLabel,
  events,
  toolCalls,
  e2eStartEvents = [],
  playthroughAnchorAt,
  conversationalMode = false,
  intakeIncomplete = false,
  realCaseMode = false,
}: {
  blockingActions: LabPendingAction[];
  historicalActions: LabPendingAction[];
  caseId: string;
  onRefresh: () => void;
  refreshing: boolean;
  operationalStepLabels?: OperationalStepLabelMap;
  transitionCount: number;
  currentStep?: string | null;
  currentStepLabel?: string | null;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  e2eStartEvents?: OperationalCaseEvent[];
  playthroughAnchorAt?: string | null;
  conversationalMode?: boolean;
  intakeIncomplete?: boolean;
  realCaseMode?: boolean;
}) {
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupTarget, setCleanupTarget] = useState<SettingsTestCleanupTarget>("all");
  const prevTransitionCountRef = useRef(transitionCount);
  const hasBlocking = blockingActions.length > 0;
  const hasHistorical = historicalActions.length > 0;
  const historicalCounts = countSettingsTestActionsByKind(historicalActions);
  const transitionSummary = realCaseMode
    ? "Seguimiento operativo del caso real en curso."
    : formatLabTransitionSummary(transitionCount);
  const operationalStepDisplay =
    currentStepLabel?.trim() ||
    (currentStep ? operationalStepLabels?.[currentStep] : null) ||
    currentStep ||
    "sin paso";

  useEffect(() => {
    if (
      transitionCount > prevTransitionCountRef.current &&
      cleanupStatus
    ) {
      setCleanupStatus(null);
    }
    prevTransitionCountRef.current = transitionCount;
  }, [transitionCount, cleanupStatus]);

  async function cleanupCaseHistory() {
    setCleanupLoading(true);
    setCleanupStatus(null);
    try {
      const res = await fetch(
        `/api/notifications?scope=settings-test&case_id=${encodeURIComponent(caseId)}&target=${encodeURIComponent(cleanupTarget)}`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        deleted_notifications?: number;
        rejected_tool_calls?: number;
        deleted?: number;
        error?: string;
      };
      if (!res.ok) {
        setCleanupStatus(data.error ?? "No se pudo limpiar el historial.");
        return;
      }
      setCleanupStatus(formatSettingsTestCleanupResult(data));
      onRefresh();
    } catch (err) {
      setCleanupStatus((err as Error).message ?? String(err));
    } finally {
      setCleanupLoading(false);
    }
  }

  return (
    <div
      className={`rounded border p-3 text-xs ${
        hasBlocking
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-neutral-200 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-200"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {hasBlocking
              ? "Acción humana pendiente"
              : realCaseMode
                ? "Estado del caso real"
                : "Estado del laboratorio"}
          </div>
          <p
            className={`mt-1 ${
              hasBlocking ? "text-amber-800" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {hasBlocking
              ? "Resuélvela en el mismo canal que usarías en operación real antes de revisar de nuevo el caso."
              : intakeIncomplete
                ? "Sin pendientes HITL activas. El recorrido sigue en Paso 0: completa el intake por Telegram antes de revisar avance."
                : hasHistorical
                  ? realCaseMode
                    ? "Hay registros HITL informativos previos para este caso. No bloquean la siguiente revisión."
                    : "Hay registros HITL informativos de pruebas anteriores. No bloquean la siguiente revisión."
                  : conversationalMode
                    ? "Sin pendientes HITL activas. Puedes revisar el avance del caso."
                    : "Sin pendientes HITL activas. Puedes revisar avance con el agente."}
          </p>
          <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
            {transitionSummary}
            {" · "}
            Paso operativo actual:{" "}
            <span className="font-semibold text-neutral-800 dark:text-neutral-100">
              {operationalStepDisplay}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasBlocking ? (
            <a
              href={pendientesDeepLink({ caseId })}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-amber-300 bg-white px-2 py-1 font-semibold text-amber-900 hover:bg-amber-100"
            >
                    Abrir pendientes del caso
            </a>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || cleanupLoading}
            className={`rounded border px-2 py-1 font-semibold disabled:opacity-60 ${
              hasBlocking
                ? "border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                : "border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100"
            }`}
          >
            {refreshing ? "Actualizando..." : "Refrescar caso"}
          </button>
          {hasHistorical && !realCaseMode ? (
            <>
              <label className="sr-only" htmlFor={`lab-cleanup-target-${caseId}`}>
                Qué limpiar del historial
              </label>
              <select
                id={`lab-cleanup-target-${caseId}`}
                value={cleanupTarget}
                onChange={(event) => {
                  setCleanupTarget(event.target.value as SettingsTestCleanupTarget);
                  setCleanupStatus(null);
                }}
                disabled={cleanupLoading || refreshing}
                className="rounded border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-800 disabled:opacity-60"
              >
                <option value="all">
                  {cleanupTargetLabel("all", historicalCounts)}
                </option>
                <option value="notifications">
                  {cleanupTargetLabel("notifications", historicalCounts)}
                </option>
                <option value="tool_calls">
                  {cleanupTargetLabel("tool_calls", historicalCounts)}
                </option>
              </select>
              <button
                type="button"
                onClick={() => void cleanupCaseHistory()}
                disabled={cleanupLoading || refreshing}
                className="rounded border border-rose-200 bg-white px-2 py-1 font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              >
                {cleanupLoading ? "Limpiando..." : "Limpiar historial"}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {hasBlocking ? (
        <p className="mt-1 text-[11px] text-amber-700">
          Refrescar caso actualiza el estado tras resolver la acción en Pendientes
          o Telegram.
        </p>
      ) : null}
      {hasHistorical && !realCaseMode ? (
        <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
          Limpiar historial: las notificaciones se eliminan; las aprobaciones del
          agente se marcan como rechazadas. No se tocan acciones bloqueantes activas.
        </p>
      ) : null}
      {!hasHistorical && !hasBlocking ? (
        <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
          {realCaseMode
            ? "Sin acciones HITL activas en este caso real. El panel seguirá mostrando nuevos bloqueos cuando aparezcan."
            : conversationalMode
            ? intakeIncomplete
              ? "Responde en Telegram los campos pendientes. El panel se actualiza automáticamente mientras completas el Paso 0."
              : "Cuando el intake esté completo, ejecuta transiciones manuales una por una para avanzar el flujo operativo."
            : "Para empezar un recorrido limpio del laboratorio: Regenerar y validar registro en Preparar caso de prueba, luego ejecuta transiciones una por una."}
        </p>
      ) : null}
      {cleanupStatus ? (
        <p
          className={`mt-1 text-[11px] ${
            hasBlocking ? "text-amber-700" : "text-neutral-600 dark:text-neutral-300"
          }`}
        >
          {cleanupStatus}
        </p>
      ) : null}
      <TestCaseAuditPanel
        events={events}
        toolCalls={toolCalls}
        e2eStartEvents={e2eStartEvents}
        playthroughAnchorAt={playthroughAnchorAt}
        transitionCount={transitionCount}
        operationalStepLabels={operationalStepLabels}
        conversationalMode={conversationalMode}
        realCaseMode={realCaseMode}
        variant="embedded"
      />
      {hasBlocking ? (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            Requiere acción ahora
          </p>
          <ul className="mt-1 space-y-1.5">
            {blockingActions.map((action) => (
              <LabPendingActionItem
                key={action.id}
                action={action}
                caseId={caseId}
                showTelegramHint
                operationalStepLabels={operationalStepLabels}
                realCaseMode={realCaseMode}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {hasHistorical ? (
        <LabCaseHistoryDetails
          historicalActions={historicalActions}
          caseId={caseId}
          operationalStepLabels={operationalStepLabels}
          realCaseMode={realCaseMode}
          summaryToneClass={
            hasBlocking
              ? "text-amber-800"
              : "text-neutral-700 dark:text-neutral-200"
          }
        />
      ) : null}
    </div>
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function controlledTestAuditSummary(event: OperationalCaseEvent): string {
  const payload = event.payload_jsonb ?? {};
  const kind = typeof payload.kind === "string" ? payload.kind : event.event_type;
  const stepKey =
    typeof payload.step_key === "string" ? payload.step_key : null;
  const skillSlug =
    typeof payload.skill_slug === "string" ? payload.skill_slug : null;
  const scenarioId =
    typeof payload.scenario_id === "string" ? payload.scenario_id : null;
  const status =
    typeof payload.status === "string" ? payload.status : null;
  const durationMs =
    typeof payload.duration_ms === "number" ? payload.duration_ms : null;

  if (kind === "step_test_started") {
    return `Inicio prueba de paso · ${stepKey ?? "paso"}${scenarioId ? ` · ${scenarioId}` : ""}`;
  }
  if (kind === "step_test_completed") {
    const outcome =
      status === "tested_ok"
        ? "OK"
        : status === "tested_failed"
          ? "Falló"
          : (status ?? "completada");
    const dur =
      durationMs != null ? ` · ${formatDurationMs(durationMs)}` : "";
    return `Prueba de paso · ${stepKey ?? "paso"} · ${outcome}${dur}`;
  }
  if (kind === "skill_test_started") {
    return `Inicio prueba de habilidad · ${skillSlug ?? stepKey ?? "habilidad"}`;
  }
  if (kind === "skill_test_completed") {
    const outcome =
      status === "tested_ok"
        ? "OK"
        : status === "tested_failed"
          ? "Falló"
          : (status ?? "completada");
    return `Prueba de habilidad · ${skillSlug ?? stepKey ?? "habilidad"} · ${outcome}`;
  }
  if (kind === "controlled_test_e2e_started") {
    return "Transición con agente iniciada";
  }
  return `${kind} · ${event.actor}`;
}

function TestCaseAuditPanel({
  events,
  toolCalls,
  e2eStartEvents = [],
  playthroughAnchorAt,
  transitionCount,
  operationalStepLabels,
  conversationalMode = false,
  realCaseMode = false,
  variant = "standalone",
}: {
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  e2eStartEvents?: OperationalCaseEvent[];
  playthroughAnchorAt?: string | null;
  transitionCount?: number;
  operationalStepLabels?: OperationalStepLabelMap;
  conversationalMode?: boolean;
  realCaseMode?: boolean;
  variant?: "standalone" | "embedded";
}) {
  const transitionGroups = useMemo(
    () =>
      buildE2ETransitionGroups({
        events,
        toolCalls,
        anchorAt: playthroughAnchorAt ?? null,
        e2eStartEvents,
        stepLabels: operationalStepLabels,
      }),
    [events, toolCalls, playthroughAnchorAt, e2eStartEvents, operationalStepLabels]
  );

  const isEmbedded = variant === "embedded";
  if (realCaseMode && transitionGroups.length === 0) {
    return null;
  }

  return (
    <details
      className={`mt-3 ${
        isEmbedded
          ? "rounded border border-neutral-200 bg-white/70 dark:border-neutral-700 dark:bg-neutral-950/40"
          : "rounded-xl border border-neutral-200 dark:border-neutral-800"
      } p-2 text-sm`}
    >
      <summary className="cursor-pointer list-none marker:content-none text-[11px] font-semibold text-violet-800 [&::-webkit-details-marker]:hidden dark:text-violet-200">
        {realCaseMode ? "Auditoría de caso" : "Auditoría técnica del caso"}
        {transitionGroups.length > 0
          ? ` · ${transitionGroups.length} transición${transitionGroups.length === 1 ? "" : "es"}`
          : ""}
      </summary>
      <p className="mt-2 text-[11px] text-neutral-500">
        Actividad agrupada por cada revisión manual del runner
        {conversationalMode
          ? " en este recorrido conversacional E2E."
          : playthroughAnchorAt
            ? " en el recorrido actual (desde Regenerar y validar registro)."
            : " de todo el caso de prueba."}
      </p>
      {!conversationalMode && !playthroughAnchorAt ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          Para un recorrido limpio y contador alineado: Regenerar y validar
          registro en Preparar caso de prueba.
        </p>
      ) : null}
      {typeof transitionCount === "number" &&
      transitionCount > transitionGroups.length &&
      transitionGroups.length > 0 ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          El contador registra {transitionCount} transición
          {transitionCount === 1 ? "" : "es"}; aquí se muestran{" "}
          {transitionGroups.length} (puede faltar historial si supera el límite de
          eventos cargados).
        </p>
      ) : null}

      {transitionGroups.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {[...transitionGroups].reverse().map((group) => (
            <li
              key={`transition-${group.index}-${group.startedAt}`}
              className="rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
            >
              <details className="group" open={group.index === transitionGroups.length}>
                <summary className="cursor-pointer px-2 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-100">
                  Transición {group.index}
                  {group.stepLabel ? ` · ${group.stepLabel}` : ""}
                  <span className="ml-2 font-normal text-neutral-500">
                    {formatDateTime(group.startedAt)}
                  </span>
                  <span className="ml-2 font-normal text-neutral-400">
                    ({group.events.length} evento
                    {group.events.length === 1 ? "" : "s"},{" "}
                    {group.toolCalls.length} tool
                    {group.toolCalls.length === 1 ? "" : "s"})
                  </span>
                </summary>
                <div className="border-t border-neutral-100 px-2 py-2 dark:border-neutral-800">
                  {group.events.length > 0 ? (
                    <ul className="space-y-1">
                      {group.events.map((event) => (
                        <li key={event.id}>
                          <details className="rounded border border-neutral-100 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-950/50">
                            <summary className="cursor-pointer px-2 py-1 text-[11px]">
                              <span className="font-medium text-neutral-800 dark:text-neutral-100">
                                {controlledTestAuditSummary(event)}
                              </span>
                              <span className="ml-2 text-neutral-500">
                                {formatDateTime(event.created_at)}
                              </span>
                            </summary>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap border-t border-neutral-100 px-2 py-1 font-mono text-[10px] text-neutral-600 dark:border-neutral-800">
                              {JSON.stringify(event.payload_jsonb, null, 2)}
                            </pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-neutral-500">Sin eventos en esta transición.</p>
                  )}
                  {group.toolCalls.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {group.toolCalls.map((call) => (
                        <li
                          key={call.id}
                          className={`flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1 text-[11px] ${
                            call.status === "pending_confirmation"
                              ? "border-amber-200 bg-amber-50 text-amber-900"
                              : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                          }`}
                        >
                          <span className="font-mono text-neutral-800 dark:text-neutral-100">
                            {call.tool_name}
                          </span>
                          <span className="text-neutral-500">
                            {toolCallStatusLabel(call.status)}
                            {" · "}
                            {formatDateTime(call.created_at)}
                            {toolCallFailureDetail(call)
                              ? ` · ${toolCallFailureDetail(call)}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">
          {playthroughAnchorAt
            ? "Aún no hay revisiones manuales en este recorrido. Ejecuta la primera revisión de avance."
            : "Sin revisiones manuales del runner registradas."}
        </p>
      )}
    </details>
  );
}

function activationStatusBadge(
  status: "ready" | "pending" | "attention",
  label: string
) {
  const className =
    status === "ready"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "attention"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-neutral-200 bg-neutral-50 text-neutral-600";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function serializeEditingSnapshot(snapshot: EditingSnapshot | null) {
  if (!snapshot) return "";
  return JSON.stringify({
    editing: snapshot.editing,
    schemaText: snapshot.schemaText,
    flowText: snapshot.flowText,
    activationPolicyText: snapshot.activationPolicyText,
    procedureText: snapshot.procedureText,
    fieldListText: snapshot.fieldListText,
    createPrivateSkill: snapshot.createPrivateSkill,
    generatedSkillBody: snapshot.generatedSkillBody,
  });
}

export function OperationalCaseTypesClient({
  initialCaseTypes,
  initialOperationalCases,
  initialLatestEventsByCaseId,
  initialSkillSummaries,
}: {
  initialCaseTypes: OperationalCaseType[];
  initialOperationalCases: OperationalCase[];
  initialLatestEventsByCaseId: Record<string, OperationalCaseEvent>;
  initialSkillSummaries: SkillSummary[];
}) {
  const [caseTypes, setCaseTypes] =
    useState<OperationalCaseType[]>(initialCaseTypes);
  const [selectedCaseType, setSelectedCaseType] =
    useState<OperationalCaseType | null>(initialCaseTypes[0] ?? null);
  const [activeTab, setActiveTab] =
    useState<CaseTypeWorkspaceTab>("summary");
  const [editing, setEditing] = useState<EditingCaseType | null>(null);
  const [schemaText, setSchemaText] = useState("");
  const [flowText, setFlowText] = useState("");
  const [activationPolicyText, setActivationPolicyText] = useState("");
  const [procedureText, setProcedureText] = useState("");
  const [fieldListText, setFieldListText] = useState("");
  const [createPrivateSkill, setCreatePrivateSkill] = useState(true);
  const [generatedSkillBody, setGeneratedSkillBody] = useState("");
  const [accountSkills, setAccountSkills] = useState<AccountSkill[]>([]);
  const [authoringResult, setAuthoringResult] =
    useState<SkillAuthoringResult | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [authoringStartedAt, setAuthoringStartedAt] = useState<number | null>(
    null
  );
  const [authoringElapsedMs, setAuthoringElapsedMs] = useState(0);
  const [authoringProgress, setAuthoringProgress] = useState<
    AuthoringProgressEvent[]
  >([]);
  const [showAuthoringLog, setShowAuthoringLog] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [toolReadiness, setToolReadiness] =
    useState<ToolReadinessResult | null>(null);
  const [toolReadinessError, setToolReadinessError] = useState<string | null>(
    null
  );
  const [expandedReadinessTools, setExpandedReadinessTools] = useState<
    Set<string>
  >(new Set());
  const [openReadinessSteps, setOpenReadinessSteps] = useState<Set<string>>(
    new Set()
  );
  const readinessToggleSuppressUntilRef = useRef(0);
  const [toolRequests, setToolRequests] = useState<ToolReadinessRequestRecord[]>(
    []
  );
  const [toolRequestSubmitting, setToolRequestSubmitting] = useState<
    string | null
  >(null);
  const [toolRequestError, setToolRequestError] = useState<string | null>(null);
  const [toolReadinessLoading, setToolReadinessLoading] = useState(false);
  const [testCaseResult, setTestCaseResult] =
    useState<OperationalCaseTestResult | null>(null);
  const [conversationalLabResult, setConversationalLabResult] =
    useState<OperationalCaseTestResult | null>(null);
  const [conversationalLabLoading, setConversationalLabLoading] = useState(false);
  const [e2eLabModeLoading, setE2ELabModeLoading] = useState(false);
  const [abandoningConversationalCase, setAbandoningConversationalCase] =
    useState(false);
  const [activeConversationalCaseId, setActiveConversationalCaseId] =
    useState<string | null>(() => observedCaseIdFromUrl());
  const [conversationalObservationUnpinned, setConversationalObservationUnpinned] =
    useState(false);
  const conversationalObservationUnpinnedRef = useRef(false);
  // Armed only by "Abandonar recorrido" (not by manual deselect): when the next
  // active conversational case appears after an abandon, the lab re-pins to it
  // automatically (one-shot) so observation follows the fresh case.
  const rePinOnNextConversationalCaseRef = useRef(false);
  const abandonedConversationalCaseIdRef = useRef<string | null>(null);
  const conversationalObservationUnpinnedAtRef = useRef(
    observedCaseIdFromUrl() ? 0 : Date.now()
  );
  const [testCaseLoading, setTestCaseLoading] = useState(false);
  const [testCaseRunningMode, setTestCaseRunningMode] = useState<
    "safe_check" | "agent_e2e" | null
  >(null);
  const testCaseRunLockRef = useRef(false);
  const testCaseRunning = testCaseRunningMode !== null;
  const [testContextDraft, setTestContextDraft] = useState<TestContextDraft>({});
  const [testContextSaving, setTestContextSaving] = useState(false);
  const [testContextMessage, setTestContextMessage] = useState<string | null>(null);
  const [conversationalLabMessage, setConversationalLabMessage] =
    useState<string | null>(null);
  const [testContextVersion, setTestContextVersion] = useState(0);
  const [easyBrokerCreatedListingId, setEasyBrokerCreatedListingId] =
    useState<string | null>(null);
  const [editingBaseline, setEditingBaseline] =
    useState<EditingSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authoringRequestSeq = useRef(0);
  const authoringAbortRef = useRef<AbortController | null>(null);
  const authoringLogRef = useRef<HTMLUListElement | null>(null);
  const editorPanelRef = useRef<HTMLElement | null>(null);
  const readinessFlowScrollRef = useRef<HTMLDivElement | null>(null);
  const readinessScrollLockRef = useRef<{
    position: PageScrollPosition;
    until: number;
  } | null>(null);

  const sortedCaseTypes = useMemo(
    () =>
      [...caseTypes].sort((a, b) => {
        const aGlobal = scopeLabel(a) === "global" ? 1 : 0;
        const bGlobal = scopeLabel(b) === "global" ? 1 : 0;
        return aGlobal - bGlobal || a.display_name.localeCompare(b.display_name);
      }),
    [caseTypes]
  );
  const relatedOperationalCases = useMemo(() => {
    if (!selectedCaseType) return [];
    const fromPage = initialOperationalCases.filter(
      (opCase) =>
        opCase.case_type_id === selectedCaseType.id ||
        opCase.case_type === selectedCaseType.case_type
    );
    const byId = new Map(fromPage.map((opCase) => [opCase.id, opCase]));
    const upsertIfNewer = (candidate: OperationalCase | null | undefined) => {
      if (!candidate) return;
      if (
        candidate.case_type_id !== selectedCaseType.id &&
        candidate.case_type !== selectedCaseType.case_type
      ) {
        return;
      }
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, candidate);
        return;
      }
      const candidateUpdated = new Date(candidate.updated_at).getTime();
      const existingUpdated = new Date(existing.updated_at).getTime();
      if (!Number.isFinite(existingUpdated) || candidateUpdated >= existingUpdated) {
        byId.set(candidate.id, candidate);
      }
    };
    const testCase = testCaseResult?.case;
    const conversationalCase = conversationalLabResult?.case;
    upsertIfNewer(testCase);
    upsertIfNewer(conversationalCase);
    return Array.from(byId.values());
  }, [
    conversationalLabResult?.case,
    initialOperationalCases,
    selectedCaseType,
    testCaseResult?.case,
  ]);
  const conversationalOperationalCase = useMemo(
    () => pickActiveConversationalCase(relatedOperationalCases),
    [relatedOperationalCases]
  );
  const observableConversationalCases = useMemo(
    () =>
      relatedOperationalCases
        .filter(
          (opCase) =>
            opCase.context_jsonb?.created_from === "agent_conversation" &&
            !["completed", "failed"].includes(opCase.status)
        )
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        ),
    [relatedOperationalCases]
  );
  const pausedConversationalCase = useMemo(
    () =>
      relatedOperationalCases
        .filter(
          (opCase) =>
            opCase.context_jsonb?.created_from === "agent_conversation" &&
            opCase.status === "paused"
        )
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )[0] ?? null,
    [relatedOperationalCases]
  );
  useEffect(() => {
    conversationalObservationUnpinnedRef.current =
      conversationalObservationUnpinned;
  }, [conversationalObservationUnpinned]);
  useEffect(() => {
    if (conversationalObservationUnpinned) return;
    const availableIds = new Set(observableConversationalCases.map((opCase) => opCase.id));
    setActiveConversationalCaseId((prev) => {
      if (prev && availableIds.has(prev)) return prev;
      const fromUrl = observedCaseIdFromUrl();
      if (fromUrl && availableIds.has(fromUrl)) return fromUrl;
      return conversationalOperationalCase?.id ?? null;
    });
  }, [
    observableConversationalCases,
    conversationalOperationalCase?.id,
    conversationalObservationUnpinned,
  ]);
  const skillMap = useMemo(
    () => new Map(initialSkillSummaries.map((skill) => [skill.slug, skill])),
    [initialSkillSummaries]
  );
  const accountSkillMap = useMemo(
    () => new Map(accountSkills.map((skill) => [skill.slug, skill])),
    [accountSkills]
  );
  const authoringHasFail = authoringHasStatus(authoringResult, "FAIL");
  const authoringHasWarn = authoringHasStatus(authoringResult, "WARN");
  const saveBlockedByAuthoring =
    createPrivateSkill && generatedSkillBody.trim().length > 0 && authoringHasFail;
  const selectedSavedSkillBody = selectedCaseType
    ? accountSkillMap.get(selectedCaseType.default_skill_slug)?.body_md ?? ""
    : "";
  const selectedIsPrivate =
    selectedCaseType !== null && scopeLabel(selectedCaseType) !== "global";
  const selectedIsActive = (selectedCaseType?.status ?? "active") === "active";
  const skillLooksValid =
    (generatedSkillBody.trim().length > 0 ||
      selectedSavedSkillBody.trim().length > 0) &&
    !authoringHasFail &&
    (!authoringResult || !authoringHasWarn);
  const readinessCounts = toolReadinessCounts(toolReadiness);
  const toolsPass =
    Boolean(toolReadiness) && readinessCounts.blocking === 0;
  const toolsHaveBlocks = readinessCounts.blocking > 0;
  const shouldReviewTools = selectedIsPrivate && !toolReadiness && !toolReadinessLoading;
  const canManageTestCase =
    selectedIsPrivate && selectedIsActive && Boolean(toolReadiness);
  const canCreateTestCase = canManageTestCase && !toolsHaveBlocks;
  const refreshedConversationalCase =
    conversationalObservationUnpinned && !activeConversationalCaseId
      ? null
      : conversationalLabResult?.case?.context_jsonb?.created_from ===
            "agent_conversation" && conversationalLabResult.case.status !== "paused"
        ? conversationalLabResult.case
        : null;
  const selectedObservedCase = useMemo(() => {
    if (activeConversationalCaseId) {
      // Resolve strictly to the selected case. We intentionally do NOT fall
      // back to the auto-picked (most recent) case here: doing so created a
      // feedback loop where any transient miss snapped the panel back to the
      // recent case.
      return (
        observableConversationalCases.find(
          (opCase) => opCase.id === activeConversationalCaseId
        ) ??
        (refreshedConversationalCase?.id === activeConversationalCaseId
          ? refreshedConversationalCase
          : null)
      );
    }
    if (conversationalObservationUnpinned) return null;
    return conversationalOperationalCase;
  }, [
    activeConversationalCaseId,
    conversationalObservationUnpinned,
    observableConversationalCases,
    refreshedConversationalCase,
    conversationalOperationalCase,
  ]);
  // When a case is selected (pinned), the panel always follows that case. The
  // refreshed network result only feeds derived data when it matches.
  const conversationalResultCase = activeConversationalCaseId
    ? selectedObservedCase
    : conversationalObservationUnpinned
      ? null
      : (refreshedConversationalCase ?? selectedObservedCase);
  const refreshedMatchesObservedCase = Boolean(
    refreshedConversationalCase &&
      (!activeConversationalCaseId ||
        refreshedConversationalCase.id === activeConversationalCaseId)
  );
  const blockingLabActions = refreshedMatchesObservedCase
    ? (conversationalLabResult?.blockingActions ?? [])
    : [];
  const historicalLabActions = refreshedMatchesObservedCase
    ? (conversationalLabResult?.historicalActions ?? [])
    : [];
  const hasPendingLabActions = blockingLabActions.length > 0;
  const transitionCount = refreshedMatchesObservedCase
    ? (conversationalLabResult?.transitionCount ?? 0)
    : 0;
  const agentTestCase = conversationalResultCase;
  const conversationalPollingMs = useMemo(() => {
    const e2eLabModeActive = Boolean(conversationalLabResult?.e2eLabSession);
    if (!agentTestCase) return e2eLabModeActive ? 15_000 : 30_000;
    const highActivityStep = [
      "intake",
      "awaiting_documents",
      "documents_received",
      "property_data_review",
    ].includes(agentTestCase.current_step ?? "");
    const highActivityStatus = ["active", "waiting_internal", "waiting_external"].includes(
      agentTestCase.status
    );
    if (e2eLabModeActive && (highActivityStep || highActivityStatus)) return 5_000;
    return 15_000;
  }, [agentTestCase, conversationalLabResult?.e2eLabSession]);
  const testStatus = agentTestCase?.context_jsonb?.controlled_test_status;
  const e2eControlStatus =
    agentTestCase?.context_jsonb?.e2e_control_status;
  const e2eWaitingExternal = e2eControlStatus === "waiting_external";
  const e2eBlockedPendingExtraction =
    e2eControlStatus === "blocked_pending_extraction";
  const e2eExtractionEscalatedToHuman =
    e2eControlStatus === "extraction_escalated_to_human";
  const extractionRemediationAttemptsLabel = (() => {
    const raw = agentTestCase?.context_jsonb?.extraction_remediation_attempts;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const counts = Object.values(raw as Record<string, unknown>).filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
    if (counts.length === 0) return null;
    const maxAttempts = Math.max(...counts);
    return `intento ${Math.min(maxAttempts, 3)}/3`;
  })();
  const testPassed =
    testStatus === "passed_safe_checks" ||
    testStatus === "e2e_tick_completed" ||
    testStatus === "e2e_pending_hitl" ||
    e2eControlStatus === "manual_tick_completed" ||
    e2eControlStatus === "pending_hitl" ||
    e2eWaitingExternal ||
    e2eBlockedPendingExtraction ||
    e2eExtractionEscalatedToHuman;
  const e2ePendingHitl =
    testStatus === "e2e_pending_hitl" || e2eControlStatus === "pending_hitl";
  const e2eCompleted =
    testStatus === "e2e_tick_completed" ||
    testStatus === "e2e_pending_hitl" ||
    e2eControlStatus === "manual_tick_completed" ||
    e2eControlStatus === "pending_hitl";
  // E2E enabled only when ALL tools are technically ready (sin stubs ni
  // missing/unknown). Bloqueos los cubre toolsPass; los stubs ejecutarían
  // respuestas vacías y romperían el tick real.
  const canRunE2E =
    canManageTestCase &&
    Boolean(agentTestCase) &&
    readinessCounts.stub === 0 &&
    readinessCounts.missing === 0 &&
    readinessCounts.unknown === 0 &&
    readinessCounts.needs_config === 0;
  const testContextFields = useMemo(
    () =>
      selectedCaseType && Array.isArray(selectedCaseType.intake_schema_jsonb)
        ? selectedCaseType.intake_schema_jsonb
        : [],
    [selectedCaseType]
  );
  const currentEditingSnapshot = editing
    ? {
        editing,
        schemaText,
        flowText,
        activationPolicyText,
        procedureText,
        fieldListText,
        createPrivateSkill,
        generatedSkillBody,
      }
    : null;
  const editingHasChanges =
    Boolean(editing?.isNew) ||
    serializeEditingSnapshot(currentEditingSnapshot) !==
      serializeEditingSnapshot(editingBaseline);

  useEffect(() => {
    if (!authoring || !authoringStartedAt) return undefined;
    setAuthoringElapsedMs(Date.now() - authoringStartedAt);
    const timer = window.setInterval(() => {
      setAuthoringElapsedMs(Date.now() - authoringStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [authoring, authoringStartedAt]);

  useEffect(() => {
    if (!showAuthoringLog) return;
    const element = authoringLogRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [authoringProgress, showAuthoringLog]);

  function replaceWorkspaceUrl(
    row: OperationalCaseType | null,
    tab: CaseTypeWorkspaceTab
  ) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (row) {
      url.searchParams.set("type", row.id);
    } else {
      url.searchParams.delete("type");
    }
    if (tab === "summary") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tab);
    }
    if (
      row &&
      tab === "lab" &&
      activeConversationalCaseId &&
      activeConversationalCaseId.trim().length > 0
    ) {
      url.searchParams.set("observe_case", activeConversationalCaseId);
    } else {
      url.searchParams.delete("observe_case");
    }
    window.history.replaceState(window.history.state, "", url);
  }

  function syncWorkspaceFromUrl() {
    const nextCaseType = caseTypeFromUrl(caseTypes);
    const nextTab = tabFromUrl();
    const nextObservedCaseId = observedCaseIdFromUrl();
    setActiveConversationalCaseId((current) => {
      const normalized = nextObservedCaseId ?? null;
      return current === normalized ? current : normalized;
    });
    setConversationalObservationUnpinned(!nextObservedCaseId);
    if (!nextObservedCaseId) {
      conversationalObservationUnpinnedAtRef.current = Date.now();
    }
    if (nextCaseType && nextCaseType.id !== selectedCaseType?.id) {
      viewCaseType(nextCaseType, nextTab ?? "summary", {
        updateUrl: false,
      });
      return;
    }
    if (nextTab && nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }

  useEffect(() => {
    syncWorkspaceFromUrl();
    const handleNavigationRestore = () => {
      readinessScrollLockRef.current = null;
      syncWorkspaceFromUrl();
      if (selectedCaseType && scopeLabel(selectedCaseType) !== "global") {
        void refreshToolReadiness(selectedCaseType);
        void refreshTestCase(selectedCaseType);
        void refreshConversationalCase(selectedCaseType);
      }
    };
    window.addEventListener("pageshow", handleNavigationRestore);
    window.addEventListener("popstate", handleNavigationRestore);
    return () => {
      window.removeEventListener("pageshow", handleNavigationRestore);
      window.removeEventListener("popstate", handleNavigationRestore);
    };
  }, [caseTypes, selectedCaseType, activeTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeTab !== "lab" || !selectedCaseType) return;
    const url = new URL(window.location.href);
    if (activeConversationalCaseId) {
      url.searchParams.set("observe_case", activeConversationalCaseId);
    } else {
      url.searchParams.delete("observe_case");
    }
    window.history.replaceState(window.history.state, "", url);
  }, [activeTab, selectedCaseType?.id, activeConversationalCaseId]);

  useEffect(() => {
    if (
      activeTab !== "lab" ||
      !selectedCaseType ||
      scopeLabel(selectedCaseType) === "global" ||
      toolReadiness ||
      toolReadinessLoading ||
      toolReadinessError
    ) {
      return;
    }
    void refreshToolReadiness(selectedCaseType);
  }, [
    activeTab,
    selectedCaseType,
    toolReadiness,
    toolReadinessLoading,
    toolReadinessError,
  ]);

  useEffect(() => {
    if (
      activeTab !== "lab" ||
      !selectedCaseType ||
      scopeLabel(selectedCaseType) === "global"
    ) {
      return;
    }
    void refreshE2ELabMode(selectedCaseType);
  }, [activeTab, selectedCaseType?.id]);

  useEffect(() => {
    if (
      activeTab !== "lab" ||
      !selectedCaseType ||
      scopeLabel(selectedCaseType) === "global"
    ) {
      return;
    }
    if (!testCaseResult && !testCaseLoading) {
      void refreshTestCase(selectedCaseType);
    }
    if (!conversationalLabResult && !conversationalLabLoading) {
      void refreshConversationalCase(selectedCaseType);
    }
  }, [
    activeTab,
    conversationalLabResult,
    conversationalLabLoading,
    selectedCaseType,
    testCaseResult,
    testCaseLoading,
  ]);

  useEffect(() => {
    if (
      activeTab !== "lab" ||
      !selectedCaseType ||
      scopeLabel(selectedCaseType) === "global"
    ) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshConversationalCase(selectedCaseType, {
        silent: true,
        caseId: activeConversationalCaseId ?? undefined,
      });
    }, conversationalPollingMs);
    return () => window.clearInterval(intervalId);
  }, [activeTab, conversationalPollingMs, selectedCaseType, activeConversationalCaseId]);

  useEffect(() => {
    if (
      activeTab !== "lab" ||
      !selectedCaseType ||
      scopeLabel(selectedCaseType) === "global" ||
      !activeConversationalCaseId
    ) {
      return;
    }
    // Sync the network result to the *selected* case id, never to the derived
    // display case. Keying off a derived value let the recent case win.
    if (conversationalLabResult?.case?.id === activeConversationalCaseId) {
      return;
    }
    void refreshConversationalCase(selectedCaseType, {
      caseId: activeConversationalCaseId,
      silent: true,
    });
  }, [
    activeTab,
    activeConversationalCaseId,
    conversationalLabResult?.case?.id,
    selectedCaseType,
  ]);

  function lockPageScrollForReadiness(ms: number) {
    readinessScrollLockRef.current = {
      position: capturePageScroll(readinessFlowScrollRef.current),
      until: performance.now() + ms,
    };
  }

  useLayoutEffect(() => {
    const lock = readinessScrollLockRef.current;
    if (!lock || performance.now() > lock.until) return;
    restorePageScroll(lock.position, readinessFlowScrollRef.current);
  });

  useEffect(() => {
    const lock = readinessScrollLockRef.current;
    if (!lock) return;
    let frame = 0;
    const tick = () => {
      const current = readinessScrollLockRef.current;
      if (!current || performance.now() > current.until) {
        readinessScrollLockRef.current = null;
        return;
      }
      restorePageScroll(current.position, readinessFlowScrollRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [expandedReadinessTools]);

  useEffect(() => {
    const onPageShow = () => {
      readinessScrollLockRef.current = null;
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshCaseTypes() {
      try {
        const [caseTypesRes, accountSkillsRes] = await Promise.all([
          fetch("/api/operational-case-types", {
            cache: "no-store",
          }),
          fetch("/api/account-skills", {
            cache: "no-store",
          }),
        ]);
        const caseTypesData = (await caseTypesRes.json()) as
          | { ok: true; caseTypes: OperationalCaseType[] }
          | { error: string };
        const accountSkillsData = (await accountSkillsRes.json()) as
          | { ok: true; skills: AccountSkill[] }
          | { error: string };
        if (cancelled) return;
        if (caseTypesRes.ok && "ok" in caseTypesData) {
          setCaseTypes(caseTypesData.caseTypes);
        }
        if (accountSkillsRes.ok && "ok" in accountSkillsData) {
          setAccountSkills(accountSkillsData.skills);
        }
        setSelectedCaseType((current) => {
          if (!current) return current;
          return caseTypesRes.ok && "ok" in caseTypesData
            ? caseTypesData.caseTypes.find((row) => row.id === current.id) ?? null
            : current;
        });
      } catch (err) {
        console.warn("[operational-case-types] refresh failed:", err);
      }
    }
    void refreshCaseTypes();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const opCase = testCaseResult?.case;
    if (!opCase || testContextFields.length === 0) {
      setTestContextDraft({});
      setTestContextMessage(null);
      return;
    }
    const next: TestContextDraft = {};
    for (const field of testContextFields) {
      next[field.name] = draftValue(opCase.context_jsonb?.[field.name]);
    }
    setTestContextDraft(next);
    setTestContextMessage(null);
  }, [testCaseResult?.case, testContextFields]);

  async function loadAccountSkillsFromApi() {
    const res = await fetch("/api/account-skills", { cache: "no-store" });
    const data = (await res.json()) as
      | { ok: true; skills: AccountSkill[] }
      | { error: string };
    if (!res.ok || !("ok" in data)) return [];
    setAccountSkills(data.skills);
    return data.skills;
  }

  function effectiveOperationalFlowForRow(row: OperationalCaseType) {
    const ownFlow = Array.isArray(row.operational_flow_jsonb)
      ? row.operational_flow_jsonb
      : [];
    if (ownFlow.length > 0 || scopeLabel(row) === "global") return ownFlow;
    const globalCounterpart = caseTypes.find(
      (candidate) =>
        candidate.case_type === row.case_type && scopeLabel(candidate) === "global"
    );
    return Array.isArray(globalCounterpart?.operational_flow_jsonb)
      ? globalCounterpart.operational_flow_jsonb
      : [];
  }

  function effectiveActivationPolicyForRow(row: OperationalCaseType) {
    if (row.activation_policy_jsonb) {
      return mergeActivationPolicy(row.activation_policy_jsonb);
    }
    if (scopeLabel(row) === "global") return mergeActivationPolicy(null);
    const globalCounterpart = caseTypes.find(
      (candidate) =>
        candidate.case_type === row.case_type && scopeLabel(candidate) === "global"
    );
    return mergeActivationPolicy(globalCounterpart?.activation_policy_jsonb);
  }

  async function refreshToolReadiness(
    row: OperationalCaseType,
    options?: { silent?: boolean }
  ) {
    if (scopeLabel(row) === "global") {
      setToolReadiness(null);
      setToolReadinessError(null);
      setExpandedReadinessTools(new Set());
      setOpenReadinessSteps(new Set());
      setToolRequests([]);
      setToolRequestError(null);
      setToolRequestSubmitting(null);
      return;
    }
    const scrollPosition = capturePageScroll(readinessFlowScrollRef.current);
    if (!options?.silent) {
      setToolReadinessLoading(true);
    }
    setToolReadinessError(null);
    // Mantener paneles expandidos (p. ej. prueba individual en curso).
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    try {
      const res = await fetch(
        `/api/tool-readiness?case_type_id=${encodeURIComponent(row.id)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | ({ ok: true } & ToolReadinessResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolReadiness(null);
        setToolReadinessError(
          "error" in data ? data.error : "No se pudo revisar la preparación operativa."
        );
        return;
      }
      setToolReadiness({
        summary: data.summary,
        case_e2e_status: data.case_e2e_status,
        skill: data.skill,
        tools: data.tools,
        flow: data.flow,
        flow_preparation: data.flow_preparation,
        flow_operational: data.flow_operational,
      });
      void refreshToolRequests(row);
    } catch (err) {
      console.warn("[operational-case-types] tool readiness failed:", err);
      setToolReadiness(null);
      setToolReadinessError((err as Error).message ?? String(err));
    } finally {
      if (!options?.silent) {
        setToolReadinessLoading(false);
      }
      restorePageScrollAfterLayout(
        scrollPosition,
        readinessFlowScrollRef.current
      );
    }
  }

  function preserveReadinessUiContext(params: {
    expansionKey?: string;
    flowStepKey?: string;
    suppressToggleMs?: number;
    lockScrollMs?: number;
  }) {
    if (params.suppressToggleMs) {
      readinessToggleSuppressUntilRef.current =
        performance.now() + params.suppressToggleMs;
    }
    if (params.lockScrollMs) {
      lockPageScrollForReadiness(params.lockScrollMs);
    }
    if (params.expansionKey) {
      setExpandedReadinessTools((prev) => {
        const next = new Set(prev);
        next.add(params.expansionKey!);
        return next;
      });
    }
    if (params.flowStepKey) {
      setOpenReadinessSteps((prev) => {
        const next = new Set(prev);
        next.add(params.flowStepKey!);
        return next;
      });
    }
  }

  function toggleReadinessToolExpand(expansionKey: string) {
    if (performance.now() < readinessToggleSuppressUntilRef.current) {
      return;
    }
    const isClosing = expandedReadinessTools.has(expansionKey);
    lockPageScrollForReadiness(isClosing ? 550 : 950);
    setExpandedReadinessTools((prev) => {
      const next = new Set(prev);
      if (next.has(expansionKey)) next.delete(expansionKey);
      else next.add(expansionKey);
      return next;
    });
  }

  async function refreshToolRequests(row: OperationalCaseType) {
    try {
      const res = await fetch(
        `/api/global-tool-requests?case_type_id=${encodeURIComponent(row.id)}&status=requested,in_review,in_progress`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | { ok: true; requests: ToolReadinessRequestRecord[] }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolRequests([]);
        return;
      }
      setToolRequests(data.requests ?? []);
    } catch (err) {
      console.warn("[operational-case-types] tool requests load failed:", err);
      setToolRequests([]);
    }
  }

  async function createToolRequest(
    row: OperationalCaseType,
    tool: ToolReadinessToolItem
  ) {
    if (!tool.request_kind) return;
    setToolRequestSubmitting(tool.tool_id);
    setToolRequestError(null);
    try {
      const res = await fetch("/api/global-tool-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_id: tool.tool_id,
          request_kind: tool.request_kind,
          case_type_id: row.id,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; request: ToolReadinessRequestRecord; duplicate: boolean }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolRequestError(
          "error" in data ? data.error : "No se pudo crear la solicitud."
        );
        return;
      }
      setToolRequests((prev) => {
        const without = prev.filter(
          (item) =>
            item.tool_id !== data.request.tool_id || item.id === data.request.id
        );
        return [data.request, ...without];
      });
    } catch (err) {
      setToolRequestError((err as Error).message ?? String(err));
    } finally {
      setToolRequestSubmitting(null);
    }
  }

  async function refreshTestCase(row: OperationalCaseType) {
    if (scopeLabel(row) === "global") {
      setTestCaseResult(null);
      return;
    }
    setTestCaseLoading(true);
    try {
      const res = await fetch(
        `/api/operational-case-tests?case_type_id=${encodeURIComponent(row.id)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setTestCaseResult(null);
        return;
      }
      setTestCaseResult(asTestCaseResult(data));
    } catch (err) {
      console.warn("[operational-case-types] test case load failed:", err);
      setTestCaseResult(null);
    } finally {
      setTestCaseLoading(false);
    }
  }

  async function refreshConversationalCase(
    row: OperationalCaseType,
    options?: { silent?: boolean; caseId?: string }
  ) {
    if (scopeLabel(row) === "global") {
      setConversationalLabResult(null);
      setActiveConversationalCaseId(null);
      return;
    }
    if (!options?.silent) {
      setConversationalLabLoading(true);
    }
    try {
      const explicitCaseId = options?.caseId?.trim() || null;
      const targetCaseId = explicitCaseId ?? activeConversationalCaseId;
      const query = targetCaseId
        ? `case_id=${encodeURIComponent(targetCaseId)}`
        : `case_type_id=${encodeURIComponent(row.id)}&source=conversational`;
      const res = await fetch(`/api/operational-case-tests?${query}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        if (!options?.silent && !activeConversationalCaseId) {
          setConversationalLabResult(null);
        }
        return;
      }
      const nextResult = asTestCaseResult(data);
      if (
        !data.case ||
        data.case.context_jsonb?.created_from !== "agent_conversation"
      ) {
        if (explicitCaseId || !activeConversationalCaseId) {
          setActiveConversationalCaseId(null);
        }
        setConversationalLabResult((current) => ({
          ...(current ?? nextResult),
          case: null,
          e2eLabSession: nextResult.e2eLabSession ?? null,
        }));
        return;
      }
      if (data.case.status === "paused" && targetCaseId) {
        // A specific case was being observed and it is paused. Keep showing
        // that exact case instead of snapping to the most recent one (which
        // is what made the selector bounce back). Paused cases are still part
        // of the observable list, so the panel renders them correctly.
        setActiveConversationalCaseId((current) =>
          explicitCaseId || !current ? targetCaseId : current
        );
        setConversationalLabResult(nextResult);
        return;
      }
      const loadedCaseId = data.case.id;
      if (!targetCaseId && conversationalObservationUnpinnedRef.current) {
        const sessionCaseId =
          typeof nextResult.e2eLabSession?.case_id === "string" &&
          nextResult.e2eLabSession.case_id.trim()
            ? nextResult.e2eLabSession.case_id.trim()
            : null;
        const sessionUpdatedAtMs = nextResult.e2eLabSession?.updated_at
          ? new Date(nextResult.e2eLabSession.updated_at).getTime()
          : 0;
        const sessionLinkedAfterUnpin =
          sessionCaseId === loadedCaseId &&
          Number.isFinite(sessionUpdatedAtMs) &&
          sessionUpdatedAtMs > conversationalObservationUnpinnedAtRef.current;
        // After "Abandonar recorrido" we stay unpinned but armed. Also re-pin
        // when the active E2E lab session links to a new case after the selector
        // was on "Sin caso en observación" (web or Telegram).
        if (
          (rePinOnNextConversationalCaseRef.current || sessionLinkedAfterUnpin) &&
          data.case.status !== "paused" &&
          loadedCaseId !== abandonedConversationalCaseIdRef.current
        ) {
          rePinOnNextConversationalCaseRef.current = false;
          abandonedConversationalCaseIdRef.current = null;
          conversationalObservationUnpinnedRef.current = false;
          conversationalObservationUnpinnedAtRef.current = 0;
          setConversationalObservationUnpinned(false);
          setActiveConversationalCaseId(loadedCaseId);
          replaceObservedCaseUrl(loadedCaseId);
          setConversationalLabMessage(null);
          setConversationalLabResult(nextResult);
          return;
        }
        setConversationalLabResult((current) => ({
          ...(current ?? nextResult),
          e2eLabSession: nextResult.e2eLabSession ?? null,
        }));
        return;
      }
      setActiveConversationalCaseId((current) =>
        explicitCaseId || !current ? loadedCaseId : current
      );
      setConversationalLabResult(nextResult);
    } catch (err) {
      console.warn("[operational-case-types] conversational case load failed:", err);
      if (!options?.silent && !activeConversationalCaseId) {
        setConversationalLabResult(null);
      }
    } finally {
      if (!options?.silent) {
        setConversationalLabLoading(false);
      }
    }
  }

  async function refreshE2ELabMode(row: OperationalCaseType) {
    if (scopeLabel(row) === "global") return;
    try {
      const res = await fetch(
        `/api/operational-case-tests/e2e-lab-mode?case_type_id=${encodeURIComponent(row.id)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | {
            ok: true;
            active: boolean;
            session: OperationalCaseE2ELabSession | null;
          }
        | { error: string };
      if (!res.ok || !("ok" in data)) return;
      setConversationalLabResult((current) => ({
        ...(current ?? {
          case: null,
          events: [],
          toolCalls: [],
          pendingActions: [],
          blockingActions: [],
          historicalActions: [],
          transitionCount: 0,
          e2eStartEvents: [],
          flowProgress: [],
        }),
        e2eLabSession: data.session ?? null,
      }));
    } catch (err) {
      console.warn("[operational-case-types] e2e lab mode load failed:", err);
    }
  }

  async function toggleE2ELabMode(row: OperationalCaseType, active: boolean) {
    if (scopeLabel(row) === "global") return;
    setE2ELabModeLoading(true);
    setError(null);
    setConversationalLabMessage(null);
    try {
      const url = active
        ? "/api/operational-case-tests/e2e-lab-mode"
        : `/api/operational-case-tests/e2e-lab-mode?case_type_id=${encodeURIComponent(row.id)}`;
      const res = await fetch(url, {
        method: active ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: active ? JSON.stringify({ case_type_id: row.id }) : undefined,
      });
      const data = (await res.json()) as
        | {
            ok: true;
            active: boolean;
            session: OperationalCaseE2ELabSession | null;
          }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        throw new Error("error" in data ? data.error : "e2e_lab_mode_failed");
      }
      setConversationalLabResult((current) => ({
        ...(current ?? {
          case: null,
          events: [],
          toolCalls: [],
          pendingActions: [],
          blockingActions: [],
          historicalActions: [],
          transitionCount: 0,
          e2eStartEvents: [],
          flowProgress: [],
        }),
        e2eLabSession: data.session ?? null,
      }));
      await refreshConversationalCase(row, { silent: true });
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setE2ELabModeLoading(false);
    }
  }

  async function abandonConversationalLabCase(row: OperationalCaseType) {
    const caseId = agentTestCase?.id;
    if (
      !caseId ||
      agentTestCase?.context_jsonb?.created_from !== "agent_conversation" ||
      isAbandonedConversationalE2ECase(agentTestCase)
    ) {
      return;
    }
    setAbandoningConversationalCase(true);
    setError(null);
    setConversationalLabMessage(null);
    try {
      const res = await fetch(
        `/api/operational-case-tests?case_id=${encodeURIComponent(caseId)}&source=conversational`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        case?: OperationalCase;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "conversational_lab_abandon_failed");
      }
      replaceObservedCaseUrl(null);
      setConversationalObservationUnpinned(true);
      conversationalObservationUnpinnedRef.current = true;
      conversationalObservationUnpinnedAtRef.current = Date.now();
      // Arm one-shot auto re-pin: the next active conversational case (created
      // from web or Telegram) will be observed automatically.
      rePinOnNextConversationalCaseRef.current = true;
      abandonedConversationalCaseIdRef.current = caseId;
      setActiveConversationalCaseId(null);
      setConversationalLabResult((current) => ({
        ...(current ?? {
          case: null,
          events: [],
          toolCalls: [],
          pendingActions: [],
          blockingActions: [],
          historicalActions: [],
          transitionCount: 0,
          e2eStartEvents: [],
          flowProgress: [],
        }),
        case: data.case ?? null,
        events: [],
        toolCalls: [],
        pendingActions: [],
        blockingActions: [],
        historicalActions: [],
        transitionCount: 0,
        e2eStartEvents: [],
        flowProgress: [],
      }));
      await refreshConversationalCase(row);
      setConversationalLabMessage(
        "Recorrido E2E abandonado. Escribe por Telegram con modo prueba E2E activo para iniciar uno nuevo desde Paso 0."
      );
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setAbandoningConversationalCase(false);
    }
  }

  async function createTestCase() {
    if (!selectedCaseType) return;
    setTestCaseLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/operational-case-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_type_id: selectedCaseType.id,
          validate_registration: true,
        }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "test_case_create_failed");
        return;
      }
      setTestCaseResult({
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
        pendingActions: data.pendingActions ?? [],
        blockingActions: data.blockingActions ?? [],
        historicalActions: data.historicalActions ?? [],
        transitionCount: data.transitionCount ?? 0,
        e2eStartEvents: data.e2eStartEvents ?? [],
        flowProgress: data.flowProgress ?? [],
        lastTransition: null,
      });
      const reused =
        "reused_existing" in data &&
        Boolean((data as { reused_existing?: boolean }).reused_existing);
      setTestContextMessage(
        reused
          ? "Caso de laboratorio regenerado y registro validado en la misma fila."
          : "Caso de laboratorio creado y registro validado."
      );
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setTestCaseLoading(false);
    }
  }

  async function saveTestContext() {
    const caseId = testCaseResult?.case?.id;
    if (!caseId) return;
    setTestContextSaving(true);
    setTestContextMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/operational-case-tests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_id: caseId,
          context: testContextDraft,
        }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setTestContextMessage(
          "error" in data ? data.error : "No se pudieron guardar los datos."
        );
        return;
      }
      setTestCaseResult({
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
        pendingActions: data.pendingActions ?? [],
        blockingActions: data.blockingActions ?? [],
        historicalActions: data.historicalActions ?? [],
        transitionCount: data.transitionCount ?? 0,
        e2eStartEvents: data.e2eStartEvents ?? [],
        flowProgress: data.flowProgress ?? [],
        lastTransition: testCaseResult?.lastTransition ?? null,
      });
      setTestContextVersion((version) => version + 1);
      setTestContextMessage(
        "Datos guardados. No se reinició el recorrido; las pruebas por tool usarán estos valores."
      );
    } catch (err) {
      setTestContextMessage((err as Error).message ?? String(err));
    } finally {
      setTestContextSaving(false);
    }
  }

  async function runControlledTest(mode: "safe_check" | "agent_e2e" = "safe_check") {
    const caseId =
      mode === "agent_e2e"
        ? (conversationalResultCase?.id ?? agentTestCase?.id)
        : testCaseResult?.case?.id;
    if (!caseId || testCaseRunLockRef.current) return;
    testCaseRunLockRef.current = true;
    setTestCaseRunningMode(mode);
    setError(null);
    setTestContextMessage(null);
    try {
      const res = await fetch("/api/operational-case-tests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: caseId, mode }),
      });
      const data = (await res.json()) as
        | ({
            ok: true;
            mode?: string;
            agent?: { pending_confirmation?: boolean; response_preview?: string | null };
            last_transition?: LastE2ETransitionOutcome | null;
          } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "controlled_test_failed");
        return;
      }
      const baseResult = asTestCaseResult(data);
      const nextLastTransition =
        data.mode === "agent_e2e"
          ? (data.last_transition ?? null)
          : data.mode === "safe_check"
            ? null
            : (testCaseResult?.lastTransition ?? null);
      if (data.mode === "agent_e2e") {
        setConversationalLabResult({
          ...baseResult,
          lastTransition: nextLastTransition,
        });
      } else {
        setTestCaseResult({
          ...baseResult,
          lastTransition: nextLastTransition,
        });
      }
      if (data.mode === "agent_e2e") {
        setTestContextMessage(
          data.agent?.pending_confirmation
            ? "Transición con agente ejecutada: hay acciones pendientes de aprobación humana. Revisa Flujos en curso o el chat."
            : "Transición con agente completada. Revisa el resumen de avance y la auditoría abajo."
        );
      } else {
        setTestContextMessage(
          "Prueba segura completada: registro validado sin invocar al agente."
        );
      }
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      testCaseRunLockRef.current = false;
      setTestCaseRunningMode(null);
    }
  }

  function scrollEditorPanelToTop() {
    window.requestAnimationFrame(() => {
      editorPanelRef.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
      });
    });
  }

  async function startEdit(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    value.operational_flow_jsonb = effectiveOperationalFlowForRow(row);
    const editableDescription = descriptionForEditing(value.description);
    let savedSkillBody =
      accountSkillMap.get(value.default_skill_slug)?.body_md ?? "";
    if (!savedSkillBody) {
      try {
        const skills = await loadAccountSkillsFromApi();
        savedSkillBody =
          skills.find((skill) => skill.slug === value.default_skill_slug)
            ?.body_md ?? "";
      } catch (err) {
        console.warn("[operational-case-types] account skill load failed:", err);
      }
    }
    setSelectedCaseType(row);
    const nextEditing = { ...value, description: editableDescription };
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFlowText = JSON.stringify(value.operational_flow_jsonb, null, 2);
    const nextActivationPolicyText = JSON.stringify(
      mergeActivationPolicy(value.activation_policy_jsonb),
      null,
      2
    );
    const nextFieldListText = value.intake_schema_jsonb
      .map((field) => field.label)
      .join("\n");
    const nextCreatePrivateSkill = Boolean(savedSkillBody);
    setEditing(nextEditing);
    setSchemaText(nextSchemaText);
    setFlowText(nextFlowText);
    setActivationPolicyText(nextActivationPolicyText);
    setProcedureText(editableDescription);
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(nextCreatePrivateSkill);
    setGeneratedSkillBody(savedSkillBody);
    setEditingBaseline({
      editing: nextEditing,
      schemaText: nextSchemaText,
      flowText: nextFlowText,
      activationPolicyText: nextActivationPolicyText,
      procedureText: editableDescription,
      fieldListText: nextFieldListText,
      createPrivateSkill: nextCreatePrivateSkill,
      generatedSkillBody: savedSkillBody,
    });
    setAuthoringResult(null);
    setShowAdvanced(Boolean(savedSkillBody));
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setOpenReadinessSteps(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setConversationalLabResult(null);
    setActiveConversationalCaseId(null);
    void refreshToolReadiness(row);
    void refreshTestCase(row);
    void refreshConversationalCase(row);
    setError(null);
    scrollEditorPanelToTop();
  }

  function viewCaseType(
    row: OperationalCaseType,
    tab: CaseTypeWorkspaceTab = "summary",
    options?: { updateUrl?: boolean }
  ) {
    setSelectedCaseType(row);
    setActiveTab(tab);
    setEditing(null);
    setSchemaText("");
    setFlowText("");
    setActivationPolicyText("");
    setProcedureText("");
    setFieldListText("");
    setGeneratedSkillBody("");
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setOpenReadinessSteps(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setConversationalLabResult(null);
    setActiveConversationalCaseId(null);
    setEditingBaseline(null);
    if (scopeLabel(row) !== "global") {
      void refreshToolReadiness(row);
      void refreshTestCase(row);
      void refreshConversationalCase(row);
    }
    if (options?.updateUrl !== false) {
      replaceWorkspaceUrl(row, tab);
    }
    setError(null);
  }

  function selectWorkspaceTab(tab: CaseTypeWorkspaceTab, row: OperationalCaseType) {
    setActiveTab(tab);
    replaceWorkspaceUrl(row, tab);
    if (tab === "lab" && scopeLabel(row) !== "global") {
      if (!toolReadiness && !toolReadinessLoading) {
        void refreshToolReadiness(row);
      }
      if (!testCaseResult && !testCaseLoading) {
        void refreshTestCase(row);
      }
      if (!conversationalLabResult && !conversationalLabLoading) {
        void refreshConversationalCase(row);
      }
    }
  }

  function startPrivateVersion(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    const editableDescription = descriptionForEditing(value.description);
    const existingSkill = skillMap.get(value.default_skill_slug);
    const skillBody = buildSkillBody({
      slug: value.default_skill_slug,
      displayName: value.display_name,
      description: editableDescription,
      procedureText: editableDescription,
      fields: value.intake_schema_jsonb,
      allowedTools: existingSkill?.allowedTools,
      includes: existingSkill?.includes,
    });
    const nextEditing = {
      ...value,
      description: editableDescription,
      visibility: "private" as const,
      isNew: true,
    };
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFlowText = JSON.stringify(value.operational_flow_jsonb, null, 2);
    const nextActivationPolicyText = JSON.stringify(
      mergeActivationPolicy(value.activation_policy_jsonb),
      null,
      2
    );
    const nextFieldListText = value.intake_schema_jsonb
      .map((field) => field.label)
      .join("\n");
    setSelectedCaseType(row);
    setEditing(nextEditing);
    setSchemaText(nextSchemaText);
    setFlowText(nextFlowText);
    setActivationPolicyText(nextActivationPolicyText);
    setProcedureText(editableDescription);
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(true);
    setGeneratedSkillBody(skillBody);
    setEditingBaseline({
      editing: nextEditing,
      schemaText: nextSchemaText,
      flowText: nextFlowText,
      activationPolicyText: nextActivationPolicyText,
      procedureText: editableDescription,
      fieldListText: nextFieldListText,
      createPrivateSkill: true,
      generatedSkillBody: skillBody,
    });
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setOpenReadinessSteps(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setConversationalLabResult(null);
    setActiveConversationalCaseId(null);
    setError(null);
    scrollEditorPanelToTop();
  }

  function startNew() {
    const value = newCaseType();
    setSelectedCaseType(null);
    setEditing(value);
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFlowText = JSON.stringify(value.operational_flow_jsonb, null, 2);
    const nextActivationPolicyText = JSON.stringify(
      mergeActivationPolicy(value.activation_policy_jsonb),
      null,
      2
    );
    const nextFieldListText = "Título\nNotas iniciales";
    setSchemaText(nextSchemaText);
    setFlowText(nextFlowText);
    setActivationPolicyText(nextActivationPolicyText);
    setProcedureText("");
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(true);
    setGeneratedSkillBody("");
    setEditingBaseline({
      editing: value,
      schemaText: nextSchemaText,
      flowText: nextFlowText,
      activationPolicyText: nextActivationPolicyText,
      procedureText: "",
      fieldListText: nextFieldListText,
      createPrivateSkill: true,
      generatedSkillBody: "",
    });
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setConversationalLabResult(null);
    setActiveConversationalCaseId(null);
    setError(null);
    scrollEditorPanelToTop();
  }

  function generateDraft() {
    if (!editing) return;
    const displayName = editing.display_name.trim() || "Nuevo caso de uso";
    const caseType = editing.case_type.trim() || toSlug(displayName, "_");
    const skillSlug =
      editing.default_skill_slug.trim() || `${toSlug(displayName, "-")}-coach`;
    const fields = parseFieldList(fieldListText);
    const existingSkill = skillMap.get(skillSlug);
    const description =
      editing.description.trim() ||
      procedureText.trim().split(/\n\n|\. /)[0]?.trim() ||
      `Procedimiento operativo para ${displayName}.`;
    const next = {
      ...editing,
      case_type: caseType,
      display_name: displayName,
      default_skill_slug: skillSlug,
      description,
      intake_schema_jsonb: fields,
      operational_flow_jsonb: fallbackOperationalFlow({
        defaultSkillSlug: skillSlug,
        skill: existingSkill,
      }),
    };
    setEditing(next);
    setSchemaText(JSON.stringify(fields, null, 2));
    setFlowText(JSON.stringify(next.operational_flow_jsonb, null, 2));
    setGeneratedSkillBody(
      buildSkillBody({
        slug: skillSlug,
        displayName,
        description,
        procedureText,
        fields,
        allowedTools: existingSkill?.allowedTools,
        includes: existingSkill?.includes,
      })
    );
    setShowAdvanced(true);
    setAuthoringResult(null);
    setError(null);
  }

  function cancelAuthoring() {
    authoringRequestSeq.current += 1;
    authoringAbortRef.current?.abort();
    authoringAbortRef.current = null;
    setAuthoring(false);
    setAuthoringStartedAt(null);
    setAuthoringProgress((prev) => [
      ...prev,
      {
        type: "stage",
        stage: "cancelled",
        message: "Generación cancelada por el usuario.",
        ts: Date.now(),
      },
    ]);
  }

  function applyAuthoringResult(data: { ok: true } & SkillAuthoringResult) {
    setGeneratedSkillBody(data.skillDraft);
    setAuthoringResult({
      skillDraft: data.skillDraft,
      validationRubric: data.validationRubric ?? [],
      suggestedEvals: data.suggestedEvals ?? {},
      operationalFlow: data.operationalFlow ?? [],
      activationRecommendation: data.activationRecommendation ?? "",
      attemptsUsed: data.attemptsUsed,
      elapsedMs: data.elapsedMs,
      metadataTruncated: data.metadataTruncated,
    });
    if (data.operationalFlow?.length) {
      const normalized = normalizeOperationalFlow(data.operationalFlow);
      setEditing((current) =>
        current ? { ...current, operational_flow_jsonb: normalized } : current
      );
      setFlowText(JSON.stringify(normalized, null, 2));
    }
    if (data.activationPolicy) {
      const normalizedPolicy = mergeActivationPolicy(data.activationPolicy);
      setEditing((current) =>
        current
          ? { ...current, activation_policy_jsonb: normalizedPolicy }
          : current
      );
      setActivationPolicyText(JSON.stringify(normalizedPolicy, null, 2));
    }
    setCreatePrivateSkill(true);
    setShowAdvanced(true);
  }

  async function generateOptimizedDraft() {
    if (!editing) return;
    const requestId = authoringRequestSeq.current + 1;
    authoringRequestSeq.current = requestId;
    authoringAbortRef.current?.abort();
    const abortController = new AbortController();
    authoringAbortRef.current = abortController;
    setAuthoring(true);
    setAuthoringStartedAt(Date.now());
    setAuthoringElapsedMs(0);
    setAuthoringProgress([]);
    setShowAuthoringLog(true);
    setError(null);
    try {
      const res = await fetch("/api/skill-authoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          caseType: editing.case_type,
          displayName: editing.display_name,
          description: procedureText || editing.description,
          fieldList: fieldListText,
          intakeSchema: editing.intake_schema_jsonb,
          operationalFlow: editing.operational_flow_jsonb,
          activationPolicy: editing.activation_policy_jsonb,
          skillSlug: editing.default_skill_slug,
          baseSkillSlug: selectedCaseType?.default_skill_slug ?? editing.default_skill_slug,
        }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok && !contentType.includes("application/x-ndjson")) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          raw?: string;
        };
        if (requestId !== authoringRequestSeq.current) return;
        setError(data.raw ? `${data.error}\n\n${data.raw}` : data.error ?? "skill_authoring_failed");
        return;
      }

      if (!res.body || !contentType.includes("application/x-ndjson")) {
        const data = (await res.json()) as
          | ({ ok: true } & SkillAuthoringResult)
          | { error: string; raw?: string };
        if (requestId !== authoringRequestSeq.current) return;
        if (!("ok" in data)) {
          setError(
            "raw" in data && data.raw
              ? `${data.error}\n\n${data.raw}`
              : "error" in data
                ? data.error
                : "skill_authoring_failed"
          );
          return;
        }
        applyAuthoringResult(data);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotResult = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = JSON.parse(trimmed) as
            | AuthoringProgressEvent
            | {
                type: "result";
                payload: { ok: true } & SkillAuthoringResult;
                ts?: number;
              };
          if (requestId !== authoringRequestSeq.current) return;
          if (event.type === "stage" || event.type === "error") {
            setAuthoringProgress((prev) => [...prev, event]);
          }
          if (event.type === "error") {
            setError(
              event.details ? `${event.error}: ${event.details}` : event.error ?? "skill_authoring_failed"
            );
            return;
          }
          if (event.type === "result") {
            gotResult = true;
            applyAuthoringResult(event.payload);
          }
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer.trim()) as
          | AuthoringProgressEvent
          | {
              type: "result";
              payload: { ok: true } & SkillAuthoringResult;
              ts?: number;
            };
        if (requestId === authoringRequestSeq.current) {
          if (event.type === "stage" || event.type === "error") {
            setAuthoringProgress((prev) => [...prev, event]);
          }
          if (event.type === "error") {
            setError(
              event.details ? `${event.error}: ${event.details}` : event.error ?? "skill_authoring_failed"
            );
            return;
          }
          if (event.type === "result") {
            gotResult = true;
            applyAuthoringResult(event.payload);
          }
        }
      }
      if (!gotResult && requestId === authoringRequestSeq.current) {
        setError("skill_authoring_stream_finished_without_result");
      }
    } catch (err) {
      if (requestId !== authoringRequestSeq.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError((err as Error).message ?? String(err));
    } finally {
      if (requestId === authoringRequestSeq.current) {
        setAuthoring(false);
        setAuthoringStartedAt(null);
        authoringAbortRef.current = null;
      }
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      let intakeSchema: unknown;
      try {
        intakeSchema = JSON.parse(schemaText);
      } catch (err) {
        setError(`intake_schema_jsonb inválido: ${(err as Error).message}`);
        return;
      }
      let operationalFlow: OperationalCaseFlowStep[];
      try {
        operationalFlow = normalizeOperationalFlow(JSON.parse(flowText || "[]"));
      } catch (err) {
        setError(`operational_flow_jsonb inválido: ${(err as Error).message}`);
        return;
      }
      let activationPolicy: OperationalCaseActivationPolicy;
      try {
        activationPolicy = mergeActivationPolicy(
          JSON.parse(activationPolicyText || "{}") as OperationalCaseActivationPolicy
        );
      } catch (err) {
        setError(`activation_policy_jsonb inválido: ${(err as Error).message}`);
        return;
      }

      if (createPrivateSkill) {
        const skillBody =
          generatedSkillBody ||
          buildSkillBody({
            slug: editing.default_skill_slug,
            displayName: editing.display_name,
            description: editing.description,
            procedureText,
            fields: Array.isArray(intakeSchema)
              ? (intakeSchema as OperationalCaseIntakeField[])
              : [],
          });
        const skillRes = await fetch("/api/account-skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: editing.default_skill_slug,
            body_md: skillBody,
            status: "active",
          }),
        });
        const skillData = (await skillRes.json()) as
          | { ok: true }
          | { error: string; details?: string };
        if (!skillRes.ok || !("ok" in skillData)) {
          setError(
            "details" in skillData && skillData.details
              ? `${skillData.error}: ${skillData.details}`
              : "error" in skillData
                ? skillData.error
                : "skill_save_failed"
          );
          return;
        }
      }

      const res = await fetch("/api/operational-case-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editing,
          intake_schema_jsonb: intakeSchema,
          operational_flow_jsonb: operationalFlow,
          activation_policy_jsonb: activationPolicy,
          default_reminder_policy_jsonb: editing.default_reminder_policy_jsonb,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; caseType: OperationalCaseType }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "save_failed");
        return;
      }

      setCaseTypes((prev) => {
        const without = prev.filter((row) => row.id !== data.caseType.id);
        return [data.caseType, ...without];
      });
      setSelectedCaseType(data.caseType);
      setActiveTab("summary");
      setToolReadiness(null);
      setToolReadinessError(null);
      setExpandedReadinessTools(new Set());
      setOpenReadinessSteps(new Set());
      setToolRequests([]);
      setToolRequestError(null);
      setToolRequestSubmitting(null);
      setTestCaseResult(null);
      void refreshToolReadiness(data.caseType);
      void refreshTestCase(data.caseType);
      setEditingBaseline(null);
      setEditing(null);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  function renderCaseTypeDetail(row: OperationalCaseType) {
    const skill = skillMap.get(row.default_skill_slug);
    const isGlobal = scopeLabel(row) === "global";
    const scopeUi = templateScopePresentation(isGlobal);
    const fields = Array.isArray(row.intake_schema_jsonb)
      ? row.intake_schema_jsonb
      : [];
    const activationPolicy = effectiveActivationPolicyForRow(row);
    const testCasePreparationDefaultOpen =
      !testCaseResult?.case ||
      testCaseResult.case.current_step === "intake";
    const configuredLabFlow = Array.isArray(row.operational_flow_jsonb)
      ? row.operational_flow_jsonb.map(flowStepWithoutReadiness)
      : [];
    const labFlowSteps =
      toolReadiness?.flow && toolReadiness.flow.length > 0
        ? toolReadiness.flow
        : configuredLabFlow;
    const labFlowPartition = partitionFlowSteps(
      labFlowSteps.filter((step) => step.step_key !== "transversal_tools")
    );
    const labPreparationSteps =
      toolReadiness?.flow_preparation ?? labFlowPartition.preparationSteps;
    const labOperationalSteps =
      toolReadiness?.flow_operational ?? labFlowPartition.operationalSteps;
    const labTransversalStep = labFlowSteps.find(
      (step) => step.step_key === "transversal_tools"
    );
    const testCaseHasCase = Boolean(testCaseResult?.case);
    const intakePrepared = testCaseIntakePrepared({
      hasCase: testCaseHasCase,
      testPassed,
      currentStep: testCaseResult?.case?.current_step,
    });
    const toolsCompleteForOperation =
      Boolean(toolReadiness) &&
      toolsPass &&
      readinessCounts.stub === 0 &&
      readinessCounts.missing === 0 &&
      readinessCounts.unknown === 0 &&
      readinessCounts.needs_config === 0;
    const conversationalActivationReady =
      selectedIsActive &&
      skillLooksValid &&
      toolsCompleteForOperation &&
      intakePrepared;
    const operationalStepsForActivation = (() => {
      const flow = toolReadiness?.flow ?? [];
      if (toolReadiness?.flow_operational?.length) {
        return toolReadiness.flow_operational;
      }
      return partitionFlowSteps(
        flow.filter((step) => step.step_key !== "transversal_tools")
      ).operationalSteps;
    })();
    const stepProgressCheck = activationStepProgressCheck({
      steps: operationalStepsForActivation,
    });
    const realRelatedCases = relatedOperationalCases.filter(
      (opCase) => opCase.context_jsonb?.test_mode !== true
    );
    const testRelatedCases = relatedOperationalCases.filter(
      (opCase) => opCase.context_jsonb?.test_mode === true
    );

    function caseTypeDisplayNameForInstance(opCase: OperationalCase) {
      return (
        caseTypes.find((type) => type.id === opCase.case_type_id)
          ?.display_name ?? opCase.case_type
      );
    }

    function skillMetaForInstance(
      opCase: OperationalCase
    ): OperationalCaseInstanceSkillMeta {
      const type =
        caseTypes.find((item) => item.id === opCase.case_type_id) ?? row;
      const slug = type.default_skill_slug;
      const summary = skillMap.get(slug);
      return {
        slug,
        kindLabel: summary?.kind === "composite" ? "compuesta" : "atómica",
        sourceLabel: accountSkills.some(
          (accountSkill) => accountSkill.slug === slug
        )
          ? "cuenta"
          : "producto",
        exists: Boolean(summary),
      };
    }

    function latestEventForInstance(opCase: OperationalCase) {
      const event = initialLatestEventsByCaseId[opCase.id];
      return event ? operationalCaseLatestEventSummary(event) : null;
    }

    function stepLabelForInstance(opCase: OperationalCase) {
      if (!opCase.current_step) return "Sin definir";
      const flow = Array.isArray(row.operational_flow_jsonb)
        ? row.operational_flow_jsonb
        : [];
      return (
        flow.find((step) => step.step_key === opCase.current_step)
          ?.step_label ?? opCase.current_step
      );
    }

    function renderRelatedOperationalCases() {
      const statusCounts = relatedOperationalCases.reduce(
        (acc, opCase) => {
          acc[opCase.status] = (acc[opCase.status] ?? 0) + 1;
          return acc;
        },
        {} as Partial<Record<OperationalCaseStatus, number>>
      );
      return (
        <div className="w-full min-w-0 space-y-3">
          <div className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Flujos relacionados
            </div>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              Casos creados desde esta plantilla. Los casos de prueba viven en
              la misma tabla, pero se separan aquí para no mezclarlos con
              operación real. Para ver instancias de{" "}
              <span className="font-medium">todas</span> las plantillas, usa{" "}
              <a
                href="/operational-cases"
                className="font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              >
                Todas las instancias
              </a>
              .
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-neutral-100 px-2 py-1 font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                {realRelatedCases.length} reales
              </span>
              <span className="rounded bg-sky-50 px-2 py-1 font-semibold text-sky-700">
                {testRelatedCases.length} prueba
              </span>
              {Object.entries(statusCounts).map(([status, count]) => (
                <span
                  key={status}
                  className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {OPERATIONAL_CASE_STATUS_LABELS[status as OperationalCaseStatus]}:{" "}
                  {count}
                </span>
              ))}
            </div>
          </div>
          {relatedOperationalCases.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
              Todavía no hay casos en operación para esta plantilla. Cuando se
              creen por chat, Telegram, laboratorio o creación manual aparecerán
              aquí.
            </div>
          ) : (
            <OperationalCaseInstanceList
              cases={relatedOperationalCases}
              getHref={(opCase) =>
                `/operational-cases?case=${opCase.id}&type=${row.id}`
              }
              getCaseTypeDisplayName={caseTypeDisplayNameForInstance}
              getStepLabel={stepLabelForInstance}
              getSkillMeta={skillMetaForInstance}
              getLatestEvent={latestEventForInstance}
            />
          )}
        </div>
      );
    }

    function renderTestCaseN0Card() {
      const preparationStatus = testCasePreparationStatus({
        hasCase: Boolean(testCaseResult?.case),
        registrationReady: intakePrepared,
        safeCheckPassed: testPassed,
        toolsHaveBlocks,
      });
      return (
        <LabStepDetails
          key={`n0-${testCaseResult?.case?.id ?? "none"}-${testCaseResult?.case?.current_step ?? "pending"}`}
          defaultOpen={testCasePreparationDefaultOpen}
          className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950"
          summary={
            <div className="text-center">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
                  Preparar caso de prueba
                </span>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${testCaseStatusPillClass(
                    preparationStatus.tone
                  )}`}
                >
                  {preparationStatus.label}
                </span>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {activationPolicy.safe_test.description}
              </p>
            </div>
          }
        >
          <div className="mt-3 space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={createTestCase}
                disabled={
                  testCaseLoading ||
                  testCaseRunning ||
                  toolsHaveBlocks ||
                  (!testCaseResult?.case ? !canCreateTestCase : !canManageTestCase)
                }
                className={`rounded px-3 py-2 text-xs font-semibold disabled:opacity-60 ${
                  !toolsHaveBlocks &&
                  (testCaseResult?.case ? canManageTestCase : canCreateTestCase)
                    ? "bg-violet-700 text-white hover:bg-violet-800"
                    : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
                }`}
              >
                {testCaseLoading
                  ? "Procesando..."
                  : testCaseResult?.case
                    ? "Regenerar y validar registro"
                    : "Crear y validar registro"}
              </button>
            </div>
            <p className="text-[11px] text-neutral-500">
              Regenera datos controlados del laboratorio, valida el registro sin
              invocar al agente y deja el caso listo en el primer paso operativo.
              Guardar datos no reinicia el recorrido.
            </p>
            {toolsHaveBlocks && testCaseResult?.case ? (
              <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Hay un caso de prueba creado previamente, pero no puede
                regenerarse y validarse hasta probar o configurar las tools
                requeridas en Preparación operativa.
              </p>
            ) : null}
            {testCaseResult?.case ? (
              <div className="rounded border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
                <div className="font-semibold">
                  {String(
                    testCaseResult.case.context_jsonb?.title ??
                      testCaseResult.case.id
                  )}
                </div>
                <div className="mt-1 text-neutral-500">
                  Estado: {testCaseResult.case.status} · Paso:{" "}
                  {testCaseResult.case.current_step ?? "sin paso"} · Creado:{" "}
                  {formatDateTime(testCaseResult.case.created_at)}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshTestCase(row)}
                    disabled={testCaseLoading}
                    className="rounded border border-violet-300 bg-white px-2 py-1 text-[11px] font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-60"
                  >
                    {testCaseLoading ? "Refrescando..." : "Refrescar estado"}
                  </button>
                  <a
                    href={`/operational-cases?case=${testCaseResult.case.id}`}
                    className="inline-flex items-center rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-neutral-50"
                  >
                    Abrir en Flujos en curso
                  </a>
                </div>
                <TestCaseBusinessSnapshot
                  opCase={testCaseResult.case}
                  events={testCaseResult.events}
                />
                <p className="mt-2 text-neutral-500">
                  {activationPolicy.safe_test.synthetic_data_copy}
                </p>
                <p className="mt-1 text-[11px] text-neutral-500">
                  Regenerar y validar registro restablece el caso de laboratorio,
                  inicia una nueva ventana de auditoría y lo deja listo para
                  pruebas aisladas o transiciones controladas. La línea de tiempo
                  histórica se conserva en la base de datos.
                </p>
              </div>
            ) : (
              <p className="text-xs text-neutral-500">
                {testCaseLoading
                  ? "Buscando el caso de prueba más reciente..."
                  : !toolReadiness
                    ? "Primero revisa la preparación operativa."
                    : toolsHaveBlocks
                      ? "Prueba o configura las tools requeridas antes de preparar el caso de laboratorio."
                      : "Aún no hay caso de prueba para esta plantilla."}
              </p>
            )}
            {testCaseResult?.case ? (
              <TestCaseContextForm
                fields={testContextFields}
                draft={testContextDraft}
                saving={testContextSaving}
                message={testContextMessage}
                onChange={(name, value) => {
                  setTestContextDraft((prev) => ({ ...prev, [name]: value }));
                  setTestContextMessage(null);
                }}
                onSave={() => {
                  void saveTestContext();
                }}
              />
            ) : null}
          </div>
        </LabStepDetails>
      );
    }

    function renderTestCaseN5Card() {
      const hasCase = Boolean(agentTestCase);
      const operationalStepLabels = buildOperationalStepLabelMap(
        conversationalResultCase && conversationalLabResult?.flowProgress?.length
          ? conversationalLabResult.flowProgress
          : Array.isArray(row.operational_flow_jsonb)
            ? row.operational_flow_jsonb
            : []
      );
      const playthroughAnchorAt = conversationalResultCase
        ? settingsTestPlaythroughAnchorAt(conversationalResultCase.context_jsonb)
        : null;
      const showPlaythroughRestartBanner = false;
      const lastTransition = conversationalResultCase
        ? (conversationalLabResult?.lastTransition ?? null)
        : null;
      const e2eStartedAt = (conversationalResultCase
        ? (conversationalLabResult?.e2eStartEvents ?? [])
        : [])
        .map((event) => event.created_at)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
      const fallbackFlowProgress: OperationalCaseFlowProgressStep[] =
        conversationalResultCase && conversationalLabResult?.flowProgress?.length
          ? conversationalLabResult.flowProgress
          : (Array.isArray(row.operational_flow_jsonb)
              ? row.operational_flow_jsonb
              : []
            ).map((step) => ({
              step_key: step.step_key,
              step_label: step.step_label,
              status:
                agentTestCase?.current_step === step.step_key
                  ? "in_progress"
                  : "pending",
              evidence: [],
              evidenceItems: [],
            }));
      const e2eFlowProgress = flowProgressForE2ESummary(fallbackFlowProgress, {
        e2eStartedAt: e2eStartedAt ?? null,
      });
      const hasE2ETransitions =
        transitionCount > 0 || Boolean(lastTransition);
      const lastTransitionUi =
        lastTransition && transitionCount > 0
          ? formatLastE2ETransitionOutcome({
              transitionNumber: transitionCount,
              ...lastTransition,
              stepLabels: operationalStepLabels,
            })
          : null;
      const currentStepKey = agentTestCase?.current_step ?? null;
      const currentStepProgress = e2eFlowProgress.find(
        (step) => step.step_key === currentStepKey
      );
      const currentStepLabel = currentStepProgress?.step_label ?? null;
      const documentRequestTarget =
        agentTestCase
          ? resolveOperationalCaseDocumentRequestTarget({
              externalContact: agentTestCase.external_contact_jsonb,
              context: agentTestCase.context_jsonb,
            })
          : null;
      const documentRequestTargetLabel =
        documentRequestTarget === "external_contact"
          ? "Contacto externo"
          : documentRequestTarget === "internal_user"
            ? "Equipo interno"
            : null;
      const missingRequired = Array.isArray(
        agentTestCase?.context_jsonb?.missing_required
      )
        ? (agentTestCase?.context_jsonb?.missing_required as Array<{
            name?: string;
            label?: string;
          }>)
        : [];
      const labMode = deriveConversationalLabMode({
        opCase: agentTestCase ?? null,
        hasPendingLabActions,
      });
      const conversationalActivityCount = countConversationalActivity(
        conversationalLabResult?.events ?? [],
        agentTestCase ?? null
      );
      const conversationalActivity = conversationalActivityItems(
        conversationalLabResult?.events ?? [],
        agentTestCase ?? null
      );
      const intakeIncomplete = labMode === "intake_conversacional";
      const caseIsControlledE2E =
        agentTestCase?.context_jsonb?.e2e_controlled === true;
      const isRealConversationalCase = Boolean(agentTestCase && !caseIsControlledE2E);
      const hasObservableConversationalCases =
        observableConversationalCases.length > 0;
      const observedCaseSelectorValue = activeConversationalCaseId ?? "";
      const canAbandonObservedE2ECase =
        agentTestCase?.context_jsonb?.created_from === "agent_conversation" &&
        caseIsControlledE2E &&
        !isAbandonedConversationalE2ECase(agentTestCase);
      const observedCaseLabel = (opCase: OperationalCase) =>
        buildObservedConversationalCaseLabel({
          opCase,
          operationalStepLabels,
          currentStepProgressLabel: currentStepProgress?.step_label,
          formatDateTime,
        });
      const activeE2ELabSession = conversationalLabResult?.e2eLabSession ?? null;
      const e2eLabModeActive = Boolean(activeE2ELabSession);
      const e2eLabModeExpiresAt = activeE2ELabSession?.expires_at
        ? formatDateTime(activeE2ELabSession.expires_at)
        : null;
      const n5StatusLabel =
        labMode === "sin_caso"
          ? "Sin caso conversacional activo"
          : labMode === "accion_humana_pendiente"
            ? "Acción humana pendiente"
            : labMode === "intake_conversacional"
              ? "Intake conversacional en curso"
              : !isRealConversationalCase && e2ePendingHitl
                ? "Pendiente aprobación humana"
                : !isRealConversationalCase && e2eWaitingExternal
                  ? "Esperando respuesta del dueño"
                  : !isRealConversationalCase && e2eExtractionEscalatedToHuman
                    ? "Escalado a humano: no pude leer documentos tras varios intentos"
                    : !isRealConversationalCase && e2eBlockedPendingExtraction
                      ? `Reintentando extracción de documentos automáticamente${
                          extractionRemediationAttemptsLabel
                            ? ` (${extractionRemediationAttemptsLabel})`
                            : ""
                        }`
                      : !isRealConversationalCase && e2eCompleted
                        ? "Transición completada"
                        : "Caso conversacional listo";
      return (
        <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30">
          {conversationalLabMessage ? (
            <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
              {conversationalLabMessage}
            </div>
          ) : null}
          <div className="rounded border border-emerald-200 bg-white/70 p-2 dark:border-emerald-900 dark:bg-neutral-950/40">
            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              Configuración del laboratorio E2E
            </div>
            <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-300">
              Define cómo se comportarán los próximos mensajes de Telegram. No
              describe el caso en observación, más abajo.
            </p>
            <div
              className={`mt-2 rounded border p-2 text-xs ${
                e2eLabModeActive
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
                  : "border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">Modo prueba E2E por Telegram</div>
                  <p className="mt-1 text-[11px]">
                    {e2eLabModeActive
                      ? `Activo para ${row.case_type}. Los casos nuevos desde Telegram se marcarán como e2e_controlled y expiran automáticamente.`
                      : "Inactivo. Telegram creará o continuará casos reales; no se inferirá modo prueba desde el texto del mensaje."}
                    {e2eLabModeExpiresAt ? ` Expira: ${e2eLabModeExpiresAt}.` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canAbandonObservedE2ECase ? (
                    <button
                      type="button"
                      onClick={() => void abandonConversationalLabCase(row)}
                      disabled={abandoningConversationalCase || e2eLabModeLoading}
                      className="rounded border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-60"
                      title="Pausa este recorrido E2E, cancela sus pendientes y permite crear uno nuevo al escribir por Telegram. No borra el historial."
                    >
                      {abandoningConversationalCase
                        ? "Abandonando recorrido..."
                        : "Abandonar este recorrido E2E"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void toggleE2ELabMode(row, !e2eLabModeActive)}
                    disabled={e2eLabModeLoading || scopeLabel(row) === "global"}
                    className={`rounded px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60 ${
                      e2eLabModeActive
                        ? "border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50"
                        : "bg-violet-700 text-white hover:bg-violet-800"
                    }`}
                  >
                    {e2eLabModeLoading
                      ? "Actualizando..."
                      : e2eLabModeActive
                        ? "Desactivar modo prueba E2E"
                        : "Activar modo prueba E2E"}
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-2 rounded border border-neutral-200 bg-white p-2 text-[11px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              <div className="font-semibold text-neutral-700 dark:text-neutral-200">
                Iniciar un recorrido E2E en limpio
              </div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>Activa el modo prueba E2E.</li>
                <li>
                  Si ya hay un recorrido E2E activo, selecciónalo en Caso en
                  observación (abajo) y pulsa «Abandonar este recorrido E2E».
                </li>
                <li>
                  Escribe por Telegram para crear un caso nuevo desde Paso 0.
                </li>
              </ol>
              {isRealConversationalCase ? (
                <p className="mt-1 text-amber-700 dark:text-amber-300">
                  Observas un caso real. Estos pasos no lo afectan; solo controlan
                  las pruebas E2E.
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 rounded border border-violet-200 bg-white/80 p-2 text-violet-900 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100">
            <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
              Caso en observación
            </div>
            {!activeConversationalCaseId ? (
              <p className="mt-1 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                Listo para nuevo recorrido
              </p>
            ) : null}
            {hasObservableConversationalCases ? (
              <select
                id={`observed-case-${row.id}`}
                value={observedCaseSelectorValue}
                onChange={(event) => {
                  const nextId = event.target.value.trim();
                  // Manual selection/deselection is an explicit user choice, so
                  // it must NOT trigger the abandon-driven auto re-pin.
                  rePinOnNextConversationalCaseRef.current = false;
                  abandonedConversationalCaseIdRef.current = null;
                  replaceObservedCaseUrl(nextId || null);
                  setConversationalObservationUnpinned(!nextId);
                  setActiveConversationalCaseId(nextId || null);
                  setConversationalLabMessage(null);
                  if (!nextId) {
                    conversationalObservationUnpinnedAtRef.current = Date.now();
                    setConversationalLabResult((current) =>
                      current
                        ? {
                            ...current,
                            events: [],
                            toolCalls: [],
                            pendingActions: [],
                            blockingActions: [],
                            historicalActions: [],
                            transitionCount: 0,
                            e2eStartEvents: [],
                            flowProgress: [],
                          }
                        : current
                    );
                    return;
                  }
                  void refreshConversationalCase(row, {
                    caseId: nextId || undefined,
                  });
                }}
                className="mt-1 w-full rounded border border-violet-200 bg-white px-2 py-1 text-[11px] font-medium text-violet-900 dark:border-violet-800 dark:bg-neutral-950 dark:text-violet-100"
              >
                <option value="">— Sin caso en observación —</option>
                {observableConversationalCases.map((opCase) => (
                  <option key={opCase.id} value={opCase.id}>
                    {observedCaseLabel(opCase)}
                  </option>
                ))}
              </select>
            ) : activeConversationalCaseId && agentTestCase ? (
              <p className="mt-1 text-xs font-medium">
                {observedCaseLabel(agentTestCase)}
              </p>
            ) : null}
          </div>
          <LabStepDetails
            defaultOpen={hasCase}
            className="mt-2"
            summary={
              <div className="text-center">
                <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">
                  {isRealConversationalCase ? "Caso real observado" : "Prueba con agente"}
                </span>
                {hasCase && !intakeIncomplete ? (
                  <span
                    className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
                    title={
                      isRealConversationalCase
                        ? "Seguimiento operativo del caso real."
                        : formatLabTransitionSummary(transitionCount)
                    }
                  >
                    {isRealConversationalCase
                      ? "Seguimiento caso real"
                      : formatLabTransitionBadge(transitionCount)}
                  </span>
                ) : null}
                {e2eLabModeActive ? (
                  <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
                    Modo prueba E2E activo
                    {e2eLabModeExpiresAt ? ` hasta ${e2eLabModeExpiresAt}` : ""}
                  </span>
                ) : (
                  <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                    Modo real por defecto
                  </span>
                )}
                {hasCase ? (
                  <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
                    {isRealConversationalCase
                      ? "Origen: Telegram"
                      : "Origen: Conversacional (agent_conversation)"}
                  </span>
                ) : null}
                {hasCase && currentStepKey && !intakeIncomplete ? (
                  <span
                    className="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-900 dark:bg-sky-950 dark:text-sky-100"
                    title="Paso operativo donde está el caso ahora (define qué hará el agente en la siguiente transición)."
                  >
                    Paso: {currentStepLabel ?? currentStepKey}
                  </span>
                ) : null}
                {hasCase &&
                currentStepKey === "awaiting_documents" &&
                documentRequestTargetLabel ? (
                  <span
                    className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
                    title="Destino actual para solicitud/carga de documentos."
                  >
                    Documentos: {documentRequestTargetLabel}
                  </span>
                ) : null}
                {hasCase && intakeIncomplete ? (
                  <span className="inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-900 dark:bg-sky-950 dark:text-sky-100">
                    Paso 0: {currentStepLabel ?? "Completar registro del caso"}
                  </span>
                ) : null}
              </div>
                <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
                  {isRealConversationalCase
                    ? "Este panel observa el caso real. El flujo avanza por Telegram, cron y tus decisiones HITL en Pendientes."
                    : "Activa el modo prueba E2E antes de escribir por Telegram si quieres que el nuevo caso sea controlado por el laboratorio. Los avances por evento ocurren en Telegram; las revisiones por tiempo se hacen manualmente aquí."}
                </p>
                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-300">
                  Estado actual: {n5StatusLabel}
                </p>
                {isRealConversationalCase ? (
                  <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    Caso real de producción: el cron puede continuar este caso fuera
                    del laboratorio.
                  </p>
                ) : null}
              </div>
            }
          >
          <div className="mt-3 space-y-3 border-t border-violet-200 pt-3 dark:border-violet-900">
            {!agentTestCase ? (
              <div className="space-y-2 text-xs text-neutral-600 dark:text-neutral-300">
                {!activeConversationalCaseId ? (
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
                    <div className="font-semibold">Listo para nuevo recorrido</div>
                    <p className="mt-1">
                      No hay un caso E2E activo en observación. Escribe por
                      Telegram con modo prueba E2E activo para crear uno desde
                      Paso 0.
                      {observableConversationalCases.length > 0
                        ? " Para revisar un recorrido anterior, elígelo en el selector de arriba."
                        : ""}
                    </p>
                  </div>
                ) : pausedConversationalCase ? (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
                    <div className="font-semibold">
                      Recorrido conversacional anterior pausado
                    </div>
                    <p className="mt-1">
                      Hay un caso previo en{" "}
                      <span className="font-mono">paused / intake</span>, pero no
                      se usa como recorrido activo para evitar confundirlo con una
                      prueba E2E en curso.
                    </p>
                    <p className="mt-1">
                      Activa el modo prueba E2E y escribe nuevamente por Telegram
                      que quieres opcionar una propiedad para iniciar un recorrido
                      limpio desde Paso 0.
                    </p>
                  </div>
                ) : (
                  <p>
                    {e2eLabModeActive
                      ? "Escribe por Telegram para comenzar el recorrido E2E desde Paso 0."
                      : "Activa el modo prueba E2E antes de escribir por Telegram si quieres que el recorrido quede controlado por el laboratorio."}
                  </p>
                )}
              </div>
            ) : (
              <>
                {showPlaythroughRestartBanner ? (
                  <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    Para una prueba controlada desde el registro, usa{" "}
                    <strong>Regenerar y validar registro</strong> en Preparar
                    caso de prueba. El caso está en un paso avanzado sin ancla
                    de recorrido actual.
                  </p>
                ) : null}
                {isRealConversationalCase ? (
                  <a
                    href={`/chat/pending?case=${encodeURIComponent(agentTestCase.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-fit rounded border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-50"
                  >
                    Abrir pendientes del caso
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => void runControlledTest("agent_e2e")}
                    disabled={
                      !agentTestCase ||
                      testCaseRunning ||
                      !canRunE2E ||
                      hasPendingLabActions ||
                      intakeIncomplete
                    }
                    className="rounded bg-violet-700 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
                    title={
                      toolsHaveBlocks
                        ? "Prueba o configura las tools requeridas antes de la prueba con agente."
                        : intakeIncomplete
                          ? "Completa el intake por Telegram antes de revisar el primer avance operativo."
                          : !canRunE2E
                            ? "Resuelve stubs, configuraciones de cuenta y tools faltantes antes de la prueba con agente."
                            : hasPendingLabActions
                              ? "Resuelve la acción humana pendiente antes de revisar de nuevo el caso."
                              : "Revisa si el caso debe avanzar por tiempo o por estado actual, con tools reales y aprobación humana si aplica."
                    }
                  >
                    {testCaseRunningMode === "agent_e2e"
                      ? "Revisando avance..."
                      : intakeIncomplete
                        ? "Completa intake en Telegram"
                        : "Revisar avance de caso"}
                  </button>
                )}
                <p className="text-[11px] text-neutral-500">
                  {isRealConversationalCase
                    ? "Este panel muestra auditoría del caso real. Para resolver acciones pendientes usa el inbox de Pendientes o Telegram."
                    : intakeIncomplete
                    ? "Ahora mismo el recorrido está en Paso 0 (intake). Continúa por Telegram para completar los datos faltantes; la primera revisión manual se habilita después."
                    : "Cada clic ejecuta una revisión real del agente sobre el caso. Los mensajes de Telegram siguen procesándose por evento; el cron no debe continuar este recorrido controlado."}
                  {hasPendingLabActions ? (
                    <span className="ml-1 text-amber-700">
                      Resuelve la acción humana pendiente antes de ejecutar otra
                      revisión.
                    </span>
                  ) : null}
                  {!hasPendingLabActions &&
                  currentStepKey === "awaiting_documents" &&
                  documentRequestTarget === "internal_user" ? (
                    <span className="ml-1 text-indigo-700">
                      Ruta interna activa: el asesor sube documentos y confirma
                      “listo”; no se envía Telegram al contacto externo.
                    </span>
                  ) : null}
                  {!canRunE2E && !toolsHaveBlocks ? (
                    <span className="ml-1 text-amber-700">
                      Deshabilitado hasta resolver {readinessCounts.stub} stubs,{" "}
                      {readinessCounts.needs_config} de cuenta y{" "}
                      {readinessCounts.missing + readinessCounts.unknown}{" "}
                      faltantes.
                    </span>
                  ) : null}
                  {e2ePendingHitl ? (
                    <span className="ml-1 text-violet-700">
                      La última revisión quedó pendiente de aprobación humana;
                      resuélvela en Pendientes o Telegram.
                    </span>
                  ) : e2eCompleted ? (
                    <span className="ml-1 text-emerald-700">
                      La última revisión del agente se completó.
                    </span>
                  ) : null}
                </p>
                {intakeIncomplete && missingRequired.length > 0 ? (
                  <div className="rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
                    <div className="font-semibold">
                      Campos pendientes para completar registro (Paso 0)
                    </div>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px]">
                      {missingRequired.map((field) => (
                        <li key={field.name ?? field.label ?? "pending-field"}>
                          {field.label?.trim() || field.name || "Campo requerido"}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {conversationalLabResult?.conversationBindings &&
                conversationalLabResult.conversationBindings.length > 0 ? (
                  <div className="rounded border border-violet-200 bg-violet-50 p-2 text-xs text-violet-900 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100">
                    <div className="font-semibold">
                      Continuidad conversacional activa
                    </div>
                    <ul className="mt-1 space-y-1 text-[11px]">
                      {conversationalLabResult.conversationBindings
                        .slice(0, 3)
                        .map((binding) => (
                          <li
                            key={binding.id}
                            className="rounded border border-violet-100 bg-white/80 px-2 py-1 font-mono text-[10px] dark:border-violet-900 dark:bg-neutral-950/50"
                          >
                            status={binding.status} · case_type={binding.case_type}
                            {binding.chat_id ? ` · chat_id=${binding.chat_id}` : ""}
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : null}
                {lastTransitionUi ? (
                  <div
                    className={`rounded border p-2 text-xs ${
                      lastTransitionUi.tone === "ready"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                        : lastTransitionUi.tone === "attention"
                          ? "border-amber-200 bg-amber-50 text-amber-900"
                          : "border-neutral-200 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900/50"
                    }`}
                  >
                    <div className="font-semibold">{lastTransitionUi.title}</div>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px]">
                      {lastTransitionUi.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {conversationalResultCase ? (
                  <LabPendingActionPanel
                    blockingActions={blockingLabActions}
                    historicalActions={historicalLabActions}
                    caseId={conversationalResultCase.id}
                    operationalStepLabels={operationalStepLabels}
                    refreshing={conversationalLabLoading}
                    transitionCount={transitionCount}
                    currentStep={currentStepKey}
                    currentStepLabel={currentStepLabel}
                    events={conversationalLabResult?.events ?? []}
                    toolCalls={conversationalLabResult?.toolCalls ?? []}
                    e2eStartEvents={conversationalLabResult?.e2eStartEvents ?? []}
                    playthroughAnchorAt={playthroughAnchorAt}
                    conversationalMode
                    intakeIncomplete={intakeIncomplete}
                    realCaseMode={isRealConversationalCase}
                    onRefresh={() =>
                      void refreshConversationalCase(row, {
                        caseId: conversationalResultCase?.id ?? agentTestCase?.id,
                      })
                    }
                  />
                ) : null}
                {agentTestCase && e2eFlowProgress.length > 0 ? (
                  <TestCaseFlowProgressSummary
                    caseStatus={agentTestCase?.status}
                    caseStatusTechnical={agentTestCase?.status ?? null}
                    currentStepTechnical={agentTestCase?.current_step ?? null}
                    flowProgress={e2eFlowProgress}
                    e2eScoped
                    hasTransitions={hasE2ETransitions}
                    intakeIncomplete={intakeIncomplete}
                    manualTransitionCount={transitionCount}
                    conversationalActivityCount={conversationalActivityCount}
                    conversationalActivity={conversationalActivity}
                  />
                ) : null}
              </>
            )}
          </div>
        </LabStepDetails>
        </div>
      );
    }

    return (
      <div className="w-full min-w-0 space-y-4">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{row.display_name}</h2>
              <p className="mt-1 font-mono text-xs text-neutral-500">
                {row.case_type}
              </p>
            </div>
            <span
              className={`rounded-md px-2 py-1 text-xs font-medium ${scopeUi.badge}`}
              title={scopeUi.hint}
            >
              {scopeUi.detailBadge}
            </span>
          </div>
          {isGlobal ? (
            <p className="mt-2 text-sm text-neutral-500">
              Esta plantilla global es solo de lectura. Puedes crear una versión
              privada para adaptarla a esta cuenta sin modificar la plantilla de
              producto.
            </p>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              Esta plantilla pertenece a la cuenta y puede editarse directamente.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-b border-neutral-200 pb-2 text-sm dark:border-neutral-800">
          {CASE_TYPE_WORKSPACE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectWorkspaceTab(tab.id, row)}
              className={`rounded-full px-3 py-1.5 font-semibold ${
                activeTab === tab.id
                  ? "bg-violet-700 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "lab" ? (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950">
            <div className="font-semibold">Laboratorio guiado</div>
            <p className="mt-1 text-xs leading-relaxed text-violet-800">
              Valida la plantilla de menor a mayor riesgo: preparar el caso de
              prueba, verificar herramientas, probar habilidades y escenarios
              por paso, y al final ejecutar una transición real con el agente.
            </p>
          </div>
        ) : null}

        {activeTab === "activation" ? (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-950">
            <div className="font-semibold">Checklist de activación</div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Esta sección responde si la plantilla está lista para usarse en
              chat/Telegram y qué falta antes de operación real completa.
            </p>
          </div>
        ) : null}

        {activeTab === "summary" && row.description ? (
          <div className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Descripción
            </div>
            {(() => {
              const { intro, steps } = descriptionParts(row.description ?? "");
              return (
                <div className="mt-2 text-neutral-700 dark:text-neutral-200">
                  <p>{intro}</p>
                  {steps.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })()}
          </div>
        ) : null}

        {activeTab === "summary" ? (
        <details className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Formulario de alta
            {fields.length > 0
              ? ` · ${fields.length} campo${fields.length === 1 ? "" : "s"}`
              : " · sin campos"}
          </summary>
          {fields.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {fields.map((field) => (
                <li key={field.name} className="text-sm">
                  <span className="font-medium">{field.label}</span>{" "}
                  <span className="text-xs text-neutral-500">
                    ({field.type}
                    {field.required ? ", requerido" : ", opcional"})
                  </span>
                  <div className="font-mono text-xs text-neutral-500">
                    {field.name}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              Sin campos iniciales configurados.
            </p>
          )}
        </details>
        ) : null}

        {activeTab === "summary" ? (
        <details className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Habilidades y herramientas
            {` · ${row.default_skill_slug}`}
            {skill && skill.includes.length > 0
              ? ` · ${skill.includes.length} atómica${skill.includes.length === 1 ? "" : "s"}`
              : ""}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-violet-50 px-2 py-1 font-mono text-violet-700">
              {row.default_skill_slug}
            </span>
            {skill ? (
              <>
                <span className="rounded bg-gray-100 px-2 py-1 text-gray-600">
                  {skillKindLabel(skill.kind)}
                </span>
                <span className="rounded bg-gray-100 px-2 py-1 text-gray-600">
                  Ámbito: {scopeText(skill.scope)}
                </span>
              </>
            ) : (
              <span className="rounded bg-red-50 px-2 py-1 text-red-700">
                habilidad no encontrada
              </span>
            )}
          </div>
          {skill?.description ? (
            <p className="mt-2 text-xs text-neutral-500">{skill.description}</p>
          ) : null}
          {skill && skill.includes.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-semibold text-neutral-600">
                Skills atómicas incluidas
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {skill.includes.map((slug) => (
                  <span
                    key={slug}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                  >
                    {slug}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {skill && skill.allowedTools.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-semibold text-neutral-600">
                Herramientas permitidas
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {skill.allowedTools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </details>
        ) : null}

        {activeTab === "lab" && !isGlobal ? (
          <div className="w-full min-w-0 space-y-3">
            <div className="space-y-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Preparación operativa
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Revisa si las herramientas de la habilidad privada existen,
                  tienen adapter y están configuradas antes de probarla.
                </p>
              </div>
              <button
                type="button"
                onClick={() => refreshToolReadiness(row)}
                disabled={toolReadinessLoading}
                className={`shrink-0 rounded px-2 py-1 text-xs font-semibold disabled:opacity-60 ${
                  shouldReviewTools
                    ? "bg-violet-700 text-white hover:bg-violet-800"
                    : "border border-neutral-300 hover:bg-neutral-50"
                }`}
              >
                {toolReadinessLoading
                  ? "Revisando..."
                  : toolReadiness
                    ? "Volver a revisar"
                    : "Revisar"}
              </button>
            </div>
            <div className="text-sm font-semibold">
              {toolReadinessSummaryLabel(toolReadiness?.summary)}
            </div>
            {toolReadiness ? (
              <>
                <p className="text-[11px] text-neutral-500">
                  {readinessCounts.visibleTotal} tools del flujo (integración y
                  acción; sin internas de plataforma).
                </p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
                    {readinessCounts.ready} de {readinessCounts.visibleTotal}{" "}
                    configuradas
                  </span>
                  {readinessCounts.untested > 0 ? (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                      {readinessCounts.untested} sin probar
                    </span>
                  ) : null}
                  {readinessCounts.testedOk > 0 ? (
                    <span className="rounded bg-emerald-50/80 px-1.5 py-0.5 text-emerald-700">
                      {readinessCounts.testedOk} probadas
                    </span>
                  ) : null}
                  {readinessCounts.needs_config > 0 ? (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                      {readinessCounts.needs_config} por configurar
                    </span>
                  ) : null}
                  {readinessCounts.stub > 0 ? (
                    <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-800">
                      {readinessCounts.stub} stubs
                    </span>
                  ) : null}
                  {readinessCounts.missing + readinessCounts.unknown > 0 ? (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-800">
                      {readinessCounts.missing + readinessCounts.unknown}{" "}
                      pendientes técnicos
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
            {toolsHaveBlocks ? (
              <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Prueba o configura las tools requeridas antes de crear una prueba
                end-to-end. Los stubs no críticos pueden quedar como
                advertencia para una prueba parcial.
              </p>
            ) : null}
            {toolReadinessError ? (
              <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                No se pudo revisar la preparación operativa: {toolReadinessError}
              </p>
            ) : null}
            </div>
            {renderTestCaseN0Card()}
            {labFlowSteps.length > 0 ? (
              <div className="space-y-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              {(() => {
                const preparationSteps = labPreparationSteps;
                const operationalSteps = labOperationalSteps;
                const transversalStep = labTransversalStep;

                const partitionSkillTools = (tools: ToolReadinessFlowTool[]) => {
                  const readinessVisible: ToolReadinessFlowTool[] = [];
                  const internal: ToolReadinessFlowTool[] = [];
                  for (const tool of tools) {
                    if (
                      isReadinessVisibleTool(tool.tool_id) ||
                      isScenarioOnlyTool(tool.tool_id)
                    ) {
                      readinessVisible.push(tool);
                    } else if (isInternalOperationalTool(tool.tool_id)) {
                      internal.push(tool);
                    } else {
                      readinessVisible.push(tool);
                    }
                  }
                  return { readinessVisible, internal };
                };

                const renderToolCard = (
                  tool: ToolReadinessFlowTool,
                  keyPrefix: string,
                  flowContext?: {
                    flowStepKey?: string;
                    skillSlug?: string;
                  }
                ) => {
                  const expansionKey = [
                    flowContext?.flowStepKey ?? "transversal_tools",
                    flowContext?.skillSlug ?? keyPrefix,
                    tool.tool_id,
                  ].join("::");

                  return tool.readiness ? (
                    <div key={expansionKey} className={READINESS_LAB_TOOL_CARD_WRAP}>
                      {tool.tool_label || tool.tool_description ? (
                        <div className="mb-1 text-xs">
                          <span className="font-semibold">
                            {tool.tool_label ?? tool.tool_id}
                          </span>
                          {tool.tool_description ? (
                            <span className="text-neutral-500">
                              {" · "}
                              {tool.tool_description}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {renderFlowToolReadiness({
                        item: tool.readiness,
                        row,
                        readinessFlowScrollEl: readinessFlowScrollRef.current,
                        expanded: expandedReadinessTools.has(expansionKey),
                        existingRequest: toolRequests.find(
                          (req) => req.tool_id === tool.tool_id
                        ),
                        submitting: toolRequestSubmitting === tool.tool_id,
                        hasTestCase: Boolean(testCaseResult?.case),
                        caseId: testCaseResult?.case?.id ?? null,
                        caseContextVersion: `${testCaseResult?.case?.updated_at ?? ""}:${testContextVersion}`,
                        readinessSkillSlug: flowContext?.skillSlug,
                        readinessFlowStepKey: flowContext?.flowStepKey,
                        onEditSkill: () => startEdit(row),
                        onToggleExpand: () =>
                          toggleReadinessToolExpand(expansionKey),
                        onRequestGlobal: () =>
                          tool.readiness &&
                          createToolRequest(row, tool.readiness),
                        onBeforeAssetUpload: () => {
                          preserveReadinessUiContext({
                            expansionKey,
                            flowStepKey: flowContext?.flowStepKey,
                            suppressToggleMs: 1500,
                            lockScrollMs: 1500,
                          });
                        },
                        onAssetUploaded: async () => {
                          preserveReadinessUiContext({
                            expansionKey,
                            flowStepKey: flowContext?.flowStepKey,
                            suppressToggleMs: 1200,
                            lockScrollMs: 1200,
                          });
                          await refreshToolReadiness(row, { silent: true });
                        },
                        refreshToolReadiness,
                        refreshTestCase,
                        onTestCaseUpdated: async (processedResult) => {
                          setTestCaseResult(processedResult);
                          setTestContextMessage(
                            "Respuesta del dueño simulada y procesada."
                          );
                          await refreshToolReadiness(row);
                        },
                        easyBrokerCreatedListingId,
                        onEasyBrokerListingCreated: (listingId) => {
                          setEasyBrokerCreatedListingId(listingId);
                          setTestContextMessage(
                            `Borrador EasyBroker de prueba creado: ${listingId}.`
                          );
                        },
                      })}
                    </div>
                  ) : null;
                };

                const renderInternalToolRow = (tool: ToolReadinessFlowTool) => {
                  const readiness = tool.readiness;
                  return (
                    <div
                      key={`${tool.tool_id}-internal`}
                      className="rounded border border-neutral-200 bg-white/80 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900/60"
                    >
                      <div className="font-mono text-[11px] text-neutral-600">
                        {tool.tool_id}
                      </div>
                      {tool.tool_label ? (
                        <div className="mt-0.5 font-semibold text-neutral-800">
                          {tool.tool_label}
                        </div>
                      ) : null}
                      {tool.tool_description ? (
                        <p className="mt-1 text-neutral-500">{tool.tool_description}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="text-neutral-400">
                          {toolSurfaceLabel(toolSurfaceKind(tool.tool_id))}
                        </span>
                        {readiness ? (
                          <span
                            className={`rounded px-1.5 py-0.5 font-semibold ${toolReadinessClass(
                              readiness.status
                            )}`}
                          >
                            {toolReadinessLabel(readiness.status)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                };

                const renderInternalToolsBlock = (
                  tools: ToolReadinessFlowTool[]
                ) => {
                  if (tools.length === 0) return null;
                  return (
                    <details className="rounded border border-dashed border-neutral-300 bg-neutral-50/80 p-2 dark:border-neutral-700 dark:bg-neutral-900/40">
                      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                        Herramientas internas
                      </summary>
                      <p className="mt-1 text-[11px] text-neutral-500">
                        No requiere «Probar tool» aquí. Se comprueba al usar
                        «Probar habilidad» o «Probar paso» en este hito.
                      </p>
                      <div className="mt-2 space-y-2">
                        {tools.map((tool) => renderInternalToolRow(tool))}
                      </div>
                    </details>
                  );
                };

                const readinessStepDetailsKey = (
                  step: ToolReadinessFlowStep,
                  stepIndex: number,
                  sectionOptions: { preparation?: boolean }
                ) =>
                  sectionOptions.preparation
                    ? `preparation::${step.step_key}`
                    : `operational::${step.step_key}::${stepIndex}`;

                const renderStepSection = (
                  step: ToolReadinessFlowStep,
                  stepIndex: number,
                  options: { preparation?: boolean }
                ) => {
                  const summaryHint = stepExpandableSummaryHint(step);
                  const stepDetailsKey = readinessStepDetailsKey(
                    step,
                    stepIndex,
                    options
                  );
                  const stepDetailsOpen = openReadinessSteps.has(stepDetailsKey);
                  return (
                      <details
                        key={stepDetailsKey}
                        open={stepDetailsOpen}
                        onToggle={(event) => {
                          const nextOpen = event.currentTarget.open;
                          setOpenReadinessSteps((prev) => {
                            const next = new Set(prev);
                            if (nextOpen) next.add(stepDetailsKey);
                            else next.delete(stepDetailsKey);
                            return next;
                          });
                        }}
                        className={READINESS_LAB_STEP_SHELL}
                      >
                        <summary className="cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden">
                          <div className="text-center">
                            <div className="flex flex-wrap items-center justify-center gap-2">
                              <span
                                className={
                                  options.preparation
                                    ? "inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800"
                                    : READINESS_LAB_STEP_BADGE
                                }
                              >
                                {options.preparation
                                  ? "Preparación del caso"
                                  : `Paso ${stepIndex + 1}`}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${readinessTestStatusPillClass(
                                  step.test_status
                                )}`}
                              >
                                {stepTestStatusLabel(
                                  step.test_status,
                                  step.step_test_progress
                                )}
                              </span>
                            </div>
                            <div className="mt-2 font-semibold">{step.step_label}</div>
                            {step.step_description ? (
                              <p className="mt-1 text-xs text-neutral-500">
                                {step.step_description}
                              </p>
                            ) : null}
                            {summaryHint ? (
                              <p className="mt-1 text-[11px] text-neutral-400">
                                {summaryHint}
                              </p>
                            ) : null}
                          </div>
                        </summary>
                        <div className={READINESS_LAB_STEP_BODY}>
                          {stepDetailsOpen && !options.preparation ? (
                            <StepTestPanel
                              step={step}
                              row={row}
                              caseTypeSlug={row.case_type}
                              hasTestCase={Boolean(testCaseResult?.case)}
                              caseId={testCaseResult?.case?.id ?? null}
                              onFinished={async () => {
                                await refreshToolReadiness(row);
                                await refreshTestCase(row);
                              }}
                            />
                          ) : null}
                          {step.step_skills.length > 0 ? (
                            step.step_skills.map((skill) => (
                              <div
                                key={skill.skill_slug}
                                className={READINESS_LAB_SKILL_SHELL}
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className={READINESS_LAB_SKILL_LABEL}>
                                      Habilidad
                                    </div>
                                    <div className="text-xs font-semibold">
                                      {skill.skill_label ??
                                        labelFromSlug(skill.skill_slug)}
                                    </div>
                                    <div className="font-mono text-[11px] text-neutral-500">
                                      {skill.skill_slug}
                                    </div>
                                  </div>
                                  <span
                                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${readinessTestStatusPillClass(
                                      skill.test_status
                                    )}`}
                                  >
                                    {skillTestStatusLabel(skill.test_status)}
                                  </span>
                                </div>
                                {skill.skill_description ? (
                                  <p className="mt-1 text-xs text-neutral-500">
                                    {skill.skill_description}
                                  </p>
                                ) : null}
                                {stepDetailsOpen && !options.preparation ? (
                                  <div className="mt-3">
                                    <SkillTestPanel
                                      skill={skill}
                                      row={row}
                                      hasTestCase={Boolean(testCaseResult?.case)}
                                      caseId={testCaseResult?.case?.id ?? null}
                                      onFinished={async () => {
                                        await refreshToolReadiness(row);
                                        await refreshTestCase(row);
                                      }}
                                    />
                                  </div>
                                ) : null}
                                <div className={READINESS_LAB_TOOLS_SECTION}>
                                  <div className={READINESS_LAB_TOOLS_LABEL}>
                                    Herramientas de integración / acción
                                  </div>
                                  {(() => {
                                    const { readinessVisible, internal } =
                                      partitionSkillTools(skill.skill_tools);
                                    if (
                                      readinessVisible.length === 0 &&
                                      internal.length === 0
                                    ) {
                                      return (
                                        <p className="text-xs text-neutral-500">
                                          Esta habilidad no declara herramientas
                                          específicas en el flujo.
                                        </p>
                                      );
                                    }
                                    return (
                                      <>
                                        {readinessVisible.map((tool) =>
                                          renderToolCard(tool, skill.skill_slug, {
                                            flowStepKey: step.step_key,
                                            skillSlug: skill.skill_slug,
                                          })
                                        )}
                                        {renderInternalToolsBlock(internal)}
                                      </>
                                    );
                                  })()}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                                Habilidad
                              </div>
                              <div className="text-xs font-semibold">
                                No aplica
                              </div>
                              <p className="mt-1 text-xs text-neutral-500">
                                Este paso usa herramientas directas del flujo
                                para crear y preparar la instancia.
                              </p>
                            </div>
                          )}
                          {step.step_tools.length > 0 ? (
                            <div className={READINESS_LAB_STEP_TOOLS_SECTION}>
                              <div className={READINESS_LAB_TOOLS_LABEL}>
                                Herramientas de integración / acción
                              </div>
                              {(() => {
                                const { readinessVisible, internal } =
                                  partitionSkillTools(step.step_tools);
                                return (
                                  <>
                                    {readinessVisible.map((tool) =>
                                      renderToolCard(tool, step.step_key, {
                                        flowStepKey: step.step_key,
                                      })
                                    )}
                                    {renderInternalToolsBlock(internal)}
                                  </>
                                );
                              })()}
                            </div>
                          ) : null}
                          {options.preparation ? (
                            <p className="text-xs text-neutral-500">
                              Este hito representa el registro inicial del caso:
                              recopilar datos mínimos, crear o completar la
                              instancia y dejarla lista para el primer paso
                              operativo. En el laboratorio, Preparar caso de
                              prueba genera esos datos de forma controlada.
                            </p>
                          ) : null}
                        </div>
                      </details>
                  );
                };

                const renderIntakeFlowReference = (step: ToolReadinessFlowStep) => {
                  const { readinessVisible, internal } = partitionSkillTools(
                    step.step_tools
                  );
                  const scenarioTools = readinessVisible.filter((tool) =>
                    isScenarioOnlyTool(tool.tool_id)
                  );
                  const intakeSummaryHint = stepExpandableSummaryHint(step);
                  return (
                    <details
                      key={step.step_key}
                      className={READINESS_LAB_STEP_SHELL}
                    >
                      <summary className="cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden">
                        <div className="text-center">
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <span className={READINESS_LAB_STEP_BADGE}>
                              Paso 0
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${readinessTestStatusPillClass(
                                step.test_status
                              )}`}
                            >
                              {stepTestStatusLabel(
                                step.test_status,
                                step.step_test_progress,
                                {
                                  allSkillsN3Ok: stepAllSkillsN3Ok(
                                    step.step_skills
                                  ),
                                }
                              )}
                            </span>
                          </div>
                          <div className="mt-2 font-semibold">{step.step_label}</div>
                          {step.step_description ? (
                            <p className="mt-1 text-xs text-neutral-500">
                              {step.step_description}
                            </p>
                          ) : null}
                          {intakeSummaryHint ? (
                            <p className="mt-1 text-[11px] text-neutral-400">
                              {intakeSummaryHint}
                            </p>
                          ) : null}
                        </div>
                      </summary>
                      <div className={READINESS_LAB_STEP_BODY}>
                        <p className="text-xs text-neutral-500">
                          El formulario y la prueba segura están en{" "}
                          <span className="font-semibold">
                            Preparar caso de prueba
                          </span>{" "}
                          arriba. Este bloque documenta el hito de runtime (
                          <span className="font-mono">intake</span>).
                        </p>
                        {scenarioTools.length > 0 ? (
                          <div className="space-y-2 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                              Alta / escenario (opcional N1)
                            </div>
                            {scenarioTools.map((tool) =>
                              renderToolCard(tool, step.step_key, {
                                flowStepKey: step.step_key,
                              })
                            )}
                          </div>
                        ) : null}
                        {renderInternalToolsBlock(internal)}
                      </div>
                    </details>
                  );
                };

                return (
                  <div
                    ref={readinessFlowScrollRef}
                    className="space-y-3 [overflow-anchor:none]"
                  >
                    {preparationSteps.map((step) => renderIntakeFlowReference(step))}
                    {operationalSteps.length > 0 || transversalStep ? (
                      <div className="space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                            Pasos operativos del flujo
                          </div>
                          <p className="mt-1 text-xs text-neutral-500">
                            En cada paso puedes probar herramientas, habilidades
                            y escenarios. La prueba con agente está al final del
                            laboratorio.
                          </p>
                        </div>
                        <div className="space-y-3">
                          {operationalSteps.map((step, stepIndex) =>
                            renderStepSection(step, stepIndex, {
                              preparation: false,
                            })
                          )}
                          {transversalStep ? (
                            <details className={READINESS_LAB_STEP_SHELL}>
                              <summary className="cursor-pointer text-center list-none marker:content-none [&::-webkit-details-marker]:hidden">
                                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                  {transversalStep.step_label}
                                </div>
                                {transversalStep.step_description ? (
                                  <p className="mt-2 text-xs text-neutral-500">
                                    {transversalStep.step_description}
                                  </p>
                                ) : null}
                                <p className="mt-1 text-[11px] text-neutral-400">
                                  {transversalStep.step_tools.length} tool
                                  {transversalStep.step_tools.length === 1
                                    ? ""
                                    : "s"}{" "}
                                  transversal
                                </p>
                              </summary>
                              <div className={READINESS_LAB_STEP_BODY}>
                                {(() => {
                                  const { readinessVisible, internal } =
                                    partitionSkillTools(transversalStep.step_tools);
                                  return (
                                    <>
                                      {readinessVisible.map((tool) =>
                                        renderToolCard(tool, "transversal", {
                                          flowStepKey: "transversal_tools",
                                        })
                                      )}
                                      {renderInternalToolsBlock(internal)}
                                    </>
                                  );
                                })()}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {toolRequestError ? (
                      <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                        {toolRequestError}
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              </div>
            ) : toolReadiness ? (
              <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
                No se requieren herramientas para esta habilidad. Puedes seguir
                con el caso de prueba.
              </p>
            ) : (
              <p className="text-xs text-neutral-500">
                {toolReadinessLoading
                  ? "Calculando herramientas requeridas..."
                  : "Pendiente: revisa herramientas antes de crear un caso de prueba."}
              </p>
            )}
            {renderTestCaseN5Card()}
          </div>
        ) : null}

        {activeTab === "instances" ? renderRelatedOperationalCases() : null}

        {activeTab === "activation" && !isGlobal ? (
          <div className="space-y-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Checks de activación
            </div>
            <p className="text-[11px] text-neutral-500">
              Validan si la <span className="font-medium">plantilla</span> puede
              usarse en modo controlado (skill, tools, caso de prueba). No
              sustituyen el estado de cada{" "}
              <span className="font-medium">Paso N</span> arriba, donde ves si
              ya probaste habilidad o paso en el laboratorio.
            </p>
            <ul className="space-y-2 text-xs">
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  skillLooksValid ? "ready" : "pending",
                  skillLooksValid ? "✓ Listo" : "Pendiente"
                )}
                <span>{activationPolicy.activation_checks.skill_valid_copy}</span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  toolsCompleteForOperation
                    ? "ready"
                    : toolReadiness
                      ? "attention"
                      : "pending",
                  toolsCompleteForOperation
                    ? "✓ Listo"
                    : toolReadiness
                      ? "Resolver tools"
                      : "Pendiente"
                )}
                <span>
                  {operationCompletenessDescription({
                    readinessCounts,
                    toolsPass,
                    policy: activationPolicy,
                  })}
                </span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  intakePrepared ? "ready" : "pending",
                  intakePrepared ? "✓ Listo" : "Pendiente"
                )}
                <span>
                  {activationSafeTestCheckCopy({
                    testPassed,
                    intakePrepared,
                    testStatus:
                      typeof testStatus === "string" ? testStatus : undefined,
                    policy: activationPolicy,
                  })}
                </span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  stepProgressCheck.status,
                  stepProgressCheck.label
                )}
                <span>{stepProgressCheck.copy}</span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  conversationalActivationReady ? "ready" : "pending",
                  conversationalActivationReady ? "✓ Listo" : "Pendiente"
                )}
                <span>
                  {activationConversationalCheckCopy({
                    ready: conversationalActivationReady,
                    policy: activationPolicy,
                  })}
                  {conversationalActivationReady &&
                  stepProgressCheck.status !== "ready" ? (
                    <span className="mt-1 block text-neutral-500">
                      Puedes abrir chat/Telegram en modo controlado; aún faltan
                      pasos por probar en el laboratorio antes de producción
                      plena.
                    </span>
                  ) : null}
                </span>
              </li>
            </ul>
          </div>
        ) : null}

        {activeTab === "summary" ? (
        <div className="flex justify-end gap-2">
          {isGlobal ? (
            <button
              type="button"
              onClick={() => startPrivateVersion(row)}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
            >
              Crear versión privada
            </button>
          ) : (
            <button
              type="button"
              onClick={() => startEdit(row)}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
            >
              Editar configuración
            </button>
          )}
        </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="w-full min-w-0 space-y-4">
      <div className="w-full rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Caso de uso seleccionado
            </div>
            <div className="mt-2 flex w-full flex-col gap-2">
              <select
                value={selectedCaseType?.id ?? ""}
                onChange={(event) => {
                  const next = sortedCaseTypes.find(
                    (row) => row.id === event.target.value
                  );
                  if (next) viewCaseType(next);
                }}
                className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="" disabled>
                  Selecciona un caso de uso
                </option>
                {sortedCaseTypes.map((row) => {
                  const duplicateName =
                    sortedCaseTypes.filter(
                      (candidate) => candidate.display_name === row.display_name
                    ).length > 1;
                  const scopeUi = templateScopePresentation(
                    scopeLabel(row) === "global"
                  );
                  return (
                    <option key={row.id} value={row.id}>
                      {duplicateName
                        ? `${row.display_name} (${scopeUi.listBadge})`
                        : row.display_name}
                    </option>
                  );
                })}
              </select>
              {selectedCaseType ? (
                <div className="flex min-w-0 flex-wrap gap-1.5 text-[11px]">
                  <span className="max-w-full truncate rounded bg-neutral-100 px-2 py-1 font-mono text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {selectedCaseType.case_type}
                  </span>
                  <span className="max-w-full truncate rounded bg-violet-50 px-2 py-1 font-mono text-violet-700">
                    {selectedCaseType.default_skill_slug}
                  </span>
                  <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {selectedCaseType.status ?? "active"}
                  </span>
                  <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {scopeLabel(selectedCaseType) === "global"
                      ? "producto"
                      : "cuenta"}
                  </span>
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-neutral-500">
              Elige la plantilla desde el selector. Los metadatos técnicos
              aparecen debajo como referencia.
            </p>
          </div>
          <button
            type="button"
            onClick={startNew}
            className="rounded bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            + Nuevo caso de uso
          </button>
        </div>
      </div>

      <section
        ref={editorPanelRef}
        className="w-full min-w-0 overflow-x-hidden rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        {editing ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">
                {editing.isNew
                  ? selectedCaseType
                    ? "Crear versión privada"
                    : "Nuevo caso de uso"
                  : "Editar caso de uso"}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                {editing.isNew && selectedCaseType
                  ? "Parte de la plantilla global seleccionada y guarda una versión privada para esta cuenta."
                  : "Describe el proceso en lenguaje natural. Gu genera un borrador de formulario y una habilidad privada; puedes ajustar lo avanzado antes de guardar."}
              </p>
            </div>

            <label className="block text-sm">
              <span className="font-medium">Identificador</span>
              <input
                value={editing.case_type}
                onChange={(event) =>
                  setEditing({ ...editing, case_type: event.target.value })
                }
                disabled={!editing.isNew || Boolean(selectedCaseType)}
                placeholder="seguimiento_post_visita"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-100"
              />
              {editing.isNew && selectedCaseType ? (
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  La versión privada conserva el identificador técnico de la
                  plantilla base. Así esta cuenta puede personalizarla sin
                  modificar la versión global de producto.
                </p>
              ) : null}
            </label>

            <label className="block text-sm">
              <span className="font-medium">Nombre visible</span>
              <input
                value={editing.display_name}
                onChange={(event) =>
                  setEditing({ ...editing, display_name: event.target.value })
                }
                placeholder="Seguimiento post-visita"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="font-medium">Descripción y procedimiento</span>
              <textarea
                value={procedureText}
                onChange={(event) => {
                  setProcedureText(event.target.value);
                  setEditing({ ...editing, description: event.target.value });
                }}
                placeholder="Ej. Cuando un lead visita una propiedad, Gu debe registrar el interés, preparar un mensaje de seguimiento, recordar al asesor si no hay respuesta y escalar si el lead muestra intención de compra."
                className="mt-1 min-h-28 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Puedes escribirla como resumen, pasos o bullets; el sistema la
                usará como base para generar/validar la habilidad.
              </p>
            </label>

            <label className="block text-sm">
              <span className="font-medium">
                Campos iniciales al poner en operación
              </span>
              <textarea
                value={fieldListText}
                onChange={(event) => setFieldListText(event.target.value)}
                placeholder="Uno por línea o separados por coma: nombre del lead, propiedad visitada, interés, canal preferido"
                className="mt-1 min-h-20 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Esto genera el formulario inicial que verás en Casos
                operacionales al poner un caso de uso en operación.
              </p>
            </label>

            <div className="space-y-2">
              <button
                type="button"
                onClick={generateOptimizedDraft}
                disabled={authoring}
                className="w-full rounded border border-violet-700 bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-wait disabled:opacity-60"
              >
                {authoring ? "Generando con skill-authoring..." : "Generar con skill-authoring"}
              </button>
              <p className="text-xs leading-relaxed text-gray-500">
                Usa la skill <code className="font-mono">skill-authoring</code>{" "}
                para proponer un SKILL.md optimizado, con rúbrica y evals para
                revisión humana.
              </p>
              {authoring || authoringProgress.length > 0 || authoringResult ? (
                <div className="rounded border border-violet-200 bg-violet-50 p-3 text-xs text-violet-950">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">
                        {authoring
                          ? `Generando con skill-authoring · ${formatElapsed(authoringElapsedMs)}`
                          : authoringResult
                            ? "Generación completada"
                            : "Proceso de generación"}
                      </div>
                      <p className="mt-1 text-violet-800">
                        {authoring
                          ? authoringProgress.at(-1)?.message ??
                            fallbackAuthoringMessage(authoringElapsedMs)
                          : authoringResult?.elapsedMs
                            ? `Listo en ${formatElapsed(authoringResult.elapsedMs)}.`
                            : "Sin proceso activo."}
                      </p>
                      {authoringResult ? (
                        <p className="mt-1 text-violet-800">
                          Intentos usados: {authoringResult.attemptsUsed ?? 1}
                          {authoringResult.metadataTruncated
                            ? " · metadata recuperada parcialmente"
                            : ""}
                        </p>
                      ) : null}
                    </div>
                    {authoring ? (
                      <button
                        type="button"
                        onClick={cancelAuthoring}
                        className="shrink-0 rounded border border-violet-300 bg-white px-2 py-1 font-semibold text-violet-800 hover:bg-violet-100"
                      >
                        Cancelar
                      </button>
                    ) : null}
                  </div>
                  <details
                    open={showAuthoringLog}
                    onToggle={(event) =>
                      setShowAuthoringLog(event.currentTarget.open)
                    }
                    className="mt-2"
                  >
                    <summary className="cursor-pointer font-semibold">
                      Detalle de ejecución
                    </summary>
                    {authoringProgress.length > 0 ? (
                      <ul
                        ref={authoringLogRef}
                        className="mt-2 max-h-44 space-y-1 overflow-auto rounded bg-white/70 p-2 font-mono text-[11px] text-violet-900"
                      >
                        {authoringProgress.map((event, index) => (
                          <li key={`${event.stage ?? event.type}-${index}`}>
                            <span className="text-violet-500">
                              {event.ts
                                ? new Date(event.ts).toLocaleTimeString()
                                : "--:--"}
                            </span>{" "}
                            {event.attempt ? `[intento ${event.attempt}] ` : ""}
                            {event.message ??
                              event.details ??
                              event.error ??
                              event.stage ??
                              event.type}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-violet-800">
                        Aún no hay eventos técnicos. El timer seguirá corriendo
                        aunque el navegador o proxy no entregue eventos parciales.
                      </p>
                    )}
                  </details>
                </div>
              ) : null}
              <button
                type="button"
                onClick={generateDraft}
                disabled={authoring}
                className="w-full rounded border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
              >
                Generar borrador básico
              </button>
              <p className="text-xs leading-relaxed text-gray-500">
                Fallback local con heurísticas simples si necesitas una
                estructura inicial rápida o si la generación asistida falla.
              </p>
            </div>

            <label className="block text-sm">
              <span className="font-medium">Skill asociada</span>
              <input
                value={editing.default_skill_slug}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    default_skill_slug: event.target.value,
                  })
                }
                placeholder="lead-follow-up-draft"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                La habilidad privada se crea/actualiza con este slug si dejas
                activada la opción de abajo. Si reutilizas una existente, debe
                cumplir el formato de skill del sistema.
              </p>
            </label>

            <label className="flex items-start gap-2 rounded border border-gray-200 p-3 text-sm">
              <input
                type="checkbox"
                checked={createPrivateSkill}
                onChange={(event) =>
                  setCreatePrivateSkill(event.target.checked)
                }
                className="mt-1"
              />
              <span>
                Crear o actualizar habilidad privada de la cuenta al guardar.
                <span className="block text-xs text-gray-500">
                  Si ya existe una habilidad privada con este slug, se carga en
                  la caja Habilidad y se actualiza al guardar.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="font-medium">Estado</span>
                <select
                  value={editing.status}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      status: event.target.value as OperationalCaseTypeStatus,
                    })
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="draft">Borrador</option>
                  <option value="active">Activo</option>
                  <option value="archived">Archivado</option>
                </select>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Activo aparece para poner en operación. Borrador permite
                  guardar sin publicarlo todavía. Archivado lo oculta del flujo
                  normal sin borrar la definición.
                </p>
              </label>

              <label className="block text-sm">
                <span className="font-medium">Visibilidad</span>
                <select
                  value={editing.visibility}
                  onChange={() =>
                    setEditing({ ...editing, visibility: "private" })
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="private">private</option>
                </select>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  V1 crea casos de uso privados. Compartir con usuarios
                  específicos o publicar como global requiere un flujo de
                  permisos separado.
                </p>
              </label>
            </div>

            <details
              open={showAdvanced}
              onToggle={(event) =>
                setShowAdvanced(event.currentTarget.open)
              }
              className="rounded border border-gray-200 p-3"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                {showAdvanced ? "Ocultar avanzado" : "Mostrar avanzado"}:
                formulario JSON y habilidad
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-gray-500">
                Usa esta sección para revisar o ajustar la definición exacta que
                guardará el sistema. El formulario JSON, el flujo operativo, la
                política de activación y la habilidad se validan al guardar.
              </p>
              <label className="mt-3 block text-sm">
                <span className="font-medium">Formulario inicial JSON</span>
                <textarea
                  value={schemaText}
                  onChange={(event) => setSchemaText(event.target.value)}
                  className="mt-1 h-56 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                />
              </label>
              <label className="mt-3 block text-sm">
                <span className="font-medium">
                  Política de activación JSON
                </span>
                <textarea
                  value={activationPolicyText}
                  onChange={(event) => {
                    setActivationPolicyText(event.target.value);
                    try {
                      const normalized = mergeActivationPolicy(
                        JSON.parse(event.target.value || "{}") as OperationalCaseActivationPolicy
                      );
                      setEditing((current) =>
                        current
                          ? { ...current, activation_policy_jsonb: normalized }
                          : current
                      );
                    } catch {
                      // Mientras el usuario edita JSON parcial, esperamos a guardar.
                    }
                  }}
                  className="mt-1 h-56 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                />
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Controla copy/reglas de prueba segura inicial y checks de
                  activación para este caso de uso sin tocar código.
                </p>
              </label>
              <label className="mt-3 block text-sm">
                <span className="font-medium">
                  Flujo operativo JSON paso → skill → tool
                </span>
                <textarea
                  value={flowText}
                  onChange={(event) => {
                    setFlowText(event.target.value);
                    try {
                      const normalized = normalizeOperationalFlow(
                        JSON.parse(event.target.value || "[]")
                      );
                      setEditing((current) =>
                        current
                          ? { ...current, operational_flow_jsonb: normalized }
                          : current
                      );
                    } catch {
                      // Mientras el usuario edita JSON parcial, esperamos a guardar.
                    }
                  }}
                  className="mt-1 h-64 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                />
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Este flow alimenta Preparación operativa y Prueba controlada.
                  skill-authoring lo propone automáticamente; aquí puedes ajustar
                  labels/descripciones o editar JSON avanzado.
                </p>
              </label>
              <label className="mt-3 block text-sm">
                <span className="font-medium">Habilidad</span>
                <textarea
                  value={generatedSkillBody}
                  onChange={(event) => setGeneratedSkillBody(event.target.value)}
                  className="mt-1 h-64 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                  placeholder="La habilidad guardada o generada aparecerá aquí."
                />
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Muestra el SKILL.md privado guardado para esta cuenta o el
                  contenido recién generado antes de guardar.{" "}
                  `includes` lista skills reutilizadas por esta habilidad
                  compuesta. `allowed_tools` lista herramientas directas de esta
                  habilidad; si todo se delega a skills incluidas, puede quedar
                  vacío. `guardrails` son reglas operativas que siempre se
                  aplican al ejecutar la habilidad.
                </p>
              </label>
              {authoringResult ? (
                <div className="mt-3 space-y-3 rounded border border-violet-200 bg-violet-50 p-3 text-xs text-violet-950">
                  <div>
                    <div className="font-semibold">Rúbrica de validación</div>
                    {authoringResult.validationRubric.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {authoringResult.validationRubric.map((item, index) => (
                          <li key={`${item.item ?? "item"}-${index}`}>
                            <span className="font-semibold">
                              {item.status ?? "WARN"}
                            </span>
                            {item.item ? ` · ${item.item}` : ""}
                            {item.note ? `: ${item.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1">Sin rúbrica estructurada.</p>
                    )}
                  </div>
                  {authoringResult.activationRecommendation ? (
                    <div>
                      <div className="font-semibold">
                        Recomendación de activación
                      </div>
                      <p className="mt-1">
                        {authoringResult.activationRecommendation}
                      </p>
                    </div>
                  ) : null}
                  {saveBlockedByAuthoring ? (
                    <p className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
                      No se puede guardar una habilidad activa mientras la
                      rúbrica tenga FAIL. Corrige el borrador y vuelve a
                      generarlo/validarlo.
                    </p>
                  ) : authoringHasWarn ? (
                    <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
                      Hay advertencias en la rúbrica. Puedes guardar, pero
                      conviene revisarlas antes de activar este caso de uso.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </details>

            {error ? (
              <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800">
                {error}
              </pre>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setEditingBaseline(null);
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || saveBlockedByAuthoring || !editingHasChanges}
                className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
              >
                {saving
                  ? "Guardando..."
                  : editingHasChanges
                    ? "Guardar"
                    : "Sin cambios"}
              </button>
            </div>
          </div>
        ) : selectedCaseType ? (
          renderCaseTypeDetail(selectedCaseType)
        ) : (
          <div className="text-sm text-neutral-500">
            Selecciona un caso de uso para ver su detalle o crea uno nuevo. Las
            plantillas globales son solo de lectura, pero puedes crear una
            versión privada para esta cuenta.
          </div>
        )}
      </section>
    </section>
  );
}
