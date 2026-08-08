/**
 * Contrato compilado de una tarea durable independiente (Phase 5.2/5.3).
 *
 * No contiene `case_type` ni grafo comercial. Declara un objetivo, criterios
 * de aceptación, requisitos tipados y unidades ejecutables del work plane.
 */
import { z } from "zod";
import { inputRequirementSchema } from "./input-requirements";

export const durableTaskWorkTemplateSchema = z.object({
  work_type: z.string().min(1),
  required_capability: z.string().min(1),
  objective: z.string().min(1),
  depends_on: z.array(z.string().min(1)).default([]),
  required_tools: z.array(z.string().min(1)).default([]),
  required_data_scopes: z.array(z.string().min(1)).default([]),
  guardrails: z.array(z.string().min(1)).default([]),
  exit_criteria: z.array(z.string().min(1)).min(1),
  human_review_required: z.boolean().default(true),
  output_required_keys: z.array(z.string().min(1)).default(["response_summary"]),
  priority: z.number().int().default(100),
  max_attempts: z.number().int().min(1).default(3),
});

export const durableTaskSpecSchema = z.object({
  spec_version: z.number().int().min(1).default(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  input_requirements: z.array(inputRequirementSchema).default([]),
  work_templates: z.array(durableTaskWorkTemplateSchema).min(1),
  result_contract: z.object({
    required_keys: z.array(z.string().min(1)).min(1),
    description: z.string().min(1),
  }),
  retention_policy: z.object({
    result_days: z.number().int().min(1).default(365),
    input_days: z.number().int().min(1).default(90),
  }),
  open_questions: z.array(z.string().min(1)).default([]),
});

export type DurableTaskSpec = z.infer<typeof durableTaskSpecSchema>;
export type DurableTaskWorkTemplate = z.infer<
  typeof durableTaskWorkTemplateSchema
>;

export const durableTaskCompilerOutputSchema = z.object({
  clarifying_questions: z.array(z.string().min(1)).max(5).default([]),
  task_spec: durableTaskSpecSchema.optional(),
  reason: z.string().optional(),
});

export type DurableTaskCompilerOutput = z.infer<
  typeof durableTaskCompilerOutputSchema
>;

/** Convierte templates compilados al contrato canónico del work plane. */
export function durableTaskTemplatesToWorkItems(spec: DurableTaskSpec) {
  return spec.work_templates.map((template) => ({
    work_type: template.work_type,
    required_capability: template.required_capability,
    depends_on: template.depends_on,
    priority: template.priority,
    max_attempts: template.max_attempts,
    input_contract: {
      objective: template.objective,
      guardrails: template.guardrails,
      required_tools: template.required_tools,
      required_data_scopes: template.required_data_scopes,
      input_requirements: spec.input_requirements,
    },
    output_contract: {
      required_keys: template.output_required_keys,
    },
    verification_contract: {
      exit_criteria: template.exit_criteria,
      human_review_required: template.human_review_required,
    },
  }));
}
