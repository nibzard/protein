import type { JsonValue } from "./types";

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function parseJson<T extends JsonValue>(value: string): T {
  return JSON.parse(value) as T;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }

  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
