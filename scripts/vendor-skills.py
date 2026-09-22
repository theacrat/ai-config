#!/usr/bin/env python3
"""Maintain skill symlinks declared in sources.json.

sources.json lists which upstream skills to expose under skills/. Version pins
live in Git submodule pointers, not in the manifest.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "sources.json"


class VendorError(RuntimeError):
    """Raised when skill links cannot be verified or refreshed."""


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise VendorError(f"cannot read {MANIFEST}: {exc}") from exc
    if manifest.get("schema_version") != 3:
        raise VendorError("sources.json must declare schema_version 3")
    skills = manifest.get("skills")
    if not isinstance(skills, list) or not skills:
        raise VendorError("sources.json must contain a non-empty skills list")
    seen_names: set[str] = set()
    for entry in skills:
        if not isinstance(entry, dict):
            raise VendorError("each skill entry must be an object")
        name = entry.get("name")
        root = entry.get("root")
        rel_path = entry.get("path")
        if not isinstance(name, str) or not name:
            raise VendorError("each skill needs a non-empty name")
        if name in seen_names:
            raise VendorError(f"duplicate skill name: {name}")
        seen_names.add(name)
        if not isinstance(root, str) or not root:
            raise VendorError(f"{name} needs root")
        root_path = Path(root)
        if root_path.is_absolute() or ".." in root_path.parts:
            raise VendorError(f"{name} root escapes repository: {root}")
        if not isinstance(rel_path, str) or not rel_path:
            raise VendorError(f"{name} needs path")
        rel = Path(rel_path)
        if rel.is_absolute() or ".." in rel.parts:
            raise VendorError(f"{name} path escapes root: {rel_path}")
    return manifest


def skill_destination(name: str) -> Path:
    return ROOT / "skills" / name


def skill_target(entry: dict[str, Any]) -> Path:
    return ROOT / entry["root"] / entry["path"]


def link_skill(entry: dict[str, Any]) -> None:
    destination = skill_destination(entry["name"])
    target = skill_target(entry)
    if not (target / "SKILL.md").is_file():
        raise VendorError(f"{entry['name']} source is missing SKILL.md: {target}")
    rel = os.path.relpath(target, destination.parent)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() and destination.resolve() == target.resolve():
            return
        if destination.is_symlink():
            destination.unlink()
        elif destination.is_dir():
            shutil.rmtree(destination)
        else:
            destination.unlink()
    destination.symlink_to(rel, target_is_directory=True)


def refresh(manifest: dict[str, Any]) -> None:
    run("git", "submodule", "update", "--init", "--recursive", cwd=ROOT)
    for skill in manifest["skills"]:
        link_skill(skill)


def check_skill(entry: dict[str, Any]) -> tuple[bool, str]:
    root = ROOT / entry["root"]
    if not root.is_dir():
        return False, f"missing checkout: {entry['root']}"
    destination = skill_destination(entry["name"])
    target = skill_target(entry)
    if not (target / "SKILL.md").is_file():
        return False, f"upstream SKILL.md missing at {target.relative_to(ROOT)}"
    if not destination.is_symlink():
        return False, "expected symlink under skills/"
    if destination.resolve() != target.resolve():
        return False, f"symlink points to {destination.resolve()}, expected {target}"
    return True, "OK"


def check(manifest: dict[str, Any]) -> int:
    failures = 0
    for entry in manifest["skills"]:
        ok, message = check_skill(entry)
        if ok:
            print(f"OK {entry['name']}")
        else:
            print(f"MISMATCH {entry['name']}: {message}")
            failures += 1
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument(
        "--check",
        action="store_true",
        help="verify skill symlinks against sources.json",
    )
    action.add_argument(
        "--refresh",
        action="store_true",
        help="init submodules and recreate skill symlinks",
    )
    arguments = parser.parse_args()
    try:
        manifest = load_manifest()
        if arguments.refresh:
            refresh(manifest)
        return 1 if check(manifest) else 0
    except (OSError, subprocess.CalledProcessError, VendorError) as exc:
        print(f"vendor-skills: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
