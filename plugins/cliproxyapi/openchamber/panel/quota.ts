// CLIProxyAPI quota domain: fetch the account list and probe each credential
// for its current windows, normalized into one shape for rendering.

export type QuotaWindow = {
  id: string
  label: string
  remainingPercent: number | null
  resetAt: string | null
  exhausted: boolean
}

export type AccountQuota = {
  authIndex: string
  name: string
  email: string
  provider: string
  planType: string | null
  status: "ok" | "low" | "exhausted" | "error" | "disabled" | "unknown"
  windows: QuotaWindow[]
  error?: string
}

export type AuthFile = {
  account?: string
  auth_index?: string
  disabled?: boolean
  email?: string
  label?: string
  name?: string
  project_id?: string
  provider?: string
  type?: string
  quota?: { signals?: Record<string, string>; observed_at?: string }
}

// Adapter to the host's HTTP layer; `path` is relative to the management API.
export type Requester = (input: { method: "GET" | "POST"; path: string; body?: unknown }) => Promise<{ status: number; body: string }>

function pick<T = number>(source: unknown, ...keys: string[]): T | undefined {
  if (!source || typeof source !== "object") return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value as T
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function normalizeBody(body: unknown): any {
  if (typeof body !== "string") return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function toIso(resetAt?: number, resetAfterSeconds?: number): string | null {
  if (typeof resetAt === "number" && resetAt > 0) return new Date(resetAt * 1000).toISOString()
  if (typeof resetAfterSeconds === "number" && resetAfterSeconds > 0) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString()
  }
  return null
}

function windowLabel(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "limit"
  if (seconds % 86_400 === 0) return `${Math.round(seconds / 86_400)}d`
  if (seconds % 3_600 === 0) return `${Math.round(seconds / 3_600)}h`
  return `${Math.round(seconds / 60)}m`
}

export function formatReset(iso: string | null): string {
  if (!iso) return ""
  const reset = new Date(iso).getTime()
  if (!Number.isFinite(reset)) return ""
  const delta = reset - Date.now()
  if (delta <= 0) return "resets now"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `resets in ${hours}h`
  return `resets in ${Math.round(hours / 24)}d`
}

async function api<T>(request: Requester, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await request({ method, path, body })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${path} returned ${response.status}`)
  }
  return JSON.parse(response.body) as T
}

// CPA swaps the `$TOKEN$` sentinel for the selected credential's OAuth token.
async function apiCall<T = any>(
  request: Requester,
  authIndex: string,
  method: "GET" | "POST",
  url: string,
  header: Record<string, string>,
  data?: string,
): Promise<T> {
  if (!authIndex) throw new Error("account has no auth_index")
  const result = await api<{ status_code?: number; body?: unknown }>(request, "/api-call", "POST", {
    auth_index: authIndex,
    method,
    url,
    header,
    ...(data === undefined ? {} : { data }),
  })
  const status = result.status_code ?? 0
  if (status < 200 || status >= 300) throw new Error(`upstream returned ${status}`)
  return normalizeBody(result.body) as T
}

export function whamWindows(body: any): QuotaWindow[] {
  const rateLimit = body?.rate_limit ?? body?.rateLimit ?? {}
  const windows: QuotaWindow[] = []
  const add = (raw: any, idPrefix: string, labelPrefix = "") => {
    if (!raw || typeof raw !== "object") return
    const used = pick<number>(raw, "used_percent", "usedPercent")
    const seconds = pick<number>(raw, "limit_window_seconds", "limitWindowSeconds")
    windows.push({
      id: `${idPrefix}-${windows.length}`,
      label: `${labelPrefix}${windowLabel(seconds)}`,
      remainingPercent: typeof used === "number" ? clampPercent(100 - used) : null,
      resetAt: toIso(
        pick<number>(raw, "reset_at", "resetAt"),
        pick<number>(raw, "reset_after_seconds", "resetAfterSeconds"),
      ),
      exhausted: typeof used === "number" && used >= 100,
    })
  }
  add(rateLimit.primary_window ?? rateLimit.primaryWindow, "primary")
  add(rateLimit.secondary_window ?? rateLimit.secondaryWindow, "secondary")
  const additional = rateLimit.additional_rate_limits ?? rateLimit.additionalRateLimits
  if (Array.isArray(additional)) {
    additional.forEach((extra: any, index: number) => {
      const name =
        pick<string>(extra, "limit_name", "limitName", "metered_feature", "meteredFeature") ??
        `extra-${index + 1}`
      const nested = extra?.rate_limit ?? extra?.rateLimit ?? {}
      add(nested?.primary_window ?? nested?.primaryWindow, `${name}-primary`, `${name} `)
      add(nested?.secondary_window ?? nested?.secondaryWindow, `${name}-secondary`, `${name} `)
    })
  }
  return windows
}

export function antigravityWindows(body: any): QuotaWindow[] {
  const models = body?.models
  if (!models || typeof models !== "object") return []
  const windows: QuotaWindow[] = []
  for (const [id, entry] of Object.entries<any>(models)) {
    const info = entry?.quotaInfo ?? entry?.quota_info
    if (!info) continue
    const fraction = pick<number>(info, "remainingFraction", "remaining_fraction", "remaining")
    if (typeof fraction !== "number") continue
    windows.push({
      id,
      label: entry?.displayName ?? id,
      remainingPercent: clampPercent(fraction * 100),
      resetAt: pick<string>(info, "resetTime", "reset_time") ?? null,
      exhausted: fraction <= 0,
    })
  }
  windows.sort((a, b) => (a.remainingPercent ?? 100) - (b.remainingPercent ?? 100))
  return windows
}

// Quota CPA already observed from response headers, used when a live probe fails.
export function signalsWindows(signals?: Record<string, string>): QuotaWindow[] {
  if (!signals) return []
  const windows: QuotaWindow[] = []
  const add = (prefix: "Primary" | "Secondary", id: string) => {
    const used = signals[`X-Codex-${prefix}-Used-Percent`]
    const resetAt = signals[`X-Codex-${prefix}-Reset-At`]
    const minutes = signals[`X-Codex-${prefix}-Window-Minutes`]
    if (used === undefined && resetAt === undefined && minutes === undefined) return
    const usedNumber = used === undefined ? NaN : Number(used)
    const seconds = minutes === undefined ? undefined : Number(minutes) * 60
    windows.push({
      id,
      label: windowLabel(seconds),
      remainingPercent: Number.isFinite(usedNumber) ? clampPercent(100 - usedNumber) : null,
      resetAt: toIso(Number(resetAt)),
      exhausted: Number.isFinite(usedNumber) && usedNumber >= 100,
    })
  }
  add("Primary", "signal-primary")
  add("Secondary", "signal-secondary")
  return windows
}

const CODEX_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
}

const ANTIGRAVITY_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "antigravity/1.11.5 windows/amd64",
}

// Provider -> live quota probe. Providers without an entry fall back to signals.
const PROBES: Record<string, (request: Requester, entry: AuthFile) => Promise<{ planType: string | null; windows: QuotaWindow[] }>> = {
  codex: async (request, entry) => {
    const body = await apiCall(request, entry.auth_index ?? "", "GET", "https://chatgpt.com/backend-api/wham/usage", CODEX_HEADERS)
    return {
      planType: pick<string>(body, "plan_type", "planType") ?? null,
      windows: whamWindows(body),
    }
  },
  antigravity: async (request, entry) => {
    const data = JSON.stringify({ project: entry.project_id ?? "" })
    const body = await apiCall(
      request,
      entry.auth_index ?? "",
      "POST",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      ANTIGRAVITY_HEADERS,
      data,
    )
    return { planType: null, windows: antigravityWindows(body) }
  },
}

function withStatus(account: AccountQuota): AccountQuota {
  const remaining = account.windows
    .map((window) => window.remainingPercent)
    .filter((value): value is number => typeof value === "number")
  if (!remaining.length) return { ...account, status: "unknown" }
  const worst = Math.min(...remaining)
  return { ...account, status: worst <= 0 ? "exhausted" : worst <= 30 ? "low" : "ok" }
}

export async function collectAccount(request: Requester, entry: AuthFile): Promise<AccountQuota> {
  const provider = (entry.provider ?? entry.type ?? "unknown").toLowerCase()
  const base: AccountQuota = {
    authIndex: entry.auth_index ?? "",
    name: entry.email ?? entry.label ?? entry.account ?? entry.name ?? "account",
    email: entry.email ?? entry.account ?? "",
    provider,
    planType: null,
    status: "unknown",
    windows: [],
  }
  if (entry.disabled) return { ...base, status: "disabled" }
  try {
    const probe = PROBES[provider]
    if (!probe) {
      const fallback = signalsWindows(entry.quota?.signals)
      if (!fallback.length) throw new Error(`no quota probe for provider "${provider}"`)
      return withStatus({ ...base, windows: fallback })
    }
    const result = await probe(request, entry)
    return withStatus({ ...base, planType: result.planType, windows: result.windows })
  } catch (error) {
    const fallback = signalsWindows(entry.quota?.signals)
    if (fallback.length) return withStatus({ ...base, windows: fallback })
    return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchQuotas(request: Requester): Promise<AccountQuota[]> {
  const result = await api<{ files?: AuthFile[] }>(request, "/auth-files", "GET")
  const files = Array.isArray(result.files) ? result.files : []
  return Promise.all(files.map((entry) => collectAccount(request, entry)))
}
