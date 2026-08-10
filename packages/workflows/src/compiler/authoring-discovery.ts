/**
 * Contrato puro de discovery para Studio (Slice 5.3.1).
 *
 * El modelo decide suficiencia semántica y cita evidencia del transcript.
 * Código determinístico valida forma, límites y que cada cita exista.
 */
import { z } from "zod";
import {
  AUTHORING_ROUTER_KINDS,
  REUSABLE_SKILL_SUBTYPES,
} from "./authoring-router";
import { inputRequirementSchema } from "./input-requirements";
import {
  authoringGapPlanSchema,
  deriveFlatAuthoringGaps,
} from "./authoring-gap-planner";

export const AUTHORING_DISCOVERY_DIMENSIONS = [
  "objective",
  "data_sources",
  "actors",
  "human_decisions",
  "side_effects",
  "capabilities",
  "acceptance_criteria",
  "durability",
  "recurrence",
  "mece_overlap",
] as const;

export const authoringDiscoveryEvidenceSchema = z.object({
  source: z.enum(["description", "answer"]),
  answer_index: z.number().int().nonnegative().optional(),
  quote: z.string().trim().min(1).max(500),
});

export const authoringDiscoveryDimensionSchema = z.object({
  key: z.enum(AUTHORING_DISCOVERY_DIMENSIONS),
  status: z.enum(["covered", "partial", "missing"]),
  summary: z.string().trim().min(1).max(2000),
  evidence: z.array(authoringDiscoveryEvidenceSchema).max(6).default([]),
});

export const authoringClarifyingQuestionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  target_dimension: z.enum(AUTHORING_DISCOVERY_DIMENSIONS),
  gap: z.string().trim().min(1).max(2000),
  gap_id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/).optional(),
  examples: z
    .array(z.string().trim().min(1).max(240))
    .max(3)
    .default([]),
});

export const authoringCapabilityNeedSchema = z.object({
  category_id: z.string().trim().min(1).max(64),
  category_label: z.string().trim().min(1).max(120),
  provider_id: z.string().trim().min(1).max(80).nullable().default(null),
  provider_name: z.string().trim().min(1).max(160).nullable().default(null),
  status: z.enum([
    "connected",
    "supported_not_connected",
    "catalog_only",
    "unresolved",
  ]),
  resolution: z.enum([
    "assumed_connected",
    "needs_choice",
    "needs_connection",
    "manual_fallback",
  ]),
  capabilities: z
    .array(z.string().trim().min(1).max(80))
    .max(24)
    .default([]),
  connect_href: z.string().trim().max(1000).nullable().default(null),
});

export const authoringInvocationChannelSchema = z.object({
  channel: z.enum(["web_chat", "telegram"]),
  label: z.string().trim().min(1).max(120),
  availability: z.enum(["available", "limited"]),
  supports_text: z.boolean(),
  supports_generic_attachments: z.boolean(),
  limitations: z
    .array(z.string().trim().min(1).max(500))
    .max(8)
    .default([]),
});

const summaryField = z
  .array(z.string().trim().min(1).max(500))
  .max(64)
  .default([]);

export const authoringUnderstandingSummarySchema = z.object({
  objective: z.string().trim().min(1).max(4000),
  sources: summaryField,
  actors: summaryField,
  decisions: summaryField,
  effects: summaryField,
  capabilities: summaryField,
  acceptance_criteria: summaryField,
  assumptions: summaryField,
  gaps: summaryField,
});

export const authoringDiscoveryOutputSchema = z
  .object({
    provisional_kind: z.enum(AUTHORING_ROUTER_KINDS),
    final_kind: z.enum(AUTHORING_ROUTER_KINDS),
    skill_subtype: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.enum(REUSABLE_SKILL_SUBTYPES).optional()
    ),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.array(z.string().trim().min(1).max(500)).max(16).default([]),
    covered_dimensions: z
      .array(authoringDiscoveryDimensionSchema)
      .min(1)
      .max(AUTHORING_DISCOVERY_DIMENSIONS.length),
    material_ambiguities: z
      .array(z.string().trim().min(1).max(500))
      .max(16)
      .default([]),
    clarifying_questions: z
      .array(z.string().trim().min(1).max(2000))
      .max(4)
      .default([]),
    clarifying_question_details: z
      .array(authoringClarifyingQuestionSchema)
      .max(4)
      .default([]),
    assumptions: summaryField,
    gaps: summaryField,
    gap_plan: authoringGapPlanSchema.optional(),
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
    capability_needs: z
      .array(authoringCapabilityNeedSchema)
      .max(16)
      .default([]),
    input_requirements: z.array(inputRequirementSchema).max(32).default([]),
    invocation_channels: z
      .array(authoringInvocationChannelSchema)
      .max(8)
      .default([]),
    readiness: z.enum([
      "needs_clarification",
      "ready_for_confirmation",
      "redirect",
      "blocked_reformulate",
    ]),
    suggested_title: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.string().trim().min(1).max(160).optional()
    ),
    suggested_slug: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.string().trim().min(1).max(64).optional()
    ),
    understanding: authoringUnderstandingSummarySchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.final_kind === "reusable_skill" &&
      value.skill_subtype === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skill_subtype"],
        message: "reusable_skill requiere skill_subtype",
      });
    }
    if (
      value.readiness === "needs_clarification" &&
      value.clarifying_questions.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clarifying_questions"],
        message: "needs_clarification requiere al menos una pregunta",
      });
    }
    if (
      value.clarifying_question_details.length > 0 &&
      value.clarifying_question_details.some(
        (detail) => !value.clarifying_questions.includes(detail.question)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clarifying_question_details"],
        message: "cada detalle debe corresponder a clarifying_questions",
      });
    }
    if (
      (value.readiness === "ready_for_confirmation" ||
        value.readiness === "blocked_reformulate") &&
      value.clarifying_questions.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clarifying_questions"],
        message: `${value.readiness} no debe incluir preguntas`,
      });
    }
    if (
      value.readiness === "ready_for_confirmation" &&
      (value.final_kind === "clarify" || value.final_kind === "redirect_to_chat")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["final_kind"],
        message: "ready_for_confirmation requiere un tipo de artefacto",
      });
    }
    if (
      value.readiness === "blocked_reformulate" &&
      value.gaps.length === 0 &&
      value.material_ambiguities.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gaps"],
        message: "blocked_reformulate requiere gaps o ambigüedades materiales",
      });
    }
    if (
      (value.readiness === "redirect") !==
      (value.final_kind === "redirect_to_chat")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readiness"],
        message: "redirect debe corresponder exactamente a redirect_to_chat",
      });
    }
  })
  .transform((value) => {
    if (!value.gap_plan) return value;
    const gaps = deriveFlatAuthoringGaps(value.gap_plan);
    return {
      ...value,
      gaps,
      understanding: {
        ...value.understanding,
        gaps,
      },
    };
  });

export type AuthoringDiscoveryOutput = z.infer<
  typeof authoringDiscoveryOutputSchema
>;
export type AuthoringClarifyingQuestion = z.infer<
  typeof authoringClarifyingQuestionSchema
>;
export type AuthoringCapabilityNeed = z.infer<
  typeof authoringCapabilityNeedSchema
>;
export type AuthoringInvocationChannel = z.infer<
  typeof authoringInvocationChannelSchema
>;

const SUMMARY_ITEM_MAX = 500;
const RATIONALE_ITEM_MAX = 500;
const EVIDENCE_QUOTE_MAX = 500;
const TITLE_MAX = 160;
const SLUG_MAX = 64;

/** Recorta texto al máximo del contrato, con elipsis si hace falta. */
export function clipAuthoringText(
  value: string,
  max: number
): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Divide texto largo sin descartar contenido. Prefiere límites de oración y,
 * si no existen, espacios entre palabras. Solo parte por carácter cuando hay
 * un token continuo mayor al máximo.
 */
export function splitAuthoringText(value: string, max: number): string[] {
  let remaining = value.trim();
  if (!remaining) return [];
  if (max < 1) return [remaining];
  const chunks: string[] = [];

  while (remaining.length > max) {
    const window = remaining.slice(0, max + 1);
    const minimumUsefulBoundary = Math.floor(max * 0.4);
    let cut = -1;

    const sentenceBoundary = /[.!?;:](?:\s|$)/g;
    for (const match of window.matchAll(sentenceBoundary)) {
      const candidate = (match.index ?? 0) + 1;
      if (candidate >= minimumUsefulBoundary && candidate <= max) {
        cut = candidate;
      }
    }

    if (cut < 0) {
      const whitespace = window.slice(0, max + 1).lastIndexOf(" ");
      if (whitespace >= minimumUsefulBoundary) cut = whitespace;
    }
    if (cut < 1) cut = max;

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitStringArray(
  value: unknown,
  maxItem: number
): string[] | unknown {
  const array = coerceArray(value);
  if (!array) return value;
  return array
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => splitAuthoringText(item, maxItem))
    .filter((item) => item.length > 0);
}

function parseJsonContainer(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    )
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function coerceArray(value: unknown): unknown[] | null {
  const parsed = parseJsonContainer(value);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  return null;
}

/**
 * Normaliza la salida cruda del modelo para que quepa en el contrato Zod
 * (p. ej. gaps/assumptions > 500 chars) sin fallar cerrado por verbosidad.
 */
export function sanitizeAuthoringDiscoveryRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = { ...input };

  output.rationale = splitStringArray(input.rationale, RATIONALE_ITEM_MAX);
  output.material_ambiguities = splitStringArray(
    input.material_ambiguities,
    SUMMARY_ITEM_MAX
  );
  const rawQuestions = coerceArray(input.clarifying_questions);
  output.clarifying_questions = rawQuestions
    ? rawQuestions
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 4)
    : input.clarifying_questions;
  const rawDetails = coerceArray(input.clarifying_question_details);
  if (rawDetails) {
    const questions = Array.isArray(output.clarifying_questions)
      ? (output.clarifying_questions as string[])
      : [];
    output.clarifying_question_details = rawDetails
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(parseJsonContainer(item)) &&
          typeof parseJsonContainer(item) === "object" &&
          !Array.isArray(parseJsonContainer(item))
      )
      .map((item, index) => {
        const parsed = parseJsonContainer(item) as Record<string, unknown>;
        const examples = coerceArray(parsed.examples);
        return {
          ...parsed,
          question:
            questions.length === rawDetails.length && questions[index]
              ? questions[index]
              : typeof parsed.question === "string"
                ? parsed.question.trim()
                : parsed.question,
          gap:
            typeof parsed.gap === "string"
              ? parsed.gap.trim()
              : parsed.gap,
          examples: examples
            ? examples
              .filter((example): example is string => typeof example === "string")
              .map((example) => clipAuthoringText(example, 240))
              .filter(Boolean)
              .slice(0, 3)
            : [],
        };
      })
      .slice(0, 4);
  }
  output.assumptions = splitStringArray(
    input.assumptions,
    SUMMARY_ITEM_MAX
  );
  output.gaps = splitStringArray(input.gaps, SUMMARY_ITEM_MAX);
  if (typeof input.suggested_title === "string") {
    output.suggested_title = clipAuthoringText(input.suggested_title, TITLE_MAX);
  }
  if (typeof input.suggested_slug === "string") {
    output.suggested_slug = clipAuthoringText(input.suggested_slug, SLUG_MAX);
  }

  const rawDimensions = coerceArray(input.covered_dimensions);
  if (rawDimensions) {
    output.covered_dimensions = rawDimensions.map((dimension) => {
      dimension = parseJsonContainer(dimension);
      if (!dimension || typeof dimension !== "object") return dimension;
      const row = dimension as Record<string, unknown>;
      const rawEvidence = coerceArray(row.evidence);
      const evidence = rawEvidence
        ? rawEvidence.map((item) => {
            item = parseJsonContainer(item);
            if (!item || typeof item !== "object") return item;
            const ev = item as Record<string, unknown>;
            const numericAnswerIndex =
              typeof ev.answer_index === "string" &&
              /^\d+$/.test(ev.answer_index.trim())
                ? Number(ev.answer_index)
                : ev.answer_index;
            return {
              ...ev,
              ...(numericAnswerIndex !== undefined
                ? { answer_index: numericAnswerIndex }
                : {}),
              quote:
                typeof ev.quote === "string"
                  ? ev.quote.trim().slice(0, EVIDENCE_QUOTE_MAX).trimEnd()
                  : ev.quote,
            };
          })
        : row.evidence;
      return {
        ...row,
        evidence,
      };
    });
  }

  const rawUnderstanding = parseJsonContainer(input.understanding);
  if (rawUnderstanding && typeof rawUnderstanding === "object") {
    const understanding = rawUnderstanding as Record<string, unknown>;
    const next: Record<string, unknown> = { ...understanding };
    for (const key of [
      "sources",
      "actors",
      "decisions",
      "effects",
      "capabilities",
      "acceptance_criteria",
      "assumptions",
      "gaps",
    ] as const) {
      next[key] = splitStringArray(understanding[key], SUMMARY_ITEM_MAX);
    }
    output.understanding = next;
  }
  const sideEffects = coerceArray(input.requested_side_effects);
  if (sideEffects) output.requested_side_effects = sideEffects;
  const rawCapabilityNeeds = coerceArray(input.capability_needs);
  if (rawCapabilityNeeds) {
    output.capability_needs = rawCapabilityNeeds
      .map((item) => parseJsonContainer(item))
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
      .map((item) => {
        const rawCapabilities = coerceArray(item.capabilities);
        return {
          ...item,
          category_id:
            typeof item.category_id === "string"
              ? clipAuthoringText(item.category_id, 64)
              : item.category_id,
          category_label:
            typeof item.category_label === "string"
              ? clipAuthoringText(item.category_label, 120)
              : item.category_label,
          provider_id:
            typeof item.provider_id === "string"
              ? clipAuthoringText(item.provider_id, 80)
              : item.provider_id ?? null,
          provider_name:
            typeof item.provider_name === "string"
              ? clipAuthoringText(item.provider_name, 160)
              : item.provider_name ?? null,
          capabilities: rawCapabilities
            ? rawCapabilities
                .filter(
                  (capability): capability is string =>
                    typeof capability === "string"
                )
                .map((capability) => clipAuthoringText(capability, 80))
                .filter(Boolean)
                .slice(0, 24)
            : [],
          connect_href:
            typeof item.connect_href === "string"
              ? clipAuthoringText(item.connect_href, 1000)
              : item.connect_href ?? null,
        };
      })
      .slice(0, 16);
  }
  const rawInputRequirements = coerceArray(input.input_requirements);
  if (rawInputRequirements) {
    output.input_requirements = rawInputRequirements
      .map((item) => parseJsonContainer(item))
      .slice(0, 32);
  }
  const rawInvocationChannels = coerceArray(input.invocation_channels);
  if (rawInvocationChannels) {
    output.invocation_channels = rawInvocationChannels
      .map((item) => parseJsonContainer(item))
      .slice(0, 8);
  }

  return output;
}

export function parseAuthoringDiscoveryOutput(
  raw: unknown
): AuthoringDiscoveryOutput | null {
  const parsed = authoringDiscoveryOutputSchema.safeParse(
    sanitizeAuthoringDiscoveryRaw(raw)
  );
  return parsed.success ? parsed.data : null;
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrae el cuerpo de respuesta si viene como `pregunta → respuesta`. */
export function answerBodyFromClarification(entry: string): string {
  const arrow = entry.indexOf("→");
  return (arrow >= 0 ? entry.slice(arrow + 1) : entry).trim();
}

export function isGenericAuthoringSlug(slug: string | null | undefined): boolean {
  if (!slug) return true;
  const normalized = slug.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "new_artifact" ||
    (AUTHORING_ROUTER_KINDS as readonly string[]).includes(normalized) ||
    normalized === "batch_analysis" ||
    normalized === "scheduled_work" ||
    normalized === "flujo_de_caso" ||
    normalized === "tarea_durable"
  );
}

export function filterNovelClarifyingQuestions(params: {
  questions: readonly string[];
  priorQuestions?: readonly string[];
  priorAnswers?: readonly string[];
}): string[] {
  const prior = [
    ...(params.priorQuestions ?? []),
    ...(params.priorAnswers ?? []).map((entry) => {
      const arrow = entry.indexOf("→");
      return arrow >= 0 ? entry.slice(0, arrow) : "";
    }),
  ]
    .map(normalizeEvidenceText)
    .filter(Boolean);

  return params.questions.filter((question) => {
    const normalized = normalizeEvidenceText(question);
    if (!normalized) return false;
    return !prior.some((seen) => {
      if (seen === normalized) return true;
      if (seen.includes(normalized) || normalized.includes(seen)) return true;
      const seenTokens = new Set(seen.split(" ").filter((token) => token.length > 4));
      const questionTokens = normalized
        .split(" ")
        .filter((token) => token.length > 4);
      if (questionTokens.length === 0) return false;
      const overlap = questionTokens.filter((token) => seenTokens.has(token)).length;
      return overlap / questionTokens.length >= 0.6;
    });
  });
}

/**
 * Evita preguntas contra dimensiones que el mismo discovery ya marcó como
 * cubiertas. Los detalles estructurados permiten dedupe semántico sin
 * inventar contenido mediante regex.
 */
export function filterCoveredClarifyingQuestionDetails(params: {
  details: readonly AuthoringClarifyingQuestion[];
  dimensions: ReadonlyArray<
    AuthoringDiscoveryOutput["covered_dimensions"][number]
  >;
}): AuthoringClarifyingQuestion[] {
  const status = new Map(
    params.dimensions.map((dimension) => [dimension.key, dimension.status])
  );
  return params.details.filter(
    (detail) => status.get(detail.target_dimension) !== "covered"
  );
}

export function validateAuthoringDiscoveryEvidence(params: {
  discovery: AuthoringDiscoveryOutput;
  description: string;
  answers?: readonly string[];
}): string[] {
  const failures: string[] = [];
  const description = normalizeEvidenceText(params.description);
  const answers = (params.answers ?? []).map((answer) =>
    normalizeEvidenceText(answerBodyFromClarification(answer))
  );
  const joinedAnswers = answers.join("\n");

  for (const dimension of params.discovery.covered_dimensions) {
    if (dimension.status === "covered" && dimension.evidence.length === 0) {
      failures.push(`${dimension.key}: marcado cubierto sin evidencia`);
    }
    for (const evidence of dimension.evidence) {
      const quote = normalizeEvidenceText(evidence.quote);
      if (!quote) {
        failures.push(`${dimension.key}: cita vacía`);
        continue;
      }
      if (evidence.source === "description") {
        if (!description.includes(quote)) {
          failures.push(`${dimension.key}: cita no existe en la descripción`);
        }
        continue;
      }
      const index = evidence.answer_index;
      const indexed = index !== undefined ? answers[index] : undefined;
      const foundInIndexed = Boolean(indexed?.includes(quote));
      const foundAnywhere = joinedAnswers.includes(quote);
      if (!foundInIndexed && !foundAnywhere) {
        failures.push(`${dimension.key}: cita no existe en la respuesta indicada`);
      }
    }
  }
  return failures;
}
