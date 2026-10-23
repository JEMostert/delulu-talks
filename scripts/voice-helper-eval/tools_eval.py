"""Prototype for the voice-helper redesign (docs/voice-redesign.md): the helper
model as a forced tool caller in Qwen's native tool format.

Every turn must be one tool call. The tool name is chosen by its calibrated log
probability (minus the score each name gets for a neutral "N/A" turn); the
arguments are then generated. Measured 32/34 on cases.json with Qwen3.5-0.8B.

Run with an installed coordinator runtime and cached model, offline:
  CALIBRATE=1 "<profile>/magic-venv/generations/<id>/bin/python" -I \
    scripts/voice-helper-eval/tools_eval.py backend/python [qwen35Small|qwen35Medium]
"""
import json, os, re, sys, time
sys.path.insert(0, sys.argv[1]); os.environ["HF_HUB_OFFLINE"] = "1"; os.environ["DELULU_RUNTIME_KIND"] = "coordinator"
import torch, transcription_engine as te
w = te.Worker()
w.dispatch({"protocolVersion": 1, "id": "l", "command": os.environ.get("COORD_CMD", "coordinatorLoad"), "model": sys.argv[2] if len(sys.argv) > 2 else "qwen35Small",
            "cacheDir": os.path.expanduser("~/.config/Delulu Talks/models/hub")})
proc, model = w.magic_processor, w.magic_model

def tools(ctx):
    tasks = [t["id"] for t in ctx["tasks"]]; agents = [a["label"] for a in ctx["agents"]]
    opt = lambda desc, values: {"type": "string", "description": desc, **({"enum": values} if values else {})}
    t = [
      {"type": "function", "function": {"name": "send_to_agent", "description": "Hand the user's request to a coding agent: any request to do, make, fix, change, run or check work. The user's exact words are delivered automatically; never repeat them.",
        "parameters": {"type": "object", "properties": {**({"agent": opt("Only if the user names an agent", agents)} if agents else {}), **({"task": opt("Only for a correction or follow-up to this existing task", tasks)} if tasks else {})}, "required": []}}},
      {"type": "function", "function": {"name": "task_status", "description": "Look up how the user's tasks are going.",
        "parameters": {"type": "object", "properties": {**({"task": opt("A specific task", tasks)} if tasks else {})}, "required": []}}},
      {"type": "function", "function": {"name": "stop_speaking", "description": "Stop talking right now.", "parameters": {"type": "object", "properties": {}, "required": []}}},
      {"type": "function", "function": {"name": "stop_listening", "description": "Turn off the microphone.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    ]
    if tasks:
        t.append({"type": "function", "function": {"name": "cancel_task", "description": "Cancel a task the user explicitly asks to cancel.",
            "parameters": {"type": "object", "properties": {"task": opt("The task to cancel", tasks)}, "required": ["task"]}}})
    return t

def system(ctx):
    lines = ["You are Delulu, a voice assistant between the user and their coding agents.",
             "Use a tool when the user wants something done. Otherwise reply in one short spoken sentence, in the user's language.",
             "Agents: " + (", ".join(a["label"] for a in ctx["agents"]) or "none"),
             "Open tasks: " + ("; ".join(f'{t["id"]}: {t["label"]}' for t in ctx["tasks"]) or "none")]
    return "\n".join(lines)


REPLY = {"type": "function", "function": {"name": "reply", "description": "Say one short sentence to the user, in their language. Only for greetings, thanks, or questions about you; never to claim work was done.",
    "parameters": {"type": "object", "properties": {"text": {"type": "string", "description": "What to say"}}, "required": ["text"]}}}
EX = [
  (0, "Fix the login bug.", "send_to_agent", {}),
  (0, "Repareer de inlogpagina.", "send_to_agent", {}),
  (0, "Kun je de tests draaien?", "send_to_agent", {}),
  (0, "Can you write docs for the API?", "send_to_agent", {}),
  (1, "How is it going?", "task_status", {}),
  (1, "Is de taak klaar?", "task_status", {"task": "task_1"}),
  (0, "Stop talking.", "stop_speaking", {}),
  (0, "Hou je mond even.", "stop_speaking", {}),
  (0, "Turn off the microphone.", "stop_listening", {}),
  (0, "Hoi!", "reply", {"text": "Hoi! Zeg maar wat je agent moet doen."}),
  (0, "Thanks.", "reply", {"text": "You're welcome."}),
  (0, "Stop the server and restart it.", "send_to_agent", {}),
  (0, "Who are you?", "reply", {"text": "I'm Delulu. I pass your requests to your coding agent."}),
  (0, "Super, dank je.", "reply", {"text": "Graag gedaan."}),
  (0, "Stop met dat script en kijk naar de logs.", "send_to_agent", {}),
]
EXCTX = {"tasks": [{"id": "task_1", "label": "Fix the search bug"}], "agents": [{"id": "agent_1", "label": "Coding agent"}]}

def render_call(name, args):
    body = "".join(f"<parameter={k}>\n{v}\n</parameter>\n" for k, v in args.items())
    return f"<tool_call>\n<function={name}>\n{body}</function>\n</tool_call>"

def prompt_ids(ctx, text):
    msgs = [{"role": "system", "content": system(ctx) + "\nAlways answer with exactly one tool call."}]
    for _c, u, name, args in EX:
        msgs.append({"role": "user", "content": u})
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": name, "arguments": args}}]})
        msgs.append({"role": "tool", "content": "ok"})
    msgs.append({"role": "user", "content": text})
    tl = tools(ctx) + [REPLY]
    s = proc.apply_chat_template(msgs, tools=tl, add_generation_prompt=True, tokenize=False, enable_thinking=False)
    return s + "<tool_call>\n<function=", [t["function"]["name"] for t in tl]

PARAM = re.compile(r"<parameter=(\w+)>\s*(.*?)\s*</parameter>", re.S)
tok = proc.tokenizer
_prior = {}

def name_scores(prefix, names):
    base = tok(prefix, return_tensors="pt", add_special_tokens=False).input_ids.to(w.magic_device)
    with torch.inference_mode():
        out = model(base, use_cache=True)
        cache = out.past_key_values
        first = out.logits[0, -1].log_softmax(-1)
        scores = {}
        for name in names:
            ids = tok(name + ">", add_special_tokens=False).input_ids
            total = first[ids[0]].item()
            if len(ids) > 1:
                import copy
                c = copy.deepcopy(cache)
                logits = model(torch.tensor([ids[:-1]], device=base.device), past_key_values=c, use_cache=True).logits[0].log_softmax(-1)
                total += sum(logits[i, t].item() for i, t in enumerate(ids[1:]))
            scores[name] = total
    return scores, base.shape[-1]

def run(ctx, text):
    prefix, names = prompt_ids(ctx, text)
    scores, n = name_scores(prefix, names)
    key = (json.dumps(ctx, sort_keys=True))
    if os.environ.get("CALIBRATE") == "1":
        if key not in _prior:
            _prior[key] = name_scores(prompt_ids(ctx, "N/A")[0], names)[0]
        scores = {k: v - _prior[key][k] for k, v in scores.items()}
    name = max(scores, key=scores.get)
    lead = prefix + name + ">\n" + ("<parameter=text>\n" if name == "reply" else "")
    cont = tok(lead, return_tensors="pt", add_special_tokens=False).to(w.magic_device)
    with torch.inference_mode():
        gen = model.generate(**cont, max_new_tokens=40, do_sample=False, stop_strings=["</parameter>", "</tool_call>"], tokenizer=tok)
    raw = tok.decode(gen[0][cont.input_ids.shape[-1]:], skip_special_tokens=True)
    args = {"text": raw.split("</parameter>")[0].strip()} if name == "reply" else dict(PARAM.findall(raw))
    return name, args, n

ctx0 = {"tasks": [], "agents": [{"id": "agent_1", "label": "Claude Code"}]}
ctx1 = {"tasks": [{"id": "task_1", "label": "Run the unit tests"}], "agents": [{"id": "agent_1", "label": "Claude Code"}]}
cases = json.load(open(os.path.join(os.path.dirname(__file__), "cases.json")))
ok = 0; t0 = time.time()
for c, text, want in cases:
    ctx = ctx1 if c == 1 else ctx0
    t = time.time(); name, args, n = run(ctx, text)
    hit = name == want; ok += hit
    print(f"{'OK ' if hit else 'BAD'} {want:14} {name:14} {json.dumps(args, ensure_ascii=False)[:70]:72} {time.time()-t:4.2f}s {n}tok  {text}")
print(f"{ok}/{len(cases)}  total {time.time()-t0:.1f}s")
