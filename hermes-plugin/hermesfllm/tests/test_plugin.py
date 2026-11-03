import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location("hermesfllm_plugin", Path(__file__).resolve().parents[1] / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)


def done(code=0, out="", err=""):
    return subprocess.CompletedProcess([], code, out, err)


LAUNCHCTL_PRINT = """gui/501/io.github.hermesfllm = {
	active count = 1
	state = running
	runs = 5
	pid = 90617
	endpoints = {
		state = active
	}
}"""


class StatusTests(unittest.TestCase):
    def test_reports_health_and_launchd_fields(self):
        with mock.patch.object(plugin, "_probe", return_value={"healthy": True, "version": "0.7.2", "commit": "abc1234"}), \
             mock.patch.object(plugin, "_run", return_value=done(0, LAUNCHCTL_PRINT)):
            result = json.loads(plugin._handle_status({}))
        self.assertTrue(result["healthy"])
        self.assertEqual(result["version"], "0.7.2")
        # First "state =" wins: the nested endpoints block must not overwrite it.
        self.assertEqual(result["launchd"], {"loaded": True, "state": "running", "runs": "5", "pid": "90617"})

    def test_agent_not_loaded(self):
        with mock.patch.object(plugin, "_probe", return_value={"healthy": False}), mock.patch.object(plugin, "_run", return_value=done(113)):
            result = json.loads(plugin._handle_status({}))
        self.assertEqual(result["launchd"], {"loaded": False})


class _Response:
    def __init__(self, body: bytes, status: int = 200):
        self.status, self._body = status, body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ProbeTests(unittest.TestCase):
    def test_default_url_is_the_hermesfllm_port_not_freellmapis(self):
        with mock.patch.dict(plugin.os.environ, {}, clear=True):
            self.assertEqual(plugin._url(), "http://127.0.0.1:3002")

    def test_hermesfllm_is_healthy_and_reports_its_version(self):
        body = b'{"name": "HermesFLLM", "version": "0.7.2", "commit": "abc1234"}'
        with mock.patch.object(plugin.urllib.request, "urlopen", return_value=_Response(body)) as urlopen:
            result = plugin._probe("http://127.0.0.1:3002")
        self.assertEqual(result, {"healthy": True, "version": "0.7.2", "commit": "abc1234"})
        self.assertTrue(urlopen.call_args[0][0].endswith("/api/hermesfllm/version"))

    def test_upstream_freellmapi_is_not_mistaken_for_hermesfllm(self):
        # An unmodified FreeLLMAPI serves its dashboard HTML (200) for the unknown path.
        with mock.patch.object(plugin.urllib.request, "urlopen", return_value=_Response(b"<!doctype html><html></html>")):
            result = plugin._probe("http://127.0.0.1:3001")
        self.assertFalse(result["healthy"])
        self.assertIn("HERMESFLLM_URL", result["error"])

    def test_other_json_is_not_hermesfllm(self):
        with mock.patch.object(plugin.urllib.request, "urlopen", return_value=_Response(b'{"name": "something else"}')):
            self.assertFalse(plugin._probe("http://127.0.0.1:3002")["healthy"])

    def test_unreachable_server(self):
        with mock.patch.object(plugin.urllib.request, "urlopen", side_effect=OSError("Connection refused")):
            result = plugin._probe("http://127.0.0.1:3002")
        self.assertFalse(result["healthy"])
        self.assertIn("Connection refused", result["error"])


class StopTests(unittest.TestCase):
    def test_unloads_the_agent_instead_of_killing(self):
        with mock.patch.object(plugin, "_run", return_value=done()) as run:
            result = json.loads(plugin._handle_stop({}))
        self.assertTrue(result["stopped"])
        args = run.call_args[0][0]
        self.assertEqual(args[:2], ["launchctl", "bootout"])
        self.assertTrue(args[2].endswith("/io.github.hermesfllm"))

    def test_reports_launchctl_failure(self):
        with mock.patch.object(plugin, "_run", return_value=done(3, err="No such process")):
            result = json.loads(plugin._handle_stop({}))
        self.assertFalse(result["stopped"])
        self.assertIn("No such process", result["error"])


class RegisterTests(unittest.TestCase):
    def test_registers_tools_only(self):
        ctx = mock.Mock()
        plugin.register(ctx)
        ctx.register_hook.assert_not_called()
        self.assertEqual({c.kwargs["name"] for c in ctx.register_tool.call_args_list}, {"hermesfllm_status", "hermesfllm_stop"})


if __name__ == "__main__":
    unittest.main()
