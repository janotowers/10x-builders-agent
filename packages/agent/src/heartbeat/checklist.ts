export type HeartbeatChecklistSource =
  | "calendar"
  | "calendar_tasks"
  | "warehouse"
  | "messages"
  | "memory"
  | "scheduled_tasks"
  | "github"
  | "files";

export interface HeartbeatChecklistItem {
  id: string;
  text: string;
  intent: string;
  threshold: string;
  notifyWhen: string;
  candidateSkills: string[];
  sources: HeartbeatChecklistSource[];
  /**
   * Lookahead window expressed once as a structured field, parsed from the
   * free-text threshold/notify if present (e.g. "60 minutos", "30 minutes").
   * Heartbeat prefetchers prefer this number; if absent, they fall back to
   * the skill's `heartbeat_signals[].reminder_window_minutes`.
   */
  reminderWindowMinutes?: number;
}

export interface HeartbeatChecklistTemplate {
  id: string;
  name: string;
  description: string;
  markdown: string;
}

const skillNames = [
  "meeting-readiness-watch",
  "daily-operating-brief",
  "lead-momentum-watch",
  "visit-confirmation-watch",
  "conversation-risk-watch",
  "pending-approval-watch",
  "inventory-matchmaking-watch",
  "personal-day-briefing",
  "lead-follow-up-draft",
  "company-data",
  "skill-authoring",
];

function slugify(value: string): string {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 48) || "item";
}

function inferSources(text: string): HeartbeatChecklistSource[] {
  const t = text.toLowerCase();
  const sources = new Set<HeartbeatChecklistSource>();
  if (/\b(agenda|calendar|calendario|evento|reuni[oó]n|cita|visita)\b/.test(t)) {
    sources.add("calendar");
  }
  if (/\b(tarea|task|tasks|pendiente|recordatorio)\b/.test(t)) {
    sources.add("calendar_tasks");
  }
  if (/\b(lead|leads|inmobiliaria|inventario|propiedad|warehouse|bigquery|n[uú]mero|m[eé]trica|kpi|cliente)\b/.test(t)) {
    sources.add("warehouse");
  }
  if (/\b(mensaje|whatsapp|email|correo|conversaci[oó]n|respuesta)\b/.test(t)) {
    sources.add("messages");
  }
  if (/\b(memoria|preferencia|contexto)\b/.test(t)) sources.add("memory");
  if (/\b(aprobaci[oó]n|automatizaci[oó]n|tarea programada|fall[oó]|retry)\b/.test(t)) {
    sources.add("scheduled_tasks");
  }
  if (/\b(github|issue|pr|pull request|repo)\b/.test(t)) sources.add("github");
  return [...sources];
}

function parseSources(value: string): HeartbeatChecklistSource[] {
  const valid = new Set<HeartbeatChecklistSource>([
    "calendar",
    "calendar_tasks",
    "warehouse",
    "messages",
    "memory",
    "scheduled_tasks",
    "github",
    "files",
  ]);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is HeartbeatChecklistSource =>
      valid.has(item as HeartbeatChecklistSource)
    );
}

function inferCandidateSkills(text: string): string[] {
  const t = text.toLowerCase();
  const skills = new Set<string>();
  if (/\b(agenda|calendario|evento|reuni[oó]n|cita|compromiso|preparaci[oó]n|recordatorio|tarea|tasks?)\b/.test(t)) {
    skills.add("meeting-readiness-watch");
  }
  if (/\b(lead|leads|momentum|seguimiento|reactivaci[oó]n|respuesta|sla)\b/.test(t)) {
    skills.add("lead-momentum-watch");
  }
  if (/\b(visita|cita|confirmaci[oó]n|appointment|tour)\b/.test(t)) {
    skills.add("visit-confirmation-watch");
  }
  if (/\b(frustraci[oó]n|confusi[oó]n|urgencia|molest|riesgo|sentimiento|empat[ií]a)\b/.test(t)) {
    skills.add("conversation-risk-watch");
  }
  if (/\b(aprobaci[oó]n|pendiente|fall[oó]|automatizaci[oó]n|retry|reintento)\b/.test(t)) {
    skills.add("pending-approval-watch");
  }
  if (/\b(inventario|match|propiedad|opci[oó]n|recomendaci[oó]n|cruce)\b/.test(t)) {
    skills.add("inventory-matchmaking-watch");
  }
  for (const skill of skillNames) {
    if (t.includes(skill)) skills.add(skill);
  }
  return [...skills];
}

function parseSkills(value: string): string[] {
  const replacements: Record<string, string> = {
    "daily-operating-brief": "meeting-readiness-watch",
    "personal-day-briefing": "meeting-readiness-watch",
    "lead-follow-up-draft": "lead-momentum-watch",
  };
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .map((item) => replacements[item] ?? item)
        .filter((item) => item.length > 0)
    ),
  ];
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[.\s]+$/g, "");
}

/**
 * Pulls the first lookahead window mentioned in the text (e.g. "60 minutos",
 * "30 minutes", "90 min"). Returns null when absent so the runner can fall
 * back to the skill's default. Hours are converted to minutes.
 */
export function extractReminderWindowMinutes(
  ...sources: Array<string | undefined>
): number | null {
  for (const raw of sources) {
    const text = (raw ?? "").toLowerCase();
    if (!text) continue;
    const minuteMatch = text.match(
      /\b(\d{1,4})\s*(?:minut(?:o|os|e|es)?|min\.?|m)\b/
    );
    if (minuteMatch) {
      const value = Number.parseInt(minuteMatch[1] ?? "", 10);
      if (Number.isFinite(value) && value > 0) return value;
    }
    const hourMatch = text.match(
      /\b(\d{1,3})\s*(?:hora|horas|hour|hours|hr|hrs|h)\b/
    );
    if (hourMatch) {
      const value = Number.parseInt(hourMatch[1] ?? "", 10);
      if (Number.isFinite(value) && value > 0) return value * 60;
    }
  }
  return null;
}

function parseReminderWindowField(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number.parseInt(trimmed.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (/\b(hora|horas|hour|hours|hr|hrs|h)\b/i.test(trimmed)) return numeric * 60;
  return numeric;
}

function extractMetadata(text: string): {
  cleanText: string;
  threshold: string;
  notifyWhen: string;
  candidateSkills: string[];
  sources: HeartbeatChecklistSource[];
  reminderWindowMinutes: number | null;
} {
  const firstMeta = text.search(
    /\b(?:threshold|umbral|notify_when|avisar cuando|skills?|fuentes?|sources?|reminder_window|ventana(?:_minutos)?):/i
  );
  const thresholdMatch = text.match(
    /\b(?:threshold|umbral):\s*([\s\S]*?)(?=\s*(?:;|\||\.?\s*(?:notify_when|avisar cuando|skills?|fuentes?|reminder_window|ventana(?:_minutos)?):)|$)/i
  );
  const notifyMatch = text.match(
    /\b(?:notify_when|avisar cuando):\s*([\s\S]*?)(?=\s*(?:;|\||\.?\s*(?:skills?|fuentes?|reminder_window|ventana(?:_minutos)?):)|$)/i
  );
  const skillsMatch = text.match(
    /\b(?:skills?):\s*([\s\S]*?)(?=\s*(?:;|\||\.?\s*(?:fuentes?|sources?|reminder_window|ventana(?:_minutos)?):)|$)/i
  );
  const sourcesMatch = text.match(
    /\b(?:fuentes?|sources?):\s*([\s\S]*?)(?=\s*(?:;|\||\.?\s*(?:reminder_window|ventana(?:_minutos)?):)|$)/i
  );
  const windowMatch = text.match(
    /\b(?:reminder_window|ventana(?:_minutos)?):\s*([\s\S]*?)$/i
  );
  const threshold =
    stripTrailingPunctuation(thresholdMatch?.[1] ?? "") ||
    "Solo cuenta si hay una señal concreta, reciente y accionable";
  const notifyWhen =
    stripTrailingPunctuation(notifyMatch?.[1] ?? "") ||
    "Notifica solo si hay acción clara, aprobación requerida o riesgo relevante";
  const explicitWindow = parseReminderWindowField(
    stripTrailingPunctuation(windowMatch?.[1] ?? "")
  );
  return {
    cleanText: (firstMeta >= 0 ? text.slice(0, firstMeta) : text)
      .replace(/\s*[;|]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    threshold,
    notifyWhen,
    candidateSkills: parseSkills(stripTrailingPunctuation(skillsMatch?.[1] ?? "")),
    sources: parseSources(stripTrailingPunctuation(sourcesMatch?.[1] ?? "")),
    reminderWindowMinutes:
      explicitWindow ?? extractReminderWindowMinutes(threshold, notifyWhen),
  };
}

export function parseHeartbeatChecklist(markdown: string): HeartbeatChecklistItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: HeartbeatChecklistItem[] = [];
  let section = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (!bullet) continue;
    const {
      cleanText,
      threshold,
      notifyWhen,
      candidateSkills,
      sources,
      reminderWindowMinutes,
    } = extractMetadata(bullet[1].trim());
    if (!cleanText) continue;
    const item: HeartbeatChecklistItem = {
      id: slugify(`${section}-${cleanText}`),
      text: cleanText,
      intent: cleanText,
      threshold,
      notifyWhen,
      candidateSkills:
        candidateSkills.length > 0 ? candidateSkills : inferCandidateSkills(cleanText),
      sources: sources.length > 0 ? sources : inferSources(cleanText),
    };
    if (reminderWindowMinutes !== null) {
      item.reminderWindowMinutes = reminderWindowMinutes;
    }
    items.push(item);
  }
  return items;
}

export function formatHeartbeatChecklist(items: HeartbeatChecklistItem[], title = "Heartbeat checklist"): string {
  const lines = [`# ${title}`, ""];
  for (const item of items) {
    const skills = item.candidateSkills.length
      ? `; Skills: ${item.candidateSkills.join(", ")}`
      : "";
    const sources = item.sources.length ? `; Fuentes: ${item.sources.join(", ")}` : "";
    const window =
      typeof item.reminderWindowMinutes === "number" &&
      Number.isFinite(item.reminderWindowMinutes)
        ? `; Ventana_minutos: ${item.reminderWindowMinutes}`
        : "";
    lines.push(
      `- ${stripTrailingPunctuation(item.intent)}; Umbral: ${stripTrailingPunctuation(item.threshold)}; Avisar cuando: ${stripTrailingPunctuation(item.notifyWhen)}${skills}${sources}${window}.`
    );
  }
  return lines.join("\n");
}

export function normalizeHeartbeatChecklist(markdown: string): string {
  const items = parseHeartbeatChecklist(markdown);
  return formatHeartbeatChecklist(items.length > 0 ? items : [], "Heartbeat checklist");
}

export function validateHeartbeatChecklist(markdown: string): {
  items: HeartbeatChecklistItem[];
  warnings: string[];
} {
  const items = parseHeartbeatChecklist(markdown);
  const warnings: string[] = [];
  if (items.length === 0) {
    warnings.push("El checklist no tiene items accionables en formato bullet o numerado.");
  }
  for (const item of items) {
    const lower = item.text.toLowerCase();
    if (/^(revisa|check|checa|verifica)\b/.test(lower) && !/si|cuando|mayor|más de|requiere|riesgo|oportunidad/.test(lower)) {
      warnings.push(`El item "${item.text}" parece polling genérico; agrega intención, umbral y condición de aviso.`);
    }
    if (item.sources.length === 0) {
      warnings.push(`El item "${item.text}" no declara una fuente clara de observación.`);
    }
    if (item.candidateSkills.length === 0) {
      warnings.push(`El item "${item.text}" no mapea todavía a ningún skill candidato.`);
    }
  }
  return { items, warnings };
}

const personalOperatingRhythmItems: HeartbeatChecklistItem[] = [
  {
    id: "calendar-prep-gaps",
    text: "Detectar reuniones próximas que requieran recordatorio, preparación, logística o contexto antes de iniciar.",
    intent: "Detectar reuniones próximas que requieran recordatorio, preparación, logística o contexto antes de iniciar.",
    threshold: "Solo si faltan 60 minutos o menos para una reunión relevante, hay conflicto, preparación faltante, logística incompleta o contexto necesario.",
    notifyWhen: "Hay una acción concreta antes de la reunión; si no, responder solo Pulso OK.",
    candidateSkills: ["meeting-readiness-watch"],
    sources: ["calendar", "calendar_tasks", "memory"],
  },
  {
    id: "real-blockers",
    text: "Detectar automatizaciones, aprobaciones o tareas programadas que realmente bloquean un flujo.",
    intent: "Detectar automatizaciones, aprobaciones o tareas programadas que realmente bloquean un flujo.",
    threshold: "Hay confirmación pendiente, fallo reciente, reintentos acumulados o tarea programada detenida que requiere intervención.",
    notifyWhen: "El usuario puede desbloquear el flujo con una decisión, revisión o aprobación concreta; si no, responder solo Pulso OK.",
    candidateSkills: ["pending-approval-watch"],
    sources: ["scheduled_tasks"],
  },
];

const realEstateOpportunityItems: HeartbeatChecklistItem[] = [
  {
    id: "lead-momentum",
    text: "Detectar leads con alta intención que perdieron momentum después de recibir opciones o pedir información.",
    intent: "Detectar leads con alta intención que perdieron momentum después de recibir opciones o pedir información.",
    threshold: "Lead sin respuesta más allá del SLA configurado o con conversación reciente que amerita seguimiento.",
    notifyWhen: "Hay un siguiente paso claro o conviene pedir aprobación para redactar seguimiento.",
    candidateSkills: ["lead-momentum-watch"],
    sources: ["warehouse", "messages"],
  },
  {
    id: "visit-confirmation",
    text: "Detectar visitas o citas próximas que falten de confirmar o tengan datos incompletos.",
    intent: "Detectar visitas o citas próximas que falten de confirmar o tengan datos incompletos.",
    threshold: "Visita dentro de 24 horas o solicitud abierta sin confirmación clara.",
    notifyWhen: "Falta confirmar hora, ubicación, asistentes o responsable.",
    candidateSkills: ["visit-confirmation-watch"],
    sources: ["calendar", "warehouse", "messages"],
  },
  {
    id: "conversation-risk",
    text: "Detectar compradores confundidos, frustrados o con urgencia que requieran intervención humana.",
    intent: "Detectar compradores confundidos, frustrados o con urgencia que requieran intervención humana.",
    threshold: "Señales explícitas de molestia, confusión, urgencia o pérdida de confianza.",
    notifyWhen: "La conversación amerita empatía, negociación o escalación.",
    candidateSkills: ["conversation-risk-watch"],
    sources: ["messages"],
  },
];

const hybridFounderOperatorItems: HeartbeatChecklistItem[] = [
  ...personalOperatingRhythmItems,
  {
    id: "pending-approvals",
    text: "Detectar aprobaciones humanas, automatizaciones fallidas o tareas que requieren intervención antes de que se acumulen.",
    intent: "Detectar aprobaciones humanas, automatizaciones fallidas o tareas que requieren intervención antes de que se acumulen.",
    threshold: "Hay confirmación pendiente, fallo reciente o automatización bloqueada.",
    notifyWhen: "El usuario puede desbloquear el flujo con una decisión concreta.",
    candidateSkills: ["pending-approval-watch"],
    sources: ["scheduled_tasks"],
  },
  {
    id: "commercial-opportunity",
    text: "Detectar oportunidades comerciales de alto valor que conecten leads, visitas o inventario con una acción próxima.",
    intent: "Detectar oportunidades comerciales de alto valor que conecten leads, visitas o inventario con una acción próxima.",
    threshold: "La señal combina intención del cliente con inventario o siguiente paso disponible.",
    notifyWhen: "Hay oportunidad accionable y no solo una métrica informativa.",
    candidateSkills: ["lead-momentum-watch", "inventory-matchmaking-watch"],
    sources: ["warehouse", "messages"],
  },
];

export const HEARTBEAT_CHECKLIST_TEMPLATES: HeartbeatChecklistTemplate[] = [
  {
    id: "personal-operating-rhythm",
    name: "Ritmo operativo personal",
    description: "Monitoreo exception-first de reuniones próximas, preparación y bloqueos reales.",
    markdown: formatHeartbeatChecklist(personalOperatingRhythmItems),
  },
  {
    id: "real-estate-opportunity-watch",
    name: "Oportunidades inmobiliarias",
    description: "Leads, visitas, conversaciones de riesgo e inventario con señales accionables.",
    markdown: formatHeartbeatChecklist(realEstateOpportunityItems),
  },
  {
    id: "hybrid-founder-operator",
    name: "Founder/operator híbrido",
    description: "Combina monitores de reuniones, riesgos comerciales y automatizaciones pendientes.",
    markdown: formatHeartbeatChecklist(hybridFounderOperatorItems, "Heartbeat checklist"),
  },
];

export function getHeartbeatChecklistTemplate(id: string | null | undefined): HeartbeatChecklistTemplate | null {
  return HEARTBEAT_CHECKLIST_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function generateHeartbeatChecklistProposal(description: string): {
  markdown: string;
  missingSkills: string[];
  warnings: string[];
} {
  const t = description.toLowerCase();
  const base =
    /lead|inmobili|visita|cita|propiedad|cliente|whatsapp|mensaje/.test(t)
      ? getHeartbeatChecklistTemplate("real-estate-opportunity-watch")
      : getHeartbeatChecklistTemplate("personal-operating-rhythm");
  const items = parseHeartbeatChecklist(base?.markdown ?? "");
  if (/aprobaci|automatiz|fall/.test(t)) {
    items.push(...hybridFounderOperatorItems.filter((item) => item.id.includes("pending")));
  }
  const markdown = formatHeartbeatChecklist(items, "Heartbeat checklist propuesto");
  const validation = validateHeartbeatChecklist(markdown);
  const missingSkills = [...new Set(validation.items.flatMap((item) => item.candidateSkills))];
  return { markdown, missingSkills, warnings: validation.warnings };
}
