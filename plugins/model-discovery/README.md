# Model discovery for OpenCode

Load an OpenAI-compatible model catalogue at plugin startup. Each configured source becomes an OpenCode provider. Discovery changes the in-memory model registry; it does not write configuration files.

The default export is a native OpenCode V2 plugin with `setup()`. It targets `@opencode/plugin` 2.0.14.

## Build

Run these commands in `plugins/model-discovery` with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run check
```

This runs TypeScript checks for source and tests, oxlint, oxfmt, Vitest, and a Bun build with declarations in `dist/`. Tests serve local HTTP endpoints and exercise the V2 provider transform. Live host verification is separate from these package tests.

To run these checks before committing plugin changes, enable the repository hook from the repository root:

```sh
git config core.hooksPath plugins/model-discovery/.githooks
```

## Configure V2

Use an absolute path to the built `dist` directory in your `opencode.jsonc`:

```jsonc
{
	"$schema": "https://opencode.ai/config.json",
	"plugins": [
		{
			"package": "/absolute/path/ai-config/plugins/model-discovery/dist",
			"options": {
				"sources": [
					{
						"id": "compatible",
						"baseURL": "https://llm.example.com/v1",
						"apiKeyEnv": "MODEL_API_KEY",
					},
				],
			},
		},
	],
}
```

Set `MODEL_API_KEY` to your bearer token in the environment of the OpenCode server. Omit `apiKeyEnv` for an unauthenticated server. V2 passes this options object through `ctx.options`.

You can also set `OPENCODE_MODEL_DISCOVERY` to JSON:

```sh
export OPENCODE_MODEL_DISCOVERY='{"sources":[{"id":"compatible","baseURL":"https://llm.example.com/v1","apiKeyEnv":"MODEL_API_KEY"}]}'
```

The plugin uses that variable only when native options are absent or an empty object. Explicit options replace the environment configuration entirely. `{ "sources": [] }` disables discovery. Invalid options produce a sanitised diagnostic and leave providers unchanged.

## Options

```ts
type Options = {
	sources: Array<{
		id: string;
		baseURL: string;
		apiKeyEnv?: string;
		modelsURL?: string;
		discovery?: boolean;
		models?: Array<
			| string
			| {
					id: string;
					name?: string;
					context?: number;
					output?: number;
					tools?: boolean;
					reasoning?: boolean;
					cost?: {
						input: number;
						output: number;
						cache_read?: number;
						cache_write?: number;
						context_over_200k?: {
							input: number;
							output: number;
							cache_read?: number;
							cache_write?: number;
						};
					};
					release_date?: string;
					attachment?: boolean;
					temperature?: boolean;
					status?: "alpha" | "beta" | "deprecated" | "active";
					modalities?: {
						input?: Array<"text" | "audio" | "image" | "video" | "pdf">;
						output?: Array<"text" | "audio" | "image" | "video" | "pdf">;
					};
					reasoning_options?: Array<{
						type: "effort";
						values: string[];
					}>;
			  }
		>;
		timeoutMs?: number;
		defaults?: {
			context?: number;
			output?: number;
			tools?: boolean;
		};
	}>;
};
```

| Option             | Behaviour                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Unique provider ID. Model IDs may contain `/`.                                                                                                                              |
| `baseURL`          | HTTP(S) API root used for inference, typically ending in `/v1`.                                                                                                             |
| `modelsURL`        | Optional HTTP(S) catalogue URL. Defaults to `baseURL` with `/models` appended to its path.                                                                                  |
| `discovery`        | Fetch the catalogue at startup. Default `true`. Set to `false` to use only configured models without a listing request.                                                     |
| `models`           | Explicit model IDs or metadata objects. Default `[]`. Configured fields override discovered fields; configured-only IDs are retained.                                       |
| `apiKeyEnv`        | Environment variable containing the bearer token. Missing or empty values fail that source without a request. The token is also passed to the inference provider in memory. |
| `timeoutMs`        | Discovery request timeout including response body reading. Default `10000`.                                                                                                 |
| `defaults.context` | Context token limit when metadata is missing. Default `32768`.                                                                                                              |
| `defaults.output`  | Output token limit when metadata is missing. Default `4096`.                                                                                                                |
| `defaults.tools`   | Tool support when metadata is missing. Default `true`.                                                                                                                      |

The context/output defaults are assumptions, not measured model limits. Tool support defaults to `true` for coding-agent use; set it to `false` for servers without tool calling. Tune these defaults to your server or add manual per-model overrides in OpenCode configuration. Numbers must be positive safe integers. `timeoutMs` must not exceed `2147483647`.

URLs may not contain user info or fragments. Keep credentials in `apiKeyEnv`. An explicit `modelsURL` receives the same bearer token as discovery at `baseURL`, so it must identify a trusted endpoint. Redirects are rejected rather than followed.

## Endpoint format and overrides

Any OpenAI-compatible inference endpoint can be configured, including servers without a model-listing route. For those servers, supply the exact model IDs accepted by inference and disable discovery:

```json
{
	"sources": [
		{
			"id": "compatible",
			"baseURL": "https://llm.example.com/v1",
			"apiKeyEnv": "MODEL_API_KEY",
			"discovery": false,
			"models": [
				"organisation/coder",
				{
					"id": "another-model",
					"name": "Another model",
					"context": 65536,
					"output": 8192,
					"tools": false
				}
			]
		}
	]
}
```

With `discovery: false`, an empty `models` list still registers the source so native OpenCode manual model definitions can supply its models. The plugin never guesses model IDs. Missing credentials still skip the source. Configured model objects reject unknown fields, duplicate IDs and invalid metadata.

With discovery enabled, each explicitly supplied metadata field overrides its discovered counterpart. Omitted fields retain discovered metadata, including the display name for a string ID. Configured-only models use source defaults for missing limits and tool support. Native OpenCode model settings take precedence over this combined inventory.

All models are on by default, including models with `tools: false`. Explicit native disable settings, provider activation choices and model filters still apply.

When discovery is enabled, the endpoint must return a JSON object with a `data` array:

```json
{
	"data": [
		{
			"id": "organisation/coder",
			"name": "Coder",
			"context_length": 65536,
			"max_output_tokens": 8192,
			"supports_tools": true,
			"modalities": { "input": ["text", "image"], "output": ["text"] },
			"reasoning": true,
			"reasoning_options": [
				{ "type": "effort", "values": ["low", "medium", "high"] }
			]
		},
		{ "id": "another-model", "object": "model", "owned_by": "local" }
	]
}
```

Only `id` is required per model. `name` defaults to `id`. The plugin recognises these optional server extensions:

| Metadata       | Precedence                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Context limit  | `context_length`, then `max_context_length`, then the source default                                                |
| Output limit   | `max_output_tokens`, then the source default                                                                        |
| Tool support   | `tool_call`, then `supports_tools`, then the source default                                                         |
| Thinking       | `reasoning_options`, or `supported_reasoning_levels[].effort`                                                       |
| Display name   | `name`; duplicate names get ` (owned_by)` appended                                                                  |
| Pricing        | `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write`, and the same fields in `cost.context_over_200k` |
| Model metadata | `release_date`, `attachment`, `temperature`, `status`                                                               |

These fields are not guaranteed by the standard OpenAI models endpoint. Numeric strings, null limits, nonpositive limits, duplicate model IDs and malformed entries invalidate that source's whole response. Unknown fields such as `object` are ignored. `owned_by` is used only for display names. `created` is not treated as a release date. Empty catalogues are valid. The IDs `__proto__`, `prototype` and `constructor` are rejected for both providers and models. IDs cannot contain `#` or surrounding whitespace. Provider IDs cannot contain `/`; model IDs can.

The plugin does not infer pricing, reasoning or vision support from names. When the endpoint supplies effort values, V2 exposes variants with `reasoningEffort` settings. The plugin carries endpoint `modalities.input` and `modalities.output`, defaulting missing directions to `["text"]`. Configured directions override discovered directions. Existing manual overrides can supply additional capabilities or costs.

Pricing is in USD per million tokens, with no unit conversion. V2 converts it to `cost` entries, with the base rate first and `context_over_200k` as a context tier of size `200000`. Missing cache rates become zero in V2, matching OpenCode's catalogue conversion. Explicit zero prices stay zero; absent pricing stays an empty cost array. Arbitrary pricing formats and other tier shapes are not supported.

V2 carries `status` and converts `release_date` to epoch milliseconds in `time.released`. Missing or unparseable dates use zero; missing status uses `active`. Status alone does not disable a discovered model. V2 has no equivalent capability flags for `reasoning`, `attachment` and `temperature`, so it uses explicit modalities and effort variants instead. It does not translate a temperature-support flag into a generation temperature or attach unsupported fields to models.

V2 adds source definitions through `ctx.provider.transform`. Existing source models with the same ID retain their fields while discovered variants are merged by ID, with existing variants taking precedence, and OpenCode applies its configured model overrides when it materialises models. The plugin preserves unrelated providers, manual-only models, provider settings and activation choices. Existing provider settings override the source's base URL and API key for inference; discovery itself always uses the source options.

## Refresh and failures

Discovery runs once when the plugin loads, with sources fetched concurrently. There is no polling. Restart the OpenCode server or unload/reload the plugin to fetch a new catalogue. Replaying a V2 provider transform alone does not fetch again.

A timeout, HTTP error or invalid response falls back to configured `models` when supplied. This includes listing access denied, since inference may have separate permissions. Without configured models, a failed request leaves the existing provider unchanged. A missing credential always skips the source. Other sources continue.

HTTP 404, 405 and 501 report `discovery-unavailable`. HTTP 401 and 403 report `authentication-error`. A successful empty catalogue reports `empty-catalogue` and retains configured and existing manual models. Unsupported and empty listings suggest explicit models with `discovery: false`.

Diagnostics contain a fixed actionable message, an error code, the zero-based position in `sources`, and an HTTP status where applicable. They never include tokens, URLs, raw exceptions or response bodies. V2 writes structured warnings to the host's stderr. V2 disposes its transform when the plugin unloads.

## Verify installed hosts

After building, run this from the repository root on Linux or macOS:

```sh
python3 scripts/verify-model-discovery.py \
  --v2 /path/to/opencode-v2
```

The script starts authenticated local endpoints, isolates the host's configuration and data, and verifies discovery plus inference. V2 verification also checks manual model overrides. It starts a private server and waits for plugin activation because initial V2 catalogue reads can precede plugin startup. Every server stops when the check finishes.

## API references

- [V2 plugins and provider transforms](https://opencode.ai/v2/docs/build/plugins)
