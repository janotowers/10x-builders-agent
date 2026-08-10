import { ACCOUNT_TOOL_PROVIDERS } from "@/lib/account-tool-providers";
import {
  isCatalogIntegrationSatisfied,
  type TenantProviderSnapshot,
} from "@/lib/tool-readiness/provider-readiness";
import type {
  AuthoringInvocationChannel,
  InputRequirement,
} from "@agents/workflows";

export const CAPABILITY_CATEGORY_IDS = [
  "user_email",
  "transactional_email",
  "messaging",
  "real_estate_crm",
  "general_crm",
  "calendar",
  "document_storage",
  "electronic_signature",
  "forms",
  "valuation",
  "listing_publication",
  "maps",
  "data_store",
  "automation_bridge",
] as const;

export type CapabilityCategoryId = (typeof CAPABILITY_CATEGORY_IDS)[number];

export const PROVIDER_CAPABILITY_IDS = [
  "read",
  "search",
  "create_draft",
  "send",
  "attach_files",
  "detect_replies",
  "correlate_reply",
  "manage_contacts",
  "manage_inventory",
  "publish_listings",
  "receive_webhooks",
  "schedule",
  "store_files",
  "request_signature",
  "collect_form",
  "geocode",
  "query_data",
] as const;

export type ProviderCapabilityId = (typeof PROVIDER_CAPABILITY_IDS)[number];
export type ProviderMaturity =
  | "shipped"
  | "candidate"
  | "deferred"
  | "unsupported";
export type ProviderEnablement =
  | "oauth_integration"
  | "account_secret"
  | "builtin"
  | "catalog_only";
export type ProviderRisk = "low" | "medium" | "high";
export type ProviderConnectionState =
  | "connected"
  | "supported_not_connected"
  | "catalog_only";

export interface CapabilityCategorySpec {
  id: CapabilityCategoryId;
  label: string;
  description: string;
}

export interface CapabilityProviderSpec {
  id: string;
  displayName: string;
  categoryId: CapabilityCategoryId;
  capabilities: readonly ProviderCapabilityId[];
  maturity: ProviderMaturity;
  enablement: ProviderEnablement;
  integrationKeys?: readonly string[];
  accountProviderIds?: readonly string[];
  access: "read" | "write" | "read_write";
  minimumScopes?: readonly string[];
  sensitiveData: readonly string[];
  risk: ProviderRisk;
  regions: readonly string[];
  apiMaturity: "official_stable" | "official_limited" | "unverified";
  webhookSupport: "yes" | "no" | "unknown";
  costNote: string;
  toolIds: readonly string[];
  readinessTest?: string;
  officialDocsUrl?: string;
  verifiedOn?: string;
  manualFallback: string;
  notes?: string;
}

export interface ResolvedCapabilityProvider {
  id: string;
  displayName: string;
  state: ProviderConnectionState;
  maturity: ProviderMaturity;
  capabilities: readonly ProviderCapabilityId[];
  risk: ProviderRisk;
  connectHref: string | null;
  reason: string;
}

export interface CapabilityCategoryResolution {
  categoryId: CapabilityCategoryId;
  categoryLabel: string;
  providers: ResolvedCapabilityProvider[];
  policy:
    | "confirm_single_connected"
    | "ask_connected_choice"
    | "offer_connection"
    | "offer_manual_and_request";
  recommendedProviderId: string | null;
}

export interface AuthoringCapabilityContext {
  detectedCategories: CapabilityCategoryResolution[];
  inputRequirements: InputRequirement[];
  invocationChannels: AuthoringInvocationChannel[];
}

export const CAPABILITY_CATEGORIES: readonly CapabilityCategorySpec[] = [
  {
    id: "user_email",
    label: "Correo de usuario",
    description:
      "Correo relacional que sale de la cuenta real de una persona y conserva hilos y respuestas.",
  },
  {
    id: "transactional_email",
    label: "Correo transaccional",
    description:
      "Envíos automatizados a volumen desde infraestructura del sistema; no sustituye el correo personal.",
  },
  {
    id: "messaging",
    label: "Mensajería",
    description: "Mensajes conversacionales por Telegram, WhatsApp o SMS.",
  },
  {
    id: "real_estate_crm",
    label: "CRM inmobiliario",
    description:
      "Inventario, contactos y operación especializada para bienes raíces.",
  },
  {
    id: "general_crm",
    label: "CRM general",
    description: "Gestión horizontal de contactos, deals y actividades.",
  },
  {
    id: "calendar",
    label: "Calendario",
    description: "Consulta y programación de eventos.",
  },
  {
    id: "document_storage",
    label: "Archivos y documentos",
    description: "Carga, almacenamiento y recuperación de archivos.",
  },
  {
    id: "electronic_signature",
    label: "Firma electrónica",
    description: "Solicitud y seguimiento de firmas.",
  },
  {
    id: "forms",
    label: "Formularios",
    description: "Captura estructurada de información.",
  },
  {
    id: "valuation",
    label: "Valuación",
    description: "Estimaciones y opiniones digitales de valor.",
  },
  {
    id: "listing_publication",
    label: "Publicación inmobiliaria",
    description: "Creación y publicación de anuncios de propiedades.",
  },
  {
    id: "maps",
    label: "Mapas y geocodificación",
    description: "Direcciones, coordenadas y contexto geográfico.",
  },
  {
    id: "data_store",
    label: "Datos",
    description: "Consulta de bases de datos y almacenes analíticos.",
  },
  {
    id: "automation_bridge",
    label: "Puentes de automatización",
    description:
      "Intermediarios externos para conectar productos cuando no existe una integración nativa.",
  },
];

const VERIFIED_ON = "2026-08-08";

export const CAPABILITY_PROVIDERS: readonly CapabilityProviderSpec[] = [
  {
    id: "gmail",
    displayName: "Gmail / Google Workspace",
    categoryId: "user_email",
    capabilities: ["send", "attach_files"],
    maturity: "shipped",
    enablement: "oauth_integration",
    integrationKeys: ["gmail"],
    access: "write",
    minimumScopes: ["https://www.googleapis.com/auth/gmail.send"],
    sensitiveData: ["email_content", "contacts", "attachments"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "no",
    costNote: "Incluido en la cuenta Google; aplican cuotas de Gmail API.",
    toolIds: ["gmail_send_email"],
    readinessTest: "OAuth activo y scopes Gmail vigentes.",
    officialDocsUrl: "https://developers.google.com/gmail/api",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Generar el borrador y el archivo para envío manual.",
    notes:
      "La integración enviada hoy solo cubre gmail.send; lectura, búsqueda y detección de respuestas requieren ampliar scopes y runtime en otro cambio gobernado.",
  },
  {
    id: "microsoft_outlook",
    displayName: "Microsoft 365 Outlook",
    categoryId: "user_email",
    capabilities: [
      "read",
      "search",
      "create_draft",
      "send",
      "attach_files",
      "detect_replies",
      "correlate_reply",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    minimumScopes: ["Mail.Read", "Mail.Send"],
    sensitiveData: ["email_content", "contacts", "attachments"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Requiere cuenta Microsoft 365 compatible.",
    toolIds: [],
    officialDocsUrl:
      "https://learn.microsoft.com/graph/api/resources/mail-api-overview",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Generar el borrador y el archivo para envío manual.",
  },
  ...["postmark", "amazon_ses", "sendgrid"].map(
    (id): CapabilityProviderSpec => ({
      id,
      displayName:
        id === "postmark"
          ? "Postmark"
          : id === "amazon_ses"
            ? "Amazon SES"
            : "SendGrid",
      categoryId: "transactional_email",
      capabilities: ["send", "attach_files", "receive_webhooks"],
      maturity: "deferred",
      enablement: "catalog_only",
      access: "write",
      sensitiveData: ["recipient_email", "message_content", "attachments"],
      risk: "high",
      regions: ["global"],
      apiMaturity: "official_stable",
      webhookSupport: "yes",
      costNote: "Servicio de pago por volumen; costos dependen del proveedor.",
      toolIds: [],
      manualFallback:
        "Usar correo de usuario para bajo volumen o preparar el contenido sin enviarlo.",
      notes:
        "Solo considerar para notificaciones o campañas a volumen; no para conversación personal.",
    })
  ),
  {
    id: "telegram_bot",
    displayName: "Telegram",
    categoryId: "messaging",
    capabilities: ["send", "attach_files", "detect_replies", "correlate_reply"],
    maturity: "shipped",
    enablement: "builtin",
    integrationKeys: ["telegram_bot"],
    access: "read_write",
    sensitiveData: ["message_content", "chat_identity", "attachments"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Sin costo por mensaje; aplican límites de Telegram Bot API.",
    toolIds: ["telegram_send_message_to_contact", "notify_user"],
    readinessTest: "Cuenta Telegram vinculada y destinatario alcanzable.",
    officialDocsUrl: "https://core.telegram.org/bots/api",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Mostrar el mensaje para copiar y enviar manualmente.",
  },
  {
    id: "whatsapp_business",
    displayName: "WhatsApp Business Platform",
    categoryId: "messaging",
    capabilities: ["send", "attach_files", "detect_replies", "correlate_reply"],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["message_content", "phone_number", "attachments"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Cobro por conversaciones/mensajes según Meta y región.",
    toolIds: [],
    officialDocsUrl:
      "https://developers.facebook.com/docs/whatsapp/cloud-api",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Preparar el mensaje para envío manual por WhatsApp.",
  },
  {
    id: "easybroker",
    displayName: "EasyBroker",
    categoryId: "real_estate_crm",
    capabilities: [
      "read",
      "search",
      "manage_inventory",
      "publish_listings",
    ],
    maturity: "shipped",
    enablement: "account_secret",
    integrationKeys: ["easybroker", "easybroker_web"],
    accountProviderIds: ["easybroker", "easybroker_web"],
    access: "read_write",
    sensitiveData: ["property_inventory", "contacts"],
    risk: "high",
    regions: ["MX", "LATAM"],
    apiMaturity: "official_stable",
    webhookSupport: "unknown",
    costNote: "Requiere plan de EasyBroker con acceso a la capacidad usada.",
    toolIds: [
      "easybroker_search_listings",
      "easybroker_search_closed_deals",
      "easybroker_create_listing",
      "easybroker_upload_images",
      "easybroker_publish_listing",
    ],
    readinessTest: "API key o sesión web de cuenta validadas.",
    officialDocsUrl: "https://dev.easybroker.com/",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Exportar o capturar los datos manualmente.",
  },
  {
    id: "tokko_broker",
    displayName: "Tokko Broker",
    categoryId: "real_estate_crm",
    capabilities: [
      "read",
      "search",
      "manage_inventory",
      "publish_listings",
      "receive_webhooks",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["property_inventory", "contacts", "leads"],
    risk: "high",
    regions: ["LATAM"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Acceso sujeto al plan y API key de la inmobiliaria.",
    toolIds: [],
    officialDocsUrl: "https://developers.tokkobroker.com/",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Importar/exportar inventario de forma manual.",
  },
  {
    id: "alterestate",
    displayName: "AlterEstate",
    categoryId: "real_estate_crm",
    capabilities: [
      "read",
      "search",
      "manage_contacts",
      "manage_inventory",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["property_inventory", "contacts", "leads"],
    risk: "high",
    regions: ["LATAM"],
    apiMaturity: "official_stable",
    webhookSupport: "unknown",
    costNote: "Acceso sujeto al plan y tokens de la cuenta.",
    toolIds: [],
    officialDocsUrl: "https://dev.alterestate.com/",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Importar/exportar inventario y leads manualmente.",
  },
  {
    id: "wiggot",
    displayName: "Wiggot",
    categoryId: "real_estate_crm",
    capabilities: [
      "read",
      "manage_contacts",
      "manage_inventory",
      "publish_listings",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["property_inventory", "contacts", "leads"],
    risk: "high",
    regions: ["MX"],
    apiMaturity: "official_limited",
    webhookSupport: "unknown",
    costNote: "Requiere plan compatible; API pública por verificar.",
    toolIds: [],
    officialDocsUrl:
      "https://help.wiggot.com/es/articles/7153959-obten-tu-api-key",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Usar exportación/importación o captura manual.",
  },
  {
    id: "inmoapp",
    displayName: "InmoApp",
    categoryId: "real_estate_crm",
    capabilities: [
      "manage_contacts",
      "manage_inventory",
      "publish_listings",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["property_inventory", "contacts", "leads"],
    risk: "high",
    regions: ["MX"],
    apiMaturity: "unverified",
    webhookSupport: "unknown",
    costNote: "Requiere validar plan y acceso de integración con el proveedor.",
    toolIds: [],
    officialDocsUrl: "https://www.inmoapp.mx/",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Usar exportación/importación o captura manual.",
    notes:
      "No se encontró documentación pública de una API general; requiere validación comercial/técnica.",
  },
  {
    id: "hubspot",
    displayName: "HubSpot",
    categoryId: "general_crm",
    capabilities: [
      "read",
      "search",
      "manage_contacts",
      "receive_webhooks",
    ],
    maturity: "candidate",
    enablement: "catalog_only",
    access: "read_write",
    sensitiveData: ["contacts", "deals", "activities"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Capacidades y cuotas dependen del plan de HubSpot.",
    toolIds: [],
    officialDocsUrl: "https://developers.hubspot.com/docs/api/overview",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Importar/exportar contactos y actividades.",
  },
  {
    id: "google_calendar",
    displayName: "Google Calendar",
    categoryId: "calendar",
    capabilities: ["read", "search", "schedule"],
    maturity: "shipped",
    enablement: "oauth_integration",
    integrationKeys: ["google_calendar"],
    access: "read_write",
    sensitiveData: ["calendar_events", "attendees"],
    risk: "high",
    regions: ["global"],
    apiMaturity: "official_stable",
    webhookSupport: "yes",
    costNote: "Incluido en la cuenta Google; aplican cuotas.",
    toolIds: [],
    readinessTest: "OAuth activo con scopes de Calendar.",
    officialDocsUrl: "https://developers.google.com/calendar/api",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Preparar los datos del evento para captura manual.",
  },
  {
    id: "gu_account_assets",
    displayName: "Recursos de cuenta de Gu",
    categoryId: "document_storage",
    capabilities: ["store_files", "read", "search"],
    maturity: "shipped",
    enablement: "builtin",
    access: "read_write",
    sensitiveData: ["uploaded_documents"],
    risk: "medium",
    regions: ["tenant"],
    apiMaturity: "official_stable",
    webhookSupport: "no",
    costNote: "Incluido en Gu OS.",
    toolIds: [],
    readinessTest: "Storage de tenant accesible.",
    manualFallback: "Adjuntar el archivo al iniciar el trabajo.",
  },
  {
    id: "avaclick",
    displayName: "Avaclick",
    categoryId: "valuation",
    capabilities: ["read"],
    maturity: "shipped",
    enablement: "account_secret",
    integrationKeys: ["avaclick"],
    accountProviderIds: ["avaclick"],
    access: "read",
    sensitiveData: ["property_characteristics", "address"],
    risk: "medium",
    regions: ["MX"],
    apiMaturity: "official_limited",
    webhookSupport: "no",
    costNote: "Acceso sujeto al contrato con Avaclick.",
    toolIds: ["get_avaclick_valuation"],
    readinessTest: "Credenciales API activas.",
    officialDocsUrl: "https://avaclick.app/",
    verifiedOn: VERIFIED_ON,
    manualFallback: "Solicitar o capturar una valuación externa.",
  },
  {
    id: "ungga",
    displayName: "Ungga",
    categoryId: "listing_publication",
    capabilities: ["manage_inventory", "publish_listings"],
    maturity: "shipped",
    enablement: "account_secret",
    integrationKeys: ["ungga"],
    accountProviderIds: ["ungga_cli", "ungga_api"],
    access: "write",
    sensitiveData: ["property_inventory", "listing_media"],
    risk: "high",
    regions: ["MX"],
    apiMaturity: "official_limited",
    webhookSupport: "unknown",
    costNote: "Sujeto a la cuenta y modalidad de integración.",
    toolIds: ["ungga_publish_listing"],
    readinessTest: "API o automatización web activas.",
    manualFallback: "Entregar el paquete de publicación para carga manual.",
  },
];

const CATEGORY_BY_ID = new Map(
  CAPABILITY_CATEGORIES.map((category) => [category.id, category])
);

const DETECTION_RULES: ReadonlyArray<{
  categoryId: CapabilityCategoryId;
  pattern: RegExp;
}> = [
  {
    categoryId: "transactional_email",
    pattern:
      /\b(postmark|sendgrid|amazon\s+ses|correo\s+masivo|email\s+transaccional|newsletter)\b/i,
  },
  {
    categoryId: "real_estate_crm",
    pattern:
      /\b(easybroker|inmoapp|tokko(?:\s+broker)?|alterestate|wiggot|crm\s+inmobiliari[oa])\b/i,
  },
  {
    categoryId: "general_crm",
    pattern: /\b(hubspot|salesforce|crm\s+general)\b/i,
  },
  {
    categoryId: "calendar",
    pattern: /\b(calendario|calendar|cita|agendar|evento)\b/i,
  },
  {
    categoryId: "document_storage",
    pattern:
      /\b(google\s+drive|drive|dropbox|sharepoint|onedrive|almacenamiento\s+de\s+(?:documentos|archivos))\b/i,
  },
  {
    categoryId: "electronic_signature",
    pattern: /\b(firma\s+electr[oó]nica|docusign|adobe\s+sign)\b/i,
  },
  {
    categoryId: "forms",
    pattern: /\b(formulario|typeform|jotform|google\s+forms)\b/i,
  },
  {
    categoryId: "valuation",
    pattern: /\b(aval[uú]o|valuaci[oó]n|avaclick)\b/i,
  },
  {
    categoryId: "listing_publication",
    pattern:
      /\b(publicar|publicaci[oó]n|portal(?:es)?\s+inmobiliari|listing|ungga)\b/i,
  },
  {
    categoryId: "maps",
    pattern: /\b(mapa|maps|geocodific|coordenadas|ubicaci[oó]n)\b/i,
  },
  {
    categoryId: "data_store",
    pattern: /\b(base\s+de\s+datos|postgres|supabase|bigquery|warehouse)\b/i,
  },
  {
    categoryId: "automation_bridge",
    pattern: /\b(zapier|make(?:\.com)?|n8n|automatizaci[oó]n)\b/i,
  },
];

type OutboundCommunicationCategory = "user_email" | "messaging";

const OUTBOUND_ACTION =
  String.raw`(?:env[ií](?:a|e|es|an|en|ar|ado|ada|alo|elo|arlo|árselo)?|mand(?:a|e|an|en|ar|ado|ada)|notific(?:a|e|an|en|ar|aci[oó]n|aciones)|avis(?:a|e|an|en|ar|o)|compart(?:e|an|ir)|remit(?:e|an|ir)|send|notify)`;
const EMAIL_CHANNEL =
  String.raw`(?:email|e-mail|correo(?:\s+electr[oó]nico)?|gmail|outlook)`;
const TELEGRAM_CHANNEL = String.raw`telegram`;

function communicationPattern(source: string): RegExp {
  return new RegExp(source, "i");
}

function hasOutboundExecutionIntent(
  value: string,
  categoryId: OutboundCommunicationCategory
): boolean {
  const channel =
    categoryId === "user_email" ? EMAIL_CHANNEL : TELEGRAM_CHANNEL;
  const viaChannel =
    categoryId === "messaging"
      ? String.raw`(?:por|v[ií]a|mediante|usando)\s+${channel}`
      : String.raw`(?:(?:por|v[ií]a|mediante|usando)\s+)?(?:un\s+)?${channel}`;
  return [
    communicationPattern(
      String.raw`\b${OUTBOUND_ACTION}\b.{0,100}\b${viaChannel}\b`
    ),
    communicationPattern(
      String.raw`\b${channel}\b.{0,50}\bpara\s+${OUTBOUND_ACTION}\b`
    ),
    communicationPattern(
      String.raw`\b${channel}\b.{0,60}\b(?:enviado|enviada|mandado|mandada)\b`
    ),
  ].some((pattern) => pattern.test(value));
}

function rejectsOutboundExecution(
  value: string,
  categoryId: OutboundCommunicationCategory
): boolean {
  const channel =
    categoryId === "user_email" ? EMAIL_CHANNEL : TELEGRAM_CHANNEL;
  return [
    communicationPattern(
      String.raw`\b(?:no|nunca|sin)\b[^.;\n]{0,60}\b${OUTBOUND_ACTION}\b[^.;\n]{0,100}\b${channel}\b`
    ),
    communicationPattern(
      String.raw`\bya\s+no\b[^.;\n]{0,60}\b${OUTBOUND_ACTION}\b[^.;\n]{0,100}\b${channel}\b`
    ),
    communicationPattern(
      String.raw`\b(?:no|nunca|sin|ya\s+no)\s+(?:usar|uses?|utilizar|utilices?)\s+(?:el\s+|la\s+)?${channel}\b`
    ),
    communicationPattern(
      String.raw`\b(?:en\s+lugar\s+de|instead\s+of)\s+(?:el\s+|la\s+)?${channel}\b`
    ),
  ].some((pattern) => pattern.test(value));
}

function currentOutboundCommunicationCategories(
  values: readonly string[]
): Set<OutboundCommunicationCategory> {
  const current = new Set<OutboundCommunicationCategory>();
  for (const value of values) {
    for (const categoryId of [
      "user_email",
      "messaging",
    ] as const satisfies readonly OutboundCommunicationCategory[]) {
      if (rejectsOutboundExecution(value, categoryId)) {
        current.delete(categoryId);
        continue;
      }
      if (hasOutboundExecutionIntent(value, categoryId)) {
        current.add(categoryId);
      }
    }
  }
  return current;
}

function settingsConnectionHref(authoringSessionId?: string | null): string {
  const params = new URLSearchParams({
    view: "integrations",
    section: "connections",
  });
  if (authoringSessionId?.trim()) {
    params.set(
      "return_to",
      `/operations/workflows/design?authoring_session=${encodeURIComponent(
        authoringSessionId.trim()
      )}`
    );
  }
  return `/settings?${params.toString()}#connections`;
}

function providerScore(
  provider: CapabilityProviderSpec,
  state: ProviderConnectionState
): number {
  let score = state === "connected" ? 100 : state === "supported_not_connected" ? 50 : 0;
  if (provider.apiMaturity === "official_stable") score += 20;
  if (provider.apiMaturity === "official_limited") score += 8;
  if (provider.risk === "low") score += 6;
  if (provider.risk === "medium") score += 3;
  if (provider.regions.includes("MX") || provider.regions.includes("LATAM")) {
    score += 4;
  }
  return score;
}

function providerState(
  provider: CapabilityProviderSpec,
  snapshot: TenantProviderSnapshot
): ProviderConnectionState {
  if (provider.enablement === "builtin" && provider.id === "gu_account_assets") {
    return "connected";
  }
  if (
    provider.integrationKeys?.some(
      (key) => isCatalogIntegrationSatisfied(key, snapshot).satisfied
    )
  ) {
    return "connected";
  }
  if (provider.maturity === "shipped" && provider.enablement !== "catalog_only") {
    return "supported_not_connected";
  }
  return "catalog_only";
}

export function detectCapabilityCategories(
  values: readonly string[]
): CapabilityCategoryId[] {
  const text = values.join("\n");
  const detected = new Set(
    DETECTION_RULES.filter(({ pattern }) => pattern.test(text)).map(
      ({ categoryId }) => categoryId
    )
  );
  for (const categoryId of currentOutboundCommunicationCategories(values)) {
    detected.add(categoryId);
  }
  return CAPABILITY_CATEGORY_IDS.filter((categoryId) =>
    detected.has(categoryId)
  );
}

const REUSABLE_ACCOUNT_FILE_PATTERN =
  /\b(plantilla|template|marca\s+de\s+agua|watermark|brand\s*book|manual\s+de\s+marca|gu[ií]a\s+de\s+estilo)\b/i;
const RUNTIME_FILE_PATTERN =
  /\b(word|docx|txt|pdf|documento|archivo|adjunto|adjuntar|subir|cargar)\b/i;

export function inferAuthoringInputRequirements(
  values: readonly string[]
): InputRequirement[] {
  const text = values.join("\n");
  const latest = values[values.length - 1] ?? "";
  const rejectsReusableAsset =
    /\b(?:no\s+es|no\s+ser[aá]|sin)\b.{0,50}\b(?:plantilla|template|recurso\s+permanente|archivo\s+reutilizable|account_asset)\b/i.test(
      latest
    );
  const requirements: InputRequirement[] = [];
  if (REUSABLE_ACCOUNT_FILE_PATTERN.test(text) && !rejectsReusableAsset) {
    requirements.push({
      kind: "account_asset",
      key: "reusable_account_file",
      label: "Archivo reutilizable de la cuenta",
      required: true,
      scope: "account",
      resolve_at: "authoring",
      source_hint: "account_assets",
      retention: "durable",
    });
  }
  if (
    RUNTIME_FILE_PATTERN.test(text) &&
    !(
      REUSABLE_ACCOUNT_FILE_PATTERN.test(text) &&
      !rejectsReusableAsset &&
      !/\b(cada\s+(?:vez|ejecuci[oó]n)|por\s+(?:caso|ejecuci[oó]n)|adjunt|subir|cargar)\b/i.test(
        text
      )
    )
  ) {
    requirements.push({
      kind: "runtime_input",
      key: "source_document",
      label: "Documento fuente de esta ejecución",
      required: true,
      scope: "task_run",
      resolve_at: "run_start",
      source_hint: "chat_attachment",
      retention: "run",
    });
  }
  return requirements;
}

const PER_EXECUTION_INPUT_KINDS = new Set<InputRequirement["kind"]>([
  "runtime_input",
  "case_fact",
  "business_record",
  "knowledge_requirement",
  "human_input",
]);

export function isPerExecutionInputRequirement(
  requirement: Pick<InputRequirement, "kind">
): boolean {
  return PER_EXECUTION_INPUT_KINDS.has(requirement.kind);
}

export function invocationChannelsFromSnapshot(
  snapshot: TenantProviderSnapshot
): AuthoringInvocationChannel[] {
  const channels: AuthoringInvocationChannel[] = [
    {
      channel: "web_chat",
      label: "Web Chat",
      availability: "available",
      supports_text: true,
      supports_generic_attachments: true,
      limitations: [],
    },
  ];
  if (snapshot.telegramLinked) {
    channels.push({
      channel: "telegram",
      label: "Telegram",
      availability: "available",
      supports_text: true,
      supports_generic_attachments: true,
      limitations: [
        "Los archivos .xls heredados no están habilitados; deben convertirse a .xlsx.",
        "Los formatos con macros (.docm, .xlsm y .pptm) no están habilitados.",
      ],
    });
  }
  return channels;
}

export function resolveCapabilityCategory(
  categoryId: CapabilityCategoryId,
  snapshot: TenantProviderSnapshot,
  options?: { authoringSessionId?: string | null }
): CapabilityCategoryResolution {
  const category = CATEGORY_BY_ID.get(categoryId);
  if (!category) {
    throw new Error(`unknown_capability_category:${categoryId}`);
  }
  const providers = CAPABILITY_PROVIDERS.filter(
    (provider) => provider.categoryId === categoryId
  )
    .map((provider): ResolvedCapabilityProvider => {
      const state = providerState(provider, snapshot);
      return {
        id: provider.id,
        displayName: provider.displayName,
        state,
        maturity: provider.maturity,
        capabilities: provider.capabilities,
        risk: provider.risk,
        connectHref:
          state === "supported_not_connected"
            ? settingsConnectionHref(options?.authoringSessionId)
            : null,
        reason:
          state === "connected"
            ? "Disponible para esta cuenta."
            : state === "supported_not_connected"
              ? "Soportado por Gu; falta conectarlo en la cuenta."
              : provider.maturity === "deferred"
                ? "Catalogado para uso futuro; todavía no disponible en Gu."
                : "Candidato de catálogo; requiere evaluación e integración gobernada.",
      };
    })
    .sort((a, b) => {
      const providerA = CAPABILITY_PROVIDERS.find((item) => item.id === a.id)!;
      const providerB = CAPABILITY_PROVIDERS.find((item) => item.id === b.id)!;
      return (
        providerScore(providerB, b.state) - providerScore(providerA, a.state) ||
        a.displayName.localeCompare(b.displayName)
      );
    });
  const connected = providers.filter((provider) => provider.state === "connected");
  const supported = providers.filter(
    (provider) => provider.state === "supported_not_connected"
  );
  const policy =
    connected.length === 1
      ? "confirm_single_connected"
      : connected.length > 1
        ? "ask_connected_choice"
        : supported.length > 0
          ? "offer_connection"
          : "offer_manual_and_request";
  return {
    categoryId,
    categoryLabel: category.label,
    providers,
    policy,
    recommendedProviderId: providers[0]?.id ?? null,
  };
}

export function buildAuthoringCapabilityContext(params: {
  values: readonly string[];
  snapshot: TenantProviderSnapshot;
  authoringSessionId?: string | null;
}): AuthoringCapabilityContext {
  return {
    detectedCategories: detectCapabilityCategories(params.values).map(
      (categoryId) =>
        resolveCapabilityCategory(categoryId, params.snapshot, {
          authoringSessionId: params.authoringSessionId,
        })
    ),
    inputRequirements: inferAuthoringInputRequirements(params.values),
    invocationChannels: invocationChannelsFromSnapshot(params.snapshot),
  };
}

export function accountProviderIdsReferencedByCatalog(): Set<string> {
  return new Set(
    CAPABILITY_PROVIDERS.flatMap((provider) => provider.accountProviderIds ?? [])
  );
}

export function configuredAccountProviderIds(): Set<string> {
  return new Set(ACCOUNT_TOOL_PROVIDERS.map((provider) => provider.id));
}
