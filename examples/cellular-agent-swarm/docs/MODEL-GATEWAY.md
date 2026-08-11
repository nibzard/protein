# OpenAI Responses Model Gateway

## Scope

The live swarm pilot uses a small application-owned gateway around the raw
OpenAI Responses API. It does not use the OpenAI Agents SDK and it is not a new
Protein runtime feature. The gateway turns one durable Protein action into one
bounded model turn, records a local receipt, and preserves the typed Responses
items needed by the next turn.

The gateway is only one boundary in the system. It cannot execute generated
code, read arbitrary artifacts, inspect hidden cases, assign a score, or settle
a generation. Those responsibilities remain in the executor, evaluator, and
board services.

## Request contract

Each provider turn is an HTTP `POST` to `/v1/responses` with a Bearer credential
read from `OPENAI_API_KEY`. The key is never part of an action payload,
transcript, evidence manifest, or log record. The relevant body shape is:

```json
{
  "model": "<configured model>",
  "instructions": "<versioned swarm instructions>",
  "input": ["<typed Responses input items>"],
  "tools": [
    {
      "type": "function",
      "name": "read_candidate",
      "description": "<bounded purpose>",
      "parameters": {
        "type": "object",
        "properties": {
          "candidate_id": { "type": "string" }
        },
        "required": ["candidate_id"],
        "additionalProperties": false
      },
      "strict": true
    }
  ],
  "tool_choice": "required",
  "parallel_tool_calls": false,
  "max_tool_calls": 1,
  "reasoning": { "effort": "<configured effort>" },
  "max_output_tokens": 1200,
  "store": false,
  "include": ["reasoning.encrypted_content"]
}
```

Responses function definitions are flat: `name`, `description`, `parameters`,
and `strict` sit directly on the tool object rather than inside a nested
`function` object. Every object schema sets `additionalProperties: false`, and
every declared property is required. Optional semantics must be represented by
a nullable value rather than an omitted schema requirement.

The gateway also sends an `X-Client-Request-Id` for correlation and records the
provider's `x-request-id` when one is returned. Neither header is an
idempotency guarantee.

See OpenAI's current documentation for
[function calling](https://developers.openai.com/api/docs/guides/function-calling),
[strict mode](https://developers.openai.com/api/docs/guides/function-calling#strict-mode),
and [request IDs](https://developers.openai.com/api/reference/overview#debugging-requests).

## Bounded tools

The full turn exposes six functions:

| Tool | Role |
|---|---|
| `read_candidate` | Read bounded source and public evidence for the current candidate or one visible in the frozen neighborhood. |
| `run_public_checks` | Store proposed `solve(values)` source and run public correctness checks and a bounded benchmark in the sandbox. |
| `finalize_candidate` | After `run_public_checks` passes, send the runtime-held draft for authoritative hidden evaluation. The model supplies only behavior and rationale; the runtime binds candidate, strategy, and lineage. |
| `adopt_candidate` | Adopt an already verified candidate visible in the frozen neighborhood. |
| `challenge_candidate` | Request authoritative re-evaluation of a visible candidate. |
| `wait` | End the cell's generation without changing its candidate. |

The final allowed model turn exposes only the four terminal tools. The request
requires a tool, disables parallel calls, caps provider tool calls at one, and
the response parser accepts exactly one completed `function_call`. Unknown
names, missing `call_id`, invalid JSON arguments, multiple calls, no call, or a
non-completed response fail the turn without executing a tool.

Application limits bound model turns and non-terminal tool calls per cell and
generation. The default pilot permits four model turns and three non-terminal
tool calls. These are integration limits, not evidence that the budgets are
fair across experimental conditions.

`read_candidate(publicPass:true)` describes an existing artifact; it does not
create a draft that `finalize_candidate` may submit again. Retaining the current
candidate uses `wait`, while taking an already verified visible candidate uses
`adopt_candidate`. This distinction prevents redundant evaluation and removes
opaque identifier and strategy-label echoing from finalization.

## Stateless replay

Provider storage is disabled with `store: false`. Conversation continuity is
therefore application-owned:

1. The first turn contains one user item with the frozen cell observation.
2. The gateway appends every returned `response.output` item unchanged,
   including reasoning items and their opaque `encrypted_content`.
3. After the application executes the requested tool, it appends exactly one
   item shaped as:

   ```json
   {
     "type": "function_call_output",
     "call_id": "<the exact preceding call_id>",
     "output": "<JSON string>"
   }
   ```

4. The complete accumulated input, stable instructions, and tool definitions
   are sent on the next turn.

A continuation whose `call_id` does not match the immediately preceding model
call is rejected. All output item types are retained rather than assuming that
the first item is a message or function call. This is important for reasoning
models; OpenAI recommends replaying reasoning items together with function
calls and outputs. See
[keeping reasoning items in context](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context).

`store: false` governs provider-side Responses storage. It does not mean the
application has no transcript. The gateway persists raw replay items locally
so a later Protein action can continue the loop. That local state may contain
prompts, generated source, tool outputs, and encrypted reasoning material and
must be treated as sensitive run data.

See OpenAI's [data controls](https://developers.openai.com/api/docs/guides/your-data#v1responses)
for the provider-side storage behavior. The local retention and publication
boundary remains this application's responsibility.

## Gateway action receipts

The gateway exposes `POST /actions` and `GET /actions/:id` to Protein. A request
contains the Protein action ID in both the body and `Idempotency-Key` header.
The gateway canonicalizes and hashes the full receiver request.

- The action record is persisted as in progress before provider work starts.
- The same action ID and request hash joins in-flight work or returns the
  completed receipt.
- The same action ID with different content is a conflict.
- A continuation is tied to one loop ID, turn number, and the previous
  `call_id`.
- A completed receipt contains the provider response ID, returned model,
  normalized usage, validated function call, request IDs, attempt records,
  prompt and tool-schema versions and hashes, and trace references.

This makes delivery from Protein to the gateway reconcilable after a completed
local receipt. It does not make the upstream provider call exactly once.

## Provider failures and ambiguity

The raw client uses bounded HTTP timeouts and bounded retries for transport and
retryable provider failures. Non-retryable authentication, request, and quota
failures terminate the turn. A Responses object whose status is `incomplete`
or failed is not treated as a valid function decision. Returned usage and
request/attempt metadata are retained even when the response cannot be used.

The live runner defaults to one provider attempt per model action. Raising
`SWARM_MODEL_MAX_ATTEMPTS` enables bounded retries, but it does not make them
safe from duplicated upstream work.

A network failure after request dispatch can occur before the gateway receives
and persists a Responses ID. OpenAI does not document the Responses POST as
idempotent, and `X-Client-Request-Id` is a debugging correlation field rather
than a deduplication key. The gateway therefore marks transport failures
conservatively as ambiguous. Retrying may create another provider response and
may consume tokens twice. Evidence must report attempts, retries, and ambiguous
provider attempts; a successful local action receipt must not erase that cost.

Protein's existing external-effect boundary still applies. See
[the runtime contract](../../../RUNTIME.md) and
[the crash evidence](../../../PROOFS.md).

## Usage and evidence

Every provider response that returns usage, including an incomplete or failed
response, normalizes these counters:

- input, output, and total tokens;
- cached input and cache-write tokens when returned;
- reasoning tokens when returned.

Provider requests, model turns, tool calls, sandbox work, evaluator calls,
retries, ambiguous attempts, and wall time remain separate measures. The pilot
must not collapse them into a single unexplained credit score.

The audit record may contain:

- Protein action, experiment, cell, generation, loop, and turn identifiers;
- prompt and tool-schema versions and hashes;
- provider response ID, `x-request-id`, and client request ID;
- returned model, status, latency, attempt state, and normalized usage;
- tool name, hashed `call_id`, argument hash and byte length;
- terminal outcome and references to separately stored evidence.

The public timeline, service snapshot, and report must not contain:

- `OPENAI_API_KEY`, Authorization headers, environment values, or other
  credentials;
- raw prompts, candidate source, function arguments, or tool outputs;
- hidden case names, inputs, expected values, or per-case failures;
- raw reasoning or encrypted reasoning content;
- unbounded provider error bodies or stack traces.

Public evidence uses bounded summaries and hashes. Raw gateway state is not a
public report artifact; if retained, its location, access controls, and
retention policy must be recorded. Offline tests use a fake `fetch` and make no
live OpenAI calls.

## Configuration

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Required secret used only for Authorization. |
| `OPENAI_MODEL` | Requested model identifier. |
| `OPENAI_BASE_URL` | Responses-compatible API base URL. |
| `OPENAI_REASONING_EFFORT` | Requested reasoning effort. |
| `SWARM_MODEL_MAX_OUTPUT_TOKENS` | Per-response output ceiling. |
| `SWARM_MODEL_TIMEOUT_MS` | Per-provider-request timeout. |
| `SWARM_MODEL_MAX_ATTEMPTS` | Provider attempts per action; defaults to one in the live gateway. |
| `SWARM_MAX_MODEL_TURNS` | Application turn limit per cell and generation. |
| `SWARM_MAX_TOOL_CALLS` | Non-terminal tool limit per cell and generation. |

The run manifest must record the non-secret values, prompt and tool-schema
hashes, requested and returned model identifiers, retry policy, provider usage,
and any ambiguous attempts. The credential itself must never be recorded.
