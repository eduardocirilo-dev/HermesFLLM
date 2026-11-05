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
    def test_registers_the_tools_and_the_feedback_hooks(self):
        ctx = mock.Mock()
        with mock.patch.dict(plugin.os.environ, {}, clear=True):
            plugin.register(ctx)
        self.assertEqual({c.kwargs["name"] for c in ctx.register_tool.call_args_list}, {"hermesfllm_status", "hermesfllm_stop"})
        self.assertEqual([c.args[0] for c in ctx.register_hook.call_args_list], ["post_api_request", "post_tool_call", "on_session_end"])

    def test_feedback_can_be_turned_off(self):
        ctx = mock.Mock()
        with mock.patch.dict(plugin.os.environ, {"HERMESFLLM_FEEDBACK": "0"}, clear=True):
            plugin.register(ctx)
        ctx.register_hook.assert_not_called()

    def test_an_older_hermes_without_a_hook_still_gets_the_tools(self):
        ctx = mock.Mock()
        ctx.register_hook.side_effect = ValueError("unknown hook")
        with mock.patch.dict(plugin.os.environ, {}, clear=True):
            plugin.register(ctx)
        self.assertEqual(ctx.register_tool.call_count, 2)


ROUTER = "http://127.0.0.1:3002/v1"


def make_feedback(key="sk-test"):
    posts = []
    fb = plugin._Feedback(url_fn=lambda: "http://127.0.0.1:3002", key_fn=lambda: key, post=lambda url, k, payload: posts.append((url, k, payload)))
    fb._ensure_sender = lambda: None  # tests drain the queue themselves
    return fb, posts


def drain(fb):
    events = []
    while not fb.queue.empty():
        events.append(fb.queue.get_nowait())
    return events


class FeedbackTests(unittest.TestCase):
    def test_a_tool_outcome_is_attributed_to_the_model_that_asked_for_it(self):
        fb, _ = make_feedback()
        fb.on_post_api_request(api_request_id="r1", turn_id="t1", base_url=ROUTER, response_model="poolside/laguna-xs-2.1", model="autoTOP-hermes")
        fb.on_post_tool_call(api_request_id="r1", tool_name="read_file", status="error", error_type="FileNotFoundError",
                             args={"path": "/secret"}, result="contents", error_message="no such file /secret", session_id="s1", turn_id="t1")
        self.assertEqual(drain(fb), [{"kind": "tool", "modelId": "poolside/laguna-xs-2.1", "outcome": "error",
                                      "toolName": "read_file", "errorType": "FileNotFoundError", "sessionId": "s1", "turnId": "t1"}])

    def test_calls_to_other_providers_are_ignored(self):
        fb, _ = make_feedback()
        fb.on_post_api_request(api_request_id="r1", base_url="https://api.openai.com/v1", response_model="gpt-x")
        fb.on_post_tool_call(api_request_id="r1", tool_name="read_file", status="ok")
        self.assertEqual(drain(fb), [])

    def test_localhost_and_127_0_0_1_are_the_same_router(self):
        fb, _ = make_feedback()
        fb.on_post_api_request(api_request_id="r1", base_url="http://localhost:3002/v1", response_model="m1")
        fb.on_post_tool_call(api_request_id="r1", tool_name="t", status="ok")
        self.assertEqual(len(drain(fb)), 1)

    def test_a_turn_outcome_goes_to_every_model_that_served_the_turn(self):
        fb, _ = make_feedback()
        fb.on_post_api_request(api_request_id="r1", turn_id="t9", base_url=ROUTER, response_model="m1")
        fb.on_post_api_request(api_request_id="r2", turn_id="t9", base_url=ROUTER, response_model="m2")
        fb.on_session_end(turn_id="t9", session_id="s1", completed=False, failed=True, interrupted=False)
        self.assertEqual([(e["modelId"], e["outcome"]) for e in drain(fb)], [("m1", "failed"), ("m2", "failed")])
        fb.on_session_end(turn_id="t9", completed=True)  # already reported
        self.assertEqual(drain(fb), [])

    def test_hooks_never_raise(self):
        fb, _ = make_feedback()
        fb.on_post_api_request(api_request_id=object(), base_url=12345, response_model=None)
        fb.on_post_tool_call()
        fb.on_session_end(turn_id=None)

    def test_flush_posts_the_batch_with_the_router_key(self):
        fb, posts = make_feedback()
        fb.flush([{"kind": "tool", "modelId": "m1", "outcome": "ok"}])
        self.assertEqual(posts, [("http://127.0.0.1:3002/v1/hermesfllm/feedback", "sk-test", {"events": [{"kind": "tool", "modelId": "m1", "outcome": "ok"}]})])
        self.assertEqual(fb.stats()["sent"], 1)

    def test_without_a_key_events_are_dropped_and_the_status_says_why(self):
        fb, posts = make_feedback(key="")
        fb.flush([{"kind": "tool", "modelId": "m1", "outcome": "ok"}])
        self.assertEqual(posts, [])
        self.assertEqual(fb.stats()["dropped"], 1)
        self.assertIn("HERMESFLLM_API_KEY", fb.stats()["last_error"])

    def test_a_router_that_is_down_costs_nothing_but_the_batch(self):
        fb = plugin._Feedback(url_fn=lambda: "http://127.0.0.1:3002", key_fn=lambda: "k", post=mock.Mock(side_effect=OSError("Connection refused")))
        fb.flush([{"kind": "tool", "modelId": "m1", "outcome": "ok"}])
        self.assertEqual(fb.stats()["dropped"], 1)
        self.assertIn("Connection refused", fb.stats()["last_error"])

    def test_the_background_sender_delivers_queued_events(self):
        posts = []
        fb = plugin._Feedback(url_fn=lambda: "http://127.0.0.1:3002", key_fn=lambda: "k", post=lambda url, k, payload: posts.append(payload))
        fb.on_post_api_request(api_request_id="r1", base_url=ROUTER, response_model="m1")
        fb.on_post_tool_call(api_request_id="r1", tool_name="t", status="ok")
        for _ in range(50):
            if posts:
                break
            plugin.time.sleep(0.1)
        self.assertEqual(posts, [{"events": [{"kind": "tool", "modelId": "m1", "outcome": "ok", "toolName": "t"}]}])


if __name__ == "__main__":
    unittest.main()
