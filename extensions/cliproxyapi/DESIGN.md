# CLIProxyAPI panel

## Decision

Build a standalone OpenChamber panel and optional full-page view. A host-managed
loopback service reads CPA's management API. The service owns credentials and
returns a sanitised account snapshot to the iframe.

OpenChamber's token integration requires an HTTPS origin. The requested instance
uses HTTP, so a direct `host.request` integration cannot handle it. A local service
is the supported SDK contract for this case. A panel-only implementation was
rejected for that reason.

## Data and boundaries

`Snapshot` contains a fetch timestamp and `Account[]`. Each account has its stable
auth index, display name, provider, health, cooldowns and observed quota windows.
A window contains measured usage and its observation/reset timestamps. Live
provider readings occupy a separate `live` observation with status, attempt time,
safe error, bank availability, and explicit account capabilities. Missing
measurements remain unknown. Polling CPA must not make an old observation look new.

The service reads a private configuration file under the user's home directory.
Neither the management key nor upstream credentials/token claims may reach the panel, logs,
fixtures or build outputs. Configuration changes are local setup operations.
Requests use a fixed management endpoint and reject redirects.

The panel provides account/provider filtering, manual refresh, visibility-aware
polling, observation age, reset times and account health. Model observations are
kept separate from account observations. Fixed account actions support status,
credential refresh, and Codex banked-reset consumption. Quotas are read through
CPA's provider `api-call`, independent of registered passive quota plugins.

## Source contract

Only CLIProxyAPI docs and source inform CPA behaviour. OpenChamber's official SDK
docs and types inform packaging and host communication. No existing CPA clients
or similar integrations are used.

- https://help.router-for.me/management/api
- CLIProxyAPI `internal/api/handlers/management/auth_files.go`
- CLIProxyAPI `internal/runtime/executor/helps/codex_quota.go`
- CLIProxyAPI `sdk/cliproxy/auth` quota and cooldown types
- OpenChamber `packages/sdk/API.md` and `GUEST_SERVICES.md`

## Execution and checks

- [x] Ground the CPA response and OpenChamber extension contract.
- [x] Compare direct token integration with a host-managed service.
- [x] Agree on the service-backed snapshot boundary.
- [x] Implement the service, parser and panel.
- [x] Verify parsing, service authentication and real CPA reads.
- [x] Verify the built panel through the SDK wire contract in a browser.
- [x] Review the diff and package built assets for folder/ZIP installation.
- [x] Revise quota groups to retain full identifiers separately from display text.

Blocking first steps are contract discovery and credential isolation. One code
owner keeps the shared snapshot contract consistent. Verification can run
independently once the package exists. The owner uses an isolated Git worktree;
review and integration happen in the original worktree.

## Implementation verification

The package uses SDK 1.24.2, checked against npm, and ships its MIT licence and
Zod's MIT licence. The parser/service suite passes 34 tests. The built CommonJS
service passed live verification under Node with 4 accounts, none omitted, 2
account windows and 1 model observation. The live script prints counts only.

Account display names follow label, email, filename, then index. Auth indices are
opaque bounded identifiers. Model names and additional-limit names are preserved
as bounded, control-free text. Codex flags, credits and active-limit attribution
remain visible even without percentage windows. Invalid cooldown entries mark the
data incomplete rather than implying a known-empty cooldown set.

The release ZIP installed in an isolated OpenChamber 1.24.2 instance. Headless
Chromium verified all four live accounts, provider and unknown-quota filters,
manual refresh, preserved model names, and horizontal layout bounds.

The synthetic SDK fixture passed browser checks for search, flag-only quotas,
stale snapshot retention, setup errors, paused retries after service failure,
manual recovery, repeated ready events, light/dark themes, narrow/wide layouts,
and empty accounts. Screenshots use synthetic account data only.

## Requested management controls

The user expanded the panel scope after the initial ZIP verification:

- Label reset/retry timezones and offer browser-local or UTC rendering. The first
  screenshots inherited Australia/Brisbane from the test machine, UTC+10.
- Fetch fresh provider quotas through CPA rather than only reading stored signals.
- Apply Codex banked resets using the same provider operation as CPA's official UI.
- Enable/disable accounts and refresh their credentials.
- Open `/management.html` through `host.openUrl`, which uses the desktop's external
  browser or a new web-browser tab. Never attach the management key to the URL.

The user permits all official CLIProxyAPI source, including its management
frontend, for the provider request contracts. Third-party quota extensions remain
excluded. Generic CPA `/reset-quota` only clears local routing cooldowns and must
not stand in for spending a banked reset.

The service resolves action targets from current CPA account identities,
validate action payloads, retain credentials server-side, and return sanitised
results. Provider refreshes may partially succeed. Failed reads preserve prior
measurements with error/freshness labels. Consumptive reset operations must not
automatically retry after an ambiguous response. Verification uses fake upstreams
for account mutations and banked resets; real-instance checks exercise quota reads.

## Controls implementation

The service exposes authenticated `GET /info`, `GET /snapshot`, `POST /refresh`,
and `POST /actions` alongside health. The action union admits only an opaque
account index, fixed kind, and a boolean for status changes. Private filenames,
claims, management keys, and refresh credentials stay inside the service.

Reads use a 30-second cache, singleflight, three account workers, and a 15-second
network budget. Each account has a revision and mutation lock. A racing read
cannot overwrite a completed action's quota state. Failed live queries retain
the previous reading and its timestamp with an error label. Unsupported providers
retain passive data. Management URL metadata is available without a CPA request.

Banked-reset consumption uses a UUID request ID and requires in-panel confirmation.
Any inner 2xx means consumed, independent of response body format. Follow-up read
failure returns `success-refresh-failed`; unknown transport outcomes return
`uncertain` without retry. The test upstream exercises both cases and duplicate
submissions. Real verification returned four fresh accounts (3 Codex, 1
Antigravity), eight live windows, and three known bank counts without mutations.
