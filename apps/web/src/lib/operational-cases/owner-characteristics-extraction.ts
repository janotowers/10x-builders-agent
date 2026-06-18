import { z } from "zod";
import {
  parseOwnerCharacteristics,
} from "./parse-owner-characteristics";

const DEFAULT_EXTRACTOR_MODEL = "openai/gpt-4o-mini";
const MAX_LLM_ATTEMPTS = 2;

/**
 * Canonical owner-provided property characteristics.
 *
 * Field names align 1:1 with the FIRST path of each requirement in
 * `evaluatePropertyDataMinimumsForReview` so a validated patch can be merged
 * straight into `context_jsonb.property_data` and immediately satisfy the
 * deterministic minimums evaluator (the business "judge").
 *
 * Everything is optional: the LLM only fills what the owner actually stated.
 * We never invent values; unknowns belong in `unresolved`.
 */
export const OwnerCharacteristicsPatchSchema = z
  .object({
    operation: z.enum(["sale", "rent"]).optional(),
    property_type: z.string().min(1).optional(),
    area_total_m2: z.number().nonnegative().optional(),
    area_construida_m2: z.number().nonnegative().optional(),
    floors: z.number().int().nonnegative().optional(),
    bedrooms: z.number().int().nonnegative().optional(),
    bathrooms: z.number().nonnegative().optional(),
    half_bathrooms: z.number().int().nonnegative().optional(),
    parking_spots: z.number().int().nonnegative().optional(),
    integral_kitchen: z.boolean().optional(),
    floor_number: z.number().int().nonnegative().optional(),
    has_elevator: z.boolean().optional(),
    amenities: z.array(z.string().min(1)).optional(),
    land_context: z.string().min(1).optional(),
    warehouse_area_m2: z.number().nonnegative().optional(),
    warehouse_height_m: z.number().nonnegative().optional(),
    office_area_m2: z.number().nonnegative().optional(),
    kva: z.number().nonnegative().optional(),
    has_transformer: z.boolean().optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();

export type OwnerCharacteristicsPatch = z.infer<
  typeof OwnerCharacteristicsPatchSchema
>;

export const OwnerCharacteristicsExtractionSchema = z.object({
  patch: OwnerCharacteristicsPatchSchema,
  confidence: z.enum(["high", "medium", "low"]),
  unresolved: z
    .array(
      z.object({
        field: z.string().min(1),
        reason: z.string().min(1),
      })
    )
    .default([]),
  assumptions: z.array(z.string().min(1)).default([]),
});

export type OwnerCharacteristicsExtractionResult = z.infer<
  typeof OwnerCharacteristicsExtractionSchema
> & {
  /** How the patch was obtained, for auditability. */
  method: "llm" | "llm_retry" | "deterministic_fallback";
  attempts: number;
  validationErrors?: string[];
};

export interface OwnerCharacteristicsMissingField {
  key: string;
  label: string;
  question: string;
}

export interface OwnerCharacteristicsExtractorInput {
  text: string;
  propertyType?: string | null;
  missingFields?: OwnerCharacteristicsMissingField[];
  currentPropertyData?: Record<string, unknown> | null;
}

/**
 * Injectable model boundary so selftests can run without network access and
 * production can swap providers without touching call sites.
 */
export interface OwnerCharacteristicsExtractorModel {
  extract(input: OwnerCharacteristicsExtractorInput): Promise<unknown>;
}

function stripEmptyPatchValues(
  patch: OwnerCharacteristicsPatch
): OwnerCharacteristicsPatch {
  const entries = Object.entries(patch).filter(([, value]) => {
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
  return Object.fromEntries(entries) as OwnerCharacteristicsPatch;
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function buildExtractorPrompt(
  input: OwnerCharacteristicsExtractorInput,
  previousErrors?: string[]
): string {
  const missing = (input.missingFields ?? [])
    .map((field) => `- ${field.key}: ${field.question}`)
    .join("\n");
  const known = input.currentPropertyData
    ? JSON.stringify(input.currentPropertyData)
    : "{}";
  return [
    "Extract structured real-estate property characteristics from a Spanish message sent by a property owner.",
    "Return ONLY compact JSON matching this TypeScript shape:",
    '{"patch":{"operation"?:"sale"|"rent","property_type"?:string,"area_total_m2"?:number,"area_construida_m2"?:number,"floors"?:number,"bedrooms"?:number,"bathrooms"?:number,"half_bathrooms"?:number,"parking_spots"?:number,"integral_kitchen"?:boolean,"floor_number"?:number,"has_elevator"?:boolean,"amenities"?:string[],"land_context"?:string,"warehouse_area_m2"?:number,"warehouse_height_m"?:number,"office_area_m2"?:number,"kva"?:number,"has_transformer"?:boolean,"notes"?:string},"confidence":"high"|"medium"|"low","unresolved":[{"field":string,"reason":string}],"assumptions":[string]}',
    "",
    "Rules:",
    "- Only include a field in patch when the owner stated it explicitly. NEVER invent or guess values.",
    "- `floors` is the number of stories/levels (plantas, pisos, niveles) of a house.",
    "- `floor_number` is the floor an apartment is on; do not confuse it with `floors`.",
    "- Negations set explicit values: 'sin medios baños' => half_bathrooms:0; 'no tiene cocina integral' => integral_kitchen:false; 'sí tiene cocina integral' => integral_kitchen:true.",
    "- Convert Spanish number words to digits (dos=2, tres=3).",
    "- `bathrooms` means full bathrooms; keep half bathrooms separate in `half_bathrooms`.",
    "- Map operation words: venta=>sale, renta/alquiler=>rent.",
    "- For anything the owner was asked but did not clearly answer, add it to `unresolved` with a short reason. Do not put it in patch.",
    "- confidence reflects how clearly the message maps to the fields.",
    previousErrors && previousErrors.length > 0
      ? `Your previous answer failed validation with: ${previousErrors.join("; ")}. Return ONLY valid JSON for the schema above.`
      : "",
    "",
    input.propertyType ? `property_type: ${input.propertyType}` : "",
    missing ? `fields_still_missing:\n${missing}` : "",
    `known_property_data: ${known}`,
    `owner_message: ${JSON.stringify(input.text)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function invokeOpenRouterExtractor(
  input: OwnerCharacteristicsExtractorInput,
  previousErrors?: string[]
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model =
    process.env.OWNER_CHARACTERISTICS_EXTRACTOR_MODEL_ID?.trim() ||
    DEFAULT_EXTRACTOR_MODEL;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON extractor for property characteristics. Never call tools. Never answer conversationally. Never invent data.",
        },
        { role: "user", content: buildExtractorPrompt(input, previousErrors) },
      ],
    }),
  });
  if (!response.ok) {
    console.warn(
      "[owner-characteristics-extraction] OpenRouter failed:",
      response.status,
      await response.text().catch(() => "")
    );
    return null;
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

function buildDeterministicFallback(
  input: OwnerCharacteristicsExtractorInput,
  validationErrors: string[],
  attempts: number
): OwnerCharacteristicsExtractionResult {
  const parsed = stripEmptyPatchValues(
    (parseOwnerCharacteristics(input.text) as OwnerCharacteristicsPatch) ?? {}
  );
  const parsedKeys = Object.keys(parsed);
  return {
    patch: parsed,
    confidence: parsedKeys.length > 0 ? "low" : "low",
    unresolved: [],
    assumptions:
      parsedKeys.length > 0
        ? ["Extracción determinística de respaldo tras fallo del LLM."]
        : [],
    method: "deterministic_fallback",
    attempts,
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
  };
}

/**
 * Reusable pattern: LLM interprets free-form natural language, a Zod schema
 * guards the contract, and a deterministic parser is the last-resort fallback.
 * It never decides workflow transitions; it only proposes a validated patch.
 */
export async function extractOwnerCharacteristics(
  input: OwnerCharacteristicsExtractorInput,
  model?: OwnerCharacteristicsExtractorModel
): Promise<OwnerCharacteristicsExtractionResult> {
  const text = input.text?.trim() ?? "";
  if (!text) {
    return {
      patch: {},
      confidence: "low",
      unresolved: [],
      assumptions: [],
      method: "deterministic_fallback",
      attempts: 0,
    };
  }

  const validationErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    let raw: unknown;
    try {
      raw = model
        ? await model.extract(input)
        : await invokeOpenRouterExtractor(
            input,
            attempt > 1 ? validationErrors.slice() : undefined
          );
    } catch (error) {
      validationErrors.push(
        `attempt_${attempt}_threw: ${(error as Error).message ?? String(error)}`
      );
      continue;
    }
    if (raw == null) {
      // No model configured / transport returned nothing: stop retrying.
      break;
    }
    const parsed = OwnerCharacteristicsExtractionSchema.safeParse(raw);
    if (parsed.success) {
      return {
        ...parsed.data,
        patch: stripEmptyPatchValues(parsed.data.patch),
        method: attempt === 1 ? "llm" : "llm_retry",
        attempts: attempt,
        ...(validationErrors.length > 0
          ? { validationErrors: validationErrors.slice() }
          : {}),
      };
    }
    validationErrors.push(
      `attempt_${attempt}_invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join(", ")}`
    );
  }

  return buildDeterministicFallback(input, validationErrors, MAX_LLM_ATTEMPTS);
}
