import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createController } from "../src/controller";
import { parseClaude } from "../src/providers/claude";
import { parseDevin } from "../src/providers/devin";
import { parseKimi } from "../src/providers/kimi";
import { parseMeta } from "../src/providers/meta";
import { parseXaiBilling } from "../src/providers/xai";

const at = 1700000000000;
const windows = (value: { windows: unknown[] }) => value.windows;

describe("provider payloads", () => {
  it("reads Claude windows, prefers the scoped Fable limit and extra usage", () => {
    expect(
      windows(
        parseClaude(
          {
            five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00.123456Z" },
            seven_day: { utilization: 40, resets_at: null },
            iguana_necktie: { utilization: 99, resets_at: null },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 7,
                is_active: true,
                resets_at: "2030-01-02T00:00:00Z",
                scope: { model: { display_name: "Fable" } },
              },
            ],
            extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250 },
          },
          at,
        ),
      ),
    ).toEqual([
      {
        limitId: "five_hour",
        label: "5-hour",
        usedPercent: 12,
        minutes: 300,
        resetAt: 1893456000123,
      },
      { limitId: "seven_day", label: "7-day", usedPercent: 40, minutes: 10080, resetAt: null },
      {
        limitId: "iguana_necktie",
        label: "7-day Fable",
        usedPercent: 7,
        minutes: 10080,
        resetAt: 1893542400000,
      },
      {
        limitId: "extra-usage",
        label: "Extra usage",
        usedPercent: 25,
        minutes: null,
        resetAt: null,
        description: "$12.50 of $50.00 this month",
      },
    ]);
    expect(() => parseClaude({}, at)).toThrow();
  });
  it("reads Kimi limits with protobuf units, remaining counts and relative resets", () => {
    expect(
      windows(
        parseKimi(
          {
            limits: [
              {
                window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
                detail: { limit: "100", remaining: "75", reset_in: 60 },
              },
            ],
            usage: { used: 10, limit: 40, reset_at: "2030-01-01T00:00:00Z" },
          },
          at,
        ),
      ),
    ).toEqual([
      {
        limitId: "limit-0",
        label: "5h limit",
        usedPercent: 25,
        minutes: 300,
        resetAt: at + 60000,
      },
      {
        limitId: "summary",
        label: "Weekly limit",
        usedPercent: 25,
        minutes: 10080,
        resetAt: 1893456000000,
      },
    ]);
  });
  it("reads Devin remaining percentages and unix resets", () => {
    expect(
      windows(
        parseDevin(
          {
            userStatus: {
              planStatus: {
                dailyQuotaRemainingPercent: 80,
                dailyQuotaResetAtUnix: "1893456000",
                weeklyQuotaRemainingPercent: "101",
              },
            },
          },
          at,
        ),
      ),
    ).toEqual([
      { limitId: "daily", label: "Daily", usedPercent: 20, minutes: 1440, resetAt: 1893456000000 },
      { limitId: "weekly", label: "Weekly", usedPercent: null, minutes: 10080, resetAt: null },
    ]);
  });
  it("reads Meta windows and treats missing usage as a known-empty observation", () => {
    expect(
      windows(
        parseMeta(
          {
            api_key: "never-copied",
            subs_usage: {
              window: { used_percent: 30, resets_at: 1893456000, window_duration_mins: 300 },
              weekly: { used_percent: "5" },
            },
          },
          at,
        ),
      ),
    ).toEqual([
      {
        limitId: "window",
        label: "Usage window",
        usedPercent: 30,
        minutes: 300,
        resetAt: 1893456000000,
      },
      { limitId: "weekly", label: "Weekly", usedPercent: 5, minutes: 10080, resetAt: null },
    ]);
    expect(windows(parseMeta({ is_subs_active: true }, at))).toEqual([]);
    expect(() => parseMeta("not json", at)).toThrow();
  });
  it("reads xAI weekly credits with products, or monthly and on-demand spend", () => {
    expect(
      parseXaiBilling({
        config: {
          creditUsagePercent: 42,
          currentPeriod: {
            type: "WEEKLY",
            start: "2029-12-25T00:00:00Z",
            end: "2030-01-01T00:00:00Z",
          },
          productUsage: [{ product: "Grok Code", usagePercent: 10 }],
        },
      }),
    ).toEqual([
      {
        id: "weekly",
        label: "Weekly credits",
        usedPercent: 42,
        resetAt: 1893456000000,
        minutes: 10080,
      },
      {
        id: "product:Grok Code",
        label: "Grok Code usage",
        usedPercent: 10,
        resetAt: 1893456000000,
        minutes: 10080,
      },
    ]);
    expect(
      parseXaiBilling({
        config: { monthlyLimit: { val: 1000 }, used: { val: 1500 }, onDemandCap: 2000 },
      }).map((r) => [r.id, r.usedPercent]),
    ).toEqual([
      ["monthly", 100],
      ["on-demand", 25],
    ]);
    expect(parseXaiBilling({ config: {} })).toEqual([]);
    expect(
      parseXaiBilling({ config: { onDemandCap: 1000 } }).map((r) => [r.id, r.usedPercent]),
    ).toEqual([
      ["monthly", null],
      ["on-demand", null],
    ]);
  });
  it("accepts unix resets in seconds or milliseconds", () => {
    expect(
      [1893456000, 1893456000000].map(
        (resets_at) =>
          parseMeta({ subs_usage: { weekly: { used_percent: 1, resets_at } } }, 0).windows[0]
            ?.resetAt,
      ),
    ).toEqual([1893456000000, 1893456000000]);
  });
});

const callSchema = z.object({
  authIndex: z.string(),
  method: z.string(),
  url: z.string(),
  header: z.record(z.string(), z.string()),
  data: z.string().optional(),
});
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("provider registry through CPA api-call", () => {
  it("routes every OAuth provider through its fixed contract and keeps Meta secrets private", async () => {
    const calls: z.infer<typeof callSchema>[] = [];
    const downloads: string[] = [];
    const bodies: Record<string, unknown> = {
      "https://api.anthropic.com/api/oauth/usage": { five_hour: { utilization: 1 } },
      "https://api.kimi.com/coding/v1/usages": { usage: { used: 1, limit: 2 } },
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus": {
        userStatus: { planStatus: { dailyQuotaRemainingPercent: 50 } },
      },
      "https://api.meta.ai/muse-code/key": { api_key: "meta-echo-secret", subs_usage: {} },
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits": {
        config: { creditUsagePercent: 3 },
      },
      "https://cli-chat-proxy.grok.com/v1/billing": { config: {} },
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": {
        groups: [{ buckets: [{ remainingFraction: 1 }] }],
      },
    };
    const server = createServer(async (req, res) => {
      if (req.url === "/v0/management/auth-files") {
        res.end(
          JSON.stringify({
            files: [
              { auth_index: "c", name: "c.json", provider: "claude" },
              { auth_index: "k", name: "k.json", provider: "kimi" },
              { auth_index: "d", name: "d.json", provider: "devin" },
              { auth_index: "m", name: "meta private.json", provider: "meta" },
              { auth_index: "x", name: "x.json", provider: "Grok", sub: "user-7" },
              { auth_index: "q", name: "q.json", provider: "qwen" },
              { auth_index: "p", name: "p.json", provider: "constructor" },
              { auth_index: "a", name: "ag.json", provider: "antigravity" },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v0/management/auth-files/download")) {
        downloads.push(req.url);
        res.end(
          JSON.stringify(
            req.url.endsWith("ag.json")
              ? { installed: { project_id: "downloaded-project" } }
              : { dca_token: "dca:meta-secret" },
          ),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const call = callSchema.parse(JSON.parse(raw));
      calls.push(call);
      res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(bodies[call.url] ?? {}) }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const snapshot = await createController(async () => ({
      baseUrl: `http://127.0.0.1:${address.port}`,
      managementKey: "key",
    })).snapshot();

    expect(snapshot.accounts.map((a) => [a.provider, a.live?.status])).toEqual([
      ["claude", "fresh"],
      ["kimi", "fresh"],
      ["devin", "fresh"],
      ["meta", "fresh"],
      ["xai", "fresh"],
      ["qwen", "unsupported"],
      ["constructor", "unsupported"],
      ["antigravity", "fresh"],
    ]);
    expect(downloads.sort()).toEqual([
      "/v0/management/auth-files/download?name=ag.json",
      "/v0/management/auth-files/download?name=meta%20private.json",
    ]);
    expect(calls.find((c) => c.authIndex === "a")?.data).toBe('{"project":"downloaded-project"}');
    expect(calls.find((c) => c.authIndex === "m")?.header.Authorization).toBe(
      "Bearer dca:meta-secret",
    );
    expect(calls.find((c) => c.authIndex === "d")?.data).toContain('"apiKey":"$TOKEN$"');
    expect(calls.find((c) => c.authIndex === "x")?.header["x-userid"]).toBe("user-7");
    expect(calls.filter((c) => c.authIndex === "q")).toEqual([]);
    const serialised = JSON.stringify(snapshot);
    for (const secret of ["meta-secret", "meta-echo-secret", "user-7", "downloaded-project"])
      expect(serialised).not.toContain(secret);
  });
});
