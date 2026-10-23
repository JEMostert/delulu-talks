"""Offline eval of the voice helper (backend/python/coordinator_engine.py) on the
production path: requests go through the worker's protocol validation and
dispatch exactly as the app sends them.

  cases.json    34 English/Dutch phrases: [context, text, expected tool]
  heldout.json  phrases that are not prompt examples, with memory, follow-ups,
                repeat_last and a cancel + "ja" confirmation (multi-step cases)

Run offline with an installed coordinator runtime and cached model:
  CALIBRATE=1 "<profile>/magic-venv/generations/<id>/bin/python" -I \
    scripts/voice-helper-eval/tools_eval.py backend/python
DELULU_HELPER_CACHE overrides the model cache (default: the release profile's).
CALIBRATE is accepted for compatibility; calibration is always on.
"""
import json, os, re, statistics, sys, time
sys.path.insert(0, sys.argv[1]); os.environ["HF_HUB_OFFLINE"] = "1"; os.environ["DELULU_RUNTIME_KIND"] = "coordinator"
import transcription_engine as te
from worker_protocol import validate_request, validate_result
from coordinator_engine import REPLY_AFTER, detect_language

HERE = os.path.dirname(os.path.abspath(__file__))
w = te.Worker()
seq = 0


def call(command, **fields):
    global seq
    seq += 1
    request = validate_request({"protocolVersion": 1, "id": f"eval-{seq}", "command": command, **fields})
    result = w.dispatch(request)
    validate_result(command, result)
    return result


started = time.time()
call("coordinatorLoad", model="qwen35Small",
     cacheDir=os.environ.get("DELULU_HELPER_CACHE") or os.path.expanduser("~/.config/Delulu Talks/models/hub"))
print(f"load + prefix cache {time.time() - started:.1f}s, prefix {w.coordinator_helper.prefix_tokens} tokens")

AGENT = {"id": "agent_1", "label": "Claude Code", "listening": True}
CONTEXTS = {
    0: {"agents": [AGENT]},
    1: {"agents": [AGENT], "tasks": [{"id": "task_1", "label": "Run the unit tests", "agent": "Claude Code", "state": "running"}]},
}


def result_for(tool, args, context, confirmed=False):
    # The English sentence the Rust executor reports back for the second call.
    tasks = {task["id"]: task for task in context.get("tasks", [])}
    if tool == "send_to_agent":
        agents = [a for a in context.get("agents", []) if a["listening"]]
        if not agents:
            return "No agent is listening right now."
        if "task" in args:
            return f"Passed it on to {tasks[args['task']].get('agent') or agents[0]['label']}."
        return f"Sent to {next((a['label'] for a in agents if a['id'] == args.get('agent')), agents[0]['label'])}."
    if tool == "task_status":
        chosen = [tasks[args["task"]]] if "task" in args else list(tasks.values())
        lines = {"queued": '{agent} has not started "{label}" yet.', "accepted": '{agent} is working on "{label}".',
                 "running": '{agent} is working on "{label}".', "blocked": '{agent} is stuck on "{label}".'}
        return " ".join(lines[t["state"]].format(agent=t.get("agent") or "No agent", label=t["label"]) for t in chosen) or "There are no open tasks."
    if tool == "cancel_task":
        task = tasks[args["task"]]
        return f'Asked {task["agent"]} to cancel "{task["label"]}".' if confirmed else f'Cancel "{task["label"]}"? Say yes.'


decide_ms, reply_ms, turn_ms, mismatched = [], [], [], []


def turn(context, text, step=None):
    """One user turn like the app runs it: decide, then a reply for tools that need one."""
    t = time.perf_counter()
    decision = call("coordinatorDecide", text=text, context=context)
    decide_ms.append(decision["elapsedMs"])
    said = decision["args"].get("text", "")
    if decision["tool"] in REPLY_AFTER:
        result = result_for(decision["tool"], decision["args"], context, decision.get("confirmed", False))
        answer = call("coordinatorReply", text=text, context=context,
                      call={"tool": decision["tool"], "args": decision["args"]}, result=result)
        reply_ms.append(answer["elapsedMs"])
        said = answer["text"]
    turn_ms.append((time.perf_counter() - t) * 1000)
    # Quoted task titles stay in their own language.
    plain = re.sub(r'"[^"]*"', "", said)
    if plain and detect_language(plain) != decision["language"] and len(plain.split()) > 2:
        mismatched.append((text, said))
    return decision, said


def check(name, cases):
    ok = 0
    for case in cases:
        steps = case.get("steps", [case])
        hit = True
        for step in steps:
            context = step["context"] if isinstance(step["context"], dict) else CONTEXTS[step["context"]]
            decision, said = turn(context, step["text"])
            good = step["tool"] in (None, decision["tool"]) and all(decision["args"].get(k) == v for k, v in step.get("args", {}).items())
            if "noArgs" in step and any(k in decision["args"] for k in step["noArgs"]):
                good = False
            if step.get("confirmed") is not None and bool(decision.get("confirmed")) != step["confirmed"]:
                good = False
            hit &= good
            args = {k: v for k, v in decision["args"].items() if k != "text"}
            print(f"{'OK ' if good else 'BAD'} {str(step['tool']):14} {decision['tool']:14} {json.dumps(args):22} "
                  f"{decision['elapsedMs']:6.0f}ms  {step['text']}  →  {said}")
        ok += hit
    print(f"{name}: {ok}/{len(cases)}\n")
    return ok


main = [{"context": c, "text": text, "tool": want} for c, text, want in json.load(open(os.path.join(HERE, "cases.json")))]
score_main = check("cases.json", main)
heldout = json.load(open(os.path.join(HERE, "heldout.json")))
score_heldout = check("heldout.json", heldout)


def stats(values):
    values = sorted(values)
    return f"median {statistics.median(values):.0f} ms, p90 {values[int(len(values) * 0.9) - 1]:.0f} ms, max {values[-1]:.0f} ms"


print(f"main {score_main}/{len(main)}, held-out {score_heldout}/{len(heldout)}")
print(f"decide: {stats(decide_ms)} ({len(decide_ms)} calls)")
print(f"reply:  {stats(reply_ms)} ({len(reply_ms)} calls)")
print(f"turn (decide + reply when needed): {stats(turn_ms)}")
print(f"reply language mismatches: {len(mismatched)}" + "".join(f"\n  {t!r} → {s!r}" for t, s in mismatched))
