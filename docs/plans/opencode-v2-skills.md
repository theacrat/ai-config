# OpenChamber skill management on OpenCode V2

## Acceptance

The installer supports OpenChamber backed by OpenCode V2. It registers one native
skill-management plugin and pstack's agents. Managed skill count must not increase
the advertised prompt catalogue. All selected skills remain explicitly loadable
through the native skill tool with their original supporting files.

Installation is repeatable. Checks do not write files. Migration preserves
unrelated skills and application settings, and backs up replaced managed links.

## Evidence and design

OpenCode 2.0.15 is installed on the development machine. The V2
[skills documentation](https://opencode.ai/v2/docs/skills) says `autoinvoke: false`
omits a skill from the model's available list while retaining explicit loading.
The [plugin API](https://opencode.ai/v2/docs/build/plugins) exposes native skill
and tool transforms. The [migration guide](https://opencode.ai/v2/docs/migrate-v1)
identifies plugins and server integrations as breaking changes.

Use a native skill registry with a small discovery entry and a bounded search
tool. Keep content loading in the native skill tool so its permission checks and
supporting-file resolution remain effective. A custom content loader would
duplicate those responsibilities. Project-local overrides retain precedence.

The domain consists of source skill records, native registry entries, and owned
installation links. It has no per-application installer matrix or per-session
mutable skill activation state. Sources stay in their complete checkout trees.

## Work sequence

1. Research V2 and OpenChamber against first-party documentation and source.
2. Build the native plugin and its catalogue-size checks in one isolated branch.
3. Replace the multi-application installer and its temporary-home tests in another.
4. Integrate the branches, update documentation, checks and CI.
5. Run the installed V2 service against an isolated home and inspect the actual
   registry, advertised skills, search results and explicit skill loading.
6. Review the combined diff independently and resolve findings before shipping.

The plugin and installer can proceed independently against one contract: the
installer links `plugins/skill-manager` into the global OpenCode plugins directory.
The plugin owns skill selection; the installer owns filesystem registration.

Existing uncommitted changes to personal guidance and model discovery are user
work and must be preserved.

## Progress

- Grounding complete. Existing installation targets five applications and writes
  shared discovery directories, producing duplicate sources in V2.
- Installer replaced and verified with 23 temporary-home tests, including moved
  checkouts and rollback after link or state-write failures.
- First-party research and hidden-skill native activation proof recorded in
  `docs/research/opencode-v2-skill-discovery.md`.
- Native plugin passes 10 tests. On OpenCode 2.0.15, the integrated checkout
  registers 99 managed skills and advertises two. Hidden native loading,
  supporting source files, and project override precedence pass the isolated
  runtime check.
- Model discovery now supports V2 only. All 27 tests and the isolated live
  discovery and inference check pass.
- Captured model-request verification and final independent review are pending.
