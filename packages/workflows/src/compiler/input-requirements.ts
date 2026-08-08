/**
 * Taxonomía de requisitos del compilador (Phase 5 / Studio Authoring).
 *
 * Distingue archivos reutilizables de cuenta (`account_asset`) de inputs de
 * ejecución, hechos de caso, registros de negocio, conocimiento, artefactos
 * generados e inputs humanos. Evita el anti-patrón de pedir "historial" o
 * "borrador" como upload en Recursos.
 */

import { z } from "zod";

export const INPUT_REQUIREMENT_KINDS = [
  "account_asset",
  "runtime_input",
  "case_fact",
  "business_record",
  "knowledge_requirement",
  "generated_artifact",
  "human_input",
  "integration",
  "tool",
] as const;

export type InputRequirementKind = (typeof INPUT_REQUIREMENT_KINDS)[number];

export const INPUT_REQUIREMENT_SCOPES = [
  "account",
  "case",
  "task_run",
  "turn",
] as const;

export type InputRequirementScope = (typeof INPUT_REQUIREMENT_SCOPES)[number];

export const INPUT_REQUIREMENT_RESOLVE_AT = [
  "authoring",
  "run_start",
  "step_entry",
  "runtime",
] as const;

export type InputRequirementResolveAt =
  (typeof INPUT_REQUIREMENT_RESOLVE_AT)[number];

export const inputRequirementSchema = z.object({
  kind: z.enum(INPUT_REQUIREMENT_KINDS),
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().optional(),
  scope: z.enum(INPUT_REQUIREMENT_SCOPES).optional(),
  resolve_at: z.enum(INPUT_REQUIREMENT_RESOLVE_AT).optional(),
  source_hint: z.string().optional(),
  retention: z
    .enum(["ephemeral", "run", "durable", "promote_to_case"])
    .optional(),
  producer_step: z.string().optional(),
  tool: z.string().optional(),
  skill_reference: z.string().optional(),
});

export type InputRequirement = z.infer<typeof inputRequirementSchema>;

/** Labels/keys that must never be encoded as account_asset uploads. */
const NON_ASSET_LABEL_PATTERN =
  /\b(historial|acuerdo|borrador|contacto|conversaci[oó]n|mensaje|expediente|owner|lead|crm|draft|history|agreement|contact)\b/i;

/**
 * Heurística de clasificación errónea: un `account_asset` cuyo label/key
 * huele a dato operacional o artefacto generado.
 */
export function looksLikeMisclassifiedAccountAsset(
  requirement: Pick<InputRequirement, "kind" | "key" | "label">
): boolean {
  if (requirement.kind !== "account_asset") return false;
  return (
    NON_ASSET_LABEL_PATTERN.test(requirement.key) ||
    NON_ASSET_LABEL_PATTERN.test(requirement.label)
  );
}

/** Un artefacto generado nunca es un gap pre-ejecución. */
export function isGeneratedOutput(
  requirement: Pick<InputRequirement, "kind">
): boolean {
  return requirement.kind === "generated_artifact";
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

export function customerMessageForInputRequirement(
  requirement: InputRequirement
): string {
  const label = requirement.label || requirement.key;
  switch (requirement.kind) {
    case "account_asset":
      return `Falta ${lowerFirst(label)}: súbela en el panel de recursos de la cuenta.`;
    case "runtime_input":
      return `${label} se pedirá al iniciar la ejecución (no es un recurso permanente).`;
    case "case_fact":
      return `${label} se captura o verifica en el expediente del caso.`;
    case "business_record":
      return `${label} se lee del sistema de negocio / warehouse conectado.`;
    case "knowledge_requirement":
      return `${label} se consultará en la base de conocimiento cuando esté disponible.`;
    case "generated_artifact":
      return `${label} se genera durante la ejecución; no hay que subirlo.`;
    case "human_input":
      return `${label} se solicitará a una persona en el momento adecuado.`;
    case "integration":
      return `Falta conectar la integración "${requirement.key}". Puedes publicarla igual; configúrala en la cuenta antes de operar.`;
    case "tool":
      return `El flujo necesita la herramienta "${requirement.key}" y no está en el catálogo.`;
  }
}

export type InputRequirementLinkHint =
  | "assets_panel"
  | "integrations_panel"
  | "case_intake"
  | "none";

export function linkHintForInputRequirement(
  kind: InputRequirementKind
): InputRequirementLinkHint {
  switch (kind) {
    case "account_asset":
      return "assets_panel";
    case "integration":
      return "integrations_panel";
    case "runtime_input":
    case "case_fact":
    case "human_input":
      return "case_intake";
    default:
      return "none";
  }
}
