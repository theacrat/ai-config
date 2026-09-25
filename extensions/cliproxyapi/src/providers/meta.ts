import type { Observation } from "../snapshot";
import {
  instant,
  LiveError,
  numeric,
  object,
  observe,
  type Provider,
  type Reading,
} from "./shared";

export function parseMeta(value: unknown, at: number): Observation {
  const payload = object(value);
  if (!Object.keys(payload).length) throw new Error("invalid quota");
  const usage = object(payload.subs_usage);
  const readings: Reading[] = [];
  for (const [key, label] of [
    ["window", "Usage window"],
    ["weekly", "Weekly"],
  ] as const) {
    const window = object(usage[key]);
    if (!Object.keys(window).length) continue;
    readings.push({
      id: key,
      label,
      minutes: key === "weekly" ? 10080 : numeric(window.window_duration_mins),
      usedPercent: numeric(window.used_percent),
      resetAt: instant(window.resets_at),
    });
  }
  return observe(at, readings);
}

export const meta: Provider = {
  async read({ call, download }) {
    const token = object(await download()).dca_token;
    if (typeof token !== "string" || !/^dca:\S+$/.test(token.trim()))
      throw new LiveError("Credential file has no DCA token");
    const payload = await call({
      method: "POST",
      url: "https://api.meta.ai/muse-code/key",
      header: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.trim()}`,
        "x-api-version": "1.0.0",
      },
      data: "{}",
    });
    return { observation: parseMeta(payload, Date.now()) };
  },
};
