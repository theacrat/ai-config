import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createController } from "../src/controller";
import { createService } from "../src/service";
import { actionResultSchema, snapshotSchema } from "../src/snapshot";
import { parseAntigravity } from "../src/providers/antigravity";
import { parseBank, parseCodex } from "../src/providers/codex";

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const usage = {
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 2000000000 },
  },
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
};
const ag = {
  groups: [
    {
      displayName: "Premium",
      description: "Shared models",
      buckets: [
        {
          bucketId: "weekly",
          window: "WEEKLY",
          remainingFraction: "75%",
          resetTime: "2030-01-01T00:00:00Z",
        },
      ],
    },
  ],
};
const callSchema = z.object({
  authIndex: z.string(),
  method: z.string(),
  url: z.string(),
  header: z.record(z.string(), z.string()),
  data: z.string().optional(),
});
type Call = z.infer<typeof callSchema>;
async function fixture() {
  const calls: Call[] = [];
  const mutations: { method: string | undefined; path: string | undefined; body: unknown }[] = [];
  const state = {
    failUsage: false,
    failBank: false,
    failAGPrimary: false,
    consumed: false,
    disabled: false,
    innerConsumeStatus: 204,
    outerConsumeStatus: 200,
    holdConsume: Promise.resolve(),
    holdUsage: Promise.resolve(),
    holdListing: Promise.resolve(),
    missingProject: false,
    name: "private-file.json",
    calls,
    mutations,
    listings: 0,
  };
  const origin = await listen(
    createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer management-test-canary");
      if (req.url === "/v0/management/auth-files") {
        state.listings++;
        await state.holdListing;
        res.end(
          JSON.stringify({
            files: [
              {
                auth_index: "codex-1",
                name: state.name,
                label: "Codex fixture",
                provider: "codex",
                disabled: state.disabled,
                id_token: { chatgpt_account_id: "private-claim", access_token: "raw-secret" },
                quota: {
                  observed_at: "2024-01-01T00:00:00Z",
                  signals: { "x-codex-primary-used-percent": "9" },
                },
              },
              {
                auth_index: "ag-1",
                name: "private-ag.json",
                provider: "antigravity",
                project_id: state.missingProject ? undefined : "private-project",
              },
              { auth_index: "other-1", name: "other.json", provider: "qwen" },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v0/management/auth-files/download")) {
        res.end(JSON.stringify({}));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body: unknown = JSON.parse(raw);
      if (req.url === "/v0/management/api-call") {
        const call = callSchema.parse(body);
        state.calls.push(call);
        if (
          state.failAGPrimary &&
          call.url ===
            "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
        ) {
          res.end(
            JSON.stringify({ status_code: 403, header: {}, body: "private upstream failure" }),
          );
          return;
        }
        if (call.url.endsWith("/consume")) {
          state.consumed = true;
          await state.holdConsume;
          res.writeHead(state.outerConsumeStatus);
          res.end(
            JSON.stringify({
              status_code: state.innerConsumeStatus,
              header: {},
              body: "unspecified non-JSON success",
            }),
          );
          return;
        }
        if (call.url.endsWith("/usage")) {
          const used = state.consumed ? 0 : 41;
          await state.holdUsage;
          res.end(
            JSON.stringify({
              status_code: state.failUsage ? 401 : 200,
              header: {},
              body: JSON.stringify({
                ...usage,
                rate_limit: {
                  ...usage.rate_limit,
                  primary_window: { ...usage.rate_limit.primary_window, used_percent: used },
                },
              }),
            }),
          );
          return;
        }
        const payload = call.url.endsWith("rate-limit-reset-credits")
          ? {
              available_count: state.consumed ? 1 : 2,
              credits: [
                {
                  reset_type: "codex_rate_limits",
                  status: "available",
                  expires_at: "2030-01-01T00:00:00Z",
                },
              ],
            }
          : ag;
        res.end(
          JSON.stringify({
            status_code:
              state.failBank && call.url.endsWith("rate-limit-reset-credits") ? 503 : 200,
            header: {},
            body: JSON.stringify(payload),
          }),
        );
        return;
      }
      state.mutations.push({ method: req.method, path: req.url, body });
      const disabled = z.object({ disabled: z.boolean() }).safeParse(body);
      if (disabled.success) state.disabled = disabled.data.disabled;
      res.end(
        JSON.stringify({
          status: "ok",
          auth: { access_token: "raw-refresh-secret", refresh_token: "raw-refresh-token" },
        }),
      );
    }),
  );
  const controller = createController(async () => ({
    baseUrl: origin,
    managementKey: "management-test-canary",
  }));
  const service = await listen(createService("host-test", controller));
  async function request(path: string, body?: unknown) {
    return fetch(service + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer host-test", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function snapshot(force = false) {
    return snapshotSchema.parse(
      await (await request(force ? "/refresh" : "/snapshot", force ? {} : undefined)).json(),
    );
  }
  async function action(body: unknown) {
    return actionResultSchema.parse(await (await request("/actions", body)).json());
  }
  return { state, origin, service, request, snapshot, action };
}
describe("provider parsing", () => {
  it("uses supplied durations, preserves group identities and credit flags", () => {
    const parsed = parseCodex(
      {
        ...usage,
        additionalRateLimits: [
          {
            meteredFeature: "gpt-long-feature-identifier",
            limitName: "Extra",
            rateLimit: {
              primaryWindow: {
                durationSeconds: 18000,
                usedPercent: "25",
                resetAtUnixSeconds: "2000000001",
              },
            },
          },
        ],
        codeReviewRateLimit: { secondaryWindow: { usedPercent: 8, limitWindowSeconds: 604800 } },
        credits: { hasCredits: true, unlimited: false, balance: "1.5" },
      },
      1700000000000,
    );
    expect(parsed.windows.find((w) => w.limitId === "main")).toMatchObject({
      usedPercent: 41,
      minutes: 10080,
      resetAt: 2000000000000,
    });
    expect(parsed.windows.find((w) => w.limitId === "gpt-long-feature-identifier")).toMatchObject({
      usedPercent: 25,
      minutes: 300,
      resetAt: 2000000001000,
    });
    expect(parsed.windows.find((w) => w.limitId === "code-review")).toMatchObject({
      usedPercent: 8,
    });
    expect(parsed.credits).toEqual({ hasCredits: true, unlimited: false, balance: 1.5 });
  });
  it("retains AG groups, descriptions and reset instants with fraction aliases", () => {
    const parsed = parseAntigravity(
      {
        groups: [
          ...ag.groups,
          {
            display_name: "Standard",
            description: "Other models",
            buckets: [
              {
                bucket_id: "daily",
                window: "DAILY",
                remaining_fraction: "0.2",
                reset_time: "2031-01-01T00:00:00Z",
              },
            ],
          },
        ],
      },
      1700000000000,
    );
    expect(parsed.windows.map((w) => w.usedPercent)).toEqual([25, 80]);
    expect(parsed.windows.map((w) => w.resetAt)).toEqual([1893456000000, 1924992000000]);
    expect(parsed.windows.map((w) => w.description)).toEqual(["Shared models", "Other models"]);
    expect(parsed.windows[0]?.limitId).not.toBe(parsed.windows[1]?.limitId);
  });
  it("merges reset availability with zero precedence and filters unusable credits", () => {
    const credits = [
      { reset_type: "codex_rate_limits", status: "available", expires_at: "2030-01-01T00:00:00Z" },
      { reset_type: "codex_rate_limits", status: "used", expires_at: "2030-01-01T00:00:00Z" },
      { reset_type: "other", status: "available", expires_at: "2030-01-01T00:00:00Z" },
      { reset_type: "codex_rate_limits", status: "available" },
    ];
    expect(parseBank(usage, { available_count: 0, credits }, null)).toEqual({
      available: 0,
      applicable: 0,
      expiries: [1893456000000],
      error: null,
    });
    expect(parseBank(usage, { credits }, null).available).toBe(1);
    expect(parseBank(usage, { credits: [] }, null).available).toBe(3);
  });
});
describe("real service routes with fake management upstream", () => {
  it("isolates tokens, uses fixed provider contracts and keeps passive timestamps", async () => {
    const f = await fixture();
    const [snapshot, duplicate] = await Promise.all([f.snapshot(), f.snapshot()]);
    expect(duplicate).toEqual(snapshot);
    expect(f.state.listings).toBe(1);
    expect(snapshot.accounts.map((a) => a.live?.status)).toEqual(["fresh", "fresh", "unsupported"]);
    const codex = snapshot.accounts[0];
    expect(codex?.observation.observedAt).toBe(1704067200000);
    expect(codex?.live?.observation?.observedAt).toBeGreaterThan(1704067200000);
    expect(codex?.actions?.bankReset).toBe(true);
    expect(codex?.live?.bank?.applicable).toBe(0);
    for (const call of f.state.calls) expect(call.header.Authorization).toBe("Bearer $TOKEN$");
    expect(f.state.calls.find((c) => c.url.endsWith("/usage"))).toMatchObject({
      authIndex: "codex-1",
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: {
        "Chatgpt-Account-Id": "private-claim",
        "User-Agent":
          "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
      },
    });
    expect(f.state.calls.find((c) => c.url.endsWith("reset-credits"))?.header).toMatchObject({
      Accept: "application/json",
      "OpenAI-Beta": "codex-1",
      Originator: "Codex Desktop",
    });
    expect(f.state.calls.find((c) => c.authIndex === "ag-1")).toMatchObject({
      method: "POST",
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      data: '{"project":"private-project"}',
    });
    const serialised = JSON.stringify(snapshot);
    for (const secret of [
      "management-test-canary",
      "private-claim",
      "raw-secret",
      "private-project",
      "private-file.json",
    ])
      expect(serialised).not.toContain(secret);
    await f.snapshot(true);
    expect(f.state.listings).toBe(2);
  });
  it("preserves previous live readings on partial failures, marking them stale", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    f.state.failUsage = true;
    const after = await f.snapshot(true);
    expect(after.accounts[0]?.live?.status).toBe("error");
    expect(after.accounts[0]?.live?.observation).toEqual(before.accounts[0]?.live?.observation);
    expect(after.accounts[0]?.actions?.bankReset).toBe(false);
    expect(after.accounts[1]?.live?.status).toBe("fresh");
    f.state.missingProject = true;
    expect((await f.snapshot(true)).accounts[1]?.live?.error).toBe(
      "Project ID missing from CPA listing",
    );
  });
  it("falls back to the official AG sandbox and keeps usage bank counts if details fail", async () => {
    const f = await fixture();
    f.state.failAGPrimary = true;
    f.state.failBank = true;
    const snapshot = await f.snapshot();
    expect(snapshot.accounts[1]?.live?.status).toBe("fresh");
    expect(f.state.calls.filter((c) => c.authIndex === "ag-1").map((c) => c.url)).toEqual([
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ]);
    expect(snapshot.accounts[0]?.live?.bank).toMatchObject({
      available: 3,
      applicable: 0,
      error: "Banked reset details unavailable",
    });
  });
  it("does not let a read started before consumption overwrite post-action quota", async () => {
    const f = await fixture();
    await f.snapshot();
    let release = () => {};
    f.state.holdUsage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const count = f.state.calls.filter((c) => c.url.endsWith("/usage")).length;
    const staleRead = f.snapshot(true);
    await expect
      .poll(() => f.state.calls.filter((c) => c.url.endsWith("/usage")).length)
      .toBe(count + 1);
    f.state.holdUsage = Promise.resolve();
    expect((await f.action({ kind: "consume-reset", accountId: "codex-1" })).status).toBe(
      "success",
    );
    release();
    expect(
      (await staleRead).accounts[0]?.live?.observation?.windows.find((w) => w.limitId === "main")
        ?.usedPercent,
    ).toBe(0);
    expect((await f.snapshot()).accounts[0]?.live?.bank?.available).toBe(1);
  });
  it("resolves current filenames privately and drops refresh credential responses", async () => {
    const f = await fixture();
    await f.snapshot();
    f.state.name = "renamed-private.json";
    expect(
      (await f.action({ kind: "set-disabled", accountId: "codex-1", disabled: true })).status,
    ).toBe("success");
    expect(f.state.mutations[0]).toEqual({
      method: "PATCH",
      path: "/v0/management/auth-files/status",
      body: { name: "renamed-private.json", auth_index: "codex-1", disabled: true },
    });
    const result = await f.action({ kind: "refresh-auth", accountId: "codex-1" });
    expect(result.status).toBe("success");
    expect(JSON.stringify(result)).not.toContain("raw-refresh");
    expect(f.state.mutations[1]).toEqual({
      method: "POST",
      path: "/v0/management/auth-files/refresh",
      body: { name: "renamed-private.json", auth_index: "codex-1" },
    });
    expect((await f.snapshot()).accounts[0]?.disabled).toBe(true);
  });
  it("rejects browser paths and generic proxy fields and authenticates new routes", async () => {
    const f = await fixture();
    for (const path of ["/info", "/refresh", "/actions"])
      expect(
        (await fetch(f.service + path, { method: path === "/info" ? "GET" : "POST" })).status,
      ).toBe(401);
    expect(
      (
        await f.request("/actions", {
          kind: "refresh-auth",
          accountId: "codex-1",
          name: "evil.json",
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request("/actions", { kind: "api-call", url: "https://evil.invalid" })).status,
    ).toBe(400);
    expect(
      (
        await f.request("/actions", {
          kind: "set-disabled",
          accountId: "codex-1",
          disabled: "false",
        })
      ).status,
    ).toBe(400);
    expect((await f.request("/actions", { padding: "x".repeat(5000) })).status).toBe(413);
    expect(await (await f.request("/info")).json()).toEqual({
      managementUrl: f.origin + "/management.html",
    });
    expect(f.state.listings).toBe(0);
  });
  it("consumes with a UUID only and prevents duplicate concurrent submissions", async () => {
    const f = await fixture();
    await f.snapshot();
    let release = () => {};
    f.state.holdConsume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.action({ kind: "consume-reset", accountId: "codex-1" });
    await expect.poll(() => f.state.consumed).toBe(true);
    expect((await f.action({ kind: "consume-reset", accountId: "codex-1" })).status).toBe("busy");
    release();
    expect((await first).status).toBe("success");
    const calls = f.state.calls.filter((c) => c.url.endsWith("/consume"));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.header).not.toHaveProperty("OpenAI-Beta");
    expect(JSON.parse(call?.data ?? "{}")).toEqual({
      redeem_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(
      (await f.snapshot()).accounts[0]?.live?.observation?.windows.find((w) => w.limitId === "main")
        ?.usedPercent,
    ).toBe(0);
  });
  it("reports consume success even when the subsequent quota refresh fails", async () => {
    const f = await fixture();
    await f.snapshot();
    let release = () => {};
    f.state.holdConsume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = f.action({ kind: "consume-reset", accountId: "codex-1" });
    await expect.poll(() => f.state.consumed).toBe(true);
    f.state.failUsage = true;
    release();
    expect(await result).toEqual({
      status: "success-refresh-failed",
      message: "Banked reset consumed. Quota refresh failed; refresh to check current usage.",
    });
    expect((await f.snapshot()).accounts[0]?.live?.status).toBe("error");
    expect(f.state.calls.filter((c) => c.url.endsWith("/consume"))).toHaveLength(1);
  });
  it.each([
    { inner: 409, outer: 200, status: "rejected" },
    { inner: 408, outer: 200, status: "uncertain" },
    { inner: 500, outer: 200, status: "uncertain" },
    { inner: 502, outer: 200, status: "uncertain" },
    { inner: 504, outer: 200, status: "uncertain" },
    { inner: 204, outer: 502, status: "uncertain" },
    { inner: 204, outer: 408, status: "uncertain" },
  ])("distinguishes rejected and uncertain outcomes: $status", async ({ inner, outer, status }) => {
    const f = await fixture();
    f.state.innerConsumeStatus = inner;
    f.state.outerConsumeStatus = outer;
    expect((await f.action({ kind: "consume-reset", accountId: "codex-1" })).status).toBe(status);
    expect(f.state.calls.filter((c) => c.url.endsWith("/consume"))).toHaveLength(1);
  });
});
