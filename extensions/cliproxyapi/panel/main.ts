import { connectHost, HostRequestError } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import { formatTime } from "../src/time";
import {
  snapshotSchema,
  actionResultSchema,
  type Action,
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
const managementButton = required("#management", HTMLButtonElement);
refreshButton.classList.add("icon-button");
managementButton.classList.add("icon-button");
let managementUrl: string | null = null;
const search = required("#search", HTMLInputElement);
const provider = required("#provider", HTMLSelectElement);
const health = required("#health", HTMLSelectElement);
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const connection = required("#connection", HTMLParagraphElement);
const summary = required("#summary", HTMLParagraphElement);
const accounts = required("#accounts", HTMLElement);
const host = connectHost();
let snapshot: Snapshot | null = null;
let busy = false;
let ready = false;
let failure = "";
let pausePolling = false;
const pendingActions = new Set<string>();
const actionMessages = new Map<string, string>();
const actionMessageTimers = new Map<string, ReturnType<typeof setTimeout>>();
let confirming: string | null = null;
let revision = 0;
const staleAfter = 15 * 60 * 1000;
function closeConfirmation(accountId: string): void {
  confirming = null;
  render();
  [...accounts.querySelectorAll<HTMLButtonElement>("button[data-reset-account]")]
    .find((button) => button.dataset.resetAccount === accountId)
    ?.focus();
}

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
  return formatTime({
    timestamp: time,
    timeZone: localTimeZone,
  });
}
function observationNode(observation: Observation, compact = false): HTMLElement {
  const node = element("div");
  const old = observation.observedAt !== null && Date.now() - observation.observedAt > staleAfter;
  if (!compact)
    node.append(
      element(
        "p",
        observation.observedAt === null
          ? "Observation time unknown"
          : `${old ? "Stale observation · " : "Observed "}${age(observation.observedAt)}`,
        "observation-time",
      ),
    );
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
  function priority(window: Observation["windows"][number]): number {
    if (window.limitId === "main") return 0;
    return `${window.limitId} ${window.label}`.toLowerCase().includes("gpt-reserve") ? 1 : 2;
  }
  for (const window of [...observation.windows].sort((a, b) => priority(a) - priority(b))) {
    const remaining = window.usedPercent === null ? null : 100 - window.usedPercent;
    const label = window.label.replace(/\s+Limit Remaining$/i, "");
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
      element("span", `${label}${duration ? ` · ${duration}` : ""}`),
      element(
        "strong",
        remaining === null ? "Quota unknown" : `${Math.round(remaining * 10) / 10}% remaining`,
      ),
    );
    row.append(title);
    if (remaining !== null) {
      const progress = element(
        "progress",
        "",
        remaining >= 70 ? "healthy" : remaining >= 30 ? "low" : "critical",
      );
      progress.max = 100;
      progress.value = remaining;
      progress.setAttribute(
        "aria-label",
        `${label}: ${Math.round(remaining * 10) / 10}% remaining`,
      );
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
function icon(name: "reset" | "refresh" | "power" | "external"): SVGSVGElement {
  const shapes = {
    reset: [
      ["path", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"],
      ["path", "M3 3v5h5"],
    ],
    refresh: [
      ["path", "M20 11a8.1 8.1 0 0 0-15.5-2"],
      ["path", "M4 5v4h4"],
      ["path", "M4 13a8.1 8.1 0 0 0 15.5 2"],
      ["path", "M20 19v-4h-4"],
    ],
    power: [
      ["path", "M18.36 6.64a9 9 0 1 1-12.73 0"],
      ["line", "12"],
    ],
    external: [
      ["path", "M15 3h6v6"],
      ["path", "M10 14 21 3"],
      ["path", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    ],
  } as const;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const [tag, data] of shapes[name]) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    shape.setAttribute(tag === "line" ? "x1" : "d", data);
    if (tag === "line") {
      shape.setAttribute("x2", "12");
      shape.setAttribute("y1", "2");
      shape.setAttribute("y2", "12");
    }
    svg.append(shape);
  }
  return svg;
}
refreshButton.replaceChildren(icon("refresh"));
refreshButton.title = "Refresh quotas";
refreshButton.setAttribute("aria-label", "Refresh quotas");
managementButton.replaceChildren(icon("external"));
managementButton.title = "Open management";
managementButton.setAttribute("aria-label", "Open management");
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
  const identity = element("div", "", "account-identity");
  identity.append(element("p", account.provider, "account-provider"), name);
  const badges = element("div", "", "badges");
  if (account.health !== "active" && account.health !== "disabled")
    badges.append(element("span", account.health, "badge warning"));
  if (account.disabled || account.health === "disabled")
    badges.append(element("span", "Disabled", "badge warning"));
  if (account.unavailable) badges.append(element("span", "Unavailable", "badge warning"));
  identity.append(badges);
  heading.append(identity);
  article.append(heading);
  const live = account.live;
  const diagnostics = element("div", "", "account-details");
  if (live && live.status !== "unsupported") {
    if (live.status === "error")
      article.append(element("p", `Stale / unavailable · ${live.error}`, "error"));
    article.append(
      observationNode(live.observation ?? account.observation, live.status === "fresh"),
    );
  } else article.append(observationNode(account.observation));
  const bankAvailable = live?.bank?.available ?? null;
  const controls = element("div", "", "account-actions");
  function iconButton(iconName: "reset" | "refresh" | "power", label: string): HTMLButtonElement {
    const node = element("button", "", "icon-button");
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.append(icon(iconName));
    return node;
  }
  function button(
    symbol: "reset" | "refresh" | "power",
    label: string,
    action: Action,
    enabled: boolean,
  ) {
    const node = iconButton(symbol, label);
    node.disabled = pendingActions.has(account.id) || !enabled;
    node.addEventListener("click", () => {
      void runAction(action);
    });
    controls.append(node);
  }
  if (account.actions) {
    if (
      account.provider === "codex" &&
      (live?.bank?.available === null || (live?.bank?.available ?? 0) > 0)
    ) {
      const reset = iconButton(
        "reset",
        bankAvailable === null
          ? "Use banked reset; availability unknown"
          : `Use banked reset; ${bankAvailable} available`,
      );
      reset.dataset.resetAccount = account.id;
      reset.type = "button";
      reset.disabled = pendingActions.has(account.id) || !account.actions.bankReset;
      reset.addEventListener("click", () => {
        confirming = account.id;
        render();
        document.getElementById("reset-cancel")?.focus();
      });
      controls.append(reset);
    }
    button(
      "refresh",
      "Refresh credentials",
      { kind: "refresh-auth", accountId: account.id },
      account.actions.refreshAuth,
    );
    button(
      "power",
      account.disabled ? "Enable" : "Disable",
      { kind: "set-disabled", accountId: account.id, disabled: !account.disabled },
      account.actions.status && account.disabled !== null,
    );
  }
  heading.append(controls);
  if (confirming === account.id) {
    const confirmation = element("section", "", "reset-confirmation");
    confirmation.setAttribute("role", "group");
    confirmation.setAttribute("aria-label", "Confirm banked reset");
    confirmation.append(
      element(
        "p",
        `Consume one banked reset for ${account.name}? This spends an available reset credit.`,
      ),
    );
    const primary = live?.observation?.windows.find(
      (window) => window.limitId === "main" && window.label === "Primary",
    );
    if (live?.status !== "fresh" || primary?.usedPercent == null) {
      confirmation.append(
        element(
          "p",
          "Primary quota is unknown or stale. Refresh before spending a reset.",
          "warning",
        ),
      );
    } else if (100 - primary.usedPercent >= 30) {
      confirmation.append(
        element(
          "p",
          `Primary quota still has ${Math.round(100 - primary.usedPercent)}% remaining. A reset may be unnecessary.`,
          "warning",
        ),
      );
    }
    const cancel = element("button", "Cancel");
    cancel.type = "button";
    cancel.id = "reset-cancel";
    cancel.addEventListener("click", () => {
      closeConfirmation(account.id);
    });
    const confirm = element("button", "Confirm use of banked reset");
    confirm.type = "button";
    confirm.addEventListener("click", () => {
      confirming = null;
      void runAction({ kind: "consume-reset", accountId: account.id });
    });
    confirmation.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeConfirmation(account.id);
      }
    });
    confirmation.append(cancel, confirm);
    article.append(confirmation);
  }
  if (pendingActions.has(account.id) || actionMessages.has(account.id)) {
    const result = element(
      "p",
      pendingActions.has(account.id)
        ? "Account action in progress…"
        : actionMessages.get(account.id),
      "action-result",
    );
    result.setAttribute("role", "status");
    article.append(result);
  }
  if (account.disabled === null || account.unavailable === null)
    diagnostics.append(element("p", "Availability partly unknown", "unknown"));
  if (account.cooldowns === null)
    diagnostics.append(element("p", "Cooldowns unknown (remote or unreported)", "unknown"));
  for (const cooldown of account.cooldowns ?? []) {
    (cooldown.retryAt > Date.now() ? article : diagnostics).append(
      element(
        "p",
        `${cooldown.model ?? "Account"}: ${cooldown.reason.replaceAll("_", " ")} · ${cooldown.retryAt > Date.now() ? "retry" : "retry time passed"} ${timeLabel(cooldown.retryAt)}`,
        "cooldown",
      ),
    );
  }
  if (account.retryAt !== null)
    diagnostics.append(element("p", `CPA retry time · ${timeLabel(account.retryAt)}`, "cooldown"));
  if (account.detailsOmitted)
    diagnostics.append(
      element("p", "Some account details omitted (invalid data or display limit).", "unknown"),
    );
  if (diagnostics.childElementCount) article.append(diagnostics);
  return article;
}
function render(): void {
  refreshButton.disabled = busy;
  refreshButton.title = busy ? "Refreshing quotas…" : "Refresh quotas";
  connection.className = failure ? "error" : "";
  connection.textContent = failure
    ? `${snapshot ? "Stale snapshot · " : ""}${failure}`
    : snapshot
      ? `Updated ${age(snapshot.fetchedAt)}. Auto-refresh every minute.`
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
        (health.value === "unknown" &&
          !hasQuotaSignals(account.live?.observation ?? account.observation))),
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
async function refresh(manual = false): Promise<void> {
  if (busy || !ready || document.hidden || pendingActions.size) return;
  if (confirming && !manual) return;
  const startedRevision = revision;
  busy = true;
  render();
  try {
    const result = await host.serviceRequest({
      method: manual ? "POST" : "GET",
      path: manual ? "/refresh" : "/snapshot",
    });
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
    if (startedRevision !== revision) return;
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
  void loadInfo();
  void refresh(true);
});
function showActionMessage(accountId: string, message: string): void {
  actionMessages.set(accountId, message);
  const previousTimer = actionMessageTimers.get(accountId);
  if (previousTimer) clearTimeout(previousTimer);
  actionMessageTimers.set(
    accountId,
    setTimeout(() => {
      actionMessages.delete(accountId);
      actionMessageTimers.delete(accountId);
      render();
    }, 3000),
  );
}
async function runAction(action: Action): Promise<void> {
  if (pendingActions.has(action.accountId)) return;
  pendingActions.add(action.accountId);
  revision++;
  render();
  actionMessages.delete(action.accountId);
  try {
    const response = await host.serviceRequest({
      method: "POST",
      path: "/actions",
      body: JSON.stringify(action),
    });
    if (response.status !== 200) throw new Error();
    const result = actionResultSchema.parse(JSON.parse(response.body));
    showActionMessage(action.accountId, result.message);
    const current = await host.serviceRequest({ method: "GET", path: "/snapshot" });
    if (current.status === 200) snapshot = snapshotSchema.parse(JSON.parse(current.body));
  } catch {
    if (!actionMessages.has(action.accountId))
      showActionMessage(
        action.accountId,
        "Outcome uncertain. Check current account state before trying again; no automatic retry was made.",
      );
  } finally {
    pendingActions.delete(action.accountId);
    render();
  }
}
async function loadInfo(): Promise<void> {
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/info" });
    const data: unknown = JSON.parse(result.body);
    if (
      result.status === 200 &&
      data &&
      typeof data === "object" &&
      "managementUrl" in data &&
      typeof data.managementUrl === "string"
    ) {
      managementUrl = data.managementUrl;
      managementButton.disabled = false;
    }
  } catch {
    /* Setup feedback is provided by refresh. */
  }
}
managementButton.addEventListener("click", () => {
  if (managementUrl)
    void host.openUrl(managementUrl).catch(() => {
      connection.textContent = "Could not open management in the browser.";
    });
});
search.addEventListener("input", render);
provider.addEventListener("change", render);
health.addEventListener("change", render);
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (!ready) {
    ready = true;
    void loadInfo();
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
