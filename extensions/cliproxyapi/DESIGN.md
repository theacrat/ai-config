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
A window contains measured usage and its observation/reset timestamps. Missing
measurements remain unknown. Polling CPA must not make an old observation look new.

The service reads a private configuration file under the user's home directory.
Neither the management key nor upstream auth metadata may reach the panel, logs,
fixtures or build outputs. Configuration changes are local setup operations.
Requests use a fixed management endpoint and reject redirects.

The panel provides account/provider filtering, manual refresh, visibility-aware
polling, observation age, reset times and account health. Model observations are
kept separate from account observations. It does not mutate CPA routing or consume
the destructive usage queue. No active quota providers are registered on the
target instance at discovery time.

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
- [ ] Verify the built panel through the SDK wire contract in a browser.
- [x] Review the diff and package built assets for folder/ZIP installation.
- [ ] Revisit the design if the SDK or observed CPA data contradicts it.

Blocking first steps are contract discovery and credential isolation. One code
owner keeps the shared snapshot contract consistent. Verification can run
independently once the package exists. The owner uses an isolated Git worktree;
review and integration happen in the original worktree.

## Implementation verification

The package uses SDK 1.24.2, checked against npm, and ships its MIT licence and
Zod's MIT licence. The parser/service suite passes 32 tests. The built CommonJS
service passed live verification under Node with 4 accounts, none omitted, 2
account windows and 1 model observation. The live script prints counts only.

Account display names follow label, email, filename, then index. Auth indices are
opaque bounded identifiers. Model names and additional-limit names are preserved
as bounded, control-free text. Codex flags, credits and active-limit attribution
remain visible even without percentage windows. Invalid cooldown entries mark the
data incomplete rather than implying a known-empty cooldown set.

The synthetic browser fixture speaks the SDK wire protocol and loads the committed
panel bundle. Browser interaction verification is pending the parent's connected
browser; this implementation session has no desktop browser or Chromium binary.
