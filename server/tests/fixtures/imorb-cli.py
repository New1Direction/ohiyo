#!/usr/bin/env python3
"""Scripted CLI contract double, NOT an ImOrb runtime or a live price probe.

Shapes follow New1Direction/ImOrb at 15762f1c0e8d29504ed18fff390be60b6b60ded2.
The test driver controls completion through a file. No models, network or money.
"""
import json
import os
from pathlib import Path
import sys
import uuid

assert sys.argv[1:3] == ["host", "agent"]
args = sys.argv[3:]
home = Path(os.environ["ORBD_HOME"])
path = home / "runtime.json"
data = json.loads(path.read_text()) if path.exists() else {"runs": {}, "starts": 0}


def event(run, kind, payload):
    run["events"].append({"seq": len(run["events"]) + 1, "at": 1, "type": kind, "data": payload})


def save():
    path.write_text(json.dumps(data))


if args[0] == "start":
    def flag(name):
        return args[args.index(name) + 1]

    assert flag("--permissions") == "standard"
    assert flag("--network") == "restricted"
    assert flag("--engine") == "orbd"
    assert flag("--kind") == "investigate"
    limit = flag("--max-usd")
    assert 0 < float(limit) <= 0.5
    run_id = "run-" + uuid.uuid4().hex[:10]
    run = {"run": run_id, "root_goal_id": flag("--root-goal"), "orb": args[1],
           "state": "Running", "goal": flag("--goal"), "events": [],
           "model_calls": 1, "limit": limit, "instruction": "monthly"}
    event(run, "run_created", {"goal": run["goal"]})
    event(run, "model_request", {"turn": 0, "attempt": 1})
    data["runs"][run_id] = run
    data["starts"] += 1
    save()
    if "ambiguous-start" in run["goal"]:
        sys.exit(1)  # Accepted upstream; caller never receives the ID.
    if "crash-start" in run["goal"]:
        (home / "start-entered").touch()
        import time
        time.sleep(60)  # Test kills the bridge while its start command is in flight.
    print(run_id)
else:
    run = data["runs"][args[1]]
    if args[0] == "status":
        if (home / "lost-model").exists():
            run["state"] = "Paused"
        elif (home / "finish").exists() and run["state"] == "Running":
            run["state"] = "Completed"
            event(run, "final_message", {"content": f"{run['instruction'].title()} comparison (fixture, not live prices)."})
            event(run, "run_completed", {"receipt_sha256": "fixture"})
        save()
        print(json.dumps({k: run[k] for k in ("run", "root_goal_id", "orb", "state")} | {
            "usage": {"lost_model_calls": int((home / "lost-model").exists())},
            "reason": "uncertain model request" if run["state"] == "Paused" else None,
        }))
    elif args[0] == "watch":
        assert args[2:] == ["--json"]
        for item in run["events"]:
            print(json.dumps(item))
    elif args[0] in ("steer", "continue"):
        if args[0] == "continue":
            assert run["state"] in ("Completed", "Failed")
            run["model_calls"] += 1
            (home / "finish").unlink(missing_ok=True)
            run["state"] = "Running"
        run["instruction"] = args[2]
        event(run, "steering_queued" if args[0] == "steer" else "run_continued", {"message": args[2]})
        save()
        if "uncertain-instruction" in args[2]:
            sys.exit(1)
        print("queued")
    elif args[0] == "cancel":
        run["state"] = "Cancelled"
        event(run, "run_cancelled", {})
        save()
        print("cancel requested")
    elif args[0] == "resume":
        # Actual ImOrb refuses unresolved model calls; ordinary resume cannot pay again.
        if (home / "lost-model").exists():
            sys.exit(1)
        run["state"] = "Running"
        save()
        print("resumed")
    else:
        raise AssertionError(args)
