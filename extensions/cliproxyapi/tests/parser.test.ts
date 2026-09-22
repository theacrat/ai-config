import { describe, expect, it } from "vitest";
import { parseObservation, parseSnapshot } from "../src/parser";
import { snapshotSchema } from "../src/snapshot";

const observed = "2026-09-23T12:00:00Z";
const quota = {
  observed_at: observed,
  signals: {
    "X-Codex-Primary-Used-Percent": "0",
    "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-After-Seconds": "3600",
    "X-Codex-Secondary-Used-Percent": "99.5",
    "X-Codex-Secondary-Window-Minutes": "10080",
    "X-Codex-Secondary-Reset-At": "1790251200",
  },
};
describe("passive observations", () => {
  it("preserves zero, the original observation, and absolute resets across refreshes", () => {
    const files = [{ auth_index: "0123456789abcdef", provider: "codex", quota }];
    const first = parseSnapshot({ files }, 1790164800000);
    const later = parseSnapshot({ files }, 1790168400000);
    expect(first.accounts[0]?.observation).toMatchObject({
      observedAt: 1790164800000,
      windows: [
        { label: "Primary", usedPercent: 0, minutes: 300, resetAt: 1790168400000 },
        { label: "Secondary", usedPercent: 99.5, minutes: 10080, resetAt: 1790251200000 },
      ],
    });
    expect(later.accounts[0]?.observation).toEqual(first.accounts[0]?.observation);
    expect(later.fetchedAt).toBe(1790168400000);
  });
  it.each(["", " ", "NaN", "Infinity", "1e2", "0x10", "-1", "101", null, true, {}, []])(
    "keeps invalid percentage %j unknown",
    (value) => {
      expect(
        parseObservation({ signals: { "X-Codex-Primary-Used-Percent": value } }, "codex").windows[0]
          ?.usedPercent,
      ).toBeNull();
    },
  );
  it("skips zero-length windows, does not invent observation/reset timestamps", () => {
    expect(
      parseObservation(
        {
          signals: { "X-Codex-Primary-Used-Percent": "20", "X-Codex-Primary-Window-Minutes": "0" },
        },
        "codex",
      ).windows,
    ).toEqual([]);
    expect(
      parseObservation({ signals: { "X-Codex-Primary-Reset-After-Seconds": "0" } }, "codex"),
    ).toMatchObject({
      observedAt: null,
      windows: [{ label: "Primary", usedPercent: null, minutes: null, resetAt: null }],
    });
    expect(
      parseObservation(
        { observed_at: observed, signals: { "X-Codex-Primary-Reset-After-Seconds": "0" } },
        "codex",
      ).windows[0]?.resetAt,
    ).toBe(1790164800000);
  });
  it("keeps provider-unsupported observations unknown and model observations separate", () => {
    const result = parseSnapshot({
      files: [
        {
          auth_index: "0123456789abcdef",
          provider: "codex",
          quota: {},
          model_quotas: { "gpt-5-codex": quota },
        },
      ],
    });
    expect(result.accounts[0]?.observation.windows).toEqual([]);
    expect(result.accounts[0]?.models[0]?.observation.windows[0]?.usedPercent).toBe(0);
    expect(parseObservation(quota, "claude").windows).toEqual([]);
  });
  it("handles additional and code-review windows without exposing unrelated signals", () => {
    const result = parseObservation(
      {
        observed_at: observed,
        signals: {
          "X-Codex-Code-Review-Primary-Used-Percent": "42",
          "X-Codex-Additional-GPT-5.3-Codex-Spark-Secondary-Used-Percent": "8",
          Authorization: "secret",
        },
      },
      "codex",
    );
    expect(result.windows).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.windows.some((w) => w.label === "Code review · Primary")).toBe(true);
  });
  it("projects display names, health and cooldowns without credentials or raw errors", () => {
    const secret = "private-secret-canary";
    const result = parseSnapshot({
      files: [
        {
          auth_index: "0123456789abcdef",
          provider: "codex",
          name: "fixture-account.json",
          label: "Fixture account",
          email: "fixture@example.invalid",
          path: secret,
          id_token: { access_token: secret },
          status: secret,
          status_message: secret,
          quota: { signals: { Authorization: secret } },
          disabled: false,
          unavailable: true,
          model_quotas: { "gpt-5.6-luna": {} },
          cooldowns: [
            {
              scope: "model",
              model_key: "gpt-5.6-luna",
              reason: secret,
              retry_at: observed,
              remaining_seconds: 999,
              raw_error: secret,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshotSchema.parse(result).accounts[0]).toMatchObject({
      health: "unknown",
      disabled: false,
      unavailable: true,
      name: "Fixture account",
      models: [{ name: "gpt-5.6-luna" }],
      cooldowns: [{ model: "gpt-5.6-luna", reason: "unknown", retryAt: 1790164800000 }],
    });
  });
  it("uses label, email, name, then index, with bounded control-free display text", () => {
    const result = parseSnapshot({
      files: [
        {
          auth_index: "1111111111111111",
          provider: "codex",
          label: " Team\u0000\u202e A ",
          email: "ignored@example.invalid",
        },
        {
          auth_index: "2222222222222222",
          provider: "codex",
          label: "\n",
          email: "second@example.invalid",
          name: "ignored.json",
        },
        { auth_index: "3333333333333333", provider: "codex", name: "third.json" },
        { auth_index: "4444444444444444", provider: "codex" },
        {
          auth_index: "5555555555555555",
          provider: "codex",
          label: "x".repeat(100),
          model_quotas: { ["y".repeat(100)]: {} },
        },
      ],
    });
    expect(result.accounts.map((a) => a.name)).toEqual([
      "Team A",
      "second@example.invalid",
      "third.json",
      "codex · 44444444",
      "x".repeat(80),
    ]);
    expect(result.accounts[4]?.models[0]?.name).toBe("y".repeat(80));
  });
  it("distinguishes absent cooldowns from an empty known set and bounds malformed entries", () => {
    const result = parseSnapshot({
      files: [
        { auth_index: "0123456789abcdef", cooldowns: [] },
        { auth_index: "1123456789abcdef", cooldowns: null },
        { auth_index: "" },
      ],
    });
    expect(result.accounts.map((a) => a.cooldowns)).toEqual([[], null]);
    expect(result.omitted).toBe(1);
    expect(() => parseSnapshot({ error: "server secret" })).toThrow("invalid-response");
  });
  it("preserves opaque indices already assigned by CPA", () => {
    const result = snapshotSchema.parse(
      parseSnapshot({
        files: [
          { auth_index: "index-file", label: "File fixture" },
          { auth_index: "index-virtual", label: "Virtual fixture" },
          { auth_index: " " },
          { auth_index: "x".repeat(257) },
        ],
      }),
    );
    expect(result.accounts.map((account) => account.id)).toEqual(["index-file", "index-virtual"]);
    expect(result.omitted).toBe(2);
  });
  it("keeps both Spark windows in one named group and retains active-limit attribution", () => {
    const result = parseObservation(
      {
        observed_at: observed,
        signals: {
          "X-Codex-Additional-GPT-5.3-Codex-Spark-Limit-Name": "GPT-5.3-Codex-Spark",
          "X-Codex-Additional-GPT-5.3-Codex-Spark-Primary-Used-Percent": "10",
          "X-Codex-Additional-GPT-5.3-Codex-Spark-Secondary-Used-Percent": "20",
          "X-Codex-Active-Limit": "GPT-5.3-Codex-Spark",
        },
      },
      "codex",
    );
    expect(result.activeLimit).toBe("GPT-5.3-Codex-Spark");
    expect(result.windows.map((window) => [window.limitId, window.label])).toEqual([
      ["additional-gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark · Primary"],
      ["additional-gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark · Secondary"],
    ]);
    expect(result.limits).toEqual([
      {
        id: "additional-gpt-5.3-codex-spark",
        name: "GPT-5.3-Codex-Spark",
        allowed: null,
        limitReached: null,
      },
    ]);
  });
  it("preserves flags and zero credits without inventing percentage windows or cooldowns", () => {
    const result = parseSnapshot({
      files: [
        {
          auth_index: "index-flags",
          provider: "codex",
          quota: {
            observed_at: observed,
            signals: {
              "X-Codex-Allowed": "false",
              "X-Codex-Limit-Reached": "true",
              "X-Codex-Credits-Has-Credits": "false",
              "X-Codex-Credits-Unlimited": "false",
              "X-Codex-Credits-Balance": "0",
            },
          },
        },
      ],
    });
    expect(result.accounts[0]?.observation).toMatchObject({
      windows: [],
      limits: [{ id: "main", allowed: false, limitReached: true }],
      credits: { hasCredits: false, unlimited: false, balance: 0 },
    });
    expect(result.accounts[0]?.cooldowns).toBeNull();
    expect(
      parseObservation(
        { signals: { "X-Codex-Allowed": "yes", "X-Codex-Credits-Balance": "NaN" } },
        "codex",
      ),
    ).toMatchObject({ limits: [{ allowed: null }], credits: null });
  });
  it("marks malformed cooldown data incomplete instead of reporting known-empty", () => {
    const valid = {
      scope: "model",
      model_key: "gpt-5.6-luna",
      reason: "quota",
      retry_at: observed,
    };
    const result = parseSnapshot({
      files: [
        { auth_index: "empty", cooldowns: [] },
        { auth_index: "invalid", cooldowns: [{ scope: "model", retry_at: "bad" }, null] },
        { auth_index: "mixed", cooldowns: [valid, {}] },
        { auth_index: "wrong-type", cooldowns: {} },
      ],
    });
    expect(
      result.accounts.map((account) => [account.cooldowns?.length ?? null, account.detailsOmitted]),
    ).toEqual([
      [0, false],
      [null, true],
      [1, true],
      [null, true],
    ]);
  });
});
