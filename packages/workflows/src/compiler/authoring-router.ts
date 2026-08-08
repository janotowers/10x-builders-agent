/**
 * Contratos puros del router de autoría del Studio (Slice 5.3).
 *
 * Taxonomía (finding 29):
 *   Artefactos: case_workflow | durable_task | reusable_skill(simple|composite) | schedule
 *   Sin artefacto: clarify | redirect_to_chat
 *
 * Este módulo es puro: clasificación determinística + fixtures de la batería
 * inmobiliaria + gate de fidelidad. La invocación del modelo vive en apps/web.
 */

import { z } from "zod";

export const AUTHORING_ARTIFACT_KINDS = [
  "case_workflow",
  "durable_task",
  "reusable_skill",
  "schedule",
] as const;

export type AuthoringArtifactKind = (typeof AUTHORING_ARTIFACT_KINDS)[number];

export const AUTHORING_NON_ARTIFACT_KINDS = [
  "clarify",
  "redirect_to_chat",
] as const;

export type AuthoringNonArtifactKind =
  (typeof AUTHORING_NON_ARTIFACT_KINDS)[number];

export const AUTHORING_ROUTER_KINDS = [
  ...AUTHORING_ARTIFACT_KINDS,
  ...AUTHORING_NON_ARTIFACT_KINDS,
] as const;

export type AuthoringRouterKind = (typeof AUTHORING_ROUTER_KINDS)[number];

export const REUSABLE_SKILL_SUBTYPES = ["simple", "composite"] as const;
export type ReusableSkillSubtype = (typeof REUSABLE_SKILL_SUBTYPES)[number];

export const authoringRouterOutputSchema = z.object({
  kind: z.enum(AUTHORING_ROUTER_KINDS),
  skill_subtype: z.enum(REUSABLE_SKILL_SUBTYPES).optional(),
  confidence: z.enum(["high", "medium", "low"]),
  reasons: z.array(z.string().min(1)).default([]),
  clarifying_questions: z.array(z.string().min(1)).max(5).default([]),
  suggested_title: z.string().optional(),
  suggested_slug: z.string().optional(),
  requested_side_effects: z
    .array(
      z.enum([
        "send_message",
        "human_approval",
        "schedule_recurrence",
        "external_write",
        "create_case",
      ])
    )
    .default([]),
  dimensions: z
    .object({
      expected_outcome: z.string().optional(),
      reusable: z.boolean().optional(),
      multi_day_state: z.boolean().optional(),
      recurrence: z.boolean().optional(),
      external_actors: z.boolean().optional(),
      hitl_required: z.boolean().optional(),
      data_source_ambiguous: z.boolean().optional(),
    })
    .optional(),
});

export type AuthoringRouterOutput = z.infer<typeof authoringRouterOutputSchema>;

export interface AuthoringBatteryFixture {
  id: string;
  description: string;
  expectedKind: AuthoringRouterKind;
  expectedSkillSubtype?: ReusableSkillSubtype;
  notes?: string;
}

/** Batería inmobiliaria del walkthrough (gu-os-studio-human-walkthrough.md). */
export const AUTHORING_BATTERY_FIXTURES: readonly AuthoringBatteryFixture[] = [
  {
    id: "owner_followup_message",
    description:
      "Cada vez que prepares un seguimiento para un propietario, resume el último acuerdo y termina proponiendo una siguiente acción concreta; nunca inventes compromisos ni fechas.",
    expectedKind: "reusable_skill",
    expectedSkillSubtype: "simple",
  },
  {
    id: "captacion_prep_folder",
    description:
      "Antes de una cita de captación, prepara una carpeta con datos de la propiedad, zona, comparables, pendientes, antecedentes del propietario y agenda sugerida.",
    expectedKind: "reusable_skill",
    expectedSkillSubtype: "composite",
  },
  {
    id: "property_visit_coordination",
    description:
      "Coordinación de visita a propiedad: prospecto solicita visita, reunir datos, obtener horarios, aprobación del asesor, coordinar y confirmar, recordar, registrar realizada/reprogramada/cancelada/no-show. No inventar disponibilidad ni contactos.",
    expectedKind: "case_workflow",
  },
  {
    id: "rental_applicant_review",
    description:
      "Reunir el expediente del solicitante de arrendamiento, identificar faltantes y pedir decisión al asesor o propietario; Gu no aprueba ni rechaza automáticamente.",
    expectedKind: "case_workflow",
  },
  {
    id: "inventory_batch_analysis",
    description:
      "Analiza 300 propiedades activas y produce un reporte de posibles subvaluadas, incompletas, duplicadas y prioritarias.",
    expectedKind: "durable_task",
  },
  {
    id: "missing_docs_batch",
    description:
      "Revisa expedientes de propiedades activas, detecta documentos faltantes o vencidos y reporta por asesor.",
    expectedKind: "durable_task",
  },
  {
    id: "monday_inactive_leads",
    description:
      "Cada lunes a las 08:00 revisar leads sin actividad en siete días y entregar a cada asesor una lista priorizada.",
    expectedKind: "schedule",
  },
  {
    id: "portal_crm_sync",
    description:
      "Sincronizar leads de portales con nuestro CRM y evitar duplicados.",
    expectedKind: "clarify",
    notes: "Debe preguntar qué CRM; no inventar adapter.",
  },
  {
    id: "improve_prospect_followup",
    description: "Ayúdame a mejorar el seguimiento de mis prospectos.",
    expectedKind: "clarify",
  },
  {
    id: "one_shot_listing_description",
    description: "Con estos datos, redacta la descripción de esta propiedad.",
    expectedKind: "redirect_to_chat",
  },
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Clasificador determinístico para intenciones claras. Devuelve null cuando
 * hace falta el modelo (ambigüedad / confianza baja).
 */
export function classifyAuthoringIntentDeterministic(
  description: string
): AuthoringRouterOutput | null {
  const text = normalize(description.trim());
  if (!text) {
    return {
      kind: "clarify",
      confidence: "high",
      reasons: ["Descripción vacía"],
      clarifying_questions: ["¿Qué quieres que Gu haga o construya?"],
      requested_side_effects: [],
    };
  }

  if (
    /\b(con estos datos|redacta|escribe|ahora mismo|esta propiedad)\b/.test(text) &&
    !/\bcada vez|siempre que|flujo|proceso|coordin|expediente\b/.test(text)
  ) {
    return {
      kind: "redirect_to_chat",
      confidence: "high",
      reasons: ["Parece una consulta puntual de ejecución, no un artefacto reusable"],
      clarifying_questions: [],
      requested_side_effects: [],
      suggested_title: "Consulta puntual",
    };
  }

  if (
    /\b(cada lunes|cada dia|cada semana|cron|a las \d|todos los|periodicamente|recurrente)\b/.test(
      text
    )
  ) {
    return {
      kind: "schedule",
      confidence: "high",
      reasons: ["Describe recurrencia temporal explícita"],
      clarifying_questions: [],
      requested_side_effects: ["schedule_recurrence"],
      suggested_slug: suggestEnglishSlug(description),
      dimensions: { recurrence: true, reusable: true },
    };
  }

  if (
    (/\b(\d{2,}|cien|doscient|trescient|muchas|lote|batch|inventario|reporte de|analiza \d)\b/.test(
      text
    ) ||
      /\b(expedientes?|documentos faltantes|faltantes o vencidos|por asesor)\b/.test(
        text
      )) &&
    /\b(analiz|revis|reporte|reporta|detect|produ[cz])\b/.test(text) &&
    !/\bcaso|expediente del solicitante|coordinacion de visita|aprobacion del asesor|solicitante\b/.test(
      text
    )
  ) {
    return {
      kind: "durable_task",
      confidence: "high",
      reasons: ["Trabajo batch o de resultado sin expediente comercial por entidad"],
      clarifying_questions: [],
      requested_side_effects: [],
      suggested_slug: suggestEnglishSlug(description),
      dimensions: { reusable: false, multi_day_state: false },
    };
  }

  if (
    /\b(coordinacion|coordinar visita|expediente|aprobacion del asesor|hitl|reprogramad|no-show|arrendamiento|solicitante)\b/.test(
      text
    ) &&
    /\b(prospecto|asesor|propietario|visita|faltantes|decision)\b/.test(text)
  ) {
    return {
      kind: "case_workflow",
      confidence: "high",
      reasons: ["Proceso multi-paso con actores externos y estado comercial durable"],
      clarifying_questions: [],
      requested_side_effects: ["human_approval", "create_case"],
      suggested_slug: suggestEnglishSlug(description),
      dimensions: {
        multi_day_state: true,
        external_actors: true,
        hitl_required: true,
        reusable: true,
      },
    };
  }

  if (
    /\b(cada vez que|siempre que prepares|cuando prepares|plantilla de mensaje|mensaje de seguimiento)\b/.test(
      text
    ) &&
    !/\benviar|mandar|programar|cada lunes\b/.test(text)
  ) {
    const composite = /\b(carpeta|comparables|agenda|antecedentes|varios|compuest)\b/.test(
      text
    );
    return {
      kind: "reusable_skill",
      skill_subtype: composite ? "composite" : "simple",
      confidence: "high",
      reasons: [
        composite
          ? "Procedimiento reusable que compone varias capacidades"
          : "Procedimiento reusable simple de redacción/preparación",
      ],
      clarifying_questions: [],
      requested_side_effects: [],
      suggested_title: composite ? "Preparación de carpeta" : "Mensaje de seguimiento",
      suggested_slug: composite ? "captacion_prep_folder" : "owner_followup_message",
      dimensions: { reusable: true, multi_day_state: false },
    };
  }

  // "Antes de una cita..." composite skill without "cada vez"
  if (
    /\b(antes de una cita|prepara una carpeta|carpeta con datos)\b/.test(text)
  ) {
    return {
      kind: "reusable_skill",
      skill_subtype: "composite",
      confidence: "high",
      reasons: ["Procedimiento reusable que compone varias capacidades"],
      clarifying_questions: [],
      requested_side_effects: [],
      suggested_title: "Preparación de carpeta",
      suggested_slug: "captacion_prep_folder",
      dimensions: { reusable: true, multi_day_state: false },
    };
  }

  if (/\b(mejorar|ayudame|ayuda a|optimizar)\b/.test(text) && text.length < 120) {
    return {
      kind: "clarify",
      confidence: "high",
      reasons: ["Intención demasiado amplia / ambigua"],
      clarifying_questions: [
        "¿Qué resultado concreto quieres (mensaje, lista, flujo de caso, reporte)?",
        "¿Es un procedimiento reusable, un trabajo único o algo recurrente?",
        "¿Quiénes participan además de ti (prospecto, propietario, equipo)?",
      ],
      requested_side_effects: [],
      dimensions: { data_source_ambiguous: true },
    };
  }

  if (/\b(crm|sincroniz|portales?)\b/.test(text) && /\b(nuestro|mi)\b/.test(text)) {
    return {
      kind: "clarify",
      confidence: "high",
      reasons: ["Falta identificar el sistema externo concreto"],
      clarifying_questions: [
        "¿Qué CRM o sistema concreto usas hoy?",
        "¿La sincronización debe ser automática y recurrente, o un trabajo puntual?",
      ],
      requested_side_effects: ["external_write"],
      dimensions: { data_source_ambiguous: true },
    };
  }

  return null;
}

export function parseAuthoringRouterOutput(
  raw: unknown
): AuthoringRouterOutput | null {
  const parsed = authoringRouterOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isArtifactKind(
  kind: AuthoringRouterKind
): kind is AuthoringArtifactKind {
  return (AUTHORING_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/**
 * Gate de fidelidad: el compilador no puede agregar side effects que el
 * operador no pidió (enviar, aprobar, recurrencia, etc.).
 */
export function detectUnrequestedSideEffects(params: {
  description: string;
  requested?: AuthoringRouterOutput["requested_side_effects"];
  compiledSignals: {
    sendsMessage?: boolean;
    requiresApproval?: boolean;
    hasSchedule?: boolean;
    createsCaseWorkflow?: boolean;
  };
}): string[] {
  const text = normalize(params.description);
  const requested = new Set(params.requested ?? []);
  const failures: string[] = [];

  const askedSend = /\b(enviar|manda|mandar|envia)\b/.test(text);
  const askedApproval =
    /\b(aprobacion|aprobar|revision humana|hitl|decision del asesor)\b/.test(text);
  const askedSchedule =
    /\b(cada lunes|cada semana|cron|recurrente|programad)\b/.test(text);

  if (
    params.compiledSignals.sendsMessage &&
    !askedSend &&
    !requested.has("send_message")
  ) {
    failures.push(
      "El borrador agrega envío de mensaje aunque la descripción solo pide preparar/redactar"
    );
  }
  if (
    params.compiledSignals.requiresApproval &&
    !askedApproval &&
    !requested.has("human_approval") &&
    !params.compiledSignals.createsCaseWorkflow
  ) {
    failures.push(
      "El borrador exige aprobación humana formal sin que se haya solicitado"
    );
  }
  if (
    params.compiledSignals.hasSchedule &&
    !askedSchedule &&
    !requested.has("schedule_recurrence")
  ) {
    failures.push("El borrador introduce recurrencia/programación no solicitada");
  }
  return failures;
}

/**
 * Frases ES → slug EN canónico (batería Studio + títulos frecuentes).
 * Orden: más específicas primero.
 */
const SPANISH_PHRASE_SLUGS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bseguimiento\s+cordial\s+(?:a\s+)?propietarios?\b/,
    "owner_followup_message",
  ],
  [
    /\bpreparaci[oó]n\s+de\s+cita\s+de\s+captaci[oó]n\b/,
    "captacion_prep_folder",
  ],
  [
    /\bcoordinaci[oó]n\s+de\s+visita(?:\s+a\s+(?:una\s+|la\s+)?propiedad)?\b/,
    "property_visit_coordination",
  ],
  [
    /\bevaluaci[oó]n\s+de\s+solicitud\s+de\s+arrendamiento\b/,
    "rental_applicant_review",
  ],
  [/\bauditor[ií]a\s+del?\s+inventario(?:\s+activo)?\b/, "inventory_batch_analysis"],
  [
    /\brevisi[oó]n\s+masiva\s+de\s+expedientes\b/,
    "missing_docs_batch",
  ],
  [
    /\bseguimiento\s+semanal\s+de\s+leads?\s+inactivos?\b/,
    "monday_inactive_leads",
  ],
  [
    /\bsincronizaci[oó]n\s+de\s+leads?\s+con\s+crm\b/,
    "portal_crm_sync",
  ],
  [/\bmensaje\s+de\s+seguimiento\s+(?:a\s+)?propietarios?\b/, "owner_followup_message"],
  [/\bseguimiento\s+(?:a\s+)?propietarios?\b/, "owner_followup"],
];

/** Palabras ES frecuentes → EN para identificadores técnicos. */
const SPANISH_WORD_TO_ENGLISH: Readonly<Record<string, string>> = {
  seguimiento: "followup",
  mensaje: "message",
  mensajes: "messages",
  propietario: "owner",
  propietarios: "owners",
  cordial: "cordial",
  preparacion: "prep",
  cita: "appointment",
  captacion: "listing_intake",
  coordinacion: "coordination",
  visita: "visit",
  visitas: "visits",
  propiedad: "property",
  propiedades: "properties",
  evaluacion: "review",
  solicitud: "application",
  solicitudes: "applications",
  arrendamiento: "rental",
  renta: "rental",
  auditoria: "audit",
  inventario: "inventory",
  activo: "active",
  activos: "active",
  revision: "review",
  masiva: "batch",
  masivo: "batch",
  expediente: "dossier",
  expedientes: "dossiers",
  documental: "document",
  documentos: "documents",
  documento: "document",
  semanal: "weekly",
  inactivo: "inactive",
  inactivos: "inactive",
  sincronizacion: "sync",
  prospecto: "prospect",
  prospectos: "prospects",
  asesor: "advisor",
  asesores: "advisors",
  aprobacion: "approval",
  recordatorio: "reminder",
  confirmacion: "confirmation",
  disponibilidad: "availability",
  horario: "schedule",
  horarios: "schedules",
  carpeta: "folder",
  zona: "area",
  comparables: "comparables",
  agenda: "agenda",
  reunion: "meeting",
  reporte: "report",
  lista: "list",
  priorizada: "prioritized",
  priorizado: "prioritized",
  analisis: "analysis",
  analiza: "analyze",
  subvaluados: "undervalued",
  incompleta: "incomplete",
  incompleto: "incomplete",
  duplicados: "duplicates",
  oportunidades: "opportunities",
  ilegibles: "unreadable",
  vencidos: "expired",
  faltantes: "missing",
  faltante: "missing",
};

/**
 * Genera un slug inglés snake_case corto a partir de un título o descripción.
 * Traduce frases/palabras ES habituales; no llama a un modelo.
 */
export function suggestEnglishSlug(titleOrDescription: string): string {
  const raw = titleOrDescription.trim();
  if (!raw) return "new_artifact";

  const normalized = normalize(raw);
  for (const [pattern, slug] of SPANISH_PHRASE_SLUGS) {
    if (pattern.test(normalized) || pattern.test(raw.toLowerCase())) {
      return slug;
    }
  }

  const stop = new Set([
    "a",
    "the",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "un",
    "una",
    "para",
    "por",
    "con",
    "y",
    "o",
    "en",
    "al",
    "que",
    "cuando",
    "cada",
    "vez",
    "nuestro",
    "nuestra",
    "nuestros",
    "nuestras",
    "tu",
    "su",
    "sus",
    "este",
    "esta",
    "estos",
    "estas",
    "todos",
    "todas",
    "las",
    "los",
  ]);

  const words = normalized
    .replace(/[^a-z0-9\s_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .map((w) => SPANISH_WORD_TO_ENGLISH[w] ?? w)
    .filter((w) => w && !stop.has(w))
    .slice(0, 5);

  const slug = words.join("_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return slug || "new_artifact";
}
