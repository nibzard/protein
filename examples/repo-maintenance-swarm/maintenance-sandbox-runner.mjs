import vm from "node:vm";

const input = JSON.parse(await readStdin());
const fn = vm.runInNewContext(`(${input.source})`, Object.create(null), { timeout: 250 });
if (typeof fn !== "function") throw new Error("Source must evaluate to a function");
const results = [];
for (const args of input.cases) {
  try { results.push({ ok: true, value: await Promise.race([Promise.resolve(fn(...structuredClone(args))), timeout(500)]) }); }
  catch (error) { results.push({ ok: false, error: String(error).slice(0, 300) }); }
}
process.stdout.write(JSON.stringify({ results }));

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error("invocation timeout")), ms)); }
async function readStdin() { const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
