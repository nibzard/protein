import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script=fileURLToPath(new URL("./protocol_solver.py",import.meta.url));
export async function solve(request,{python=process.env.PROTEIN_SMT_PYTHON??fileURLToPath(new URL("../../.protein/tools/z3-venv/bin/python",import.meta.url)),timeoutMs=10_000}={}){
  const child=spawn(python,[script],{stdio:["pipe","pipe","pipe"]});const out=[],err=[];child.stdout.on("data",c=>out.push(c));child.stderr.on("data",c=>err.push(c));child.stdin.end(JSON.stringify(request));const timer=setTimeout(()=>child.kill("SIGKILL"),timeoutMs);const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)});clearTimeout(timer);if(code!==0)throw new Error(`SMT capability failed: ${Buffer.concat(err).toString("utf8").slice(0,1000)}`);return JSON.parse(Buffer.concat(out).toString("utf8"));
}
