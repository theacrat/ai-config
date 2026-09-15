from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "install.py"


class InstallerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp())
        self.home = self.temp / "home"
        self.checkout = self.temp / "checkout"
        (self.checkout / "scripts").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.checkout / "scripts/install.py")
        (self.checkout / "skills/alpha").mkdir(parents=True)
        (self.checkout / "skills/alpha/SKILL.md").write_text("alpha\n")
        (self.checkout / "personal/skills/thea-mode").mkdir(parents=True)
        (self.checkout / "personal/skills/thea-mode/SKILL.md").write_text("thea\n")
        bundle = self.checkout / "plugins/pstack/pstack"
        for directory in (
            ".claude-plugin",
            ".codex-plugin",
            ".cursor-plugin",
            "skills/shared",
            "agents",
        ):
            (bundle / directory).mkdir(parents=True)
        (bundle / ".claude-plugin/marketplace.json").write_text(
            '{"name":"pstack-local"}'
        )
        (bundle / ".codex-plugin/plugin.json").write_text(
            '{"name":"pstack","version":"1"}'
        )
        (bundle / ".cursor-plugin/plugin.json").write_text(
            '{"name":"pstack","version":"1"}'
        )
        (bundle / "skills/shared/SKILL.md").write_text("shared\n")
        (bundle / "agents/example.md").write_text("agent\n")
        self.bin = self.temp / "bin"
        self.bin.mkdir()
        self.log = self.temp / "commands.jsonl"
        self._write_clis()

    def tearDown(self) -> None:
        shutil.rmtree(self.temp)

    def _write_clis(self) -> None:
        body = """#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
pathlib.Path(os.environ["FAKE_LOG"]).open("a").write(json.dumps(args) + "\\n")
codex = pathlib.Path(os.environ["CODEX_HOME"])
claude = pathlib.Path(os.environ["CLAUDE_CONFIG_DIR"])
stable = pathlib.Path(os.environ["STABLE_BUNDLE"])
if args[:4] == ["plugin", "marketplace", "add", str(stable)]:
    config = codex / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text('[marketplaces.pstack-local]\\nsource = "' + str(stable) + '"\\n[plugins."pstack@pstack-local"]\\nenabled = true\\n')
elif args[:3] == ["plugin", "add", "pstack@pstack-local"]:
    destination = codex / "plugins/cache/pstack-local/pstack/1"
    shutil.copytree(stable, destination, dirs_exist_ok=True)
elif args[:3] == ["plugin", "remove", "pstack@pstack-local"]:
    shutil.rmtree(codex / "plugins/cache/pstack-local", ignore_errors=True)
elif args[:4] == ["plugin", "marketplace", "add", str(stable)]:
    pass
elif args[:3] == ["plugin", "install", "pstack@pstack-local"]:
    destination = claude / "plugins/cache/pstack-local/pstack/1"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(stable, destination, dirs_exist_ok=True)
    (claude / "plugins/installed_plugins.json").write_text(json.dumps({"plugins":{"pstack@pstack-local":[{"scope":"user","installPath":str(destination)}]}}))
    (claude / "plugins/known_marketplaces.json").write_text(json.dumps({"pstack-local":{"installLocation":str(stable)}}))
    (claude / "settings.json").write_text(json.dumps({"enabledPlugins":{"pstack@pstack-local":True}}))
elif args[:3] == ["plugin", "uninstall", "pstack@pstack-local"]:
    shutil.rmtree(claude / "plugins/cache/pstack-local", ignore_errors=True)
"""
        for name in ("codex", "claude"):
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(self.home),
                "CODEX_HOME": str(self.home / ".codex"),
                "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
                "XDG_CONFIG_HOME": str(self.home / ".config"),
                "XDG_DATA_HOME": str(self.home / ".local/share"),
                "FAKE_LOG": str(self.log),
                "STABLE_BUNDLE": str(self.home / ".local/share/ai-config/pstack"),
                "PATH": str(self.bin) + os.pathsep + env["PATH"],
            }
        )
        return env

    def execute(
        self, *args: str, checkout: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str((checkout or self.checkout) / "scripts/install.py"),
                *args,
            ],
            cwd=checkout or self.checkout,
            env=self.env(),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_replace_is_reversible_and_repeat_does_not_backup(self) -> None:
        existing = self.home / ".agents/skills/alpha"
        existing.mkdir(parents=True)
        (existing / "SKILL.md").write_text("old\n")
        lockfile = self.home / ".agents/.skill-lock.json"
        lockfile.write_text("stale lock\n")
        result = self.execute("--replace")
        self.assertEqual(result.returncode, 0, result.stderr)
        backup_root = self.home / ".local/share/ai-config/backups"
        backups = list(backup_root.iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "0/SKILL.md").read_text(), "old\n")
        self.assertEqual((backups[0] / "1").read_text(), "stale lock\n")
        self.assertEqual(existing.resolve(), (self.checkout / "skills/alpha").resolve())
        commands_before = self.log.read_text()
        second = self.execute()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(list(backup_root.iterdir())), 1)
        self.assertEqual(self.log.read_text(), commands_before)

    def test_locally_replaced_skill_is_preserved(self) -> None:
        self.assertEqual(self.execute().returncode, 0)
        skill = self.home / ".agents/skills/alpha"
        skill.unlink()
        skill.mkdir()
        (skill / "SKILL.md").write_text("personal replacement\n")
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((skill / "SKILL.md").read_text(), "personal replacement\n")
        result = self.execute("--replace")
        self.assertEqual(result.returncode, 0, result.stderr)
        manifests = list(
            (self.home / ".local/share/ai-config/backups").glob("*/manifest.json")
        )
        entries = [
            entry for file in manifests for entry in json.loads(file.read_text())
        ]
        backup = next(
            Path(entry["backup"])
            for entry in entries
            if entry["original"] == str(skill)
        )
        self.assertEqual((backup / "SKILL.md").read_text(), "personal replacement\n")

    def test_replacement_removes_opencode_duplicate_and_preserves_system_skills(
        self,
    ) -> None:
        old = self.home / ".config/opencode/skills/alpha"
        old.mkdir(parents=True)
        (old / "SKILL.md").write_text("old OpenCode skill\n")
        system = self.home / ".codex/skills/.system/keep"
        system.mkdir(parents=True)
        (system / "SKILL.md").write_text("system\n")
        result = self.execute("--replace")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old.exists())
        self.assertEqual((system / "SKILL.md").read_text(), "system\n")
        self.assertEqual(self.execute("--check").returncode, 0)

    def test_check_detects_missing_link_and_tampered_native_cache(self) -> None:
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        link = self.home / ".cursor/skills/alpha"
        link.unlink()
        self.assertNotEqual(self.execute("--check").returncode, 0)
        link.symlink_to(self.checkout / "skills/alpha", target_is_directory=True)
        cache_file = next(
            (self.home / ".codex/plugins/cache/pstack-local/pstack/1").rglob("SKILL.md")
        )
        cache_file.write_text("tampered\n")
        self.assertNotEqual(self.execute("--check").returncode, 0)

    def test_cli_failure_keeps_existing_skills(self) -> None:
        skill = self.home / ".agents/skills/alpha"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("keep on failure\n")
        (self.bin / "claude").write_text("#!/bin/sh\nexit 3\n")
        result = self.execute("--replace")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(skill.is_symlink())
        self.assertEqual((skill / "SKILL.md").read_text(), "keep on failure\n")

    def test_relocated_checkout_updates_links(self) -> None:
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        relocated = self.temp / "moved-checkout"
        shutil.copytree(self.checkout, relocated)
        shutil.rmtree(self.checkout)
        result = self.execute(checkout=relocated)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.home / ".agents/skills/alpha").resolve(),
            (relocated / "skills/alpha").resolve(),
        )


if __name__ == "__main__":
    unittest.main()
