"""Status and stop tools for the HermesFLLM router (a FreeLLMAPI fork).

The server itself is kept running by a launchd agent (``io.github.hermesfllm``, installed from
``scripts/launchd/``): it starts at login and restarts if it dies, so it is already up before
Hermes probes ``/v1/models``. Starting it from Hermes hooks was dropped because the hooks only run
in the process that serves the conversation, and a second starter would race launchd for the port.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request

TOOLSET = "hermesfllm"
LABEL = os.environ.get("HERMESFLLM_LAUNCHD_LABEL", "io.github.hermesfllm")


def _url() -> str:
    return os.environ.get("HERMESFLLM_URL", "http://127.0.0.1:3001").rstrip("/")


def _healthy(url: str, timeout: float = 2.0) -> bool:
    # /api/ping, not /health: the dashboard answers 200 to any unknown path.
    try:
        with urllib.request.urlopen(url + "/api/ping", timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


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
    return json.dumps({"healthy": _healthy(url), "url": url, "launchd": _launchd_state()})


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
    "description": "Report whether the local HermesFLLM router answers /api/ping and the state of its launchd agent.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

STOP_SCHEMA = {
    "name": "hermesfllm_stop",
    "description": "Stop the local HermesFLLM router by unloading its launchd agent (it stays stopped until it is bootstrapped again or the next login).",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


def register(ctx) -> None:
    """Plugin entry point, called by the Hermes plugin loader."""
    ctx.register_tool(name="hermesfllm_status", toolset=TOOLSET, schema=STATUS_SCHEMA, handler=_handle_status, emoji="🛰️")
    ctx.register_tool(name="hermesfllm_stop", toolset=TOOLSET, schema=STOP_SCHEMA, handler=_handle_stop, emoji="🛑")


__all__ = ["register"]
