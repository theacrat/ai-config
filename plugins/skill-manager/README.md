# Native skill manager

OpenCode V2 plugin for the ai-config checkout. It registers selected `sources.json`
entries and skills from personal, pstack, 1Password and Cloudflare source directories.
Manifest names are canonical IDs, including aliases whose upstream folders differ.
Original absolute `SKILL.md` paths preserve native relative-resource loading.

Only `skill-discovery` and enabled `thea-mode` advertise automatically. All other
managed skills remain registered with `autoinvoke: false`, so native explicit ID
loading and OpenChamber's skill/slash catalogue remain available. The discovery
guide directs the agent to load personal guidance and its required skills natively.
This is an instruction to the model, not guaranteed automatic execution.

## Installation contract

Run `bun install --frozen-lockfile` and `bun run build` in this package. Link the
whole `checkout/plugins/skill-manager` directory to
`~/.config/opencode/plugins/ai-config`. The package exports `dist/index.js`.
Its root `index.ts` re-exports that build for native directory discovery. Keep
this entrypoint: the installed V2 server skipped packages with only `main`/exports.
Checkout resolution follows the real package directory, including through symlinks.
Keep the source checkout and its submodules available. Missing selected files or
invalid YAML fail startup rather than silently dropping selected guidance.

The plugin replaces only entries resolved inside the checkout or the former
`$XDG_DATA_HOME/ai-config` bundle. External project and user overrides win. Other
skills retain their visibility. The released `@opencode/plugin@2.0.16` schema calls
the source file field `path`; the current guide's `location` example is outdated.

## Search and permissions

`skill_search` requires a query and accepts `offset` and `limit` with a maximum of 10. Results contain only exact ID, display name and description. Display names
and descriptions are capped at 120 and 500 characters. IDs are never truncated.
The tool searches only current managed definitions; external overrides and other
project/user skill metadata are excluded.

Search metadata is not permission-filtered. The released API has no read-only
effective permission evaluator, and `skill.list()` is not session-filtered.
Managed catalogue names and descriptions are therefore treated as public metadata.
If they are confidential, deny access to the search tool as well as the skill.
Search never returns content or loads a skill. Native `skill(id)` remains responsible
for allow/ask/deny, supporting files and slash invocation. No replacement loader or
V1 compatibility entrypoint is installed. The plugin does not reinterpret slash
frontmatter, which is absent from the released registry type.

## Refresh and checks

A location-local snapshot refreshes every 30 seconds. Changes reload the native
registry; transforms replay against fresh definitions and preserve project overrides.
Invalid refreshes retain the last good snapshot and log an error. Unloading clears
the timer and disposes both registrations. No session catalogue is shared or mutated.

Run `bun run check` for type checks against the released plugin package, lint,
format, Vitest tests and the production build.

Live verification on OpenCode 2.0.15 used a separate checkout fixture containing
150 skills with unique descriptions and supporting resources. The native registry
held 151 managed entries, with only `skill-discovery` advertised. Explicit native
activation of `proof-task-100` succeeded. A context hook captured the assembled
model request and stopped it before provider dispatch: the router was present,
all 150 hidden descriptions were absent, and the activated native body was present
in the messages. External skills remained advertised. This verifies native loading
and advertisement, not a browser-rendered OpenChamber slash interaction or native
allow/ask/deny decisions. Raw proof files are under
`/tmp/opencode/skill-manager-proof` on the verification machine.

References: [V2 skills](https://opencode.ai/v2/docs/skills),
[V2 plugin API](https://opencode.ai/v2/docs/build/plugins).
