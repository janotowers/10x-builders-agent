type LabelEntry = {
  label: string;
  aliases?: string[];
};

const LABELS: Record<string, LabelEntry> = {
  case_id: { label: "caso de prueba" },
  property_data: { label: "datos del inmueble" },
  pricing_proposal: { label: "propuesta de precio" },
  "pricing_proposal.approval_status=approved": { label: "precio aprobado" },
  raw_photos: { label: "fotos del inmueble" },
  "raw_photos>=5": { label: "al menos 5 fotos del inmueble" },
  photo_analysis: { label: "análisis de fotos" },
  zone_context: { label: "contexto verificado de la zona" },
  zone_points_of_interest: { label: "puntos de interés de la zona" },
  listing_highlights: { label: "puntos clave del asesor" },
  listing_copy_ingredients: { label: "ingredientes del copy" },
  listing_description_draft: { label: "borrador de descripción" },
  listing_description_md: { label: "descripción final (markdown)" },
  listing_description_approved: { label: "descripción aprobada" },
  listing_copy_instructions: { label: "instrucciones editoriales del asesor" },
  publish_approvals: { label: "aprobaciones de publicación" },
  publish_destination_approval: { label: "aprobación de destino de publicación" },
  published: { label: "publicación confirmada" },
  contract_review: { label: "revisión de contrato" },
  contract_draft: { label: "borrador de contrato" },
  manual_publish_package: { label: "paquete manual de publicación" },
  "property_data.address.city": { label: "municipio o ciudad" },
  "property_data.address.state": { label: "estado" },
  "property_data.address.neighborhood": { label: "colonia o zona" },
  "property_data.address.formatted_address": { label: "dirección formateada" },
  internal_user_notifications: { label: "notificaciones internas" },
  "business_decision:listing_description_review": {
    label: "decisión humana de descripción",
    aliases: ["pending_review_intent"],
  },
  source: { label: "fuente de datos" },
  tool_recipe: { label: "recipe por tool" },
  flow_test_inputs_mapping: { label: "mapping del flujo" },
  generic_param_name_match: { label: "match por nombre de parámetro" },
  manual_user_args: { label: "args manuales" },
  smoke_defaults: { label: "defaults de smoke" },
  smoke_bound_test_case: { label: "smoke enlazado al caso" },
  fallback_smoke_no_test_case: { label: "fallback smoke sin caso" },
  preview_only: { label: "vista previa" },
  case_form: { label: "formulario del caso" },
  case_context: { label: "contexto persistido del caso" },
  prior_artifacts: { label: "artefactos previos del caso" },
  manual_overrides: { label: "overrides manuales" },
  generated_assets: { label: "assets de prueba" },
  flow_mapping: { label: "mapping del flujo" },
  analyze_property_images: { label: "analizar imágenes de la propiedad" },
  lookup_property_surroundings: { label: "enriquecer entorno de la propiedad" },
  geocode_property_address: { label: "geocodificar dirección de la propiedad" },
  prepare_listing_description_draft: { label: "preparar borrador de descripción" },
  easybroker_create_listing: { label: "crear publicación en EasyBroker" },
  easybroker_upload_images: { label: "subir fotos a EasyBroker" },
  ungga_publish_listing: { label: "publicar en Ungga" },
  "notify_user(kind=listing_description_review)": {
    label: "solicitar revisión de descripción",
  },
  "notify_user(kind=property_data_review)": {
    label: "solicitar validación de property_data",
  },
  "notify_user(kind=comparables_insufficient_data)": {
    label: "avisar comparables insuficientes",
  },
  "business_decision:property_data_review": {
    label: "revisión de property_data",
  },
  OPENROUTER_API_KEY: { label: "API key de OpenRouter" },
  GOOGLE_MAPS_API_KEY: { label: "API key de Google Maps" },
  "property_data.address": { label: "dirección del inmueble" },
  "published.easybroker.listing_id": { label: "listing_id de EasyBroker" },
  "published.easybroker.images": { label: "fotos publicadas en EasyBroker" },
  "published.ungga": { label: "publicación en Ungga" },
  watermarked_photos: { label: "fotos con watermark" },
};

const LOOKUP: Record<string, string> = Object.entries(LABELS).reduce<
  Record<string, string>
>((acc, [key, entry]) => {
  acc[key] = entry.label;
  for (const alias of entry.aliases ?? []) acc[alias] = entry.label;
  return acc;
}, {});

const NATURAL_ONLY_LABELS = new Set([
  "case_form",
  "case_context",
  "prior_artifacts",
  "manual_overrides",
  "generated_assets",
  "tool_recipe",
  "flow_test_inputs_mapping",
  "generic_param_name_match",
  "manual_user_args",
  "smoke_defaults",
  "smoke_bound_test_case",
  "fallback_smoke_no_test_case",
  "preview_only",
]);

function humanizeFallback(slug: string): string {
  return slug
    .replace(/^property_data\./, "")
    .replace(/^pricing_proposal\./, "")
    .replace(/^photo_analysis\./, "")
    .replace(/_/g, " ")
    .replace(/\./g, " > ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyTechnicalIdentifier(value: string): boolean {
  if (!value) return false;
  if (/\s/.test(value)) return false;
  if (/^[a-z0-9_.:>=<-]+$/i.test(value)) return true;
  if (/^[a-z]+_[a-z0-9_]+$/i.test(value)) return true;
  if (/^[a-z0-9_.]+\([^)]+\)$/i.test(value)) return true;
  return false;
}

export function naturalLabelForSlug(slug: string): string {
  const clean = slug.trim();
  if (!clean) return clean;
  if (LOOKUP[clean]) return LOOKUP[clean];
  if (!isLikelyTechnicalIdentifier(clean)) return clean;
  return humanizeFallback(clean);
}

export function naturalAndTechnicalLabel(slug: string): string {
  const clean = slug.trim();
  if (!clean) return clean;
  const natural = naturalLabelForSlug(clean);
  if (NATURAL_ONLY_LABELS.has(clean)) return natural;
  if (!isLikelyTechnicalIdentifier(clean)) return natural;
  if (natural.localeCompare(clean, undefined, { sensitivity: "base" }) === 0) {
    return natural;
  }
  return `${natural} (${clean})`;
}

export function mapNaturalAndTechnicalLabels(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => naturalAndTechnicalLabel(value));
}
