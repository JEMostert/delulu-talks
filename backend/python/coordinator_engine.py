"""Voice helper: a forced tool caller in Qwen's native tool format.

Every turn is exactly one tool call. The tool name is chosen by its log
probability minus a calibration prior (the score each name gets for a neutral
"N/A" turn with the same context shape); arguments are chosen among the ids
in the context, and only `reply` generates text. The fixed prompt prefix
(system text, tools, examples) is processed once and its cache reused, so a
turn only runs its own context block and utterance.

The model never writes task text: `send_to_agent` forwards the user's words
on the Rust side. Model ownership/loading stays in the worker.
"""
from __future__ import annotations

import copy
import re
import time
from typing import Any

from worker_protocol import utf16_length

MODELS = frozenset({"qwen35Small", "qwen35Medium"})
TOOLS = ("send_to_agent", "task_status", "cancel_task", "stop_speaking", "stop_listening", "repeat_last", "reply")
# Tools whose result the helper turns into a spoken sentence with a second call.
REPLY_AFTER = frozenset({"send_to_agent", "task_status", "cancel_task"})
TASK_STATES = frozenset({"queued", "accepted", "running", "blocked"})
LANGUAGES = {"en": "English", "nl": "Dutch"}
MAX_TEXT_CHARS = 2_000
MAX_RESULT_CHARS = 600
MAX_REPLY_CHARS = 300
MAX_REPLY_TOKENS = 32
MAX_TRANSLATION_TOKENS = 72
MAX_INPUT_TOKENS = 8_192
# Share of the neutral-turn prior subtracted from each tool score; measured on
# scripts/voice-helper-eval (full calibration over-rewards rarely chosen tools).
CALIBRATION = 0.25
_ID = re.compile(r"^(agent|task)_[0-9]{1,3}$")

# Small word lists decide only which language to answer in.
_DUTCH = frozenset("""
de het een ik je jij jou jouw u wat wie waar waarom wanneer hoe zijn niet en van dat die deze dit maar kun kan
kunt wil wilt moet mag hoi dank bedankt goedemorgen goedemiddag goedenavond zeg zei mij mijn nog ook er heb hebt
heeft wordt alsjeblieft graag ja nee even eigenlijk sla maak draai zet uit met voor naar aan bij om tegen hij zij
wij ons jullie klaar taak taken luisteren praten herhaal herhalen annuleer annuleren laat gaat staat ervoor al
mond hou dan nu weer welke goed
""".split())
_ENGLISH = frozenset("""
the a an i you your what who where why when how are not and of that this these but can could will would should
please thanks thank hello hi hey morning say said me my again also there have has do does did it to for on with
he she we us our done task tasks listening talking repeat cancel yes no fix run make add write tell going doing
""".split())
_YES = frozenset("yes yeah yep yup sure ja jawel jazeker zeker ok okay oké oke prima klopt correct graag absolutely".split())
_NO = frozenset("no not don't dont nope never nee niet geen nooit wacht wait".split())


def _words(text: str) -> list[str]:
    return re.findall(r"[\w']+", text.casefold())


def detect_language(text: str, recent: list[dict[str, Any]] | None = None) -> str:
    """English or Dutch by marker words; ties fall back to the conversation."""
    words = _words(text)
    dutch = sum(word in _DUTCH for word in words)
    english = sum(word in _ENGLISH for word in words)
    if dutch != english:
        return "nl" if dutch > english else "en"
    for turn in reversed(recent or []):
        words = _words(turn.get("user", ""))
        dutch = sum(word in _DUTCH for word in words)
        english = sum(word in _ENGLISH for word in words)
        if dutch != english:
            return "nl" if dutch > english else "en"
    return "en"


def _names(text: str, label: str) -> bool:
    """The utterance names this agent ("Tell Claude Code to …")."""
    label = _words(label)
    words = _words(text)
    return bool(label) and any(words[i:i + len(label)] == label for i in range(len(words)))


def is_affirmative(text: str) -> bool:
    """A short spoken yes ("ja", "yes please", "ja, doe maar"), never with a no in it."""
    words = _words(text)
    if not words or len(words) > 6 or any(word in _NO for word in words):
        return False
    return words[0] in _YES or words[:2] in (["doe", "maar"], ["go", "ahead"], ["do", "it"])


# ---------------------------------------------------------------- validation

def _text(value: Any, limit: int, *, empty: bool = False) -> bool:
    return isinstance(value, str) and (empty or bool(value.strip())) and utf16_length(value) <= limit


def validate_context(context: Any) -> dict[str, Any]:
    if not isinstance(context, dict) or set(context) - {"agents", "tasks", "recent", "pendingCancel"}:
        raise ValueError("Helper context has unexpected fields")
    for key, limit, fields in (("agents", 8, {"id", "label", "listening"}),
                               ("tasks", 16, {"id", "label", "agent", "state", "summary"}),
                               ("recent", 6, {"user", "tool", "said", "interrupted"})):
        items = context.get(key, [])
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError(f"Helper context {key} is limited to {limit} entries")
        for item in items:
            if not isinstance(item, dict) or set(item) - fields:
                raise ValueError(f"Helper context {key} entries have unexpected fields")
    seen: set[str] = set()
    labels: set[str] = set()
    for agent in context.get("agents", []):
        if (not isinstance(agent.get("id"), str) or not _ID.match(agent["id"]) or not agent["id"].startswith("agent_")
                or not _text(agent.get("label"), 120) or type(agent.get("listening")) is not bool
                or agent["id"] in seen or agent["label"] in labels):
            raise ValueError("Helper context agents need a unique agent_N id, label and listening flag")
        seen.add(agent["id"])
        labels.add(agent["label"])
    for task in context.get("tasks", []):
        if (not isinstance(task.get("id"), str) or not _ID.match(task["id"]) or not task["id"].startswith("task_")
                or task["id"] in seen or not _text(task.get("label"), 120) or task.get("state") not in TASK_STATES
                or (task.get("agent") is not None and not _text(task["agent"], 120))
                or ("summary" in task and not _text(task["summary"], 200))):
            raise ValueError("Helper context tasks need a unique task_N id, label and open state")
        seen.add(task["id"])
    for turn in context.get("recent", []):
        if (not _text(turn.get("user"), 300) or turn.get("tool") not in TOOLS
                or not _text(turn.get("said"), 300, empty=True) or type(turn.get("interrupted")) is not bool):
            raise ValueError("Helper context recent turns need user, tool, said and interrupted")
    pending = context.get("pendingCancel")
    if pending is not None and pending not in {task["id"] for task in context.get("tasks", [])}:
        raise ValueError("Helper pendingCancel must be a task in the context")
    return context


def _validate_call(call: Any, context: dict[str, Any], tools: tuple[str, ...] | frozenset[str]) -> None:
    if not isinstance(call, dict) or call.get("tool") not in tools or not isinstance(call.get("args"), dict):
        raise ValueError("Helper call needs a known tool and args")
    tool, args = call["tool"], call["args"]
    allowed = {"send_to_agent": {"agent", "task"}, "task_status": {"task"}, "cancel_task": {"task"},
               "reply": {"text"}}.get(tool, set())
    if set(args) - allowed or (tool == "cancel_task" and "task" not in args) or (tool == "reply" and "text" not in args):
        raise ValueError("Helper call has invalid arguments")
    agents = {agent["id"] for agent in context.get("agents", [])}
    tasks = {task["id"] for task in context.get("tasks", [])}
    if "agent" in args and args["agent"] not in agents or "task" in args and args["task"] not in tasks:
        raise ValueError("Helper call refers to an id outside its context")
    if "text" in args and (not _text(args["text"], MAX_REPLY_CHARS) or "\n" in args["text"]):
        raise ValueError("Helper reply must be one short line")


def validate_coordinator_request(request: dict[str, Any]) -> None:
    command = request["command"]
    fields = {"protocolVersion", "id", "command"}
    if command in ("coordinatorSetup", "coordinatorLoad"):
        fields |= {"model", "cacheDir"}
        if request.get("model") not in MODELS:
            raise ValueError("Coordinator model must be qwen35Small or qwen35Medium")
        if "cacheDir" in request and not (isinstance(request["cacheDir"], str) and 0 < len(request["cacheDir"].encode()) <= 4096):
            raise ValueError("Coordinator cacheDir must be a bounded path")
    elif command in ("coordinatorDecide", "coordinatorReply"):
        fields |= {"text", "context"} | ({"call", "result"} if command == "coordinatorReply" else set())
        if not _text(request.get("text"), MAX_TEXT_CHARS):
            raise ValueError("Helper text must contain 1 to 2000 characters")
        context = validate_context(request.get("context"))
        if command == "coordinatorReply":
            _validate_call(request.get("call"), context, REPLY_AFTER)
            if not _text(request.get("result"), MAX_RESULT_CHARS):
                raise ValueError("Helper tool result must contain 1 to 600 characters")
    if set(request) - fields:
        raise ValueError("Coordinator request has unexpected fields")


def validate_decision(result: Any, context: dict[str, Any] | None = None) -> None:
    if not isinstance(result, dict) or set(result) - {"tool", "args", "language", "confirmed", "elapsedMs"}:
        raise ValueError("Helper decision has unexpected fields")
    _validate_call(result, context or {"agents": [], "tasks": []}, TOOLS) if context is not None else _validate_shape(result)
    if result.get("language") not in LANGUAGES or not _elapsed(result):
        raise ValueError("Helper decision needs a language and elapsedMs")
    if "confirmed" in result and (result["confirmed"] is not True or result["tool"] != "cancel_task"
                                  or context is not None and result["args"].get("task") != context.get("pendingCancel")):
        raise ValueError("Helper confirmation must match the pending cancel")


def _validate_shape(result: dict[str, Any]) -> None:
    # Without the request context ids can only be checked for their form.
    args = result.get("args")
    if result.get("tool") not in TOOLS or not isinstance(args, dict):
        raise ValueError("Helper call needs a known tool and args")
    for key in ("agent", "task"):
        if key in args and not (isinstance(args[key], str) and _ID.match(args[key])):
            raise ValueError("Helper call has an invalid id")


def _elapsed(result: dict[str, Any]) -> bool:
    value = result.get("elapsedMs")
    return type(value) in (int, float) and value >= 0


def validate_reply(result: Any) -> None:
    if (not isinstance(result, dict) or set(result) - {"text", "elapsedMs"} or not _elapsed(result)
            or not _text(result.get("text"), MAX_REPLY_CHARS) or "\n" in result["text"]):
        raise ValueError("Helper reply must be one short line with elapsedMs")


# -------------------------------------------------------------------- prompt

def _tool(name: str, description: str, properties: dict[str, str] | None = None, required: tuple[str, ...] = ()):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": {key: {"type": "string", "description": text}
                                                        for key, text in (properties or {}).items()},
                       "required": list(required)}}}


TOOL_SCHEMAS = [
    _tool("send_to_agent", "Forward the user's request to a coding agent: any request to do, make, fix, change, run, "
          "stop or check work (\"stop the build\", \"stop de server\"), and any factual or technical question. The "
          "user's exact words are sent automatically.",
          {"agent": "Only if the user names an agent: its id.",
           "task": "Only for a correction or follow-up to an existing task: its id."}),
    _tool("task_status", "Look up how the user's tasks and agents are doing.", {"task": "A specific task id."}),
    _tool("cancel_task", "Cancel a task the user explicitly asks to cancel. Delulu asks for a spoken yes first.",
          {"task": "The task id."}, ("task",)),
    _tool("stop_speaking", "Delulu stops talking right now. Only when the user tells Delulu itself to be quiet; "
          "never for stopping work."),
    _tool("stop_listening", "Delulu stops listening and turns off the microphone."),
    _tool("repeat_last", "Say Delulu's last spoken line again, when the user missed or did not understand it."),
    _tool("reply", "Say one short sentence to the user in their language: greetings, thanks, questions about "
          "Delulu itself (who it is, what it can do), or the confirmation after another tool. Never for factual or "
          "technical questions.",
          {"text": "What to say."}, ("text",)),
]
SYSTEM = (
    "You are Delulu, the voice between the user and their coding agents. Answer every user turn with exactly one "
    "tool call. Coding agents do the work and answer questions; you forward requests, report status, stop, repeat "
    "and confirm. After a tool result, confirm it with reply in one short sentence in the user's language."
)


def _context_block(context: dict[str, Any], language: str) -> str:
    agents = ", ".join(f"{a['id']} {a['label']} ({'listening' if a['listening'] else 'away'})"
                       for a in context.get("agents", [])) or "none"
    tasks = "; ".join(f"{t['id']} \"{t['label']}\" ({t.get('agent') or 'no agent'}, {t['state']})"
                      for t in context.get("tasks", [])) or "none"
    lines = [f"Agents: {agents}", f"Open tasks: {tasks}"]
    for turn in context.get("recent", []):
        said = f" → Delulu: \"{turn['said']}\"" if turn["said"] else ""
        cut = " (interrupted)" if turn["interrupted"] else ""
        lines.append(f"Earlier: user \"{turn['user']}\" → {turn['tool']}{said}{cut}")
    if context.get("pendingCancel"):
        lines.append(f"Waiting for a yes to cancel {context['pendingCancel']}")
    lines.append(f"Language: {LANGUAGES[language]}")
    return "\n".join(lines)


def _user(context: dict[str, Any], text: str, language: str) -> dict[str, Any]:
    return {"role": "user", "content": f"{_context_block(context, language)}\nUser says: {text}"}


def _call(name: str, args: dict[str, str]) -> dict[str, Any]:
    return {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "function": {"name": name, "arguments": args}}]}


def _tool_result(text: str) -> dict[str, Any]:
    return {"role": "tool", "content": text}


_ONE = {"agents": [{"id": "agent_1", "label": "Claude Code", "listening": True}]}
_TWO = {"agents": [{"id": "agent_1", "label": "Claude Code", "listening": True},
                   {"id": "agent_2", "label": "Codex", "listening": True}]}
_AWAY = {"agents": [{"id": "agent_1", "label": "Claude Code", "listening": False}]}
_BUSY = {**_ONE, "tasks": [{"id": "task_1", "label": "Fix the search bug", "agent": "Claude Code", "state": "running"}]}


def _said(user: str, tool: str, said: str) -> list[dict[str, Any]]:
    return [{"user": user, "tool": tool, "said": said, "interrupted": False}]


_FOLLOW = {**_BUSY, "recent": _said("Fix the search bug.", "send_to_agent", "Sent to Claude Code.")}
_FOLLOW_NL = {**_BUSY, "recent": _said("Repareer de zoekbug.", "send_to_agent", "Doorgestuurd naar Claude Code.")}
_BUTTON = {**_ONE, "tasks": [{"id": "task_1", "label": "Voeg een exportknop toe", "agent": "Claude Code", "state": "running"}],
           "recent": _said("Voeg een exportknop toe.", "send_to_agent", "Doorgestuurd naar Claude Code.")}
_SAID = {**_ONE, "recent": _said("Is the build green?", "send_to_agent", "Sent to Claude Code.")}
_SAID_NL = {**_BUSY, "recent": _said("Hoe gaat het?", "task_status", "Claude Code is nog bezig met de zoekbug.")}
_ASKED = {**_BUSY, "pendingCancel": "task_1",
          "recent": _said("Cancel the search bug task.", "cancel_task", "Cancel \"Fix the search bug\"? Say yes.")}
_ASKED_NL = {**_BUSY, "pendingCancel": "task_1",
             "recent": _said("Annuleer de zoekbug.", "cancel_task", "\"Fix the search bug\" annuleren? Zeg ja.")}

# (context, utterance, tool, args)
EXAMPLES = [
    (_ONE, "Fix the login bug.", "send_to_agent", {}),
    (_ONE, "Repareer de inlogpagina.", "send_to_agent", {}),
    (_ONE, "Kun je de tests draaien?", "send_to_agent", {}),
    (_ONE, "What is a race condition?", "send_to_agent", {}),
    (_ONE, "Hoi!", "reply", {"text": "Hoi! Wat moet je agent doen?"}),
    (_ONE, "Can you hear me?", "reply", {"text": "Yes, I can hear you."}),
    (_ONE, "Wat doet de functie parseConfig?", "send_to_agent", {}),
    (_ONE, "Turn off the microphone.", "stop_listening", {}),
    (_ONE, "Thanks.", "reply", {"text": "You're welcome."}),
    (_ONE, "Je mag stoppen met luisteren.", "stop_listening", {}),
    (_ONE, "What can you do?", "reply", {"text": "I pass your requests to your coding agent and tell you how they're going."}),
    (_ONE, "Ben je er nog?", "reply", {"text": "Ja, ik ben er."}),
    (_ONE, "Hey, Delulu!", "reply", {"text": "Hi! What should your agent do?"}),
    (_ONE, "Why does the app crash on startup?", "send_to_agent", {}),
    (_ONE, "Super, dank je.", "reply", {"text": "Graag gedaan."}),
    (_ONE, "Goedemiddag.", "reply", {"text": "Goedemiddag! Wat moet je agent doen?"}),
    (_ONE, "Wie ben jij?", "reply", {"text": "Ik ben Delulu. Ik geef je verzoeken door aan je agent."}),
    (_BUSY, "How is it going?", "task_status", {}),
    (_BUSY, "Add a dark theme to the settings.", "send_to_agent", {}),
    (_BUSY, "Is de zoekbug al opgelost?", "task_status", {"task": "task_1"}),
    (_BUSY, "Cancel the search bug task.", "cancel_task", {"task": "task_1"}),
    (_BUSY, "Schrijf een README voor de API.", "send_to_agent", {}),
    (_ASKED, "No, keep it.", "reply", {"text": "Okay, I won't cancel it."}),
    (_ASKED_NL, "Nee, laat maar lopen.", "reply", {"text": "Oké, de taak loopt door."}),
    (_FOLLOW, "Actually, keep the old ranking.", "send_to_agent", {"task": "task_1"}),
    (_FOLLOW, "And add a test for it too.", "send_to_agent", {"task": "task_1"}),
    (_FOLLOW_NL, "Gebruik toch maar de oude sortering.", "send_to_agent", {"task": "task_1"}),
    (_BUTTON, "Maak hem ook blauw.", "send_to_agent", {"task": "task_1"}),
    (_BUSY, "Eigenlijk, alleen op de zoekpagina.", "send_to_agent", {"task": "task_1"}),
    (_BUSY, "Actually, skip the old browsers.", "send_to_agent", {"task": "task_1"}),
    (_FOLLOW_NL, "Sla de oude tests maar over.", "send_to_agent", {"task": "task_1"}),
    (_SAID, "Say that again?", "repeat_last", {}),
    (_SAID_NL, "Wat zei je?", "repeat_last", {}),
    (_SAID_NL, "What did you say?", "repeat_last", {}),
    (_SAID, "Herhaal dat eens.", "repeat_last", {}),
    (_SAID_NL, "Sorry, nog een keer?", "repeat_last", {}),
    (_SAID_NL, "I missed that.", "repeat_last", {}),
    (_TWO, "Vraag Codex om de changelog bij te werken.", "send_to_agent", {"agent": "agent_2"}),
    (_TWO, "Tell Claude Code to update the docs.", "send_to_agent", {"agent": "agent_1"}),
    (_AWAY, "Add a dark theme.", "send_to_agent", {}),
    (_AWAY, "Maak de build sneller.", "send_to_agent", {}),
    (_ONE, "Stop talking.", "stop_speaking", {}),
    (_ONE, "Stop de deployment.", "send_to_agent", {}),
    (_ONE, "Hou je mond even.", "stop_speaking", {}),
    (_ONE, "Stop the build.", "send_to_agent", {}),
    (_ONE, "Stop met dat script en kijk naar de logs.", "send_to_agent", {}),
    (_ONE, "Shh, quiet.", "stop_speaking", {}),
    (_ONE, "Stop de server.", "send_to_agent", {}),
]


def _example_messages() -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}]
    for context, text, tool, args in EXAMPLES:
        messages.append(_user({"recent": [], "tasks": [], **context}, text, detect_language(text)))
        messages.append(_call(tool, args))
        messages.append(_tool_result("Spoken." if tool == "reply" else "Done."))
    return messages


REPLY_SYSTEM = (
    "You are Delulu, a voice assistant for coding agents. Say the result to the user in Dutch, in the same short "
    "words. Keep names and quoted titles as they are."
)
# Executor results (English sentences from the Rust side) and how they sound in Dutch.
REPLY_EXAMPLES = [
    ("Sent to Claude Code.", "Doorgestuurd naar Claude Code."),
    ("Passed it on to Claude Code.", "Doorgegeven aan Claude Code."),
    ("No agent is listening right now.", "Er luistert nu geen agent."),
    ("Claude Code is working on \"Fix the search bug\".", "Claude Code is bezig met \"Fix the search bug\"."),
    ("Codex has not started \"Write the docs\" yet.", "Codex is nog niet begonnen aan \"Write the docs\"."),
    ("Claude Code is stuck on \"Fix the search bug\": needs the API key.",
     "Claude Code zit vast bij \"Fix the search bug\": needs the API key."),
    ("Claude Code finished \"Update the README\": Added the install steps.",
     "Claude Code is klaar met \"Update the README\": Added the install steps."),
    ("There are no open tasks.", "Er zijn geen open taken."),
    ("Cancel \"Fix the search bug\"? Say yes.", "\"Fix the search bug\" annuleren? Zeg ja."),
    ("Asked Claude Code to cancel \"Fix the search bug\".", "Ik heb Claude Code gevraagd \"Fix the search bug\" te annuleren."),
    ("Cancelled \"Write the docs\".", "\"Write the docs\" is geannuleerd."),
    ("Sent to Codex.", "Doorgestuurd naar Codex."),
    ("Claude Code is working on \"Run the tests\". Codex has not started \"Write the docs\" yet.",
     "Claude Code is bezig met \"Run the tests\". Codex is nog niet begonnen aan \"Write the docs\"."),
]
REPLY_SCHEMA = [schema for schema in TOOL_SCHEMAS if schema["function"]["name"] == "reply"]


def _reply_messages() -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": REPLY_SYSTEM}]
    for result, spoken in REPLY_EXAMPLES:
        messages += [{"role": "user", "content": result}, _call("reply", {"text": spoken}), _tool_result("Spoken.")]
    return messages


# --------------------------------------------------------------------- model

LEAD = "<tool_call>\n<function="


class Helper:
    """Prompt prefix cache, calibration priors and the last turn's state."""

    def __init__(self, worker: Any) -> None:
        import torch

        self.torch = torch
        self.model = worker.magic_model
        self.processor = worker.magic_processor
        self.tokenizer = worker.magic_processor.tokenizer
        self.device = worker.magic_device
        self.examples = _example_messages()
        self.reply_examples = _reply_messages()
        self.prefix_text, self.prefix_cache, self.prefix_tokens = self._prefix(self.examples, TOOL_SCHEMAS)
        self.reply_text, self.reply_cache, _ = self._prefix(self.reply_examples, REPLY_SCHEMA)
        self.priors: dict[tuple, dict[str, float]] = {}
        eos = self.model.generation_config.eos_token_id
        self.stop_tokens = set([eos] if isinstance(eos, int) else eos or [])
        self.stop_tokens.add(self.tokenizer.convert_tokens_to_ids("<|im_end|>"))

    def _render(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] = TOOL_SCHEMAS) -> str:
        return self.processor.apply_chat_template(messages, tools=tools, add_generation_prompt=True,
                                                  tokenize=False, enable_thinking=False)

    def _prefix(self, examples: list[dict[str, Any]], tools: list[dict[str, Any]]):
        # The template marks the turns after the last user message, so the
        # shared prefix ends where a final user message starts.
        probe = self._render(examples + [{"role": "user", "content": "N/A"}], tools)
        text = probe[:probe.rfind("<|im_start|>user\n")]
        ids = self._ids(text)
        with self.torch.inference_mode():
            cache = self.model(input_ids=ids, use_cache=True).past_key_values
        return text, cache, ids.shape[-1]

    def _suffix(self, prefix: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], lead: str) -> str:
        full = self._render(messages, tools) + lead
        if not full.startswith(prefix):
            raise ValueError("Helper prompt prefix changed")
        return full[len(prefix):]

    def _ids(self, text: str):
        ids = self.tokenizer(text, return_tensors="pt", add_special_tokens=False).input_ids
        if ids.shape[-1] > MAX_INPUT_TOKENS:
            raise ValueError("Helper prompt exceeds 8192 tokens")
        return ids.to(self.device)

    def _extend(self, cache: Any, text: str):
        """Run `text` on a copy of `cache`; returns the last logits and the new cache."""
        cache = copy.deepcopy(cache)
        with self.torch.inference_mode():
            out = self.model(input_ids=self._ids(text), past_key_values=cache, use_cache=True)
        return out.logits[0, -1].float().log_softmax(-1), out.past_key_values

    def _turn(self, context: dict[str, Any], text: str, language: str):
        """Cache and next-token log probabilities right after the forced `<function=` lead."""
        suffix = self._suffix(self.prefix_text, self.examples + [_user(context, text, language)], TOOL_SCHEMAS, LEAD)
        return self._extend(self.prefix_cache, suffix)

    def _score(self, cache: Any, first: Any, options: list[str]) -> list[float]:
        """Total log probability of each continuation, in one batched forward."""
        torch = self.torch
        encoded = [self.tokenizer(option, add_special_tokens=False).input_ids for option in options]
        scores = [first[ids[0]].item() for ids in encoded]
        longest = max(len(ids) for ids in encoded)
        if longest > 1:
            pad = self.tokenizer.pad_token_id or 0
            batch = torch.tensor([ids[:-1] + [pad] * (longest - len(ids)) for ids in encoded], device=self.device)
            expanded = copy.deepcopy(cache)
            expanded.reorder_cache(torch.zeros(len(options), dtype=torch.long, device=self.device))
            with torch.inference_mode():
                logits = self.model(input_ids=batch, past_key_values=expanded, use_cache=True).logits.float().log_softmax(-1)
            for row, ids in enumerate(encoded):
                scores[row] += sum(logits[row, index, token].item() for index, token in enumerate(ids[1:]))
        return scores

    def _generate(self, cache: Any, lead: str, limit: int = MAX_REPLY_TOKENS) -> str:
        """Greedy single-line text after `lead`, capped at `limit` tokens."""
        logits, cache = self._extend(cache, lead)
        tokens: list[int] = []
        text = ""
        with self.torch.inference_mode():
            for _ in range(limit):
                token = int(logits.argmax())
                if token in self.stop_tokens:
                    break
                tokens.append(token)
                text = self.tokenizer.decode(tokens, skip_special_tokens=True)
                if "\n" in text or "<" in text:
                    break
                out = self.model(input_ids=self.torch.tensor([[token]], device=self.device), past_key_values=cache, use_cache=True)
                cache = out.past_key_values
                logits = out.logits[0, -1].float()
        text = re.split(r"[\n<]", text, maxsplit=1)[0].strip()
        if not text:
            raise ValueError("Helper produced an empty reply")
        return text[:MAX_REPLY_CHARS]

    def _prior(self, context: dict[str, Any], names: list[str], language: str) -> dict[str, float]:
        shape = (tuple(names), bool(context.get("tasks")), min(len(context.get("agents", [])), 2),
                 bool(context.get("recent")), bool(context.get("pendingCancel")), language)
        if shape not in self.priors:
            first, cache = self._turn(context, "N/A", language)
            self.priors[shape] = dict(zip(names, self._score(cache, first, [name + ">" for name in names])))
        return self.priors[shape]

    def _arguments(self, cache: Any, name: str, context: dict[str, Any]) -> dict[str, str]:
        params = {"send_to_agent": ("agent", "task"), "task_status": ("task",), "cancel_task": ("task",)}.get(name, ())
        options: list[tuple[str, dict[str, str]]] = [] if name == "cancel_task" else [("</function>", {})]
        for param in params:
            for item in context.get("agents" if param == "agent" else "tasks", []):
                options.append((f"<parameter={param}>\n{item['id']}\n</parameter>\n</function>", {param: item["id"]}))
        if len(options) == 1:
            return options[0][1]
        first, cache = self._extend(cache, name + ">\n")
        scores = self._score(cache, first, [text for text, _ in options])
        return options[max(range(len(options)), key=scores.__getitem__)][1]

    def decide(self, text: str, context: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        language = detect_language(text, context.get("recent"))
        pending = context.get("pendingCancel")
        if pending and is_affirmative(text):
            return {"tool": "cancel_task", "args": {"task": pending}, "confirmed": True, "language": language,
                    "elapsedMs": round((time.perf_counter() - started) * 1000, 1)}
        # Anything but a yes drops the pending cancel; it is not asked again.
        names = [name for name in TOOLS if name != "cancel_task" or context.get("tasks") and not pending]
        first, cache = self._turn(context, text, language)
        scores = dict(zip(names, self._score(cache, first, [name + ">" for name in names])))
        prior = self._prior(context, names, language)
        name = max(names, key=lambda key: scores[key] - CALIBRATION * prior[key])
        if name == "reply":
            args = {"text": self._generate(cache, "reply>\n<parameter=text>\n")}
        else:
            args = self._arguments(cache, name, context)
            named = [agent["id"] for agent in context.get("agents", []) if _names(text, agent["label"])]
            if name == "send_to_agent" and "task" not in args and len(named) == 1:
                args["agent"] = named[0]
        return {"tool": name, "args": args, "language": language,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1)}

    def reply(self, text: str, context: dict[str, Any], result: str) -> dict[str, Any]:
        """The spoken sentence for a tool's result. Results are English sentences;
        other languages get them through a short cached prompt of their own."""
        started = time.perf_counter()
        result = " ".join(result.split())
        if detect_language(text, context.get("recent")) == "en":
            spoken = result if utf16_length(result) <= MAX_REPLY_CHARS else result[:MAX_REPLY_CHARS].rsplit(". ", 1)[0] + "."
        else:
            messages = self.reply_examples + [{"role": "user", "content": result}]
            suffix = self._suffix(self.reply_text, messages, REPLY_SCHEMA, LEAD + "reply>\n<parameter=text>\n")
            spoken = self._generate(self.reply_cache, suffix, MAX_TRANSLATION_TOKENS)
        return {"text": spoken, "elapsedMs": round((time.perf_counter() - started) * 1000, 1)}


def _helper(worker: Any) -> Helper:
    if worker.magic_model is None or worker.magic_processor is None or worker.magic_model_name not in MODELS:
        raise RuntimeError("Load the helper model first")
    helper = getattr(worker, "coordinator_helper", None)
    if helper is None or helper.model is not worker.magic_model:
        helper = Helper(worker)
        worker.coordinator_helper = helper
    return helper


def prepare(worker: Any) -> None:
    """Build the prompt prefix cache at load so the first turn is fast."""
    _helper(worker)


def decide(worker: Any, request: dict[str, Any]) -> dict[str, Any]:
    validate_coordinator_request(request)
    result = _helper(worker).decide(request["text"], request["context"])
    validate_decision(result, request["context"])
    worker.magic_warmup = "complete"
    return result


def reply(worker: Any, request: dict[str, Any]) -> dict[str, Any]:
    validate_coordinator_request(request)
    result = _helper(worker).reply(request["text"], request["context"], request["result"])
    validate_reply(result)
    return result
