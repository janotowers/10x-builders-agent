import { z } from "zod";

const DEFAULT_CLASSIFIER_MODEL = "openai/gpt-4o-mini";

const PatchSchema = z
  .object({
    property_title: z.string().optional(),
    property_zone: z.string().optional(),
    operation_type: z.string().optional(),
    property_type: z.string().optional(),
    notes: z.string().optional(),
  })
  .partial();

export const OperationalConversationClassificationSchema = z.object({
  route: z.enum(["property_optioning", "existing_case", "general", "clarify"]),
  confidence: z.enum(["high", "medium", "low"]),
  intent: z.enum([
    "start_case",
    "provide_intake",
    "review_correction",
    "confirm_review",
    "deliver_documents",
    "mark_ready",
    "other",
  ]),
  patch: PatchSchema.optional(),
  reason: z.string().optional(),
});

export type OperationalConversationClassification = z.infer<
  typeof OperationalConversationClassificationSchema
>;

export interface OperationalConversationClassifierInput {
  message: string;
  stage:
    | "no_case"
    | "intake"
    | "property_data_review"
    | "awaiting_documents"
    | "active_case";
  caseSummary?: string | null;
}

export interface OperationalConversationClassifierModel {
  classify(
    input: OperationalConversationClassifierInput
  ): Promise<unknown>;
}

function sanitizePatch(
  patch: OperationalConversationClassification["patch"] | undefined
) {
  if (!patch) return undefined;
  const sanitized = Object.fromEntries(
    Object.entries(patch).filter(
      ([, value]) => typeof value === "string" && value.trim().length > 0
    )
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeClassification(
  value: unknown
): OperationalConversationClassification | null {
  const parsed = OperationalConversationClassificationSchema.safeParse(value);
  if (!parsed.success) return null;
  const patch = sanitizePatch(parsed.data.patch);
  return {
    ...parsed.data,
    ...(patch ? { patch } : {}),
  };
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function buildClassifierPrompt(input: OperationalConversationClassifierInput) {
  const intakeSpecificRules =
    input.stage === "intake"
      ? [
          "- For stage=intake, focus on extracting ONLY these fields when present: property_title, property_zone, operation_type, property_type.",
          "- You may infer property_type from title text when explicit (e.g. 'Casa en venta' => Casa).",
          "- You may infer operation_type from intent phrases when explicit (e.g. 'en venta' => Venta, 'en renta' => Renta).",
          "- Keep user-provided descriptive titles intact; only shorten property_title when the user explicitly separates title and zone labels.",
          "- Never include operation or type labels inside property_zone.",
          "- If a field is unclear, omit it from patch.",
        ]
      : [];
  const awaitingDocumentsRules =
    input.stage === "awaiting_documents"
      ? [
          "- The current case is collecting property documents from the internal team.",
          "- intent=deliver_documents when the user announces, attaches, or refers to sending/uploading documents (e.g. 'adjunto documentos', 'ahí te van', 'te paso lo que junté', 'aquí están los archivos', 'ya subí la escritura'). Use route=existing_case for these.",
          "- intent=mark_ready when the user signals they finished uploading and want processing to start (e.g. 'listo', 'ya terminé', 'eso es todo', 'ya están todos'). Use route=existing_case.",
          "- intent=start_case ONLY when the user clearly wants to open a DIFFERENT/new property case, not continue this one.",
          "- Prefer existing_case over clarify; only use clarify if the message is genuinely unrelated and ambiguous.",
          "- Never extract intake fields in this stage.",
        ]
      : [];
  return [
    "Classify this Spanish Telegram message for a real-estate operational case workflow.",
    "Return ONLY compact JSON matching this TypeScript shape:",
    '{"route":"property_optioning|existing_case|general|clarify","confidence":"high|medium|low","intent":"start_case|provide_intake|review_correction|confirm_review|other","patch":{"property_title"?:string,"property_zone"?:string,"operation_type"?:string,"property_type"?:string,"notes"?:string},"reason"?:string}',
    "",
    "Rules:",
    "- property_optioning means the user wants to start/capture/option/list a property case for an inmobiliaria workflow.",
    "- existing_case means the message belongs to the current operational case.",
    "- general means unrelated assistant/business question.",
    "- clarify only if the message is genuinely ambiguous.",
    "- For review corrections, extract only explicit corrections into patch.",
    "- Normalize common operation values to Venta or Renta when clear.",
    "- Do not invent missing intake fields.",
    ...intakeSpecificRules,
    ...awaitingDocumentsRules,
    "",
    `stage: ${input.stage}`,
    input.caseSummary ? `case: ${input.caseSummary}` : "",
    `message: ${JSON.stringify(input.message)}`,
  ].join("\n");
}

async function invokeOpenRouterClassifier(
  input: OperationalConversationClassifierInput
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model =
    process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID?.trim() ||
    DEFAULT_CLASSIFIER_MODEL;
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
      max_tokens: 220,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON classifier. Never call tools. Never answer conversationally.",
        },
        { role: "user", content: buildClassifierPrompt(input) },
      ],
    }),
  });
  if (!response.ok) {
    console.warn(
      "[operational-conversation-classifier] OpenRouter failed:",
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

export async function classifyOperationalConversationMessage(
  input: OperationalConversationClassifierInput,
  model?: OperationalConversationClassifierModel
): Promise<OperationalConversationClassification | null> {
  if (!input.message.trim()) return null;
  try {
    const raw = model
      ? await model.classify(input)
      : await invokeOpenRouterClassifier(input);
    return normalizeClassification(raw);
  } catch (error) {
    console.warn("[operational-conversation-classifier] failed:", error);
    return null;
  }
}
