#!/usr/bin/env python3
import hashlib, json, pathlib, sys
from z3 import Solver, parse_smt2_file, unsat, get_version_string
root=pathlib.Path(sys.argv[1]);manifest=json.loads((root/"manifest.json").read_text());results=[]
for item in manifest["obligations"]:
    path=root/item["file"];digest=hashlib.sha256(path.read_bytes()).hexdigest()
    solver=Solver();solver.add(parse_smt2_file(str(path)));result=str(solver.check());results.append({"name":item["name"],"sha256Matches":digest==item["sha256"],"result":result})
accepted=all(x["sha256Matches"] and x["result"]=="unsat" for x in results)
print(json.dumps({"accepted":accepted,"solver":f"Z3 {get_version_string()}","results":results},separators=(",",":")))
sys.exit(0 if accepted else 1)
