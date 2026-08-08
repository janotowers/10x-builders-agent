/**
 * Catálogo de proveedores de tools per-account.
 *
 * Esta es la **única** fuente de verdad sobre qué providers se pueden
 * configurar por cuenta (EasyBroker, Ungga, etc.), qué campos lleva su
 * config no-sensible y qué campos van cifrados.
 *
 * Lo consumen:
 *  - `/api/account-tool-secrets/*` para validar inputs.
 *  - El form inline `<AccountToolConnectionForm>` para renderizar campos.
 *  - El endpoint de readiness para mapear `tool.requires_integration`
 *    → provider canónico.
 *
 * Para agregar un provider:
 *   1. Añadir entry a `ACCOUNT_TOOL_PROVIDERS`.
 *   2. Crear (o ajustar) la función `testConnection` en su carpeta de
 *      integración (Phase 2b lo cablea para EasyBroker, 2c para Ungga).
 *   3. Asegurar que `tool-readiness/route.ts` use `providerHasAccountConfig`
 *      para considerar la tool como `ready` cuando el secret esté activo.
 */

export type AccountToolFieldType = "text" | "password" | "url";

export interface AccountToolFieldSpec {
  name: string;
  label: string;
  type: AccountToolFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface AccountToolProviderSpec {
  /** ID canónico del provider; coincide con `tool.requires_integration`. */
  id: string;
  /** Nombre mostrado al usuario (Ej: "EasyBroker"). */
  displayName: string;
  /** Texto corto explicando para qué sirve esta conexión. */
  description: string;
  /** URL para que el usuario obtenga sus credenciales. */
  credentialsHelpUrl?: string;
  /** Campos no sensibles guardados en `config_jsonb`. */
  configFields: AccountToolFieldSpec[];
  /** Campos sensibles cifrados en `encrypted_secret_jsonb`. */
  secretFields: AccountToolFieldSpec[];
  /**
   * IDs de tools en `TOOL_CATALOG` que quedan "cubiertas" cuando el user
   * conecta este provider. Se usa para auto-marcar `shipped` cualquier
   * `global_tool_request` abierta para esas tools cuando la validación
   * de conexión sale OK (status=active).
   */
  appliesToTools: string[];
}

export const ACCOUNT_TOOL_PROVIDERS: AccountToolProviderSpec[] = [
  {
    id: "easybroker",
    displayName: "EasyBroker",
    description:
      "API de EasyBroker para crear fichas, subir imágenes y otras operaciones sobre tu inventario.",
    credentialsHelpUrl: "https://dev.easybroker.com/docs/autenticaci%C3%B3n",
    configFields: [
      {
        name: "account_label",
        label: "Etiqueta de la cuenta",
        type: "text",
        required: false,
        placeholder: "EasyBroker producción",
        help: "Sólo informativo; útil cuando hay múltiples agencias.",
      },
    ],
    secretFields: [
      {
        name: "api_key",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "ab1...",
        help: "Obtén tu API Key en EasyBroker → Configuraciones → API para programadores. Debes ser administrador.",
      },
    ],
    appliesToTools: [
      "easybroker_create_listing",
      "easybroker_upload_images",
    ],
  },
  {
    id: "easybroker_web",
    displayName: "EasyBroker MLS (automatización web)",
    description:
      "Inicio de sesión web para buscar en la bolsa inmobiliaria/MLS de EasyBroker vía automatización del navegador.",
    credentialsHelpUrl: "https://www.easybroker.com/mx/account/authentication/new",
    configFields: [],
    secretFields: [
      {
        name: "email",
        label: "Correo de EasyBroker",
        type: "text",
        required: true,
        placeholder: "usuario@agencia.com",
      },
      {
        name: "password",
        label: "Contraseña",
        type: "password",
        required: true,
        placeholder: "••••••••",
      },
    ],
    appliesToTools: [
      "easybroker_search_listings",
      "easybroker_search_closed_deals",
    ],
  },
  {
    id: "ungga_api",
    displayName: "Ungga API",
    description:
      "Usar la API privada de Ungga para enriquecimiento de leads y operaciones internas.",
    configFields: [
      {
        name: "api_base",
        label: "Base URL",
        type: "url",
        required: true,
        placeholder: "https://api.ungga.com",
      },
    ],
    secretFields: [
      {
        name: "api_token",
        label: "API Token",
        type: "password",
        required: true,
        placeholder: "ungga_pat_...",
      },
    ],
    appliesToTools: [],
  },
  {
    id: "ungga_cli",
    displayName: "Ungga (automatización web)",
    description:
      "Inicio de sesión en ungga.com para crear borradores y publicar fichas vía automatización del navegador (Playwright). Es la vía habitual mientras no haya API interna.",
    credentialsHelpUrl: "https://ungga.com/login",
    configFields: [
      {
        name: "login_url",
        label: "URL de inicio de sesión",
        type: "url",
        required: true,
        placeholder: "https://ungga.com/login",
        help: "Pantalla donde el usuario inicia sesión en Ungga.",
      },
    ],
    secretFields: [
      {
        name: "email",
        label: "Correo de Ungga",
        type: "text",
        required: true,
        placeholder: "usuario@agencia.com",
      },
      {
        name: "password",
        label: "Contraseña",
        type: "password",
        required: true,
        placeholder: "••••••••",
      },
    ],
    appliesToTools: ["ungga_publish_listing"],
  },
  {
    id: "avaclick",
    displayName: "Avaclick",
    description:
      "API de opinión digital de valor para casa/departamento (venta y renta) usando catálogos de ubicación y características.",
    credentialsHelpUrl: "https://avaclick.app/",
    configFields: [
      {
        name: "api_url",
        label: "API URL",
        type: "url",
        required: false,
        placeholder: "https://avaclick.app/Apiv2/Avaluo",
        help: "Opcional. Si se omite se usa la URL por defecto de Avaclick.",
      },
      {
        name: "company_name",
        label: "Nombre de empresa",
        type: "text",
        required: true,
        placeholder: "Avaclick",
        help: "Valor enviado en Empresa.NombreEmpresa al proveedor.",
      },
    ],
    secretFields: [
      {
        name: "email",
        label: "Correo API",
        type: "text",
        required: true,
        placeholder: "api.ungga.test@avaclick.app",
        help:
          "Si Avaclick rotó tus credenciales, escribe el correo completo aquí. Actualizar solo el nombre de empresa no cambia el secret guardado.",
      },
      {
        name: "password",
        label: "Password API",
        type: "password",
        required: true,
        placeholder: "••••••••••••••••",
        help:
          "Obligatorio al guardar credenciales nuevas. Dejar en blanco solo conserva el password anterior si también dejaste el correo en blanco.",
      },
    ],
    appliesToTools: ["get_avaclick_valuation"],
  },
];

export function getAccountToolProvider(
  id: string
): AccountToolProviderSpec | null {
  return ACCOUNT_TOOL_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function providerHasAccountConfig(id: string): boolean {
  return ACCOUNT_TOOL_PROVIDERS.some((p) => p.id === id);
}

/**
 * Mapa toolId → provider de `account_tool_secrets`.
 * Fuente única para readiness (lab + Studio).
 */
export const TOOL_TO_ACCOUNT_PROVIDER: Readonly<Record<string, string>> = {
  easybroker_search_listings: "easybroker_web",
  easybroker_search_closed_deals: "easybroker_web",
  easybroker_create_listing: "easybroker",
  easybroker_upload_images: "easybroker",
  easybroker_publish_listing: "easybroker",
  ungga_publish_listing: "ungga_cli",
  get_avaclick_valuation: "avaclick",
};

/** Providers que satisfacen la integración de catálogo `ungga`. */
export const UNGGA_PUBLISH_ACCOUNT_PROVIDERS = ["ungga_cli", "ungga_api"] as const;

/**
 * Claves de `requires_integration` (TOOL_CATALOG) que quedan cubiertas
 * cuando hay un secret activo del provider de cuenta dado.
 * Ej.: `ungga_cli` → `ungga` + `ungga_cli`.
 */
const ACCOUNT_PROVIDER_TO_CATALOG_INTEGRATIONS: Readonly<
  Record<string, readonly string[]>
> = {
  easybroker: ["easybroker"],
  easybroker_web: ["easybroker_web"],
  ungga_cli: ["ungga", "ungga_cli"],
  ungga_api: ["ungga", "ungga_api"],
  avaclick: ["avaclick"],
};

const CATALOG_INTEGRATION_TO_ACCOUNT_PROVIDERS: Readonly<
  Record<string, readonly string[]>
> = {
  ungga: [...UNGGA_PUBLISH_ACCOUNT_PROVIDERS],
  ungga_cli: ["ungga_cli"],
  ungga_api: ["ungga_api"],
  easybroker: ["easybroker"],
  easybroker_web: ["easybroker_web"],
  avaclick: ["avaclick"],
};

export function accountProviderForTool(toolId: string): string | null {
  return TOOL_TO_ACCOUNT_PROVIDER[toolId] ?? null;
}

export function catalogIntegrationsForAccountProvider(
  providerId: string
): readonly string[] {
  return (
    ACCOUNT_PROVIDER_TO_CATALOG_INTEGRATIONS[providerId] ?? [providerId]
  );
}

export function alternativeAccountProvidersForCatalogIntegration(
  catalogProvider: string
): readonly string[] {
  return CATALOG_INTEGRATION_TO_ACCOUNT_PROVIDERS[catalogProvider] ?? [];
}

/**
 * Valida un payload contra la spec de un provider.
 * Devuelve la separación canónica { config, secret } o un mensaje de error.
 */
export function validateAccountToolPayload(
  spec: AccountToolProviderSpec,
  body: Record<string, unknown>
):
  | {
      ok: true;
      config: Record<string, unknown>;
      secret: Record<string, unknown>;
    }
  | { ok: false; error: string } {
  const rawConfig = isRecord(body.config) ? body.config : {};
  const rawSecret = isRecord(body.secret) ? body.secret : {};

  const config: Record<string, unknown> = {};
  for (const field of spec.configFields) {
    const value = rawConfig[field.name];
    if (
      field.required &&
      (value === undefined || value === null || value === "")
    ) {
      return { ok: false, error: `config.${field.name} es requerido` };
    }
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `config.${field.name} debe ser string`,
        };
      }
      config[field.name] = value.trim();
    }
  }

  const secret: Record<string, unknown> = {};
  for (const field of spec.secretFields) {
    const value = rawSecret[field.name];
    if (
      field.required &&
      (value === undefined || value === null || value === "")
    ) {
      return { ok: false, error: `secret.${field.name} es requerido` };
    }
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string") {
        return {
          ok: false,
          error: `secret.${field.name} debe ser string`,
        };
      }
      secret[field.name] = value.trim();
    }
  }

  return { ok: true, config, secret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
