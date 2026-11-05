"""Status and stop tools for the HermesFLLM router (a FreeLLMAPI fork), and the agent's feedback.

The server itself is kept running by a launchd agent (``io.github.hermesfllm``, installed from
``scripts/launchd/``): it starts at login and restarts if it dies, so it is already up before
Hermes probes ``/v1/models``. Starting it from Hermes hooks was dropped because the hooks only run
in the process that serves the conversation, and a second starter would race launchd for the port.

Feedback: the router sees whether a model answered, not what the agent did with the answer. Hooks
(post_api_request, post_tool_call, on_session_end) let this plugin tell it: which model served each
API call, whether every tool call that model asked for ran or failed, and how each turn ended. Only
model ids, tool names, outcome words and error types are sent, never arguments, results or messages,
from a background thread with short timeouts, so the agent loop never waits on it.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict

TOOLSET = "hermesfllm"
LABEL = os.environ.get("HERMESFLLM_LAUNCHD_LABEL", "io.github.hermesfllm")


# 3002 is the port the README quick start installs HermesFLLM on; 3001 is upstream FreeLLMAPI's.
DEFAULT_URL = "http://127.0.0.1:3002"


def _url() -> str:
    return os.environ.get("HERMESFLLM_URL", DEFAULT_URL).rstrip("/")


def _probe(url: str, timeout: float = 2.0) -> dict:
    """Healthy only if the server at `url` identifies itself as HermesFLLM.

    /api/ping would also answer on an unmodified FreeLLMAPI (often on the neighbouring port), and the
    dashboard answers 200 with HTML to any unknown path, so the check reads the fork-only JSON
    endpoint /api/hermesfllm/version and requires its name.
    """
    try:
        with urllib.request.urlopen(url + "/api/hermesfllm/version", timeout=timeout) as response:
            if not 200 <= response.status < 300:
                return {"healthy": False, "error": f"HTTP {response.status}"}
            body = json.loads(response.read().decode("utf-8"))
    except ValueError:
        return {"healthy": False, "error": "not a HermesFLLM server (no version JSON); check HERMESFLLM_URL"}
    except Exception as exc:
        return {"healthy": False, "error": str(exc)[:200]}
    if not isinstance(body, dict) or body.get("name") != "HermesFLLM":
        return {"healthy": False, "error": "not a HermesFLLM server; check HERMESFLLM_URL"}
    return {"healthy": True, "version": body.get("version"), "commit": body.get("commit")}


def _run(args: list[str], timeout: float = 15) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


def _service() -> str:
    return f"gui/{os.getuid()}/{LABEL}"


def _launchd_state() -> dict:
    try:
        done = _run(["launchctl", "print", _service()])
    except (OSError, subprocess.SubprocessError) as exc:
        return {"loaded": False, "error": str(exc)}
    if done.returncode != 0:
        return {"loaded": False}
    fields = {}
    for line in done.stdout.splitlines():
        key, sep, value = line.strip().partition(" = ")
        if sep and key in ("state", "pid", "runs") and key not in fields:
            fields[key] = value
    return {"loaded": True, **fields}


def _handle_status(args: dict, **_kw) -> str:
    url = _url()
    return json.dumps({**_probe(url), "url": url, "launchd": _launchd_state(), "feedback": _feedback.stats()})


def _handle_stop(args: dict, **_kw) -> str:
    # bootout, not kill: launchd's KeepAlive would restart a killed server within seconds.
    try:
        done = _run(["launchctl", "bootout", _service()], timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return json.dumps({"stopped": False, "error": str(exc)})
    if done.returncode != 0:
        return json.dumps({"stopped": False, "error": (done.stderr or done.stdout).strip()[-500:]})
    plist = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
    return json.dumps({"stopped": True, "restart_with": f"launchctl bootstrap gui/{os.getuid()} {plist}"})


STATUS_SCHEMA = {
    "name": "hermesfllm_status",
    "description": "Report whether the local HermesFLLM router is up (and its version) and the state of its launchd agent.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

STOP_SCHEMA = {
    "name": "hermesfllm_stop",
    "description": "Stop the local HermesFLLM router by unloading its launchd agent (it stays stopped until it is bootstrapped again or the next login).",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


# ── Feedback ─────────────────────────────────────────────────────────────────

FEEDBACK_PATH = "/v1/hermesfllm/feedback"
_TRACK_LIMIT = 2000
_QUEUE_LIMIT = 2000
_BATCH = 100
_BATCH_WINDOW_S = 2.0
_POST_TIMEOUT_S = 3.0


def _feedback_enabled(env=None) -> bool:
    raw = (env if env is not None else os.environ).get("HERMESFLLM_FEEDBACK", "").strip().lower()
    return raw not in ("0", "false", "off")


def _netloc(url: str) -> str:
    parsed = urllib.parse.urlparse(url or "")
    host = (parsed.hostname or "").lower()
    if host in ("localhost", "::1", "0.0.0.0"):
        host = "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return f"{host}:{port}"


class _Feedback:
    """Remembers which model served each HermesFLLM API call and queues what happened next."""

    def __init__(self, url_fn=_url, key_fn=lambda: os.environ.get("HERMESFLLM_API_KEY", ""), post=None):
        self._url_fn = url_fn
        self._key_fn = key_fn
        self._post = post or self._http_post
        self._lock = threading.Lock()
        self._model_by_call: "OrderedDict[str, str]" = OrderedDict()
        self._models_by_turn: "OrderedDict[str, set]" = OrderedDict()
        self.queue: "queue.Queue[dict]" = queue.Queue(maxsize=_QUEUE_LIMIT)
        self.sent = 0
        self.dropped = 0
        self.last_error = None
        self._thread = None

    # Hook callbacks: every one accepts **kwargs and never raises.

    def on_post_api_request(self, **kw) -> None:
        try:
            if not self._is_router(kw.get("base_url"), kw.get("provider")):
                return
            model = kw.get("response_model") or kw.get("model")
            call_id = kw.get("api_request_id")
            if not model or not call_id:
                return
            with self._lock:
                self._remember(self._model_by_call, str(call_id), str(model))
                turn = kw.get("turn_id")
                if turn:
                    models = self._models_by_turn.get(str(turn)) or set()
                    models.add(str(model))
                    self._remember(self._models_by_turn, str(turn), models)
        except Exception:  # noqa: BLE001 - a hook must never break the agent
            pass

    def on_post_tool_call(self, **kw) -> None:
        try:
            call_id = kw.get("api_request_id")
            with self._lock:
                model = self._model_by_call.get(str(call_id)) if call_id else None
            if not model:
                return
            outcome = str(kw.get("status") or ("error" if kw.get("error_type") else "ok")).lower()
            self._enqueue({
                "kind": "tool", "modelId": model, "outcome": outcome,
                "toolName": kw.get("tool_name"), "errorType": kw.get("error_type"),
                "sessionId": kw.get("session_id"), "turnId": kw.get("turn_id"),
            })
        except Exception:  # noqa: BLE001
            pass

    def on_session_end(self, **kw) -> None:
        try:
            turn = kw.get("turn_id")
            if not turn:
                return
            with self._lock:
                models = self._models_by_turn.pop(str(turn), None)
            if not models:
                return
            if kw.get("failed"):
                outcome = "failed"
            elif kw.get("interrupted"):
                outcome = "interrupted"
            elif kw.get("completed"):
                outcome = "completed"
            else:
                return
            for model in sorted(models):
                self._enqueue({"kind": "turn", "modelId": model, "outcome": outcome,
                               "sessionId": kw.get("session_id"), "turnId": str(turn)})
        except Exception:  # noqa: BLE001
            pass

    # Internals

    def _is_router(self, base_url, provider) -> bool:
        if base_url:
            return _netloc(str(base_url)) == _netloc(self._url_fn())
        return str(provider or "").lower() == "hermesfllm"

    @staticmethod
    def _remember(store: "OrderedDict", key: str, value) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > _TRACK_LIMIT:
            store.popitem(last=False)

    def _enqueue(self, event: dict) -> None:
        try:
            self.queue.put_nowait({k: v for k, v in event.items() if v is not None})
        except queue.Full:
            self.dropped += 1
            return
        self._ensure_sender()

    def _ensure_sender(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="hermesfllm-feedback", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            batch = [self.queue.get()]
            deadline = time.monotonic() + _BATCH_WINDOW_S
            while len(batch) < _BATCH:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    batch.append(self.queue.get(timeout=remaining))
                except queue.Empty:
                    break
            self.flush(batch)

    def flush(self, batch: list) -> None:
        key = self._key_fn()
        if not key:
            self.dropped += len(batch)
            self.last_error = "HERMESFLLM_API_KEY is not set"
            return
        try:
            self._post(self._url_fn() + FEEDBACK_PATH, key, {"events": batch})
            self.sent += len(batch)
            self.last_error = None
        except Exception as exc:  # noqa: BLE001 - feedback is best effort
            self.dropped += len(batch)
            self.last_error = str(exc)[:200]

    @staticmethod
    def _http_post(url: str, key: str, payload: dict) -> None:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=_POST_TIMEOUT_S) as response:
            response.read()

    def stats(self) -> dict:
        return {"enabled": _feedback_enabled(), "sent": self.sent, "dropped": self.dropped,
                "queued": self.queue.qsize(), "last_error": self.last_error}


_feedback = _Feedback()

FEEDBACK_HOOKS = (
    ("post_api_request", "on_post_api_request"),
    ("post_tool_call", "on_post_tool_call"),
    ("on_session_end", "on_session_end"),
)


def register(ctx) -> None:
    """Plugin entry point, called by the Hermes plugin loader."""
    ctx.register_tool(name="hermesfllm_status", toolset=TOOLSET, schema=STATUS_SCHEMA, handler=_handle_status, emoji="🛰️")
    ctx.register_tool(name="hermesfllm_stop", toolset=TOOLSET, schema=STOP_SCHEMA, handler=_handle_stop, emoji="🛑")
    if not _feedback_enabled():
        return
    for hook, method in FEEDBACK_HOOKS:
        try:
            ctx.register_hook(hook, getattr(_feedback, method))
        except Exception:  # noqa: BLE001 - an older Hermes without this hook keeps the tools working
            pass


__all__ = ["register"]
