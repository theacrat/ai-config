import type { Observation } from "../snapshot";
import {
  first,
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

const unitMinutes = new Map([
  ["SECOND", 1 / 60],
  ["SECONDS", 1 / 60],
  ["HOUR", 60],
  ["HOURS", 60],
  ["DAY", 1440],
  ["DAYS", 1440],
  ["WEEK", 10080],
  ["WEEKS", 10080],
]);
function minutes(duration: unknown, unit: unknown): number | null {
  const n = numeric(duration);
  if (!n) return null;
  const key =
    typeof unit === "string"
      ? unit
          .trim()
          .toUpperCase()
          .replace(/^TIME_UNIT_/, "")
      : "";
  return n * (unitMinutes.get(key) ?? 1);
}
function row(
  data: Record<string, unknown>,
  id: string,
  label: string,
  at: number,
  span: number | null,
): Reading | null {
  const limit = numeric(data.limit);
  const remaining = numeric(data.remaining);
  const used =
    numeric(data.used) ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (used === null && limit === null) return null;
  const relative = numeric(first(data.reset_in, data.resetIn, data.ttl));
  return {
    id,
    label: text(first(data.name, data.title)) || label,
    minutes: span,
    usedPercent: limit ? ((used ?? 0) / limit) * 100 : null,
    resetAt:
      instant(first(data.reset_at, data.resetAt, data.reset_time, data.resetTime)) ??
      (relative ? at + relative * 1000 : null),
  };
}

export function parseKimi(value: unknown, at: number): Observation {
  const payload = object(value);
  const readings: Reading[] = [];
  list(payload.limits).forEach((raw, index) => {
    const item = object(raw);
    const detail = Object.keys(object(item.detail)).length ? object(item.detail) : item;
    const window = object(item.window);
    const span = minutes(
      first(window.duration, item.duration, detail.duration),
      first(window.timeUnit, item.timeUnit, detail.timeUnit),
    );
    const named = text(first(item.name, item.title, item.scope, detail.name, detail.title));
    const label =
      named ||
      (span
        ? `${span % 1440 === 0 ? `${span / 1440}d` : span % 60 === 0 ? `${span / 60}h` : `${span}m`} limit`
        : `Limit ${index + 1}`);
    const reading = row(detail, `limit-${index}`, label, at, span);
    if (reading) readings.push(reading);
  });
  const summary = row(object(payload.usage), "summary", "Weekly limit", at, 10080);
  if (summary) readings.push(summary);
  if (!readings.length) throw new Error("invalid quota");
  return observe(at, readings);
}

export const kimi: Provider = {
  async read({ call }) {
    const payload = await call({
      method: "GET",
      url: "https://api.kimi.com/coding/v1/usages",
      header: tokenHeader,
    });
    return { observation: parseKimi(payload, Date.now()) };
  },
};
