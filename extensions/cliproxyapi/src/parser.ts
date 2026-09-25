import { object, providerId } from "./providers/shared";
import {
  authIndexSchema,
  healthSchema,
  reasonSchema,
  type Account,
  type Observation,
  type Snapshot,
} from "./snapshot";

export function date(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function number(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function boundedTime(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : null;
}
function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function signalBoolean(value: unknown): boolean | null {
  const normalised = typeof value === "string" ? value.trim().toLowerCase() : value;
  return normalised === "true" ? true : normalised === "false" ? false : boolean(value);
}
function displayText(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .trim()
        .slice(0, 80)
    : "";
}
function modelName(value: unknown, ordinal: number): string {
  return displayText(value) || `Model ${ordinal}`;
}

export function parseObservation(value: unknown, provider: string): Observation {
  const input = object(value);
  const observedAt = date(input.observed_at);
  const empty: Observation = {
    observedAt,
    windows: [],
    activeLimit: null,
    limits: [],
    credits: null,
  };
  if (provider !== "codex") return empty;
  const signals = Object.fromEntries(
    Object.entries(object(input.signals)).map(([key, val]) => [key.toLowerCase(), val]),
  );
  const prefixes = new Set<string>();
  const groups = new Set<string>();
  for (const key of Object.keys(signals)) {
    const match =
      /^(x-codex-(?:[a-z0-9._-]{1,256}-)?(?:primary|secondary))-(?:used-percent|window-minutes|reset-at|reset-after-seconds)$/.exec(
        key,
      );
    if (match?.[1]) {
      prefixes.add(match[1]);
      groups.add(match[1].replace(/(?:primary|secondary)$/, ""));
    }
    const group = /^(x-codex-(?:[a-z0-9._-]{1,256}-)?)(?:allowed|limit-reached|limit-name)$/.exec(
      key,
    )?.[1];
    if (group) groups.add(group);
  }
  const limits = [...groups]
    .sort()
    .slice(0, 24)
    .map((prefix) => ({
      id: prefix === "x-codex-" ? "main" : prefix.slice(8, -1),
      name:
        displayText(signals[`${prefix}limit-name`]) ||
        (prefix === "x-codex-"
          ? "Account"
          : prefix === "x-codex-code-review-"
            ? "Code review"
            : displayText(prefix.slice(8, -1).replace(/^additional-/, ""))),
      allowed: signalBoolean(signals[`${prefix}allowed`]),
      limitReached: signalBoolean(signals[`${prefix}limit-reached`]),
    }));
  const windows: Observation["windows"] = [];
  for (const prefix of [...prefixes].sort().slice(0, 24)) {
    const minutes = number(signals[`${prefix}-window-minutes`]);
    if (minutes === 0) continue;
    const used = number(signals[`${prefix}-used-percent`]);
    const absolute = number(signals[`${prefix}-reset-at`]);
    const relative = number(signals[`${prefix}-reset-after-seconds`]);
    const resetAt =
      absolute !== null && absolute > 0
        ? boundedTime(absolute * 1000)
        : relative !== null && observedAt !== null
          ? boundedTime(observedAt + relative * 1000)
          : null;
    const period = prefix.endsWith("-primary") ? "Primary" : "Secondary";
    const groupPrefix = prefix.replace(/(?:primary|secondary)$/, "");
    const limitId = groupPrefix === "x-codex-" ? "main" : groupPrefix.slice(8, -1);
    const groupName = limits.find((limit) => limit.id === limitId)?.name ?? "Additional limit";
    const label =
      prefix === "x-codex-primary" || prefix === "x-codex-secondary"
        ? period
        : `${groupName.slice(0, 65)} · ${period}`;
    windows.push({
      limitId,
      label,
      usedPercent: used !== null && used <= 100 ? used : null,
      minutes,
      resetAt,
    });
  }
  const credits = {
    hasCredits: signalBoolean(signals["x-codex-credits-has-credits"]),
    unlimited: signalBoolean(signals["x-codex-credits-unlimited"]),
    balance: number(signals["x-codex-credits-balance"]),
  };
  return {
    observedAt,
    windows,
    activeLimit: displayText(signals["x-codex-active-limit"]) || null,
    limits,
    credits: Object.values(credits).some((value) => value !== null) ? credits : null,
  };
}

export function parseSnapshot(value: unknown, fetchedAt = Date.now()): Snapshot {
  const files = object(value).files;
  if (!Array.isArray(files)) throw new Error("invalid-response");
  const accounts: Account[] = [];
  let omitted = 0;
  const ids = new Set<string>();
  for (const raw of files) {
    const entry = object(raw);
    const index = authIndexSchema.safeParse(entry.auth_index);
    if (!index.success || ids.has(index.data) || accounts.length >= 300) {
      omitted++;
      continue;
    }
    ids.add(index.data);
    const provider = providerId(entry.provider);
    const models = Object.entries(object(entry.model_quotas));
    const rawCooldowns = Array.isArray(entry.cooldowns) ? entry.cooldowns : null;
    let cooldowns: Account["cooldowns"] = rawCooldowns === null ? null : [];
    let droppedCooldowns =
      entry.cooldowns !== undefined && entry.cooldowns !== null && rawCooldowns === null;
    for (const [index, rawCooldown] of (rawCooldowns ?? []).slice(0, 24).entries()) {
      const cooldown = object(rawCooldown);
      const retryAt = date(cooldown.retry_at);
      if ((cooldown.scope !== "credential" && cooldown.scope !== "model") || retryAt === null) {
        droppedCooldowns = true;
        continue;
      }
      cooldowns?.push({
        scope: cooldown.scope,
        model: cooldown.scope === "model" ? modelName(cooldown.model_key, index + 1) : null,
        reason: reasonSchema.catch("unknown").parse(cooldown.reason),
        retryAt,
      });
    }
    if (droppedCooldowns && cooldowns?.length === 0) cooldowns = null;
    accounts.push({
      id: index.data,
      name:
        displayText(entry.label) ||
        displayText(entry.email) ||
        displayText(entry.name) ||
        `${provider} · ${index.data.slice(0, 8)}`,
      provider,
      health: healthSchema.catch("unknown").parse(entry.status),
      disabled: boolean(entry.disabled),
      unavailable: boolean(entry.unavailable),
      observation: parseObservation(entry.quota, provider),
      models: models.slice(0, 24).map(([key, observation], index) => ({
        name: modelName(key, index + 1),
        observation: parseObservation(observation, provider),
      })),
      cooldowns,
      retryAt: date(entry.next_retry_after),
      detailsOmitted: droppedCooldowns || models.length > 24 || (rawCooldowns?.length ?? 0) > 24,
    });
  }
  return { fetchedAt, omitted, accounts };
}
