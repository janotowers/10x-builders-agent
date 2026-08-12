import {
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  operationalJudgeResponseContractInstructions,
  parseOperationalJudgeVerdict,
  type OperationalJudgeVerdict,
} from "@agents/workflows";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const MAX_CONTRACT_ATTEMPTS = 2;
const MAX_ERROR_BODY_BYTES = 8_192;

type JudgeUsageRecorder = typeof recordOpenRouterCallUsage;

export type OperationalJudgeInfrastructureCode =
  | "judge_not_configured"
  | "judge_provider_http_error"
  | "judge_transport_error"
  | "judge_invalid_response_contract";

export class OperationalJudgeInfrastructureError extends Error {
  constructor(
    readonly code: OperationalJudgeInfrastructureCode,
    message: string,
    readonly details: {
      attempts: number;
      httpStatus?: number;
      providerCode?: string;
    }
  ) {
    super(message);
    this.name = "OperationalJudgeInfrastructureError";
  }
}

function safeProviderCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(trimmed) ? trimmed : null;
}

async function readSanitizedProviderError(response: Response): Promise<{
  providerCode: string | null;
}> {
  let raw = "";
  try {
    const reader = response.body?.getReader();
    if (!reader) return { providerCode: null };
    const decoder = new TextDecoder();
    let bytesRead = 0;
    while (bytesRead < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      raw += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (value.byteLength > remaining) {
        await reader.cancel();
        break;
      }
    }
    raw += decoder.decode();
  } catch {
    return { providerCode: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { providerCode: null };
    }
    const record = parsed as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : {};
    return {
      providerCode:
        safeProviderCode(nested.code) ?? safeProviderCode(record.code) ?? null,
    };
  } catch {
    return { providerCode: null };
  }
}

function parseJsonObjectContent(content: unknown): unknown {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Operational judge response content was not a JSON string");
  }
  return JSON.parse(content);
}

function requestBody(params: {
  modelId: string;
  prompt: string;
  expectedCriterionIds: readonly string[];
  retry: boolean;
}): string {
  const contract = operationalJudgeResponseContractInstructions(
    params.expectedCriterionIds
  );
  return JSON.stringify({
    model: params.modelId,
    temperature: 0,
    max_tokens: 1800,
    response_format: { type: "json_object" },
    usage: { include: true },
    messages: [
      {
        role: "system",
        content: [
          "You are Gu OS Studio's independent operational judge. You have no tools.",
          "Judge only the supplied evidence. Never execute, repair, publish, send, or call tools.",
          contract,
          ...(params.retry
            ? [
                "The prior HTTP-200 response failed the JSON contract. Return a corrected contract object; do not reconsider a substantive verdict.",
              ]
            : []),
        ].join("\n"),
      },
      { role: "user", content: params.prompt },
    ],
  });
}

export async function requestOperationalJudgeVerdict(params: {
  apiKey: string;
  modelId: string;
  prompt: string;
  expectedCriterionIds: readonly string[];
  fetchImpl?: typeof fetch;
  recordUsage?: JudgeUsageRecorder;
}): Promise<OperationalJudgeVerdict> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const recordUsage = params.recordUsage ?? recordOpenRouterCallUsage;

  for (let attempt = 0; attempt < MAX_CONTRACT_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://agents.local",
        },
        body: requestBody({
          modelId: params.modelId,
          prompt: params.prompt,
          expectedCriterionIds: params.expectedCriterionIds,
          retry: attempt > 0,
        }),
      });
    } catch {
      await recordUsage({
        modelId: params.modelId,
        modelRole: "studio_operational_judge",
        operation: "chat_completion",
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: "transport_network",
        retryOrdinal: attempt,
      });
      throw new OperationalJudgeInfrastructureError(
        "judge_transport_error",
        "Operational judge transport failed",
        { attempts: attempt + 1 }
      );
    }

    if (!response.ok) {
      const sanitized = await readSanitizedProviderError(response);
      await recordUsage({
        modelId: params.modelId,
        modelRole: "studio_operational_judge",
        operation: "chat_completion",
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: `http_${response.status}`,
        retryOrdinal: attempt,
        metadata: {
          provider_error_code: sanitized.providerCode,
        },
      });
      throw new OperationalJudgeInfrastructureError(
        "judge_provider_http_error",
        `Operational judge provider rejected the request (HTTP ${response.status})`,
        {
          attempts: attempt + 1,
          httpStatus: response.status,
          ...(sanitized.providerCode
            ? { providerCode: sanitized.providerCode }
            : {}),
        }
      );
    }

    let envelope:
      | {
          id?: string;
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: OpenRouterUsagePayload;
        }
      | undefined;
    let verdict: OperationalJudgeVerdict | undefined;
    try {
      envelope = (await response.json()) as typeof envelope;
      verdict = parseOperationalJudgeVerdict(
        parseJsonObjectContent(envelope?.choices?.[0]?.message?.content),
        params.expectedCriterionIds
      );
    } catch {
      await recordUsage({
        modelId: params.modelId,
        modelRole: "studio_operational_judge",
        operation: "chat_completion",
        usage: envelope?.usage ?? null,
        providerRequestId:
          typeof envelope?.id === "string" ? envelope.id : null,
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: "invalid_response_contract",
        retryOrdinal: attempt,
      });
      if (attempt + 1 < MAX_CONTRACT_ATTEMPTS) continue;
      throw new OperationalJudgeInfrastructureError(
        "judge_invalid_response_contract",
        "Operational judge returned an invalid response contract",
        { attempts: attempt + 1 }
      );
    }

    await recordUsage({
      modelId: params.modelId,
      modelRole: "studio_operational_judge",
      operation: "chat_completion",
      usage: envelope?.usage ?? null,
      providerRequestId:
        typeof envelope?.id === "string" ? envelope.id : null,
      latencyMs: Date.now() - startedAt,
      retryOrdinal: attempt,
    });
    return verdict;
  }

  throw new OperationalJudgeInfrastructureError(
    "judge_invalid_response_contract",
    "Operational judge returned an invalid response contract",
    { attempts: MAX_CONTRACT_ATTEMPTS }
  );
}
