#!/usr/bin/env python3
"""Install reviewed skills and the local pstack bundle on this machine."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PLUGIN_ID = "pstack@pstack-local"


class InstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class Paths:
    checkout: Path
    home: Path
    codex_home: Path
    claude_home: Path
    xdg_config: Path
    data_root: Path

    @classmethod
    def from_checkout(cls, checkout: Path) -> Paths:
        home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
        codex = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
        claude = Path(
            os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))
        ).expanduser()
        config = Path(
            os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))
        ).expanduser()
        data = Path(
            os.environ.get("XDG_DATA_HOME", str(home / ".local" / "share"))
        ).expanduser()
        return cls(checkout.resolve(), home, codex, claude, config, data / "ai-config")

    @property
    def state_file(self) -> Path:
        return self.data_root / "state.json"

    @property
    def backup_root(self) -> Path:
        return self.data_root / "backups"

    @property
    def link_destinations(self) -> tuple[Path, ...]:
        return (
            self.home / ".agents" / "skills",
            self.claude_home / "skills",
            self.home / ".cursor" / "skills",
        )

    @property
    def cleanup_destinations(self) -> tuple[Path, ...]:
        return (self.codex_home / "skills",) + self.link_destinations

    @property
    def opencode_skills(self) -> Path:
        return self.xdg_config / "opencode" / "skills"

    @property
    def opencode_agents(self) -> Path:
        return self.xdg_config / "opencode" / "agents"

    @property
    def cursor_plugin(self) -> Path:
        return self.home / ".cursor" / "plugins" / "local" / "pstack"

    @property
    def claude_plugins(self) -> Path:
        return self.claude_home / "plugins"


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def iter_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        if ".git" in path.relative_to(root).parts:
            continue
        if path.is_file() or path.is_symlink():
            yield path


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in iter_files(root):
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        if path.is_symlink():
            digest.update(b"link\0" + os.readlink(path).encode())
        else:
            digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def same_tree(expected: Path, actual: Path) -> bool:
    return actual.is_dir() and tree_digest(expected) == tree_digest(actual)


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def discover_skills(paths: Paths) -> dict[str, Path]:
    result: dict[str, Path] = {}
    root = paths.checkout / "skills"
    if root.is_dir():
        for item in sorted(root.iterdir()):
            if item.is_dir() and (item / "SKILL.md").is_file():
                result[item.name] = item.resolve()
    personal_root = paths.checkout / "personal" / "skills"
    if personal_root.is_dir():
        for item in sorted(personal_root.iterdir()):
            if item.is_dir() and (item / "SKILL.md").is_file():
                result[item.name] = item.resolve()
    if not result:
        raise InstallError(f"no skills found under {root}")
    return result


def source_bundle(paths: Paths) -> Path:
    candidates = (
        paths.checkout / "plugins" / "pstack" / "pstack",
        paths.checkout / "plugins" / "pstack",
    )
    for candidate in candidates:
        if (candidate / ".claude-plugin" / "marketplace.json").is_file():
            return candidate.resolve()
    raise InstallError(
        "pstack bundle is missing (expected plugins/pstack/pstack or plugins/pstack)"
    )


def managed_paths(state: dict[str, Any]) -> set[Path]:
    return {Path(path) for path in state.get("managed_paths", [])}


class Backup:
    def __init__(self, paths: Paths) -> None:
        self.paths = paths
        self.root: Path | None = None
        self.manifest: list[dict[str, str]] = []

    def move(self, path: Path) -> None:
        if self.root is None:
            self.root = (
                self.paths.backup_root
                / f"{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
            )
            self.root.mkdir(parents=True, exist_ok=False)
        target = self.root / str(len(self.manifest))
        shutil.move(str(path), target)
        self.manifest.append({"original": str(path), "backup": str(target)})
        write_json(self.root / "manifest.json", self.manifest)


def is_expected_link(path: Path, source: Path) -> bool:
    return path.is_symlink() and path.resolve(strict=False) == source.resolve(
        strict=False
    )


def prepare_link(
    path: Path,
    source: Path,
    state_paths: set[Path],
    replace: bool,
    moves: list[Path],
    conflicts: list[str],
) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if is_expected_link(path, source):
        return
    if path in state_paths and path.is_symlink():
        moves.append(path)
        return
    if replace:
        moves.append(path)
    else:
        conflicts.append(str(path))


def create_link(path: Path, source: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if is_expected_link(path, source):
        return
    if path.exists() or path.is_symlink():
        remove_path(path)
    os.symlink(source, path, target_is_directory=True)


def clean_skill_dirs(
    paths: Paths,
    desired: set[str],
    state_paths: set[Path],
    replace: bool,
    moves: list[Path],
    stale: list[Path],
    conflicts: list[str],
) -> None:
    for destination in paths.cleanup_destinations + (paths.opencode_skills,):
        if not destination.is_dir():
            continue
        for item in sorted(destination.iterdir()):
            if destination == paths.codex_home / "skills" and item.name == ".system":
                continue
            if (
                destination == paths.opencode_skills
                and item.name == "pstack"
                and item in state_paths
            ):
                continue
            if destination in paths.link_destinations and item.name in desired:
                continue
            if item in state_paths:
                if item.is_symlink():
                    stale.append(item)
                elif replace:
                    moves.append(item)
                else:
                    conflicts.append(str(item))
            elif item.is_symlink():
                if replace:
                    moves.append(item)
                else:
                    conflicts.append(str(item))
            elif replace:
                moves.append(item)
            else:
                conflicts.append(str(item))


def copy_tree_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.tmp-{uuid.uuid4().hex}"
    shutil.copytree(
        source, temporary, symlinks=True, ignore=shutil.ignore_patterns(".git")
    )
    if destination.exists() or destination.is_symlink():
        remove_path(destination)
    os.replace(temporary, destination)


def run_cli(command: list[str]) -> str:
    try:
        result = subprocess.run(command, check=True, text=True, capture_output=True)
    except FileNotFoundError as exc:
        raise InstallError(f"required CLI is unavailable: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        output = (exc.stdout or "") + (exc.stderr or "")
        raise InstallError(
            f"command failed: {' '.join(command)}\n{output.strip()}"
        ) from exc
    return result.stdout


def cli_preflight() -> None:
    missing = [name for name in ("codex", "claude") if shutil.which(name) is None]
    if missing:
        raise InstallError("required CLI(s) missing: " + ", ".join(missing))


def codex_ok(paths: Paths, stable: Path) -> tuple[bool, str]:
    cache = paths.codex_home / "plugins" / "cache" / "pstack-local" / "pstack"
    version = read_json(stable / ".codex-plugin/plugin.json", {}).get("version")
    if not version or not same_tree(stable, cache / version):
        return False, "Codex plugin cache is missing or incomplete"
    try:
        import tomllib

        config = tomllib.loads(
            (paths.codex_home / "config.toml").read_text(encoding="utf-8")
        )
    except (FileNotFoundError, ValueError):
        return False, "Codex config.toml is missing or invalid"
    plugins = config.get("plugins", {})
    enabled = (
        isinstance(plugins, dict)
        and isinstance(plugins.get(PLUGIN_ID), dict)
        and plugins[PLUGIN_ID].get("enabled") is True
    )
    marketplaces = config.get("marketplaces", {})
    marketplace = (
        marketplaces.get("pstack-local", {}) if isinstance(marketplaces, dict) else {}
    )
    if not enabled or Path(marketplace.get("source", "")).resolve() != stable.resolve():
        return (
            False,
            "Codex config does not enable pstack or point its marketplace at the stable bundle",
        )
    return True, "Codex native plugin is healthy"


def claude_ok(paths: Paths, stable: Path) -> tuple[bool, str]:
    installed = read_json(paths.claude_plugins / "installed_plugins.json", {})
    entries = (
        installed.get("plugins", {}).get(PLUGIN_ID, [])
        if isinstance(installed, dict)
        else []
    )
    installed_paths = [
        Path(entry.get("installPath", ""))
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("installPath")
        and entry.get("scope") == "user"
    ]
    if not any(path.is_dir() and same_tree(stable, path) for path in installed_paths):
        return False, "Claude plugin cache is missing or incomplete"
    settings = read_json(paths.claude_home / "settings.json", {})
    enabled = settings.get("enabledPlugins", {}) if isinstance(settings, dict) else {}
    if not (isinstance(enabled, dict) and enabled.get(PLUGIN_ID) is True):
        return False, "Claude settings do not enable pstack"
    known = read_json(paths.claude_plugins / "known_marketplaces.json", {})
    marketplace = known.get("pstack-local", {}) if isinstance(known, dict) else {}
    if Path(marketplace.get("installLocation", "")).resolve() != stable.resolve():
        return False, "Claude marketplace registry does not point at the stable bundle"
    return True, "Claude native plugin is healthy"


def codex_installed(paths: Paths) -> bool:
    return (paths.codex_home / "plugins" / "cache" / "pstack-local" / "pstack").is_dir()


def claude_installed(paths: Paths) -> bool:
    installed = read_json(paths.claude_plugins / "installed_plugins.json", {})
    entries = (
        installed.get("plugins", {}).get(PLUGIN_ID, [])
        if isinstance(installed, dict)
        else []
    )
    return any(
        isinstance(entry, dict)
        and entry.get("installPath")
        and entry.get("scope") == "user"
        for entry in entries
    )


def native_install(paths: Paths, stable: Path) -> None:
    paths.codex_home.mkdir(parents=True, exist_ok=True)
    paths.claude_home.mkdir(parents=True, exist_ok=True)
    codex_good, _ = codex_ok(paths, stable)
    claude_good, _ = claude_ok(paths, stable)
    if not codex_good and codex_installed(paths):
        run_cli(["codex", "plugin", "remove", PLUGIN_ID, "--json"])
    if not claude_good and claude_installed(paths):
        run_cli(
            [
                "claude",
                "plugin",
                "uninstall",
                PLUGIN_ID,
                "--scope",
                "user",
                "--keep-data",
                "--json",
            ]
        )
    if not codex_good:
        run_cli(["codex", "plugin", "marketplace", "add", str(stable), "--json"])
        run_cli(["codex", "plugin", "add", PLUGIN_ID, "--json"])
    if not claude_good:
        run_cli(["claude", "plugin", "marketplace", "add", str(stable)])
        run_cli(["claude", "plugin", "install", PLUGIN_ID, "--scope", "user", "--json"])
    codex_good, codex_message = codex_ok(paths, stable)
    claude_good, claude_message = claude_ok(paths, stable)
    if not codex_good or not claude_good:
        raise InstallError(
            f"native verification failed: {codex_message}; {claude_message}"
        )


def check(paths: Paths) -> int:
    problems: list[str] = []
    try:
        skills = discover_skills(paths)
        bundle = source_bundle(paths)
    except InstallError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    expected_managed = {
        str(destination / name)
        for destination in paths.link_destinations
        for name in skills
    }
    expected_managed.update(
        {
            str(paths.cursor_plugin),
            str(paths.opencode_skills / "pstack"),
            str(paths.opencode_agents / "pstack"),
        }
    )
    for stale in managed_paths(read_json(paths.state_file, {})) - {
        Path(path) for path in expected_managed
    }:
        if stale.exists() or stale.is_symlink():
            problems.append(f"stale managed path: {stale}")
    for destination in paths.link_destinations:
        for name, source in skills.items():
            if not is_expected_link(destination / name, source):
                problems.append(f"missing or incorrect link: {destination / name}")
    for destination in paths.cleanup_destinations + (paths.opencode_skills,):
        allowed = set(skills) if destination in paths.link_destinations else set()
        if destination == paths.codex_home / "skills":
            allowed.add(".system")
        if destination == paths.opencode_skills:
            allowed.add("pstack")
        if destination.is_dir():
            problems.extend(
                f"unexpected skill entry: {item}"
                for item in destination.iterdir()
                if item.name not in allowed
            )
    stable = paths.data_root / "pstack"
    if stable.is_symlink() or not same_tree(bundle, stable):
        problems.append("stable pstack bundle is missing or stale")
    if paths.cursor_plugin.is_symlink() or not same_tree(stable, paths.cursor_plugin):
        problems.append("Cursor pstack bundle is missing or incomplete")
    if not is_expected_link(paths.opencode_skills / "pstack", stable):
        problems.append("OpenCode pstack skills link is missing or incorrect")
    if (stable / "agents").is_dir() and not is_expected_link(
        paths.opencode_agents / "pstack", stable / "agents"
    ):
        problems.append("OpenCode pstack agents link is missing or incorrect")
    good, message = codex_ok(paths, stable)
    if not good:
        problems.append(message)
    good, message = claude_ok(paths, stable)
    if not good:
        problems.append(message)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    print(f"healthy ({len(skills)} skills, pstack {tree_digest(stable)[:12]})")
    return 0


def install(paths: Paths, replace: bool) -> int:
    skills = discover_skills(paths)
    bundle = source_bundle(paths)
    state = read_json(paths.state_file, {})
    prior_paths = managed_paths(state)
    cli_preflight()
    backup = Backup(paths)
    conflicts: list[str] = []
    desired = set(skills)
    moves: list[Path] = []
    stale: list[Path] = []
    for destination in paths.link_destinations:
        for name, source in skills.items():
            prepare_link(
                destination / name, source, prior_paths, replace, moves, conflicts
            )
    clean_skill_dirs(paths, desired, prior_paths, replace, moves, stale, conflicts)
    for special in (
        paths.cursor_plugin,
        paths.opencode_skills / "pstack",
        paths.opencode_agents / "pstack",
    ):
        if special.exists() or special.is_symlink():
            if special in prior_paths:
                if special.is_symlink():
                    target = paths.data_root / "pstack"
                    if special == paths.opencode_agents / "pstack":
                        target /= "agents"
                    if special == paths.cursor_plugin or not is_expected_link(
                        special, target
                    ):
                        moves.append(special)
                    continue
                if special == paths.cursor_plugin and (
                    same_tree(bundle, special)
                    or tree_digest(special) == state.get("pstack_digest")
                ):
                    continue
            if replace:
                moves.append(special)
            else:
                conflicts.append(str(special))
    lockfile = paths.home / ".agents" / ".skill-lock.json"
    if replace and moves and lockfile.exists():
        moves.append(lockfile)
    if conflicts:
        raise InstallError(
            "conflicting existing paths (use --replace to back them up):\n"
            + "\n".join(conflicts)
        )
    stable = paths.data_root / "pstack"
    paths.data_root.mkdir(parents=True, exist_ok=True)
    if stable.is_symlink() or not same_tree(bundle, stable):
        if stable.exists() or stable.is_symlink():
            backup.move(stable)
        copy_tree_atomic(bundle, stable)
    native_install(paths, stable)
    for item in dict.fromkeys(stale + moves):
        backup.move(item)
    for destination in paths.link_destinations:
        for name, source in skills.items():
            create_link(destination / name, source)
    if not same_tree(stable, paths.cursor_plugin):
        copy_tree_atomic(stable, paths.cursor_plugin)
    create_link(paths.opencode_skills / "pstack", stable)
    if (stable / "agents").is_dir():
        create_link(paths.opencode_agents / "pstack", stable / "agents")
    managed = {
        str(destination / name)
        for destination in paths.link_destinations
        for name in skills
    }
    managed.update(
        {
            str(paths.cursor_plugin),
            str(paths.opencode_skills / "pstack"),
            str(paths.opencode_agents / "pstack"),
        }
    )
    write_json(
        paths.state_file,
        {
            "version": 1,
            "managed_paths": sorted(managed),
            "skills": sorted(skills),
            "pstack_digest": tree_digest(stable),
        },
    )
    print(f"installed {len(skills)} skills and pstack")
    if backup.root:
        print(f"previous skills backed up at {backup.root}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify without changing files or running CLIs",
    )
    parser.add_argument(
        "--replace", action="store_true", help="back up and replace conflicting entries"
    )
    args = parser.parse_args(argv)
    paths = Paths.from_checkout(Path(__file__).resolve().parents[1])
    try:
        return check(paths) if args.check else install(paths, args.replace)
    except InstallError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
