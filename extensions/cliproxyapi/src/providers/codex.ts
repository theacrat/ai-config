import { randomUUID } from "node:crypto";
import { parseObservation } from "../parser";
import type { Observation } from "../snapshot";
import {
  count,
  instant,
  list,
  numeric,
  object,
  text,
  tokenHeader,
  type Bank,
  type PrivateAccount,
  type Provider,
} from "./shared";

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
    ![
      "rate_limit",
      "rateLimit",
      "credits",
      "additional_rate_limits",
      "additionalRateLimits",
      "code_review_rate_limit",
      "codeReviewRateLimit",
    ].some((key) => key in payload)
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

export function parseBank(usage: unknown, details: unknown, error: string | null): Bank {
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
        return instant(c.expires_at ?? c.expiresAt);
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b)
      .slice(0, 100),
    error,
  };
}

const root = "https://chatgpt.com/backend-api/wham/";
function headers(account: PrivateAccount): Record<string, string> {
  const claim = object(account.file.id_token).chatgpt_account_id;
  return {
    ...tokenHeader,
    "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
    ...(typeof claim === "string" && claim ? { "Chatgpt-Account-Id": claim } : {}),
  };
}

export const codex: Provider = {
  async read({ account, call }) {
    const header = headers(account);
    const usage = await call({ method: "GET", url: root + "usage", header });
    const observation = parseCodex(usage, Date.now());
    let details: unknown = null;
    let error: string | null = null;
    try {
      details = await call({
        method: "GET",
        url: root + "rate-limit-reset-credits",
        header: {
          ...header,
          Accept: "application/json",
          "OpenAI-Beta": "codex-1",
          Originator: "Codex Desktop",
        },
      });
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
    return { observation, bank: parseBank(usage, details, error) };
  },
  async consumeReset({ account, call }) {
    await call(
      {
        method: "POST",
        url: root + "rate-limit-reset-credits/consume",
        header: headers(account),
        data: JSON.stringify({ redeem_request_id: randomUUID() }),
      },
      true,
    );
  },
};
