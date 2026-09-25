# Automatic model discovery

## Goal

Load models from an OpenAI-compatible `/models` endpoint into OpenCode V2 without maintaining a model list by hand. Credentials stay in environment variables. Discovery does not rewrite OpenCode configuration.

## Runtime boundary

The [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins) defines the native `setup` entrypoint. The plugin registers a synchronous provider transform after fetching the inventory.

Local configuration points to the built `dist` directory. The first catalogue read can occur before plugin activation; host verification waits for the plugin to become active in one persistent server.

Each configured source owns a provider ID and an API base URL. The discovery module validates options and endpoint responses, resolves a bearer token from an environment variable, and returns a typed inventory keyed by model ID. The V2 adapter translates this inventory using the released plugin types.

The source model contains an ID, a display name, optional context and output limits, and optional tool support. Missing metadata uses documented, configurable defaults. Model names alone do not prove reasoning, vision, pricing, or context size. Manual model definitions take precedence over discovered metadata.

## Alternatives

| Design | Decision |
| --- | --- |
| Typed inventory with a native V2 provider transform | Preferred. Uses the supported plugin API without writing configuration. |
| Generate provider configuration files | Rejected. Creates shared mutable files, risks replacing user settings, and needs another reload mechanism. |

## Failure behaviour

Requests have a timeout and never follow redirects with credentials. Invalid responses do not partly replace a catalogue. Discovery failures leave existing provider configuration intact and report a sanitised diagnostic. Response bodies and bearer tokens never appear in logs. Different sources fail independently.

## Verification

Use a local HTTP endpoint to exercise authentication, metadata mapping, malformed responses, timeout, and the plugin entrypoint. Run actual V2 model listing against an isolated project and configuration. Probe the configured endpoint separately without saving its token in the repository.

## Servers without discovery

Sources may provide `models`, an explicit list of model IDs or metadata objects, and set `discovery: false` to skip the catalogue request. With discovery enabled, configured model metadata overrides discovered metadata and configured-only models are retained. Every model is selectable by default. Explicit OpenCode disable settings still win.

A missing catalogue route, an empty catalogue, an authentication failure, and an invalid response have distinct diagnostics. Configured models remain usable when discovery fails. Without configured models, a failed request preserves the existing provider rather than guessing IDs. Missing credentials still prevent source registration. Diagnostics give a fixed, actionable message without including credentials or response bodies.

The installed loader reads a local options file. Provider names, endpoints, and credential paths belong in that file rather than in the loader. Work is split between the shared discovery package and local installation plus real-host verification; neither writes the other's configuration.

## Work plan

- Ground the versioned plugin contracts and compare runtime transforms with generated files.
- Commit this design before implementation.
- Review and run the installed plugin in the supported V2 host.
- Run tests, type checks, lint, formatting, and a credential scan before delivery.

Confirm the V2 plugin contract and the endpoint's response shape before changing inventory mapping. Live-host verification runs after a build exists. No process writes a shared configuration file.
