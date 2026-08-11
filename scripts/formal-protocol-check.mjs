import { solve } from "../examples/formal-protocol-swarm/solver.mjs";

const buggy=await solve({command:"counterexamples",patch:"buggy",depth:2});
if(!buggy.counterexamples.some(x=>x.property==="at_most_once"))throw new Error("expected at-most-once counterexample");
const lemmas=["effect_at_most_once","committed_has_receipt","receipt_means_committed","committed_has_effect","ambiguous_has_no_receipt","ambiguous_is_unreconciled","pending_is_clean","phase_shape"];
const repaired=await solve({command:"check",patch:"require_reconciliation",lemmas});
if(!repaired.accepted)throw new Error("repaired protocol did not prove");
const mutations={buggy:await solve({command:"check",patch:"buggy",lemmas}),retry_without_effect:await solve({command:"check",patch:"retry_without_effect",lemmas}),payload_guard:await solve({command:"check",patch:"payload_guard",lemmas})};
if(Object.values(mutations).some(x=>x.accepted))throw new Error("an invalid mutation proved");
console.log(JSON.stringify({status:"passed",solver:repaired.solver,counterexample:buggy.counterexamples[0],obligations:repaired.obligations.length,mutationsRejected:Object.keys(mutations)},null,2));
