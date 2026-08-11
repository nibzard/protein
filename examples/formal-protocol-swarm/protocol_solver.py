#!/usr/bin/env python3
import json, sys, hashlib, pathlib
from z3 import And, Bool, BoolVal, If, Implies, Int, Not, Or, Solver, sat, unsat, get_version_string

SPEC = json.loads((pathlib.Path(__file__).parent / "protocol-spec.json").read_text())
PHASE = {index: value for index, value in enumerate(SPEC["state"]["phase"])}
PATCHES = SPEC["patches"]
LEMMAS = SPEC["lemmas"]
PROPERTIES = SPEC["properties"]

def state(prefix, index=""):
    suffix = f"_{index}" if index != "" else ""
    return {"phase": Int(f"{prefix}_phase{suffix}"), "effects": Int(f"{prefix}_effects{suffix}"), "receipt": Bool(f"{prefix}_receipt{suffix}"), "reconciled": Bool(f"{prefix}_reconciled{suffix}")}

def domain(s): return And(s["phase"] >= 0, s["phase"] <= 2, s["effects"] >= 0, s["effects"] <= 3)
def initial(s): return And(domain(s), s["phase"] == 0, s["effects"] == 0, Not(s["receipt"]), Not(s["reconciled"]))
def same(a,b): return And(*[b[k] == a[k] for k in a])

def transitions(a,b,patch):
    common = [domain(a), domain(b)]
    def t(name, guard, phase, effects, receipt, reconciled):
        return (name, And(*common, guard, b["phase"] == phase, b["effects"] == effects, b["receipt"] == receipt, b["reconciled"] == reconciled))
    values = [
      t("dispatch_ok", a["phase"]==0, 2, a["effects"]+1, True, a["reconciled"]),
      t("timeout_applied", a["phase"]==0, 1, a["effects"]+1, False, False),
      t("timeout_not_applied", a["phase"]==0, 1, a["effects"], False, False),
      t("reconcile_applied", And(a["phase"]==1,a["effects"]==1), 2, a["effects"], True, True),
      t("reconcile_not_applied", And(a["phase"]==1,a["effects"]==0), 0, a["effects"], False, True),
      ("crash_recover", And(*common, same(a,b))),
    ]
    if patch == "require_reconciliation": guard = And(a["phase"]==1,a["reconciled"])
    else: guard = a["phase"]==1
    effects = a["effects"] if patch == "retry_without_effect" else a["effects"]+1
    values.append(t("retry_ambiguous", guard, 2, effects, True, a["reconciled"]))
    return values

def prop(name,s):
    return {
      "at_most_once": s["effects"] <= 1,
      "committed_receipt": Implies(s["phase"]==2,s["receipt"]),
      "receipt_committed": Implies(s["receipt"],s["phase"]==2),
      "committed_effect": Implies(s["phase"]==2,s["effects"]==1),
    }[name]

def lemma(name,s):
    return {
      "effect_at_most_once": s["effects"] <= 1,
      "committed_has_receipt": Implies(s["phase"]==2,s["receipt"]),
      "receipt_means_committed": Implies(s["receipt"],s["phase"]==2),
      "committed_has_effect": Implies(s["phase"]==2,s["effects"]==1),
      "ambiguous_has_no_receipt": Implies(s["phase"]==1,Not(s["receipt"])),
      "ambiguous_is_unreconciled": Implies(s["phase"]==1,Not(s["reconciled"])),
      "pending_is_clean": Implies(s["phase"]==0,And(s["effects"]==0,Not(s["receipt"]))),
      "phase_shape": Or(And(s["phase"]==0,s["effects"]==0,Not(s["receipt"])),And(s["phase"]==1,Or(s["effects"]==0,s["effects"]==1),Not(s["receipt"])),And(s["phase"]==2,s["effects"]==1,s["receipt"])),
    }[name]

def values(model,s):
    return {"phase":PHASE.get(model.eval(s["phase"]).as_long(),"invalid"),"effects":model.eval(s["effects"]).as_long(),"receipt":bool(model.eval(s["receipt"])),"reconciled":bool(model.eval(s["reconciled"]))}

def counterexample(patch, property_name, depth=3):
    states=[state("trace",i) for i in range(depth+1)]
    solver=Solver();solver.add(initial(states[0]));selectors=[]
    for i in range(depth):
      choices=[]
      for name,formula in transitions(states[i],states[i+1],patch):
        marker=Bool(f"step_{i}_{name}");solver.add(marker==formula);choices.append(marker)
      solver.add(Or(*choices));selectors.append(choices)
    solver.add(Not(prop(property_name,states[-1])))
    if solver.check()!=sat:return None
    model=solver.model(); steps=[]
    for i,choices in enumerate(selectors):
      name=next(name for (name,_),marker in zip(transitions(states[i],states[i+1],patch),choices) if bool(model.eval(marker)))
      steps.append(name)
    return {"property":property_name,"depth":depth,"states":[values(model,s) for s in states],"transitions":steps}

def obligation(name, assertions):
    solver=Solver();solver.add(*assertions);result=solver.check();smt=solver.sexpr()+"\n(check-sat)\n"
    return {"name":name,"result":str(result),"sha256":hashlib.sha256(smt.encode()).hexdigest(),"smt2":smt,"counterexample":None if result==unsat else str(solver.model())}

def check(patch, names):
    if patch not in PATCHES: raise ValueError("unknown patch")
    if any(name not in LEMMAS for name in names): raise ValueError("unknown lemma")
    a,b=state("s"),state("n"); inv_a=And(*[lemma(x,a) for x in names]) if names else BoolVal(True);inv_b=And(*[lemma(x,b) for x in names]) if names else BoolVal(True)
    obligations=[obligation("initiation",[initial(a),Not(inv_a)])]
    for transition_name,relation in transitions(a,b,patch):obligations.append(obligation(f"preservation:{transition_name}",[domain(a),inv_a,relation,Not(inv_b)]))
    for property_name in PROPERTIES:obligations.append(obligation(f"safety:{property_name}",[domain(a),inv_a,Not(prop(property_name,a))]))
    retry=dict(transitions(a,b,patch))["retry_ambiguous"]
    obligations.append(obligation("policy:no_direct_ambiguous_retry",[domain(a),a["phase"]==1,Not(a["reconciled"]),retry]))
    accepted=all(x["result"]=="unsat" for x in obligations)
    return {"patch":patch,"lemmas":names,"accepted":accepted,"solver":f"Z3 {get_version_string()}","obligations":obligations}

def validate_trace(patch, trace):
    states=[state("runtime",i) for i in range(len(trace["states"]))]
    checks=[]
    for index, concrete in enumerate(trace["states"]):
        expected=And(states[index]["phase"]==SPEC["state"]["phase"].index(concrete["phase"]),states[index]["effects"]==concrete["effects"],states[index]["receipt"]==concrete["receipt"],states[index]["reconciled"]==concrete["reconciled"])
        solver=Solver();solver.add(domain(states[index]),expected);checks.append({"name":f"state:{index}","result":str(solver.check())})
        for property_name in PROPERTIES:
            safety=Solver();safety.add(domain(states[index]),expected,Not(prop(property_name,states[index])));checks.append({"name":f"state:{index}:safety:{property_name}","result":"unsat" if safety.check()==unsat else "sat"})
    for index,name in enumerate(trace["transitions"]):
        relation=dict(transitions(states[index],states[index+1],patch)).get(name)
        if relation is None:checks.append({"name":f"transition:{index}:{name}","result":"unknown-transition"});continue
        a=trace["states"][index];b=trace["states"][index+1]
        concrete=And(states[index]["phase"]==SPEC["state"]["phase"].index(a["phase"]),states[index]["effects"]==a["effects"],states[index]["receipt"]==a["receipt"],states[index]["reconciled"]==a["reconciled"],states[index+1]["phase"]==SPEC["state"]["phase"].index(b["phase"]),states[index+1]["effects"]==b["effects"],states[index+1]["receipt"]==b["receipt"],states[index+1]["reconciled"]==b["reconciled"])
        solver=Solver();solver.add(relation,concrete);checks.append({"name":f"transition:{index}:{name}","result":str(solver.check())})
    accepted=all((x["result"]=="unsat" if ":safety:" in x["name"] else x["result"]=="sat") for x in checks)
    return {"accepted":accepted,"patch":patch,"trace":trace,"checks":checks,"solver":f"Z3 {get_version_string()}"}

request=json.load(sys.stdin); command=request.get("command")
if command=="catalog":result={"patches":PATCHES,"lemmas":LEMMAS,"properties":PROPERTIES,"solver":f"Z3 {get_version_string()}"}
elif command=="counterexamples":result={"patch":request["patch"],"counterexamples":[x for p in PROPERTIES if (x:=counterexample(request["patch"],p,request.get("depth",3))) is not None]}
elif command=="check":result=check(request["patch"],request.get("lemmas",[]))
elif command=="validate_trace":result=validate_trace(request["patch"],request["trace"])
else:raise ValueError("unknown command")
json.dump(result,sys.stdout,separators=(",",":"))
