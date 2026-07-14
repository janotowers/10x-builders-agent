import { z } from "zod";
import {
  parseContractCommercialReply,
  classifyExclusivePolarity,
  classifyCollaborationPolarity,
  type CollaborationCompensationMode,
  type CommissionTerms,
  type ContractCommercialMissingField,
  type ContractCommercialPatch,
} from "@agents/agent";

const DEFAULT_EXTRACTOR_MODEL = "openai/gpt-4o-mini";
const MAX_LLM_ATTEMPTS = 2;

const COMPENSATION_MODES = [
  "not_specified",
  "percentage_of_total_commission",
  "percentage_of_sale_price",
  "fixed_amount",
  "negotiable",
] as const satisfies readonly CollaborationCompensationMode[];

/**
 * Strict patch schema aligned with ContractCommercialPatch.
 * Control fields (`confirm`, `confirmed_by`) are intentionally excluded:
 * only the deterministic business handler may confirm terms.
 */
export const ContractCommercialPatchSchema = z
  .object({
    owner_email: z.string().email().optional(),
    commission_pct: z.number().positive().nullable().optional(),
    exclusive: z.boolean().nullable().optional(),
    duration_months: z.number().int().positive().nullable().optional(),
    collaboration_enabled: z.boolean().nullable().optional(),
    compensation_mode: z.enum(COMPENSATION_MODES).nullable().optional(),
    compensation_value: z.number().nonnegative().nullable().optional(),
    compensation_currency: z.string().min(1).nullable().optional(),
    collaboration_notes: z.string().min(1).nullable().optional(),
  })
  .strict();

export const ContractCommercialExtractionSchema = z.object({
  patch: ContractCommercialPatchSchema,
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

export type ContractCommercialExtractionResult = z.infer<
  typeof ContractCommercialExtractionSchema
> & {
  intent: "provide_data" | "unclear";
  method: "llm" | "llm_retry" | "deterministic_fallback";
  attempts: number;
  validationErrors?: string[];
  reason?: string;
};

export interface ContractCommercialExtractorInput {
  text: string;
  missingFields: ContractCommercialMissingField[];
  knownTerms?: CommissionTerms | null;
  currentOwnerEmail?: string | null;
}

export interface ContractCommercialExtractorModel {
  extract(input: ContractCommercialExtractorInput): Promise<unknown>;
}

const DETERMINISTIC_PRIORITY_FIELDS: ReadonlySet<keyof ContractCommercialPatch> =
  new Set([
    "owner_email",
    "commission_pct",
    "duration_months",
    "collaboration_enabled",
    "exclusive",
  ]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripEmptyPatchValues(
  patch: ContractCommercialPatch
): ContractCommercialPatch {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as ContractCommercialPatch;
}

function allowedKeysFromMissing(
  missingFields: ContractCommercialMissingField[],
  patch: ContractCommercialPatch
): Set<string> {
  const keys = new Set(missingFields.map((field) => field.key));
  // Progressive capture: if this reply enables collaboration, also accept
  // optional shared-compensation detail in the same message.
  if (patch.collaboration_enabled === true) {
    keys.add("compensation_mode");
    keys.add("compensation_value");
    keys.add("compensation_currency");
    keys.add("collaboration_notes");
  }
  return keys;
}

function filterPatchToAllowedKeys(
  patch: ContractCommercialPatch,
  allowedKeys: Set<string>
): ContractCommercialPatch {
  const filtered: ContractCommercialPatch = {};
  for (const [rawKey, value] of Object.entries(patch)) {
    if (!allowedKeys.has(rawKey)) continue;
    (filtered as Record<string, unknown>)[rawKey] = value;
  }
  return stripEmptyPatchValues(filtered);
}

function valuesConflict(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) > 1e-9;
  }
  return a !== b;
}

/**
 * Merge LLM + deterministic patches.
 * - Deterministic fills gaps when LLM omitted a field.
 * - For exclusive / collaboration_enabled, deterministic overrides LLM only when
 *   the source text has explicit polarity (explicit_true / explicit_false).
 * - Other conflicts are dropped as unresolved (safer than guessing).
 */
export function mergeContractCommercialPatches(params: {
  llmPatch: ContractCommercialPatch;
  deterministicPatch: ContractCommercialPatch;
  missingFields: ContractCommercialMissingField[];
  /** Original advisor message; used to decide boolean polarity overrides. */
  sourceText?: string;
}): {
  patch: ContractCommercialPatch;
  unresolved: Array<{ field: string; reason: string }>;
  assumptions: string[];
} {
  const unresolved: Array<{ field: string; reason: string }> = [];
  const assumptions: string[] = [];
  const seedAllowed = allowedKeysFromMissing(
    params.missingFields,
    {
      ...params.llmPatch,
      ...params.deterministicPatch,
    }
  );
  const llm = filterPatchToAllowedKeys(params.llmPatch, seedAllowed);
  const deterministic = filterPatchToAllowedKeys(
    params.deterministicPatch,
    seedAllowed
  );
  const merged: ContractCommercialPatch = { ...llm };
  const sourceText = params.sourceText?.trim() ?? "";

  for (const [rawKey, detValue] of Object.entries(deterministic)) {
    const key = rawKey as keyof ContractCommercialPatch;
    const llmValue = merged[key];
    const hasLlmValue = key in merged && llmValue !== undefined;
    if (!hasLlmValue) {
      (merged as Record<string, unknown>)[key] = detValue;
      continue;
    }
    if (valuesConflict(llmValue, detValue)) {
      if (
        (key === "exclusive" || key === "collaboration_enabled") &&
        typeof detValue === "boolean"
      ) {
        const polarity =
          key === "exclusive"
            ? classifyExclusivePolarity(sourceText)
            : classifyCollaborationPolarity(sourceText);
        if (
          polarity === "explicit_true" ||
          polarity === "explicit_false"
        ) {
          (merged as Record<string, unknown>)[key] =
            polarity === "explicit_true";
          assumptions.push(
            `Se priorizó la polaridad explícita del texto para ${key}.`
          );
          continue;
        }
        // Unknown polarity: keep LLM; do not let a weak deterministic guess win.
        assumptions.push(
          `Se conservó la interpretación del LLM para ${key} (polaridad determinística no explícita).`
        );
        continue;
      }
      delete (merged as Record<string, unknown>)[key];
      unresolved.push({
        field: key,
        reason:
          "El extractor LLM y el parser determinístico interpretaron valores incompatibles.",
      });
      continue;
    }
    if (DETERMINISTIC_PRIORITY_FIELDS.has(key)) {
      (merged as Record<string, unknown>)[key] = detValue;
    }
  }

  if (
    Object.keys(deterministic).length > 0 &&
    JSON.stringify(merged) !== JSON.stringify(llm)
  ) {
    assumptions.push(
      "Se completaron o reconciliaron campos explícitos con parser determinístico."
    );
  }

  const finalAllowed = allowedKeysFromMissing(params.missingFields, merged);
  return {
    patch: filterPatchToAllowedKeys(merged, finalAllowed),
    unresolved,
    assumptions,
  };
}

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function buildExtractorPrompt(
  input: ContractCommercialExtractorInput,
  previousErrors?: string[]
): string {
  const missing = (input.missingFields ?? [])
    .map(
      (field) =>
        `- ${field.key}${field.optional ? " (optional)" : ""}: ${field.question}`
    )
    .join("\n");
  const knownTerms = input.knownTerms
    ? JSON.stringify(input.knownTerms)
    : "{}";
  return [
    "Extract structured commercial contract terms from a Spanish message sent by a real-estate advisor.",
    "Return ONLY compact JSON matching this TypeScript shape:",
    '{"patch":{"owner_email"?:string,"commission_pct"?:number|null,"exclusive"?:boolean|null,"duration_months"?:number|null,"collaboration_enabled"?:boolean|null,"compensation_mode"?: "not_specified"|"percentage_of_total_commission"|"percentage_of_sale_price"|"fixed_amount"|"negotiable"|null,"compensation_value"?:number|null,"compensation_currency"?:string|null,"collaboration_notes"?:string|null},"confidence":"high"|"medium"|"low","unresolved":[{"field":string,"reason":string}],"assumptions":[string]}',
    "",
    "Field definitions (do not confuse them):",
    "- commission_pct: percentage charged to the property owner on sale/rent price (e.g. 5).",
    "- compensation_value: share of that commission given to a collaborating broker (e.g. 50), NOT the owner commission.",
    "- compensation_mode=percentage_of_total_commission when the share is expressed as percent of the total commission.",
    "- collaboration_enabled: whether commission will be shared with another advisor/agency.",
    "- exclusive: whether the listing mandate is exclusive.",
    "- duration_months: mandate length in months.",
    "",
    "Rules:",
    "- Only include a field in patch when the advisor stated it explicitly. NEVER invent values.",
    "- Never include confirm/confirmed_by or workflow control fields.",
    "- Prefer fields listed in fields_still_missing; if the message enables collaboration and also states the shared percentage, you may include compensation_mode/value in the same patch.",
    "- Convert Spanish number words to digits (seis=6).",
    "- Strip trailing punctuation from emails (alex@ungga.com, => alex@ungga.com).",
    "- For anything asked but not clearly answered, add it to unresolved. Do not put it in patch.",
    "- confidence reflects how clearly the message maps to the fields.",
    previousErrors && previousErrors.length > 0
      ? `Your previous answer failed validation with: ${previousErrors.join("; ")}. Return ONLY valid JSON for the schema above.`
      : "",
    "",
    missing ? `fields_still_missing:\n${missing}` : "",
    input.currentOwnerEmail
      ? `current_owner_email: ${input.currentOwnerEmail}`
      : "",
    `known_commission_terms: ${knownTerms}`,
    `advisor_message: ${JSON.stringify(input.text)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function invokeOpenRouterExtractor(
  input: ContractCommercialExtractorInput,
  previousErrors?: string[]
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model =
    process.env.CONTRACT_COMMERCIAL_EXTRACTOR_MODEL_ID?.trim() ||
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
      max_tokens: 350,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON extractor for commercial contract terms. Never call tools. Never answer conversationally. Never invent data.",
        },
        { role: "user", content: buildExtractorPrompt(input, previousErrors) },
      ],
    }),
  });
  if (!response.ok) {
    console.warn(
      "[contract-commercial-extraction] OpenRouter failed:",
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

function sanitizeOwnerEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/[.,;:!?)\]}>]+$/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return undefined;
  return cleaned;
}

function sanitizeExtractedPatch(
  patch: ContractCommercialPatch
): ContractCommercialPatch {
  const next = stripEmptyPatchValues({ ...patch });
  if ("owner_email" in next) {
    const email = sanitizeOwnerEmail(next.owner_email);
    if (email) next.owner_email = email;
    else delete next.owner_email;
  }
  // Never allow control fields from extraction payloads.
  delete (next as Record<string, unknown>).confirm;
  delete (next as Record<string, unknown>).confirmed_by;
  return next;
}

function buildDeterministicFallback(
  input: ContractCommercialExtractorInput,
  validationErrors: string[],
  attempts: number
): ContractCommercialExtractionResult {
  const parsed = parseContractCommercialReply(
    input.text,
    input.missingFields
  );
  const patch = sanitizeExtractedPatch(parsed.patch ?? {});
  const hasData = Object.keys(patch).length > 0;
  return {
    patch,
    confidence: "low",
    unresolved: [],
    assumptions: hasData
      ? ["Extracción determinística de respaldo tras fallo del LLM."]
      : [],
    method: "deterministic_fallback",
    attempts,
    intent: hasData ? "provide_data" : "unclear",
    reason: hasData
      ? undefined
      : parsed.reason ??
        "No pude interpretar los datos. Responde con los faltantes listados (correo, sí/no, porcentajes o meses).",
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
  };
}

/**
 * Hybrid extractor: LLM interprets free-form Spanish, Zod guards the contract,
 * deterministic parser backfills/conflicts, and the business handler remains the judge.
 */
export async function extractContractCommercialReply(
  input: ContractCommercialExtractorInput,
  model?: ContractCommercialExtractorModel
): Promise<ContractCommercialExtractionResult> {
  const text = input.text?.trim() ?? "";
  const deterministicParsed = parseContractCommercialReply(
    text,
    input.missingFields
  );
  const deterministicPatch = sanitizeExtractedPatch(
    deterministicParsed.patch ?? {}
  );

  if (!text) {
    return {
      patch: {},
      confidence: "low",
      unresolved: [],
      assumptions: [],
      method: "deterministic_fallback",
      attempts: 0,
      intent: "unclear",
      reason: "Escribe los datos faltantes para continuar.",
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
      break;
    }
    if (!isRecord(raw)) {
      validationErrors.push(`attempt_${attempt}_invalid: expected object`);
      continue;
    }
    const parsed = ContractCommercialExtractionSchema.safeParse(raw);
    if (parsed.success) {
      const llmPatch = sanitizeExtractedPatch(parsed.data.patch);
      const merged = mergeContractCommercialPatches({
        llmPatch,
        deterministicPatch,
        missingFields: input.missingFields,
        sourceText: text,
      });
      const hasData = Object.keys(merged.patch).length > 0;
      console.info(
        "[contract-commercial-extraction]",
        JSON.stringify({
          method: attempt === 1 ? "llm" : "llm_retry",
          confidence: parsed.data.confidence,
          attempts: attempt,
          captured_keys: Object.keys(merged.patch),
          unresolved_count: merged.unresolved.length + parsed.data.unresolved.length,
          validation_error_count: validationErrors.length,
        })
      );
      return {
        patch: merged.patch,
        confidence: parsed.data.confidence,
        unresolved: [...parsed.data.unresolved, ...merged.unresolved],
        assumptions: [...parsed.data.assumptions, ...merged.assumptions],
        method: attempt === 1 ? "llm" : "llm_retry",
        attempts: attempt,
        intent: hasData ? "provide_data" : "unclear",
        reason: hasData
          ? undefined
          : "No pude interpretar los datos. Responde con los faltantes listados (correo, sí/no, porcentajes o meses).",
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

  const fallback = buildDeterministicFallback(
    input,
    validationErrors,
    MAX_LLM_ATTEMPTS
  );
  console.info(
    "[contract-commercial-extraction]",
    JSON.stringify({
      method: fallback.method,
      confidence: fallback.confidence,
      attempts: fallback.attempts,
      captured_keys: Object.keys(fallback.patch),
      validation_error_count: validationErrors.length,
    })
  );
  return fallback;
}
