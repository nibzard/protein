import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { taskById } from "./maintenance-tasks.mjs";
import { evaluateSource } from "./maintenance-sandbox.mjs";

const port=Number(process.env.MAINTENANCE_EXECUTOR_PORT ?? 19200);
const maxOutputTokens=Number(process.env.MAINTENANCE_MAX_OUTPUT_TOKENS ?? 1400);
const root=resolve(process.env.MAINTENANCE_RUN_DIR ?? ".protein/repo-maintenance/live");
const statePath=join(root,"executor-state.json"); const artifactDir=join(root,"artifacts");
await mkdir(artifactDir,{recursive:true});
let state=await load(); let requests=0;
const server=createServer(async(req,res)=>{try{
  if(req.method==="GET"&&req.url==="/stats") return json(res,200,stats());
  if(req.method==="GET"&&req.url?.startsWith("/jobs/")){const key=decodeURIComponent(req.url.slice(6)); return state.jobs[key]?json(res,200,state.jobs[key]):json(res,404,{error:"not_found"});}
  if(req.method!=="POST"||req.url!=="/jobs") return json(res,404,{error:"not_found"});
  const key=req.headers["idempotency-key"]; if(typeof key!=="string") return json(res,400,{error:"missing_idempotency_key"});
  requests++; if(state.jobs[key]) return json(res,200,state.jobs[key]);
  const body=await bodyJson(req); const spec=JSON.parse(String(body.task));
  const result=await execute(spec,body.agent,key); state.jobs[key]=result; await persist(); return json(res,200,result);
}catch(error){return json(res,500,{error:String(error),stack:String(error?.stack??"").slice(0,1000)})}});
server.listen(port,"127.0.0.1",()=>console.log(`maintenance executor http://127.0.0.1:${port}`));

async function execute(spec,agent,key){
  const task=taskById(spec.taskId); const started=performance.now();
  if(spec.phase==="review"){
    const prompt=`Review this proposed fix for ${task.file}. Issue: ${task.issue}\nSource:\n${spec.source}\nPublic evidence:${JSON.stringify(spec.publicEvidence)}\nIdentify concrete correctness risks, especially edge cases. Submit a concise verdict.`;
    const call=await responseCall(prompt,[tool("submit_review","Submit peer review",{verdict:{type:"string",enum:["approve","request_changes"]},findings:{type:"array",items:{type:"string"},maxItems:6},recommendation:{type:"string",maxLength:800}},["verdict","findings","recommendation"])]);
    const review=call.arguments; return complete({phase:"review",taskId:task.id,agent,review,usage:call.usage,provider:call.provider,durationMs:ms(started)});
  }
  const prior=spec.source ?? task.source; const review=spec.review ?? null;
  const prompt=`You maintain ${task.file}. Fix this issue: ${task.issue}\nCurrent source is a complete JavaScript function expression:\n${prior}\n${review?`Peer review: ${JSON.stringify(review)}`:""}\nReturn the complete replacement function expression. Keep it dependency-free and deterministic.`;
  const call=await responseCall(prompt,[tool("submit_patch","Submit a complete replacement",{source:{type:"string",maxLength:12000},summary:{type:"string",maxLength:500}},["source","summary"])]);
  const evidence=await evaluateSource(task,call.arguments.source,false);
  const sha=createHash("sha256").update(call.arguments.source).digest("hex"); const artifactId=`sha256:${sha}`;
  await writeFile(join(artifactDir,`${sha}.js`),call.arguments.source);
  return complete({phase:spec.phase,taskId:task.id,file:task.file,agent,artifactId,source:call.arguments.source,summary:call.arguments.summary,publicEvidence:evidence,usage:call.usage,provider:call.provider,durationMs:ms(started)});
}
function complete(value){return {jobId:randomUUID(),status:"completed",tests:{status:value.publicEvidence?.pass===false?"failed":"passed",command:"isolated public cases"},summary:`${value.phase} ${value.taskId} by ${value.agent}`,...value};}
async function responseCall(prompt,tools){const response=await fetch(`${process.env.OPENAI_BASE_URL??"https://api.openai.com/v1"}/responses`,{method:"POST",headers:{authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify({model:process.env.OPENAI_MODEL??"gpt-5.6-luna",reasoning:{effort:process.env.OPENAI_REASONING_EFFORT??"low"},input:[{role:"user",content:prompt}],tools,tool_choice:"required",parallel_tool_calls:false,max_tool_calls:1,max_output_tokens:maxOutputTokens,store:false})}); const raw=await response.json(); if(!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(raw).slice(0,600)}`); const item=raw.output?.find(x=>x.type==="function_call"); if(!item) throw new Error("model did not call a function"); return {arguments:JSON.parse(item.arguments),usage:raw.usage??{},provider:{responseId:raw.id,model:raw.model}};}
function tool(name,description,properties,required){return {type:"function",name,description,strict:true,parameters:{type:"object",properties,required,additionalProperties:false}};}
function stats(){const jobs=Object.values(state.jobs);return {requests,jobs:jobs.length,providerCalls:jobs.length,phases:Object.fromEntries(["implement","review","revise"].map(p=>[p,jobs.filter(j=>j.phase===p).length])),tokens:jobs.reduce((n,j)=>n+(j.usage?.total_tokens??0),0),maxOutputTokensPerCall:maxOutputTokens,model:process.env.OPENAI_MODEL??"gpt-5.6-luna"};}
async function load(){try{return JSON.parse(await readFile(statePath,"utf8"))}catch{return {schemaVersion:1,jobs:{}}}} async function persist(){await writeFile(statePath,JSON.stringify(state,null,2));}
async function bodyJson(req){const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString("utf8"));} function json(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{"content-type":"application/json","content-length":Buffer.byteLength(body)});res.end(body);} function ms(t){return Number((performance.now()-t).toFixed(2));}
