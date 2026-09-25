import type { Observation } from "../snapshot";
import {
  instant,
  list,
  numeric,
  object,
  observe,
  text,
  tokenHeader,
  type Provider,
  type Reading,
} from "./shared";

const windows = [
  ["five_hour", "5-hour", 300],
  ["seven_day", "7-day", 10080],
  ["seven_day_oauth_apps", "7-day OAuth apps", 10080],
  ["seven_day_opus", "7-day Opus", 10080],
  ["seven_day_sonnet", "7-day Sonnet", 10080],
  ["seven_day_cowork", "7-day Cowork", 10080],
  ["iguana_necktie", "7-day Fable", 10080],
] as const;

export function parseClaude(value: unknown, at: number): Observation {
  const payload = object(value);
  const fables = list(payload.limits)
    .map(object)
    .filter(
      (limit) =>
        limit.kind === "weekly_scoped" &&
        ["fable", "fable 5"].includes(
          text(object(object(limit.scope).model).display_name)
            .trim()
            .toLowerCase(),
        ) &&
        numeric(limit.percent) !== null,
    );
  const fable = fables.find((limit) => limit.is_active === true) ?? fables[0];
  const readings: Reading[] = [];
  for (const [key, label, minutes] of windows) {
    const window = object(payload[key]);
    if (!("utilization" in window) || (key === "iguana_necktie" && fable)) continue;
    readings.push({
      id: key,
      label,
      minutes,
      usedPercent: numeric(window.utilization),
      resetAt: instant(window.resets_at),
    });
  }
  if (fable)
    readings.push({
      id: "iguana_necktie",
      label: "7-day Fable",
      minutes: 10080,
      usedPercent: numeric(fable.percent),
      resetAt: instant(fable.resets_at),
    });
  const extra = object(payload.extra_usage);
  const limit = numeric(extra.monthly_limit);
  const used = numeric(extra.used_credits);
  if (extra.is_enabled === true && limit)
    readings.push({
      id: "extra-usage",
      label: "Extra usage",
      usedPercent: used === null ? null : (used / limit) * 100,
      description: `$${((used ?? 0) / 100).toFixed(2)} of $${(limit / 100).toFixed(2)} this month`,
    });
  if (!readings.length) throw new Error("invalid quota");
  return observe(at, readings);
}

export const claude: Provider = {
  async read({ call }) {
    const payload = await call({
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header: {
        ...tokenHeader,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    return { observation: parseClaude(payload, Date.now()) };
  },
};
