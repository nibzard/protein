import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path=resolve(process.env.PROTEIN_CONFORMANCE_REPORT??process.argv[2]??"");
if(path===resolve(""))throw new Error("Pass a conformance report path or PROTEIN_CONFORMANCE_REPORT");
const report=JSON.parse(await readFile(path,"utf8"));
const failures=[];
if(report.summary?.passed!==10||report.summary?.failed!==3||report.summary?.total!==13)failures.push("expected documented 10/13 crash boundary");
if(report.formalConformance?.checkedScenarios!==5||report.formalConformance?.acceptedScenarios!==2)failures.push("expected 2/5 projected non-idempotent traces to conform");
if(report.formalConformance?.seededUnsafeTrace?.accepted!==false)failures.push("seeded unsafe trace was not rejected");
const reconcilable=report.scenarios?.find(x=>x.safety==="reconcilable"&&x.checkpoint==="executor.accepted");if(reconcilable?.conformance?.accepted!==true)failures.push("reconcilable recovery did not conform");
const unsafe=report.scenarios?.filter(x=>x.safety==="unsafe"&&["action.dispatch_started","executor.request_received","executor.accepted"].includes(x.checkpoint));if(unsafe?.length!==3||unsafe.some(x=>x.conformance?.accepted!==false))failures.push("unsafe uncertainty boundary was not rejected consistently");
if(failures.length)throw new Error(failures.join("; "));
console.log(JSON.stringify({status:"passed",report:path,crashBoundary:report.summary,formalConformance:report.formalConformance,interpretation:"Supported idempotent/reconcilable paths pass; known unsafe automatic effects remain outside the production boundary."},null,2));
