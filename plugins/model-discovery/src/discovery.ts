import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const url = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    ["http:", "https:"].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.hash
  );
});
const defaults = z
  .object({
    context: positive.default(32768),
    output: positive.default(4096),
    tools: z.boolean().default(true),
  })
  .strict();
const source = z
  .object({
    id: identifier,
    baseURL: url,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    modelsURL: url.optional(),
    timeoutMs: positive.max(2147483647).default(10000),
    defaults: defaults.prefault({}),
  })
  .strict();
export const optionsSchema = z
  .object({ sources: z.array(source) })
  .strict()
  .refine(({ sources }) => new Set(sources.map((item) => item.id)).size === sources.length);
export type Options = z.input<typeof optionsSchema>;
export type Source = z.output<typeof source>;

const model = z.object({
  id: identifier,
  name: z.string().min(1).optional(),
  context_length: positive.optional(),
  max_context_length: positive.optional(),
  max_output_tokens: positive.optional(),
  tool_call: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
});
const responseSchema = z
  .object({ data: z.array(model) })
  .refine(({ data }) => new Set(data.map((item) => item.id)).size === data.length);
export type DiscoveredModel = {
  id: string;
  name: string;
  context?: number;
  output?: number;
  tools?: boolean;
};
export type Inventory = {
  source: Source;
  apiKey: string | undefined;
  models: ReadonlyMap<string, DiscoveredModel>;
};
export type Diagnostic = {
  code:
    | "invalid-options"
    | "missing-api-key"
    | "http-error"
    | "invalid-response"
    | "request-failed";
  sourceIndex?: number;
  status?: number;
};
export type Reporter = (diagnostic: Diagnostic) => void;

export async function discover(input: unknown, report: Reporter): Promise<Inventory[]> {
  let options;
  try {
    const explicit = z.record(z.string(), z.unknown()).safeParse(input);
    const fallback =
      input === undefined || (explicit.success && Object.keys(explicit.data).length === 0);
    const value: unknown =
      fallback && process.env.OPENCODE_MODEL_DISCOVERY
        ? JSON.parse(process.env.OPENCODE_MODEL_DISCOVERY)
        : input;
    options = optionsSchema.parse(value);
  } catch {
    report({ code: "invalid-options" });
    return [];
  }
  const results = await Promise.all(
    options.sources.map(async (source, sourceIndex) => {
      const apiKey = source.apiKeyEnv ? process.env[source.apiKeyEnv] : undefined;
      if (source.apiKeyEnv && !apiKey) {
        report({ code: "missing-api-key", sourceIndex });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), source.timeoutMs);
      try {
        const base = new URL(source.baseURL);
        base.pathname = `${base.pathname.replace(/\/$/, "")}/models`;
        const response = await fetch(source.modelsURL ?? base, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          report({ code: "http-error", sourceIndex, status: response.status });
          return;
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          report({ code: "invalid-response", sourceIndex });
          return;
        }
        const parsed = responseSchema.safeParse(data);
        if (!parsed.success) {
          report({ code: "invalid-response", sourceIndex });
          return;
        }
        const models = new Map<string, DiscoveredModel>();
        for (const item of parsed.data.data) {
          models.set(item.id, {
            id: item.id,
            name: item.name ?? item.id,
            context: item.context_length ?? item.max_context_length,
            output: item.max_output_tokens,
            tools: item.tool_call ?? item.supports_tools,
          });
        }
        return { source, apiKey, models } satisfies Inventory;
      } catch {
        report({ code: "request-failed", sourceIndex });
        return;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return results.filter((item) => item !== undefined);
}
