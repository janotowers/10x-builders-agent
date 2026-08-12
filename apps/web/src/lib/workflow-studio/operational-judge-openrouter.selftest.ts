import assert from "node:assert/strict";
import {
  OperationalJudgeInfrastructureError,
  requestOperationalJudgeVerdict,
} from "./operational-judge-openrouter";

const validPass = {
  schema_version: "1",
  verdict: "pass",
  summary: "All criteria are supported.",
  confidence: 0.95,
  criteria: [
    {
      criterion_id: "safe",
      passed: true,
      score: 1,
      explanation: "No external write occurred.",
    },
  ],
  remediation_items: [],
};

function completion(content: unknown, id = "request-1"): Response {
  return Response.json({
    id,
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

async function main() {
  {
    const requests: RequestInit[] = [];
    const usageEvents: Array<Record<string, unknown>> = [];
    const secretBusinessText = "PRIVATE_PROMPT_CLIENT_ACME";
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          error: {
            code: "unsupported_response_format",
            message: `Rejected request containing ${secretBusinessText}`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    };

    await assert.rejects(
      requestOperationalJudgeVerdict({
        apiKey: "test-key",
        modelId: "test/judge",
        prompt: secretBusinessText,
        expectedCriterionIds: ["safe"],
        fetchImpl,
        recordUsage: async (event) => {
          usageEvents.push(event);
        },
      }),
      (error) => {
        assert.ok(error instanceof OperationalJudgeInfrastructureError);
        assert.equal(error.code, "judge_provider_http_error");
        assert.equal(error.details.httpStatus, 400);
        assert.equal(
          error.details.providerCode,
          "unsupported_response_format"
        );
        assert.doesNotMatch(error.message, new RegExp(secretBusinessText));
        return true;
      }
    );
    assert.equal(requests.length, 1, "HTTP 400 must not retry");
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0]?.errorCode, "http_400");
    const sent = JSON.parse(String(requests[0]?.body)) as {
      response_format?: { type?: string; json_schema?: unknown };
    };
    assert.equal(sent.response_format?.type, "json_object");
    assert.equal("json_schema" in (sent.response_format ?? {}), false);
  }

  {
    let calls = 0;
    const retries: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? completion({ ...validPass, criteria: [{ criterion_id: "safe" }] })
        : completion({ ...validPass, extra: "not allowed" }, "request-2");
    };
    await assert.rejects(
      requestOperationalJudgeVerdict({
        apiKey: "test-key",
        modelId: "test/judge",
        prompt: "Judge fixture.",
        expectedCriterionIds: ["safe"],
        fetchImpl,
        recordUsage: async (event) => {
          retries.push(event.retryOrdinal ?? 0);
        },
      }),
      (error) =>
        error instanceof OperationalJudgeInfrastructureError &&
        error.code === "judge_invalid_response_contract" &&
        error.details.attempts === 2
    );
    assert.equal(calls, 2, "invalid HTTP-200 contracts get one bounded retry");
    assert.deepEqual(retries, [0, 1]);
  }

  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return completion(validPass);
    };
    const verdict = await requestOperationalJudgeVerdict({
      apiKey: "test-key",
      modelId: "test/judge",
      prompt: "Judge fixture.",
      expectedCriterionIds: ["safe"],
      fetchImpl,
      recordUsage: async () => {},
    });
    assert.equal(verdict.verdict, "pass");
    assert.equal(calls, 1);
  }

  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return completion({
        ...validPass,
        verdict: "fail",
        summary: "The safety criterion failed.",
        criteria: [
          {
            criterion_id: "safe",
            passed: false,
            score: 0,
            explanation: "An external write occurred.",
          },
        ],
        remediation_items: ["Remove the external write."],
      });
    };
    const verdict = await requestOperationalJudgeVerdict({
      apiKey: "test-key",
      modelId: "test/judge",
      prompt: "Judge fixture.",
      expectedCriterionIds: ["safe"],
      fetchImpl,
      recordUsage: async () => {},
    });
    assert.equal(verdict.verdict, "fail");
    assert.equal(calls, 1, "substantive fail verdicts must not retry");
  }

  console.log("operational-judge-openrouter.selftest: ok");
}

void main();
