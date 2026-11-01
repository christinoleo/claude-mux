#!/usr/bin/env python3
"""Prints the evidence of each named case (or all) from PROBE_DIR/results."""
import glob, json, os, sys

P = sys.argv[1]
names = sys.argv[2:] or sorted(os.path.basename(d) for d in glob.glob(P + "/results/*"))
for n in names:
    f = f"{P}/results/{n}/result.json"
    if not os.path.exists(f):
        print("==", n, "NO RESULT")
        continue
    d = json.load(open(f))
    t = d.pop("transcript")
    print("==", n)
    print(" meta", json.dumps({k: v for k, v in d.items() if k not in ("case", "fired", "hook_lifecycle")}))
    print(" fired", [":".join(str(x) for x in e if x not in (None, False)) for e in d["fired"]])
    print(" life", [" ".join(str(v) for v in e.values()) for e in d["hook_lifecycle"]])
    print(" uses", [(u["name"], "sub" if u["sidechain"] else "main") for u in t["tool_uses"]])
    seen = set()
    for r in t["tool_results"]:
        key = r["content"]
        if key in seen:
            continue
        seen.add(key)
        print(" result", "ERR" if r["is_error"] else "ok", "sub" if r["sidechain"] else "main", r["content"][:330].replace("\n", " "))
    for a in t["assistant_text"][-2:]:
        print(" text", "sub" if a["sidechain"] else "main", a["text"][:260].replace("\n", " "))
