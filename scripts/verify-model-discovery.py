#!/usr/bin/env python3
"""Exercise the discovery plugin in isolated OpenCode V1 and V2 hosts."""

import argparse
import base64
import json
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = "local-discovery-verification-token"
MODEL = "fixture/chat-model"
PROVIDERS = ["discovery-test", "unlisted", "manual"]


class Endpoint(BaseHTTPRequestHandler):
    discovery_requests = 0
    inference_requests = 0
    paths = []

    def log_message(self, *_args):
        pass

    def authorised(self):
        if self.headers.get("Authorization") == f"Bearer {TOKEN}":
            return True
        self.send_error(401)
        return False

    def do_GET(self):
        if not self.authorised():
            return
        Endpoint.paths.append(self.path)
        Endpoint.discovery_requests += 1
        if self.path != "/v1/models":
            self.send_error(404)
            return
        body = json.dumps(
            {
                "object": "list",
                "data": [
                    {
                        "id": MODEL,
                        "context_length": 65536,
                        "max_output_tokens": 8192,
                    },
                    {"id": "minimal-model"},
                ],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.authorised():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/v1/chat/completions" or body.get("model") != MODEL:
            self.send_error(400)
            return
        Endpoint.inference_requests += 1
        self.send_response(200)
        if not body.get("stream"):
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "id": "chatcmpl-discovery-test",
                        "object": "chat.completion",
                        "created": 1,
                        "model": MODEL,
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "DISCOVERY_OK",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 1,
                            "completion_tokens": 1,
                            "total_tokens": 2,
                        },
                    }
                ).encode()
            )
            return
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for delta, finish in [
            ({"role": "assistant", "content": "DISCOVERY_OK"}, None),
            ({}, "stop"),
        ]:
            chunk = {
                "id": "chatcmpl-discovery-test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": MODEL,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.close_connection = True


def run(binary, args, directory, env):
    process = subprocess.Popen(
        [binary, *args],
        cwd=directory,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError(
            f"{Path(binary).name} {' '.join(args)} exited {process.returncode}\n"
            f"{stdout}\n{stderr}"
        )
    return stdout


@contextmanager
def v2_server(binary, directory, env):
    with (directory / "server.log").open("w") as log:
        process = subprocess.Popen(
            [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
            cwd=directory,
            env=env,
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
            start_new_session=True,
        )
        lines = queue.Queue()

        def capture():
            for line in process.stdout:
                lines.put(line)

        reader = threading.Thread(target=capture, daemon=True)
        reader.start()
        try:
            url = password = None
            deadline = time.monotonic() + 30
            while url is None or password is None:
                line = lines.get(timeout=max(0.01, deadline - time.monotonic())).strip()
                if line.startswith("server listening on "):
                    url = line.removeprefix("server listening on ")
                elif line.startswith("server password "):
                    password = line.removeprefix("server password ")
            auth = base64.b64encode(f"opencode:{password}".encode()).decode()

            def request(path, body=None):
                req = urllib.request.Request(
                    url + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={
                        "Authorization": f"Basic {auth}",
                        "x-opencode-directory": str(directory),
                        "Content-Type": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=60) as response:
                    return json.load(response)

            deadline = time.monotonic() + 60
            while True:
                plugins = request("/api/plugin")["data"]
                loaded = next(
                    (p for p in plugins if p.get("id") == "model-discovery"), None
                )
                configured = next(
                    (p for p in plugins if p.get("id") == "opencode.config.provider"),
                    None,
                )
                if (
                    loaded
                    and loaded["state"]["status"] == "active"
                    and configured
                    and configured["state"]["status"] == "active"
                ):
                    break
                if loaded and loaded["state"]["status"] == "failed":
                    raise RuntimeError(f"Plugin failed: {loaded}")
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Plugin did not activate: {plugins}")
                time.sleep(0.1)
            yield request
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            reader.join(timeout=5)
            process.stdout.close()


def verify(binary, version, plugin, base_url, root):
    directory = root / version
    directory.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_")}
    env.update(
        PWD=str(directory),
        HOME=str(directory / "home"),
        XDG_CONFIG_HOME=str(directory / "config"),
        XDG_DATA_HOME=str(directory / "data"),
        XDG_CACHE_HOME=str(directory / "cache"),
        XDG_STATE_HOME=str(directory / "state"),
        DISCOVERY_TEST_KEY=TOKEN,
        OPENCODE_DISABLE_UPDATE_CHECK="true",
    )
    source = {
        "id": "discovery-test",
        "baseURL": base_url,
        "apiKeyEnv": "DISCOVERY_TEST_KEY",
    }
    options = {
        "sources": [
            source,
            {
                **source,
                "id": "unlisted",
                "modelsURL": f"{base_url}/unpublished",
                "models": [MODEL, "minimal-model"],
            },
            {
                **source,
                "id": "manual",
                "discovery": False,
                "modelsURL": f"{base_url}/must-not-request",
                "models": [MODEL, "minimal-model"],
            },
        ]
    }
    if version == "v1-legacy":
        config = {"plugin": [plugin.with_name("legacy.js").as_uri()]}
        env["OPENCODE_MODEL_DISCOVERY"] = json.dumps(options)
    elif version == "v1":
        config = {"plugin": [[plugin.as_uri(), options]]}
    else:
        config = {"plugins": [{"package": str(plugin.parent), "options": options}]}
        config["providers"] = {
            "discovery-test": {
                "models": {
                    "minimal-model": {
                        "name": "Manual override",
                        "limit": {"context": 9000, "output": 2000},
                        "capabilities": {
                            "tools": False,
                            "input": ["text"],
                            "output": ["text"],
                        },
                    }
                }
            }
        }
    (directory / "opencode.json").write_text(json.dumps(config))
    before = Endpoint.discovery_requests
    before_inference = Endpoint.inference_requests
    before_paths = len(Endpoint.paths)
    if version == "v1":
        catalogue = run(binary, ["models"], directory, env)
        for provider in PROVIDERS:
            found = {
                line.removeprefix(f"{provider}/")
                for line in catalogue.splitlines()
                if line.startswith(f"{provider}/")
            }
            assert found == {MODEL, "minimal-model"}, (provider, found)
    if version == "v2":
        with v2_server(binary, directory, env) as request:
            catalogue = request("/api/model")
            for provider in PROVIDERS:
                entries = [m for m in catalogue["data"] if m["providerID"] == provider]
                assert {m["id"] for m in entries} == {MODEL, "minimal-model"}, (
                    provider,
                    entries,
                )
                assert all(m["enabled"] for m in entries), (provider, entries)
            models = {
                m["id"]: m
                for m in catalogue["data"]
                if m["providerID"] == "discovery-test"
            }
            assert models[MODEL]["limit"]["context"] == 65536, models
            assert "minimal-model" in models, models
            assert models["minimal-model"]["name"] == "Manual override", models
            assert models["minimal-model"]["limit"]["context"] == 9000, models
            assert models["minimal-model"]["capabilities"]["tools"] is False, models
            for provider in PROVIDERS:
                session = request(
                    "/api/session",
                    {
                        "title": "Model discovery verification",
                        "model": {"providerID": provider, "id": MODEL},
                        "location": {"directory": str(directory)},
                    },
                )
                result = request(
                    f"/api/session/{session['data']['id']}/generate",
                    {"prompt": "Reply with the verification marker."},
                )
                assert result["data"]["text"] == "DISCOVERY_OK", result
    else:
        for provider in PROVIDERS:
            output = run(
                binary,
                [
                    "run",
                    "--model",
                    f"{provider}/{MODEL}",
                    "--format",
                    "json",
                    "Reply with the verification marker.",
                ],
                directory,
                env,
            )
            assert "DISCOVERY_OK" in output, output
    assert Endpoint.discovery_requests > before, "Host did not query /models"
    assert Endpoint.inference_requests >= before_inference + len(PROVIDERS), (
        "Host did not call the discovered model"
    )
    paths = Endpoint.paths[before_paths:]
    assert "/v1/models" in paths, paths
    assert "/v1/unpublished" in paths, paths
    assert "/v1/must-not-request" not in paths, paths
    print(
        f"PASS {version}: all models enabled; inference works with discovery, unavailable catalogue, and manual models"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v1", required=True, help="Path to an OpenCode V1 binary")
    parser.add_argument("--v2", required=True, help="Path to an OpenCode V2 binary")
    parser.add_argument("--legacy", help="Optional path to an older V1 binary")
    parser.add_argument(
        "--plugin",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "plugins/model-discovery/dist/index.js",
        help="Built plugin entrypoint",
    )
    args = parser.parse_args()
    plugin = args.plugin.resolve(strict=True)
    scratch = Path(tempfile.gettempdir()) / "opencode"
    scratch.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="model-discovery-", dir=scratch) as tmp:
            root = Path(tmp)
            base_url = f"http://127.0.0.1:{server.server_port}/v1"
            if args.legacy:
                verify(args.legacy, "v1-legacy", plugin, base_url, root)
            verify(args.v1, "v1", plugin, base_url, root)
            verify(args.v2, "v2", plugin, base_url, root)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
