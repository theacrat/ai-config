# ai-config

Skills and plugins for OpenChamber backed by OpenCode V2.

## Install

Install Git, Python 3.11 or newer, Bun 1.4.2, and OpenCode V2. Configure
OpenChamber to use that OpenCode installation.

```sh
git clone --recurse-submodules https://github.com/theacrat/ai-config.git ~/Git/ai-config
cd ~/Git/ai-config
cd plugins/skill-manager
bun install --frozen-lockfile
bun run build
cd ../..
./install.sh
./install.sh --check
python3 scripts/verify-loaders.py
```

Keep the checkout on disk. The installed plugin loads skills from it, preserving
their neighbouring scripts, references, and shared documentation. Restart the
OpenCode service after installing or updating the plugin, then reconnect
OpenChamber.

## Update

```sh
git pull --ff-only
git submodule update --init --recursive
cd plugins/skill-manager
bun install --frozen-lockfile
bun run build
cd ../..
./install.sh
./install.sh --check
```

The installer registers the native plugin under
`~/.config/opencode/plugins/ai-config` and pstack agents under
`~/.config/opencode/agents/pstack`. It respects `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`. Credentials, model choices, MCP connections, and OpenChamber
settings remain local to each device.

## Migrate an earlier installation

Run `./install.sh`. The installer retires recognised managed skill links in
OpenCode's shared discovery directories. If a destination contains conflicting
files, inspect the reported paths, then use `./install.sh --replace` to back them
up before replacement. Backups and installation state live under
`~/.local/share/ai-config` or the `XDG_DATA_HOME` equivalent.

The installer no longer manages Codex, Claude Code, Cursor, or Oh My Pi. Old
native plugin registrations in those applications are outside this installer.
Unrelated user and project skills remain available.

## Skill discovery

The V2 plugin registers skills with `autoinvoke: false` and advertises a small
discovery entry instead of every skill description. Search returns a bounded
page of matching skill metadata. Load a result with the native `skill` tool and
its exact ID. Native loading retains OpenCode's skill permission checks.

Skill bodies and supporting files load when requested. Adding another source
skill does not add another description to every model request. Explicit skill
selection remains available in clients that expose it.

Search exposes managed names and descriptions, including skills denied by a
native loading rule. It never returns their bodies. See the
[search permission contract](plugins/skill-manager/README.md#search-and-permissions).

See the [design note](docs/plans/opencode-v2-skills.md) and
[runtime research](docs/research/opencode-v2-skill-discovery.md), including the
[V2 skill documentation](https://opencode.ai/v2/docs/skills).

## Maintain the selection

`sources.json` selects upstream skills from pinned submodules under `sources/`.
The complete pstack bundle lives in `plugins/pstack`; 1Password and Cloudflare
live in their own plugin submodules. Personal guidance belongs in
`personal/skills/`.

Review upstream changes, update the relevant submodule revision, and commit that
revision here. Run `python3 scripts/vendor-skills.py --check` to check the
standalone source links. Do not use `npx skills update` on this checkout.

## Other plugins

The [model-discovery plugin](plugins/model-discovery/README.md) discovers
OpenAI-compatible provider models. Configure its V2 entry separately.

The [CLIProxyAPI panel](extensions/cliproxyapi/README.md) is an OpenChamber
extension for account quotas, cooldowns, and health. Install it through
OpenChamber's Extensions settings.

## Development checks

```sh
git config --local core.hooksPath .githooks
python3 -m unittest discover -s tests
uv run ruff check scripts tests
uv run ruff format --check scripts tests
cd plugins/skill-manager
bun run check
```

`scripts/verify-loaders.py` queries the actual OpenCode V2 registry without making
a model request. It fails if the managed advertised catalogue grows beyond its
fixed budget.

Run `python3 scripts/verify-skill-manager.py --keep` for an isolated installation
and native loading check against your installed V2 executable. It records the
registry and activation evidence under `/tmp/opencode`, then stops its private
server.

Run `python3 scripts/verify-skill-context.py --keep` to capture the actual model
request and exercise bounded search against a local fake provider.
