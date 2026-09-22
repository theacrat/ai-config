import { z } from "zod";
import { date, parseObservation } from "./parser";
import type { Account, Observation } from "./snapshot";
import { apiCall, type Connection } from "./upstream";

const record = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80) : fallback;
}
function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function count(value: unknown): number | null {
  const n = numeric(value);
  return n !== null && Number.isInteger(n) ? n : null;
}
const blank = (at: number): Observation => ({
  observedAt: at,
  windows: [],
  limits: [],
  activeLimit: null,
  credits: null,
});
export function parseCodex(value: unknown, at: number): Observation {
  const payload = object(value);
  const signals: Record<string, unknown> = {};
  const identities = new Map<string, string>();
  function group(raw: unknown, prefix: string, name: string) {
    const limit = object(raw);
    signals[`${prefix}limit-name`] = name;
    signals[`${prefix}allowed`] = limit.allowed;
    signals[`${prefix}limit-reached`] = limit.limit_reached ?? limit.limitReached;
    for (const period of ["primary", "secondary"]) {
      const window = object(limit[`${period}_window`] ?? limit[`${period}Window`]);
      if (!Object.keys(window).length) continue;
      const duration = numeric(
        window.limit_window_seconds ??
          window.limitWindowSeconds ??
          window.duration_seconds ??
          window.durationSeconds,
      );
      if (duration !== null) signals[`${prefix}${period}-window-minutes`] = duration / 60;
      signals[`${prefix}${period}-used-percent`] = window.used_percent ?? window.usedPercent;
      signals[`${prefix}${period}-reset-at`] =
        window.reset_at ??
        window.resetAt ??
        window.reset_at_unix_seconds ??
        window.resetAtUnixSeconds;
      signals[`${prefix}${period}-reset-after-seconds`] =
        window.reset_after_seconds ?? window.resetAfterSeconds;
    }
  }
  group(payload.rate_limit ?? payload.rateLimit, "x-codex-", "Account");
  list(payload.additional_rate_limits ?? payload.additionalRateLimits)
    .slice(0, 20)
    .forEach((raw, i) => {
      const entry = object(raw);
      const identity =
        entry.metered_feature ?? entry.meteredFeature ?? entry.limit_name ?? entry.limitName;
      if (typeof identity === "string")
        identities.set(`additional-${i}`, identity.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 256));
      group(
        entry.rate_limit ?? entry.rateLimit,
        `x-codex-additional-${i}-`,
        text(
          entry.limit_name ?? entry.limitName ?? entry.metered_feature ?? entry.meteredFeature,
          `Additional ${i + 1}`,
        ),
      );
    });
  if (payload.code_review_rate_limit ?? payload.codeReviewRateLimit)
    group(
      payload.code_review_rate_limit ?? payload.codeReviewRateLimit,
      "x-codex-code-review-",
      "Code review",
    );
  const credits = object(payload.credits);
  signals["x-codex-credits-has-credits"] = credits.has_credits ?? credits.hasCredits;
  signals["x-codex-credits-unlimited"] = credits.unlimited;
  signals["x-codex-credits-balance"] = credits.balance;
  signals["x-codex-active-limit"] = payload.active_limit ?? payload.activeLimit;
  if (
    !(
      "rate_limit" in payload ||
      "rateLimit" in payload ||
      "credits" in payload ||
      "additional_rate_limits" in payload ||
      "additionalRateLimits" in payload ||
      "code_review_rate_limit" in payload ||
      "codeReviewRateLimit" in payload
    )
  )
    throw new Error("invalid quota");
  const observation = parseObservation(
    { observed_at: new Date(at).toISOString(), signals },
    "codex",
  );
  for (const window of observation.windows)
    window.limitId = identities.get(window.limitId) ?? window.limitId;
  for (const limit of observation.limits) limit.id = identities.get(limit.id) ?? limit.id;
  return observation;
}
export function parseAntigravity(value: unknown, at: number): Observation {
  const observation = blank(at);
  list(object(value).groups)
    .slice(0, 24)
    .forEach((raw, index) => {
      const group = object(raw);
      const label = text(group.displayName ?? group.display_name, `Group ${index + 1}`);
      list(group.buckets).forEach((rawBucket, bucketIndex) => {
        if (observation.windows.length >= 24) return;
        const bucket = object(rawBucket);
        const rawFraction = bucket.remainingFraction ?? bucket.remaining_fraction;
        const fraction =
          typeof rawFraction === "string" && rawFraction.trim().endsWith("%")
            ? (numeric(rawFraction.trim().slice(0, -1)) ?? NaN) / 100
            : numeric(rawFraction);
        if (fraction === null || !Number.isFinite(fraction) || fraction > 1) return;
        const window = text(bucket.window);
        const period = window.trim().toLowerCase();
        const minutes = ["5h", "five-hour", "five_hour"].includes(period)
          ? 300
          : ["weekly", "week"].includes(period)
            ? 10080
            : null;
        observation.windows.push({
          limitId: `${index}:${label}:${text(bucket.bucketId ?? bucket.bucket_id, String(bucketIndex))}`,
          label:
            `${label} · ${text(bucket.displayName ?? bucket.display_name, window || `Bucket ${bucketIndex + 1}`)}`.slice(
              0,
              80,
            ),
          description: [text(group.description), text(bucket.description)]
            .filter(Boolean)
            .join(" · "),
          minutes,
          usedPercent: (1 - fraction) * 100,
          resetAt: date(bucket.resetTime ?? bucket.reset_time),
        });
      });
    });
  if (!observation.windows.length) throw new Error("invalid quota");
  return observation;
}
export function parseBank(
  usage: unknown,
  details: unknown,
  error: string | null,
): NonNullable<NonNullable<Account["live"]>["bank"]> {
  const u = object(object(usage).rate_limit_reset_credits ?? object(usage).rateLimitResetCredits);
  const d = object(details);
  const availableCredits = list(d.credits).filter((raw) => {
    const c = object(raw);
    return (
      (c.reset_type ?? c.resetType) === "codex_rate_limits" &&
      c.status === "available" &&
      Boolean(c.expires_at ?? c.expiresAt)
    );
  });
  const available =
    count(d.available_count ?? d.availableCount) ??
    (availableCredits.length || null) ??
    count(u.available_count ?? u.availableCount);
  return {
    available,
    applicable:
      count(u.applicable_available_count ?? u.applicableAvailableCount) ??
      count(d.applicable_available_count ?? d.applicableAvailableCount) ??
      available,
    expiries: availableCredits
      .map((raw) => {
        const c = object(raw);
        return date(c.expires_at ?? c.expiresAt);
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b)
      .slice(0, 100),
    error,
  };
}
export type PrivateAccount = {
  authIndex: string;
  name: string;
  provider: string;
  project: string;
  chatgptAccount: string;
};
export const codexRoot = "https://chatgpt.com/backend-api/wham/";
export function codexHeaders(account: PrivateAccount): Record<string, string> {
  return {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
    ...(account.chatgptAccount ? { "Chatgpt-Account-Id": account.chatgptAccount } : {}),
  };
}
export async function readLive(
  config: Connection,
  account: PrivateAccount,
  signal: AbortSignal,
): Promise<NonNullable<Account["live"]>> {
  const at = Date.now();
  if (account.provider === "codex") {
    const header = codexHeaders(account);
    const usage = await apiCall(
      config,
      { authIndex: account.authIndex, method: "GET", url: codexRoot + "usage", header },
      signal,
    );
    const observation = parseCodex(usage, Date.now());
    let details: unknown = null;
    let error: string | null = null;
    try {
      details = await apiCall(
        config,
        {
          authIndex: account.authIndex,
          method: "GET",
          url: codexRoot + "rate-limit-reset-credits",
          header: {
            ...header,
            Accept: "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
          },
        },
        signal,
      );
      const d = object(details);
      if (
        ![
          "credits",
          "available_count",
          "availableCount",
          "applicable_available_count",
          "applicableAvailableCount",
        ].some((key) => key in d)
      )
        throw new Error();
    } catch {
      error = "Banked reset details unavailable";
    }
    return {
      status: "fresh",
      attemptedAt: at,
      error: null,
      observation,
      bank: parseBank(usage, details, error),
    };
  }
  if (account.provider === "antigravity") {
    if (!account.project) throw new Error("missing-project");
    for (const domain of [
      "daily-cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.sandbox.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ]) {
      try {
        const payload = await apiCall(
          config,
          {
            authIndex: account.authIndex,
            method: "POST",
            url: `https://${domain}/v1internal:retrieveUserQuotaSummary`,
            header: {
              Authorization: "Bearer $TOKEN$",
              "Content-Type": "application/json",
              "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
            },
            data: JSON.stringify({ project: account.project }),
          },
          signal,
        );
        return {
          status: "fresh",
          attemptedAt: at,
          error: null,
          observation: parseAntigravity(payload, Date.now()),
          bank: null,
        };
      } catch {
        if (signal.aborted) break;
      }
    }
    throw new Error("quota-unavailable");
  }
  return { status: "unsupported", attemptedAt: at, error: null, observation: null, bank: null };
}
