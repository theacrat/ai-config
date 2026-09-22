import { connectHost, HostRequestError } from "@openchamber/sdk"
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountProgress,
  mountSpinner,
} from "@openchamber/sdk/ui"
import { fetchQuotas, formatReset, type AccountQuota, type QuotaWindow, type Requester } from "./quota"

// Every backend lives under this prefix on the CPA origin.
const MGMT = "/cpa/v0/management"

const host = connectHost()
const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("cpa-quotas: #root missing")

const request: Requester = (input) =>
  host.request({ method: input.method, path: `${MGMT}${input.path}`, body: input.body })

let disposers: Array<{ dispose: () => void }> = []
let lastConnected: boolean | undefined
let loading = false

function clear() {
  for (const item of disposers) item.dispose()
  disposers = []
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function statusTone(status: AccountQuota["status"]): "success" | "warning" | "error" | "neutral" {
  if (status === "ok") return "success"
  if (status === "low") return "warning"
  if (status === "exhausted" || status === "error") return "error"
  return "neutral"
}

function progressTone(window: QuotaWindow): "success" | "warning" | "error" | "neutral" {
  if (window.exhausted) return "error"
  if (window.remainingPercent === null) return "neutral"
  return window.remainingPercent <= 30 ? "warning" : "success"
}

function statusRank(status: AccountQuota["status"]): number {
  if (status === "exhausted" || status === "error") return 0
  if (status === "low") return 1
  if (status === "ok") return 2
  if (status === "disabled") return 3
  return 4
}

function renderAccount(account: AccountQuota): HTMLElement {
  const card = el("div", "cpa-account")
  const head = el("div", "cpa-account-head")
  head.appendChild(el("div", "cpa-account-name", account.name))
  disposers.push(mountBadge(head, { label: account.provider, tone: "neutral" }))
  if (account.planType) disposers.push(mountBadge(head, { label: account.planType, tone: "info" }))
  disposers.push(mountBadge(head, { label: account.status, tone: statusTone(account.status) }))
  card.appendChild(head)

  for (const window of account.windows) {
    const row = el("div", "cpa-window")
    const meta = el("div", "cpa-window-meta")
    meta.appendChild(el("div", "cpa-window-label", window.label))
    const percent = window.remainingPercent === null ? "no data" : `${Math.round(window.remainingPercent)}% left`
    meta.appendChild(el("div", "cpa-window-reset", [percent, formatReset(window.resetAt)].filter(Boolean).join(" · ")))
    row.appendChild(meta)
    const bar = el("div")
    row.appendChild(bar)
    disposers.push(mountProgress(bar, { value: window.remainingPercent ?? 0, tone: progressTone(window) }))
    card.appendChild(row)
  }

  if (account.error) card.appendChild(el("div", "cpa-error", account.error))
  return card
}

function renderAccounts(accounts: AccountQuota[]) {
  clear()
  const head = el("div", "cpa-head")
  head.appendChild(el("div", "cpa-head-title", "CPA Quotas"))
  disposers.push(mountButton(head, { label: "Refresh", size: "sm", variant: "secondary", onClick: () => void load() }))

  const summary = el("div", "cpa-summary")
  const low = accounts.filter((account) => account.status === "low").length
  const dead = accounts.filter((account) => account.status === "exhausted" || account.status === "error").length
  disposers.push(mountBadge(summary, { label: `${accounts.length} accounts`, tone: "neutral" }))
  if (low) disposers.push(mountBadge(summary, { label: `${low} low`, tone: "warning" }))
  if (dead) disposers.push(mountBadge(summary, { label: `${dead} out`, tone: "error" }))

  root.appendChild(head)
  root.appendChild(summary)
  for (const account of [...accounts].sort((a, b) => statusRank(a.status) - statusRank(b.status))) {
    root.appendChild(renderAccount(account))
  }
  root.appendChild(el("div", "cpa-updated", `updated ${new Date().toLocaleTimeString()}`))
}

function renderDisconnected() {
  clear()
  disposers.push(
    mountEmpty(root, {
      title: "Not connected",
      body: "Paste the CLIProxyAPI management key in Settings → Integrations → CLIProxyAPI.",
    }),
  )
}

async function load() {
  if (loading) return
  loading = true
  clear()
  const spinner = mountSpinner(root, { label: "Reading quotas" })
  disposers.push(spinner)
  try {
    const accounts = await fetchQuotas(request)
    spinner.dispose()
    disposers = disposers.filter((item) => item !== spinner)
    renderAccounts(accounts)
  } catch (error) {
    spinner.dispose()
    disposers = disposers.filter((item) => item !== spinner)
    const message = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
    disposers.push(mountBanner(root, { tone: "error", title: "Could not read quotas", body: message }))
  } finally {
    loading = false
  }
}

let mounted = false
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  if (mounted) return
  mounted = true
  renderDisconnected()
})

host.onConnection((connection) => {
  const connected = Boolean(connection?.connected)
  if (connected === lastConnected) return
  lastConnected = connected
  if (connected) void load()
  else renderDisconnected()
})
