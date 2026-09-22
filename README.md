# ai-config

Personal skills shared across Codex, Claude Code, OpenCode, Oh My Pi and Cursor.

## OpenChamber extensions

[`extensions/cliproxyapi/`](extensions/cliproxyapi/README.md) contains a standalone
CLIProxyAPI panel for account quotas, cooldowns and health. Install it through
OpenChamber's Extensions settings. Its private connection settings stay on the
device running OpenChamber.

To develop the panel, install Bun 1.4.2 and run `bun install --frozen-lockfile`
inside `extensions/cliproxyapi`. From the repository root, run
`git config --local core.hooksPath .githooks` to enable its pre-commit checks.

## Set up another device

Install Git and Python 3.11 or newer. Sign in to GitHub so you can clone this private repository. macOS and Linux are supported, including WSL on Windows.

```sh
git clone --recurse-submodules https://github.com/theacrat/ai-config.git ~/Git/ai-config
cd ~/Git/ai-config
./install.sh --replace
./install.sh --check
```

`--replace` moves existing user-installed skills into a local backup before installing this selection. The installer keeps system skills, credentials, unrelated plugins and project-local files. Backups and install state live under `~/.local/share/ai-config`, or your `XDG_DATA_HOME` equivalent. Keep the checkout on disk because standalone skills link to it.

The Codex and Claude Code CLIs are optional. If either is missing, installation and `--check` skip its native plugin registration and verification. Shared skills, the Cursor and OpenCode bundles, and the Oh My Pi extension still install. After adding a missing CLI, rerun `./install.sh` to register its plugin. Errors from installed CLIs still fail the install.

Restart Codex, Claude, OpenCode, Oh My Pi and Cursor after installation. In Cursor, check Customize for pstack, 1password, and cloudflare. Local plugin imports must be allowed by your organisation. A marketplace installation of the same plugin takes precedence over the local copy. See [Cursor's local plugin rules](https://cursor.com/docs/plugins).

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
- `plugins/1password/` and `plugins/cloudflare/` pin those plugin repositories as submodules. The installer copies each one into `~/.cursor/plugins/local/` and links their skills into the shared skill directories.
- `sources/` pins upstream skill repositories as Git submodules. `skills/` holds symlinks into those checkouts. `sources.json` lists which upstream skills to install and where they live in each submodule; commit pins live only in Git. `licenses/` retains upstream licence text.
- `personal/skills/` holds your editable personal guidance, currently `thea-mode`. Its initial source is recorded in `personal/source.json`.
- `install.sh` installs this selection and `--check` checks local links, bundle files and native plugin registrations.

Edit personal skills here, then commit and push. Make upstream upgrades here too, review the diff, and commit the new snapshots or submodule revision before pulling them onto another device. Use this repository to update this selection. `npx skills update` manages a separate lockfile and can overwrite linked files.

For standalone skill upgrades, fetch and check out the reviewed commit inside the relevant submodule under `sources/` (or `plugins/pstack` for the two pstack skills), commit the updated submodule pointer in this repository, then run `python3 scripts/vendor-skills.py --refresh` if you changed the manifest. `python3 scripts/vendor-skills.py --check` verifies that every listed skill is linked. Keep personal edits under `personal/skills/` so they are not replaced.

For pstack, 1Password, or Cloudflare, fetch in `plugins/<name>`, check out the reviewed upstream commit, then commit the changed submodule pointer here. The `cli-for-agents` and `make-pr-easy-to-review` skills symlink into `plugins/pstack` and move with that submodule. The other sibling plugins in the pstack repository are not installed automatically.

Application settings, model choices, authentication, MCP connections and session histories stay local to each device. This repository synchronises skills and the plugin bundles.

## Installation layout

| App | Standalone skills | Plugins |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | Native `pstack@pstack-local` plugin |
| Claude Code | `~/.claude/skills/` | Native `pstack@pstack-local` plugin |
| OpenCode | Shared `~/.agents/skills/` discovery | Complete pstack bundle mounted under `~/.config/opencode/skills/pstack` and agents under `~/.config/opencode/agents/pstack` |
| Oh My Pi | `~/.omp/agent/skills/` | Stable pstack bundle registered as an `extensions` entry in `~/.omp/agent/config.yml` |
| Cursor | `~/.cursor/skills/` | Local copies at `~/.cursor/plugins/local/pstack`, `1password`, and `cloudflare` |

The installer retains a complete pstack copy at `~/.local/share/ai-config/pstack` for native marketplace registration, OpenCode mounts, and the Oh My Pi extension. It refreshes native caches when bundle contents change, even if upstream did not bump the plugin version. Environment overrides for Codex, Claude, Oh My Pi (`PI_CODING_AGENT_DIR`, `OMP_PROFILE`, `PI_PROFILE`, `PI_CONFIG_DIR`) and XDG directories are respected.

OpenCode discovers the bundled agents in its `all` mode, so they can be selected directly or delegated to. It ignores Cursor's background scheduling field. Its [skill discovery documentation](https://opencode.ai/docs/skills) describes the shared global directories.

Oh My Pi links standalone skills into `~/.omp/agent/skills/`. It also discovers `~/.agents/skills/`. The pstack bundle is registered as one extension path so its `skills/` and `agents/` stay next to `docs/`. An existing `config.yaml` is updated in place. Legacy `settings.json` is updated only when no YAML config exists, because a new YAML file would hide it. A project `extensions` list replaces the user list for that project. [Skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md).

## Verify native discovery

With all three CLIs installed:

```sh
python3 scripts/verify-loaders.py
```

This asks Codex, Claude and OpenCode to list their loaded skills without sending a model request. Oh My Pi has no headless skill list, so `./install.sh --check` confirms the skill links and the extension path. Cursor's files are checked by the installer; inspect its running UI after reload to confirm local imports are enabled.

Installer development checks:

```sh
python3 -m unittest discover -s tests
uv run ruff check scripts tests
uv run ruff format --check scripts tests
```
