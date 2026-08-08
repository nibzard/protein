# RUNTIME — the Protein contract

The base-class surface a Protein agent implements, the DNA schema convention, and the alarm re-arm rule. This is the spec for the first implementation. Every API referenced is verified to exist on celld (see [`CLAUDE.md`](./CLAUDE.md) constraints).

## Mental model

```
                ┌─────────────────────────── a celld cell (Durable Object) ───────────────────────────┐
                │                                                                              │
  HTTP / WS ──► │  fetch() / webSocketMessage()  ──►  express(goal)                                │
                │        persist intent to DNA            arm alarm  ──►  (cell hibernates)          │
                │                                                                              │
   alarm()  ──► │  ensureSchema() → recall() → step() → translate() [fetch LLM] → persist DNA       │
                │     └─ if continue: setAlarm(now + N)   (re-arm AFTER durable writes)              │
                │     └─ else:        clear goal, onComplete()                                       │
                │                                                                              │
                │   DNA = ctx.storage.sql (private SQLite, LTX-replicated to S3)                     │
                └────────────────────────────────────────────────────────────────────────────────────┘
```

## Types

```ts
// A unit of work the cell expresses a protein for.
export type Goal = {
  id: string;            // stable; used for idempotency
  kind: string;          // discriminator the subclass switches on
  input: unknown;        // task-specific payload
  startedAt: number;     // epoch ms (passed in by the caller; celld has no Date.now in some contexts)
};

// The result of one bounded step.
export type StepResult =
  | { continue: true;  nextWakeMs: number }   // more to do; re-arm the alarm
  | { continue: false };                       // goal complete; clear it

export interface ChatMsg { role: "system" | "user" | "assistant"; content: string }

export interface TranslateOpts {
  system?: string;
  messages: ChatMsg[];
  model?: string;        // provider-specific; defaults from env
  maxTokens?: number;
}
```

## The base class (sketch)

```ts
import { DurableObject } from "cloudflare:workers";

export abstract class Protein extends DurableObject<Env> {
  // ── DNA: declare your cell's durable schema as SQL DDL. Run idempotently each wake. ──
  protected abstract schema(): readonly string[];

  // ── Express this protein for a goal. Persist intent, arm the first alarm, return. ──
  // Called from fetch()/webSocketMessage(), or from another cell's RPC. Cell hibernates after.
  async express(goal: Goal): Promise<void> {
    await this.ensureSchema();
    await this.dna().put<Goal>("__goal__", goal);
    await this.ctx.storage.setAlarm(goal.startedAt);   // fire ASAP
  }

  // ── celld's only timer. Runs ONE bounded step, then re-arms or finalizes. ──
  async alarm(): Promise<void> {
    await this.ensureSchema();
    const goal = await this.dna().get<Goal>("__goal__");
    if (!goal) return;                                  // nothing active

    const result = await this.step(goal);              // subclass: recall → ≤1 translate() → persist

    if (result.continue) {
      // RE-ARM ONLY AFTER durable writes have returned (see "re-arm rule" below).
      await this.ctx.storage.setAlarm(Date.now() + result.nextWakeMs);
    } else {
      await this.dna().delete("__goal__");
      await this.onComplete(goal);
    }
  }

  // ── Implement ONE bounded step. ──
  // Load prior state from DNA, call this.translate() at most once, write results back.
  // MUST be safe to re-run (idempotent) for the same goal/step, because a crash can replay it.
  protected abstract step(goal: Goal): Promise<StepResult>;

  // ── Model access = outbound fetch to ANY provider. There is NO env.AI on celld. ──
  // Subclass picks Anthropic/OpenAI/local. Keep it one provider-agnostic shape.
  protected abstract translate(opts: TranslateOpts): Promise<string>;

  // Optional hook when a goal finishes.
  protected async onComplete(_goal: Goal): Promise<void> {}

  // ── Provided helpers ──
  protected dna(): ProteinDna { /* thin wrapper over this.ctx.storage + this.ctx.storage.sql */ }
  protected async ensureSchema(): Promise<void> { /* run schema() with IF NOT EXISTS, once per instance */ }
}
```

## DNA schema convention

DNA is the cell's private SQLite, addressed through `this.dna()`:

- **Key/value** for small singletons (active goal, counters, last-run pointer): `dna().put/get/delete`.
- **Tables** for append-mostly records (messages, events, artifacts-metadata): `this.sql\`...\`` / `dna().sql.exec`.
- Reserve the `__*` key prefix for Protein internals (`__goal__`, `__schema_v__`).

Conventional tables an agent usually declares:

```sql
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS events   (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload TEXT, ts INTEGER);
```

> **No blobs in the cell.** celld does not expose R2/blob storage to Worker code (R2 bindings load but every method throws). Keep artifacts as *metadata + a hash* in SQLite; route the bytes to your own object store from outside the cell. Screenshots/PDFs do not belong in DNA.

## The re-arm rule (critical)

A crash between writing step state and re-arming must not lose progress, and a replay must not duplicate side effects. Therefore:

1. Do **all durable writes first** (DNA `put`/`sql.exec`), and let them return.
2. **Then** call `setAlarm(now + N)` to schedule the next wake.
3. Make `step()` **idempotent** for a given `(goal.id, step)` so a replay is harmless — e.g., key rows by a monotonic step counter and `INSERT OR IGNORE`.

> Open question (see [`QUESTIONS.md`](./QUESTIONS.md)): a Worker cannot *observe* when celld's LTX replication to S3 actually completes. The conservative rule above relies on celld's replication being prompt; we still need to measure the durability window under failure and decide whether steps need explicit idempotency keys. Until measured, assume any step can be replayed.

## Inbound interaction

- **HTTP one-shot turn:** `fetch()` reads JSON, calls `express()`, returns ack.
- **Live channel:** upgrade to a hibernatable WebSocket — `WebSocketPair` + `this.ctx.acceptWebSocket(server)`, handle inbound frames in `webSocketMessage(ws, msg)`, push updates via `this.ctx.getWebSockets()`.
- **Outbound:** `fetch()` and `new WebSocket(url)` (e.g., to a remote browser over CDP) are fully supported.

> Note: `setWebSocketAutoResponse` / `WebSocketRequestResponsePair` are **absent** on celld (tracked gap, issue #123) — the one thing that stops the Cloudflare Agents SDK porting as-is. Protein does not use them; keepalive/protocol ping-pong is the agent's responsibility.

## Minimal example agent

```ts
import { Protein, type Goal, type StepResult } from "protein";

export class Summarizer extends Protein {
  protected schema() {
    return [
      `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, ts INTEGER)`,
    ];
  }

  protected async step(goal: Goal & { input: { url: string } }): Promise<StepResult> {
    const page = await (await fetch(goal.input.url)).text();           // outbound fetch
    const summary = await this.translate({                             // ≤1 LLM call
      system: "Summarize the page in 5 bullets.",
      messages: [{ role: "user", content: page.slice(0, 20000) }],
    });
    await this.dna().sql.exec(
      `INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)`,
      "assistant", summary, goal.startedAt,
    );
    return { continue: false };                                        // one-shot
  }

  protected async translate(opts) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-5",   // use a current concrete id
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system,
        messages: opts.messages,
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text ?? "";
  }
}
```

Worker entry (routes `/a/:id` to the named cell) is identical to the celld pattern in [`CLAUDE.md`](./CLAUDE.md).

## Out of scope for v1

- Multi-cell orchestration (planner/worker) — supported by the model (cells address cells by name) but not abstracted yet.
- Fleet primitives (concurrency/fairness/rate-limits) — deferred; see [`QUESTIONS.md`](./QUESTIONS.md).
- A portable backend interface beyond celld — designed for, not yet implemented.
