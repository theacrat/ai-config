# CLIProxyAPI quota panel for OpenChamber

A standalone panel and full-page view for live Codex and Antigravity quotas,
account controls, saved CPA observations, and cooldowns. Requires OpenChamber 1.24.2 or later
on desktop or web. VS Code and mobile do not run guest local services.

## Install

1. On the machine running the OpenChamber host, create
   `~/.config/openchamber/cliproxyapi.json` with your editor:

   ```json
   {
     "baseUrl": "http://cpa.nb",
     "managementKey": "REPLACE_WITH_YOUR_EXISTING_CPA_MANAGEMENT_KEY"
   }
   ```

   Use an origin, without a path, query, fragment, or URL credentials. `baseUrl`
   defaults to `http://cpa.nb` if omitted. The key must already exist in CPA.
   The extension does not change this configuration file. Keep it private,
   outside the extension directory. On Linux and macOS, use
   `chmod 600 ~/.config/openchamber/cliproxyapi.json`.

2. In OpenChamber, open **Settings → Extensions** and install this folder or
   `dist/openchamber-cliproxyapi.zip`. Approve the local service when prompted.
   The committed `panel/main.js` and `service/main.js` are ready to run. No build
   or dependency installation is needed for folder installation.
3. Open **CLIProxyAPI** from the rail, or from the Extension pages menu for the
   full-page view. Use **Refresh** after editing the configuration file.

The service runs on the host machine, which may differ from the browser machine.
CPA must permit management access from that host. OpenChamber starts the service
on demand with its own Node-compatible runtime. The installed extension does not
need Bun or a system Node installation.

The service is necessary because OpenChamber's token integration requires an HTTPS
origin and CPA may use HTTP. HTTP carries the management key without transport
encryption. Use a trusted private network or configure an HTTPS CPA origin.

## Reading the panel

Usage and reset times appear first. Expand **Search and display options** for
filters and timezone selection, **Manage account** for actions, and **Account
details** for quota flags, saved readings, and model observations. Account errors
and active cooldowns stay visible. Action results appear below the controls.

- Search by account name, provider, or stable auth index. Filter by provider, health, or unknown
  account quota. Display names use CPA's label, then email, then filename, then
  provider and index as a fallback. Hover the name for the full index. Display
  strings are limited to 80 characters with control characters removed.
- Bars show **percent remaining** and empty as quota is consumed. They use the
  host theme's success colour at 70% or above, warning from 30%, and error below
  30%, matching CPA's thresholds. Zero is a real measurement. Missing or invalid
  measurements display as unknown. Live and passive Codex primary, secondary,
  additional, and code-review windows are decoded, along with observed
  allowed/limit-reached flags, active-limit attribution, and credits. Other providers
  retain their saved readings. Antigravity groups show percent remaining, computed from
  remaining fractions, with group descriptions and reset times.
- Account observations and model observations are separate. Expand **Model
  observations** to inspect the latter. Model names are preserved, bounded, and
  rendered as plain text.
- Saved observation times come from CPA's `quota.observed_at`. Relative resets are
  anchored to that timestamp, never to the most recent refresh. Observations older
  than 15 minutes display as stale. A passed reset time does not imply replenished
  quota; another observation is needed.
- Live readings have their own response timestamp and do not change CPA's saved
  observation time. Failed reads retain previous measurements with an explicit
  stale/error label. Expand **Saved CPA observation** to compare the two sources.
- Reset and retry times include their UTC offset. The Time zone selector switches
  between the browser's local timezone and UTC without changing CPA's timestamps.
- Health, disablement, unavailability and cooldowns describe different CPA states.
  An empty known cooldown set does not prove an account is available. A null or
  missing cooldown set displays as unknown, including remote scheduling state.
- The panel polls once per minute while the document is visible and fetches when
  it becomes visible. Refresh failures preserve the previous snapshot with a stale
  label. Service crashes and missing service approval require manual Refresh.

## Account controls

- **Refresh** queries live provider quotas through CPA's management `api-call`.
  Accounts can succeed or fail independently. Antigravity requires `project_id`
  in the private CPA listing; missing projects produce an account-level error.
- **Enable / Disable** changes the account's CPA status. **Refresh credentials**
  asks CPA to refresh that account's credentials. Raw credentials stay server-side.
- **Use banked reset** appears for Codex and is enabled when available credits are
  greater than zero, even if the applicable count is zero. The panel shows the
  available count and next expiry. Confirm in the panel to consume one reset.
  This calls the provider's credit-consumption endpoint, not CPA's local cooldown reset.
- Mutation results remain on the account. A successful consumption followed by a
  failed quota read is reported as consumed. An uncertain transport outcome is
  labelled uncertain and is never automatically retried. Check current state
  before submitting again.
- **Open management** uses the SDK's `host.openUrl` to open the configured origin's
  `/management.html` in the external desktop browser or a new web tab, without a key.
  The link is available even when CPA quota requests fail.

## Service contract

`service/main.js` is bundled CommonJS for the host's actual Node runtime. The
package intentionally has no `type: "module"`. The panel is a classic IIFE.

The service binds `127.0.0.1` using `OPENCHAMBER_SERVICE_PORT`. Every request,
including `GET /health`, requires
`Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`. The host owns this token;
the iframe never receives it. Fixed routes are:

| Route           | Operation                                    |
| --------------- | -------------------------------------------- |
| `GET /health`   | Service readiness                            |
| `GET /info`     | Public management URL only                   |
| `GET /snapshot` | Cached or refreshed sanitised quota snapshot |
| `POST /refresh` | Coalesced live quota refresh                 |
| `POST /actions` | Validated account action                     |

Actions accept only `{kind, accountId}` for `refresh-auth` and `consume-reset`, or
`{kind: "set-disabled", accountId, disabled}`. The service resolves filenames from
a fresh private listing. Browser-supplied URLs, filenames, and proxy payloads are
rejected. Action bodies are limited to 4 KiB; concurrent mutations on the same
account return `busy`.

The CPA key comes only from the config file, read on each uncached snapshot
request. OpenChamber filters the service environment, so inherited environment
keys are not a supported configuration mechanism. Provider operations are fixed
server-side, use `Bearer $TOKEN$` inside CPA's `api-call`, reject management
redirects, and bound upstream bodies to 4 MiB. Reads use three concurrent account
workers, 3.5-second request deadlines, and a 15-second total network deadline.
The service coalesces reads and caches snapshots for 30 seconds; manual refresh
bypasses that cache. Per-account revisions prevent reads started before a mutation
from replacing post-action state. Responses contain projected fields and fixed
errors, never raw CPA entries, credential-refresh responses, or server error bodies.

The public snapshot has at most 300 accounts and 24 model observations,
cooldowns, and quota windows per account. Output stays below 240,000 bytes.
Omitted accounts and model/cooldown details are marked. Invalid cooldown entries
are marked incomplete, never treated as a known-empty set. Auth indices are opaque,
nonempty identifiers limited to 256 characters. Invalid or duplicate indices are
omitted.

## Build and checks

Development requires Bun, Node for runtime verification, and `zip` for packaging.
The SDK version was checked against the npm registry and pinned to **1.24.2**.

```sh
cd extensions/cliproxyapi
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run zip
```

The ZIP includes the manifest, README, HTML, CSS, bundled JavaScript, and bundled
dependency and official management frontend MIT licences under `licenses/`.
It excludes source files, dependencies, configuration, and credentials.

### Live verification

After configuring the host file, run:

```sh
bun run verify:live
```

This starts the **built service under Node**, verifies authenticated health and
unauthenticated refusals, then reads its sanitised snapshot. It prints only counts,
and fixed failure codes. It never prints keys, account names,
indices, raw auth entries, or error bodies. It reads live quota and bank availability
only; it does not submit account mutations or alter the configuration.

### Browser fixture

```sh
bun run build
bun run fixture
```

Open `http://127.0.0.1:4318`. An optional port can be passed as
`bun run fixture 4319`. The synthetic parent page hosts the real built panel in
an opaque-origin sandboxed iframe. It speaks the SDK's actual `hello`, `ready`,
`service-request`, and `result` messages, and validates host messages with the SDK
schema. It never reads configuration or contacts CPA.

Check search and filters, expand model observations, switch themes, and toggle
between 360px and 760px widths. Choose a response mode and press **Refresh** inside
the panel to test stale-on-error, setup, disconnected, and empty states. The parent
shows request counts for polling checks. Hide the browser tab for over a minute
and confirm no request occurs until it becomes visible. The fixture has four
synthetic accounts, live/reset examples, a saved stale measurement, and a model
cooldown. It supports account actions, reset confirmation, management open-url,
partial reads, rejected/uncertain actions, and successful actions with failed refreshes.

## Source references

CPA behaviour was derived from its [official source at e01806f](https://github.com/router-for-me/CLIProxyAPI/tree/e01806f971b1758b23bb067d93f7d2acd73d2c70):

- `internal/api/handlers/management/auth_files.go`: auth entries, passive quota
  projection, `observed_at`, `signals`, and `model_quotas`.
- `internal/runtime/executor/helps/codex_quota.go`: Codex header names, window
  minutes, used percentages, and reset units.
- `sdk/cliproxy/auth/types.go`, `status.go`, and `cooldown_view.go`: stable indices,
  health states, cooldown scopes, reasons and absolute retry times.
- `internal/api/handlers/management/auth_files_fields.go`, `auth_files_refresh.go`,
  and `api_tools.go`: account mutations, private refresh results, and provider proxy envelopes.
- Official `CLIProxyAPI-Management-Center` source: `src/utils/quota/constants.ts`,
  `resetCredits.ts`, and `src/features/quota/providers/{codex,antigravity}/data.ts`
  define provider URLs, headers, bank-credit merging, consumption, and fallback order.
  The corresponding MIT notice ships in `licenses/cliproxyapi-management-MIT.txt`.

Host behaviour follows the [official OpenChamber SDK](https://github.com/btriapitsyn/openchamber/tree/0c4fbe362dbbc12af790d29da8afbcb19c910ced/packages/sdk) `API.md`, `GUEST_SERVICES.md`,
and `src` protocol and theme types. No other CPA client or host provider
implementation informed this package.
