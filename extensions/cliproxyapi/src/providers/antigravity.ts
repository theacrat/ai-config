import type { Observation } from "../snapshot";
import {
  firstText,
  instant,
  list,
  LiveError,
  numeric,
  object,
  observe,
  text,
  tokenHeader,
  type Provider,
  type ProviderContext,
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
        const minutes = ["5h", "five-hour", "five_hour"].includes(period)
          ? 300
          : ["weekly", "week"].includes(period)
            ? 10080
            : null;
        readings.push({
          id: `${index}:${label}:${text(bucket.bucketId ?? bucket.bucket_id, String(bucketIndex))}`,
          label: minutes
            ? label
            : `${label} · ${text(bucket.displayName ?? bucket.display_name, window || `Bucket ${bucketIndex + 1}`)}`,
          description: [text(group.description), text(bucket.description)]
            .filter(Boolean)
            .join(" · "),
          minutes,
          usedPercent: (1 - fraction) * 100,
          resetAt: instant(bucket.resetTime ?? bucket.reset_time),
        });
      });
    });
  return observe(at, readings);
}

const domains = [
  "daily-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.googleapis.com",
];

async function projectId({ account, download }: ProviderContext): Promise<string | null> {
  const { file } = account;
  const metadata = object(file.metadata);
  const attributes = object(file.attributes);
  const listed = firstText(
    file.project_id,
    file.projectId,
    metadata.project_id,
    metadata.projectId,
    attributes.project_id,
    attributes.projectId,
    attributes.gemini_virtual_project,
  );
  if (listed) return listed;
  const stored = object(await download().catch(() => null));
  const installed = object(stored.installed);
  const web = object(stored.web);
  return firstText(
    stored.project_id,
    stored.projectId,
    installed.project_id,
    installed.projectId,
    web.project_id,
    web.projectId,
  );
}

export const antigravity: Provider = {
  async read(context) {
    const { call, signal } = context;
    const project = await projectId(context);
    if (!project) throw new LiveError("Project ID missing from CPA listing");
    let failure: unknown;
    let empty: Observation | null = null;
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
        const observation = parseAntigravity(payload, Date.now());
        if (observation.windows.length) return { observation };
        empty ??= observation;
      } catch (error) {
        failure = error;
        if (signal.aborted) break;
      }
    }
    if (empty) return { observation: empty };
    throw failure;
  },
};
