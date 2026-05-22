import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCaseTypeById,
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
import { providerHasAccountConfig } from "@/lib/account-tool-providers";

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
  asset_requirements?: ToolAssetRequirementStatus[];
  test_asset_requirements?: ToolAssetRequirementStatus[];
};

type ToolAssetRequirementStatus = OperationalCaseRequiredAsset & {
  configured: boolean;
  asset: AccountAsset | null;
};

const TOOL_TEST_ASSET_REQUIREMENTS: Record<string, OperationalCaseRequiredAsset[]> = {
  image_watermark: [
    {
      asset_key: "test_image_watermark_source",
      label: "Foto fuente para probar watermark",
      description:
        "Carga una foto temporal de una propiedad para validar cómo se aplica la marca de agua.",
      accept: ["image/jpeg", "image/png", "image/webp"],
      max_size_mb: 15,
      required: true,
    },
  ],
};

type ReadinessSkillGraph = {
  rootName: string;
  composedFrom: string[];
  allowedTools: string[];
  warnings: string[];
};

const ADAPTER_TOOLS = new Set([
  "get_user_preferences",
  "list_enabled_tools",
  "read_skill_reference",
  "bigquery_run_query",
  "calendar_list_events",
  "calendar_create_event",
  "calendar_update_event",
  "operational_case_create",
  "operational_case_update_state",
  "operational_case_add_event",
  "notify_user",
  "telegram_send_message_to_contact",
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "bigquery_lookup_local_comparables",
  "generate_document_from_template",
  "image_watermark",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
]);

const STUB_TOOLS = new Set([
  "bigquery_lookup_local_comparables",
  "easybroker_create_listing",
  "easybroker_upload_images",
]);

const EASYBROKER_TOOLS = new Set([
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "easybroker_create_listing",
  "easybroker_upload_images",
]);
const EASYBROKER_WRITE_TOOLS = new Set([
  "easybroker_create_listing",
  "easybroker_upload_images",
]);
const UNGGA_TOOLS = new Set(["ungga_publish_listing"]);
const TENANT_ASSET_TOOLS = new Set([
  "generate_document_from_template",
  "image_watermark",
]);

/**
 * Mapeo tool → provider canónico de `account_tool_secrets` (ver
 * `apps/web/src/lib/account-tool-providers.ts`). Cuando una tool aparece
 * aquí, la presencia de un secret per-account activo se considera
 * equivalente a tener configuración global por env vars.
 */
const TOOL_TO_ACCOUNT_PROVIDER: Record<string, string> = {
  easybroker_search_listings: "easybroker_web",
  easybroker_search_closed_deals: "easybroker_web",
  easybroker_create_listing: "easybroker",
  easybroker_upload_images: "easybroker",
  ungga_publish_listing: "ungga_cli",
};

/** Providers que satisfacen `ungga_publish_listing` (cualquiera activo basta). */
const UNGGA_PUBLISH_ACCOUNT_PROVIDERS = ["ungga_cli", "ungga_api"] as const;

const ACCOUNT_PROVIDER_LABELS: Record<string, string> = {
  easybroker: "EasyBroker",
  easybroker_web: "EasyBroker MLS (automatización web)",
  ungga_api: "Ungga API",
  ungga_cli: "Ungga (automatización web)",
};

function accountProviderLabel(providerId: string) {
  return ACCOUNT_PROVIDER_LABELS[providerId] ?? providerId;
}

function unggaPublishAccountState(
  accountSecretsByProvider: Map<string, AccountToolSecretPublic>
) {
  for (const providerId of UNGGA_PUBLISH_ACCOUNT_PROVIDERS) {
    const secret = accountSecretsByProvider.get(providerId) ?? null;
    if (secret?.status === "active") {
      return { providerId, secret, satisfied: true };
    }
  }
  for (const providerId of UNGGA_PUBLISH_ACCOUNT_PROVIDERS) {
    const secret = accountSecretsByProvider.get(providerId) ?? null;
    if (secret) {
      return { providerId, secret, satisfied: false };
    }
  }
  return {
    providerId: "ungga_cli" as const,
    secret: null as AccountToolSecretPublic | null,
    satisfied: false,
  };
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
  if (
    toolId === "easybroker_search_listings" ||
    toolId === "easybroker_search_closed_deals"
  ) {
    return Boolean(
      process.env.EASYBROKER_WEB_EMAIL?.trim() &&
        process.env.EASYBROKER_WEB_PASSWORD?.trim()
    );
  }
  if (
    toolId === "easybroker_create_listing" ||
    toolId === "easybroker_upload_images"
  ) {
    return Boolean(process.env.EASYBROKER_API_KEY?.trim());
  }
  if (toolId === "ungga_publish_listing") {
    return Boolean(
      process.env.UNGGA_INTERNAL_API_BASE?.trim() &&
        process.env.UNGGA_INTERNAL_API_TOKEN?.trim()
    ) || Boolean(
      process.env.UNGGA_CLI_ENABLED?.trim().toLowerCase() === "true" &&
        ((
          process.env.UNGGA_STAGING_URL?.trim() &&
          process.env.UNGGA_STAGING_EMAIL?.trim() &&
          process.env.UNGGA_STAGING_PASSWORD?.trim()
        ) ||
          localUnggaCliEnvAvailable())
    ) || localUnggaCliEnvAvailable();
  }
  return true;
}

function localUnggaCliEnvAvailable() {
  if (process.env.NODE_ENV === "production") return false;
  const pocDir = resolveLocalUnggaCliDir();
  return Boolean(pocDir && existsSync(path.join(pocDir, ".env")));
}

function resolveLocalUnggaCliDir() {
  const configured = process.env.UNGGA_CLI_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "pocs", "ungga-cli"),
    path.resolve(cwd, "..", "..", "pocs", "ungga-cli"),
  ];
  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "src", "publish-listing.mjs"))
  );
}

function collectRequiredAssets(flow: OperationalCaseFlowStep[]) {
  const byTool = new Map<string, OperationalCaseRequiredAsset[]>();
  const addTool = (tool: OperationalCaseFlowTool) => {
    const requirements = Array.isArray(tool.required_assets)
      ? tool.required_assets.filter(
          (item): item is OperationalCaseRequiredAsset =>
            Boolean(item?.asset_key && item.label)
        )
      : [];
    if (requirements.length === 0) return;
    byTool.set(tool.tool_id, [
      ...(byTool.get(tool.tool_id) ?? []),
      ...requirements,
    ]);
  };
  for (const step of flow) {
    for (const tool of step.step_tools ?? []) addTool(tool);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) addTool(tool);
    }
  }
  return byTool;
}

function collectTestAssets(
  flow: OperationalCaseFlowStep[],
  allowedTools: string[]
) {
  const byTool = new Map<string, OperationalCaseRequiredAsset[]>();
  const add = (toolId: string, requirements: OperationalCaseRequiredAsset[]) => {
    if (requirements.length === 0) return;
    byTool.set(toolId, [...(byTool.get(toolId) ?? []), ...requirements]);
  };
  const addTool = (tool: OperationalCaseFlowTool) => {
    add(
      tool.tool_id,
      Array.isArray(tool.test_assets)
        ? tool.test_assets.filter(
            (item): item is OperationalCaseRequiredAsset =>
              Boolean(item?.asset_key && item.label)
          )
        : []
    );
  };
  for (const step of flow) {
    for (const tool of step.step_tools ?? []) addTool(tool);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) addTool(tool);
    }
  }
  for (const toolId of allowedTools) {
    add(toolId, TOOL_TEST_ASSET_REQUIREMENTS[toolId] ?? []);
  }
  return byTool;
}

function classifyTool(params: {
  toolId: string;
  def?: ToolDefinition;
  settings: UserToolSetting[];
  integrations: UserIntegration[];
  accountSecretsByProvider: Map<string, AccountToolSecretPublic>;
  accountAssetsByKey: Map<string, AccountAsset>;
  requiredAssets: OperationalCaseRequiredAsset[];
  testAssets: OperationalCaseRequiredAsset[];
  telegramLinked: boolean;
}): ToolReadinessItem {
  const notes: string[] = [];
  const exists = Boolean(params.def);
  const adapterAvailable = ADAPTER_TOOLS.has(params.toolId);
  const testAssetRequirements = params.testAssets.map((requirement) => {
    const asset = params.accountAssetsByKey.get(requirement.asset_key) ?? null;
    return {
      ...requirement,
      configured: Boolean(asset),
      asset,
    } satisfies ToolAssetRequirementStatus;
  });
  const base = {
    risk: params.def?.risk,
    requires_integration: params.def?.requires_integration,
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
  const assetRequirements = params.requiredAssets.map((requirement) => {
    const asset = params.accountAssetsByKey.get(requirement.asset_key) ?? null;
    return {
      ...requirement,
      configured: Boolean(asset),
      asset,
    } satisfies ToolAssetRequirementStatus;
  });
  const missingRequiredAssets = assetRequirements.filter(
    (requirement) => requirement.required !== false && !requirement.configured
  );
  // `active` significa que la última validación fue OK; los estados
  // intermedios (`pending_test`, `invalid`) se tratan más abajo como
  // needs_config con acciones específicas.
  const accountSatisfied = accountSecretStatus === "active";

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
        "La tool no existe en el catálogo. Quita esta tool de la habilidad o crea/registra la tool antes de activar.",
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
        "La tool está en catálogo, pero todavía no tiene un adapter runtime verificado en el producto. Solicita su incorporación al equipo de Ungga para usarla en operación real.",
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
          "La tool está disponible para prueba controlada. Requiere confirmación humana por ser de riesgo alto.",
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
          "La tool está disponible para prueba controlada. Requiere confirmación humana por ser de riesgo alto.",
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
    if (accountSecretStatus === "invalid") {
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
      notes.push(
        `Conexión con ${accountProviderId} activa por cuenta — no depende de env vars globales.`
      );
      // Cae al check de STUB / ready más abajo.
    } else if (!envConfigured(params.toolId)) {
      // Sin secret per-cuenta y sin env: ofrecemos configurarlo aquí mismo
      // (form inline en Phase 2b). El campo account_provider le dice al UI
      // qué form abrir.
      notes.push(
        `Falta credencial para ${accountProviderId}. Conecta tu cuenta para usar esta tool.`
      );
      return {
        tool_id: params.toolId,
        status: "needs_config",
        category: "account_config",
        blocking: true,
        action_kind: "configure_account",
        action_label: `Conectar ${accountProviderLabel(accountProviderId)}`,
        action_available: true,
        action_message: `Esta tool necesita credenciales de ${accountProviderLabel(accountProviderId)} para esta cuenta. Conéctala desde aquí mismo o desde Ajustes.`,
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
    const providerLabel = isEasyBroker
      ? "EasyBroker"
      : isUngga
        ? "Ungga"
        : "esta tool";
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
        "Esta tool requiere archivos de tu cuenta. Sube o reemplaza los recursos aquí mismo; quedarán guardados para este usuario y se podrán reutilizar en el flujo.",
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
        ? "Recursos de cuenta configurados; queda pendiente completar el adapter real de la tool."
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
        ? "Los recursos de esta cuenta ya están cargados. Para operación real falta que Ungga conecte esta tool al handler final que use esos assets; mientras tanto no bloquea la prueba segura."
        : isTenantAsset
        ? "Esta tool necesita templates/assets por cuenta (ej. plantilla de documento o watermark). La prueba puede validar pasos seguros, pero operación real requiere que el equipo configure ese recurso para tu cuenta."
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
    action_message: "La tool está lista para prueba controlada.",
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
 * - google_calendar y github tienen OAuth implementado: action_url al authorize.
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
    action_message: `La tool ${toolId} requiere la integración "${provider}" que todavía no está disponible en el producto. Crea una solicitud para que el equipo de Ungga la incorpore o configure por tu cuenta.`,
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
    allowedTools,
    warnings,
  };
}

function labelFromSlug(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
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
}) {
  const sourceFlow =
    params.flow.length > 0
      ? params.flow
      : fallbackOperationalFlow(params.resolved, params.registry);
  const mapped = new Set<string>();

  function enrichTool(tool: OperationalCaseFlowTool) {
    mapped.add(tool.tool_id);
    return {
      ...tool,
      readiness: params.toolsById.get(tool.tool_id) ?? null,
    };
  }

  const flow = sourceFlow.map((step) => ({
    ...step,
    step_skills: (step.step_skills ?? []).map((skill: OperationalCaseFlowSkill) => ({
      ...skill,
      skill_tools: (skill.skill_tools ?? []).map(enrichTool),
    })),
    step_tools: (step.step_tools ?? []).map(enrichTool),
  }));

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
      step_skills: [],
      step_tools: unmappedTools,
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
    const requiredAssetsByTool = collectRequiredAssets(sourceFlow);
    const resolved = resolveSkillToolsFromMetadata(
      caseType.default_skill_slug,
      registry
    );
    const testAssetsByTool = collectTestAssets(sourceFlow, resolved.allowedTools);
    const requiredAssetKeys = Array.from(
      new Set(
        [
          ...Array.from(requiredAssetsByTool.values()).flat(),
          ...Array.from(testAssetsByTool.values()).flat(),
        ]
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
      }),
    ]);

    const telegramLinked = Boolean(telegramAccount);
    const accountSecretsByProvider = new Map<string, AccountToolSecretPublic>();
    for (const secret of accountSecrets) {
      accountSecretsByProvider.set(secret.provider, secret);
    }
    const accountAssetsByKey = new Map<string, AccountAsset>();
    for (const asset of accountAssets) {
      accountAssetsByKey.set(asset.asset_key, asset);
    }

    const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    const tools = resolved.allowedTools.map((toolId) =>
      classifyTool({
        toolId,
        def: catalogById.get(toolId),
        settings: (toolSettings ?? []) as UserToolSetting[],
        integrations: (integrations ?? []) as UserIntegration[],
        accountSecretsByProvider,
        accountAssetsByKey,
        requiredAssets: requiredAssetsByTool.get(toolId) ?? [],
        testAssets: testAssetsByTool.get(toolId) ?? [],
        telegramLinked,
      })
    );
    const toolsById = new Map(tools.map((tool) => [tool.tool_id, tool]));
    const flow = enrichFlow({
      flow: sourceFlow,
      toolsById,
      resolved,
      registry,
    });

    const hasBlocking = tools.some((tool) => tool.blocking);
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
      tools,
      flow,
    });
  } catch (err) {
    console.error("[GET /api/tool-readiness] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
