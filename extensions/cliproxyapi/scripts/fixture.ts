import { OPENCHAMBER_SDK_CHANNEL, type HostReadyContext } from "@openchamber/sdk";
import { parseGuestMessage, hostMessageSchema } from "@openchamber/sdk/schemas";
import { parseSnapshot } from "../src/parser";
import { actionSchema } from "../src/snapshot";

const frame = document.querySelector("iframe");
const requests = document.querySelector("#requests");
if (!(frame instanceof HTMLIFrameElement) || !requests) throw new Error("Missing fixture elements");
let count = 0;
let mode = "success";
let dark = true;
const now = Date.now();
const observedAt = new Date(now - 45 * 60000).toISOString();
const quota = {
  observed_at: observedAt,
  signals: {
    "X-Codex-Primary-Used-Percent": "37",
    "X-Codex-Primary-Window-Minutes": "300",
    "X-Codex-Primary-Reset-After-Seconds": "7200",
    "X-Codex-Secondary-Used-Percent": "93",
    "X-Codex-Secondary-Window-Minutes": "10080",
    "X-Codex-Secondary-Reset-At": String(Math.floor(now / 1000 + 3600 * 24)),
  },
};
const snapshot = parseSnapshot(
  {
    files: [
      {
        auth_index: "1111111111111111",
        label: "Personal Codex fixture",
        provider: "codex",
        status: "active",
        disabled: false,
        unavailable: false,
        quota,
        cooldowns: [],
        model_quotas: { "gpt-5.6-luna": quota },
      },
      {
        auth_index: "2222222222222222",
        email: "team@example.invalid",
        provider: "codex",
        status: "error",
        disabled: false,
        unavailable: true,
        quota: {
          observed_at: observedAt,
          signals: {
            "X-Codex-Allowed": "false",
            "X-Codex-Limit-Reached": "true",
            "X-Codex-Credits-Balance": "0",
          },
        },
        cooldowns: [
          {
            scope: "model",
            model_key: "gpt-5-codex",
            reason: "quota",
            retry_at: new Date(now + 600000).toISOString(),
          },
        ],
      },
      {
        auth_index: "4444444444444444",
        name: "antigravity-fixture.json",
        provider: "antigravity",
        disabled: false,
        status: "active",
      },
      {
        auth_index: "3333333333333333",
        name: "claude-fixture.json",
        provider: "claude",
        status: "disabled",
        disabled: true,
        unavailable: false,
        cooldowns: null,
      },
    ],
  },
  now,
);
for (const account of snapshot.accounts) {
  account.actions = {
    status: true,
    refreshAuth: true,
    bankReset: account.id === "1111111111111111",
  };
  if (account.id === "1111111111111111")
    account.live = {
      status: "fresh",
      attemptedAt: now,
      error: null,
      observation: { ...account.observation, observedAt: now },
      bank: { available: 2, applicable: 0, expiries: [now + 86400000], error: null },
    };
  if (account.provider === "antigravity")
    account.live = {
      status: "fresh",
      attemptedAt: now,
      error: null,
      bank: null,
      observation: {
        observedAt: now,
        windows: [
          {
            limitId: "premium-weekly",
            label: "Premium",
            description: "Shared premium models",
            usedPercent: 25,
            minutes: 10080,
            resetAt: now + 86400000,
          },
        ],
        limits: [],
        activeLimit: null,
        credits: null,
      },
    };
}
function ready(): HostReadyContext {
  return {
    theme: {
      mode: dark ? "dark" : "light",
      tokens: {
        background: dark ? "#20242b" : "#ffffff",
        elevated: dark ? "#2c313b" : "#f7f8fa",
        foreground: dark ? "#e2e5ea" : "#20242b",
        muted: dark ? "#aab1bd" : "#59616c",
        subtle: "#6f7886",
        border: dark ? "#505765" : "#c6ccd4",
        hover: dark ? "#373f4a" : "#eceff3",
        selection: "#3e5778",
        focus: "#5b98e0",
        primary: "#4c84bd",
        mutedSurface: dark ? "#292e36" : "#f0f2f5",
        elevatedForeground: dark ? "#e2e5ea" : "#20242b",
        active: "#3e5778",
        selectionForeground: "#ffffff",
        primaryForeground: "#ffffff",
        primaryText: dark ? "#91beef" : "#24588f",
        successText: dark ? "#9fd9b0" : "#25613c",
        warningText: dark ? "#ffd189" : "#845500",
        errorText: dark ? "#ffadad" : "#a32626",
        infoText: dark ? "#91beef" : "#24588f",
        success: "#38915b",
        warning: "#c98a27",
        error: "#bc4040",
        info: "#4c84bd",
        font: "system-ui, sans-serif",
        mono: "monospace",
        radius: "6px",
      },
    },
    locale: "en",
    directory: null,
    session: null,
    surface: "panel",
    connection: { connected: false, account: "" },
    settings: {},
    item: null,
  };
}
function send(message: unknown): void {
  const parsed = hostMessageSchema.parse(message);
  frame?.contentWindow?.postMessage(parsed, "*");
}
function pushReady(): void {
  send({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: 1,
    type: "ready",
    payload: ready(),
  });
}
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = parseGuestMessage(event.data);
  if (!message) return;
  if (message.type === "hello") {
    pushReady();
    return;
  }
  if (message.type === "open-url") {
    document.querySelector("#mode")?.replaceChildren(`Opened externally: ${message.payload.url}`);
    send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: "result",
      id: message.id,
      ok: true,
      payload: {},
    });
    return;
  }
  if (message.type !== "service-request") return;
  const reply = (body: unknown, status = 200) =>
    send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: "result",
      id: message.id,
      ok: true,
      payload: { status, body: JSON.stringify(body) },
    });
  if (message.payload.path === "/info") {
    reply({ managementUrl: "https://cpa.example.invalid/management.html" });
    return;
  }
  if (message.payload.path === "/actions" && message.payload.method === "POST") {
    const action = actionSchema.parse(JSON.parse(message.payload.body ?? "{}"));
    const account = snapshot.accounts.find((a) => a.id === action.accountId);
    if (!account) throw new Error("Unknown fixture account");
    if (mode === "uncertain") {
      reply({
        status: "uncertain",
        message:
          "Outcome uncertain. Check current state before trying again; no automatic retry was made.",
      });
      return;
    }
    if (mode === "rejected") {
      reply({ status: "rejected", message: "Action rejected by the synthetic upstream" });
      return;
    }
    if (action.kind === "set-disabled") {
      account.disabled = action.disabled;
      account.health = action.disabled ? "disabled" : "active";
    }
    if (action.kind === "consume-reset" && account.live?.bank) {
      account.live.bank.available = Math.max(0, (account.live.bank.available ?? 0) - 1);
      if (account.live.observation)
        for (const window of account.live.observation.windows) window.usedPercent = 0;
      if (account.actions) account.actions.bankReset = (account.live.bank.available ?? 0) > 0;
    }
    if (mode === "action-refresh-failed") {
      if (account.live) {
        account.live.status = "error";
        account.live.error = "Quota refresh failed after successful action";
      }
      reply({
        status: "success-refresh-failed",
        message:
          action.kind === "consume-reset"
            ? "Banked reset consumed. Quota refresh failed; refresh to check current usage."
            : "Account updated. Quota refresh failed.",
      });
    } else
      reply({
        status: "success",
        message:
          action.kind === "consume-reset"
            ? "Banked reset consumed; quotas refreshed"
            : "Account updated; quotas refreshed",
      });
    return;
  }
  count++;
  requests.textContent = `Snapshot requests: ${count}`;
  if (
    !(
      (message.payload.method === "GET" && message.payload.path === "/snapshot") ||
      (message.payload.method === "POST" && message.payload.path === "/refresh")
    )
  )
    throw new Error("Unexpected fixture request");
  if (mode === "disconnected") {
    send({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: "result",
      id: message.id,
      ok: false,
      code: "SERVICE_FAILED",
      error: "Fixture unavailable",
    });
    return;
  }
  if (mode === "partial") {
    const account = snapshot.accounts[0];
    if (account?.live) {
      account.live.status = "error";
      account.live.error = "Live quota read failed; previous readings retained";
      if (account.actions) account.actions.bankReset = false;
    }
  } else if (mode === "success") {
    for (const account of snapshot.accounts)
      if (account.live) {
        account.live.status = "fresh";
        account.live.error = null;
        if (account.actions) account.actions.bankReset = (account.live.bank?.available ?? 0) > 0;
      }
  }
  const body =
    mode === "setup"
      ? { error: "setup" }
      : mode === "error"
        ? { error: "upstream-unavailable" }
        : mode === "empty"
          ? { fetchedAt: Date.now(), omitted: 0, accounts: [] }
          : { ...snapshot, fetchedAt: Date.now() };
  send({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: 1,
    type: "result",
    id: message.id,
    ok: true,
    payload: {
      status: ["setup", "error"].includes(mode) ? 503 : 200,
      body: JSON.stringify(body),
    },
  });
});
document.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    mode = button.dataset.mode ?? "success";
    document
      .querySelector("#mode")
      ?.replaceChildren(`Next response: ${mode}. Press Refresh inside the panel.`);
  }),
);
document.querySelector("#theme")?.addEventListener("click", () => {
  dark = !dark;
  pushReady();
});
document.querySelector("#width")?.addEventListener("click", () => {
  frame.style.width = frame.style.width === "760px" ? "360px" : "760px";
});
frame.src = "/panel/index.html";
