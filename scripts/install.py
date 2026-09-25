#!/usr/bin/env python3
"""Register the repository skill manager for OpenChamber through OpenCode V2."""

from __future__ import annotations

import argparse
import configparser
import json
import os
import shutil
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path


class InstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class Paths:
    checkout: Path
    home: Path
    xdg_config: Path
    data_root: Path

    @classmethod
    def from_checkout(cls, checkout: Path) -> Paths:
        home = Path(os.environ.get("HOME") or Path.home()).expanduser().absolute()
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        data = Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share")
        if not config.is_absolute() or not data.is_absolute():
            raise InstallError(
                "XDG_CONFIG_HOME and XDG_DATA_HOME must be absolute paths"
            )
        return cls(checkout.resolve(), home, config, data / "ai-config")

    @property
    def state_file(self) -> Path:
        return self.data_root / "state.json"

    @property
    def backup_root(self) -> Path:
        return self.data_root / "backups"

    @property
    def visible_skill_roots(self) -> tuple[Path, ...]:
        return (
            self.home / ".agents/skills",
            self.home / ".claude/skills",
            self.xdg_config / "opencode/skills",
            self.xdg_config / "opencode/skill",
        )

    @property
    def links(self) -> dict[Path, Path]:
        return {
            self.xdg_config / "opencode/plugins/ai-config": self.checkout
            / "plugins/skill-manager",
            self.xdg_config / "opencode/agents/pstack": self.checkout
            / "plugins/pstack/pstack/agents",
        }


def exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def link_target(path: Path) -> Path | None:
    if not path.is_symlink():
        return None
    return Path(os.path.abspath(path.parent / os.readlink(path)))


def expected_link(path: Path, source: Path) -> bool:
    return link_target(path) == source


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_state(paths: Paths) -> tuple[int, dict[Path, Path | None]]:
    try:
        state = json.loads(paths.state_file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return 2, {}
    except (ValueError, UnicodeError) as exc:
        raise InstallError(f"invalid installer state: {paths.state_file}") from exc
    if not isinstance(state, dict):
        raise InstallError("installer state must be an object")
    version = state.get("version")
    if version == 1:
        entries = state.get("managed_paths")
        if isinstance(entries, list) and all(isinstance(p, str) for p in entries):
            return 1, {Path(p): None for p in entries}
    elif version == 2:
        entries = state.get("managed_links")
        if isinstance(entries, dict) and all(
            isinstance(p, str) and isinstance(t, str) for p, t in entries.items()
        ):
            return 2, {Path(p): Path(t) for p, t in entries.items()}
    raise InstallError(
        "unsupported or malformed installer state; expected version 1 or 2"
    )


def validate_sources(paths: Paths) -> set[str]:
    modules = configparser.ConfigParser()
    try:
        modules.read(paths.checkout / ".gitmodules")
    except configparser.Error as exc:
        raise InstallError("invalid .gitmodules") from exc
    for section in modules.sections():
        relative = Path(modules.get(section, "path"))
        root = paths.checkout / relative
        if relative.is_absolute() or ".." in relative.parts:
            raise InstallError(f"invalid submodule path: {relative}")
        if not root.is_dir() or not any(root.iterdir()):
            raise InstallError(
                f"missing submodule: {relative}; run git submodule update --init --recursive"
            )
    names: set[str] = set()
    for root in (paths.checkout / "skills", paths.checkout / "personal/skills"):
        if not root.is_dir():
            raise InstallError(f"missing skill source directory: {root}")
        for entry in root.iterdir():
            if entry.is_symlink() or entry.is_dir():
                if not (entry / "SKILL.md").is_file():
                    raise InstallError(
                        f"missing skill source: {entry}; "
                        "run git submodule update --init --recursive"
                    )
                names.add(entry.name)
    if not names:
        raise InstallError("no source skills found")
    plugin = paths.checkout / "plugins/skill-manager"
    if not (plugin / "dist/index.js").is_file():
        raise InstallError(f"skill manager is not built: {plugin / 'dist/index.js'}")
    agents = paths.checkout / "plugins/pstack/pstack/agents"
    if not agents.is_dir() or not any(agents.glob("*.md")):
        raise InstallError(f"missing pstack agents: {agents}")
    return names


def safe_parent(paths: Paths, path: Path) -> bool:
    """Do not follow a visible directory alias into another application's files."""
    anchors = (paths.xdg_config, paths.home)
    for anchor in anchors:
        if path.is_relative_to(anchor):
            relative = path.relative_to(anchor)
            return all(
                not (anchor.joinpath(*relative.parts[:i])).is_symlink()
                for i in range(1, len(relative.parts))
            )
    return False


def owned_skill_target(paths: Paths, target: Path | None) -> bool:
    if target is None or not target.is_absolute() or ".." in target.parts:
        return False
    roots = (
        paths.checkout / "skills",
        paths.checkout / "personal/skills",
        paths.checkout / "sources",
        paths.checkout / "plugins",
        paths.data_root / "pstack",
    )
    return any(target.is_relative_to(root) for root in roots)


def migration_entries(
    paths: Paths, prior: dict[Path, Path | None], names: set[str]
) -> dict[Path, bool]:
    result: dict[Path, bool] = {}
    for root in paths.visible_skill_roots:
        if not safe_parent(paths, root / "entry") or not root.is_dir():
            continue
        for entry in root.iterdir():
            target = link_target(entry)
            recorded = prior.get(entry)
            if recorded is not None and owned_skill_target(paths, recorded):
                result[entry] = target == recorded
            elif owned_skill_target(paths, target):
                result[entry] = True
            elif entry in prior and (entry.name in names or entry.name == "pstack"):
                result[entry] = False
    return result


class Backup:
    def __init__(self, paths: Paths) -> None:
        self.paths = paths
        self.root: Path | None = None
        self.manifest: list[dict[str, str]] = []

    def move(self, path: Path) -> None:
        if self.root is None:
            self.root = self.paths.backup_root / uuid.uuid4().hex
            self.root.mkdir(parents=True, exist_ok=False)
        destination = self.root / str(len(self.manifest))
        try:
            shutil.move(str(path), str(destination))
        except OSError as exc:
            raise InstallError(f"could not back up {path}: {exc}") from exc
        self.manifest.append({"original": str(path), "backup": str(destination)})
        write_json(self.root / "manifest.json", self.manifest)

    def restore(self) -> None:
        for item in reversed(self.manifest):
            original = Path(item["original"])
            saved = Path(item["backup"])
            if saved.is_symlink():
                os.symlink(os.readlink(saved), original)
            elif saved.is_dir():
                shutil.copytree(saved, original, symlinks=True)
            else:
                shutil.copy2(saved, original)


def restore_state(path: Path, content: bytes | None) -> None:
    if content is None:
        path.unlink(missing_ok=True)
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def install(paths: Paths, replace: bool = False) -> int:
    names = validate_sources(paths)
    version, prior = read_state(paths)
    moves: list[Path] = []
    conflicts: list[Path] = []
    for path, proven in migration_entries(paths, prior, names).items():
        (moves if proven or replace else conflicts).append(path)
    for path, source in paths.links.items():
        if not safe_parent(paths, path):
            raise InstallError(
                f"refusing to write through a symlinked directory: {path}"
            )
        if not exists(path) or expected_link(path, source):
            continue
        old_agents = (
            version == 1
            and path in prior
            and path.name == "pstack"
            and expected_link(path, paths.data_root / "pstack/agents")
        )
        recorded = prior.get(path)
        role = source.relative_to(paths.checkout).parts
        old_registration = (
            version == 2
            and recorded is not None
            and recorded.is_absolute()
            and ".." not in recorded.parts
            and recorded.parts[-len(role) :] == role
            and expected_link(path, recorded)
        )
        (moves if old_agents or old_registration or replace else conflicts).append(path)
    if conflicts:
        raise InstallError(
            "conflicting existing paths (use --replace to back them up):\n"
            + "\n".join(str(p) for p in conflicts)
        )
    backup = Backup(paths)
    created: list[Path] = []
    previous_state = (
        paths.state_file.read_bytes() if paths.state_file.exists() else None
    )
    state_attempted = False
    try:
        for path in sorted(set(moves)):
            backup.move(path)
        for path, source in paths.links.items():
            if not expected_link(path, source):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(source, target_is_directory=True)
                created.append(path)
        state = {
            "version": 2,
            "managed_links": {str(p): str(t) for p, t in paths.links.items()},
        }
        if version != 2 or prior != paths.links:
            state_attempted = True
            write_json(paths.state_file, state)
    except Exception as exc:
        try:
            for path in reversed(created):
                path.unlink()
            backup.restore()
            if state_attempted:
                restore_state(paths.state_file, previous_state)
        except OSError as rollback_error:
            raise InstallError(
                f"installation failed: {exc}; rollback failed: {rollback_error}; "
                f"recover saved entries from {backup.root}"
            ) from exc
        raise InstallError(f"installation failed and was rolled back: {exc}") from exc
    print("registered skill manager and pstack agents for OpenCode V2")
    if backup.root:
        print(f"previous entries backed up at {backup.root}")
    return 0


def check(paths: Paths) -> int:
    names = validate_sources(paths)
    version, prior = read_state(paths)
    problems: list[str] = []
    for path, target in paths.links.items():
        if not safe_parent(paths, path) or not expected_link(path, target):
            problems.append(f"missing or incorrect link: {path}")
    for path in migration_entries(paths, prior, names):
        problems.append(f"stale OpenCode-visible managed entry: {path}")
    if version != 2 or prior != paths.links:
        problems.append("installer state is missing or stale; run the installer")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print("healthy: skill manager and pstack agents registered for OpenCode V2")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check", action="store_true", help="verify without writing files"
    )
    mode.add_argument(
        "--replace",
        action="store_true",
        help="back up conflicting managed destinations",
    )
    args = parser.parse_args(argv)
    try:
        paths = Paths.from_checkout(Path(__file__).resolve().parents[1])
        return check(paths) if args.check else install(paths, args.replace)
    except (InstallError, OSError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
