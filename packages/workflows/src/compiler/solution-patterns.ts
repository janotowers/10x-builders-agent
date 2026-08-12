import { z } from "zod";
import { AUTHORING_DISCOVERY_DIMENSIONS } from "./authoring-discovery";

export const SOLUTION_PATTERN_WORK_FORMS = [
  "case_workflow",
  "durable_task",
  "reusable_skill",
  "schedule",
] as const;

export const SOLUTION_PATTERN_TRIGGERS = [
  "scheduled_execution",
  "sends_external_email",
  "sends_telegram_message",
  "sends_external_message",
  "external_response_wait",
  "document_intake",
  "generated_document",
  "human_approval",
  "business_decision",
  "human_contribution",
  "exception_review",
  "integration_dependency",
  "external_write",
] as const;

export const HUMAN_INVOLVEMENT_TYPES = [
  "action_authorization",
  "business_decision",
  "human_contribution",
  "exception_review",
] as const;

export const REGISTERED_AUTHORING_COMPONENTS = [
  "DecisionCard",
  "ArtifactPreview",
  "FileContribution",
  "IntegrationChoice",
  "SchedulePolicy",
  "ExceptionPanel",
  "DeliveryPreview",
  "StableDocumentLink",
] as const;

export type SolutionPatternWorkForm =
  (typeof SOLUTION_PATTERN_WORK_FORMS)[number];
export type SolutionPatternTrigger = (typeof SOLUTION_PATTERN_TRIGGERS)[number];
export type HumanInvolvementType = (typeof HUMAN_INVOLVEMENT_TYPES)[number];
export type RegisteredAuthoringComponent =
  (typeof REGISTERED_AUTHORING_COMPONENTS)[number];

export const AUTHORING_HINT_SEVERITIES = [
  "blocking",
  "defaultable",
  "important",
] as const;

export const SOLUTION_PATTERN_READINESS_GATE_IDS = [
  "outbound_delivery_route",
  "outbound_recipient_resolution",
  "outbound_approval_authority",
] as const;

export type SolutionPatternReadinessGateId =
  (typeof SOLUTION_PATTERN_READINESS_GATE_IDS)[number];

const stableLegacyGapKey = (targetDimension: string, gap: string): string => {
  let hash = 2166136261;
  for (const character of `${targetDimension}\0${gap.trim()}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy.${targetDimension}.${(hash >>> 0).toString(36)}`;
};

const authoringGapKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const authoringHintSchema = z
  .object({
    targetDimension: z.enum(AUTHORING_DISCOVERY_DIMENSIONS),
    gapKey: authoringGapKeySchema.optional(),
    severity: z.enum(AUTHORING_HINT_SEVERITIES).default("important"),
    dependsOn: z.array(authoringGapKeySchema).default([]),
    appliesWhen: z.array(z.enum(SOLUTION_PATTERN_TRIGGERS)).min(1).optional(),
    gap: z.string().trim().min(1),
    question: z.string().trim().min(1),
    examples: z.array(z.string().trim().min(1)).max(4).default([]),
    safeDefault: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((hint, ctx) => {
    if (hint.severity === "defaultable" && !hint.safeDefault) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safeDefault"],
        message: "un hint defaultable requiere safeDefault explícito",
      });
    }
  })
  .transform((hint) => ({
    ...hint,
    gapKey:
      hint.gapKey ?? stableLegacyGapKey(hint.targetDimension, hint.gap),
  }));

const testContractSchema = z.object({
  levels: z
    .array(z.enum(["n0", "n1", "n2", "n3", "n4", "n5"]))
    .min(1),
  scenarios: z.array(z.string().trim().min(1)).min(1),
});

export const solutionPatternSchema = z.object({
  id: z.string().regex(/^PATTERN_[A-Z0-9_]+$/),
  version: z.number().int().positive(),
  status: z.enum(["active", "candidate", "deprecated"]),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  workForms: z.array(z.enum(SOLUTION_PATTERN_WORK_FORMS)).min(1),
  mandatoryWhen: z.array(z.enum(SOLUTION_PATTERN_TRIGGERS)).default([]),
  requiredCapabilities: z.array(z.string().trim().min(1)).default([]),
  humanInvolvement: z
    .array(z.enum(HUMAN_INVOLVEMENT_TYPES))
    .default([]),
  uiComponents: z
    .array(z.enum(REGISTERED_AUTHORING_COMPONENTS))
    .default([]),
  persistenceContracts: z.array(z.string().trim().min(1)).default([]),
  auditEvents: z.array(z.string().trim().min(1)).default([]),
  runtimeGuarantees: z.array(z.string().trim().min(1)).min(1),
  dependencies: z
    .array(z.string().regex(/^PATTERN_[A-Z0-9_]+$/))
    .default([]),
  incompatibilities: z
    .array(z.string().regex(/^PATTERN_[A-Z0-9_]+$/))
    .default([]),
  authoringHints: z.array(authoringHintSchema).default([]),
  compileDirectives: z.array(z.string().trim().min(1)).min(1),
  validationRuleIds: z.array(z.string().trim().min(1)).min(1),
  readinessGateIds: z
    .array(z.enum(SOLUTION_PATTERN_READINESS_GATE_IDS))
    .default([]),
  testContract: testContractSchema,
  implementationPaths: z.array(z.string().trim().min(1)).min(1),
  evidenceDocs: z.array(z.string().trim().min(1)).min(1),
});

export type SolutionPattern = z.infer<typeof solutionPatternSchema>;
export type AuthoringHint = z.infer<typeof authoringHintSchema>;

const ALL_FORMS = [...SOLUTION_PATTERN_WORK_FORMS];
const CASE_AND_TASK: SolutionPatternWorkForm[] = [
  "case_workflow",
  "durable_task",
  "schedule",
];
const DOC =
  "docs/operational-cases/operational-case-reusable-patterns.md";

const RAW_SOLUTION_PATTERNS: Array<z.input<typeof solutionPatternSchema>> = [
  {
    id: "PATTERN_BASE_CASE_WORKFLOW",
    version: 1,
    status: "active",
    label: "Paquete base de caso durable",
    description:
      "Estado durable, timeline, actores, decisiones, artefactos, esperas, auditoría y pruebas del caso.",
    workForms: ["case_workflow"],
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: [],
    uiComponents: [],
    persistenceContracts: [
      "operational_cases",
      "operational_case_events",
      "work_items",
    ],
    auditEvents: ["case_created", "case_transitioned", "case_completed"],
    runtimeGuarantees: [
      "Estado durable y transiciones auditables.",
      "Las esperas se representan explícitamente y pueden reanudarse.",
    ],
    dependencies: ["PATTERN_OPERATIONAL_WRITE_GATE"],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "durability",
        gap: "Falta identificar qué debe persistir y reanudarse.",
        question:
          "¿Qué estado, expediente o historial debe conservar Gu entre una intervención y la siguiente?",
        examples: ["documentos recibidos", "aprobación pendiente", "último contacto"],
      },
    ],
    compileDirectives: [
      "Modelar estado durable, timeline, actores, artefactos, esperas y transiciones explícitas.",
      "Generar escenarios N0-N5 proporcionales al riesgo.",
    ],
    validationRuleIds: ["case_state_contract", "case_audit_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3", "n4", "n5"],
      scenarios: ["happy_path", "waiting_resume", "blocked_transition"],
    },
    implementationPaths: [
      "packages/workflows/src/compiler/spec-schemas.ts",
      "apps/web/src/lib/operational-cases",
    ],
    evidenceDocs: [DOC, "docs/skills-tools-architecture.md"],
  },
  {
    id: "PATTERN_BASE_DURABLE_TASK",
    version: 1,
    status: "active",
    label: "Paquete base de tarea durable",
    description:
      "Inputs, progreso, retries, resultado, cancelación, retención y observabilidad.",
    workForms: ["durable_task", "schedule"],
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: [],
    uiComponents: ["ExceptionPanel"],
    persistenceContracts: ["durable_task_spec", "work_items", "work_attempts"],
    auditEvents: ["task_started", "task_retried", "task_completed", "task_cancelled"],
    runtimeGuarantees: [
      "El trabajo puede reintentarse sin duplicar efectos.",
      "La cancelación y el resultado quedan visibles.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "durability",
        gap: "Falta definir progreso, cancelación o reanudación.",
        question:
          "Si el trabajo tarda o falla, ¿qué progreso debe conservarse y cuándo debería reintentarse o cancelarse?",
        examples: ["reanudar desde el último lote", "cancelar antes del envío"],
      },
    ],
    compileDirectives: [
      "Declarar inputs, progreso, resultado, política de retry, cancelación y retención.",
    ],
    validationRuleIds: ["durable_task_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3"],
      scenarios: ["success", "retry", "cancel"],
    },
    implementationPaths: [
      "packages/workflows/src/compiler/durable-task-spec.ts",
      "packages/workflows/src/dispatcher.ts",
    ],
    evidenceDocs: ["docs/skills-tools-architecture.md"],
  },
  {
    id: "PATTERN_BASE_REUSABLE_SKILL",
    version: 1,
    status: "active",
    label: "Paquete base de skill reusable",
    description:
      "Activadores y límites MECE, output contract, tools mínimas y Skill Lab.",
    workForms: ["reusable_skill"],
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: [],
    uiComponents: [],
    persistenceContracts: ["account_skills"],
    auditEvents: ["skill_invoked", "skill_completed"],
    runtimeGuarantees: [
      "La skill declara cuándo aplica y cuándo no.",
      "El output contract es verificable.",
    ],
    dependencies: ["PATTERN_SKILL_TEST_CONTRACT"],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "mece_overlap",
        gap: "Falta delimitar cuándo usar esta función y cuándo no.",
        question:
          "¿En qué situaciones debe usar Gu esta función y en cuáles no?",
        examples: ["solo propietarios representados", "no usar para compradores"],
      },
    ],
    compileDirectives: [
      "Declarar activadores, exclusiones, output contract y tools mínimas.",
    ],
    validationRuleIds: ["skill_activation_contract", "skill_output_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3"],
      scenarios: ["positive_activation", "negative_activation", "output_contract"],
    },
    implementationPaths: [
      "apps/web/src/lib/workflow-studio/compile-reusable-skill.ts",
      "skills/global/skill-authoring/SKILL.md",
    ],
    evidenceDocs: ["docs/skills-tools-architecture.md"],
  },
  {
    id: "PATTERN_SCHEDULED_TASK_SAFETY",
    version: 1,
    status: "active",
    label: "Ejecución programada segura",
    description:
      "Recurrencia con timezone, lease, no solapamiento, idempotencia, retry/misfire, política unattended y escalado.",
    workForms: CASE_AND_TASK,
    mandatoryWhen: ["scheduled_execution"],
    requiredCapabilities: ["scheduled_execution"],
    humanInvolvement: ["exception_review"],
    uiComponents: ["SchedulePolicy", "ExceptionPanel"],
    persistenceContracts: [
      "scheduled_tasks",
      "scheduled_task_runs",
      "next_action_at",
    ],
    auditEvents: [
      "scheduled_run_started",
      "scheduled_run_completed",
      "scheduled_run_retried",
      "scheduled_task_auto_paused",
    ],
    runtimeGuarantees: [
      "Timezone y próxima ejecución son explícitas.",
      "Un lease atómico impide ejecución concurrente de la misma unidad.",
      "Cada tick es idempotente y deduplica efectos externos.",
      "Retry respeta la próxima ocurrencia natural y un presupuesto acotado.",
      "Una captura HITL parcial no reprograma next_action_at.",
      "No existe auto-aprobación general de tools en trabajo unattended.",
      "Agotamiento de retry auto-pausa y escala de forma visible.",
    ],
    dependencies: [
      "PATTERN_OPERATIONAL_WRITE_GATE",
      "PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER",
    ],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "recurrence",
        gapKey: "schedule.recurrence_policy",
        severity: "blocking",
        gap: "Faltan timezone, misfire y política de fallo.",
        question:
          "¿En qué zona horaria corre, qué debe pasar si se omite una ejecución y cuándo se pausa para revisión?",
        examples: [
          "09:00 America/Mexico_City",
          "no recuperar ejecuciones vencidas",
          "pausar tras 3 fallos",
        ],
      },
    ],
    compileDirectives: [
      "Declarar cron/recurrencia y timezone IANA.",
      "Usar lease atómico, idempotency key por tick y concurrencia acotada.",
      "Definir misfire/catch-up, retry budget, auto-pausa, escalado y next run visible.",
      "Aplicar allowlist de riesgo; cualquier efecto no autorizado va a pending inbox.",
    ],
    validationRuleIds: [
      "schedule_timezone",
      "schedule_idempotency",
      "schedule_retry_budget",
      "schedule_unattended_risk",
    ],
    testContract: {
      levels: ["n0", "n1", "n2", "n3", "n4"],
      scenarios: [
        "on_time",
        "duplicate_tick",
        "transient_retry",
        "retry_exhausted",
        "misfire",
        "pending_approval",
      ],
    },
    implementationPaths: [
      "apps/web/src/app/api/cron/scheduled-tasks/route.ts",
      "apps/web/src/lib/scheduled-tasks/scheduled-task-tool-policy.ts",
      "apps/web/src/app/api/cron/operational-cases/route.ts",
    ],
    evidenceDocs: [DOC, "docs/manuals/gu-os-flexible-workflows-technical-plan.md"],
  },
  {
    id: "PATTERN_REUSABLE_SKILL_DOCUMENT_INPUT",
    version: 1,
    status: "active",
    label: "Documento de ejecución para skill reusable",
    description:
      "Lectura de un documento aportado en cada ejecución sin convertirlo en recurso permanente de cuenta.",
    workForms: ["reusable_skill"],
    mandatoryWhen: ["document_intake"],
    requiredCapabilities: [],
    humanInvolvement: ["human_contribution"],
    uiComponents: [],
    persistenceContracts: [],
    auditEvents: ["runtime_document_received", "runtime_document_read"],
    runtimeGuarantees: [
      "El documento se modela como una sola entrada efímera de ejecución.",
      "La skill no supone una ruta de entrega que el operador no haya definido.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "data_sources",
        gapKey: "data_sources.document_intake_route",
        severity: "blocking",
        gap:
          "Falta definir cómo llegará el documento a una entrada de ejecución disponible.",
        question:
          "¿Cómo entregará la persona el documento en cada ejecución y desde qué canal disponible iniciará el trabajo?",
        examples: [
          "adjuntarlo al iniciar desde Web Chat",
          "adjuntarlo al iniciar desde Telegram",
        ],
      },
      {
        targetDimension: "data_sources",
        gapKey: "data_sources.document_intake_policy",
        severity: "defaultable",
        dependsOn: ["data_sources.document_intake_route"],
        gap: "Falta definir qué formatos documentales se admitirán.",
        question:
          "¿Qué formatos de documento debe aceptar Gu en cada ejecución?",
        examples: ["DOCX", "PDF", "TXT"],
        safeDefault:
          "Aceptar únicamente formatos compatibles y seguros habilitados por la plataforma.",
      },
    ],
    compileDirectives: [
      "Materializar exactamente un runtime_input chat_attachment por cada dato documental canónico.",
      "Enlazar data_sources.document_intake_route con esa entrada y un canal de invocación disponible que acepte adjuntos.",
      "Usar read_runtime_attachment o search_runtime_attachments sin persistir el archivo como account_asset.",
    ],
    validationRuleIds: ["runtime_document_input_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3"],
      scenarios: [
        "document_attached",
        "document_missing",
        "unsupported_document_format",
      ],
    },
    implementationPaths: [
      "apps/web/src/lib/workflow-studio/compile-reusable-skill.ts",
      "apps/web/src/lib/agent/wire-tool-deps.ts",
    ],
    evidenceDocs: ["docs/skills-tools-architecture.md"],
  },
  {
    id: "PATTERN_CHANNEL_COPY_RENDERING",
    version: 1,
    status: "active",
    label: "Copy y render por canal",
    description:
      "Adapta estructura y énfasis al canal; convierte Markdown del agente a HTML seguro de Telegram con fallback.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["sends_telegram_message"],
    requiredCapabilities: ["messaging"],
    humanInvolvement: [],
    uiComponents: ["DeliveryPreview"],
    persistenceContracts: [],
    auditEvents: ["channel_render_fallback"],
    runtimeGuarantees: [
      "Telegram nunca recibe Markdown de web sin convertir.",
      "HTML se escapa y un rechazo degrada a texto plano.",
      "El copy conserva intención sin depender de formato no soportado.",
    ],
    dependencies: ["PATTERN_EXTERNAL_MESSAGE_DELIVERY"],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "side_effects",
        gap: "Falta confirmar canal y tipo de mensaje.",
        question:
          "¿Por qué canal se entrega cada mensaje y qué debe conservarse al adaptar su formato?",
        examples: ["Telegram breve con botones", "email con asunto y párrafos"],
      },
    ],
    compileDirectives: [
      "Renderizar copy mediante el adaptador registrado del canal; nunca concatenar markup específico en la skill.",
      "Para Telegram usar conversión Markdown→HTML segura y fallback plain text.",
    ],
    validationRuleIds: ["channel_renderer_registered"],
    testContract: {
      levels: ["n0", "n1", "n3", "n4"],
      scenarios: ["formatted_copy", "escaped_markup", "plain_text_fallback"],
    },
    implementationPaths: [
      "apps/web/src/lib/telegram/send-message.ts",
      "apps/web/src/lib/notify/index.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY",
    version: 1,
    status: "active",
    label: "Límites, split y adjuntos por canal",
    description:
      "Respeta límites de texto/caption, divide semánticamente, decide documento+caption y reintenta fallos transitorios.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["sends_telegram_message"],
    requiredCapabilities: ["messaging"],
    humanInvolvement: [],
    uiComponents: ["DeliveryPreview", "ArtifactPreview"],
    persistenceContracts: [],
    auditEvents: ["channel_message_split", "attachment_fallback"],
    runtimeGuarantees: [
      "Texto y captions respetan límites del canal sin perder contenido.",
      "Adjuntos degradan a texto/enlace estable cuando el canal los rechaza.",
      "429/5xx usan backoff acotado.",
    ],
    dependencies: ["PATTERN_CHANNEL_COPY_RENDERING"],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Usar helpers registrados de truncado/split y delivery plan; no cortar strings ad hoc.",
      "Probar límites 4096/1024, adjunto grande y fallback.",
    ],
    validationRuleIds: ["channel_limits_guard"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["long_text", "caption_overflow", "attachment_rejected", "rate_limit"],
    },
    implementationPaths: [
      "apps/web/src/lib/telegram/send-message.ts",
      "apps/web/src/lib/notify/hitl-telegram-attachment-delivery.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_EXTERNAL_RESPONSE_CORRELATION",
    version: 1,
    status: "active",
    label: "Correlación de respuesta externa",
    description:
      "Vincula una respuesta del contacto con el caso, espera y mensaje saliente correctos.",
    workForms: ["case_workflow", "durable_task"],
    mandatoryWhen: ["external_response_wait"],
    requiredCapabilities: ["detect_replies", "correlate_reply"],
    humanInvolvement: ["exception_review"],
    uiComponents: ["ExceptionPanel"],
    persistenceContracts: ["conversation_case_identity", "external_wait"],
    auditEvents: ["external_reply_correlated", "external_reply_ambiguous"],
    runtimeGuarantees: [
      "No se aplica una respuesta a un caso por coincidencia débil.",
      "La ambigüedad se escala sin mutar estado.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "durability",
        gap: "Falta definir cómo se identifica la respuesta esperada.",
        question:
          "¿Cómo sabrá Gu a qué caso y solicitud corresponde una respuesta recibida?",
        examples: ["hilo de email", "chat y contacto vinculados", "token de solicitud"],
      },
    ],
    compileDirectives: [
      "Persistir identidad de conversación, contacto, caso y mensaje saliente.",
      "Exigir correlación determinística o revisión de excepción antes de avanzar.",
    ],
    validationRuleIds: ["external_reply_identity"],
    testContract: {
      levels: ["n1", "n2", "n3", "n4"],
      scenarios: ["unique_match", "ambiguous_match", "unmatched_reply", "duplicate_reply"],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/conversation-case-identity.ts",
      "packages/workflows/src/guards/builtins.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_DOCUMENT_INTAKE_REVIEW",
    version: 1,
    status: "active",
    label: "Contribución, extracción y revisión documental",
    description:
      "Carga segura, procedencia, extracción, borrador, comentario o reemplazo y reanudación.",
    workForms: CASE_AND_TASK,
    mandatoryWhen: ["document_intake", "human_contribution"],
    requiredCapabilities: ["document_upload", "document_text_extraction"],
    humanInvolvement: ["human_contribution", "business_decision"],
    uiComponents: ["FileContribution", "ArtifactPreview", "DecisionCard"],
    persistenceContracts: [
      "case_documents",
      "pending_attachment_envelope",
      "case_artifacts",
    ],
    auditEvents: [
      "document_uploaded",
      "document_extracted",
      "document_replaced",
      "document_approved",
    ],
    runtimeGuarantees: [
      "Tipo, tamaño y malware se validan antes de procesar.",
      "Procedencia, hash, versión y retención quedan registradas.",
      "Comentario o archivo de reemplazo reanuda el mismo trabajo sin confundir adjuntos.",
    ],
    dependencies: [
      "PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER",
    ],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "data_sources",
        gapKey: "data_sources.document_intake_route",
        severity: "blocking",
        gap:
          "Falta definir cómo llegará el documento a una entrada de ejecución disponible.",
        question:
          "¿Cómo entregará la persona el documento en cada ejecución y desde qué canal disponible iniciará el trabajo?",
        examples: [
          "adjuntarlo al iniciar desde Web Chat",
          "adjuntarlo al iniciar desde Telegram",
        ],
      },
      {
        targetDimension: "data_sources",
        gapKey: "data_sources.document_intake_policy",
        severity: "defaultable",
        dependsOn: ["data_sources.document_intake_route"],
        gap: "Falta definir qué formatos documentales se admitirán.",
        question:
          "¿Qué formatos de documento debe aceptar Gu en cada ejecución?",
        examples: ["DOCX", "PDF", "TXT"],
        safeDefault:
          "Aceptar únicamente formatos compatibles y seguros habilitados por la plataforma.",
      },
    ],
    compileDirectives: [
      "Materializar data_sources.document_intake_route solo con evidencia de entrega por ejecución; un formato de archivo por sí solo no implica una ruta de carga.",
      "Enlazar la estrategia de fuente con exactamente un runtime_input chat_attachment y un canal de invocación disponible que acepte adjuntos.",
      "Declarar tipos/tamaño, malware scan, procedencia, hash, retención y extracción.",
      "Modelar contribución inicial, comentario, archivo de reemplazo, aprobación y reanudación.",
    ],
    validationRuleIds: ["document_intake_policy", "document_resume_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3", "n4"],
      scenarios: [
        "valid_upload",
        "unsupported_type",
        "extraction_failure",
        "comment_revision",
        "replacement_file",
      ],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/case-document-collection.ts",
      "apps/web/src/lib/operational-cases/pending-attachment-envelope.ts",
      "apps/web/src/lib/chat/extract-attachment-text.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_GENERATED_CASE_DOCUMENT_ACCESS",
    version: 1,
    status: "active",
    label: "Documento generado versionado y accesible",
    description:
      "Persiste output_path y ofrece descarga autenticada estable en lugar de signed URLs caducadas.",
    workForms: CASE_AND_TASK,
    mandatoryWhen: ["generated_document"],
    requiredCapabilities: ["document_generation"],
    humanInvolvement: [],
    uiComponents: ["ArtifactPreview", "StableDocumentLink"],
    persistenceContracts: ["case_artifacts", "artifact_inputs"],
    auditEvents: ["document_generated", "document_superseded"],
    runtimeGuarantees: [
      "El documento declara inputs/hash y staleness.",
      "Los mensajes usan enlace estable autenticado, no signed URL efímera.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Persistir output_path, versión, input hash y estado de staleness.",
      "Compartir endpoint estable autenticado y resolver signed URL al descargar.",
    ],
    validationRuleIds: ["generated_document_binding", "stable_document_link"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["generated_download", "stale_input", "superseded_version"],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/generated-case-document.ts",
      "apps/web/src/app/api/operational-cases/[id]/documents/[documentKey]/download/route.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_EXTERNAL_MESSAGE_DELIVERY",
    version: 1,
    status: "active",
    label: "Entrega externa gobernada",
    description:
      "Contrato genérico de entrega para cualquier mensaje externo, con ruta, estrategia de destinatario, autorización y evidencia verificables.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["sends_external_message"],
    requiredCapabilities: [],
    humanInvolvement: ["action_authorization"],
    uiComponents: ["DeliveryPreview", "DecisionCard"],
    persistenceContracts: ["pending_confirmations", "tool_calls"],
    auditEvents: [
      "external_message_delivery_requested",
      "external_message_delivery_approved",
      "external_message_delivered",
    ],
    runtimeGuarantees: [
      "Todo mensaje externo tiene una ruta de entrega lista o un fallback manual explícito.",
      "La estrategia para obtener el destinatario queda definida en autoría; su valor y formato se validan antes del envío.",
      "La autoridad de aprobación y la evidencia aprobada quedan vinculadas al efecto.",
    ],
    dependencies: [
      "PATTERN_OPERATIONAL_WRITE_GATE",
      "PATTERN_HITL_ACTION_CONTRACT",
    ],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "side_effects",
        gapKey: "external_message.delivery_mode",
        severity: "blocking",
        dependsOn: [],
        appliesWhen: [
          "sends_external_message",
          "sends_external_email",
          "sends_telegram_message",
        ],
        gap: "Falta acordar cómo se entrega el mensaje.",
        question:
          "Después de preparar el mensaje, ¿Gu debe enviarlo tras tu aprobación o solo dejarlo listo para que lo envíes tú?",
        examples: ["enviarlo después de mi aprobación", "dejarlo listo para envío manual"],
      },
      {
        targetDimension: "capabilities",
        gapKey: "external_message.channel_provider",
        severity: "defaultable",
        dependsOn: ["external_message.delivery_mode"],
        appliesWhen: [
          "sends_external_message",
          "sends_external_email",
          "sends_telegram_message",
        ],
        gap: "Falta definir cómo se realizará la entrega.",
        question:
          "¿Desde qué cuenta o herramienta debe salir el mensaje?",
        examples: ["Gmail conectado a la cuenta", "dejarlo listo para envío manual"],
        safeDefault:
          "Dejar el mensaje aprobado listo para envío manual sin ejecutar la entrega externa.",
      },
      {
        targetDimension: "actors",
        gapKey: "external_message.recipient_resolution",
        severity: "blocking",
        dependsOn: [],
        appliesWhen: [
          "sends_external_message",
          "sends_external_email",
          "sends_telegram_message",
        ],
        gap: "Falta saber de dónde tomará Gu el contacto en cada uso.",
        question:
          "¿Cómo recibirá Gu el email o contacto del destinatario cada vez que se use esta función?",
        examples: ["el usuario lo escribe en el chat", "se toma de la ficha del caso"],
      },
      {
        targetDimension: "human_decisions",
        gapKey: "external_message.approval_evidence",
        severity: "blocking",
        dependsOn: [
          "external_message.delivery_mode",
          "external_message.recipient_resolution",
        ],
        appliesWhen: [
          "sends_external_message",
          "sends_external_email",
          "sends_telegram_message",
        ],
        gap: "Falta definir quién aprueba y qué revisa antes del envío.",
        question:
          "¿Quién debe aprobar el envío y qué necesita revisar antes de autorizarlo?",
        examples: ["el usuario inmobiliario revisa destinatario y mensaje final"],
      },
    ],
    compileDirectives: [
      "Declarar modo de entrega, ruta de canal/proveedor y fallback manual gobernado.",
      "Materializar la estrategia de destinatario y validar su valor antes de solicitar autorización.",
      "Vincular autoridad y evidencia aprobada al efecto externo ejecutado.",
    ],
    validationRuleIds: [
      "external_message_delivery_mode",
      "external_message_delivery_route",
      "external_message_recipient",
      "external_message_approval",
    ],
    readinessGateIds: [
      "outbound_delivery_route",
      "outbound_recipient_resolution",
      "outbound_approval_authority",
    ],
    testContract: {
      levels: ["n0", "n1", "n2", "n3", "n4"],
      scenarios: [
        "provider_route",
        "manual_fallback",
        "recipient_unresolved",
        "approval_missing",
        "approved_delivery",
      ],
    },
    implementationPaths: [
      "packages/workflows/src/compiler/solution-patterns.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_EMAIL_SEND_WITH_APPROVAL",
    version: 1,
    status: "active",
    label: "Email externo con preview y autorización",
    description:
      "Todo envío externo muestra destinatario, asunto, cuerpo, adjuntos y evidencia antes de ejecutar.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["sends_external_email"],
    requiredCapabilities: ["user_email.send"],
    humanInvolvement: ["action_authorization"],
    uiComponents: ["DeliveryPreview", "ArtifactPreview", "DecisionCard"],
    persistenceContracts: ["pending_confirmations", "tool_calls"],
    auditEvents: ["email_send_requested", "email_send_approved", "email_sent"],
    runtimeGuarantees: [
      "No se envía email externo sin autorización explícita sobre evidencia actual.",
      "La aprobación fija destinatario, asunto, cuerpo, adjuntos y fuente.",
      "Cambiar el borrador invalida la autorización anterior.",
    ],
    dependencies: [
      "PATTERN_EXTERNAL_MESSAGE_DELIVERY",
      "PATTERN_HITL_ACTION_CONTRACT",
      "PATTERN_OPERATIONAL_WRITE_GATE",
      "PATTERN_TOOL_AUDIT_SINGLE_OWNER",
    ],
    incompatibilities: [],
    authoringHints: [
      {
        targetDimension: "human_decisions",
        gap: "Falta definir quién autoriza y qué ve antes del envío.",
        question:
          "¿Quién aprueba el email y qué evidencia debe revisar antes de que Gu lo envíe?",
        examples: ["destinatario, asunto y cuerpo", "documento fuente", "adjunto final"],
      },
    ],
    compileDirectives: [
      "Preparar preview con destinatario, asunto, cuerpo, adjuntos y fuentes.",
      "Usar autorización HITL vinculada al hash de esa evidencia.",
      "Ejecutar gmail_send_email solo tras aprobación vigente y auditar message id.",
    ],
    validationRuleIds: ["external_email_approval", "email_provider_ready"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3", "n4"],
      scenarios: [
        "preview",
        "approve_send",
        "request_changes",
        "changed_after_approval",
        "provider_not_connected",
      ],
    },
    implementationPaths: [
      "apps/web/src/lib/gmail/send-message.ts",
      "apps/web/src/lib/business-decisions/contract-review.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_HITL_ACTION_CONTRACT",
    version: 1,
    status: "active",
    label: "Contrato HITL multicanal",
    description:
      "Una decisión y un contrato canónico de acciones, renderizado por adaptadores web/Telegram.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["human_approval", "business_decision"],
    requiredCapabilities: [],
    humanInvolvement: ["action_authorization", "business_decision"],
    uiComponents: ["DecisionCard"],
    persistenceContracts: ["pending_business_decisions"],
    auditEvents: ["decision_requested", "decision_resolved"],
    runtimeGuarantees: [
      "Web y Telegram exponen las mismas acciones de negocio.",
      "Texto libre y botones convergen en el mismo handler.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Registrar acciones en el contrato HITL canónico y reutilizar handlers por canal.",
    ],
    validationRuleIds: ["hitl_action_parity"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["web_action", "telegram_action", "free_text_action"],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/hitl-action-contract.ts",
      "apps/web/src/lib/operational-cases/web-hitl-presentation.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_INTEGRATION_RECONNECT_DEGRADED_CONTINUATION",
    version: 1,
    status: "active",
    label: "Reconexión y continuación degradada",
    description:
      "Reintento acotado, reconexión accionable y fallback manual sin afirmar éxito remoto.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["integration_dependency"],
    requiredCapabilities: [],
    humanInvolvement: ["exception_review"],
    uiComponents: ["IntegrationChoice", "ExceptionPanel"],
    persistenceContracts: ["user_integrations", "account_tool_secrets"],
    auditEvents: ["integration_failed", "integration_reconnected", "manual_fallback"],
    runtimeGuarantees: [
      "Un fallo de integración nunca se reporta como éxito.",
      "Reconexión, retry y fallback quedan diferenciados y auditados.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Verificar readiness antes de ejecutar; ofrecer reconexión y fallback manual gobernado.",
    ],
    validationRuleIds: ["integration_readiness"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["connected", "revoked", "retry_success", "manual_fallback"],
    },
    implementationPaths: [
      "apps/web/src/lib/tool-readiness/provider-readiness.ts",
      "apps/web/src/lib/account-tool-providers.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
    version: 1,
    status: "active",
    label: "Dedup Telegram en un turno",
    description:
      "Evita envíos equivalentes repetidos al mismo contacto dentro de un turno/tick.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["sends_telegram_message"],
    requiredCapabilities: ["messaging.send"],
    humanInvolvement: [],
    uiComponents: [],
    persistenceContracts: ["tool_calls"],
    auditEvents: ["telegram_send_deduplicated"],
    runtimeGuarantees: ["Un texto equivalente se entrega como máximo una vez por turno."],
    dependencies: ["PATTERN_EXTERNAL_MESSAGE_DELIVERY"],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Aplicar idempotentSameMessageDedupKey al envío externo por Telegram.",
    ],
    validationRuleIds: ["telegram_same_turn_dedup"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["single_send", "duplicate_tool_call"],
    },
    implementationPaths: [
      "packages/types/src/telegram-send-dedup.ts",
      "packages/agent/src/tools/realestate-adapters.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_OPERATIONAL_WRITE_GATE",
    version: 1,
    status: "active",
    label: "Gate de escritura operacional",
    description:
      "Toda mutación o efecto externo atraviesa políticas de estado, riesgo y autorización.",
    workForms: ALL_FORMS,
    mandatoryWhen: ["external_write", "sends_external_message"],
    requiredCapabilities: [],
    humanInvolvement: ["action_authorization"],
    uiComponents: [],
    persistenceContracts: ["tool_calls", "pending_confirmations"],
    auditEvents: ["write_blocked", "write_authorized", "write_executed"],
    runtimeGuarantees: [
      "No hay escrituras fuera del gate registrado.",
      "Estado, tenant y autorización se validan antes del efecto.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: ["Ejecutar toda escritura mediante el gate operacional registrado."],
    validationRuleIds: ["operational_write_gate"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["allowed", "blocked_state", "missing_authorization"],
    },
    implementationPaths: [
      "packages/agent/src/tools/operational-cases-adapters.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER",
    version: 1,
    status: "active",
    label: "Remediación determinística con breaker",
    description:
      "Reintenta fallos mecánicos con presupuesto y escala a una persona al agotarlo.",
    workForms: CASE_AND_TASK,
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: ["exception_review"],
    uiComponents: ["ExceptionPanel"],
    persistenceContracts: ["remediation_attempts"],
    auditEvents: ["remediation_retried", "remediation_escalated"],
    runtimeGuarantees: [
      "Ningún bloqueo termina en espera silenciosa.",
      "El presupuesto de retry es finito y observable.",
    ],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Clasificar dueño de remediación y aplicar retry acotado o escalado explícito.",
    ],
    validationRuleIds: ["remediation_owner", "retry_budget"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["retry_success", "breaker_exhausted"],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/property-optioning-post-agent-invariants.ts",
    ],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_TOOL_AUDIT_SINGLE_OWNER",
    version: 1,
    status: "active",
    label: "Un dueño de auditoría por tool",
    description:
      "Evita registros duplicados y conserva estado final ejecutado/deduplicado/fallido.",
    workForms: ALL_FORMS,
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: [],
    uiComponents: [],
    persistenceContracts: ["tool_calls"],
    auditEvents: ["tool_call_recorded"],
    runtimeGuarantees: ["Cada ejecución de tool tiene un único dueño de auditoría."],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Declarar si handler o graph persiste la auditoría; nunca ambos.",
    ],
    validationRuleIds: ["tool_audit_owner"],
    testContract: {
      levels: ["n1", "n3", "n4"],
      scenarios: ["executed", "deduplicated", "failed"],
    },
    implementationPaths: ["packages/agent/src/graph.ts"],
    evidenceDocs: [DOC],
  },
  {
    id: "PATTERN_SKILL_TEST_CONTRACT",
    version: 1,
    status: "active",
    label: "Contrato de prueba de skill",
    description:
      "Inputs, precondiciones, tool calls, outcomes y prohibiciones verificables.",
    workForms: ["reusable_skill", "case_workflow"],
    mandatoryWhen: [],
    requiredCapabilities: [],
    humanInvolvement: [],
    uiComponents: [],
    persistenceContracts: [],
    auditEvents: [],
    runtimeGuarantees: ["Toda skill generada declara un contrato de prueba reproducible."],
    dependencies: [],
    incompatibilities: [],
    authoringHints: [],
    compileDirectives: [
      "Generar contrato de prueba con escenarios positivos, negativos y guardrails.",
    ],
    validationRuleIds: ["skill_test_contract"],
    testContract: {
      levels: ["n0", "n1", "n2", "n3"],
      scenarios: ["positive", "negative", "guardrail"],
    },
    implementationPaths: [
      "apps/web/src/lib/operational-cases/test-patterns-catalog.ts",
    ],
    evidenceDocs: [DOC],
  },
];

export const SOLUTION_PATTERNS: readonly SolutionPattern[] =
  RAW_SOLUTION_PATTERNS.map((pattern) => solutionPatternSchema.parse(pattern));

export interface WorkFormBaseBundle {
  id: string;
  workForm: SolutionPatternWorkForm;
  basePatternIds: readonly string[];
}

export const WORK_FORM_BASE_BUNDLES: Readonly<
  Record<SolutionPatternWorkForm, WorkFormBaseBundle>
> = {
  case_workflow: {
    id: "case_workflow_base",
    workForm: "case_workflow",
    basePatternIds: ["PATTERN_BASE_CASE_WORKFLOW"],
  },
  durable_task: {
    id: "durable_task_base",
    workForm: "durable_task",
    basePatternIds: ["PATTERN_BASE_DURABLE_TASK"],
  },
  reusable_skill: {
    id: "reusable_skill_base",
    workForm: "reusable_skill",
    basePatternIds: ["PATTERN_BASE_REUSABLE_SKILL"],
  },
  schedule: {
    id: "scheduled_durable_task_base",
    workForm: "schedule",
    basePatternIds: [
      "PATTERN_BASE_DURABLE_TASK",
      "PATTERN_SCHEDULED_TASK_SAFETY",
    ],
  },
};

const PATTERN_BY_ID = new Map(
  SOLUTION_PATTERNS.map((pattern) => [pattern.id, pattern])
);

export interface SolutionPatternComposition {
  workForm: SolutionPatternWorkForm;
  baseBundleId: string;
  triggers: SolutionPatternTrigger[];
  patternIds: string[];
  patterns: SolutionPattern[];
  issues: string[];
}

export const SOLUTION_PATTERN_READINESS_ROUTE_STATUSES = [
  "ready",
  "manual_fallback",
  "unresolved",
] as const;

export interface SolutionPatternReadinessCapabilityNeed {
  capabilityId: string;
  requiredFor: readonly string[];
  routing: {
    status: (typeof SOLUTION_PATTERN_READINESS_ROUTE_STATUSES)[number];
    routeId?: string;
    evidence?: readonly string[];
  };
}

export interface SolutionPatternReadinessDimension {
  key: (typeof AUTHORING_DISCOVERY_DIMENSIONS)[number];
  status: "covered" | "partial" | "missing" | "not_applicable";
  evidence?: readonly string[];
}

export interface SolutionPatternReadinessState {
  requestedSideEffects: readonly string[];
  capabilityNeeds: readonly SolutionPatternReadinessCapabilityNeed[];
  understanding: {
    dimensions?: readonly SolutionPatternReadinessDimension[];
    recipientResolution?: {
      status: "resolved" | "runtime_resolvable" | "unresolved";
      evidence?: readonly string[];
    };
    approvalAuthority?: {
      authorityId: string;
      evidence?: readonly string[];
    };
  };
}

export interface SolutionPatternReadinessViolation {
  gateId: SolutionPatternReadinessGateId;
  code:
    | "outbound_route_unresolved"
    | "outbound_recipient_unresolved"
    | "outbound_approval_authority_unresolved";
  message: string;
  patternIds: string[];
}

export interface SolutionPatternReadinessResult {
  ready: boolean;
  gateIds: SolutionPatternReadinessGateId[];
  passedGateIds: SolutionPatternReadinessGateId[];
  violations: SolutionPatternReadinessViolation[];
}

export function inferSolutionPatternTriggers(params: {
  requestedSideEffects?: readonly string[];
  capabilityCategoryIds?: readonly string[];
  capabilityProviderIds?: readonly string[];
  inputRequirementKinds?: readonly string[];
  inputSourceHints?: readonly string[];
}): SolutionPatternTrigger[] {
  const sideEffects = new Set(params.requestedSideEffects ?? []);
  const categories = new Set(params.capabilityCategoryIds ?? []);
  const providers = new Set(params.capabilityProviderIds ?? []);
  const inputKinds = new Set(params.inputRequirementKinds ?? []);
  const inputSourceHints = new Set(params.inputSourceHints ?? []);
  const triggers = new Set<SolutionPatternTrigger>();
  if (sideEffects.has("schedule_recurrence")) triggers.add("scheduled_execution");
  if (sideEffects.has("external_write")) triggers.add("external_write");
  if (sideEffects.has("human_approval")) triggers.add("human_approval");
  if (sideEffects.has("send_message")) triggers.add("sends_external_message");
  if (categories.has("user_email") || categories.has("transactional_email")) {
    triggers.add("sends_external_email");
    triggers.add("integration_dependency");
  }
  if (categories.has("messaging") && providers.has("telegram_bot")) {
    triggers.add("sends_telegram_message");
    triggers.add("integration_dependency");
  }
  if (
    categories.has("document_storage") ||
    inputSourceHints.has("chat_attachment") ||
    inputSourceHints.has("document_source")
  ) {
    triggers.add("document_intake");
    triggers.add("human_contribution");
  }
  if (inputKinds.has("generated_artifact")) {
    triggers.add("generated_document");
  }
  if (categories.size > 0) triggers.add("integration_dependency");
  return [...triggers].sort();
}

export function resolveSolutionPatternComposition(params: {
  workForm: SolutionPatternWorkForm;
  triggers?: readonly SolutionPatternTrigger[];
  selectedPatternIds?: readonly string[];
}): SolutionPatternComposition {
  const triggers = [...new Set(params.triggers ?? [])].sort();
  const bundle = WORK_FORM_BASE_BUNDLES[params.workForm];
  const ids = new Set<string>([
    ...bundle.basePatternIds,
    ...(params.selectedPatternIds ?? []),
  ]);
  for (const pattern of SOLUTION_PATTERNS) {
    if (!pattern.workForms.includes(params.workForm)) continue;
    if (pattern.mandatoryWhen.some((trigger) => triggers.includes(trigger))) {
      ids.add(pattern.id);
    }
  }

  const issues: string[] = [];
  const visit = (id: string, stack: string[]) => {
    const pattern = PATTERN_BY_ID.get(id);
    if (!pattern) {
      issues.push(`unknown_pattern:${id}`);
      return;
    }
    if (!pattern.workForms.includes(params.workForm)) {
      issues.push(`pattern_not_applicable:${id}:${params.workForm}`);
      return;
    }
    if (stack.includes(id)) {
      issues.push(`dependency_cycle:${[...stack, id].join(">")}`);
      return;
    }
    for (const dependency of pattern.dependencies) {
      ids.add(dependency);
      visit(dependency, [...stack, id]);
    }
  };
  for (const id of [...ids]) visit(id, []);

  const patterns = [...ids]
    .map((id) => PATTERN_BY_ID.get(id))
    .filter((pattern): pattern is SolutionPattern => Boolean(pattern))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const pattern of patterns) {
    for (const incompatible of pattern.incompatibilities) {
      if (ids.has(incompatible)) {
        issues.push(`incompatible_patterns:${pattern.id}:${incompatible}`);
      }
    }
  }
  return {
    workForm: params.workForm,
    baseBundleId: bundle.id,
    triggers,
    patternIds: patterns.map((pattern) => pattern.id),
    patterns,
    issues: [...new Set(issues)].sort(),
  };
}

export function readinessGateIdsForComposition(
  composition: SolutionPatternComposition
): SolutionPatternReadinessGateId[] {
  const contributed = new Set(
    composition.patterns.flatMap((pattern) => pattern.readinessGateIds)
  );
  return SOLUTION_PATTERN_READINESS_GATE_IDS.filter((gateId) =>
    contributed.has(gateId)
  );
}

const hasReadinessEvidence = (evidence?: readonly string[]): boolean =>
  Boolean(evidence?.some((item) => item.trim().length > 0));

const dimensionReadinessEvidence = (
  state: SolutionPatternReadinessState,
  key: SolutionPatternReadinessDimension["key"]
): readonly string[] | undefined => {
  const dimension = state.understanding.dimensions?.find(
    (candidate) =>
      candidate.key === key &&
      (candidate.status === "covered" || candidate.status === "partial")
  );
  return dimension?.evidence;
};

export function evaluateSolutionPatternReadiness(params: {
  composition: SolutionPatternComposition;
  state: SolutionPatternReadinessState;
}): SolutionPatternReadinessResult {
  const gateIds = readinessGateIdsForComposition(params.composition);
  const passedGateIds: SolutionPatternReadinessGateId[] = [];
  const violations: SolutionPatternReadinessViolation[] = [];
  const requestedSideEffects = new Set(params.state.requestedSideEffects);

  for (const gateId of gateIds) {
    const patternIds = params.composition.patterns
      .filter((pattern) => pattern.readinessGateIds.includes(gateId))
      .map((pattern) => pattern.id)
      .sort();

    if (gateId === "outbound_delivery_route") {
      const capabilitiesEvidence = dimensionReadinessEvidence(
        params.state,
        "capabilities"
      );
      const routeReady = params.state.capabilityNeeds.some((need) => {
        if (
          !need.requiredFor.some((sideEffect) =>
            requestedSideEffects.has(sideEffect)
          )
        ) {
          return false;
        }
        if (need.routing.status === "ready") {
          return Boolean(need.routing.routeId?.trim());
        }
        return (
          need.routing.status === "manual_fallback" &&
          (hasReadinessEvidence(need.routing.evidence) ||
            hasReadinessEvidence(capabilitiesEvidence))
        );
      });
      if (routeReady) {
        passedGateIds.push(gateId);
      } else {
        violations.push({
          gateId,
          code: "outbound_route_unresolved",
          message:
            "Outbound delivery requires a ready route or an evidenced manual fallback.",
          patternIds,
        });
      }
      continue;
    }

    if (gateId === "outbound_recipient_resolution") {
      const recipient = params.state.understanding.recipientResolution;
      const recipientEvidence =
        recipient?.evidence ??
        dimensionReadinessEvidence(params.state, "actors");
      if (
        recipient &&
        recipient.status !== "unresolved" &&
        hasReadinessEvidence(recipientEvidence)
      ) {
        passedGateIds.push(gateId);
      } else {
        violations.push({
          gateId,
          code: "outbound_recipient_unresolved",
          message:
            "Outbound delivery requires an evidenced deterministic or runtime recipient resolution.",
          patternIds,
        });
      }
      continue;
    }

    const approval = params.state.understanding.approvalAuthority;
    const approvalEvidence =
      approval?.evidence ??
      dimensionReadinessEvidence(params.state, "human_decisions");
    if (
      approval?.authorityId.trim() &&
      hasReadinessEvidence(approvalEvidence)
    ) {
      passedGateIds.push(gateId);
    } else {
      violations.push({
        gateId,
        code: "outbound_approval_authority_unresolved",
        message:
          "Outbound delivery requires an identified approval authority with supporting evidence.",
        patternIds,
      });
    }
  }

  return {
    ready: violations.length === 0,
    gateIds,
    passedGateIds,
    violations,
  };
}

export function authoringHintsForComposition(
  composition: SolutionPatternComposition
): SolutionPattern["authoringHints"] {
  const seen = new Set<string>();
  return composition.patterns.flatMap((pattern) =>
    pattern.authoringHints.filter((hint) => {
      if (
        hint.appliesWhen &&
        !hint.appliesWhen.some((trigger) =>
          composition.triggers.includes(trigger)
        )
      ) {
        return false;
      }
      if (seen.has(hint.gapKey)) return false;
      seen.add(hint.gapKey);
      return true;
    })
  );
}
