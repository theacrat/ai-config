# Automatic model discovery

## Goal

Load models from an OpenAI-compatible `/models` endpoint into OpenCode V1 and V2 without maintaining a model list by hand. Credentials stay in environment variables. Discovery does not rewrite OpenCode configuration.

## Runtime boundary

The [V2 plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1) documents a default export with `server` for V1 and `setup` for V2. This entrypoint requires V1 1.18.29 or newer. V1 adds discovered models through its configuration hook. V2 registers a synchronous provider transform after fetching the inventory.

Older V1 hosts use a separate function export in `legacy.js`, verified on 1.2.27. V2 2.0.14 resolves local plugins through their directory's `index` entrypoint, so local configuration points to `dist`. Its first catalogue read can occur before plugin activation; the host verification waits for the plugin to become active in one persistent server.

Each configured source owns a provider ID and an API base URL. A shared discovery module validates options and endpoint responses, resolves a bearer token from an environment variable, and returns a typed inventory keyed by model ID. Version-specific adapters translate this inventory using each SDK's actual types.

The source model contains an ID, a display name, optional context and output limits, and optional tool support. Missing metadata uses documented, configurable defaults. Model names alone do not prove reasoning, vision, pricing, or context size. Manual model definitions take precedence over discovered metadata.

## Alternatives

| Design | Decision |
| --- | --- |
| Shared inventory with separate V1 and V2 adapters | Preferred. Uses public extension points and keeps version-specific types at the boundary. |
| Generate provider configuration files | Rejected. Creates shared mutable files, risks replacing user settings, and needs another reload mechanism. |

## Failure behaviour

Requests have a timeout and never follow redirects with credentials. Invalid responses do not partly replace a catalogue. Discovery failures leave existing provider configuration intact and report a sanitised diagnostic. Response bodies and bearer tokens never appear in logs. Different sources fail independently.

## Verification

Use a local HTTP endpoint to exercise authentication, metadata mapping, malformed responses, timeout, and both plugin entrypoints. Run actual V1 and V2 model listing against an isolated project and configuration. Probe the supplied CPA endpoint separately without saving its token in the repository.

## Work plan

- Ground the versioned plugin contracts and compare runtime transforms with generated files.
- Commit this design before implementation.
- Delegate the package implementation, then review and run the installed plugin in each host.
- Run tests, type checks, lint, formatting, and a credential scan before delivery.

The blocking steps are confirming the two plugin contracts and the endpoint's response shape. Package implementation has one owner because inventory mapping and the two adapters share types. Live-host verification can run separately once a build exists. No process writes a shared configuration file.
