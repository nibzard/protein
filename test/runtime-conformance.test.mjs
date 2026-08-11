import { describe, expect, it } from "vitest";
import { projectRuntimeTrace } from "../examples/formal-protocol-swarm/runtime-conformance.mjs";

describe("runtime protocol projection",()=>{
  it("projects a recovered receipt through reconciliation",()=>{
    expect(projectRuntimeTrace({checkpoint:"executor.accepted",safety:"reconcilable",actionStatus:"delivered",uncertainReceipt:true,executorRequests:1,executorCreates:1,reconciliations:2})).toMatchObject({transitions:["timeout_applied","reconcile_applied"],states:[{phase:"pending",effects:0},{phase:"ambiguous",effects:1},{phase:"committed",effects:1,reconciled:true}]});
  });
  it("projects an unsafe resumed dispatch as direct ambiguous retry",()=>{
    expect(projectRuntimeTrace({checkpoint:"executor.accepted",safety:"unsafe",actionStatus:"delivered",uncertainReceipt:true,executorRequests:2,executorCreates:1,reconciliations:0})).toMatchObject({transitions:["timeout_applied","retry_ambiguous"]});
  });
  it("projects the seeded duplicate effect",()=>{
    expect(projectRuntimeTrace({checkpoint:"seed",safety:"unsafe",actionStatus:"delivered",uncertainReceipt:true,seededDirectRetry:true,executorRequests:2,executorCreates:1,reconciliations:0}).states.at(-1)).toMatchObject({phase:"committed",effects:2});
  });
});
