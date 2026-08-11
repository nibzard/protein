import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./maintenance-sandbox-runner.mjs", import.meta.url));
export async function runCases(source, cases, timeoutMs = 6_000) {
  const name = `protein-maint-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const child = spawn("docker", ["run","--rm","-i","--name",name,"--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--cpus","1","--pids-limit","64","--user","65534:65534","--tmpfs","/tmp:rw,noexec,nosuid,size=16m","--mount",`type=bind,src=${runner},dst=/runner.mjs,readonly`,process.env.MAINTENANCE_SANDBOX_IMAGE ?? "node:22-alpine","node","/runner.mjs"], { stdio:["pipe","pipe","pipe"] });
  const out=[]; const err=[];
  child.stdout.on("data", c=>out.push(c)); child.stderr.on("data", c=>err.push(c));
  child.stdin.end(JSON.stringify({source,cases}));
  const timer=setTimeout(()=>child.kill("SIGKILL"),timeoutMs);
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)}); clearTimeout(timer);
  if(code!==0) throw new Error(`sandbox failed: ${Buffer.concat(err).toString("utf8").slice(0,500)}`);
  return JSON.parse(Buffer.concat(out).toString("utf8"));
}

export async function evaluateSource(task, source, hidden = false) {
  const cases = hidden ? [...task.publicCases, ...task.hiddenCases] : task.publicCases;
  const expected = hidden ? task.expected : task.expected.slice(0, task.publicCases.length);
  const { results } = await runCases(source, cases);
  const failures=[];
  results.forEach((result,index)=>{ if(!result.ok || JSON.stringify(result.value)!==JSON.stringify(expected[index])) failures.push({index,args:cases[index],expected:expected[index],actual:result.ok?result.value:result.error}); });
  return { pass: failures.length===0, passed: cases.length-failures.length, total: cases.length, failures };
}
