#!/usr/bin/env python3
"""Inspect the native OpenCode V2 skill registry without a model request."""

import argparse
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", default="opencode")
    args = parser.parse_args()
    version = subprocess.check_output([args.opencode, "--version"], text=True)
    if not version.strip().startswith("opencode v2."):
        raise SystemExit(f"OpenCode V2 required, found {version.strip()}")
    result = subprocess.run(
        [args.opencode, "api", "get", "/api/skill"],
        capture_output=True,
        text=True,
        check=True,
        timeout=90,
    )
    skills = json.loads(result.stdout)["data"]
    root = Path(__file__).resolve().parents[1]
    managed = [
        skill for skill in skills if Path(skill.get("path", "/")).is_relative_to(root)
    ]
    if not managed:
        raise SystemExit(
            "No managed skills loaded. Run ./install.sh, restart the OpenCode "
            "service, and open this checkout in OpenChamber before checking."
        )
    advertised = [skill["id"] for skill in managed if skill.get("autoinvoke", True)]
    if len(advertised) > 2:
        raise SystemExit(f"Unbounded managed catalogue: {advertised}")
    ids = {skill["id"] for skill in skills}
    if "skill-discovery" not in ids:
        raise SystemExit("The skill discovery entry is missing.")
    print(
        f"OpenCode V2 loaded {len(managed)} managed skills; "
        f"{len(advertised)} advertised entries: {', '.join(advertised)}"
    )


if __name__ == "__main__":
    main()
