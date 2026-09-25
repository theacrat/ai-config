# OpenCode V2 skill discovery research

Research date: 2026-09-25. Main checkout was read only. No model requests or delegates were used.

## Recommendation

Keep the native skill registry and loader. Use a V2 plugin transform to set `autoinvoke = false` on the managed catalogue, expose bounded metadata search, and advertise one tiny discovery/router skill. Native explicit ID loading remains available. Do not replace the registry with a custom Markdown loader merely to reduce prompt size.

The important unresolved implementation gate is **permission-aware discovery**. `ctx.skill.list()` is a location catalogue, not a list filtered for the calling session's selected agent and permissions. Returning its descriptions blindly can reveal denied skills. Native `skill` loading still enforces its own permissions, but that does not prevent metadata disclosure by a search tool.

## Evidence and versions

- Official [skills](https://opencode.ai/v2/docs/skills), [plugins](https://opencode.ai/v2/docs/build/plugins), and [migration](https://opencode.ai/v2/docs/migrate-v1) pages, fetched on the research date.
- Installed executable: `/home/thea/.bun/bin/opencode`, resolving to the globally installed `@opencode/cli` binary. Both `opencode --version` and `opencode api get /api/info` reported **2.0.15**.
- Examined published **`@opencode/plugin@2.0.15`**, downloaded from `https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.15.tgz`; package dependencies pin matching `@opencode/schema`, `client`, `protocol`, `util`, and `ai` versions. Files inspected under `/tmp/opencode/skill-research-package/package/dist/promise/`.
- OpenChamber first-party checkout: `https://github.com/theacrat/openchamber`, clean commit **9abd1313bdca53d4fc59ffa31becc26c3d6fcdec**. Its package manifests pin `@opencode/client` **2.0.16**. Do not assume the CLI and UI dependency versions already match.
- Live OpenAPI saved at `/tmp/opencode/skill-research-openapi.json`.

## Design comparison

| Concern | Native registry + hidden advertisements | Remove registry + custom loader |
| --- | --- | --- |
| Prompt footprint | One router description and bounded search results | Similar, but no additional savings that justify replacing loading |
| Explicit native skill ID | Preserved | Fails after removal |
| Supporting files and base directory | Native loader supplies directory and sample of up to ten paths | Must reproduce directory and path semantics |
| Permissions | Native loading retained; search still needs filtering | Must reproduce skill action/resource checks and approval behavior |
| Source overrides | Native precedence retained | Must reproduce discovery, case-sensitive IDs, duplicate precedence, refresh |
| OpenChamber | Existing catalogue and ID attachments continue to work | Skill list disappears; UI may show fallback disk entries that cannot resolve natively |
| Slash experience | Autoinvoke is independent of slash by documented contract | Must rebuild commands/UI integration |
| Maintenance | Small transform and search tool | Owns a second skill subsystem |

A custom loader can be justified only by requirements native loading cannot represent. Catalogue token reduction alone is already supported.

## Exact API details and documentation drift

`@opencode/plugin@2.0.15` exports `Plugin` from its Promise entrypoint. `Plugin.define` accepts `{ id, setup(ctx) }`; returning a cleanup callback is supported. A dependency-free generated JavaScript plugin can default-export the same object. This is how OpenChamber materializes its managed tools.

`dist/promise/skill.d.ts` provides:

```ts
interface SkillEditor {
  list(): readonly DeepMutable<Skill.Info>[];
  get(id: string): DeepMutable<Skill.Info> | undefined;
  add(skill: Skill.Info): void;
  update(id: string, update: (skill: DeepMutable<Skill.Info>) => void): void;
  remove(id: string): void;
}
```

`ctx.skill.transform` and `reload` exist. Transforms are synchronous and replayable; fetch external inputs before registering and explicitly reload captured data. A later transform can undo an earlier policy, so verify the final catalogue, not only the callback.

**Use `path`, not `location`, in `Skill.Info` for 2.0.15.** The live schema requires `id`, `name`, `path`, and `content`; `description` and `autoinvoke` are optional. The current plugin guide's add example still uses `location`, contradicting the installed schema. The schema does not expose a `slash` field in Skill.Info.

`ctx.tool.transform` registers tools with JSON Schema input and an executor returning `{ content: string }`. `Tool.Context` contains sessionID, agent, messageID, call ID, progress; the Promise adapter adds `signal`. There is no legacy `context.directory`, `context.abort`, or `context.ask`. Resolve the actual calling session when directory-sensitive work is required; `ctx.location` describes plugin instance scope.

The installed `PermissionDomain` exposes `list`, `get`, `reply`, and `hook('evaluate', ...)`, **not an evaluate/check/ask method**. The guide's newer `ctx.permission.rules` example is also absent from that installed declaration. `Tool.Options.permission` names a permission action; its existence does not prove the custom loader can express native per-skill resource checks. Do not invent `ctx.permission.evaluate` or reuse pending-request listing as an authorization decision.

Configured plugins should be **absolute directory paths with a package.json and entrypoint**, not individual JS files. OpenChamber documents this requirement in `packages/web/server/lib/opencode/DOCUMENTATION.md:41-57`. Auto-discovered global plugin files are a distinct loading path and already exist on this machine. Absolute directory configuration avoids ambiguity in relative resolution.

## Native semantics to retain

Official skills docs explicitly state that `metadata.opencode/autoinvoke: false` only removes a skill from the model's available list. The skill remains registered and explicitly loadable. `slash` and `metadata.opencode/slash` control interactive catalogue visibility independently.

Native permissions use action `skill`, resource equal to the exact case-sensitive ID. Last matching rule wins. `deny` hides and rejects; `ask` remains advertised and asks on loading. Agent rules can override global rules. Session rules add another scope, so filtering only static global config is insufficient.

Native discovery includes global/project `.claude/skills` and `.agents/skills`, global/project OpenCode skills, then explicit configured sources. Later sources override by ID. Frontmatter name is a display name, not identity. Hiding only one installation directory will not remove advertisements from compatibility sources or built-ins. Choose and document whether the transform governs all skills or only owned skills; do not silently suppress project-specific skills while describing the feature as an installer-only policy.

Recommended search shape: required nonempty query, hard capped result count (for example 5), capped ID/name/description lengths, deterministic ordering, no body content, no full-catalogue fallback, explicit zero-match output. Search IDs and descriptions plus deliberate routing aliases rather than relying on directory categories alone. Return exact IDs and instruct the model to call native `skill`. Keep universally required instructions genuinely tiny rather than advertising dozens of supposedly mandatory principles.

## OpenChamber integration

First-party source references at the commit above:

- `packages/web/server/lib/opencode/skill-routes.js:131-195`: authoritative catalogue comes from `client.skill.list()`, scoped with percent-encoded `x-opencode-directory`. Reads V2 `path` with a compatibility fallback to `location`, normalizes `/builtin/` to read-only panel entries. Failed reads return null, allowing a local disk fallback; an empty authoritative list is distinct.
- `packages/ui/src/components/chat/CommandAutocomplete.tsx:143-162`: maps discovered skills into slash suggestions without filtering autoinvoke. Therefore keeping hidden skills registered preserves this UI path.
- `packages/ui/src/lib/opencode/client.ts:1107-1141`: sends resolved skills as `session.prompt({skills:[{id}]})`. If the skill disappears between listing and admission, it falls back to synthetic instructions and retries without the attachment. A custom loader that removes registry entries would push ordinary invocation into this fallback.
- `packages/web/server/lib/opencode/managed-config-file.js` and `managed-plugin-config.js` own OpenChamber's generated config layer. The research shell actually has `OPENCODE_CONFIG` pointing at that managed layer. Install ai-config through its own plugin entry; do not overwrite OpenChamber's generated config.

OpenChamber's mapping currently uses display name for suggestions and the native catalogue to resolve IDs. Preserve stable IDs even if presentation changes. The reviewed mapping does not carry slash metadata, so native docs alone are insufficient to promise `slash:false` is honored by this specific OpenChamber revision.

## Local runtime proof

Probe artifact directory: `/tmp/opencode/skill-proof`. Isolated files only; no main-checkout or global-config edit. No model invocation. A scratch session was created with no model override, ID `ses_f27c94ba3ffeeWi7Q96UU69wzr`.

The successful probe configured an absolute directory plugin, with package.json `main: index.js`, default exporting `{id, setup}`. Its transform added:

```js
{ id: 'proof-hidden', name: 'Proof Hidden',
  description: 'Hidden advertisement', autoinvoke: false,
  path: '/tmp/opencode/skill-proof/proof.md', content: 'PROOF_NATIVE_BODY' }
```

After `POST /api/location/reload` scoped to the scratch directory, `GET /api/skill` returned that exact entry including `autoinvoke:false`. Result saved at `/tmp/opencode/skill-proof/final.json`.

`POST /api/experimental/session/ses_f27c94ba3ffeeWi7Q96UU69wzr/skill` with `{"id":"proof-hidden","resume":false}` then returned success (204). This proves hidden registration remains explicitly activatable through the native API without generating model output. It does **not** prove model-side tool permission checks, UI rendering, or outgoing prompt token reduction.

`GET /api/command` did not include the synthetic skill. Do not equate that endpoint with OpenChamber's combined slash catalogue: the UI separately maps skills to suggestions. Also, cold location reads initially returned empty catalogues before reload/activation; loader verification must distinguish uninitialized registries from genuinely missing definitions. Initial probes using a configured JS file and then a relative directory did not load the probe; the absolute directory with its own entrypoint did.

Remaining acceptance proof for implementation: capture outgoing model context with a local fake endpoint or context hook; assert the full descriptions are absent and the router is present; exercise search result cap and no-match behavior; verify native allow/ask/deny with the actual skill tool; verify OpenChamber slash attachment; reload and verify project override behavior. No such broader claim is made here.

## Current installer architecture and migration ownership

`install.sh` delegates to `scripts/install.py`. `Paths` honors HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, XDG_DATA_HOME. State is `$XDG_DATA_HOME/ai-config/state.json` (version 1), with a flat managed_paths list, skills list and pstack digest. Backups move paths into timestamped backup directories with manifest.json.

`discover_skills` merges top-level skills, extra Cursor-manifest plugin skills with setdefault, then personal skills as overrides. `extra_plugins` is selected by `.cursor-plugin/plugin.json`, not a generic plugin manifest. Pstack is special-cased separately and copied to stable `$XDG_DATA_HOME/ai-config/pstack`.

The installer creates per-skill symlinks under `.agents/skills`, `.claude/skills`, `.cursor/skills`, and the detected Oh My Pi agent directory. It uses native Codex/Claude installation for pstack, copies Cursor plugin directories, links OpenCode `skills/pstack` to the stable entire bundle and `agents/pstack` to its agents, and edits Oh My Pi extension configuration. OpenCode therefore gets ordinary skills via compatibility discovery rather than an explicit ordinary-skill install loop.

Migration risks:

1. `clean_skill_dirs` scans entire destination directories. Unknown items become conflicts, or are backed up under `--replace`; a V2-only rework must not treat unrelated user skills as disposable cleanup.
2. Ownership is path-only. For a previously managed symlink, current logic can replace it without verifying that it still points to the previously owned target. Record artifact identity/target and distinguish user replacements from stale owned artifacts.
3. Config mutations and native package installs are not comprehensively represented by managed_paths. Dropping the old target loops alone leaves registrations and extension entries behind. Enumerate old owned mutations before retiring them.
4. `.agents` and `.claude` duplicates remain visible to OpenCode even after moving one native folder. Catalogue policy must operate on resolved IDs; migration cleanup must operate on owned artifacts.
5. Keep vendoring/provenance (`sources.json`, source roots, license paths) distinct from deployment ownership. Current sources schema is 3, installation state schema is 1.
6. `scripts/verify-loaders.py` invokes obsolete `opencode --pure debug skill`; installed V2 offers neither that flag nor that subcommand. Replace that probe with location-scoped V2 API verification and initialize/reload the location before asserting catalogue contents.
7. Preserve external plugins, MCP/provider settings and OpenChamber's managed config. A single owned plugin directory avoids taking over its generated files or broad plugin folder.

Suggested ownership boundary: ai-config owns source selection, deterministic deployment artifacts, its own V2 plugin and its own install-state migration. OpenCode owns skill discovery/loading/permissions. OpenChamber owns client UI and its generated integration layer.
