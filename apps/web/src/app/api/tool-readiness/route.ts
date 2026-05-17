import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getOperationalCaseTypeById,
  listAccountToolSecretsPublic,
} from "@agents/db";
import {
  getSkillRegistryForUser,
  TOOL_CATALOG,
} from "@agents/agent";
import type {
  AccountToolSecretPublic,
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
  "generate_document_from_template",
  "image_watermark",
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
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
  easybroker_search_listings: "easybroker",
  easybroker_search_closed_deals: "easybroker",
  easybroker_create_listing: "easybroker",
  easybroker_upload_images: "easybroker",
  ungga_publish_listing: "ungga_api",
};

const ACCOUNT_PROVIDER_LABELS: Record<string, string> = {
  easybroker: "EasyBroker",
  ungga_api: "Ungga API",
};

function accountProviderLabel(providerId: string) {
  return ACCOUNT_PROVIDER_LABELS[providerId] ?? providerId;
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
    toolId === "easybroker_search_closed_deals" ||
    toolId === "easybroker_create_listing" ||
    toolId === "easybroker_upload_images"
  ) {
    return Boolean(process.env.EASYBROKER_API_KEY?.trim());
  }
  if (toolId === "ungga_publish_listing") {
    return Boolean(
      process.env.UNGGA_INTERNAL_API_BASE?.trim() &&
        process.env.UNGGA_INTERNAL_API_TOKEN?.trim()
    );
  }
  return true;
}

function classifyTool(params: {
  toolId: string;
  def?: ToolDefinition;
  settings: UserToolSetting[];
  integrations: UserIntegration[];
  accountSecretsByProvider: Map<string, AccountToolSecretPublic>;
  telegramLinked: boolean;
}): ToolReadinessItem {
  const notes: string[] = [];
  const exists = Boolean(params.def);
  const adapterAvailable = ADAPTER_TOOLS.has(params.toolId);
  const base = {
    risk: params.def?.risk,
    requires_integration: params.def?.requires_integration,
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
  if (STUB_TOOLS.has(params.toolId)) {
    const isTenantAsset = TENANT_ASSET_TOOLS.has(params.toolId);
    const isEasyBrokerWrite = EASYBROKER_WRITE_TOOLS.has(params.toolId);
    notes.push(
      isTenantAsset
        ? "Requiere un recurso o configuración específica de esta cuenta."
        : isEasyBrokerWrite
          ? "Pendiente de Ungga: falta completar el adapter de escritura. Cuando esté listo, esta acción requerirá aprobación HITL del usuario antes de ejecutarse."
          : "Pendiente de Ungga: el usuario ya no puede resolver esto desde configuración; falta completar el adapter/mapeo en producto."
    );
    return {
      tool_id: params.toolId,
      status: "stub",
      category: isTenantAsset ? "tenant_asset" : "technical_stub",
      blocking: false,
      action_kind: "request_global",
      action_label: isTenantAsset
        ? "Solicitar configuración del recurso"
        : "Solicitar prioridad a Ungga",
      action_available: true,
      action_message: isTenantAsset
        ? "Esta tool necesita templates/assets por cuenta (ej. plantilla de documento o watermark). La prueba puede validar pasos seguros, pero operación real requiere que el equipo configure ese recurso para tu cuenta."
        : isEasyBrokerWrite
          ? "La conexión EasyBroker ya puede estar lista, pero esta operación de escritura todavía funciona como stub técnico. No requiere otra configuración del usuario: requiere que Ungga implemente el adapter real. Cuando esté implementada, el agente preparará la acción y pedirá aprobación HITL antes de crear o subir contenido."
          : "La conexión o el catálogo ya existen, pero esta operación todavía funciona como stub técnico. No requiere otra configuración del usuario: requiere que el equipo de Ungga complete el adapter/mapeo en el producto. Si esta capacidad es importante para tu caso de uso, puedes solicitar prioridad.",
      action_url: null,
      action_anchor: null,
      request_kind: isTenantAsset
        ? "provide_tenant_asset"
        : "incorporate_to_catalog",
      account_provider: accountProviderId,
      account_secret_status: accountSecretStatus,
      exists_in_catalog: true,
      adapter_available: true,
      ...base,
      notes,
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
      action_kind: "request_global",
      action_label: "Solicitar configuración de Ungga por cuenta",
      action_available: true,
      action_message:
        "El publicador interno de Ungga aún no tiene flujo de configuración por cuenta. Crea una solicitud para que el equipo lo active para ti.",
      action_url: null,
      action_anchor: null,
      request_kind: "enable_account_config",
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

    const [
      { data: toolSettings },
      { data: integrations },
      { data: telegramAccount },
      accountSecrets,
      registry,
    ] = await Promise.all([
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id),
      supabase
        .from("telegram_accounts")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle(),
      listAccountToolSecretsPublic(db, user.id),
      getSkillRegistryForUser(db, user.id),
    ]);

    const telegramLinked = Boolean(telegramAccount);
    const accountSecretsByProvider = new Map<string, AccountToolSecretPublic>();
    for (const secret of accountSecrets) {
      accountSecretsByProvider.set(secret.provider, secret);
    }

    const resolved = resolveSkillToolsFromMetadata(
      caseType.default_skill_slug,
      registry
    );
    const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    const tools = resolved.allowedTools.map((toolId) =>
      classifyTool({
        toolId,
        def: catalogById.get(toolId),
        settings: (toolSettings ?? []) as UserToolSetting[],
        integrations: (integrations ?? []) as UserIntegration[],
        accountSecretsByProvider,
        telegramLinked,
      })
    );

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
    });
  } catch (err) {
    console.error("[GET /api/tool-readiness] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
