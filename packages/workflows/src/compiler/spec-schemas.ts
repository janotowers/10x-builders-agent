/**
 * Schemas de artefactos del compilador (Slice 4.2-1; Technical Plan §15).
 *
 * Tres artefactos con papeles distintos:
 *   - Business spec: la intención de negocio, versionada y PRESERVADA aunque
 *     resulte inimplementable (§15). Vive en
 *     `workflow_definitions.business_spec_jsonb`.
 *   - Implementation spec: el plan técnico declarado (estados, capacidades,
 *     skills, tools, assets, integraciones) del que se deriva el capability
 *     map. Vive en `implementation_spec_jsonb`.
 *   - Salida del compilador (LLM): o bien preguntas de aclaración (ronda
 *     acotada, §14: ≤3) o bien specs + borrador de grafo. El grafo se valida
 *     aparte con `workflowGraphSchema` — aquí solo se transporta.
 *
 * Los escenarios de aceptación nacen en la especificación, antes de la
 * implementación (§14): el business spec los declara y la simulación (4.2-3)
 * los consume.
 */

import { z } from "zod";
import { workflowGraphSchema } from "../graph-schema";

export const BUSINESS_SPEC_VERSION = 1;
export const IMPLEMENTATION_SPEC_VERSION = 1;

// ─── Business spec ──────────────────────────────────────────────────────────

export const acceptanceScenarioSchema = z.object({
  name: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
});

export const businessSpecSchema = z.object({
  spec_version: z.number().int().min(1),
  title: z.string().min(1),
  /** Descripción original en lenguaje natural — se preserva verbatim. */
  description_nl: z.string().min(1),
  objective: z.string().min(1),
  actors: z.array(z.string().min(1)).min(1),
  /** Camino feliz en palabras de negocio, en orden. */
  happy_path: z.array(z.string().min(1)).min(1),
  /** Puntos de decisión humana (aprobaciones) declarados por el negocio. */
  decisions: z
    .array(
      z.object({
        name: z.string().min(1),
        approver: z.string().min(1),
      })
    )
    .default([]),
  outcomes: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()).default([]),
  acceptance_scenarios: z.array(acceptanceScenarioSchema).default([]),
  /**
   * Notas de inimplementabilidad: el spec se preserva aunque el capability
   * map no resuelva; esto documenta POR QUÉ quedó en backlog (§15).
   */
  unimplementable_notes: z.array(z.string()).default([]),
});

export type BusinessSpec = z.infer<typeof businessSpecSchema>;

// ─── Implementation spec ────────────────────────────────────────────────────

export const implementationSpecSchema = z.object({
  spec_version: z.number().int().min(1),
  summary: z.string().min(1),
  states: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().optional(),
        kind: z.enum(["operational", "terminal"]),
      })
    )
    .min(1),
  /** Capacidades del work plane que el flujo requiere, por estado. */
  capabilities: z
    .array(
      z.object({
        capability: z.string().min(1),
        state: z.string().min(1),
        work_type: z.string().min(1),
      })
    )
    .default([]),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  integrations: z.array(z.string().min(1)).default([]),
  required_assets: z
    .array(
      z.object({
        asset_key: z.string().min(1),
        label: z.string().min(1),
        required: z.boolean().optional(),
      })
    )
    .default([]),
  approvals: z
    .array(
      z.object({
        kind: z.string().min(1),
        evidence_inputs: z.array(z.string()).default([]),
      })
    )
    .default([]),
  open_questions: z.array(z.string()).default([]),
});

export type ImplementationSpec = z.infer<typeof implementationSpecSchema>;

// ─── Salida del compilador (LLM) ────────────────────────────────────────────

/**
 * Contrato de salida del paso NL → specs. Dos formas mutuamente excluyentes:
 *   - `clarifying_questions` no vacío ⇒ ronda de aclaración (sin draft);
 *   - specs (+ grafo borrador) ⇒ candidato a draft, sujeto a los gates 4.2-2.
 */
export const compilerOutputSchema = z.object({
  clarifying_questions: z.array(z.string().min(1)).max(5).default([]),
  business_spec: businessSpecSchema.optional(),
  implementation_spec: implementationSpecSchema.optional(),
  graph: workflowGraphSchema.optional(),
  reason: z.string().optional(),
});

export type CompilerOutput = z.infer<typeof compilerOutputSchema>;

/** true cuando la salida es una ronda de aclaración (no produce draft). */
export function isClarificationRound(output: CompilerOutput): boolean {
  return output.clarifying_questions.length > 0;
}

/**
 * Un spec "presente" es un objeto no vacío: las columnas `*_spec_jsonb`
 * arrancan como `{}` en definiciones pre-compiler y eso NO debe fallar el
 * gate de schema (solo los specs realmente escritos se validan).
 */
export function specIsPresent(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}
