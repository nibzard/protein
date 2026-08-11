import type { JsonObject, JsonValue } from "./types";

export type EvidenceStatus = "passed" | "failed";
export type AcceptanceDecision = "accept" | "reject";

export interface VersionedArtifact extends JsonObject {
  artifactId: string;
  parentArtifactId: string | null;
  producer: string;
  kind: string;
}

export interface ArtifactEvidence extends JsonObject {
  gate: string;
  artifactId: string;
  status: EvidenceStatus;
  authority: string;
  details: JsonValue;
}

export interface AcceptanceReceipt extends JsonObject {
  receiptId: string;
  parentArtifactId: string;
  candidateArtifactId: string;
  decision: AcceptanceDecision;
  retainedArtifactId: string;
  requiredGates: string[];
  preservedGates: string[];
  passedGates: string[];
  failedGates: string[];
  reason: string;
  decidedAt: number;
}

export interface MonotonicAcceptanceInput {
  receiptId: string;
  parent: VersionedArtifact;
  candidate: VersionedArtifact;
  parentEvidence: ArtifactEvidence[];
  candidateEvidence: ArtifactEvidence[];
  requiredGates: string[];
  decidedAt: number;
}

export function decideMonotonicAcceptance(
  input: MonotonicAcceptanceInput,
): AcceptanceReceipt {
  validateArtifact(input.parent, "parent");
  validateArtifact(input.candidate, "candidate");
  if (input.receiptId.length === 0) throw new Error("receiptId is required");
  if (!Number.isFinite(input.decidedAt) || input.decidedAt < 0) {
    throw new Error("decidedAt must be a non-negative finite number");
  }
  const requiredGates = uniqueNonEmpty(input.requiredGates, "required gate");
  if (requiredGates.length === 0) throw new Error("at least one required gate is required");
  const preservedGates = uniqueNonEmpty(
    input.parentEvidence.filter((item) => item.status === "passed").map((item) => item.gate),
    "parent evidence gate",
  );
  validateEvidence(input.parentEvidence, input.parent.artifactId, "parent");
  validateEvidence(input.candidateEvidence, input.candidate.artifactId, "candidate");
  const gates = [...new Set([...requiredGates, ...preservedGates])].sort();
  const passedGates: string[] = [];
  const failedGates: string[] = [];
  for (const gate of gates) {
    const matches = input.candidateEvidence.filter((item) => item.gate === gate);
    if (matches.length === 1 && matches[0]?.status === "passed") passedGates.push(gate);
    else failedGates.push(gate);
  }
  const lineageMatches = input.candidate.parentArtifactId === input.parent.artifactId;
  const decision: AcceptanceDecision = lineageMatches && failedGates.length === 0
    ? "accept"
    : "reject";
  const reason = !lineageMatches
    ? "candidate lineage does not reference the verified parent"
    : failedGates.length > 0
      ? `candidate did not preserve required evidence: ${failedGates.join(", ")}`
      : "candidate preserved parent evidence and passed every required gate";
  return {
    receiptId: input.receiptId,
    parentArtifactId: input.parent.artifactId,
    candidateArtifactId: input.candidate.artifactId,
    decision,
    retainedArtifactId: decision === "accept"
      ? input.candidate.artifactId
      : input.parent.artifactId,
    requiredGates,
    preservedGates,
    passedGates,
    failedGates,
    reason,
    decidedAt: input.decidedAt,
  };
}

function validateArtifact(artifact: VersionedArtifact, label: string): void {
  for (const [field, value] of Object.entries({
    artifactId: artifact.artifactId,
    producer: artifact.producer,
    kind: artifact.kind,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} ${field} is required`);
    }
  }
}

function validateEvidence(
  evidence: ArtifactEvidence[],
  artifactId: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (item.artifactId !== artifactId) {
      throw new Error(`${label} evidence references another artifact`);
    }
    if (item.gate.length === 0 || item.authority.length === 0) {
      throw new Error(`${label} evidence requires gate and authority`);
    }
    if (seen.has(item.gate)) throw new Error(`${label} evidence repeats gate ${item.gate}`);
    seen.add(item.gate);
  }
}

function uniqueNonEmpty(values: string[], label: string): string[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.some((value) => value.length === 0)) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}
