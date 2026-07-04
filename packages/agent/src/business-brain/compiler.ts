import type { BusinessBrain } from "@agents/types";
import { getBusinessBrainWarehouse } from "./schema";

export interface CompileBusinessBrainOptions {
  readonly agentName?: string | null;
}

const DEFAULT_SOUL = {
  voice: "Directa, clara, cálida y orientada a negocio.",
  tone: "Profesional y cercana, sin sonar corporativa.",
  style: "Respuestas escaneables; usa bullets solo cuando ayuden.",
  brevity:
    "Breve por defecto; profundiza cuando el usuario lo pida o cuando haga falta para precisión.",
};

function clean(value: unknown, max = 700): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function cleanArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clean(item, 80))
    .filter((item): item is string => !!item)
    .slice(0, maxItems);
}

function addLine(lines: string[], label: string, value: unknown, max?: number) {
  const text = clean(value, max);
  if (text) lines.push(`- ${label}: ${text}`);
}

/**
 * Compiles user/account-editable Business Brain slots into a bounded prompt
 * block. This is intentionally lower priority than tool, HITL, tenant and
 * skill rules, which are appended elsewhere by the runtime.
 */
export function buildBusinessBrainContextBlock(
  businessBrain: BusinessBrain | undefined | null,
  options: CompileBusinessBrainOptions = {}
): string {
  const safeBrain = businessBrain ?? {};
  const sections: string[] = [];
  const agentIdentity = safeBrain.agent_identity ?? {};
  const soul = safeBrain.soul ?? {};
  const context = safeBrain.business_context ?? {};
  const operating = safeBrain.operating_preferences ?? {};
  const warehouse = getBusinessBrainWarehouse(safeBrain);

  const communicationLines: string[] = [];
  const effectiveSummary = clean(safeBrain.soul_effective?.summary, 700);
  const effectiveWarnings = Array.isArray(safeBrain.soul_effective?.warnings)
    ? safeBrain.soul_effective.warnings
        .map((warning) => clean(warning, 220))
        .filter((warning): warning is string => !!warning)
        .slice(0, 2)
    : [];
  const source =
    safeBrain.soul_effective?.source === "default" ||
    safeBrain.soul_effective?.source === "user" ||
    safeBrain.soul_effective?.source === "mixed"
      ? safeBrain.soul_effective.source
      : undefined;
  const mergedSoul = {
    voice: clean(soul.voice, 220) ?? DEFAULT_SOUL.voice,
    tone: clean(soul.tone, 220) ?? DEFAULT_SOUL.tone,
    style: clean(soul.style, 260) ?? DEFAULT_SOUL.style,
    brevity: clean(soul.brevity, 160) ?? DEFAULT_SOUL.brevity,
  };
  communicationLines.push(
    `- Alma efectiva: ${
      effectiveSummary ??
      `Voz: ${mergedSoul.voice} Tono: ${mergedSoul.tone} Estilo: ${mergedSoul.style} Brevedad: ${mergedSoul.brevity}`
    }`
  );
  if (source) communicationLines.push(`- Fuente alma efectiva: ${source}`);
  if (effectiveWarnings.length > 0) {
    communicationLines.push(`- Advertencias de armonización: ${effectiveWarnings.join(" | ")}`);
  }
  sections.push(["### Comunicación Del Agente", ...communicationLines].join("\n"));

  const identityLines: string[] = [];
  addLine(identityLines, "Nombre", clean(agentIdentity.name) ?? options.agentName);
  addLine(identityLines, "Rol", agentIdentity.role, 160);
  addLine(identityLines, "Descripción", agentIdentity.short_description, 240);
  addLine(identityLines, "Emoji", agentIdentity.emoji, 20);
  if (identityLines.length > 0) {
    sections.push(["### Identidad Del Agente", ...identityLines].join("\n"));
  }

  const soulLines: string[] = [];
  addLine(soulLines, "Voz", soul.voice, 220);
  addLine(soulLines, "Tono", soul.tone, 220);
  addLine(soulLines, "Estilo", soul.style, 260);
  addLine(soulLines, "Brevedad", soul.brevity, 160);
  if (soulLines.length > 0) {
    sections.push(["### Soul / Voz", ...soulLines].join("\n"));
  }

  const contextLines: string[] = [];
  addLine(contextLines, "Tipo", context.kind, 120);
  const markets = cleanArray(context.markets);
  if (markets.length > 0) {
    contextLines.push(`- Mercados: ${markets.join(", ")}`);
  }
  addLine(contextLines, "Notas", context.notes, 700);
  if (contextLines.length > 0) {
    sections.push(["### Contexto Del Negocio", ...contextLines].join("\n"));
  }

  const operatingText = clean(operating.text, 700);
  if (operatingText) {
    sections.push(
      [
        "### Preferencias Operativas Del Usuario",
        `- ${operatingText}`,
        "- Aplica estas preferencias solo cuando sean compatibles con reglas de sistema, permisos, tools habilitadas, skills activas, HITL y tenant isolation.",
      ].join("\n")
    );
  }

  const warehouseLines: string[] = [];
  if (warehouse?.org_name) {
    warehouseLines.push(`- Organización/Inmobiliaria: ${warehouse.org_name}`);
  }
  if (warehouse?.organization_id) {
    warehouseLines.push(`- organization_id: ${warehouse.organization_id}`);
  }
  if (warehouse?.country) warehouseLines.push(`- País: ${warehouse.country}`);
  if (warehouseLines.length > 0) {
    sections.push(["### Fuente De Datos Principal", ...warehouseLines].join("\n"));
  }

  if (sections.length === 0) return "";

  return [
    "",
    "",
    "---",
    "",
    "## Business Brain Del Perfil",
    "",
    "Estas preferencias y contexto vienen de Settings. Son de menor prioridad que las reglas de seguridad, permisos, HITL, tenant isolation, herramientas habilitadas, skills activas, datos canónicos del perfil y reglas del sistema.",
    "",
    ...sections,
  ].join("\n");
}

export function appendBusinessBrainContextBlock(
  prompt: string,
  businessBrain: BusinessBrain | undefined | null,
  options: CompileBusinessBrainOptions = {}
): string {
  const block = buildBusinessBrainContextBlock(businessBrain, options);
  return block ? prompt + block : prompt;
}
