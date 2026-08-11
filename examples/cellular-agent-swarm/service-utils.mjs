import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export async function createStateStore(path, defaults) {
  const state = existsSync(path)
    ? { ...structuredClone(defaults), ...JSON.parse(await readFile(path, "utf8")) }
    : structuredClone(defaults);
  let queue = Promise.resolve();
  return {
    state,
    persist() {
      queue = queue.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(state, null, 2));
        await rename(temporaryPath, path);
      });
      return queue;
    },
    flush() {
      return queue;
    },
  };
}

export function createRecorder(path, base = {}) {
  let queue = Promise.resolve();
  return {
    record(kind, data = {}) {
      queue = queue.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify({
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          ...base,
          ...data,
          kind,
        })}\n`);
      });
      return queue;
    },
    flush() {
      return queue;
    },
  };
}

export async function bodyJson(request, maximumBytes = 2_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function validateReceiverRequest(request, body) {
  const object = objectValue(body, "receiver request");
  const actionId = stringValue(object.actionId, "actionId");
  const headerId = request.headers["idempotency-key"];
  if (headerId !== undefined && headerId !== actionId) {
    throw new RequestError(400, "idempotency_key_mismatch", "Idempotency-Key header does not match actionId");
  }
  const agent = stringValue(object.agent, "agent");
  const kind = stringValue(object.kind, "kind");
  const payload = objectValue(object.payload, "payload");
  return {
    actionId,
    agent,
    kind,
    payload,
    requestHash: sha256(canonicalJson(object)),
  };
}

export function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "invalid_request", `${label} must be an object`);
  }
  return value;
}

export function stringValue(value, label, maximumLength = 100_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new RequestError(400, "invalid_request", `${label} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return value;
}

export function numberValue(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestError(400, "invalid_request", `${label} must be a finite number`);
  }
  return value;
}

export function integerValue(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RequestError(400, "invalid_request", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

export function publicError(error) {
  if (error instanceof RequestError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: "internal_error", message: String(error) } };
}

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}
