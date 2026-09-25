#!/usr/bin/env python3
"""Prove the skill manager's real V2 model context with a local fake provider.

This deliberately makes no external model request. The fake provider records the
OpenAI-compatible request, returns one local tool call, and then records the
follow-up containing that tool's result.

Build plugins/skill-manager first, then run:
    python3 scripts/verify-skill-context.py --keep
"""

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class FakeProvider(BaseHTTPRequestHandler):
    requests = []
    calls = 0
    model = "context-proof"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        FakeProvider.requests.append(body)
        FakeProvider.calls += 1
        if FakeProvider.calls == 1:
            tools = body.get("tools", [])
            names = [tool.get("function", {}).get("name", "") for tool in tools]
            candidates = [name for name in names if "search" in name.lower()]
            if not candidates:
                candidates = [name for name in names if "skill" in name.lower()]
            require(candidates, f"No skill discovery tool in outgoing tools: {names}")
            reply = {
                "id": "context-proof-call",
                "object": "chat.completion",
                "created": 1,
                "model": FakeProvider.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "context-proof-tool-call",
                                    "type": "function",
                                    "function": {
                                        "name": candidates[0],
                                        "arguments": json.dumps({"query": "router"}),
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        else:
            reply = {
                "id": "context-proof-done",
                "object": "chat.completion",
                "created": 1,
                "model": FakeProvider.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "CONTEXT_PROOF_OK"},
                        "finish_reason": "stop",
                    }
                ],
            }
        encoded = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


@contextmanager
def fake_provider():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def load_harness(checkout):
    path = checkout / "scripts/verify-skill-manager.py"
    spec = importlib.util.spec_from_file_location("manager", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(args, root):
    checkout = args.checkout.resolve()
    manager = load_harness(checkout)
    plugin = checkout / "plugins/skill-manager"
    require(
        (plugin / "dist/index.js").is_file(),
        f"Build the skill manager first: {plugin / 'dist/index.js'}",
    )
    env = manager.isolated_env(root)
    env.update(
        {
            "CONTEXT_PROOF_KEY": "local-context-proof-key",
            "OPENCODE_DISABLE_UPDATE_CHECK": "true",
        }
    )
    project = root / "project"
    project.mkdir()
    subprocess.run(["git", "init", "--quiet", str(project)], env=env, check=True)
    with fake_provider() as base_url:
        config = {
            "plugins": [{"package": str(plugin)}],
            "providers": {
                "context-proof": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Local context proof",
                    "options": {
                        "baseURL": base_url,
                        "apiKey": "{env:CONTEXT_PROOF_KEY}",
                    },
                    "models": {FakeProvider.model: {"name": "Context proof"}},
                }
            },
        }
        (project / "opencode.json").write_text(json.dumps(config))
        with manager.v2_server(args.opencode, root, env) as request:
            registry = manager.catalogue(request, project, args.plugin_id)
            managed = [
                s
                for s in registry
                if Path(s.get("path", "")).resolve().is_relative_to(checkout)
            ]
            descriptions = [
                s.get("description", "") for s in managed if s.get("description")
            ]
            require(managed, "No managed skills were registered")
            session = request(
                "/api/session",
                project,
                {
                    "title": "skill context verification",
                    "model": {
                        "providerID": "context-proof",
                        "modelID": FakeProvider.model,
                    },
                    "location": {"directory": str(project)},
                },
            )["data"]
            session_id = session["id"]
            result = request(
                f"/api/session/{session_id}/prompt",
                project,
                {
                    "parts": [{"type": "text", "text": "Find the router skill."}],
                    "model": {
                        "providerID": "context-proof",
                        "modelID": FakeProvider.model,
                    },
                },
            )
            require(
                "CONTEXT_PROOF_OK" in json.dumps(result),
                f"Prompt did not complete: {result}",
            )
        require(FakeProvider.requests, "Fake provider received no request")
        first = FakeProvider.requests[0]
        encoded = json.dumps(first)
        require(
            "CONTEXT_PROOF_OK" not in encoded,
            "Provider request unexpectedly contained the answer",
        )
        leaked = [
            description
            for description in descriptions
            if description and description in encoded
        ]
        require(
            not leaked,
            f"Managed skill descriptions leaked into model context: {leaked[:3]}",
        )
        tools = first.get("tools", [])
        require(tools, f"No tool definitions were sent: {first.keys()}")
        names = [tool.get("function", {}).get("name", "") for tool in tools]
        discovery = [
            name
            for name in names
            if "search" in name.lower() or "skill" in name.lower()
        ]
        require(discovery, f"No skill router/search tool was sent: {names}")
        followups = FakeProvider.requests[1:]
        require(followups, "Discovery tool call did not produce a follow-up request")
        tool_messages = [
            m for m in followups[0].get("messages", []) if m.get("role") == "tool"
        ]
        require(tool_messages, "Follow-up omitted the discovery tool result")
        result_text = json.dumps(tool_messages)
        require(
            "router" in result_text.lower(),
            f"Discovery result did not contain router metadata: {result_text}",
        )
        evidence = {
            "requests": FakeProvider.requests,
            "managed_count": len(managed),
            "discovery_tools": discovery,
        }
        (root / "context-evidence.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )
        print(
            f"PASS: real outgoing context captured; {len(managed)} managed descriptions absent; router tool invoked locally"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkout", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--opencode", default=shutil.which("opencode"))
    parser.add_argument("--plugin-id", action="append", default=None)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    if not args.opencode:
        parser.error("opencode was not found; pass --opencode")
    args.opencode = str(Path(args.opencode).absolute())
    args.plugin_id = args.plugin_id or [
        "ai-config",
        "skill-manager",
        "ai-config.skill-manager",
    ]
    root = Path(tempfile.mkdtemp(prefix="verify-skill-context-", dir="/tmp/opencode"))
    try:
        verify(args, root)
    except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if args.keep:
            print(f"Evidence: {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
