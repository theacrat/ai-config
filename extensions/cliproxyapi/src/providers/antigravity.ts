import type { Observation } from "../snapshot";
import {
  instant,
  list,
  LiveError,
  numeric,
  object,
  observe,
  text,
  tokenHeader,
  type Provider,
  type Reading,
} from "./shared";

export function parseAntigravity(value: unknown, at: number): Observation {
  const readings: Reading[] = [];
  list(object(value).groups)
    .slice(0, 24)
    .forEach((raw, index) => {
      const group = object(raw);
      const label = text(group.displayName ?? group.display_name, `Group ${index + 1}`);
      list(group.buckets).forEach((rawBucket, bucketIndex) => {
        const bucket = object(rawBucket);
        const rawFraction = bucket.remainingFraction ?? bucket.remaining_fraction;
        const fraction =
          typeof rawFraction === "string" && rawFraction.trim().endsWith("%")
            ? (numeric(rawFraction.trim().slice(0, -1)) ?? NaN) / 100
            : numeric(rawFraction);
        if (fraction === null || !Number.isFinite(fraction) || fraction > 1) return;
        const window = text(bucket.window);
        const period = window.trim().toLowerCase();
        readings.push({
          id: `${index}:${label}:${text(bucket.bucketId ?? bucket.bucket_id, String(bucketIndex))}`,
          label: `${label} · ${text(bucket.displayName ?? bucket.display_name, window || `Bucket ${bucketIndex + 1}`)}`,
          description: [text(group.description), text(bucket.description)]
            .filter(Boolean)
            .join(" · "),
          minutes: ["5h", "five-hour", "five_hour"].includes(period)
            ? 300
            : ["weekly", "week"].includes(period)
              ? 10080
              : null,
          usedPercent: (1 - fraction) * 100,
          resetAt: instant(bucket.resetTime ?? bucket.reset_time),
        });
      });
    });
  if (!readings.length) throw new Error("invalid quota");
  return observe(at, readings);
}

const domains = [
  "daily-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.googleapis.com",
];

export const antigravity: Provider = {
  async read({ account, call }) {
    const project = account.file.project_id;
    if (typeof project !== "string" || !project)
      throw new LiveError("Project ID missing from CPA listing");
    let failure: unknown;
    for (const domain of domains) {
      try {
        const payload = await call({
          method: "POST",
          url: `https://${domain}/v1internal:retrieveUserQuotaSummary`,
          header: {
            ...tokenHeader,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
          },
          data: JSON.stringify({ project }),
        });
        return { observation: parseAntigravity(payload, Date.now()) };
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  },
};
