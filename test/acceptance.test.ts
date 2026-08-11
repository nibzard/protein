import { describe, expect, it } from "vitest";
import { decideMonotonicAcceptance, type ArtifactEvidence, type VersionedArtifact } from "../src/acceptance";

const parent: VersionedArtifact = { artifactId:"sha256:parent",parentArtifactId:null,producer:"author",kind:"source" };
const candidate: VersionedArtifact = { artifactId:"sha256:child",parentArtifactId:parent.artifactId,producer:"reviser",kind:"source" };
const evidence=(artifactId:string,gate:string,status:"passed"|"failed"):ArtifactEvidence=>({artifactId,gate,status,authority:"isolated-checker",details:null});

describe("monotonic artifact acceptance",()=>{
  it("accepts a child that preserves established evidence and passes new gates",()=>{
    const receipt=decideMonotonicAcceptance({receiptId:"r1",parent,candidate,parentEvidence:[evidence(parent.artifactId,"public","passed")],candidateEvidence:[evidence(candidate.artifactId,"public","passed"),evidence(candidate.artifactId,"hidden","passed")],requiredGates:["hidden"],decidedAt:1});
    expect(receipt).toMatchObject({decision:"accept",retainedArtifactId:candidate.artifactId,failedGates:[]});
  });
  it("retains the parent when a revision regresses established evidence",()=>{
    const receipt=decideMonotonicAcceptance({receiptId:"r2",parent,candidate,parentEvidence:[evidence(parent.artifactId,"public","passed")],candidateEvidence:[evidence(candidate.artifactId,"public","failed"),evidence(candidate.artifactId,"hidden","passed")],requiredGates:["hidden"],decidedAt:2});
    expect(receipt).toMatchObject({decision:"reject",retainedArtifactId:parent.artifactId,failedGates:["public"]});
  });
  it("rejects a candidate with conflicting lineage",()=>{
    const receipt=decideMonotonicAcceptance({receiptId:"r3",parent,candidate:{...candidate,parentArtifactId:"sha256:other"},parentEvidence:[],candidateEvidence:[evidence(candidate.artifactId,"formal-proof","passed")],requiredGates:["formal-proof"],decidedAt:3});
    expect(receipt.decision).toBe("reject");
  });
  it("refuses an acceptance decision with no authoritative gate",()=>{
    expect(()=>decideMonotonicAcceptance({receiptId:"r4",parent,candidate,parentEvidence:[],candidateEvidence:[],requiredGates:[],decidedAt:4})).toThrow("at least one required gate");
  });
});
