import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { root } from "./celld-proof-support.mjs";

const pairs=bounded(process.env.MAINTENANCE_COMPARISON_PAIRS,3,1,10);
const comparisonId=`maintenance-compare-${new Date().toISOString().replace(/[-:.TZ]/g,"")}-${process.pid}`;
const output=resolve(process.env.MAINTENANCE_COMPARISON_ROOT??join(root,".protein/repo-maintenance/comparisons"),comparisonId);
await mkdir(output,{recursive:true});
const trials=[];
for(let trial=1;trial<=pairs;trial++){
  const order=trial%2===1?["peer","isolated"]:["isolated","peer"];
  const arms={};
  for(const condition of order){
    const armRoot=join(output,`trial-${trial}-${condition}`); await mkdir(armRoot,{recursive:true});
    const result=await runArm({condition,trial,armRoot}); arms[condition]=result;
  }
  trials.push({trial,order,arms,paired:pairedMetrics(arms.peer,arms.isolated)});
  await writeFile(join(output,"comparison.partial.json"),JSON.stringify({comparisonId,trials},null,2));
}
const valid=trials.every(({arms})=>arms.peer.budget.providerCalls===12&&arms.isolated.budget.providerCalls===12&&arms.peer.budget.maximumOutputTokens===arms.isolated.budget.maximumOutputTokens);
const peer=aggregate(trials.map(x=>x.arms.peer)); const isolated=aggregate(trials.map(x=>x.arms.isolated));
const deltas=trials.map(x=>x.paired);
const conclusion=conclude(valid,deltas,peer,isolated);
const comparison={schemaVersion:1,comparisonId,status:valid?"complete":"invalid-budget",evidenceLevel:"paired-celld-repository-maintenance-experiment",claimBoundary:"Three paired 2x2 pilots compare peer review with self-review under identical call and maximum-output-token budgets. This is a small workload, not a general swarm-effectiveness claim.",design:{pairs,conditions:{peer:"clockwise neighboring cell reviews the artifact",isolated:"the author cell reviews its own artifact"},model:"gpt-5.6-luna",callsPerCell:3,cellsPerArm:4,maxOutputTokensPerCall:1400,conditionOrder:"alternating"},aggregate:{peer,isolated},pairedDeltas:deltas,trials,conclusion};
await writeFile(join(output,"comparison.json"),JSON.stringify(comparison,null,2));
await writeFile(join(output,"RESULT.md"),markdown(comparison));
console.log(JSON.stringify({output,status:comparison.status,aggregate:comparison.aggregate,pairedDeltas:deltas,conclusion},null,2));
if(!valid)process.exitCode=1;

async function runArm({condition,trial,armRoot}){
  const child=spawn(process.execPath,[join(root,"scripts/repo-maintenance-run.mjs")],{cwd:root,env:{...process.env,OPENAI_MODEL:"gpt-5.6-luna",MAINTENANCE_CONDITION:condition,MAINTENANCE_COMPARISON_ID:comparisonId,MAINTENANCE_TRIAL_INDEX:String(trial),MAINTENANCE_RUN_ROOT:armRoot},stdio:["ignore","pipe","pipe"]});
  let log=""; child.stdout.on("data",c=>log+=c);child.stderr.on("data",c=>log+=c); const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)}); await writeFile(join(armRoot,"runner.log"),log);
  const entries=await readdir(armRoot,{withFileTypes:true}); const run=entries.find(x=>x.isDirectory()); if(!run)throw new Error(`No run directory for trial ${trial} ${condition}; exit ${code}`);
  const summary=JSON.parse(await readFile(join(armRoot,run.name,"summary.json"),"utf8")); return {...summary,runnerExitCode:code,evidencePath:join(armRoot,run.name,"summary.json")};
}
function pairedMetrics(peer,isolated){return {trial:peer.trialIndex,finalCasesPassed:peer.metrics.finalCasesPassed-isolated.metrics.finalCasesPassed,hiddenTasksPassed:peer.metrics.hiddenPassed-isolated.metrics.hiddenPassed,improvementCases:(peer.metrics.finalCasesPassed-peer.metrics.initialCasesPassed)-(isolated.metrics.finalCasesPassed-isolated.metrics.initialCasesPassed),tokens:peer.metrics.totalTokens-isolated.metrics.totalTokens,restartRecoveryMs:Number((peer.metrics.restartRecoveryMs-isolated.metrics.restartRecoveryMs).toFixed(2))};}
function aggregate(arms){return {arms:arms.length,passedArms:arms.filter(x=>x.status==="passed").length,providerCalls:sum(arms,x=>x.metrics.providerCalls),totalTokens:sum(arms,x=>x.metrics.totalTokens),initialCasesPassed:sum(arms,x=>x.metrics.initialCasesPassed),finalCasesPassed:sum(arms,x=>x.metrics.finalCasesPassed),hiddenTasksPassed:sum(arms,x=>x.metrics.hiddenPassed),requestedChanges:sum(arms,x=>x.metrics.requestedChanges),medianTokens:median(arms.map(x=>x.metrics.totalTokens)),medianRestartRecoveryMs:median(arms.map(x=>x.metrics.restartRecoveryMs))};}
function conclude(valid,deltas,peer,isolated){if(!valid)return "The comparison is invalid because the enforced model-call or output-token budgets did not match.";const quality=deltas.map(x=>x.finalCasesPassed);if(quality.every(x=>x===0))return `No peer-review quality advantage was observed: both conditions passed ${peer.finalCasesPassed} of ${peer.arms*28} hidden-plus-public cases across ${peer.arms} arms. Peer review used ${peer.totalTokens-isolated.totalTokens} more actual tokens within the same maximum budget.`;const wins=quality.filter(x=>x>0).length,losses=quality.filter(x=>x<0).length;return `Peer review won ${wins} paired trials, lost ${losses}, and tied ${quality.length-wins-losses}; the sample is too small for a general claim.`;}
function markdown(c){return `# Equal-budget maintenance comparison\n\n${c.conclusion}\n\n## Design\n\nThree paired trials used the same four tasks, Luna model, public and hidden evaluators, three Responses calls per cell, and a 1,400-token output cap per call. Peer arms used clockwise neighbor review; isolated arms used self-review. Condition order alternated.\n\n| Condition | Arms passed | Provider calls | Actual tokens | Final cases | Hidden tasks | Requested changes |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| Peer review | ${c.aggregate.peer.passedArms} / ${c.aggregate.peer.arms} | ${c.aggregate.peer.providerCalls} | ${c.aggregate.peer.totalTokens} | ${c.aggregate.peer.finalCasesPassed} / ${c.aggregate.peer.arms*28} | ${c.aggregate.peer.hiddenTasksPassed} / ${c.aggregate.peer.arms*4} | ${c.aggregate.peer.requestedChanges} |\n| Self-review | ${c.aggregate.isolated.passedArms} / ${c.aggregate.isolated.arms} | ${c.aggregate.isolated.providerCalls} | ${c.aggregate.isolated.totalTokens} | ${c.aggregate.isolated.finalCasesPassed} / ${c.aggregate.isolated.arms*28} | ${c.aggregate.isolated.hiddenTasksPassed} / ${c.aggregate.isolated.arms*4} | ${c.aggregate.isolated.requestedChanges} |\n\n## Interpretation\n\nThis comparison isolates reviewer identity, not all possible benefits of a swarm. Calls and maximum output budgets match; actual tokens are measured rather than forced. Trials share a small synthetic repository workload, so the result should guide the next experiment rather than support a broad claim.\n\nMachine-readable evidence: \`comparison.json\`. Each arm links to its own celld summary and durable artifacts.\n`;}
function bounded(value,fallback,min,max){const n=Number(value??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`value must be integer ${min}..${max}`);return n;} function sum(values,pick){return values.reduce((n,x)=>n+pick(x),0);} function median(values){const x=[...values].sort((a,b)=>a-b);return x[Math.floor(x.length/2)];}
