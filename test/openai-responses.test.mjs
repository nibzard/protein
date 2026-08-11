import { describe, expect, it } from "vitest";
import {
  ALL_RESPONSE_TOOLS,
  TERMINAL_RESPONSE_TOOLS,
  buildInitialInput,
  createResponsesTurn,
  normalizeUsage,
} from "../examples/cellular-agent-swarm/openai-responses.mjs";

const API_KEY = "sk-test-never-send";
const BASELINE_ID = `sha256:${"1".repeat(64)}`;

describe("cellular swarm raw OpenAI Responses client", () => {
  it("presents benchmark scores as within-run seed multiples", () => {
    const [item] = buildInitialInput({
      agent: "cell-a",
      observation: {
        experimentId: "experiment-1",
        generation: 2,
        condition: "local",
        candidateId: BASELINE_ID,
        strategy: "current",
        score: 30_000,
        credits: 20,
        task: {
          id: "fixture/v3",
          scoreReference: { kind: "within_run_verified_seed_multiple", seedScore: 12_000 },
        },
        neighborhood: [{ candidateId: BASELINE_ID, strategy: "current", score: 24_000 }],
      },
    });
    const presented = JSON.parse(item.content);

    expect(presented.task).toEqual({
      id: "fixture/v3",
      scoreScale: "verified seed multiple; seed = 1.0",
    });
    expect(presented.current).toMatchObject({ verifiedScoreMultiple: 2.5 });
    expect(presented.current).not.toHaveProperty("verifiedScore");
    expect(presented.visibleCandidates[0]).toMatchObject({ verifiedScoreMultiple: 2 });
    expect(presented.visibleCandidates[0]).not.toHaveProperty("score");
  });

  it("sends an explicit stateless, strict, single-tool Responses request", async () => {
    const requests = [];
    const output = [
      reasoningItem("encrypted-reasoning-turn-0"),
      functionCall("call-read-1", "read_candidate", { candidate_id: BASELINE_ID }),
    ];

    const result = await createResponsesTurn({
      ...turnOptions(),
      metadata: { experiment_id: "experiment-1", turn: "0" },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(completedResponse({ output }), {
          headers: { "x-request-id": "req-provider-1" },
        });
      },
    });

    expect(requests).toHaveLength(1);
    const [{ url, init }] = requests;
    expect(url).toBe("https://example.openai.test/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-client-request-id"]).toMatch(/^protein-/);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "gpt-test",
      store: false,
      include: ["reasoning.encrypted_content"],
      tool_choice: "required",
      parallel_tool_calls: false,
      max_tool_calls: 1,
      max_output_tokens: 321,
      reasoning: { effort: "medium" },
      metadata: { experiment_id: "experiment-1", turn: "0" },
    });
    expect(body.input).toEqual([{ role: "user", content: "bounded observation" }]);
    expect(body.tools).toEqual(ALL_RESPONSE_TOOLS);
    expect(body.tools).toHaveLength(6);
    for (const tool of body.tools) assertStrictResponsesTool(tool);
    for (const name of ["read_candidate", "adopt_candidate", "challenge_candidate"]) {
      expect(toolNamed(body.tools, name).parameters.properties.candidate_id).toMatchObject({
        minLength: 71,
        maxLength: 71,
        pattern: "^sha256:[a-f0-9]{64}$",
      });
    }
    const finalizeParameters = toolNamed(body.tools, "finalize_candidate").parameters;
    expect(finalizeParameters.properties).not.toHaveProperty("draft_ref");
    expect(finalizeParameters.properties).not.toHaveProperty("strategy");
    expect(finalizeParameters.properties).not.toHaveProperty("parent_candidate_ids");
    expect(finalizeParameters.required).toEqual(["behavior", "rationale"]);

    expect(result.output).toEqual(output);
    expect(result.functionCall).toEqual({
      callId: "call-read-1",
      name: "read_candidate",
      arguments: JSON.stringify({ candidate_id: BASELINE_ID }),
    });
    expect(result.providerRequestId).toBe("req-provider-1");
  });

  it("replays every prior output item unchanged and attaches the matching call output", async () => {
    const priorReasoning = reasoningItem("opaque-encrypted-content");
    const priorCall = functionCall("call-prior-7", "read_candidate", {
      candidate_id: "candidate-visible-7",
    });
    const priorCallOutput = {
      type: "function_call_output",
      call_id: priorCall.call_id,
      output: JSON.stringify({ ok: true, candidate: { id: "candidate-visible-7" } }),
    };
    const input = [
      { role: "user", content: "original frozen observation" },
      priorReasoning,
      priorCall,
      priorCallOutput,
    ];
    let sentBody;

    await createResponsesTurn({
      ...turnOptions({ input, turn: 1, maxTurns: 3 }),
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return jsonResponse(completedResponse({
          output: [functionCall("call-wait-8", "wait", { rationale: "No safe improvement remains." })],
        }));
      },
    });

    expect(sentBody.input).toEqual(input);
    expect(JSON.stringify(sentBody.input)).toBe(JSON.stringify(input));
    expect(sentBody.input[1]).toMatchObject({
      type: "reasoning",
      encrypted_content: "opaque-encrypted-content",
    });
    expect(sentBody.input[2]).toEqual(priorCall);
    expect(sentBody.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call-prior-7",
      output: priorCallOutput.output,
    });
  });

  it("limits the final turn to terminal strict tools", async () => {
    let sentBody;
    await createResponsesTurn({
      ...turnOptions({ turn: 1, maxTurns: 2 }),
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return jsonResponse(completedResponse({
          output: [functionCall("call-final", "wait", { rationale: "Budget is exhausted." })],
        }));
      },
    });

    expect(sentBody.tools).toEqual(TERMINAL_RESPONSE_TOOLS);
    expect(sentBody.tools.map((tool) => tool.name)).not.toContain("read_candidate");
    expect(sentBody.tools.map((tool) => tool.name)).not.toContain("run_public_checks");
    for (const tool of sentBody.tools) assertStrictResponsesTool(tool);
  });

  it.each([
    ["no function calls", [reasoningItem("opaque")], /received 0/],
    [
      "multiple function calls",
      [
        functionCall("call-1", "wait", { rationale: "First" }),
        functionCall("call-2", "wait", { rationale: "Second" }),
      ],
      /received 2/,
    ],
    [
      "a missing call_id",
      [{ ...functionCall("call-unused", "wait", { rationale: "Missing ID" }), call_id: "" }],
      /missing call_id/,
    ],
    [
      "an unknown function",
      [functionCall("call-unknown", "escape_sandbox", {})],
      /Unknown function tool escape_sandbox/,
    ],
    [
      "malformed function arguments",
      [{ ...functionCall("call-json", "wait", { rationale: "bad" }), arguments: "{" }],
      /function_call arguments was not valid JSON/,
    ],
  ])("rejects %s without executing a tool", async (_label, output, expected) => {
    const operation = createResponsesTurn({
      ...turnOptions(),
      fetchImpl: async () => jsonResponse(completedResponse({ output })),
    });

    await expect(operation).rejects.toThrow(expected);
  });

  it("rejects a malformed provider JSON body", async () => {
    await expect(createResponsesTurn({
      ...turnOptions(),
      fetchImpl: async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })).rejects.toThrow("OpenAI response was not valid JSON");
  });

  it("normalizes complete and incomplete usage without trusting invalid counters", async () => {
    expect(normalizeUsage({
      input_tokens: 101,
      output_tokens: 23,
      total_tokens: 124,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 9 },
      output_tokens_details: { reasoning_tokens: 17 },
    })).toEqual({
      inputTokens: 101,
      outputTokens: 23,
      totalTokens: 124,
      cachedInputTokens: 40,
      cacheWriteTokens: 9,
      reasoningTokens: 17,
    });
    expect(normalizeUsage({
      input_tokens: -1,
      output_tokens: Number.NaN,
      total_tokens: "124",
      input_tokens_details: null,
      output_tokens_details: { reasoning_tokens: -4 },
    })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });

    const incompleteUsage = {
      input_tokens: 88,
      output_tokens: 12,
      total_tokens: 100,
      output_tokens_details: { reasoning_tokens: 12 },
    };
    let failure;
    try {
      await createResponsesTurn({
        ...turnOptions(),
        fetchImpl: async () => jsonResponse({
          id: "resp-incomplete",
          status: "incomplete",
          output: [],
          usage: incompleteUsage,
          incomplete_details: { reason: "max_output_tokens" },
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "provider_incomplete",
      details: { reason: "max_output_tokens" },
      attempts: [{ attempt: 1, status: 200, ambiguous: false }],
      usage: {
        inputTokens: 88,
        outputTokens: 12,
        totalTokens: 100,
        reasoningTokens: 12,
      },
    });
  });

  it("normalizes non-retryable provider errors and records the request ID", async () => {
    let calls = 0;
    let failure;
    try {
      await createResponsesTurn({
        ...turnOptions(),
        maximumAttempts: 3,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({
            error: {
              code: "invalid_request_error",
              type: "invalid_request_error",
              message: "The request schema was invalid.",
            },
          }, { status: 400, headers: { "x-request-id": "req-invalid-400" } });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(1);
    expect(failure).toMatchObject({
      name: "OpenAIProviderError",
      code: "invalid_request_error",
      status: 400,
      type: "invalid_request_error",
      attempts: [{
        attempt: 1,
        status: 400,
        providerRequestId: "req-invalid-400",
        ambiguous: false,
      }],
    });
  });

  it("marks a terminal transport failure as an ambiguous provider attempt", async () => {
    let failure;
    try {
      await createResponsesTurn({
        ...turnOptions(),
        fetchImpl: async () => {
          throw new TypeError("socket reset after dispatch");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "OpenAIProviderError",
      code: "transport_error",
      attempts: [{ attempt: 1, status: "transport_error", ambiguous: true }],
    });
  });
});

function turnOptions(overrides = {}) {
  return {
    apiKey: API_KEY,
    baseUrl: "https://example.openai.test",
    model: "gpt-test",
    input: [{ role: "user", content: "bounded observation" }],
    turn: 0,
    maxTurns: 2,
    maxOutputTokens: 321,
    timeoutMs: 1_000,
    maximumAttempts: 1,
    ...overrides,
  };
}

function completedResponse({ output, usage = undefined }) {
  return {
    id: "resp-test-1",
    status: "completed",
    model: "gpt-test-actual",
    output,
    usage: usage ?? {
      input_tokens: 71,
      output_tokens: 19,
      total_tokens: 90,
      input_tokens_details: { cached_tokens: 11, cache_write_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    },
  };
}

function reasoningItem(encryptedContent) {
  return {
    id: "rs-test-1",
    type: "reasoning",
    summary: [],
    encrypted_content: encryptedContent,
  };
}

function functionCall(callId, name, args) {
  return {
    id: `fc-${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function assertStrictResponsesTool(tool) {
  expect(tool.type).toBe("function");
  expect(tool.function).toBeUndefined();
  expect(tool.name).toEqual(expect.any(String));
  expect(tool.description).toEqual(expect.any(String));
  expect(tool.strict).toBe(true);
  assertStrictObjectSchema(tool.parameters);
}

function toolNamed(tools, name) {
  const tool = tools.find((value) => value.name === name);
  expect(tool).toBeDefined();
  return tool;
}

function assertStrictObjectSchema(schema) {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  for (const property of Object.values(schema.properties)) {
    if (property.type === "object") assertStrictObjectSchema(property);
    if (property.type === "array" && property.items?.type === "object") {
      assertStrictObjectSchema(property.items);
    }
  }
}
