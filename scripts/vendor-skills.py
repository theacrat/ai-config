#!/usr/bin/env python3
"""Materialize the skill snapshots recorded in sources.json.

The updater only fetches commits named in sources.json. It never resolves a
branch or tag, so refreshing is an explicit, pinned-source operation.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "sources.json"


class VendorError(RuntimeError):
    """Raised when a source cannot be materialized safely."""


def run(*args: str, cwd: Path | None = None, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def tree_hash(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(directory).as_posix().encode()
        digest.update(relative)
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
        digest.update(b"\n")
    return digest.hexdigest()


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise VendorError(f"cannot read {MANIFEST}: {exc}") from exc
    if manifest.get("schema_version") != 1:
        raise VendorError("sources.json must declare schema_version 1")
    skills = manifest.get("skills")
    if not isinstance(skills, list) or not skills:
        raise VendorError("sources.json must contain a non-empty skills list")
    seen_names: set[str] = set()
    seen_destinations: set[str] = set()
    for entry in skills:
        if not isinstance(entry, dict):
            raise VendorError("each skill entry must be an object")
        name = entry.get("name")
        destination = entry.get("destination")
        source = entry.get("source")
        if not isinstance(name, str) or not name:
            raise VendorError("each skill needs a non-empty name")
        if name in seen_names:
            raise VendorError(f"duplicate skill name: {name}")
        seen_names.add(name)
        if destination is not None:
            if not isinstance(destination, str) or not destination:
                raise VendorError(f"invalid destination for {name}")
            destination_path = Path(destination)
            if destination_path.is_absolute() or ".." in destination_path.parts:
                raise VendorError(f"destination escapes repository: {destination}")
            if destination in seen_destinations:
                raise VendorError(f"duplicate destination: {destination}")
            seen_destinations.add(destination)
        if not isinstance(source, dict):
            raise VendorError(f"missing source for {name}")
        for field in ("repository", "commit", "path"):
            if not isinstance(source.get(field), str) or not source[field]:
                raise VendorError(f"{name} source needs {field}")
        commit = source["commit"]
        if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
            raise VendorError(f"{name} source commit must be a full lowercase SHA")
        recorded_hash = source.get("sha256")
        if recorded_hash is not None and recorded_hash != "":
            if len(recorded_hash) != 64 or any(character not in "0123456789abcdef" for character in recorded_hash):
                raise VendorError(f"{name} source sha256 must be a lowercase digest")
    return manifest


def safe_member_path(member_name: str, source_path: str) -> Path | None:
    source = Path(source_path)
    member = Path(member_name)
    if source != member and source not in member.parents:
        if member in source.parents:
            return None
        raise VendorError(f"git archive contained unexpected path: {member_name}")
    try:
        relative = member.relative_to(source)
    except ValueError as exc:
        raise VendorError(f"git archive contained unexpected path: {member_name}") from exc
    if relative.is_absolute() or ".." in relative.parts:
        raise VendorError(f"git archive path escapes destination: {member_name}")
    return relative


def fetch_repo(repository: str, commit: str, directory: Path) -> None:
    run("git", "init", "--quiet", directory.as_posix())
    run("git", "remote", "add", "origin", repository, cwd=directory)
    run("git", "fetch", "--quiet", "--depth=1", "origin", commit, cwd=directory)
    run("git", "cat-file", "-e", f"{commit}^{{commit}}", cwd=directory)


def archive_skill(repo_directory: Path, commit: str, source_path: str, destination: Path) -> None:
    archive = subprocess.run(
        ("git", "archive", "--format=tar", commit, source_path),
        cwd=repo_directory,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        members = tar.getmembers()
        if not members:
            raise VendorError(f"source path does not exist: {source_path}")
        for member in members:
            relative = safe_member_path(member.name, source_path)
            if relative is None:
                continue
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                extracted = tar.extractfile(member)
                if extracted is None:
                    raise VendorError(f"cannot read archived file: {member.name}")
                target.write_bytes(extracted.read())
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise VendorError(f"unsupported archive entry: {member.name}")


def apply_compatibility(entry: dict[str, Any], staging: Path) -> None:
    if entry["name"] != "sharp-edges":
        return
    skill_file = staging / "SKILL.md"
    text = skill_file.read_text()
    preface = (
        "If the `sharp-edges-analyzer` agent is unavailable in the current harness, "
        "run the four phases inline and use the bundled references directly."
    )
    if preface not in text:
        marker = "# Sharp Edges Analysis\n\n"
        if marker not in text:
            raise VendorError("sharp-edges compatibility marker is missing")
        skill_file.write_text(text.replace(marker, f"{marker}{preface}\n\n", 1))


def materialize(
    entry: dict[str, Any], repository_cache: dict[tuple[str, str], Path], temp_root: Path
) -> tuple[str, str]:
    source = entry["source"]
    cache_key = (source["repository"], source["commit"])
    repo_directory = repository_cache.get(cache_key)
    if repo_directory is None:
        repo_directory = temp_root / f"repo-{len(repository_cache)}"
        fetch_repo(source["repository"], source["commit"], repo_directory)
        repository_cache[cache_key] = repo_directory

    staging = temp_root / "staged" / entry["name"]
    if staging.exists():
        shutil.rmtree(staging)
    archive_skill(repo_directory, source["commit"], source["path"], staging)
    source_hash = tree_hash(staging)
    apply_compatibility(entry, staging)
    return source_hash, tree_hash(staging)


def destination_path(entry: dict[str, Any]) -> Path | None:
    destination = entry.get("destination")
    return ROOT / destination if destination else None


def write_manifest(manifest: dict[str, Any]) -> None:
    temporary = MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    os.replace(temporary, MANIFEST)


def check(manifest: dict[str, Any]) -> int:
    failures = 0
    for entry in manifest["skills"]:
        destination = destination_path(entry)
        if destination is None:
            continue
        expected = entry.get("bundle_sha256")
        if not expected:
            print(f"MISSING BUNDLE HASH {entry['name']}")
            failures += 1
            continue
        if not destination.is_dir():
            print(f"MISSING {entry['name']}: {destination.relative_to(ROOT)}")
            failures += 1
            continue
        actual = tree_hash(destination)
        if actual != expected:
            print(f"MISMATCH {entry['name']}: expected {expected}, got {actual}")
            failures += 1
        else:
            print(f"OK {entry['name']}")
    return failures


def refresh(manifest: dict[str, Any], update_hashes: bool) -> int:
    entries = [entry for entry in manifest["skills"] if destination_path(entry) is not None]
    with tempfile.TemporaryDirectory(prefix="vendor-skills-") as temporary_name:
        temporary_root = Path(temporary_name)
        repository_cache: dict[tuple[str, str], Path] = {}
        staged_hashes: dict[str, tuple[str, str]] = {}
        for entry in entries:
            source_hash, bundle_hash = materialize(entry, repository_cache, temporary_root)
            expected_source = entry["source"].get("sha256")
            if expected_source and source_hash != expected_source and not update_hashes:
                raise VendorError(
                    f"{entry['name']} source hash changed; rerun with --update-hashes "
                    "only after reviewing the pinned commit"
                )
            expected_bundle = entry.get("bundle_sha256")
            if expected_bundle and bundle_hash != expected_bundle and not update_hashes:
                raise VendorError(
                    f"{entry['name']} curated bundle hash changed; review compatibility edits "
                    "before rerunning with --update-hashes"
                )
            staged_hashes[entry["name"]] = source_hash, bundle_hash

        for entry in entries:
            source = entry["source"]
            source_hash, bundle_hash = staged_hashes[entry["name"]]
            source["sha256"] = source_hash
            entry["bundle_sha256"] = bundle_hash
            destination = destination_path(entry)
            assert destination is not None
            staged = temporary_root / "staged" / entry["name"]
            if destination.exists():
                shutil.rmtree(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staged, destination)

    if update_hashes:
        write_manifest(manifest)
    return check(manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="verify materialized skills against recorded hashes")
    action.add_argument("--refresh", action="store_true", help="materialize the exact pinned commits")
    parser.add_argument(
        "--update-hashes",
        action="store_true",
        help="with --refresh, accept reviewed hash changes and rewrite sources.json",
    )
    arguments = parser.parse_args()
    if arguments.update_hashes and not arguments.refresh:
        parser.error("--update-hashes requires --refresh")
    try:
        manifest = load_manifest()
        if arguments.check:
            return 1 if check(manifest) else 0
        return 1 if refresh(manifest, arguments.update_hashes) else 0
    except (OSError, subprocess.CalledProcessError, VendorError) as exc:
        print(f"vendor-skills: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
