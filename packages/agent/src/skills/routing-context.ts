import type { AgentMessage, BusinessBrain } from "@agents/types";

export interface SkillRoutingContext {
  currentMessage: string;
  isContinuation: boolean;
  lastActiveSkill?: string;
  lastDomain?: string;
  lastMetric?: string;
  lastPeriod?: string;
  lastTenantName?: string;
  recentTurnSummary?: string;
  evidence?: readonly string[];
  confidence: "none" | "low" | "medium" | "high";
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "setiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const DOMAIN_PATTERNS = [
  { domain: "leads", re: /\bleads?\b|prospectos?\b|clientes?\b/ },
  { domain: "appointments", re: /\bcitas\b|visitas?\b|appointments?\b/ },
  { domain: "deals", re: /\bdeals?\b|cierres?\b|ventas?\b/ },
  { domain: "properties", re: /\bpropiedades?\b|inmuebles?\b|inventario\b/ },
  { domain: "users", re: /\busuarios?\b|asesores?\b|agentes?\b/ },
  { domain: "messages", re: /\bmensajes?\b|conversaciones?\b|whatsapp\b/ },
] as const;

const COUNT_RE =
  /\b(cuantos|cuantas|cuanto|cuanta|total|conteo|numero|cantidad|count)\b/;
const CONTINUATION_RE =
  /^(?:y\s+)?(?:(?:en|para|de)\s+)?(?:ese\s+)?(?:mes|periodo|trimestre|año|ano|semana|dia|día|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s*[?!.]*)?$/;
const LEAD_FOLLOW_UP_CONTEXT_RE =
  /\b(?:whatsapp|mensaje|seguimiento|follow[-\s]?up|lead|prospecto|prospecta|cliente potencial|nombre del lead|propiedad o desarrollo|ultima interaccion|accion deseada)\b/;
const SHORT_DETAIL_REPLY_RE =
  /^(?:(?:su|el|la)\s+)?(?:nombre|se llama|propiedad|desarrollo|tono|formal|amigable|casual|ultima interaccion|accion deseada)\b|^(?:quiero|busca|le interesa|prefiere|fue|vino|pregunto|pregunt[oó]|consult[oó])\b/;

export function deriveSkillRoutingContext(
  messages: readonly AgentMessage[],
  currentMessage: string | undefined,
  businessBrain: BusinessBrain | undefined
): SkillRoutingContext {
  const current = currentMessage?.trim() ?? "";
  const currentNorm = normalize(current);
  const lastTenantName = businessBrain?.identity?.org_name?.trim() || undefined;

  const evidence: string[] = [];
  let lastDomain: string | undefined;
  let lastMetric: string | undefined;
  let lastPeriod: string | undefined;
  let recentTurnSummary: string | undefined;
  let recentConversationSkill: string | undefined;

  for (const msg of [...messages].reverse()) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const norm = normalize(msg.content);
    if (!recentConversationSkill) {
      recentConversationSkill = detectConversationSkill(norm);
    }
    const domain = detectDomain(norm);
    const metric = detectMetric(norm);
    const period = detectPeriod(norm);
    if (!domain && !metric && !period && !recentConversationSkill) continue;

    if (!lastDomain && domain) lastDomain = domain;
    if (!lastMetric && metric) lastMetric = metric;
    if (!lastPeriod && period) lastPeriod = period;
    evidence.push(`${msg.role}: ${truncateOneLine(msg.content, 120)}`);

    if (!recentTurnSummary && recentConversationSkill) {
      recentTurnSummary = `Recent ${recentConversationSkill} turn`;
    } else if (!recentTurnSummary && domain) {
      recentTurnSummary = `Recent ${domain} turn` + (period ? ` for ${period}` : "");
    }
    if (recentConversationSkill || (lastDomain && lastMetric && lastPeriod)) break;
  }

  const currentDomain = detectDomain(currentNorm);
  const currentMetric = detectMetric(currentNorm);
  const currentPeriod = detectPeriod(currentNorm);
  const currentConversationSkill = detectConversationSkill(currentNorm);
  const isContinuation =
    currentNorm.length > 0 &&
    (CONTINUATION_RE.test(currentNorm) ||
      (Boolean(recentConversationSkill) && isShortDetailReply(currentNorm)));
  if (currentDomain) lastDomain = currentDomain;
  if (currentMetric) lastMetric = currentMetric;
  if (currentPeriod) lastPeriod = currentPeriod;

  const lastActiveSkill =
    currentConversationSkill ??
    recentConversationSkill ??
    (lastDomain && lastMetric ? "company-data" : undefined);
  const confidence = scoreConfidence({
    isContinuation,
    lastActiveSkill,
    lastDomain,
    lastMetric,
    lastPeriod,
    evidenceCount: evidence.length,
  });

  return {
    currentMessage: current,
    isContinuation,
    lastActiveSkill,
    lastDomain,
    lastMetric,
    lastPeriod,
    lastTenantName,
    recentTurnSummary,
    evidence: evidence.slice(0, 4),
    confidence,
  };
}

export function shouldRouteFromContinuity(ctx: SkillRoutingContext): boolean {
  return (
    ctx.isContinuation &&
    Boolean(ctx.lastActiveSkill) &&
    (ctx.confidence === "high" ||
      (ctx.lastActiveSkill !== "company-data" && ctx.confidence === "medium"))
  );
}

export function formatRoutingContextForSelector(
  ctx: SkillRoutingContext
): string {
  return JSON.stringify(
    {
      currentMessage: ctx.currentMessage,
      isContinuation: ctx.isContinuation,
      lastActiveSkill: ctx.lastActiveSkill,
      lastDomain: ctx.lastDomain,
      lastMetric: ctx.lastMetric,
      lastPeriod: ctx.lastPeriod,
      lastTenantName: ctx.lastTenantName,
      recentTurnSummary: ctx.recentTurnSummary,
      confidence: ctx.confidence,
      evidence: ctx.evidence,
    },
    null,
    2
  );
}

function scoreConfidence(input: {
  isContinuation: boolean;
  lastActiveSkill?: string;
  lastDomain?: string;
  lastMetric?: string;
  lastPeriod?: string;
  evidenceCount: number;
}): SkillRoutingContext["confidence"] {
  if (!input.lastActiveSkill) return "none";
  if (
    input.lastActiveSkill !== "company-data" &&
    input.isContinuation &&
    input.evidenceCount >= 1
  ) {
    return "high";
  }
  let score = 0;
  if (input.isContinuation) score += 2;
  if (input.lastDomain) score += 2;
  if (input.lastMetric) score += 1;
  if (input.lastPeriod) score += 1;
  if (input.evidenceCount >= 1) score += 1;
  if (score >= 6) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function detectDomain(norm: string): string | undefined {
  if (/\b(calendario|agenda|evento|eventos)\b/.test(norm)) {
    return undefined;
  }
  return DOMAIN_PATTERNS.find((p) => p.re.test(norm))?.domain;
}

function detectConversationSkill(norm: string): string | undefined {
  if (LEAD_FOLLOW_UP_CONTEXT_RE.test(norm)) return "lead-follow-up-draft";
  return undefined;
}

function isShortDetailReply(norm: string): boolean {
  return norm.length <= 180 && SHORT_DETAIL_REPLY_RE.test(norm);
}

function detectMetric(norm: string): string | undefined {
  if (COUNT_RE.test(norm)) return "count";
  if (/\bconversion|conversiones|tasa|porcentaje|ratio\b/.test(norm)) {
    return "conversion_rate";
  }
  if (/\bpromedio|media|average\b/.test(norm)) return "average";
  return undefined;
}

function detectPeriod(norm: string): string | undefined {
  const month = MONTHS.find((m) => new RegExp(`\\b${m}\\b`).test(norm));
  if (!month) return undefined;
  const normalizedMonth = month === "setiembre" ? "septiembre" : month;
  const year = norm.match(/\b20\d{2}\b/)?.[0] ?? "2026";
  return `${normalizedMonth} ${year}`;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^¿+\s*/, "")
    .trim();
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
