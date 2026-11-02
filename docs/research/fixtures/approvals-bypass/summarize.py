#!/usr/bin/env python3
"""Prints one line per case across trials, from PROBE_DIR/results. Usage: summarize.py PROBE_DIR [prefix]"""
import glob, json, os, sys
from collections import Counter

root = sys.argv[1] + "/results"
pref = sys.argv[2] if len(sys.argv) > 2 else ""
for case in sorted(os.listdir(root)):
    if not case.startswith(pref):
        continue
    rows = [json.load(open(f)) for f in sorted(glob.glob(f"{root}/{case}/t*/result.json"))]
    agg = Counter()
    modes, results = Counter(), []
    for r in rows:
        main = [f for f in r["fired"] if not f.get("agent_type") or f.get("agent_type") == "fork" or f["ev"] not in ("PreToolUse", "PostToolUse")]
        target = [f for f in main if f.get("tool_name") and f["tool_name"] not in ("ToolSearch", "Write", "Agent") or (f.get("tool_name") == "Write" and "protected" in case)]
        evs = {f["ev"] for f in target}
        for e in ("PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"):
            agg[e] += e in evs
        agg["Elicitation"] += any(f["ev"] == "Elicitation" for f in r["fired"])
        agg["ElicitationResult"] += any(f["ev"] == "ElicitationResult" for f in r["fired"])
        for k in ("dialog_during_hold", "dialog_after_hook_end", "dialog_seen", "dialog_stuck", "keys_sent", "stop_fired", "file_exists", "held", "hook_alive_after_person"):
            agg[k] += bool(r.get(k))
        for f in r["fired"]:
            if f["ev"] in ("PreToolUse", "PermissionRequest") and f.get("permission_mode"):
                modes[f["permission_mode"]] += 1
        tr = [t for t in r["transcript"]["tool_results"] if not t["content"].startswith(("Tool loaded", "File created"))]
        results.append((tr[-1]["is_error"], tr[-1]["content"][:110]) if tr else None)
    n = len(rows)
    print(f"{case} n={n} " + " ".join(f"{k}={v}" for k, v in agg.items() if v) + f" modes={dict(modes)}")
    for x, c in Counter(map(str, results)).items():
        print(f"    {c}x {x}")
