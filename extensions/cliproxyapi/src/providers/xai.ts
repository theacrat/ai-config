import type { Observation } from "../snapshot";
import { Rejected } from "../upstream";
import {
  first,
  firstText,
  instant,
  list,
  LiveError,
  numeric,
  object,
  observe,
  text,
  tokenHeader,
  type PrivateAccount,
  type Provider,
  type ProviderContext,
  type Reading,
} from "./shared";

const cents = (value: unknown) => numeric(first(object(value).val, value));

function period(start: unknown, end: unknown) {
  const resetAt = instant(end);
  const from = instant(start);
  return {
    resetAt,
    minutes: resetAt !== null && from !== null && resetAt > from ? (resetAt - from) / 60000 : null,
  };
}

export function parseXaiBilling(value: unknown): Reading[] {
  const config = object(object(value).config);
  const current = object(first(config.currentPeriod, config.current_period));
  const credit = numeric(first(config.creditUsagePercent, config.credit_usage_percent));
  const products = list(first(config.productUsage, config.product_usage)).map(object);
  const readings: Reading[] = [];
  if (credit !== null || String(current.type).toLowerCase().includes("weekly") || products.length) {
    const span = period(
      first(current.start, config.billingPeriodStart, config.billing_period_start),
      first(current.end, config.billingPeriodEnd, config.billing_period_end),
    );
    readings.push({ id: "weekly", label: "Weekly credits", usedPercent: credit, ...span });
    products.slice(0, 20).forEach((product, index) =>
      readings.push({
        id: `product:${text(product.product) || index}`,
        label: `${text(product.product) || `Product ${index + 1}`} usage`,
        usedPercent: numeric(first(product.usagePercent, product.usage_percent)),
        ...span,
      }),
    );
    return readings;
  }
  const limit = cents(first(config.monthlyLimit, config.monthly_limit));
  const used = cents(config.used);
  const cap = cents(first(config.onDemandCap, config.on_demand_cap));
  const end = first(config.billingPeriodEnd, config.billing_period_end);
  if (limit === null && used === null && cap === null && !end) return readings;
  const span = period(first(config.billingPeriodStart, config.billing_period_start), end);
  const included = used === null ? null : limit ? Math.min(used, limit) : used;
  readings.push({
    id: "monthly",
    label: "Monthly credits",
    usedPercent: limit && included !== null ? (included / limit) * 100 : null,
    ...span,
  });
  const onDemand =
    cents(first(config.onDemandUsed, config.on_demand_used)) ??
    (used !== null && limit !== null ? Math.max(0, used - limit) : null);
  if (cap)
    readings.push({
      id: "on-demand",
      label: "On-demand",
      usedPercent: onDemand === null ? null : (onDemand / cap) * 100,
      description: `$${((onDemand ?? 0) / 100).toFixed(2)} of $${(cap / 100).toFixed(2)}`,
      ...span,
    });
  return readings;
}

function userId({ file }: PrivateAccount): string | null {
  const metadata = object(file.metadata);
  const attributes = object(file.attributes);
  const oauth = object(first(file.oauth, metadata.oauth, attributes.oauth));
  const user = object(first(file.user, metadata.user, attributes.user));
  return firstText(
    ...[file, metadata, attributes].flatMap((s) => [s.sub, s.subject, s.user_id, s.userId]),
    oauth.sub,
    oauth.subject,
    user.sub,
    user.id,
  );
}

async function paidHealth(call: ProviderContext["call"]): Promise<Observation> {
  await call(
    {
      method: "POST",
      url: "https://api.x.ai/v1/chat/completions",
      header: { ...tokenHeader, Accept: "application/json", "Content-Type": "application/json" },
      data: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    },
    { timeout: 8000 },
  );
  return {
    ...observe(Date.now(), []),
    limits: [{ id: "paid-api", name: "Paid API", allowed: true, limitReached: false }],
  };
}

export const xai: Provider = {
  async read({ account, call }) {
    const id = userId(account);
    const header = {
      ...tokenHeader,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.91",
      accept: "*/*",
      "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
      ...(id ? { "x-userid": id } : {}),
    };
    const billing = async (url: string) =>
      parseXaiBilling(await call({ method: "GET", url, header }));
    const results = await Promise.allSettled([
      billing("https://cli-chat-proxy.grok.com/v1/billing?format=credits"),
      billing("https://cli-chat-proxy.grok.com/v1/billing"),
    ]);
    const readings = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((reading, index, all) => all.findIndex((r) => r.id === reading.id) === index);
    if (readings.length) return { observation: observe(Date.now(), readings) };
    for (const result of results)
      if (result.status === "rejected" && !(result.reason instanceof Rejected)) throw result.reason;
    try {
      return { observation: await paidHealth(call) };
    } catch {
      throw new LiveError("No billing quota reported and paid API check failed");
    }
  },
};
