# ai-config

Personal skills shared across Codex, Claude Code, OpenCode and Cursor.

## Set up another device

Install Git and Python 3.11 or newer. Sign in to GitHub so you can clone this private repository. macOS and Linux are supported, including WSL on Windows.

```sh
git clone --recurse-submodules https://github.com/theacrat/ai-config.git ~/Git/ai-config
cd ~/Git/ai-config
./install.sh --replace
./install.sh --check
```

`--replace` moves existing user-installed skills into a local backup before installing this selection. The installer keeps system skills, credentials, unrelated plugins and project-local files. Backups and install state live under `~/.local/share/ai-config`, or your `XDG_DATA_HOME` equivalent. Keep the checkout on disk because standalone skills link to it.

The Codex and Claude Code CLIs are optional. If either is missing, installation and `--check` skip its native plugin registration and verification. Shared skills and the Cursor and OpenCode bundles still install. After adding a missing CLI, rerun `./install.sh` to register its plugin. Errors from installed CLIs still fail the install.

Restart Codex, Claude, OpenCode and Cursor after installation. In Cursor, check Customize for pstack. Local plugin imports must be allowed by your organisation. A marketplace pstack installation takes precedence over the local copy. See [Cursor's local plugin rules](https://cursor.com/docs/plugins).

## Sync an existing device

```sh
cd ~/Git/ai-config
git pull --ff-only
git submodule update --init --recursive
./install.sh
./install.sh --check
```

Run the installer again if you move the checkout. It recreates links for the new location. It installs the committed selection and does not fetch newer skill content.

## What belongs here

- `plugins/pstack/` pins the complete pstack repository as a Git submodule. Keeping the bundle intact preserves its shared docs and agents.
- `skills/` contains selected upstream skill snapshots with their supporting files. `sources.json` records revisions and provenance. `licenses/` retains upstream licences.
- `personal/skills/` holds your editable personal guidance, currently `thea-mode`. Its initial source is recorded in `personal/source.json`.
- `install.sh` installs this selection and `--check` checks local links, bundle files and native plugin registrations.

Edit personal skills here, then commit and push. Make upstream upgrades here too, review the diff, and commit the new snapshots or submodule revision before pulling them onto another device. Use this repository to update this selection. `npx skills update` manages a separate lockfile and can overwrite linked files.

For standalone upgrades, change the relevant full commit SHAs in `sources.json`, then run `python3 scripts/vendor-skills.py --refresh --update-hashes`. Review skill changes and upstream licence changes before committing. `--refresh` without `--update-hashes` restores the recorded versions, and `--check` verifies their recorded hashes offline. Keep personal edits under `personal/skills/` so an upstream refresh does not replace them.

For pstack, fetch in `plugins/pstack`, check out the reviewed upstream commit, then commit the changed submodule pointer here. The other sibling plugins in that repository are not installed automatically.

Application settings, model choices, authentication, MCP connections and session histories stay local to each device. This repository synchronises skills and the pstack bundle.

## Installation layout

| App | Standalone skills | pstack |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | Native `pstack@pstack-local` plugin |
| Claude Code | `~/.claude/skills/` | Native `pstack@pstack-local` plugin |
| OpenCode | Shared `~/.agents/skills/` discovery | Complete bundle mounted under `~/.config/opencode/skills/pstack` and agents under `~/.config/opencode/agents/pstack` |
| Cursor | `~/.cursor/skills/` | Complete local copy at `~/.cursor/plugins/local/pstack` |

The installer retains a complete pstack copy at `~/.local/share/ai-config/pstack` for native marketplace registration and OpenCode mounts. It refreshes native caches when bundle contents change, even if upstream did not bump the plugin version. Environment overrides for Codex, Claude and XDG directories are respected.

OpenCode discovers the bundled agents in its `all` mode, so they can be selected directly or delegated to. It ignores Cursor's background scheduling field. Its [skill discovery documentation](https://opencode.ai/docs/skills) describes the shared global directories.

## Verify native discovery

With all three CLIs installed:

```sh
python3 scripts/verify-loaders.py
```

This asks Codex, Claude and OpenCode to list their loaded skills without sending a model request. Cursor's files are checked by the installer; inspect its running UI after reload to confirm local imports are enabled.

Installer development checks:

```sh
python3 -m unittest discover -s tests
uv run ruff check scripts tests
uv run ruff format --check scripts tests
```
