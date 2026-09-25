#!/usr/bin/env python3
"""Verify the installed skill manager using a private OpenCode V2 server.

Example: python3 scripts/verify-skill-manager.py --checkout /path/to/ai-config
Build plugins/skill-manager first. No real or fake model requests are made.
"""

import argparse
import base64
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def isolated_env(root):
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_")}
    for key, relative in {
        "HOME": "home",
        "XDG_CONFIG_HOME": "home/.config",
        "XDG_DATA_HOME": "home/.local/share",
        "XDG_CACHE_HOME": "home/.cache",
        "XDG_STATE_HOME": "home/.local/state",
        "TMPDIR": "tmp",
        "CODEX_HOME": "home/.codex",
        "CLAUDE_CONFIG_DIR": "home/.claude",
    }.items():
        path = root / relative
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    return env


@contextmanager
def v2_server(binary, root, env):
    with (root / "server.log").open("w") as log:
        process = subprocess.Popen(
            [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
            cwd=root,
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
            lines.put(None)

        reader = threading.Thread(target=capture, daemon=True)
        reader.start()
        try:
            url = password = None
            deadline = time.monotonic() + 30
            while url is None or password is None:
                try:
                    line = lines.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty as exc:
                    raise TimeoutError(
                        "Server did not publish its URL/password"
                    ) from exc
                require(
                    line is not None, "Server exited before publishing URL/password"
                )
                line = line.strip()
                if line.startswith("server listening on "):
                    url = line.removeprefix("server listening on ")
                elif line.startswith("server password "):
                    password = line.removeprefix("server password ")
            auth = base64.b64encode(f"opencode:{password}".encode()).decode()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path, directory, body=None):
                req = urllib.request.Request(
                    url + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={
                        "Authorization": f"Basic {auth}",
                        "x-opencode-directory": urllib.parse.quote(
                            str(directory), safe="/"
                        ),
                        "Content-Type": "application/json",
                    },
                )
                try:
                    with opener.open(req, timeout=60) as response:
                        payload = response.read()
                        return json.loads(payload) if payload else None
                except urllib.error.HTTPError as exc:
                    raise RuntimeError(
                        f"{req.get_method()} {path}: HTTP {exc.code}: {exc.read().decode()}"
                    ) from exc

            yield request
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            process.stdout.close()
            reader.join(timeout=2)


def catalogue(request, directory, plugin_ids):
    # Cold catalogue reads can precede config/plugin activation in V2.
    request("/api/location/reload", directory, {})
    deadline = time.monotonic() + 60
    while True:
        plugins = request("/api/plugin", directory)["data"]
        managed = [p for p in plugins if p["id"] in plugin_ids]
        failed = [p for p in managed if p["state"]["status"] == "failed"]
        require(not failed, f"Skill manager failed: {failed}")
        active = {p["id"] for p in plugins if p["state"]["status"] == "active"}
        if active.intersection(plugin_ids) and "opencode.config.skill" in active:
            return request("/api/skill", directory)["data"]
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"No active skill manager ({plugin_ids}); plugins: {plugins}"
            )
        time.sleep(0.1)


def activate(request, directory, skill):
    session = request(
        "/api/session",
        directory,
        {
            "title": "skill-manager verification (no generation)",
            "location": {"directory": str(directory)},
        },
    )["data"]
    session_id = session["id"]
    request(
        f"/api/experimental/session/{session_id}/skill",
        directory,
        {"id": skill["id"], "resume": False},
    )
    messages = request(f"/api/session/{session_id}/context", directory)["data"]
    loaded = [
        m
        for m in messages
        if m.get("type") == "skill" and m.get("skill") == skill["id"]
    ]
    require(bool(loaded), f"Native activation did not persist skill {skill['id']}")
    require(
        loaded[-1].get("text", "").strip() == skill["content"].strip(),
        f"Native activation changed the body of {skill['id']}",
    )
    return messages


def verify(args, root):
    env = isolated_env(root)
    checkout = args.checkout.resolve()
    plugin = checkout / "plugins/skill-manager"
    require(
        (plugin / "dist/index.js").is_file(),
        f"Build the skill manager first: {plugin / 'dist/index.js'}",
    )
    version = subprocess.check_output(
        [args.opencode, "--version"], env=env, text=True
    ).strip()
    require(version.startswith("opencode v2."), f"Expected OpenCode V2, got {version}")
    result = subprocess.run(
        [str(checkout / "install.sh")],
        cwd=checkout,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    (root / "installer.log").write_text(result.stdout + result.stderr)
    require(
        result.returncode == 0, f"Installer failed:\n{result.stdout}{result.stderr}"
    )
    link = Path(env["XDG_CONFIG_HOME"]) / "opencode/plugins/ai-config"
    require(
        link.is_symlink() and link.resolve() == plugin.resolve(),
        f"Installer did not register the expected plugin at {link}",
    )
    project = root / "project"
    project.mkdir()
    subprocess.run(["git", "init", "--quiet", str(project)], env=env, check=True)
    with v2_server(args.opencode, root, env) as request:
        registry = catalogue(request, project, args.plugin_id)
        managed = [
            s for s in registry if Path(s["path"]).resolve().is_relative_to(checkout)
        ]
        require(
            len(managed) >= args.minimum_skills,
            f"Expected >= {args.minimum_skills} managed skills, got {len(managed)}",
        )
        advertised = [
            s
            for s in managed
            if s.get("description") and s.get("autoinvoke") is not False
        ]
        require(
            len(advertised) <= 2,
            f"Managed advertisement grew: {[s['id'] for s in advertised]}",
        )
        hidden = [
            s
            for s in managed
            if s.get("autoinvoke") is False
            and Path(s["path"]).name == "SKILL.md"
            and s["content"].strip()
        ]
        supported = []
        for skill in hidden:
            base = Path(skill["path"]).parent
            files = sorted(
                p for p in base.rglob("*") if p.is_file() and p.name != "SKILL.md"
            )
            if files:
                supported.append((skill, files[0]))
        require(
            bool(supported), "No hidden directory skill with a supporting file found"
        )
        skill, support = supported[0]
        messages = activate(request, project, skill)
        require(
            support.is_relative_to(Path(skill["path"]).parent) and support.is_file(),
            "Native registry lost the skill's supporting-file base directory",
        )
        fixture = project / ".opencode/skills" / skill["id"]
        fixture.mkdir(parents=True)
        (fixture / "reference.txt").write_text("PROJECT_SUPPORT_SENTINEL\n")
        body = "PROJECT_OVERRIDE_SENTINEL\nRead reference.txt beside this skill.\n"
        (fixture / "SKILL.md").write_text(
            "---\nname: Project override\ndescription: Project-only override fixture\n"
            "metadata:\n  opencode/autoinvoke: false\n---\n" + body
        )
        overridden = catalogue(request, project, args.plugin_id)
        selected = next((s for s in overridden if s["id"] == skill["id"]), None)
        require(
            selected is not None and selected["content"].strip() == body.strip(),
            f"Project override did not win for {skill['id']}: {selected}",
        )
        require(
            Path(selected["path"]).resolve() == (fixture / "SKILL.md").resolve(),
            "Override's native supporting-file base points to the wrong source",
        )
        activate(request, project, selected)
        evidence = {
            "version": version,
            "managed": len(managed),
            "advertised": [s["id"] for s in advertised],
            "native_load": skill["id"],
            "source": skill["path"],
            "support": str(support),
            "context": messages,
            "project_override": selected,
        }
        (root / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(
        f"PASS: {len(managed)} managed skills; {len(advertised)} advertised; "
        f"native hidden load, supporting-file source and project override verified ({version})."
    )
    print(
        "Not checked: outgoing model context, search bounds, skill-tool permission prompts, UI."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkout",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Integrated checkout with built plugin and initialized submodules",
    )
    parser.add_argument(
        "--opencode", default=shutil.which("opencode"), help="OpenCode V2 executable"
    )
    parser.add_argument(
        "--plugin-id",
        action="append",
        default=None,
        help="Accepted native plugin ID (repeatable; defaults: ai-config, skill-manager, ai-config.skill-manager)",
    )
    parser.add_argument("--minimum-skills", type=int, default=80)
    parser.add_argument(
        "--keep", action="store_true", help="Keep isolated logs and evidence after exit"
    )
    args = parser.parse_args()
    if not args.opencode:
        parser.error("opencode was not found; pass --opencode")
    args.opencode = str(Path(args.opencode).absolute())
    args.plugin_id = args.plugin_id or [
        "ai-config",
        "skill-manager",
        "ai-config.skill-manager",
    ]
    Path("/tmp/opencode").mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="verify-skill-manager-", dir="/tmp/opencode"))
    try:
        verify(args, root)
    except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        log = root / "server.log"
        if log.exists():
            print(log.read_text()[-8000:], file=sys.stderr)
        return 1
    finally:
        if args.keep:
            print(f"Evidence: {root}")
        else:
            shutil.rmtree(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
