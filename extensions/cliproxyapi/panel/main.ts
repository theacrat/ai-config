import { connectHost, HostRequestError } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import {
  snapshotSchema,
  hasQuotaSignals,
  type Account,
  type Observation,
  type Snapshot,
} from "../src/snapshot";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function required<T extends Element>(selector: string, kind: { new (): T }): T {
  const node = document.querySelector(selector);
  if (!(node instanceof kind)) throw new Error("Missing panel element");
  return node;
}
const refreshButton = required("#refresh", HTMLButtonElement);
const search = required("#search", HTMLInputElement);
const provider = required("#provider", HTMLSelectElement);
const health = required("#health", HTMLSelectElement);
const connection = required("#connection", HTMLParagraphElement);
const summary = required("#summary", HTMLParagraphElement);
const accounts = required("#accounts", HTMLElement);
const host = connectHost();
let snapshot: Snapshot | null = null;
let busy = false;
let ready = false;
let failure = "";
let pausePolling = false;
const expanded = new Set<string>();
const staleAfter = 15 * 60 * 1000;

function age(time: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function timeLabel(time: number): string {
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function observationNode(observation: Observation): HTMLElement {
  const node = element("div");
  const old = observation.observedAt !== null && Date.now() - observation.observedAt > staleAfter;
  node.append(
    element(
      "p",
      observation.observedAt === null
        ? "Observation time unknown"
        : `${old ? "Stale observation · " : "Observed "}${age(observation.observedAt)}`,
      "observation-time",
    ),
  );
  if (observation.activeLimit)
    node.append(element("p", `Active limit: ${observation.activeLimit}`, "observation-time"));
  for (const limit of observation.limits) {
    const flags: string[] = [];
    if (limit.allowed !== null) flags.push(limit.allowed ? "allowed" : "not allowed");
    if (limit.limitReached !== null)
      flags.push(limit.limitReached ? "limit reached" : "limit not reached");
    if (flags.length)
      node.append(element("p", `${limit.name}: ${flags.join(" · ")}`, "observation-time"));
  }
  if (observation.credits) {
    const credits = observation.credits;
    const parts: string[] = [];
    if (credits.hasCredits !== null)
      parts.push(credits.hasCredits ? "available" : "none available");
    if (credits.unlimited !== null) parts.push(credits.unlimited ? "unlimited" : "limited");
    if (credits.balance !== null) parts.push(`balance ${credits.balance}`);
    node.append(element("p", `Credits: ${parts.join(" · ")}`, "observation-time"));
  }
  if (!observation.windows.length)
    node.append(
      element(
        "p",
        hasQuotaSignals(observation)
          ? "Usage percentage not observed"
          : "Quota unknown · No supported passive measurements",
        "unknown",
      ),
    );
  for (const window of observation.windows) {
    const row = element("div", "", "window");
    const title = element("div", "", "window-heading");
    const duration =
      window.minutes === null
        ? ""
        : window.minutes < 60
          ? `${window.minutes}m`
          : window.minutes < 1440
            ? `${Math.round((window.minutes / 60) * 10) / 10}h`
            : `${Math.round((window.minutes / 1440) * 10) / 10}d`;
    title.append(
      element("span", `${window.label}${duration ? ` · ${duration}` : ""}`),
      element(
        "strong",
        window.usedPercent === null
          ? "Usage unknown"
          : `${Math.round(window.usedPercent * 10) / 10}% used`,
      ),
    );
    row.append(title);
    if (window.usedPercent !== null) {
      const progress = element("progress", "", window.usedPercent >= 90 ? "high" : "");
      progress.max = 100;
      progress.value = window.usedPercent;
      progress.setAttribute("aria-label", `${window.label}: ${window.usedPercent}% used`);
      row.append(progress);
    }
    row.append(
      element(
        "p",
        window.resetAt === null
          ? "Reset unknown"
          : `${window.resetAt <= Date.now() ? "Reset time passed" : "Resets"} · ${timeLabel(window.resetAt)}`,
        "window-time",
      ),
    );
    node.append(row);
  }
  return node;
}
function needsAttention(account: Account): boolean {
  return (
    account.disabled === true ||
    account.unavailable === true ||
    ["error", "pending", "disabled"].includes(account.health) ||
    (account.cooldowns?.some((c) => c.retryAt > Date.now()) ?? false)
  );
}
function accountNode(account: Account): HTMLElement {
  const article = element("article", "", "account");
  const heading = element("div", "", "account-heading");
  const name = element("h2", account.name);
  name.title = `Auth index: ${account.id}`;
  const badges = element("div", "", "badges");
  badges.append(element("span", account.provider, "badge"));
  badges.append(
    element("span", account.health, `badge ${account.health === "active" ? "healthy" : "warning"}`),
  );
  if (account.disabled) badges.append(element("span", "Disabled", "badge warning"));
  if (account.unavailable) badges.append(element("span", "Unavailable", "badge warning"));
  heading.append(name, badges);
  article.append(heading, observationNode(account.observation));
  if (account.disabled === null || account.unavailable === null)
    article.append(element("p", "Availability partly unknown", "unknown"));
  if (account.cooldowns === null)
    article.append(element("p", "Cooldowns unknown (remote or unreported)", "unknown"));
  for (const cooldown of account.cooldowns ?? []) {
    article.append(
      element(
        "p",
        `${cooldown.model ?? "Account"}: ${cooldown.reason.replaceAll("_", " ")} · ${cooldown.retryAt > Date.now() ? "retry" : "retry time passed"} ${timeLabel(cooldown.retryAt)}`,
        "cooldown",
      ),
    );
  }
  if (account.retryAt !== null)
    article.append(element("p", `CPA retry time · ${timeLabel(account.retryAt)}`, "cooldown"));
  if (account.models.length) {
    const details = element("details");
    details.open = expanded.has(account.id);
    details.append(element("summary", `Model observations (${account.models.length})`));
    details.addEventListener("toggle", () => {
      if (details.open) expanded.add(account.id);
      else expanded.delete(account.id);
    });
    for (const model of account.models) {
      const row = element("div", "", "model");
      row.append(element("h3", model.name), observationNode(model.observation));
      details.append(row);
    }
    article.append(details);
  }
  if (account.detailsOmitted)
    article.append(
      element(
        "p",
        "Some model or cooldown details omitted (invalid data or display limit).",
        "unknown",
      ),
    );
  return article;
}
function render(): void {
  refreshButton.disabled = busy;
  refreshButton.textContent = busy ? "Refreshing…" : "Refresh";
  connection.className = failure ? "error" : "";
  connection.textContent = failure
    ? `${snapshot ? "Stale snapshot · " : ""}${failure}`
    : snapshot
      ? `Connected · Fetched ${age(snapshot.fetchedAt)} · Polls every 60s while visible`
      : "Reading CPA observations…";
  accounts.replaceChildren();
  if (!snapshot) {
    summary.textContent = "";
    return;
  }
  const query = search.value.toLowerCase().trim();
  const filtered = snapshot.accounts.filter(
    (account) =>
      (!query ||
        `${account.name} ${account.id} ${account.provider}`.toLowerCase().includes(query)) &&
      (provider.value === "all" || account.provider === provider.value) &&
      (health.value === "all" ||
        (health.value === "attention" && needsAttention(account)) ||
        (health.value === "disabled" && (account.disabled || account.health === "disabled")) ||
        (health.value === "unknown" && !hasQuotaSignals(account.observation))),
  );
  summary.textContent = `${filtered.length} of ${snapshot.accounts.length} accounts${snapshot.omitted ? ` · ${snapshot.omitted} omitted (invalid index or display limit)` : ""}`;
  if (!filtered.length)
    accounts.append(
      element(
        "p",
        snapshot.accounts.length
          ? "No accounts match these filters."
          : "No accounts reported by CPA.",
        "empty",
      ),
    );
  for (const account of filtered) accounts.append(accountNode(account));
}
const errors: Record<string, string> = {
  setup:
    "Setup required: create ~/.config/openchamber/cliproxyapi.json on the host with baseUrl and managementKey. See the extension README, then Refresh.",
  "upstream-auth":
    "CPA rejected the management key. Check the host config and CPA remote-management access, then Refresh.",
  "upstream-unavailable":
    "CPA is disconnected. Check the configured address and network, then Refresh.",
  "invalid-response":
    "CPA returned an unsupported response. Check the server version, then Refresh.",
  "too-large": "CPA response exceeded the safety limit. Reduce the account set before retrying.",
};
async function refresh(): Promise<void> {
  if (busy || !ready || document.hidden) return;
  busy = true;
  render();
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/snapshot" });
    if (result.status !== 200) {
      let message = "Local service could not refresh. Check setup and try Refresh.";
      try {
        const body: unknown = JSON.parse(result.body);
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
          message = errors[body.error] ?? message;
      } catch {
        /* Only public error codes are displayed. */
      }
      failure = message;
      return;
    }
    snapshot = snapshotSchema.parse(JSON.parse(result.body));
    failure = "";
    pausePolling = false;
    const selected = provider.value;
    provider.replaceChildren(
      new Option("All providers", "all"),
      ...[...new Set(snapshot.accounts.map((a) => a.provider))].sort().map((p) => new Option(p, p)),
    );
    provider.value = [...provider.options].some((o) => o.value === selected) ? selected : "all";
  } catch (error) {
    pausePolling =
      error instanceof HostRequestError &&
      ["SERVICE_FAILED", "NO_SERVICE", "DISABLED", "HOST_UNAVAILABLE"].includes(error.code);
    failure =
      error instanceof HostRequestError &&
      ["NO_SERVICE", "NOT_GRANTED", "DISABLED"].includes(error.code)
        ? "Enable this extension and approve its local service in Settings → Extensions, then Refresh."
        : "Local service disconnected. Check OpenChamber and the host config, then Refresh.";
  } finally {
    busy = false;
    render();
  }
}
refreshButton.addEventListener("click", () => {
  pausePolling = false;
  void refresh();
});
search.addEventListener("input", render);
provider.addEventListener("change", render);
health.addEventListener("change", render);
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (!ready) {
    ready = true;
    void refresh();
  }
});
const interval = setInterval(() => {
  if (!document.hidden && !pausePolling) void refresh();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !pausePolling) void refresh();
});
const connectionTimeout = setTimeout(() => {
  if (!ready) {
    connection.className = "error";
    connection.textContent =
      "Open this panel in OpenChamber. If already installed, reopen it from Extensions.";
  }
}, 20000);
window.addEventListener("pagehide", () => {
  clearInterval(interval);
  clearTimeout(connectionTimeout);
  host.dispose();
});
