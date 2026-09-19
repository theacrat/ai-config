#!/usr/bin/env python3
"""Ask installed CLI loaders for their skills without making a model request."""

import importlib.util
import json
import os
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def claude_skills(env, workspace):
    env = env | {
        "ANTHROPIC_API_KEY": "no-model-call-discovery-probe",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    env.pop("CLAUDECODE", None)
    command = [
        "claude",
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources",
        "user",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
    ]
    with (workspace / "claude.stderr").open("w") as stderr:
        process = subprocess.Popen(
            command,
            env=env,
            cwd=workspace,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            bufsize=1,
        )
        try:
            request = {
                "type": "control_request",
                "request_id": "skills-discovery",
                "request": {"subtype": "initialize", "hooks": None},
            }
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if not selector.select(timeout=1):
                        continue
                    line = process.stdout.readline()
                    if not line:
                        raise RuntimeError("Claude closed before discovery completed")
                    response = json.loads(line)
                    if response.get("type") == "control_response":
                        result = response["response"]
                        if result.get("subtype") != "success":
                            raise RuntimeError(result)
                        return result["response"]
            raise TimeoutError("Claude skill discovery")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def require_names(label, expected, found):
    missing = expected - found
    if missing:
        raise RuntimeError(f"{label}: missing {', '.join(sorted(missing))}")
    print(f"{label}: discovered all {len(expected)} configured skills")


def main():
    standalone = {
        skill.parent.name
        for folder in (ROOT / "skills", ROOT / "personal/skills")
        for skill in folder.glob("*/SKILL.md")
    }
    for plugin in (ROOT / "plugins").iterdir():
        if plugin.name == "pstack" or not plugin.is_dir():
            continue
        standalone.update(
            skill.parent.name for skill in plugin.glob("skills/*/SKILL.md")
        )
    pstack = ROOT / "plugins/pstack/pstack"
    bundled = {skill.parent.name for skill in pstack.glob("skills/*/SKILL.md")}
    env = os.environ.copy()
    env.pop("CODEX_THREAD_ID", None)
    env.setdefault("CODEX_HOME", str(Path.home() / ".codex"))
    with tempfile.TemporaryDirectory(prefix="ai-config-loaders-") as directory:
        workspace = Path(directory)
        spec = importlib.util.spec_from_file_location(
            "pstack_codex_probe", pstack / "scripts/check-codex.py"
        )
        probe = importlib.util.module_from_spec(spec)
        sys.dont_write_bytecode = True
        spec.loader.exec_module(probe)
        codex = probe.list_skills(env, workspace, workspace / "codex.json")
        names = {
            skill["name"]
            for entry in codex["data"]
            for skill in entry["skills"]
            if skill["enabled"]
        }
        require_names("Codex", standalone | {f"pstack:{n}" for n in bundled}, names)
        claude = claude_skills(env, workspace)
        require_names(
            "Claude",
            standalone | {f"pstack:{n}" for n in bundled},
            {skill["name"] for skill in claude["commands"]},
        )
        opencode_env = env | {"OPENCODE_DISABLE_DEFAULT_PLUGINS": "1"}
        opencode_env.pop("OPENCODE_DISABLE_EXTERNAL_SKILLS", None)
        output = workspace / "opencode.json"
        with output.open("w") as stdout:
            subprocess.run(
                ["opencode", "--pure", "debug", "skill"],
                cwd=workspace,
                env=opencode_env,
                stdout=stdout,
                stderr=subprocess.PIPE,
                text=True,
                check=True,
                timeout=45,
            )
        require_names(
            "OpenCode",
            standalone | bundled,
            {skill["name"] for skill in json.loads(output.read_text())},
        )
    print("Cursor: run install.sh --check, then reload and inspect Customize > Skills.")


if __name__ == "__main__":
    main()
