# ai-config

Personal skills shared across Codex, Claude Code, OpenCode and Cursor.

## Design

- `skills/` holds reviewed standalone skill snapshots and personal guidance.
- `plugins/pstack/` pins the complete pstack repository as a Git submodule.
- `sources.json` records each upstream revision and selected skill path.
- `install.sh` installs offline from this checkout, recreates local links, and registers complete plugins where supported.
- Existing user skills are moved to a local backup on replacement. Credentials, system skills, unrelated plugins and project-local files are not managed here.
- `--check` verifies installed state. Installation must be idempotent and independent of the clone location.
- Updates are reviewed and committed on one device; other devices pull with submodules and rerun the installer. Installer runs never fetch latest skill content implicitly.
