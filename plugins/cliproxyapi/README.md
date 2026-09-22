# cliproxyapi

Personal integration for a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) instance. Two artifacts share the same endpoint.

- `cliproxyapi.ts` registers a `cliproxyapi` provider in OpenCode and loads its model list from the instance's `GET /v1/models` endpoint. One module serves OpenCode v1 and v2.
- `openchamber/` is an OpenChamber extension that shows every account quota in a rail panel and a full-screen page.

## OpenCode plugin

Endpoint and API key come from the Codex CLIProxyAPI config, `[model_providers.cliproxyapi]` in `config.toml` (`base_url` and `experimental_bearer_token`). The plugin checks `$CODEX_HOME/config.toml`, then `~/.codex-custom/config.toml`, then `~/.codex/config.toml`.

Overrides, in order: plugin options, then environment.

| Variable | Meaning |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | Endpoint, e.g. `https://crate.thea.pet/cpa/v1` |
| `CLIPROXYAPI_API_KEY` | Bearer token for the models endpoint |
| `CLIPROXYAPI_CONFIG` | Path to the Codex `config.toml` to read when no key is set |
| `CLIPROXYAPI_OUTPUT_LIMIT` | Per-model output token cap (default 65536) |

`./install.sh` links the plugin to `~/.config/opencode/plugins/cliproxyapi.ts`. Verify with `./install.sh --check`, then `opencode models cliproxyapi`.

## OpenChamber extension

Install the folder in **Settings → Extensions → Add** and point it at `plugins/cliproxyapi/openchamber`. Approve the external-service permission, then paste the CPA **management key** in **Settings → Integrations → CLIProxyAPI**. The panel lives on the rail and as an **Extension pages** entry.

The key is a management key, not the proxy API key. It is stored by OpenChamber and never committed.

Quotas come from `GET /v0/management/auth-files`, plus a live probe per credential through `POST /v0/management/api-call`:

- Codex: `chatgpt.com/backend-api/wham/usage` (5h/7d windows, plan).
- Antigravity: `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (per-model remaining).
- Anything else falls back to the `X-Codex-*` signal headers CPA already recorded.

Providers without a probe render as unknown rather than failing the whole panel.

## Rebuilding the panel

`panel/main.js` is the built IIFE OpenChamber loads; rebuild it after editing `panel/main.ts` or `panel/quota.ts`.

```sh
cd plugins/cliproxyapi/openchamber
npm install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
```
