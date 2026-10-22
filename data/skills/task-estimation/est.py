#!/usr/bin/env python3
"""Task timing log for AI agents. Append-only JSONL, UTC timestamps.

  est.py estimate <task> <agent_min_low> <agent_min_high> <human_h_low> <human_h_high> [--excludes "what this estimate does not cover"] [note...]
  est.py phase    <task> <phase> [note...]   # ends any open phase on the task, starts this one
  est.py done     <task> [note...]           # ends the open phase; task finished
  est.py start|stop <task> <phase> [note...] # explicit form (older logs use this)
  est.py report   [task ...]                 # per task: phases, wall span, estimate vs actual
  est.py summary                             # all tasks: actual / estimate ratios
  est.py check                               # open phases and tasks with no estimate

Phases: read implement test review fix (others are accepted with a warning).
Log path: $EST_LOG, else ./estimation/log.jsonl, else next to this script.
Log each phase change the moment it happens; phases logged afterwards are guesses.
Say what the estimate does NOT cover with --excludes (live deploy, real-system checks, client sign-off).
Estimate BEFORE reading the code in depth, and say in the note if you already knew it."""
import datetime as dt, json, os, sys
from collections import defaultdict

PHASES = ("read", "implement", "test", "review", "fix")

def log_path():
    if os.environ.get("EST_LOG"): return os.environ["EST_LOG"]
    local = os.path.join(os.getcwd(), "estimation", "log.jsonl")
    if os.path.isdir(os.path.dirname(local)): return local
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "log.jsonl")

def now(): return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
def parse(ts): return dt.datetime.fromisoformat(ts)
def rows():
    p = log_path()
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
def add(**r):
    r["ts"] = now().isoformat()
    if os.environ.get("AGENT_NAME"): r["who"] = os.environ["AGENT_NAME"]
    os.makedirs(os.path.dirname(log_path()), exist_ok=True)
    with open(log_path(), "a") as f: f.write(json.dumps(r) + "\n")

def phase_of(r): return r.get("phase") or r.get("segment")

def analyse():
    """-> {task: {'est':row|None,'minutes':{phase:min},'open':{phase:ts},'first':ts,'last':ts}}"""
    t = defaultdict(lambda: {"est": None, "minutes": defaultdict(float), "open": {}, "first": None, "last": None})
    for r in rows():
        k = r.get("task")
        if not k: continue
        d = t[k]; ts = parse(r["ts"])
        if r["kind"] == "estimate": d["est"] = r
        elif r["kind"] == "start":
            d["open"][phase_of(r)] = ts; d["first"] = d["first"] or ts
        elif r["kind"] == "stop" and phase_of(r) in d["open"]:
            d["minutes"][phase_of(r)] += (ts - d["open"].pop(phase_of(r))).total_seconds() / 60
            d["last"] = ts
    return t

def mid(pair): return sum(pair) / 2

def show(task, d):
    actual = sum(d["minutes"].values())
    line = f"{task}: {actual:.1f} agent-min in phases"
    if d["first"] and d["last"]:
        line += f" (wall {(d['last'] - d['first']).total_seconds() / 60:.1f} min)"
    if d["est"]:
        e = d["est"]
        line += f" | est {e['agent_min'][0]:.0f}-{e['agent_min'][1]:.0f} agent-min, human {e['human_hours'][0]:.0f}-{e['human_hours'][1]:.0f}h"
        if actual: line += f" | {100 * actual / mid(e['agent_min']):.0f}% of agent est, {100 * actual / 60 / mid(e['human_hours']):.1f}% of human est"
    else: line += " | NO ESTIMATE"
    if d["est"] and d["est"].get("excludes"): line += f"\n   not covered by estimate: {d['est']['excludes']}"
    print(line)
    for p, m in d["minutes"].items(): print(f"   {p:10s} {m:6.1f} min")
    for p in d["open"]: print(f"   {p:10s} STILL OPEN since {d['open'][p].isoformat()}")

def close_open(task, note=""):
    for p in list(analyse()[task]["open"]): add(kind="stop", task=task, phase=p, note=note)

a = sys.argv[1:]
if not a: print(__doc__); sys.exit()
c = a[0]
try:
    if c == "estimate":
        rest = a[6:]; excludes = ""
        if "--excludes" in rest:
            i = rest.index("--excludes"); excludes = rest[i + 1]; rest = rest[:i] + rest[i + 2:]
        add(kind="estimate", task=a[1], agent_min=[float(a[2]), float(a[3])], human_hours=[float(a[4]), float(a[5])], note=" ".join(rest), excludes=excludes)
    elif c == "phase":
        if a[2] not in PHASES: print(f"warning: '{a[2]}' is not one of {PHASES}", file=sys.stderr)
        close_open(a[1]); add(kind="start", task=a[1], phase=a[2], note=" ".join(a[3:]))
    elif c == "done":
        close_open(a[1], " ".join(a[2:]))
    elif c in ("start", "stop"):
        add(kind=c, task=a[1], phase=a[2], note=" ".join(a[3:]))
    elif c == "report":
        for k, d in analyse().items():
            if not a[1:] or k in a[1:]: show(k, d)
    elif c == "summary":
        n = ag = hu = 0; tot = 0.0
        for k, d in analyse().items():
            actual = sum(d["minutes"].values())
            if d["est"] and actual and not d["open"]:
                n += 1; tot += actual; ag += mid(d["est"]["agent_min"]); hu += mid(d["est"]["human_hours"]) * 60
                print(f"{k:40s} actual {actual:6.1f}m  est {mid(d['est']['agent_min']):6.0f}m  ({100 * actual / mid(d['est']['agent_min']):.0f}%)  human {mid(d['est']['human_hours']):.0f}h")
        if n: print(f"\n{n} finished tasks: actual {tot:.1f} agent-min = {100 * tot / ag:.0f}% of agent estimates, {100 * tot / hu:.1f}% of human estimates")
    elif c == "check":
        for k, d in analyse().items():
            if d["open"]: print(f"{k}: open phase(s) {list(d['open'])}")
            if not d["est"]: print(f"{k}: no estimate")
    else: print(__doc__)
except IndexError:
    print(__doc__); sys.exit(1)
