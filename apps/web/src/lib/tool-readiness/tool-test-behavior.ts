export type ToolTestBehaviorKind =
  | "self_contained"
  | "case_backed"
  | "case_assembler"
  | "prior_artifact";

export type ToolTestBehavior = {
  kind: ToolTestBehaviorKind;
  label: string;
  summary: string;
  mode_hint: string;
  prerequisites: string[];
  reads_from_case: string[];
  persists_to_case: string[];
  downstream_for: string[];
  user_facing_test_type?: string;
  recommended_mode_label?: string;
  data_sources?: string[];
  required_artifacts?: string[];
  can_prepare_dependencies?: boolean;
  dependency_steps?: string[];
  smoke_uses_case_when_present?: boolean;
};

type FlowToolBehaviorInput = {
  tool_id: string;
  tool_label?: string;
  tool_description?: string;
  test_inputs_mapping?: Record<string, unknown>;
};

const SELF_CONTAINED: ToolTestBehavior = {
  kind: "self_contained",
  label: "Prueba desde argumentos",
  summary:
    "La prueba se entiende principalmente desde los args mostrados. El caso de prueba puede ayudar a derivarlos, pero no es la fuente principal de ingredientes persistidos.",
  mode_hint:
    "Smoke suele ser útil; Con formulario/caso valida que la recipe derive args realistas desde el fixture.",
  prerequisites: [],
  reads_from_case: [],
  persists_to_case: [],
  downstream_for: [],
  data_sources: ["case_form", "manual_overrides"],
};

const NOTIFY_LISTING_DESCRIPTION_REVIEW: ToolTestBehavior = {
  kind: "case_backed",
  label: "Solicita revisión del borrador comercial",
  summary:
    "En package_ready solicita al asesor revisar el borrador comercial y crea un pendiente accionable de listing_description_review.",
  mode_hint:
    "Con formulario/caso es el modo representativo: si existe listing_description_draft, la recipe arma kind=listing_description_review con el borrador real.",
  prerequisites: [
    "case_id del caso de prueba",
    "listing_description_draft para kind=listing_description_review",
    "canal interno/inbox configurado para el asesor",
  ],
  reads_from_case: [
    "listing_description_draft",
    "listing_copy_ingredients",
    "contexto del caso para enlazar el pendiente",
  ],
  persists_to_case: [
    "internal_user_notifications ligado al caso",
    "pendiente de business_decision listing_description_review",
  ],
  downstream_for: [
    "respuesta del asesor: aprobar o pedir cambios (incluye ajustes, puntos clave o reemplazo)",
    "listing_description_approved",
    "aprobación de destino de publicación",
  ],
};

const NOTIFY_LISTING_PUBLISHED_SUMMARY: ToolTestBehavior = {
  kind: "case_backed",
  label: "Envía resumen final de cierre",
  summary:
    "Al finalizar package_ready notifica al asesor el cierre del caso con links, IDs y estado del paquete de publicación.",
  mode_hint:
    "Con formulario/caso envía listing_published_summary cuando el caso ya tiene destino publicado o paquete manual; antes de eso valida el canal con un mensaje de prueba controlada (kind=tool_readiness_test).",
  prerequisites: [
    "case_id del caso de prueba",
    "published.easybroker / published.ungga o manual_publish_package entregable",
    "canal interno/inbox configurado para el asesor",
  ],
  reads_from_case: [
    "listing_description_approved",
    "pricing_proposal",
    "published",
    "manual_publish_package",
  ],
  persists_to_case: [
    "internal_user_notifications informativa ligada al caso",
    "evento listing_published_summary_sent cuando el cierre real se envía",
  ],
  downstream_for: [
    "caso en published/completed",
    "cierre informativo idempotente",
  ],
};

const BEHAVIOR_BY_TOOL: Record<string, ToolTestBehavior> = {
  operational_case_create: {
    kind: "self_contained",
    label: "Crea instancia de caso",
    summary:
      "La prueba usa los args mostrados para crear una fila de prueba nueva. No consume el caso de laboratorio existente.",
    mode_hint:
      "Úsala para validar creación de casos; repetirla crea más registros de prueba.",
    prerequisites: ["case_type válido", "context de intake suficiente"],
    reads_from_case: [],
    persists_to_case: [],
    downstream_for: [],
    data_sources: ["case_form", "manual_overrides"],
  },
  operational_case_update_state: {
    kind: "case_backed",
    label: "Actualiza estado del caso",
    summary:
      "La prueba necesita un case_id real para actualizar estado/version del caso de laboratorio.",
    mode_hint:
      "Con formulario/caso es el modo representativo; Smoke se enlaza al caso si existe.",
    smoke_uses_case_when_present: true,
    prerequisites: ["case_id del caso de prueba", "expected_version actual"],
    reads_from_case: ["estado/version actuales del caso"],
    persists_to_case: ["state transitions", "context patch opcional"],
    downstream_for: ["siguientes steps del flujo operativo"],
    data_sources: ["case_context", "case_form", "manual_overrides"],
  },
  notify_user: NOTIFY_LISTING_DESCRIPTION_REVIEW,
  operational_case_register_document: {
    kind: "case_backed",
    label: "Registra documento en el caso",
    summary:
      "Registra documentos dentro del caso de prueba; los archivos de prueba se hidratan antes de ejecutar.",
    mode_hint:
      "Con formulario/caso valida persistencia documental en el fixture.",
    prerequisites: ["case_id del caso de prueba", "documento/asset de prueba disponible"],
    reads_from_case: ["case_id"],
    persists_to_case: ["documentos del caso (operational_case_documents)"],
    downstream_for: ["operational_case_list_documents", "operational_case_extract_document_fields"],
    data_sources: ["case_context", "generated_assets", "manual_overrides"],
  },
  operational_case_list_documents: {
    kind: "case_backed",
    label: "Consulta documentos registrados",
    summary:
      "Lista documentos ya asociados al caso de prueba; no es una consulta autocontenida.",
    mode_hint:
      "Con formulario/caso o Smoke enlazado al caso muestran el estado documental real del fixture.",
    prerequisites: ["case_id del caso de prueba", "documentos registrados si esperas resultados"],
    reads_from_case: ["documentos recibidos del caso"],
    persists_to_case: [],
    downstream_for: ["operational_case_extract_document_fields"],
    data_sources: ["case_context", "manual_overrides"],
  },
  operational_case_extract_document_fields: {
    kind: "case_backed",
    label: "Extrae campos de documento",
    summary:
      "Extrae campos desde documentos registrados en el caso de prueba.",
    mode_hint:
      "Primero registra/sube documentos de prueba; luego ejecuta extracción sobre ese caso.",
    prerequisites: ["case_id del caso de prueba", "documento registrado y legible"],
    reads_from_case: ["documento del caso"],
    persists_to_case: ["document.cached_extraction_jsonb (cuando aplica)"],
    downstream_for: ["skills de extracción/validación documental"],
    data_sources: ["case_context", "manual_overrides"],
  },
  generate_document_from_template: {
    kind: "case_assembler",
    label: "Genera documento desde plantilla",
    summary:
      "Renderiza una plantilla con datos persistidos del caso; data en args sólo sirve para overrides.",
    mode_hint:
      "Con formulario/caso es el modo útil porque valida placeholders contra property_data, pricing y contacto del fixture.",
    prerequisites: ["case_id del caso de prueba", "template configurado", "property_data/pricing/contacto suficientes"],
    reads_from_case: ["property_data", "pricing_proposal", "contacto del caso"],
    persists_to_case: ["documentos generados del caso"],
    downstream_for: ["contract_pending", "envío de contrato/revisión"],
    data_sources: ["case_context", "manual_overrides"],
  },
  prepare_listing_description_draft: {
    kind: "case_assembler",
    label: "Prepara borrador comercial",
    summary:
      "Lee ingredientes verificados desde context_jsonb del caso y persiste el borrador en ese mismo caso.",
    mode_hint:
      "Con formulario/caso es el modo representativo; los args son mínimos porque los ingredientes viven en el caso.",
    prerequisites: [
      "case_id del caso de prueba",
      "property_data con tipo/operación",
      "pricing_proposal.salida (aprobado)",
      "raw_photos >= 5",
      "photo_analysis",
      "zone_context",
    ],
    required_artifacts: [
      "pricing_proposal.approval_status=approved",
      "raw_photos>=5",
      "photo_analysis",
      "zone_context",
    ],
    can_prepare_dependencies: true,
    dependency_steps: ["analyze_property_images", "lookup_property_surroundings"],
    reads_from_case: [
      "property_data",
      "pricing_proposal",
      "raw_photos",
      "photo_analysis",
      "zone_context",
      "listing_highlights",
    ],
    persists_to_case: [
      "listing_copy_ingredients",
      "listing_description_draft",
      "listing_description_md",
    ],
    downstream_for: [
      "notify_user(kind=listing_description_review)",
      "listing_description_approved",
      "aprobación de destino de publicación",
      "easybroker_create_listing",
      "ungga_publish_listing",
    ],
    data_sources: ["case_context", "prior_artifacts", "manual_overrides"],
  },
  easybroker_upload_images: {
    kind: "prior_artifact",
    label: "Sube imágenes a listing EasyBroker",
    summary:
      "Sube imágenes a un listing existente; en cadena N4/skill prioriza watermarked_photos y en N1 puede usar fotos crudas de prueba.",
    mode_hint:
      "Ejecuta después de image_watermark para validar la cadena real; en prueba aislada (N1) puedes usar raw_photos/image_paths manuales.",
    prerequisites: ["listing_id existente", "image_paths disponibles", "credencial EasyBroker activa"],
    reads_from_case: [
      "published.easybroker.listing_id (cuando existe)",
      "watermarked_photos (si existe)",
      "raw_photos (fallback N1)",
    ],
    persists_to_case: ["published.easybroker.images (resultado de upload)"],
    downstream_for: ["publicación final EasyBroker"],
    data_sources: ["prior_artifacts", "generated_assets", "manual_overrides"],
  },
  calendar_update_event: {
    kind: "prior_artifact",
    label: "Actualiza evento de calendario",
    summary:
      "Actualiza un evento existente; necesita event_id generado o capturado previamente.",
    mode_hint:
      "Ejecuta después de calendar_create_event o proporciona event_id manualmente.",
    prerequisites: ["event_id existente", "acceso a Google Calendar"],
    reads_from_case: ["photo_session.calendar_event_id (si existe)"],
    persists_to_case: ["photo_session.calendar_event_id (actualizado si aplica)"],
    downstream_for: ["coordinación de sesiones de fotos"],
    data_sources: ["prior_artifacts", "case_context", "manual_overrides"],
  },
  image_watermark: {
    kind: "prior_artifact",
    label: "Aplica marca de agua a fotos",
    user_facing_test_type: "Herramienta con assets de imagen",
    summary:
      "Marca imágenes usando el watermark configurado y rutas de imagen provistas por assets de prueba o args.",
    mode_hint:
      "Con formulario/caso toma raw_photos del fixture para construir watermarked_photos; en N1 también acepta paths manuales.",
    prerequisites: ["input_paths de imágenes", "watermark/asset configurado"],
    reads_from_case: ["raw_photos (cuando la recipe deriva input_paths del caso)"],
    persists_to_case: ["watermarked_photos (cuando existe case_id en la prueba)"],
    downstream_for: ["easybroker_upload_images", "ungga_publish_listing"],
    data_sources: ["case_context", "generated_assets", "manual_overrides"],
  },
  analyze_property_images: {
    kind: "prior_artifact",
    label: "Analiza fotos del inmueble",
    user_facing_test_type: "Herramienta con fotos/assets de prueba",
    summary:
      "Analiza fotos del inmueble; en modo Con formulario/caso las rutas se hidratan desde fotos del inmueble (raw_photos) o assets cargados.",
    mode_hint:
      "Con formulario/caso valida las fotos del laboratorio; manual permite probar rutas de imagen específicas (image_paths).",
    prerequisites: ["rutas de imagen (image_paths) o fotos del inmueble (raw_photos)", "OPENROUTER_API_KEY"],
    reads_from_case: ["fotos del inmueble (raw_photos) cuando la recipe deriva paths del caso"],
    persists_to_case: ["análisis de fotos (photo_analysis) si args incluyen case_id"],
    downstream_for: ["prepare_listing_description_draft"],
    data_sources: ["case_context", "generated_assets", "manual_overrides"],
  },
  lookup_property_surroundings: {
    kind: "self_contained",
    label: "Consulta entorno de la zona",
    summary:
      "Puede resolver entorno con dirección/coords en args, sin requerir contexto profundo del caso.",
    mode_hint:
      "Con formulario/caso es recomendable para persistir zone_context en el fixture y reutilizarlo en herramientas posteriores.",
    prerequisites: ["address o latitude/longitude", "GOOGLE_MAPS_API_KEY"],
    reads_from_case: ["property_data.address"],
    persists_to_case: ["zone_context", "zone_points_of_interest"],
    downstream_for: ["prepare_listing_description_draft"],
    required_artifacts: [],
    data_sources: ["case_form", "case_context", "manual_overrides"],
  },
  easybroker_create_listing: {
    kind: "case_assembler",
    label: "Crea ficha EasyBroker",
    summary:
      "Arma la ficha de EasyBroker usando datos del caso y del borrador aprobado antes de publicar.",
    mode_hint:
      "Con formulario/caso es el modo recomendado para validar payload realista y luego usar prueba controlada.",
    prerequisites: [
      "pricing_proposal.approval_status=approved",
      "listing_description_approved o descripción en args",
      "credencial EasyBroker activa",
    ],
    reads_from_case: [
      "property_data",
      "pricing_proposal",
      "listing_description_approved",
      "listing_description_draft",
    ],
    persists_to_case: ["published.easybroker (borrador/listing_id)"],
    downstream_for: ["easybroker_upload_images", "publicación final EasyBroker"],
    data_sources: ["case_context", "prior_artifacts", "manual_overrides"],
  },
  ungga_publish_listing: {
    kind: "case_assembler",
    label: "Publica o prepara en Ungga",
    summary:
      "Publica o prepara borrador en Ungga usando datos ensamblados del caso y validación humana.",
    mode_hint:
      "Con formulario/caso permite validar payload completo; por riesgo alto se mantiene dry-run desde esta capa.",
    prerequisites: [
      "pricing_proposal.approval_status=approved",
      "descripción preparada",
      "integración Ungga activa",
    ],
    reads_from_case: ["property_data", "pricing_proposal", "listing_description_approved"],
    persists_to_case: ["published.ungga (cuando aplica)"],
    downstream_for: ["resumen final de publicación"],
    data_sources: ["case_context", "prior_artifacts", "manual_overrides"],
  },
};

export type NotifyUserFlowIntent =
  | "listing_description_review"
  | "listing_published_summary"
  | null;

export function notifyUserIntentForFlowTool(
  flowTool?: FlowToolBehaviorInput | null
): NotifyUserFlowIntent {
  if (!flowTool || flowTool.tool_id !== "notify_user") return null;
  const mappingKind = flowTool.test_inputs_mapping?.kind;
  if (mappingKind === "listing_published_summary") return "listing_published_summary";
  if (mappingKind === "listing_description_review") return "listing_description_review";
  const text = `${flowTool.tool_label ?? ""} ${flowTool.tool_description ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/resumen final|cierre|listing_published_summary|publicacion final/.test(text)) {
    return "listing_published_summary";
  }
  if (/aprobaciones internas|revision|descripcion|listing_description_review/.test(text)) {
    return "listing_description_review";
  }
  return null;
}

export function toolTestBehaviorForFlowTool(
  flowTool: FlowToolBehaviorInput
): ToolTestBehavior {
  if (flowTool.tool_id === "notify_user") {
    const intent = notifyUserIntentForFlowTool(flowTool);
    if (intent === "listing_published_summary") {
      return NOTIFY_LISTING_PUBLISHED_SUMMARY;
    }
    if (intent === "listing_description_review") {
      return NOTIFY_LISTING_DESCRIPTION_REVIEW;
    }
  }
  return toolTestBehaviorForTool(flowTool.tool_id);
}

export function toolTestBehaviorForTool(toolId: string): ToolTestBehavior {
  return BEHAVIOR_BY_TOOL[toolId] ?? SELF_CONTAINED;
}

function defaultsForKind(kind: ToolTestBehaviorKind): Pick<
  ToolTestBehavior,
  | "user_facing_test_type"
  | "recommended_mode_label"
  | "data_sources"
  | "required_artifacts"
  | "can_prepare_dependencies"
  | "dependency_steps"
  | "smoke_uses_case_when_present"
> {
  switch (kind) {
    case "self_contained":
      return {
        user_facing_test_type: "Herramienta autocontenida con caso",
        recommended_mode_label: "Con formulario/caso",
        data_sources: ["case_form", "manual_overrides"],
        required_artifacts: [],
        can_prepare_dependencies: false,
        dependency_steps: [],
        smoke_uses_case_when_present: false,
      };
    case "case_backed":
      return {
        user_facing_test_type: "Herramienta respaldada por caso",
        recommended_mode_label: "Con formulario/caso",
        data_sources: ["case_context", "case_form", "manual_overrides"],
        required_artifacts: ["case_id"],
        can_prepare_dependencies: false,
        dependency_steps: [],
        smoke_uses_case_when_present: false,
      };
    case "case_assembler":
      return {
        user_facing_test_type: "Herramienta dependiente con preparación",
        recommended_mode_label: "Con formulario/caso",
        data_sources: ["case_context", "prior_artifacts", "manual_overrides"],
        required_artifacts: [],
        can_prepare_dependencies: true,
        dependency_steps: [],
        smoke_uses_case_when_present: false,
      };
    case "prior_artifact":
      return {
        user_facing_test_type: "Herramienta con prerequisito previo",
        recommended_mode_label: "Con formulario/caso",
        data_sources: ["prior_artifacts", "case_context", "manual_overrides"],
        required_artifacts: [],
        can_prepare_dependencies: false,
        dependency_steps: [],
        smoke_uses_case_when_present: false,
      };
  }
}

/** Rellena campos faltantes cuando la API devuelve metadata parcial o desactualizada. */
export function normalizeToolTestBehavior(
  toolId: string,
  behavior?: Partial<ToolTestBehavior> | null
): ToolTestBehavior {
  const defaults = toolTestBehaviorForTool(toolId);
  const kindDefaults = defaultsForKind(defaults.kind);
  if (!behavior) {
    return {
      ...kindDefaults,
      ...defaults,
      data_sources: defaults.data_sources ?? kindDefaults.data_sources,
      required_artifacts: defaults.required_artifacts ?? kindDefaults.required_artifacts,
      dependency_steps: defaults.dependency_steps ?? kindDefaults.dependency_steps,
      can_prepare_dependencies:
        defaults.can_prepare_dependencies ?? kindDefaults.can_prepare_dependencies,
      user_facing_test_type:
        defaults.user_facing_test_type ?? kindDefaults.user_facing_test_type,
      recommended_mode_label:
        defaults.recommended_mode_label ?? kindDefaults.recommended_mode_label,
      smoke_uses_case_when_present:
        defaults.smoke_uses_case_when_present ?? kindDefaults.smoke_uses_case_when_present,
    };
  }
  const behaviorKindDefaults = defaultsForKind(behavior.kind ?? defaults.kind);
  return {
    ...defaults,
    ...kindDefaults,
    ...behavior,
    ...behaviorKindDefaults,
    prerequisites: behavior.prerequisites ?? defaults.prerequisites,
    reads_from_case: behavior.reads_from_case ?? defaults.reads_from_case,
    persists_to_case: behavior.persists_to_case ?? defaults.persists_to_case,
    downstream_for: behavior.downstream_for ?? defaults.downstream_for,
    data_sources: behavior.data_sources ?? defaults.data_sources ?? kindDefaults.data_sources,
    required_artifacts:
      behavior.required_artifacts ??
      defaults.required_artifacts ??
      kindDefaults.required_artifacts,
    dependency_steps:
      behavior.dependency_steps ?? defaults.dependency_steps ?? kindDefaults.dependency_steps,
    can_prepare_dependencies:
      behavior.can_prepare_dependencies ??
      defaults.can_prepare_dependencies ??
      kindDefaults.can_prepare_dependencies,
    user_facing_test_type:
      behavior.user_facing_test_type ??
      defaults.user_facing_test_type ??
      kindDefaults.user_facing_test_type,
    recommended_mode_label:
      behavior.recommended_mode_label ??
      defaults.recommended_mode_label ??
      kindDefaults.recommended_mode_label,
    smoke_uses_case_when_present:
      behavior.smoke_uses_case_when_present ??
      defaults.smoke_uses_case_when_present ??
      kindDefaults.smoke_uses_case_when_present,
  };
}
