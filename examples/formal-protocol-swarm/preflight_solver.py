#!/usr/bin/env python3
import json, pathlib, sys, time
from z3 import And, Int, Or, Solver, sat

SUITE=json.loads((pathlib.Path(__file__).parent/"cube-preflight.json").read_text())
def patched_edges(case,patch):return [edge for edge in case["edges"] if edge["label"] not in patch.get("disable",[])]
def path_check(case,patch,target_kind):
    nodes=case["nodes"];index={name:i for i,name in enumerate(nodes)};steps=len(nodes);state=[Int(f"q_{case['id']}_{patch['id']}_{target_kind}_{i}") for i in range(steps+1)];solver=Solver();solver.add(state[0]==index[case["initial"]]);edges=patched_edges(case,patch)
    for i in range(steps):solver.add(Or(state[i+1]==state[i],*[And(state[i]==index[e["from"]],state[i+1]==index[e["to"]]) for e in edges]))
    targets=case["bad"] if target_kind=="bad" else case["goals"];solver.add(Or(*[state[-1]==index[x] for x in targets]));result=solver.check();return{"reachable":result==sat,"trace":None if result!=sat else [nodes[solver.model().eval(x).as_long()] for x in state]}
def evaluate(case,patch):
    bad=path_check(case,patch,"bad");goal=path_check(case,patch,"goal");return{"mutationId":case["id"],"patchId":patch["id"],"accepted":not bad["reachable"] and goal["reachable"],"badReachable":bad["reachable"],"goalReachable":goal["reachable"],"counterexample":bad["trace"]}
started=time.perf_counter();evaluations=[]
for case in SUITE["mutations"]:
    for patch in case["patches"]:evaluations.append(evaluate(case,patch))
accepted=[x for x in evaluations if x["accepted"]];result={"suiteId":SUITE["id"],"solver":"Z3 finite transition encoding","durationMs":round((time.perf_counter()-started)*1000,3),"mutations":len(SUITE["mutations"]),"evaluations":len(evaluations),"acceptedRepairs":accepted,"complete":len({x["mutationId"] for x in accepted})==len(SUITE["mutations"])}
json.dump(result,sys.stdout,separators=(",",":"))
