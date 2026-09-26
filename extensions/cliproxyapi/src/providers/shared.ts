import { z } from "zod";
import type { Account, Observation } from "../snapshot";
import type { CallOptions } from "../upstream";

const record = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
}
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80) : fallback;
}
export function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
export function count(value: unknown): number | null {
  const n = numeric(value);
  return n !== null && Number.isInteger(n) ? n : null;
}
function bounded(ms: number): number | null {
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? ms : null;
}
export function instant(value: unknown): number | null {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value))
    return bounded(Date.parse(value.replace(/(\.\d{3})\d+/, "$1")));
  const unix = numeric(value);
  return unix === null ? null : bounded(unix < 1e11 ? unix * 1000 : unix);
}
export function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}
export function firstText(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export type Bank = NonNullable<NonNullable<Account["live"]>["bank"]>;
export type Reading = {
  id: string;
  label: string;
  usedPercent: number | null;
  minutes?: number | null;
  resetAt?: number | null;
  description?: string;
};
export function observe(at: number, readings: Reading[]): Observation {
  return {
    observedAt: at,
    windows: readings.slice(0, 24).map((reading) => ({
      limitId: reading.id.slice(0, 256),
      label: text(reading.label),
      usedPercent:
        reading.usedPercent === null || !Number.isFinite(reading.usedPercent)
          ? null
          : Math.min(100, Math.max(0, reading.usedPercent)),
      minutes: reading.minutes && reading.minutes > 0 ? reading.minutes : null,
      resetAt: reading.resetAt ? bounded(reading.resetAt) : null,
      ...(reading.description ? { description: reading.description.slice(0, 240) } : {}),
    })),
    limits: [],
    activeLimit: null,
    credits: null,
  };
}

/** Message is shown in the panel, so it must be a fixed string. */
export class LiveError extends Error {}
export type PrivateAccount = {
  authIndex: string;
  name: string;
  provider: string;
  file: Record<string, unknown>;
};
type ProviderRequest = {
  method: "GET" | "POST";
  url: string;
  header: Record<string, string>;
  data?: string;
};
export type ProviderContext = {
  account: PrivateAccount;
  signal: AbortSignal;
  call(request: ProviderRequest, options?: CallOptions): Promise<unknown>;
  download(): Promise<unknown>;
};
export type Provider = {
  read(context: ProviderContext): Promise<{ observation: Observation; bank?: Bank }>;
  consumeReset?(context: ProviderContext): Promise<void>;
};
export const tokenHeader = { Authorization: "Bearer $TOKEN$" };

const aliases = new Map([
  ["x-ai", "xai"],
  ["grok", "xai"],
]);
export function providerId(value: unknown): string {
  const key =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/_/g, "-")
          .replace(/[^a-z0-9.-]/g, "")
          .slice(0, 32)
      : "";
  return aliases.get(key) ?? (key || "other");
}
