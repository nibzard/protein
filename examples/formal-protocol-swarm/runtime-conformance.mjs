import spec from "./protocol-spec.json" with { type: "json" };
import { solve } from "./solver.mjs";

export async function checkRuntimeConformance(observation){
  const trace=projectRuntimeTrace(observation);
  const formal=await solve({command:"validate_trace",patch:"require_reconciliation",trace});
  const forbiddenDirectRetry=observation.seededDirectRetry===true||(observation.uncertainReceipt===true&&(observation.executorRequests>1||(observation.actionStatus==="delivered"&&observation.reconciliations<1)));
  return{specId:spec.id,scope:spec.scope,accepted:formal.accepted&&!forbiddenDirectRetry,forbiddenDirectRetry,trace,formal};
}

export function projectRuntimeTrace(observation){
  const pending={phase:"pending",effects:0,receipt:false,reconciled:false};
  const states=[pending],transitions=[];
  if(observation.uncertainReceipt===true){
    const effects=observation.executorCreates>0?1:0;
    states.push({phase:"ambiguous",effects,receipt:false,reconciled:false});
    transitions.push(effects===1?"timeout_applied":"timeout_not_applied");
    if(observation.seededDirectRetry===true){states.push({phase:"committed",effects:effects+1,receipt:true,reconciled:false});transitions.push("retry_ambiguous");}
    else if(observation.actionStatus==="delivered"){
      if(observation.reconciliations<1){states.push({phase:"committed",effects:Math.max(1,effects),receipt:true,reconciled:false});transitions.push("retry_ambiguous");}
      else if(effects===1){states.push({phase:"committed",effects:1,receipt:true,reconciled:true});transitions.push("reconcile_applied");}
      else{states.push({phase:"pending",effects:0,receipt:false,reconciled:true});transitions.push("reconcile_not_applied");}
    }
  }else if(observation.actionStatus==="delivered"){
    states.push({phase:"committed",effects:1,receipt:true,reconciled:false});transitions.push("dispatch_ok");
  }
  return{states,transitions,source:{checkpoint:observation.checkpoint,safety:observation.safety,actionStatus:observation.actionStatus,executorRequests:observation.executorRequests,executorCreates:observation.executorCreates,reconciliations:observation.reconciliations}};
}
