from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import install


class InstallerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "repo"
        self.home = self.root / "home"
        self.paths = install.Paths(
            self.checkout, self.home, self.root / "config", self.root / "data/ai-config"
        )
        self.write(self.checkout / "skills/example/SKILL.md", "example")
        self.write(self.checkout / "personal/skills/mine/SKILL.md", "mine")
        self.write(self.checkout / "plugins/skill-manager/dist/index.js", "export {}")
        self.write(self.checkout / "plugins/pstack/pstack/agents/reviewer.md", "agent")
        self.write(
            self.checkout / ".gitmodules",
            '[submodule "plugins/pstack"]\n path = plugins/pstack\n',
        )
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()

    def write(self, path: Path, text: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def link(self, path: Path, target: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target, target_is_directory=True)
        return path

    def run_install(self, replace: bool = False) -> int:
        with contextlib.redirect_stdout(self.stdout):
            return install.install(self.paths, replace)

    def check(self) -> int:
        with (
            contextlib.redirect_stdout(self.stdout),
            contextlib.redirect_stderr(self.stderr),
        ):
            return install.check(self.paths)

    def state(self, value: object) -> None:
        self.write(self.paths.state_file, json.dumps(value))

    def backups(self) -> dict[str, Path]:
        result = {}
        for manifest in self.paths.backup_root.glob("*/manifest.json"):
            for item in json.loads(manifest.read_text()):
                result[item["original"]] = Path(item["backup"])
        return result

    def snapshot(self) -> dict[str, tuple[str, object]]:
        return {
            str(p.relative_to(self.root)): ("link", os.readlink(p))
            if p.is_symlink()
            else ("file", p.read_bytes())
            if p.is_file()
            else ("dir", None)
            for p in self.root.rglob("*")
        }

    def test_install_registers_only_two_links_and_is_idempotent(self) -> None:
        self.assertEqual(self.run_install(), 0)
        self.assertEqual(
            json.loads(self.paths.state_file.read_text()),
            {
                "version": 2,
                "managed_links": {
                    str(self.paths.xdg_config / "opencode/plugins/ai-config"): str(
                        self.checkout / "plugins/skill-manager"
                    ),
                    str(self.paths.xdg_config / "opencode/agents/pstack"): str(
                        self.checkout / "plugins/pstack/pstack/agents"
                    ),
                },
            },
        )
        before = self.snapshot()
        mtime = self.paths.state_file.stat().st_mtime_ns
        self.assertEqual(self.run_install(), 0)
        self.assertEqual(self.check(), 0)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(mtime, self.paths.state_file.stat().st_mtime_ns)
        self.assertFalse(self.home.exists())
        self.assertFalse(self.paths.backup_root.exists())

    def test_v1_migration_backs_up_visible_links_preserves_other_apps(self) -> None:
        visible = [
            self.link(root / "example", self.checkout / "skills/example")
            for root in self.paths.visible_skill_roots
        ]
        visible.append(
            self.link(
                self.paths.xdg_config / "opencode/skills/pstack",
                self.paths.data_root / "pstack",
            )
        )
        agents = self.link(
            self.paths.xdg_config / "opencode/agents/pstack",
            self.paths.data_root / "pstack/agents",
        )
        others = [
            self.link(
                self.home / name / "skills/example", self.checkout / "skills/example"
            )
            for name in (".codex", ".cursor", ".omp/agent")
        ]
        others.append(
            self.write(
                self.home / ".claude/plugins/installed_plugins.json", "untouched"
            )
        )
        others.append(
            self.write(self.paths.xdg_config / "opencode/opencode.json", "untouched")
        )
        others.append(
            self.write(
                self.paths.xdg_config / "opencode/plugins/custom.js", "untouched"
            )
        )
        self.state(
            {
                "version": 1,
                "managed_paths": [str(p) for p in visible + others + [agents]],
            }
        )
        self.assertEqual(self.run_install(), 0)
        self.assertEqual(set(self.backups()), {str(p) for p in visible + [agents]})
        for path in visible:
            self.assertFalse(install.exists(path))
            self.assertTrue(self.backups()[str(path)].is_symlink())
        for path in others:
            self.assertTrue(install.exists(path))
        self.assertEqual(self.check(), 0)

    def test_unrelated_skills_are_ignored_even_with_replace(self) -> None:
        unrelated = self.write(self.home / ".agents/skills/custom/SKILL.md", "mine")
        foreign = self.link(
            self.paths.xdg_config / "opencode/skills/external", self.root / "elsewhere"
        )
        self.run_install(True)
        self.assertEqual(unrelated.read_text(), "mine")
        self.assertEqual(os.readlink(foreign), str(self.root / "elsewhere"))
        self.assertEqual(self.check(), 0)
        self.assertEqual(self.backups(), {})

    def test_conflicting_registration_requires_replace_before_any_mutation(
        self,
    ) -> None:
        destination = next(iter(self.paths.links))
        self.write(destination / "mine.txt", "mine")
        old = self.link(
            self.home / ".agents/skills/example", self.checkout / "skills/example"
        )
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "--replace"):
            self.run_install()
        self.assertEqual(before, self.snapshot())
        self.run_install(True)
        self.assertEqual(
            (self.backups()[str(destination)] / "mine.txt").read_text(), "mine"
        )
        self.assertIn(str(old), self.backups())

    def test_changed_v2_registration_requires_replace(self) -> None:
        self.run_install()
        destination = next(iter(self.paths.links))
        destination.unlink()
        self.link(destination, self.root / "user-plugin")
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "--replace"):
            self.run_install()
        self.assertEqual(before, self.snapshot())
        self.run_install(True)
        self.assertEqual(
            os.readlink(self.backups()[str(destination)]),
            str(self.root / "user-plugin"),
        )

    def test_moved_checkout_retargets_exact_recorded_links(self) -> None:
        self.run_install()
        old_links = dict(self.paths.links)
        moved = self.root / "moved-repo"
        self.checkout.rename(moved)
        self.paths = install.Paths(
            moved, self.home, self.paths.xdg_config, self.paths.data_root
        )
        self.assertEqual(self.run_install(), 0)
        self.assertEqual(self.check(), 0)
        for path, old_target in old_links.items():
            self.assertEqual(os.readlink(self.backups()[str(path)]), str(old_target))
            self.assertEqual(os.readlink(path), str(self.paths.links[path]))

    def test_recorded_wrong_role_does_not_authorise_retarget(self) -> None:
        destination = next(iter(self.paths.links))
        target = self.root / "unrelated"
        self.link(destination, target)
        self.state({"version": 2, "managed_links": {str(destination): str(target)}})
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "--replace"):
            self.run_install()
        self.assertEqual(before, self.snapshot())

    def prepare_replacement(self) -> tuple[Path, Path, bytes]:
        destination = next(iter(self.paths.links))
        self.write(destination / "user.txt", "user content")
        stale = self.link(
            self.home / ".agents/skills/example", self.checkout / "skills/example"
        )
        self.state({"version": 1, "managed_paths": [str(stale)]})
        return destination, stale, self.paths.state_file.read_bytes()

    def assert_rolled_back(self, destination: Path, stale: Path, state: bytes) -> None:
        self.assertEqual((destination / "user.txt").read_text(), "user content")
        self.assertEqual(os.readlink(stale), str(self.checkout / "skills/example"))
        self.assertFalse(
            install.exists(self.paths.xdg_config / "opencode/agents/pstack")
        )
        self.assertEqual(self.paths.state_file.read_bytes(), state)
        backups = self.backups()
        self.assertEqual(
            (backups[str(destination)] / "user.txt").read_text(), "user content"
        )
        self.assertEqual(os.readlink(backups[str(stale)]), os.readlink(stale))

    def test_second_symlink_failure_rolls_back_and_keeps_backups(self) -> None:
        destination, stale, state = self.prepare_replacement()
        symlink = Path.symlink_to
        calls = 0

        def fail_second(path: Path, target: Path, **kwargs: object) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected second link failure")
            symlink(path, target, **kwargs)

        with patch.object(Path, "symlink_to", fail_second):
            with self.assertRaisesRegex(install.InstallError, "rolled back"):
                self.run_install(True)
        self.assert_rolled_back(destination, stale, state)
        self.assertEqual(self.run_install(True), 0)
        self.assertEqual(self.check(), 0)

    def test_state_failure_rolls_back_links_and_previous_state(self) -> None:
        destination, stale, state = self.prepare_replacement()
        write_json = install.write_json

        def fail_state(path: Path, value: object) -> None:
            write_json(path, value)
            if path == self.paths.state_file:
                raise OSError("injected state failure after write")

        with patch.object(install, "write_json", fail_state):
            with self.assertRaisesRegex(install.InstallError, "rolled back"):
                self.run_install(True)
        self.assert_rolled_back(destination, stale, state)

    def test_fresh_install_state_failure_removes_new_links_and_state(self) -> None:
        with patch.object(install, "write_json", side_effect=OSError("state failure")):
            with self.assertRaisesRegex(install.InstallError, "rolled back"):
                self.run_install()
        self.assertFalse(self.paths.state_file.exists())
        for path in self.paths.links:
            self.assertFalse(install.exists(path))

    def test_changed_v1_skill_requires_replace(self) -> None:
        destination = self.link(
            self.home / ".agents/skills/example", self.root / "user-skill"
        )
        self.state({"version": 1, "managed_paths": [str(destination)]})
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "--replace"):
            self.run_install()
        self.assertEqual(before, self.snapshot())
        self.run_install(True)
        self.assertEqual(
            os.readlink(self.backups()[str(destination)]), str(self.root / "user-skill")
        )

    def test_state_cannot_authorise_arbitrary_paths(self) -> None:
        arbitrary = self.write(self.root / "private/file", "private")
        forged = self.link(self.home / ".agents/skills/unknown", self.root / "private")
        traversal = self.home / ".agents/skills/../../private"
        for version, state in (
            (1, {"managed_paths": [str(arbitrary), str(forged), str(traversal)]}),
            (
                2,
                {
                    "managed_links": {
                        str(arbitrary): str(self.checkout / "skills/example"),
                        str(forged): str(self.root / "private"),
                    }
                },
            ),
        ):
            with self.subTest(version=version):
                self.state({"version": version, **state})
                self.run_install(True)
                self.assertEqual(arbitrary.read_text(), "private")
                self.assertTrue(forged.is_symlink())
                self.assertEqual(self.backups(), {})

    def test_check_is_read_only_and_detects_stale_links(self) -> None:
        self.run_install()
        self.link(
            self.home / ".agents/skills/removed",
            self.checkout / "sources/deleted/skill",
        )
        before = self.snapshot()
        self.assertEqual(self.check(), 1)
        self.assertIn("stale OpenCode-visible", self.stderr.getvalue())
        self.assertEqual(before, self.snapshot())

    def test_check_without_installation_creates_nothing(self) -> None:
        before = self.snapshot()
        self.assertEqual(self.check(), 1)
        self.assertEqual(before, self.snapshot())

    def test_v2_stale_link_changed_by_user_requires_replace(self) -> None:
        path = self.link(self.home / ".agents/skills/retired", self.root / "user-owned")
        self.state(
            {
                "version": 2,
                "managed_links": {
                    str(path): str(self.checkout / "sources/retired/skill")
                },
            }
        )
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "--replace"):
            self.run_install()
        self.assertEqual(self.check(), 1)
        self.assertEqual(before, self.snapshot())
        self.run_install(True)
        self.assertEqual(
            os.readlink(self.backups()[str(path)]), str(self.root / "user-owned")
        )

    def test_relative_repo_link_is_backed_up_without_touching_source(self) -> None:
        path = self.home / ".agents/skills/example"
        target = self.checkout / "skills/example"
        self.link(path, Path(os.path.relpath(target, path.parent)))
        self.run_install()
        self.assertEqual((target / "SKILL.md").read_text(), "example")
        self.assertEqual(
            os.readlink(self.backups()[str(path)]), os.path.relpath(target, path.parent)
        )

    def test_missing_sources_and_build_fail_before_writes(self) -> None:
        for relative in (
            "plugins/pstack",
            "plugins/skill-manager/dist/index.js",
            "skills/example/SKILL.md",
        ):
            with self.subTest(relative=relative):
                path = self.checkout / relative
                saved = self.root / "saved"
                path.rename(saved)
                before = self.snapshot()
                with self.assertRaises(install.InstallError):
                    self.run_install()
                self.assertEqual(before, self.snapshot())
                saved.rename(path)

    def test_broken_skill_source_has_actionable_error(self) -> None:
        self.link(self.checkout / "skills/missing", self.checkout / "sources/absent")
        with self.assertRaisesRegex(
            install.InstallError, "submodule update --init --recursive"
        ):
            self.run_install()

    def test_invalid_state_is_not_overwritten(self) -> None:
        for text in (
            "broken",
            "[]",
            '{"version": 99}',
            '{"version": 2, "managed_links": []}',
        ):
            self.write(self.paths.state_file, text)
            before = self.snapshot()
            with self.assertRaises(install.InstallError):
                self.run_install(True)
            self.assertEqual(before, self.snapshot())

    def test_symlinked_skill_root_does_not_modify_other_apps(self) -> None:
        target = self.home / ".cursor/skills"
        entry = self.link(target / "example", self.checkout / "skills/example")
        self.link(self.home / ".agents/skills", target)
        self.state(
            {"version": 1, "managed_paths": [str(self.home / ".agents/skills/example")]}
        )
        self.run_install(True)
        self.assertTrue(entry.is_symlink())
        self.assertEqual(self.backups(), {})

    def test_symlinked_registration_parent_is_rejected(self) -> None:
        self.link(
            self.paths.xdg_config / "opencode/plugins", self.home / ".cursor/plugins"
        )
        before = self.snapshot()
        with self.assertRaisesRegex(install.InstallError, "symlinked directory"):
            self.run_install(True)
        self.assertEqual(before, self.snapshot())

    def test_xdg_defaults_and_overrides(self) -> None:
        with patch.dict(os.environ, {"HOME": str(self.home)}, clear=True):
            paths = install.Paths.from_checkout(self.checkout)
            self.assertEqual(paths.xdg_config, self.home / ".config")
            self.assertEqual(paths.data_root, self.home / ".local/share/ai-config")
        with patch.dict(
            os.environ,
            {
                "HOME": str(self.home),
                "XDG_CONFIG_HOME": str(self.root / "cfg"),
                "XDG_DATA_HOME": str(self.root / "data"),
            },
            clear=True,
        ):
            paths = install.Paths.from_checkout(self.checkout)
            self.assertEqual(paths.xdg_config, self.root / "cfg")
            self.assertEqual(paths.data_root, self.root / "data/ai-config")

    def test_cli_install_and_check_in_temporary_home(self) -> None:
        script = self.checkout / "scripts/install.py"
        script.parent.mkdir()
        shutil.copyfile(install.__file__, script)
        env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.paths.xdg_config),
            "XDG_DATA_HOME": str(self.paths.data_root.parent),
            "PATH": "",
        }
        for args in ([], ["--check"], []):
            result = subprocess.run(
                [sys.executable, str(script), *args],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        (self.checkout / "plugins/skill-manager/dist/index.js").unlink()
        result = subprocess.run(
            [sys.executable, str(script), "--check"],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("skill manager is not built", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
