#!/usr/bin/env python3
"""Inspect the native OpenCode V2 skill registry without a model request."""

import argparse
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path


def request(binary, path):
    with tempfile.TemporaryFile(mode="w+") as output:
        subprocess.run(
            [binary, "api", "get", path],
            stdout=output,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
            timeout=90,
        )
        output.seek(0)
        return json.load(output)["data"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", default="opencode")
    args = parser.parse_args()
    version = subprocess.check_output([args.opencode, "--version"], text=True)
    if re.fullmatch(r"opencode v2\.\S+", version.strip()) is None:
        raise SystemExit(f"OpenCode V2 required, found {version.strip()}")
    root = Path(__file__).resolve().parents[1]
    deadline = time.monotonic() + 30
    while True:
        skills = request(args.opencode, "/api/skill")
        managed = [
            skill
            for skill in skills
            if Path(skill.get("path", "/")).is_relative_to(root)
        ]
        if managed or time.monotonic() >= deadline:
            break
        time.sleep(0.2)
    if not managed:
        raise SystemExit(
            "No managed skills loaded. Run ./install.sh, restart the OpenCode "
            "service, and open this checkout in OpenChamber before checking."
        )
    advertised = [skill["id"] for skill in managed if skill.get("autoinvoke", True)]
    service = [
        skill["id"]
        for skill in managed
        if skill.get("autoinvoke", True)
        and (
            "plugins/cloudflare" in skill.get("path", "")
            or "plugins/1password" in skill.get("path", "")
        )
    ]
    if service:
        raise SystemExit(
            f"Service sections advertised outside a relevant project: {service}"
        )
    ids = {skill["id"] for skill in skills}
    if "skill-discovery" not in ids:
        raise SystemExit("The skill discovery entry is missing.")
    print(
        f"OpenCode V2 loaded {len(managed)} managed skills; "
        f"{len(advertised)} advertised entries: {', '.join(advertised)}"
    )


if __name__ == "__main__":
    main()
