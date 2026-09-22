// CLIProxyAPI provider for OpenCode.
//
// Registers a `cliproxyapi` provider whose model list comes from the
// instance's own `/v1/models` endpoint, so new models and context limits
// show up without editing config. Endpoint and API key come from the Codex
// CLIProxyAPI config (`[model_providers.cliproxyapi]` in config.toml).
//
// One module serves both plugin APIs: OpenCode v1 calls `server()` and
// OpenCode v2 calls `setup()`. No imports, so it loads under either.

type CpaOptions = {
  configPath?: string
  baseUrl?: string
  apiKey?: string
  outputLimit?: number
}

type CpaModel = {
  id: string
  owned_by?: string
  created?: number
  context_length?: number
  max_context_length?: number
}

type ResolvedConfig = {
  baseUrl: string
  apiKey: string
  outputLimit: number
}

const PROVIDER_ID = "cliproxyapi"
const PROVIDER_NAME = "CLIProxyAPI"
const DEFAULT_OUTPUT_LIMIT = 65_536
const FALLBACK_CONTEXT_LIMIT = 128_000

function homeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  return home.replace(/[/\\]+$/, "")
}

function defaultConfigPaths(): Array<string> {
  const home = homeDir()
  const candidates = [
    process.env.CODEX_HOME ? `${process.env.CODEX_HOME}/config.toml` : "",
    `${home}/.codex-custom/config.toml`,
    `${home}/.codex/config.toml`,
  ]
  return candidates.filter((path) => path.length > 0)
}

function readTomlTable(text: string, table: string): Record<string, string> {
  const values: Record<string, string> = {}
  let inside = false
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("[")) {
      inside = line === `[${table}]`
      continue
    }
    if (!inside || line.length === 0 || line.startsWith("#")) continue
    const match = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line)
    if (match) values[match[1]] = match[2]
  }
  return values
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function resolveConfig(options: CpaOptions): Promise<ResolvedConfig | undefined> {
  let baseUrl = options.baseUrl ?? process.env.CLIPROXYAPI_BASE_URL ?? ""
  let apiKey = options.apiKey ?? process.env.CLIPROXYAPI_API_KEY ?? ""
  if (!baseUrl || !apiKey) {
    const explicit = options.configPath ?? process.env.CLIPROXYAPI_CONFIG
    const paths = explicit ? [explicit] : defaultConfigPaths()
    for (const path of paths) {
      const text = await readFileIfExists(path)
      if (!text) continue
      const table = readTomlTable(text, "model_providers.cliproxyapi")
      baseUrl = baseUrl || table["base_url"] || ""
      apiKey = apiKey || table["experimental_bearer_token"] || ""
      if (baseUrl && apiKey) break
    }
  }
  if (!baseUrl || !apiKey) return undefined
  const requested = options.outputLimit ?? (process.env.CLIPROXYAPI_OUTPUT_LIMIT ? Number(process.env.CLIPROXYAPI_OUTPUT_LIMIT) : undefined)
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    outputLimit: typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_OUTPUT_LIMIT,
  }
}

async function fetchModels(config: ResolvedConfig): Promise<Array<CpaModel>> {
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`cliproxyapi models endpoint returned ${response.status}`)
  }
  const body = (await response.json()) as { data?: Array<CpaModel> }
  if (!body || !Array.isArray(body.data)) {
    throw new Error("cliproxyapi models endpoint returned an unexpected shape")
  }
  return body.data.filter((model) => model && typeof model.id === "string")
}

function contextLimit(model: CpaModel): number {
  return model.max_context_length ?? model.context_length ?? FALLBACK_CONTEXT_LIMIT
}

// v1 model entries (opencode.json `provider.<id>.models`).
function toV1Models(models: Array<CpaModel>, outputLimit: number) {
  const entries: Record<string, { name: string; limit: { context: number; output: number } }> = {}
  for (const model of models) {
    entries[model.id] = {
      name: model.id,
      limit: { context: contextLimit(model), output: outputLimit },
    }
  }
  return entries
}

// v2 Model.Info records, mirroring Model.Info.default() with live limits.
function toV2Models(models: Array<CpaModel>, outputLimit: number) {
  return models.map((model) => ({
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: model.id,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: model.created ?? 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: contextLimit(model), output: outputLimit },
  }))
}

function missingAuthMessage(): string {
  return "no API key — set [model_providers.cliproxyapi] experimental_bearer_token in the Codex config or CLIPROXYAPI_API_KEY"
}

export default {
  id: PROVIDER_ID,

  // OpenCode v1 entrypoint (also 1.18.29+ object modules).
  async server(_input: unknown, options?: CpaOptions) {
    const config = await resolveConfig(options ?? {})
    if (!config) {
      console.warn(`[${PROVIDER_ID}] ${missingAuthMessage()}; provider not registered`)
      return {}
    }
    let models: Array<CpaModel> = []
    try {
      models = await fetchModels(config)
    } catch (error) {
      console.warn(`[${PROVIDER_ID}] models endpoint unreachable, registering provider without models: ${String(error)}`)
    }
    return {
      config: async (opencodeConfig: {
        provider?: Record<string, Record<string, unknown>>
      }) => {
        opencodeConfig.provider = opencodeConfig.provider ?? {}
        opencodeConfig.provider[PROVIDER_ID] = {
          npm: "@ai-sdk/openai-compatible",
          name: PROVIDER_NAME,
          options: { baseURL: config.baseUrl, apiKey: config.apiKey },
          models: toV1Models(models, config.outputLimit),
        }
      },
    }
  },

  // OpenCode v2 entrypoint.
  async setup(ctx: {
    options?: CpaOptions
    provider?: { transform: (edit: (editor: unknown) => void) => Promise<unknown> }
  }) {
    const transform = ctx.provider?.transform
    if (typeof transform !== "function") {
      // No provider registry here (e.g. the v1 host also invoking setup):
      // the v1 config hook already registered everything.
      return
    }
    const config = await resolveConfig(ctx.options ?? {})
    if (!config) {
      console.warn(`[${PROVIDER_ID}] ${missingAuthMessage()}; provider not registered`)
      return
    }
    let models: Array<CpaModel> = []
    try {
      models = await fetchModels(config)
    } catch (error) {
      console.warn(`[${PROVIDER_ID}] models endpoint unreachable, registering provider without models: ${String(error)}`)
    }
    const info = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: config.baseUrl, apiKey: config.apiKey },
    }
    const v2models = toV2Models(models, config.outputLimit)
    await transform((editor: {
      get: (id: string) => unknown
      add: (input: unknown) => void
      models: { set: (id: string, models: unknown) => void }
    }) => {
      if (editor.get(PROVIDER_ID)) {
        editor.models.set(PROVIDER_ID, v2models)
      } else {
        editor.add({ info, models: v2models })
      }
    })
  },
}
