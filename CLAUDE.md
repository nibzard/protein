# CLAUDE.md — working on Protein

`IDEA.md` is the vision; `RUNTIME.md` is the implementation contract; `NOTES.md` is the technical reference and landscape.

Build Protein as a celld-native agent framework: one agent per cell, alarm-paced bounded steps, DNA in private SQLite, LLM via plain outbound fetch, no platform or model lock-in.

Aim for zero dependencies in the runtime core; allow only deliberate high-value exceptions, and prefer native celld/Workers platform capabilities over packages.

Keep domain shapes small and explicit: `Goal`, `step()`, `translate()`, DNA. Treat code size as pressure — prefer deleting or moving behavior out of the core before growing it.

On every code change, revisit whether the change leaks a celld assumption outside the portable interface (see "Stay portable" below).

## celld is the foundation — know its real constraints

These were verified against celld's runtime source (`crates/celld/js/harness.js`), `docs/cloudflare-compat.md`, `docs/limitations.md`, and the shipping examples. They are not guesses. Violating one is the most common way to write code that silently fails on celld.

**Runtime**
- V8 Workers only. **No Node.** `node:fs` fails (ENOENT); `node:child_process`, `node:http(s)`, `node:net`, `node:tls`, `node:os`, `node:dns` are **silent no-op stubs** — code that imports them runs without error and does nothing. This is the #1 porting trap: grep any dependency for `node:*` before trusting it.
- `cloudflare:workers` exports `DurableObject`, `RpcTarget`, `WorkerEntrypoint` — these work. celld constructs `new cls(state, env)`, so `this.ctx` is the `DurableObjectState` and `this.env` the bindings.
- `ctx.waitUntil` works.

**State (DNA)**
- A cell's storage is its own SQLite via `ctx.storage.sql.exec(sql, ...params)` — returns an iterable cursor of column-keyed row objects. This is reliably present (verified in source) even though the compat doc barely mentions it.
- The key/value API (`ctx.storage.get/put/delete/list`) also works and is the proven fallback used by celld's own examples.

**Timers**
- **Alarms are the only timer.** `ctx.storage.setAlarm / getAlarm / deleteAlarm` + the `alarm()` handler. There is **no `scheduled`/cron handler**.
- `setInterval` **throws**. Never use it. Never rely on a long-lived in-memory loop — the cell hibernates between alarms.
- Workers/alarms are short-lived, CPU- and wall-clock-bounded. Pace multi-step work across alarms; one bounded step per wake.

**Networking**
- Outbound `fetch()` works (including streaming response bodies). Use it for LLM calls.
- Outbound `new WebSocket(url)` works (e.g., to a remote browser over CDP). Caveat: an outbound DO WebSocket does **not** survive a cell moving to another node — persist connection intent in DNA and reconnect after reactivation.
- Inbound hibernatable WebSocket works: `ctx.acceptWebSocket(ws, tags)`, `ctx.getWebSockets(tag)`, and the `webSocketMessage` / `webSocketClose` / `webSocketError` handlers. (Verified via the `wsecho` example.)

**What celld does NOT have (do not build on these)**
- **No `env.AI` / Workers AI** (only an experimental `CELLD_AI_URL` adapter — treat as undocumented; call providers by `fetch`).
- **No KV, no D1, no Queues, no Vectorize.** (D1/Queues/Workflows are on the roadmap; KV/R2/Vectorize are "not planned".)
- **No R2 as usable blob storage.** Declaring `r2_buckets` does **not** abort `celld deploy` (unlike KV/D1/Queues/cron triggers, which do) — the binding loads, but **every method throws at runtime**. Keep artifact *metadata* in SQLite; route bytes to your own object store.
- `setWebSocketAutoResponse` and `WebSocketRequestResponsePair` are **absent** (tracked gap, issue #123) — this is the one thing that stops the Cloudflare Agents SDK porting as-is. Protein must not use them.
- `serializeWebSocket` / `webSocketClose` are also absent.
- `BroadcastChannel`, `EventSource`, and `cloudflare:sockets` exist but are inert stubs — useless for cross-cell signaling. Use cell-to-cell RPC or shared DNA instead.
- Minor gaps: `Response.redirect/error()`, the `cache` request option, `ReadableStream.from()`, and several Web Crypto ops (derive/wrap/non-HMAC verify, `DigestStream`) are missing. `SubtleCrypto.digest` (SHA-256 etc.) works.

**Deploy**
- Declare the agent as a SQLite-backed Durable Object in `wrangler.jsonc`: `durable_objects.bindings` + a `migrations` entry with `new_sqlite_classes`. Put keys in `vars` (or `celld secret put`).
- Do **not** add `kv_namespaces`, `d1_databases`, `queues`, or cron `[[triggers]]` — each aborts `celld deploy`. `r2_buckets` is the exception that loads then throws at runtime.

## Stay portable

celld is young and bus-factor-1 (see `NOTES.md` risks). **All celld-specific access lives behind one portable interface** (`ProteinDna` in `RUNTIME.md`, and a future `ActorRuntime` for alarm/socket lifecycle). If celld stalls, agents retarget Restate, Rivet, or workerd by swapping the interface implementation — never by rewriting agents. Do not let celld-specific types leak into the `Protein` base class or agent subclasses.

## Conventions

- One cell per agent; name cells by a stable id (`env.AGENT.idFromName(id)`).
- Bounded step = at most one `translate()` (one LLM fetch) plus durable writes, all within one alarm.
- Steps are idempotent: a crash can replay the current step. Key mutable rows by a monotonic step counter and use `INSERT OR IGNORE`.
- Re-arm the alarm only after durable writes have returned (the re-arm rule in `RUNTIME.md`).
- Never reference `env.AI`, KV, R2, D1, Queues, cron, or `node:*` in core code.

## Testing

- Issue-specific regression tests live at `src/**/regressions/<slug>.test.ts`, named for the symptom they pin down. Adopt the convention as regressions arise; do not create empty directories.
- Prefer tests that run a real Protein cell against a real (local) celld over mocks. Mocks of `ctx.storage.sql` and `alarm()` hide the exact failures that matter on celld.

## Parallel agents / git hygiene

When several agents work in this repo, stage changes explicitly. Never run `git add -A` / `git add .`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or commit with `--no-verify`. Stage specific files only.
