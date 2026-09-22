# Model discovery for OpenCode

Load an OpenAI-compatible model catalogue at plugin startup. Each configured source becomes an OpenCode provider. Discovery changes the in-memory model registry; it does not write configuration files.

The default export has `server()` for OpenCode V1 1.18.29+ and `setup()` for V2. It targets `@opencode-ai/plugin` 1.18.32 and `@opencode/plugin` 2.0.14. V1 loads no V2 runtime code. Releases before V1 1.18.29 are not supported.

## Build

Run these commands in `plugins/model-discovery` with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run check
```

This runs TypeScript checks for source and tests, oxlint, oxfmt, Vitest, and a Bun build with declarations in `dist/`. Tests serve local HTTP endpoints and exercise both adapters. Live host verification is separate from these package tests.

## Configure V2

Use an absolute path to this package directory in your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/ai-config/plugins/model-discovery",
      "options": {
        "sources": [
          {
            "id": "local-models",
            "baseURL": "http://127.0.0.1:8000/v1",
            "apiKeyEnv": "LOCAL_MODEL_API_KEY",
          },
        ],
      },
    },
  ],
}
```

Set `LOCAL_MODEL_API_KEY` in the environment of the OpenCode server. Omit `apiKeyEnv` for an unauthenticated server. V2 passes this options object through `ctx.options`.

## Configure V1

V1 1.18.29+ supports the dual object entrypoint and a package/options tuple. Point to the built entrypoint:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/ai-config/plugins/model-discovery/dist/index.js",
      {
        "sources": [
          {
            "id": "local-models",
            "baseURL": "http://127.0.0.1:8000/v1",
            "apiKeyEnv": "LOCAL_MODEL_API_KEY",
          },
        ],
      },
    ],
  ],
}
```

The tuple's second element is passed directly as the second argument of `server(input, options)`. It is the `{ "sources": [...] }` object, without an additional `options` wrapper.

For a host or loader without native options support, use a plain plugin path and set `OPENCODE_MODEL_DISCOVERY` to JSON:

```sh
export OPENCODE_MODEL_DISCOVERY='{"sources":[{"id":"local-models","baseURL":"http://127.0.0.1:8000/v1","apiKeyEnv":"LOCAL_MODEL_API_KEY"}]}'
```

Both entrypoints use that variable only when native options are absent or an empty object. Explicit options replace the environment configuration entirely. `{ "sources": [] }` disables discovery. Invalid options produce a sanitised diagnostic and leave providers unchanged.

## Options

```ts
type Options = {
  sources: Array<{
    id: string;
    baseURL: string;
    apiKeyEnv?: string;
    modelsURL?: string;
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
| `apiKeyEnv`        | Environment variable containing the bearer token. Missing or empty values fail that source without a request. The token is also passed to the inference provider in memory. |
| `timeoutMs`        | Discovery request timeout including response body reading. Default `10000`.                                                                                                 |
| `defaults.context` | Context token limit when metadata is missing. Default `32768`.                                                                                                              |
| `defaults.output`  | Output token limit when metadata is missing. Default `4096`.                                                                                                                |
| `defaults.tools`   | Tool support when metadata is missing. Default `true`.                                                                                                                      |

The context/output defaults are assumptions, not measured model limits. Tool support defaults to `true` for coding-agent use; set it to `false` for servers without tool calling. Tune these defaults to your server or add manual per-model overrides in OpenCode configuration. Numbers must be positive safe integers. `timeoutMs` must not exceed `2147483647`.

URLs may not contain user info or fragments. Keep credentials in `apiKeyEnv`. An explicit `modelsURL` receives the same bearer token as discovery at `baseURL`, so it must identify a trusted endpoint. Redirects are rejected rather than followed.

## Endpoint format and overrides

The endpoint must return a JSON object with a `data` array:

```json
{
  "data": [
    {
      "id": "organisation/coder",
      "name": "Coder",
      "context_length": 65536,
      "max_output_tokens": 8192,
      "supports_tools": true
    },
    { "id": "another-model", "object": "model", "owned_by": "local" }
  ]
}
```

Only `id` is required per model. `name` defaults to `id`. The plugin recognises these optional server extensions:

| Metadata      | Precedence                                                           |
| ------------- | -------------------------------------------------------------------- |
| Context limit | `context_length`, then `max_context_length`, then the source default |
| Output limit  | `max_output_tokens`, then the source default                         |
| Tool support  | `tool_call`, then `supports_tools`, then the source default          |

These fields are not guaranteed by the standard OpenAI models endpoint. Numeric strings, null limits, nonpositive limits, duplicate model IDs and malformed entries invalidate that source's whole response. Unknown fields such as `object` and `owned_by` are ignored. Empty catalogues are valid. The IDs `__proto__`, `prototype` and `constructor` are rejected for both providers and models.

The plugin does not infer pricing, reasoning or vision support from names. V1 leaves pricing unspecified. V2 supplies an empty cost list and text-only modalities. Existing manual overrides can supply additional capabilities or costs.

V1 merges discovered models into the provider's configuration, with manual fields and nested limits taking precedence. V2 adds source definitions through `ctx.provider.transform`. Existing source models with the same ID take precedence as complete definitions, and OpenCode applies its configured model overrides when it materialises models. Both adapters preserve unrelated providers, manual-only models, provider settings and activation choices. Existing provider settings override the source's base URL and API key for inference; discovery itself always uses the source options.

## Refresh and failures

Discovery runs once when the plugin loads, with sources fetched concurrently. There is no polling. Restart the OpenCode server or unload/reload the plugin to fetch a new catalogue. Replaying a V2 provider transform alone does not fetch again.

A timeout, HTTP error, invalid response or missing credential leaves that source's existing provider unchanged. Other sources continue. Diagnostics contain a fixed error code, the zero-based position in `sources`, and an HTTP status where applicable. They never include tokens, URLs, raw exceptions or response bodies. V1 sends diagnostics through the SDK logger; V2 writes structured warnings to the host's stderr. V2 disposes its transform when the plugin unloads.

## API references

- [V2 plugins and provider transforms](https://opencode.ai/v2/docs/build/plugins)
- [V1 migration and dual entrypoints](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
