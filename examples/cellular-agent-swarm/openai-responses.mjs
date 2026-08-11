import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./service-utils.mjs";

export const RESPONSES_PROTOCOL = "protein-openai-responses-tools/v1";
export const PROMPT_VERSION = "protein-swarm-code-agent/v4";
export const TOOL_SCHEMA_VERSION = "protein-swarm-tools/v3";

const CANDIDATE_ID_SCHEMA = {
  type: "string",
  minLength: 71,
  maxLength: 71,
  pattern: "^sha256:[a-f0-9]{64}$",
  description: "Copy one complete candidate ID exactly as it appears in the frozen observation.",
};

const READ_CANDIDATE_TOOL = functionTool(
  "read_candidate",
  "Read the bounded source and public evidence for the current candidate or a candidate visible in the frozen neighborhood.",
  {
    type: "object",
    properties: {
      candidate_id: CANDIDATE_ID_SCHEMA,
    },
    required: ["candidate_id"],
    additionalProperties: false,
  },
);

const RUN_PUBLIC_CHECKS_TOOL = functionTool(
  "run_public_checks",
  "Store proposed solve(values) JavaScript and run only public correctness checks plus a bounded public benchmark in an isolated container.",
  {
    type: "object",
    properties: {
      source: { type: "string", maxLength: 16_384, description: "Complete JavaScript source exporting function solve(values)." },
      strategy: { type: "string", maxLength: 80, description: "Short descriptive strategy label." },
      summary: { type: "string", maxLength: 320, description: "What changed and why it may improve the task." },
    },
    required: ["source", "strategy", "summary"],
    additionalProperties: false,
  },
);

const FINALIZE_CANDIDATE_TOOL = functionTool(
  "finalize_candidate",
  "After run_public_checks passes in this generation, finalize that runtime-held draft for authoritative hidden evaluation. The runtime binds its candidate, strategy, and current-candidate lineage; supply only intent and rationale. read_candidate does not create a finalizable draft.",
  {
    type: "object",
    properties: {
      behavior: { type: "string", enum: ["explore", "improve"] },
      rationale: { type: "string", maxLength: 500 },
    },
    required: ["behavior", "rationale"],
    additionalProperties: false,
  },
);

const ADOPT_CANDIDATE_TOOL = functionTool(
  "adopt_candidate",
  "Adopt an already verified candidate visible in the frozen neighborhood without creating new source.",
  {
    type: "object",
    properties: {
      candidate_id: CANDIDATE_ID_SCHEMA,
      rationale: { type: "string", maxLength: 500 },
    },
    required: ["candidate_id", "rationale"],
    additionalProperties: false,
  },
);

const CHALLENGE_CANDIDATE_TOOL = functionTool(
  "challenge_candidate",
  "Request authoritative re-evaluation of a candidate visible in the frozen neighborhood when its evidence appears questionable.",
  {
    type: "object",
    properties: {
      candidate_id: CANDIDATE_ID_SCHEMA,
      rationale: { type: "string", maxLength: 500 },
    },
    required: ["candidate_id", "rationale"],
    additionalProperties: false,
  },
);

const WAIT_TOOL = functionTool(
  "wait",
  "End this generation without changing the candidate when no responsible improvement is available within the remaining budget.",
  {
    type: "object",
    properties: {
      rationale: { type: "string", maxLength: 500 },
    },
    required: ["rationale"],
    additionalProperties: false,
  },
);

export const ALL_RESPONSE_TOOLS = [
  READ_CANDIDATE_TOOL,
  RUN_PUBLIC_CHECKS_TOOL,
  FINALIZE_CANDIDATE_TOOL,
  ADOPT_CANDIDATE_TOOL,
  CHALLENGE_CANDIDATE_TOOL,
  WAIT_TOOL,
];

export const TERMINAL_RESPONSE_TOOLS = [
  FINALIZE_CANDIDATE_TOOL,
  ADOPT_CANDIDATE_TOOL,
  CHALLENGE_CANDIDATE_TOOL,
  WAIT_TOOL,
];

export const TOOL_SCHEMA_SHA256 = sha256(canonicalJson(ALL_RESPONSE_TOOLS));

export function buildAgentInstructions(maxTurns) {
  return `Role: You are one durable cell in a locally connected code-improvement experiment.

Outcome: Produce the strongest correct implementation of the task within ${maxTurns} model turns, using only candidates visible in the frozen observation and the provided tools.

Rules:
- Correctness comes before speed. Hidden tests are unavailable; never claim you passed them.
- Scores in the frozen observation are expressed as multiples of this run's verified seed, where 1.0 is the baseline. Compare within this scale; do not infer meaning from raw benchmark magnitudes returned by inspection tools.
- read_candidate may inspect only the current or visible neighboring candidates.
- run_public_checks is the only way to test generated source. Source must export function solve(values), use no imports, and remain under 16 KiB.
- A passing public draft is not authoritative until finalize_candidate sends it to the separate evaluator. finalize_candidate is valid only after run_public_checks returned publicPass:true in this generation. read_candidate may report publicPass for an existing artifact but never creates a finalizable draft; use wait to retain the current candidate or adopt_candidate for a visible verified candidate.
- finalize_candidate always binds the runtime-held draft, its exact strategy label, and the current verified candidate as its lineage parent. Supply only behavior and rationale; never echo candidate, draft, strategy, or parent identifiers.
- Use adopt_candidate only for a visible candidate with stronger verified evidence.
- Use challenge_candidate only when re-evaluation is more valuable than editing.
- Use wait when the remaining evidence does not justify another attempt.
- Make exactly one tool call per turn. Do not promise future or background work.

Stopping condition: End with finalize_candidate, adopt_candidate, challenge_candidate, or wait. Prefer the fewest useful tool loops, but do not skip inspection or public validation needed for a responsible candidate.`;
}

export function buildInitialInput({ agent, observation }) {
  const scoreReference = Number(observation.task?.scoreReference?.seedScore);
  const normalizedScores = Number.isFinite(scoreReference) && scoreReference > 0;
  const task = observation.task && typeof observation.task === "object"
    ? Object.fromEntries(Object.entries(observation.task).filter(([key]) => key !== "scoreReference"))
    : observation.task;
  const presentCandidate = (candidate) => normalizedScores
    ? {
        ...candidate,
        score: undefined,
        verifiedScoreMultiple: scoreMultiple(candidate.score, scoreReference),
      }
    : candidate;
  return [{
    role: "user",
    content: JSON.stringify({
      agent,
      experimentId: observation.experimentId,
      generation: observation.generation,
      condition: observation.condition,
      task: normalizedScores
        ? { ...task, scoreScale: "verified seed multiple; seed = 1.0" }
        : task,
      current: {
        candidateId: observation.candidateId,
        strategy: observation.strategy,
        ...(normalizedScores
          ? { verifiedScoreMultiple: scoreMultiple(observation.score, scoreReference) }
          : { verifiedScore: observation.score }),
        credits: observation.credits,
      },
      visibleCandidates: normalizedScores
        ? observation.neighborhood.map(presentCandidate)
        : observation.neighborhood,
    }),
  }];
}

function scoreMultiple(score, reference) {
  return typeof score === "number" && Number.isFinite(score)
    ? Number((score / reference).toFixed(6))
    : null;
}

export async function createResponsesTurn({
  apiKey,
  baseUrl = "https://api.openai.com/v1",
  model = "gpt-5.6-luna",
  input,
  turn,
  maxTurns,
  metadata,
  reasoningEffort = "medium",
  maxOutputTokens = 1_200,
  timeoutMs = 45_000,
  maximumAttempts = 3,
  fetchImpl = fetch,
}) {
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("OPENAI_API_KEY is required");
  if (!Array.isArray(input) || input.length === 0) throw new Error("Responses input must be a non-empty array");
  if (!Number.isInteger(turn) || turn < 0) throw new Error("turn must be a non-negative integer");
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || turn >= maxTurns) throw new Error("turn exceeds the configured model-turn budget");
  const tools = turn === maxTurns - 1 ? TERMINAL_RESPONSE_TOOLS : ALL_RESPONSE_TOOLS;
  const clientRequestId = `protein-${randomUUID()}`;
  const requestBody = {
    model,
    instructions: buildAgentInstructions(maxTurns),
    input,
    tools,
    tool_choice: "required",
    parallel_tool_calls: false,
    max_tool_calls: 1,
    reasoning: { effort: reasoningEffort },
    text: { verbosity: "low" },
    max_output_tokens: maxOutputTokens,
    store: false,
    include: ["reasoning.encrypted_content"],
    metadata,
  };
  const attempts = [];
  const endpoint = responsesEndpoint(baseUrl);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const startedAt = performance.now();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": clientRequestId,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      attempts.push({ attempt, status: "transport_error", ambiguous: true, durationMs: fixed(performance.now() - startedAt) });
      if (attempt === maximumAttempts) throw providerError("transport_error", String(error), attempts);
      await delay(backoffMs(attempt));
      continue;
    }
    const providerRequestId = response.headers.get("x-request-id");
    attempts.push({
      attempt,
      status: response.status,
      providerRequestId,
      ambiguous: false,
      durationMs: fixed(performance.now() - startedAt),
    });
    let text;
    let parsed;
    try {
      text = await boundedResponseText(response, 2_000_000);
      parsed = parseJson(text, "OpenAI response");
    } catch (error) {
      throw attachAttemptContext(error, attempts, providerRequestId);
    }
    if (!response.ok) {
      const error = normalizedApiError(parsed, response.status, attempts);
      if (attempt < maximumAttempts && retryableStatus(response.status, parsed)) {
        await delay(retryDelayMs(response, attempt));
        continue;
      }
      throw error;
    }
    try {
      return normalizeResponse(parsed, {
        attempts,
        clientRequestId,
        providerRequestId,
        requestBody,
        allowedTools: new Set(tools.map((tool) => tool.name)),
      });
    } catch (error) {
      throw attachAttemptContext(error, attempts, providerRequestId);
    }
  }
  throw new Error("Responses attempt loop exhausted unexpectedly");
}

function normalizeResponse(response, context) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) throw new Error("OpenAI returned a non-object response");
  if (typeof response.id !== "string" || response.id.length === 0) throw new Error("OpenAI response is missing id");
  if (response.status !== "completed") {
    const error = new Error(`OpenAI response ended with status ${String(response.status)}`);
    error.code = response.status === "incomplete" ? "provider_incomplete" : "provider_failed";
    error.usage = normalizeUsage(response.usage);
    error.details = response.incomplete_details ?? response.error ?? null;
    throw error;
  }
  if (!Array.isArray(response.output)) throw new Error("OpenAI response output must be an array");
  const calls = response.output.filter((item) => item?.type === "function_call");
  if (calls.length !== 1) throw new Error(`Expected exactly one function_call, received ${calls.length}`);
  const call = calls[0];
  if (typeof call.call_id !== "string" || call.call_id.length === 0) throw new Error("function_call is missing call_id");
  if (typeof call.name !== "string" || !context.allowedTools.has(call.name)) throw new Error(`Unknown function tool ${String(call.name)}`);
  if (typeof call.arguments !== "string" || call.arguments.length > 20_000) throw new Error("function_call arguments must be a bounded JSON string");
  parseJson(call.arguments, "function_call arguments");
  if (call.status !== undefined && call.status !== "completed") throw new Error(`function_call ended with status ${String(call.status)}`);
  return {
    responseId: response.id,
    status: response.status,
    model: typeof response.model === "string" ? response.model : null,
    output: response.output,
    functionCall: {
      callId: call.call_id,
      name: call.name,
      arguments: call.arguments,
    },
    usage: normalizeUsage(response.usage),
    clientRequestId: context.clientRequestId,
    providerRequestId: context.providerRequestId,
    attempts: context.attempts,
    request: context.requestBody,
  };
}

export function normalizeUsage(value) {
  const usage = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const inputDetails = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};
  return {
    inputTokens: nonnegative(usage.input_tokens),
    outputTokens: nonnegative(usage.output_tokens),
    totalTokens: nonnegative(usage.total_tokens),
    cachedInputTokens: nonnegative(inputDetails.cached_tokens),
    cacheWriteTokens: nonnegative(inputDetails.cache_write_tokens),
    reasoningTokens: nonnegative(outputDetails.reasoning_tokens),
  };
}

function functionTool(name, description, parameters) {
  return { type: "function", name, description, parameters, strict: true };
}

function responsesEndpoint(baseUrl) {
  const normalized = String(baseUrl).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/responses` : `${normalized}/v1/responses`;
}

async function boundedResponseText(response, maximumBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) throw new Error("OpenAI response exceeded the configured size limit");
  return text;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function normalizedApiError(body, status, attempts) {
  const provider = body?.error;
  const message = typeof provider?.message === "string" ? provider.message.slice(0, 500) : `OpenAI returned HTTP ${status}`;
  const error = providerError(typeof provider?.code === "string" ? provider.code : `http_${status}`, message, attempts);
  error.status = status;
  error.type = typeof provider?.type === "string" ? provider.type : null;
  return error;
}

function providerError(code, message, attempts) {
  const error = new Error(message);
  error.name = "OpenAIProviderError";
  error.code = code;
  error.attempts = attempts;
  return error;
}

function attachAttemptContext(error, attempts, providerRequestId) {
  if (error !== null && typeof error === "object") {
    error.attempts ??= attempts;
    error.providerRequestId ??= providerRequestId;
  }
  return error;
}

function retryableStatus(status, body) {
  if (status >= 500) return true;
  if (status !== 429) return false;
  const code = body?.error?.code;
  return code !== "insufficient_quota" && code !== "billing_hard_limit_reached";
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) ? Math.min(5_000, Math.max(100, retryAfter * 1_000)) : backoffMs(attempt);
}

function backoffMs(attempt) {
  return Math.min(2_000, 200 * (2 ** (attempt - 1)));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function fixed(value) {
  return Number(value.toFixed(3));
}
