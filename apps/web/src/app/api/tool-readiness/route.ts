import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
  listAccountAssets,
  listAccountToolSecretsPublic,
} from "@agents/db";
import {
  getSkillRegistryForUser,
  TOOL_CATALOG,
} from "@agents/agent";
import type {
  AccountToolSecretPublic,
  AccountAsset,
  OperationalCaseRequiredAsset,
  OperationalCaseFlowSkill,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  ToolDefinition,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import {
  TOOL_TO_ACCOUNT_PROVIDER,
  getAccountToolProvider,
  providerHasAccountConfig,
} from "@/lib/account-tool-providers";
import { deploymentEnvFlagsFromProcessEnv } from "@/lib/tool-readiness/load-tenant-provider-snapshot";
import {
  isEasyBrokerWebOperationalFailure,
  unggaPublishAccountState,
} from "@/lib/tool-readiness/provider-readiness";
import {
  mergeStepScenarioEvidenceMaps,
  parseStepScenarioEvidenceFromEvents,
  parseStepScenarioEvidenceFromRuns,
  resolveStepN4TestStatus,
  type StepN4ScenarioEvidence,
  type StepTestProgress,
} from "@/lib/operational-cases/step-test-scenario-evidence";
import {
  stepTestCatalogSlugForRootSkill,
  stepTestAvailable,
} from "@/lib/operational-cases/step-test-scenarios";
import { stepTestScenariosFor } from "@/lib/operational-cases/step-test-scenario-registry";
import { collectStepDecisionWarnings } from "@/lib/operational-cases/step-decision";
import { findLatestSettingsTestCaseId } from "@/lib/operational-cases/settings-test-case-lookup";
import {
  isIntakePreparationStep,
  isReadinessVisibleTool,
  partitionFlowSteps,
  readinessToolIdsForStep,
} from "@/lib/operational-cases/tool-surface-classification";
import {
  normalizeToolTestBehavior,
  toolTestBehaviorForFlowTool,
  toolTestBehaviorForTool,
  type ToolTestBehavior,
} from "@/lib/tool-readiness/tool-test-behavior";
import { VERIFIED_ADAPTER_TOOLS } from "@/lib/tool-readiness/verified-adapter-tools";
import {
  assetRequirementStatus,
  collectAssetsForScope,
  isAssetCollection,
  type AssetRequirementStatus,
} from "@/lib/tool-readiness/asset-requirements";

type ReadinessStatus = "ready" | "needs_config" | "stub" | "missing" | "unknown";
type ReadinessCategory =
  | "product_integration"
  | "account_config"
  | "tenant_asset"
  | "technical_stub"
  | "skill_definition"
  | "ready";
type ReadinessActionKind =
  | "connect_integration"
  | "configure_account"
  | "upload_asset"
  | "request_global"
  | "edit_skill"
  | "none";

type ReadinessRequestKind =
  | "incorporate_to_catalog"
  | "enable_account_config"
  | "provide_tenant_asset";

type ToolReadinessItem = {
  tool_id: string;
  status: ReadinessStatus;
  category: ReadinessCategory;
  blocking: boolean;
  action_kind: ReadinessActionKind;
  action_label: string | null;
  action_available: boolean;
  action_message: string;
  /** URL absoluta o relativa que la UI puede abrir directamente (OAuth, settings, etc.). */
  action_url: string | null;
  /** Ancla dentro de /settings cuando la acción vive ahí. */
  action_anchor: string | null;
  /** Si la acción es "solicitar al equipo del producto", qué tipo de solicitud crear. */
  request_kind: ReadinessRequestKind | null;
  /**
   * Provider canónico (en `ACCOUNT_TOOL_PROVIDERS`) cuando la tool admite
   * configuración por cuenta vía `account_tool_secrets`. La UI usa esto
   * para abrir el formulario inline (Phase 2b/2c).
   */
  account_provider: string | null;
  /** Estado actual del secret por cuenta (si existe). */
  account_secret_status: AccountToolSecretPublic["status"] | null;
  exists_in_catalog: boolean;
  adapter_available: boolean;
  risk?: string;
  requires_integration?: string;
  notes: string[];
  test_status?: "ready_untested" | "tested_ok" | "tested_failed";
  last_tested_at?: string | null;
  asset_requirements?: ToolAssetRequirementStatus[];
  test_asset_requirements?: ToolAssetRequirementStatus[];
  test_behavior: ToolTestBehavior;
};

type SkillTestStatus =
  | "blocked_by_tools"
  | "ready_to_test"
  | "tested_ok"
  | "tested_failed"
  | "partial";

type StepTestStatus =
  | "blocked"
  | "ready_to_test"
  | "partially_tested"
  | "awaiting_n4"
  | "tested_ok"
  | "tested_failed";


type CaseE2EStatus =
  | "not_ready"
  | "ready_for_e2e"
  | "e2e_passed"
  | "operational_ready";

// Extraído a lib/tool-readiness/asset-requirements.ts (Slice 2.7-3).
type ToolAssetRequirementStatus = AssetRequirementStatus;

type ReadinessSkillGraph = {
  rootName: string;
  composedFrom: string[];
  allowedTools: string[];
  warnings: string[];
};

type ToolTestEvidence = {
  status: "tested_ok" | "tested_failed";
  testedAt: string | null;
};

type SkillTestEvidence = {
  status: SkillTestStatus;
  testedAt: string | null;
};

const STUB_TOOLS = new Set<string>([]);

const EASYBROKER_TOOLS = new Set([
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "easybroker_publish_listing",
]);
const EASYBROKER_WRITE_TOOLS = new Set([
  "easybroker_create_listing",
  "easybroker_upload_images",
  "easybroker_publish_listing",
]);
const UNGGA_TOOLS = new Set(["ungga_publish_listing"]);
const AVACLICK_TOOLS = new Set(["get_avaclick_valuation"]);
const TENANT_ASSET_TOOLS = new Set([
  "generate_document_from_template",
  "image_watermark",
]);

function accountProviderLabel(providerId: string) {
  return getAccountToolProvider(providerId)?.displayName ?? providerId;
}

function enabledByUser(toolId: string, settings: UserToolSetting[]) {
  const setting = settings.find((item) => item.tool_id === toolId);
  return setting?.enabled !== false;
}

function integrationActive(
  provider: string,
  integrations: UserIntegration[],
  flags: { telegramLinked: boolean }
) {
  if (provider === "telegram_bot" && flags.telegramLinked) {
    return true;
  }
  return integrations.some(
    (item) => item.provider === provider && item.status === "active"
  );
}

function envConfigured(toolId: string) {
  const flags = deploymentEnvFlagsFromProcessEnv();
  const key = `tool:${toolId}`;
  if (key in flags) return Boolean(flags[key]);
  return true;
}

function classifyTool(params: {
  toolId: string;
  def?: ToolDefinition;
  settings: UserToolSetting[];
  integrations: UserIntegration[];
  accountSecretsByProvider: Map<string, AccountToolSecretPublic>;
  accountAssets: AccountAsset[];
  requiredAssets: OperationalCaseRequiredAsset[];
  testAssets: OperationalCaseRequiredAsset[];
  telegramLinked: boolean;
}): ToolReadinessItem {
  const notes: string[] = [];
  const exists = Boolean(params.def);
  const adapterAvailable = VERIFIED_ADAPTER_TOOLS.has(params.toolId);
  const testAssetRequirements = params.testAssets.map((requirement) =>
    assetRequirementStatus(requirement, params.accountAssets)
  );
  const base = {
    risk: params.def?.risk,
    requires_integration: params.def?.requires_integration,
    test_behavior: normalizeToolTestBehavior(
      params.toolId,
      toolTestBehaviorForTool(params.toolId)
    ),
    test_asset_requirements: testAssetRequirements.length
      ? testAssetRequirements
      : undefined,
  };

  const accountProviderId = TOOL_TO_ACCOUNT_PROVIDER[params.toolId] ?? null;
  const accountProviderConfigurable = Boolean(
    accountProviderId && providerHasAccountConfig(accountProviderId)
  );
  const accountSecret =
    accountProviderConfigurable && accountProviderId
      ? (params.accountSecretsByProvider.get(accountProviderId) ?? null)
      : null;
  const accountSecretStatus = accountSecret?.status ?? null;
  const easyBrokerWebOperationalFailure =
    accountProviderId === "easybroker_web" &&
    accountSecretStatus === "invalid" &&
    isEasyBrokerWebOperationalFailure(accountSecret?.last_error);
  const assetRequirements = params.requiredAssets.map((requirement) =>
    assetRequirementStatus(requirement, params.accountAssets)
  );
  const missingRequiredAssets = assetRequirements.filter(
    (requirement) => requirement.required !== false && !requirement.configured
  );
  // `active` significa que la última validación fue OK; los estados
  // intermedios (`pending_test`, `invalid`) se tratan más abajo como
  // needs_config con acciones específicas.
  const accountSatisfied =
    accountSecretStatus === "active" || easyBrokerWebOperationalFailure;

  if (!exists) {
    return {
      tool_id: params.toolId,
      status: "missing",
      category: "skill_definition",
      blocking: true,
      action_kind: "edit_skill",
      action_label: "Editar skill",
      action_available: true,
      action_message:
        "La herramienta no existe en el catálogo. Quita esta herramienta de la habilidad o crea/registra la herramienta antes de activar.",
      action_url: null,
      action_anchor: null,
      request_kind: null,
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: false,
      adapter_available: adapterAvailable,
      ...base,
      notes: ["No existe en TOOL_CATALOG."],
    };
  }
  if (!adapterAvailable) {
    return {
      tool_id: params.toolId,
      status: "unknown",
      category: "technical_stub",
      blocking: true,
      action_kind: "request_global",
      action_label: "Solicitar incorporación al producto",
      action_available: true,
      action_message:
        "La herramienta está en catálogo, pero todavía no tiene un adapter runtime verificado en el producto. Solicita su incorporación al equipo de Ungga para usarla en operación real.",
      action_url: null,
      action_anchor: null,
      request_kind: "incorporate_to_catalog",
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: false,
      ...base,
      notes: ["Está en catálogo, pero no está en el mapa de adapters verificados."],
    };
  }
  if (!enabledByUser(params.toolId, params.settings)) {
    notes.push("La herramienta está deshabilitada para este usuario.");
    return {
      tool_id: params.toolId,
      status: "needs_config",
      category: "account_config",
      blocking: true,
      action_kind: "configure_account",
      action_label: "Habilitar en Ajustes",
      action_available: true,
      action_message:
        "La herramienta existe, pero está deshabilitada para esta cuenta. Actívala en Ajustes → Herramientas y vuelve a revisar.",
      action_url: "/settings",
      action_anchor: "tools",
      request_kind: null,
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
    };
  }
  if (params.toolId === "ungga_publish_listing") {
    const ungga = unggaPublishAccountState(params.accountSecretsByProvider);
    if (ungga.satisfied) {
      notes.push(
        `Ungga conectado por cuenta (${accountProviderLabel(ungga.providerId)}).`
      );
      return {
        tool_id: params.toolId,
        status: "ready",
        category: "ready",
        blocking: false,
        action_kind: "none",
        action_label: null,
        action_available: false,
        action_message:
          "La herramienta está disponible para prueba controlada. Requiere confirmación humana por ser de riesgo alto.",
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: ungga.providerId,
        account_secret_status: ungga.secret?.status ?? null,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    if (envConfigured(params.toolId)) {
      notes.push(
        "Ungga disponible vía env global o pocs/ungga-cli/.env (desarrollo)."
      );
      return {
        tool_id: params.toolId,
        status: "ready",
        category: "ready",
        blocking: false,
        action_kind: "none",
        action_label: null,
        action_available: false,
        action_message:
          "La herramienta está disponible para prueba controlada. Requiere confirmación humana por ser de riesgo alto.",
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: ungga.providerId,
        account_secret_status: ungga.secret?.status ?? null,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    if (ungga.secret?.status === "pending_test") {
      notes.push("Credenciales Ungga guardadas; falta probar la conexión.");
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Probar conexión ${accountProviderLabel(ungga.providerId)}`,
        action_available: true,
        action_message: `Tienes credenciales guardadas para ${accountProviderLabel(ungga.providerId)}. Valídalas con «Probar conexión» para activar la publicación en Ungga.`,
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: ungga.providerId,
        account_secret_status: ungga.secret.status,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    if (ungga.secret?.status === "invalid") {
      notes.push(
        `Conexión Ungga inválida: ${ungga.secret.last_error ?? "error sin detalle"}.`
      );
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Reconfigurar ${accountProviderLabel(ungga.providerId)}`,
        action_available: true,
        action_message: `La última validación de Ungga falló${ungga.secret.last_error ? `: ${ungga.secret.last_error}` : ""}. Reingresa tus credenciales.`,
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: ungga.providerId,
        account_secret_status: ungga.secret.status,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    notes.push(
      "Conecta Ungga (automatización web) con tu correo y contraseña, o configura la API interna."
    );
    return {
      tool_id: params.toolId,
      status: "needs_config",
      category: "account_config",
      blocking: false,
      action_kind: "configure_account",
      action_label: "Conectar Ungga (automatización web)",
      action_available: true,
      action_message:
        "Para publicar en Ungga necesitas conectar tu cuenta (correo y contraseña de ungga.com) desde aquí o desde Ajustes → Cuentas externas.",
      action_url: null,
      action_anchor: null,
      request_kind: null,
      account_provider: "ungga_cli",
      account_secret_status: null,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
    };
  }
  if (
    params.def?.requires_integration &&
    !accountProviderConfigurable &&
    !integrationActive(params.def.requires_integration, params.integrations, {
      telegramLinked: params.telegramLinked,
    })
  ) {
    notes.push(`Requiere integración activa: ${params.def.requires_integration}.`);
    const provider = params.def.requires_integration;
    const meta = providerActionMeta(provider, params.toolId);
    return {
      tool_id: params.toolId,
      status: "needs_config",
      category: meta.category,
      blocking: true,
      action_kind: meta.action_kind,
      action_label: meta.action_label,
      action_available: meta.action_available,
      action_message: meta.action_message,
      action_url: meta.action_url,
      action_anchor: meta.action_anchor,
      request_kind: meta.request_kind,
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
    };
  }

  // Tools cuyo backend admite credenciales per-cuenta (EasyBroker, Ungga).
  // Si hay secret válido del usuario, se considera "configurada" sin
  // depender de env vars globales. Estados intermedios producen
  // needs_config con acciones específicas.
  if (accountProviderConfigurable && accountProviderId) {
    if (accountSecretStatus === "invalid" && !easyBrokerWebOperationalFailure) {
      notes.push(
        `Conexión con ${accountProviderId} falló en la última validación: ${accountSecret?.last_error ?? "error sin detalle"}.`
      );
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Reconfigurar ${accountProviderLabel(accountProviderId)}`,
        action_available: true,
        action_message: `La última validación de tu conexión con ${accountProviderLabel(accountProviderId)} falló${accountSecret?.last_error ? `: ${accountSecret.last_error}` : ""}. Reingresa tus credenciales para reintentar.`,
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: accountProviderId,
        account_secret_status: accountSecretStatus,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    if (accountSecretStatus === "pending_test") {
      notes.push(
        `Credenciales para ${accountProviderId} guardadas, pero aún no se probaron contra la API real.`
      );
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Probar conexión ${accountProviderLabel(accountProviderId)}`,
        action_available: true,
        action_message: `Tienes credenciales guardadas para ${accountProviderLabel(accountProviderId)}, pero faltan probarlas contra la API. Haz una validación para activarla.`,
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: accountProviderId,
        account_secret_status: accountSecretStatus,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
    if (accountSatisfied) {
      if (easyBrokerWebOperationalFailure) {
        notes.push(
          `EasyBroker MLS tiene credenciales guardadas, pero la última ejecución falló por automatización/sesión: ${accountSecret?.last_error ?? "error sin detalle"}. Puedes volver a probar la herramienta sin reingresar credenciales.`
        );
      } else {
        notes.push(
          `Conexión con ${accountProviderId} activa por cuenta — no depende de env vars globales.`
        );
      }
      // Cae al check de STUB / ready más abajo.
    } else if (!envConfigured(params.toolId)) {
      // Sin secret per-cuenta y sin env: ofrecemos configurarlo aquí mismo
      // (form inline en Phase 2b). El campo account_provider le dice al UI
      // qué form abrir.
      notes.push(
        `Falta credencial para ${accountProviderId}. Conecta tu cuenta para usar esta herramienta.`
      );
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Conectar ${accountProviderLabel(accountProviderId)}`,
        action_available: true,
        action_message: `Esta herramienta necesita credenciales de ${accountProviderLabel(accountProviderId)} para esta cuenta. Conéctala desde aquí mismo o desde Ajustes.`,
        action_url: null,
        action_anchor: null,
        request_kind: null,
        account_provider: accountProviderId,
        account_secret_status: accountSecretStatus,
        exists_in_catalog: true,
        adapter_available: true,
        ...base,
        notes,
      };
    }
  } else if (!envConfigured(params.toolId)) {
    // Tools sin provider per-cuenta definido: comportamiento histórico
    // (solicitar incorporación al producto).
    notes.push("Falta configuración/secret del entorno para ejecutarla.");
    const isEasyBroker = EASYBROKER_TOOLS.has(params.toolId);
    const isUngga = UNGGA_TOOLS.has(params.toolId);
    const isAvaclick = AVACLICK_TOOLS.has(params.toolId);
    const providerLabel = isEasyBroker
      ? "EasyBroker"
      : isUngga
        ? "Ungga"
        : isAvaclick
          ? "Avaclick"
        : "esta herramienta";
    return {
      tool_id: params.toolId,
      status: "needs_config",
      category: "account_config",
      blocking: true,
      action_kind: "request_global",
      action_label: `Solicitar configuración por cuenta de ${providerLabel}`,
      action_available: true,
      action_message: `Hoy ${providerLabel} se configura sólo a nivel despliegue (env vars) y aún no hay pantalla para conectarlo por cuenta. Crea una solicitud para que el equipo de Ungga habilite la configuración por tu cuenta o active la integración a nivel producto.`,
      action_url: null,
      action_anchor: null,
      request_kind: "enable_account_config",
      account_provider: null,
      account_secret_status: null,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
    };
  }
  if (missingRequiredAssets.length > 0) {
    notes.push(
      `Faltan recursos de esta cuenta: ${missingRequiredAssets
        .map((requirement) => requirement.label)
        .join(", ")}.`
    );
    return {
      tool_id: params.toolId,
      status: "needs_config",
      category: "tenant_asset",
      blocking: true,
      action_kind: "upload_asset",
      action_label:
        missingRequiredAssets.length === 1
          ? `Subir ${missingRequiredAssets[0]?.label}`
          : "Subir recursos",
      action_available: true,
      action_message:
        "Esta herramienta requiere archivos de tu cuenta. Sube o reemplaza los recursos aquí mismo; quedarán guardados para este usuario y se podrán reutilizar en el flujo.",
      action_url: null,
      action_anchor: null,
      request_kind: null,
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
      asset_requirements: assetRequirements,
    };
  }
  if (assetRequirements.length > 0) {
    notes.push("Recursos de cuenta configurados.");
  }
  if (STUB_TOOLS.has(params.toolId)) {
    const isTenantAsset = TENANT_ASSET_TOOLS.has(params.toolId);
    const tenantAssetsConfigured = isTenantAsset && assetRequirements.length > 0;
    const isEasyBrokerWrite = EASYBROKER_WRITE_TOOLS.has(params.toolId);
    notes.push(
      tenantAssetsConfigured
        ? "Recursos de cuenta configurados; queda pendiente completar el adapter real de la herramienta."
        : isTenantAsset
        ? "Requiere un recurso o configuración específica de esta cuenta."
        : isEasyBrokerWrite
          ? "Pendiente de Ungga: falta completar el adapter de escritura. Cuando esté listo, esta acción requerirá aprobación HITL del usuario antes de ejecutarse."
          : "Pendiente de Ungga: el usuario ya no puede resolver esto desde configuración; falta completar el adapter/mapeo en producto."
    );
    return {
      tool_id: params.toolId,
      status: "stub",
      category: isTenantAsset && !tenantAssetsConfigured ? "tenant_asset" : "technical_stub",
      blocking: false,
      action_kind: "request_global",
      action_label: isTenantAsset && !tenantAssetsConfigured
        ? "Solicitar configuración del recurso"
        : "Solicitar prioridad a Ungga",
      action_available: true,
      action_message: tenantAssetsConfigured
        ? "Los recursos de esta cuenta ya están cargados. Para operación real falta que Ungga conecte esta herramienta al handler final que use esos assets; mientras tanto no bloquea la prueba segura."
        : isTenantAsset
        ? "Esta herramienta necesita templates/assets por cuenta (ej. plantilla de documento o watermark). La prueba puede validar pasos seguros, pero operación real requiere que el equipo configure ese recurso para tu cuenta."
        : isEasyBrokerWrite
          ? "La conexión EasyBroker ya puede estar lista, pero esta operación de escritura todavía funciona como stub técnico. No requiere otra configuración del usuario: requiere que Ungga implemente el adapter real. Cuando esté implementada, el agente preparará la acción y pedirá aprobación HITL antes de crear o subir contenido."
          : "La conexión o el catálogo ya existen, pero esta operación todavía funciona como stub técnico. No requiere otra configuración del usuario: requiere que el equipo de Ungga complete el adapter/mapeo en el producto. Si esta capacidad es importante para tu caso de uso, puedes solicitar prioridad.",
      action_url: null,
      action_anchor: null,
      request_kind: isTenantAsset && !tenantAssetsConfigured
        ? "provide_tenant_asset"
        : "incorporate_to_catalog",
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
      asset_requirements: assetRequirements.length
        ? assetRequirements
        : undefined,
    };
  }

  notes.push("Lista para prueba controlada.");
  return {
    tool_id: params.toolId,
    status: "ready",
    category: "ready",
    blocking: false,
    action_kind: "none",
    action_label: null,
    action_available: false,
    action_message: "La herramienta está lista para prueba controlada.",
    action_url: null,
    action_anchor: null,
    request_kind: null,
    account_provider: accountProviderId,
    account_secret_status: accountSecretStatus,
    exists_in_catalog: true,
    adapter_available: true,
    ...base,
    notes,
    asset_requirements: assetRequirements.length ? assetRequirements : undefined,
  };
}

type ProviderActionMeta = {
  category: ReadinessCategory;
  action_kind: ReadinessActionKind;
  action_label: string;
  action_available: boolean;
  action_message: string;
  action_url: string | null;
  action_anchor: string | null;
  request_kind: ReadinessRequestKind | null;
};

/**
 * Decide cómo resolver una integración faltante según el proveedor.
 *
 * Hoy:
 * - google_calendar, gmail y github tienen OAuth implementado: action_url al authorize.
 * - telegram_bot se conecta por link code en Ajustes: action_anchor a #telegram.
 * - providers con pantalla por cuenta (ej. easybroker, ungga_api) se
 *   manejan antes de llegar aquí: action_kind="configure_account".
 * - tokko, wiggot u otros providers aún no soportados: solicitar
 *   incorporación/configuración.
 * - cualquier otro provider desconocido: pedir incorporación al catálogo.
 */
function providerActionMeta(
  provider: string,
  toolId: string
): ProviderActionMeta {
  if (provider === "google_calendar") {
    return {
      category: "product_integration",
      action_kind: "connect_integration",
      action_label: "Conectar Google Calendar",
      action_available: true,
      action_message:
        "Conecta tu cuenta de Google Calendar para autorizar a Gu a leer y crear eventos.",
      action_url: "/api/integrations/google/authorize",
      action_anchor: null,
      request_kind: null,
    };
  }
  if (provider === "gmail") {
    return {
      category: "product_integration",
      action_kind: "connect_integration",
      action_label: "Conectar Gmail",
      action_available: true,
      action_message:
        "Conecta Gmail para autorizar a Gu a enviar correos aprobados desde tu cuenta.",
      action_url: "/api/integrations/gmail/authorize",
      action_anchor: null,
      request_kind: null,
    };
  }
  if (provider === "github") {
    return {
      category: "product_integration",
      action_kind: "connect_integration",
      action_label: "Conectar GitHub",
      action_available: true,
      action_message:
        "Conecta GitHub para que Gu pueda leer/crear repos e issues por tu cuenta.",
      action_url: "/api/integrations/github/authorize",
      action_anchor: null,
      request_kind: null,
    };
  }
  if (provider === "telegram_bot") {
    return {
      category: "product_integration",
      action_kind: "connect_integration",
      action_label: "Vincular Telegram",
      action_available: true,
      action_message:
        "Vincula tu cuenta de Telegram desde Ajustes para que Gu pueda enviarte y enviar a contactos externos mensajes.",
      action_url: "/settings",
      action_anchor: "telegram",
      request_kind: null,
    };
  }
  if (provider === "ungga") {
    return {
      category: "account_config",
      action_kind: "configure_account",
      action_label: "Conectar Ungga (automatización web)",
      action_available: true,
      action_message:
        "Conecta tu cuenta de ungga.com (correo y contraseña) en Ajustes → Cuentas externas para publicar fichas desde Gu OS.",
      action_url: "/settings",
      action_anchor: "external-accounts",
      request_kind: null,
    };
  }
  // Provider desconocido (tokko, wiggot, whatsapp, etc.): aún no hay flujo.
  const isCommonCrmLike =
    /tokko|wiggot|whatsapp|hubspot|salesforce|pipedrive/i.test(provider);
  return {
    category: isCommonCrmLike ? "account_config" : "product_integration",
    action_kind: "request_global",
    action_label: `Solicitar incorporación de ${provider}`,
    action_available: true,
    action_message: `La herramienta ${toolId} requiere la integración "${provider}" que todavía no está disponible en el producto. Crea una solicitud para que el equipo de Ungga la incorpore o configure por tu cuenta.`,
    action_url: null,
    action_anchor: null,
    request_kind: isCommonCrmLike
      ? "enable_account_config"
      : "incorporate_to_catalog",
  };
}

function resolveSkillToolsFromMetadata(
  rootName: string,
  registry: Awaited<ReturnType<typeof getSkillRegistryForUser>>
): ReadinessSkillGraph {
  const order: string[] = [];
  const warnings: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(slug: string, trail: string[]) {
    if (visited.has(slug)) return;
    if (visiting.has(slug)) {
      warnings.push(`Ciclo detectado en includes: ${[...trail, slug].join(" -> ")}.`);
      return;
    }
    const record = registry.get(slug);
    if (!record) {
      warnings.push(`Skill incluida no encontrada: ${slug}.`);
      return;
    }
    visiting.add(slug);
    for (const include of record.metadata.includes) {
      visit(include, [...trail, slug]);
    }
    visiting.delete(slug);
    visited.add(slug);
    order.push(slug);
  }

  visit(rootName, []);

  const allowedTools: string[] = [];
  const seenTools = new Set<string>();
  for (const slug of order) {
    const record = registry.get(slug);
    if (!record) continue;
    for (const tool of record.metadata.allowedTools) {
      if (!seenTools.has(tool)) {
        seenTools.add(tool);
        allowedTools.push(tool);
      }
    }
  }

  return {
    rootName,
    composedFrom: order,
    allowedTools: pruneToolsForOperationalReadiness(rootName, allowedTools),
    warnings,
  };
}

function pruneToolsForOperationalReadiness(rootName: string, toolIds: string[]) {
  if (
    rootName === "property-optioning-coach" &&
    toolIds.includes("bigquery_lookup_local_comparables")
  ) {
    return toolIds.filter((toolId) => toolId !== "bigquery_run_query");
  }
  return toolIds;
}

function labelFromSlug(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

async function toolTestEvidenceForUser(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  toolIds: string[]
) {
  if (toolIds.length === 0) return new Map<string, ToolTestEvidence>();
  const { data: sessions, error: sessionsError } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("channel", "web")
    .order("created_at", { ascending: false })
    .limit(50);
  if (sessionsError) {
    console.warn("[tool-readiness] tool test session lookup failed:", sessionsError);
    return new Map<string, ToolTestEvidence>();
  }
  const sessionIds = (sessions ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  if (sessionIds.length === 0) return new Map<string, ToolTestEvidence>();
  const { data: calls, error: callsError } = await db
    .from("tool_calls")
    .select("tool_name,status,finished_at,created_at,turn_id")
    .in("session_id", sessionIds)
    .in("tool_name", Array.from(new Set(toolIds)))
    .in("status", ["executed", "failed"])
    .is("turn_id", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (callsError) {
    console.warn("[tool-readiness] tool test call lookup failed:", callsError);
    return new Map<string, ToolTestEvidence>();
  }
  const evidence = new Map<string, ToolTestEvidence>();
  for (const call of calls ?? []) {
    const row = call as {
      tool_name?: unknown;
      status?: unknown;
      finished_at?: unknown;
      created_at?: unknown;
    };
    if (typeof row.tool_name !== "string" || evidence.has(row.tool_name)) continue;
    evidence.set(row.tool_name, {
      status: row.status === "executed" ? "tested_ok" : "tested_failed",
      testedAt:
        typeof row.finished_at === "string"
          ? row.finished_at
          : typeof row.created_at === "string"
            ? row.created_at
            : null,
    });
  }
  return evidence;
}

function applyToolTestEvidence(
  tool: ToolReadinessItem,
  evidence: Map<string, ToolTestEvidence>
): ToolReadinessItem {
  const missingRequiredTestAsset = tool.test_asset_requirements?.some(
    (requirement) => requirement.min_count > 0 && !requirement.configured
  );
  if (missingRequiredTestAsset) {
    return {
      ...tool,
      test_status: "ready_untested",
      last_tested_at: null,
    };
  }
  const item = evidence.get(tool.tool_id);
  if (!item) {
    return {
      ...tool,
      test_status: "ready_untested",
      last_tested_at: null,
    };
  }
  return {
    ...tool,
    test_status: item.status,
    last_tested_at: item.testedAt,
  };
}

function toolReadyAndTested(tool: ToolReadinessItem | null) {
  return tool?.status === "ready" && tool.test_status === "tested_ok";
}

function toolReadyButUntested(tool: ToolReadinessItem | null) {
  return tool?.status === "ready" && tool.test_status !== "tested_ok";
}

function readinessGatingTools(
  tools: Array<{ tool_id: string; readiness: ToolReadinessItem | null }>
): Array<ToolReadinessItem | null> {
  return tools
    .filter((tool) => isReadinessVisibleTool(tool.tool_id))
    .map((tool) => tool.readiness);
}

function skillTestStatus(
  tools: Array<{ tool_id: string; readiness: ToolReadinessItem | null }>
): SkillTestStatus {
  const gating = readinessGatingTools(tools);
  if (gating.some((tool) => !tool || tool.blocking || tool.status !== "ready")) {
    return "blocked_by_tools";
  }
  if (gating.some((tool) => tool?.test_status === "tested_failed")) return "tested_failed";
  if (gating.some(toolReadyButUntested)) return "blocked_by_tools";
  if (gating.length > 0 && gating.every(toolReadyAndTested)) return "ready_to_test";
  return "ready_to_test";
}

function stepTestStatus(
  skills: Array<{ test_status?: SkillTestStatus }>,
  tools: Array<{ tool_id: string; readiness: ToolReadinessItem | null }>,
  options?: {
    stepKey: string;
    catalogSlug: string;
    scenarioEvidence?: Map<string, StepN4ScenarioEvidence>;
    progressOut?: { progress: StepTestProgress | null };
  }
): StepTestStatus {
  const skillStatuses = skills.map((skill) => skill.test_status);
  const gating = readinessGatingTools(tools);
  if (gating.some((tool) => !tool || tool.blocking || tool.status !== "ready")) {
    return "blocked";
  }
  if (skillStatuses.some((status) => status === "blocked_by_tools")) return "blocked";
  if (
    skillStatuses.some((status) => status === "tested_failed") ||
    gating.some((tool) => tool?.test_status === "tested_failed")
  ) {
    return "tested_failed";
  }
  const directToolsOk = gating.length === 0 || gating.every(toolReadyAndTested);
  const allSkillsOk =
    skillStatuses.length === 0 ||
    skillStatuses.every((status) => status === "tested_ok");
  const n4Required =
    options != null && stepTestAvailable(options.catalogSlug, options.stepKey);

  if (n4Required && options) {
    const resolved = resolveStepN4TestStatus({
      catalogSlug: options.catalogSlug,
      stepKey: options.stepKey,
      scenarioEvidence: options.scenarioEvidence?.get(options.stepKey),
      allSkillsOk,
      directToolsOk,
    });
    if (options.progressOut) {
      options.progressOut.progress = resolved.progress;
    }
    return resolved.status;
  }

  if (allSkillsOk && directToolsOk) {
    return "tested_ok";
  }
  if (
    skillStatuses.some((status) => status === "tested_ok" || status === "partial") ||
    gating.some((tool) => tool?.test_status === "tested_ok")
  ) {
    return "partially_tested";
  }
  return "ready_to_test";
}

function applySkillTestEvidence<T extends { skill_slug: string; test_status?: SkillTestStatus }>(
  skills: T[],
  evidence: Map<string, SkillTestEvidence>
): T[] {
  return skills.map((skill) => {
    const item = evidence.get(skill.skill_slug);
    return item ? { ...skill, test_status: item.status } : skill;
  });
}

async function skillTestEvidenceForCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string | null
) {
  const evidence = new Map<string, SkillTestEvidence>();
  if (!caseId) return evidence;
  const events = await getRecentOperationalCaseEvents(db, caseId, 100);
  for (const event of events) {
    const payload = event.payload_jsonb as Record<string, unknown> | null;
    if (payload?.kind !== "skill_test_completed") continue;
    const slug = typeof payload.skill_slug === "string" ? payload.skill_slug : null;
    if (!slug) continue;
    const rawStatus =
      typeof payload.status === "string" ? payload.status : "tested_failed";
    const status: SkillTestStatus =
      rawStatus === "tested_ok" || rawStatus === "partial"
        ? rawStatus
        : "tested_failed";
    evidence.set(slug, { status, testedAt: event.created_at });
  }
  return evidence;
}

async function stepScenarioEvidenceForCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string | null
) {
  if (!caseId) return new Map<string, StepN4ScenarioEvidence>();
  const { data: runs, error: runsError } = await db
    .from("operational_case_test_runs")
    .select("level,status,step_key,scenario_id,result_jsonb,finished_at,created_at")
    .eq("case_id", caseId)
    .eq("level", "n4")
    .in("status", ["completed", "failed"])
    .order("created_at", { ascending: true })
    .limit(500);
  if (runsError) {
    console.warn("[tool-readiness] step scenario run lookup failed:", runsError);
  }
  const runEvidence = runsError
    ? new Map<string, StepN4ScenarioEvidence>()
    : parseStepScenarioEvidenceFromRuns(runs ?? []);

  const events = await getRecentOperationalCaseEvents(db, caseId, 200);
  const eventEvidence = parseStepScenarioEvidenceFromEvents(events);
  return mergeStepScenarioEvidenceMaps(runEvidence, eventEvidence);
}

function caseE2EStatus(
  flow: Array<{ step_key: string; test_status?: StepTestStatus }>
): CaseE2EStatus {
  const { operationalSteps } = partitionFlowSteps(flow);
  const procedure = operationalSteps.filter((step) => step.test_status != null);
  if (procedure.some((step) => step.test_status === "blocked")) return "not_ready";
  if (
    procedure.length > 0 &&
    procedure.every((step) => step.test_status === "tested_ok")
  ) {
    return "ready_for_e2e";
  }
  return "not_ready";
}

function fallbackOperationalFlow(
  resolved: ReadinessSkillGraph,
  registry: Awaited<ReturnType<typeof getSkillRegistryForUser>>
): OperationalCaseFlowStep[] {
  const root = registry.get(resolved.rootName);
  const rootIncludes = root?.metadata.includes ?? [];
  if (rootIncludes.length === 0) {
    return [
      {
        step_key: "main",
        step_label: "Flujo principal",
        step_description:
          "Flujo inferido desde la skill porque este caso de uso aún no tiene operational_flow_jsonb configurado.",
        step_skills: [
          {
            skill_slug: resolved.rootName,
            skill_label: labelFromSlug(resolved.rootName),
            skill_description: root?.metadata.description,
            skill_tools: resolved.allowedTools.map((toolId) => ({
              tool_id: toolId,
              tool_label: labelFromSlug(toolId),
            })),
          },
        ],
        step_tools: [],
      },
    ];
  }

  return rootIncludes.map((slug, index) => {
    const record = registry.get(slug);
    return {
      step_key: `step_${index + 1}`,
      step_label: labelFromSlug(slug),
      step_description:
        "Paso inferido desde la composición de skills. Configura operational_flow_jsonb para ajustar el procedimiento.",
      step_skills: [
        {
          skill_slug: slug,
          skill_label: labelFromSlug(slug),
          skill_description: record?.metadata.description,
          skill_tools:
            record?.metadata.allowedTools.map((toolId) => ({
              tool_id: toolId,
              tool_label: labelFromSlug(toolId),
            })) ?? [],
        },
      ],
      step_tools: [],
    } satisfies OperationalCaseFlowStep;
  });
}

function enrichFlow(params: {
  flow: OperationalCaseFlowStep[];
  toolsById: Map<string, ReturnType<typeof classifyTool>>;
  resolved: ReadinessSkillGraph;
  registry: Awaited<ReturnType<typeof getSkillRegistryForUser>>;
  skillEvidence?: Map<string, SkillTestEvidence>;
  scenarioEvidence?: Map<string, StepN4ScenarioEvidence>;
  catalogSlug: string;
}) {
  const sourceFlow =
    params.flow.length > 0
      ? params.flow
      : fallbackOperationalFlow(params.resolved, params.registry);
  const mapped = new Set<string>();
  const allowedToolIds = new Set(params.resolved.allowedTools);

  function enrichTool(
    tool: OperationalCaseFlowTool,
    ctx?: { flowStepKey?: string; skillSlug?: string }
  ) {
    mapped.add(tool.tool_id);
    const readiness = params.toolsById.get(tool.tool_id) ?? null;
    return {
      ...tool,
      readiness: readiness
        ? {
            ...readiness,
            test_behavior: normalizeToolTestBehavior(
              tool.tool_id,
              toolTestBehaviorForFlowTool(tool, ctx)
            ),
          }
        : null,
    };
  }

  const flow = sourceFlow.map((step) => {
    const enrichedSkills = (step.step_skills ?? []).map((skill: OperationalCaseFlowSkill) => {
      const skillCtx = {
        flowStepKey: step.step_key,
        skillSlug: skill.skill_slug,
      };
      const skillTools = (skill.skill_tools ?? [])
        .filter((tool) => allowedToolIds.has(tool.tool_id))
        .map((tool) => enrichTool(tool, skillCtx));
      return {
        ...skill,
        skill_tools: skillTools,
        test_status: skillTestStatus(skillTools),
      };
    });
    const evidencedSkills = applySkillTestEvidence(
      enrichedSkills,
      params.skillEvidence ?? new Map()
    );
    const stepTools = (step.step_tools ?? [])
      .filter((tool) => allowedToolIds.has(tool.tool_id))
      .map((tool) =>
        enrichTool(tool, { flowStepKey: step.step_key })
      );
    const progressHolder: { progress: StepTestProgress | null } = { progress: null };
    const test_status = stepTestStatus(evidencedSkills, stepTools, {
      stepKey: step.step_key,
      catalogSlug: params.catalogSlug,
      scenarioEvidence: params.scenarioEvidence,
      progressOut: progressHolder,
    });
    return {
      ...step,
      step_kind: isIntakePreparationStep(step.step_key)
        ? ("preparation" as const)
        : ("operational" as const),
      readiness_tool_ids: readinessToolIdsForStep(step),
      step_skills: evidencedSkills,
      step_tools: stepTools,
      test_status,
      step_test_progress: progressHolder.progress ?? undefined,
    };
  });

  const unmappedTools = params.resolved.allowedTools
    .filter((toolId) => !mapped.has(toolId))
    .map((toolId) => ({
      tool_id: toolId,
      tool_label: labelFromSlug(toolId),
      readiness: params.toolsById.get(toolId) ?? null,
    }));

  if (unmappedTools.length > 0) {
    flow.push({
      step_key: "transversal_tools",
      step_label: "Herramientas transversales / soporte",
      step_description:
        "Herramientas permitidas por la habilidad que no pertenecen a un paso específico (auditoría, contexto del usuario, referencias internas). El agente puede usarlas en cualquier paso.",
      step_kind: "operational",
      readiness_tool_ids: [],
      step_skills: [],
      step_tools: unmappedTools,
      test_status: stepTestStatus([], unmappedTools, {
        stepKey: "transversal_tools",
        catalogSlug: params.catalogSlug,
        scenarioEvidence: params.scenarioEvidence,
      }),
      step_test_progress: undefined,
    });
  }

  return flow;
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const caseTypeId = searchParams.get("case_type_id")?.trim();
    if (!caseTypeId) {
      return NextResponse.json({ error: "case_type_id required" }, { status: 400 });
    }

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType || (caseType.user_id && caseType.user_id !== user.id)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const ownFlow = Array.isArray(caseType.operational_flow_jsonb)
      ? caseType.operational_flow_jsonb
      : [];
    const globalCaseType =
      ownFlow.length === 0 && caseType.user_id
        ? await getGlobalOperationalCaseTypeBySlug(db, caseType.case_type)
        : null;
    const inheritedFlow = Array.isArray(globalCaseType?.operational_flow_jsonb)
      ? globalCaseType.operational_flow_jsonb
      : [];
    const sourceFlow = ownFlow.length > 0 ? ownFlow : inheritedFlow;
    const registry = await getSkillRegistryForUser(db, user.id);
    const resolved = resolveSkillToolsFromMetadata(
      caseType.default_skill_slug,
      registry
    );
    const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    const requiredAssetsByTool = collectAssetsForScope(
      sourceFlow,
      resolved.allowedTools,
      catalogById,
      "account"
    );
    const testAssetsByTool = collectAssetsForScope(
      sourceFlow,
      resolved.allowedTools,
      catalogById,
      "test"
    );
    const allAssetRequirements = [
      ...Array.from(requiredAssetsByTool.values()).flat(),
      ...Array.from(testAssetsByTool.values()).flat(),
    ];
    const requiredAssetKeys = Array.from(
      new Set(
        allAssetRequirements.map((asset) => asset.asset_key)
      )
    );
    const assetKeyPrefixes = Array.from(
      new Set(
        allAssetRequirements
          .filter(isAssetCollection)
          .map((asset) => asset.asset_key)
      )
    );

    const [
      { data: toolSettings },
      { data: integrations },
      { data: telegramAccount },
      accountSecrets,
      accountAssets,
    ] = await Promise.all([
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id),
      supabase
        .from("telegram_accounts")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle(),
      listAccountToolSecretsPublic(db, user.id),
      listAccountAssets(db, {
        userId: user.id,
        assetKeys: requiredAssetKeys,
        assetKeyPrefixes,
      }),
    ]);

    const telegramLinked = Boolean(telegramAccount);
    const accountSecretsByProvider = new Map<string, AccountToolSecretPublic>();
    for (const secret of accountSecrets) {
      accountSecretsByProvider.set(secret.provider, secret);
    }
    const rawTools = resolved.allowedTools.map((toolId) =>
      classifyTool({
        toolId,
        def: catalogById.get(toolId),
        settings: (toolSettings ?? []) as UserToolSetting[],
        integrations: (integrations ?? []) as UserIntegration[],
        accountSecretsByProvider,
        accountAssets,
        requiredAssets: requiredAssetsByTool.get(toolId) ?? [],
        testAssets: testAssetsByTool.get(toolId) ?? [],
        telegramLinked,
      })
    );
    const toolEvidence = await toolTestEvidenceForUser(
      db,
      user.id,
      rawTools.map((tool) => tool.tool_id)
    );
    const tools = rawTools.map((tool) => applyToolTestEvidence(tool, toolEvidence));
    const toolsById = new Map(tools.map((tool) => [tool.tool_id, tool]));
    const testCaseId = await findLatestSettingsTestCaseId(
      db,
      user.id,
      caseType.id,
      caseType.case_type
    );
    const skillEvidence = await skillTestEvidenceForCase(db, testCaseId);
    const scenarioEvidence = await stepScenarioEvidenceForCase(db, testCaseId);
    const catalogSlug =
      stepTestCatalogSlugForRootSkill(caseType.default_skill_slug) ??
      caseType.case_type;
    const flow = enrichFlow({
      flow: sourceFlow,
      toolsById,
      resolved,
      registry,
      skillEvidence,
      scenarioEvidence,
      catalogSlug,
    });
    const case_e2e_status = caseE2EStatus(flow);
    const { preparationSteps, operationalSteps } = partitionFlowSteps(
      flow.filter((step) => step.step_key !== "transversal_tools")
    );

    const step_decision_warnings = sourceFlow.flatMap((step) =>
      collectStepDecisionWarnings({
        step,
        knownScenarioIds: stepTestScenariosFor(catalogSlug, step.step_key).map(
          (s) => s.id
        ),
      })
    );

    const hasBlocking = tools.some(
      (tool) => tool.blocking && isReadinessVisibleTool(tool.tool_id)
    );
    const hasStub = tools.some((tool) => tool.status === "stub");
    const summary = hasBlocking
      ? "needs_config"
      : hasStub
        ? "has_stubs"
        : "ready";

    return NextResponse.json({
      ok: true,
      caseType: {
        id: caseType.id,
        case_type: caseType.case_type,
        default_skill_slug: caseType.default_skill_slug,
      },
      skill: {
        root: resolved.rootName,
        composedFrom: resolved.composedFrom,
        allowedTools: resolved.allowedTools,
        warnings: resolved.warnings,
      },
      summary,
      case_e2e_status,
      tools,
      flow,
      flow_preparation: preparationSteps,
      flow_operational: operationalSteps,
      step_decision_warnings,
    });
  } catch (err) {
    console.error("[GET /api/tool-readiness] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
