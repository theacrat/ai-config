import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { diagnosticMessages, discover } from "./discovery";
import type { Inventory } from "./discovery";

export function applyConfig(config: Config, inventories: readonly Inventory[]): void {
  for (const { source, apiKey, models } of inventories) {
    config.provider ??= {};
    const existing = config.provider[source.id];
    const discovered: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = {};
    for (const model of models.values()) {
      const manual = existing?.models?.[model.id];
      const manualVariants = z
        .object({ variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional() })
        .safeParse(manual);
      discovered[model.id] = {
        id: model.id,
        name: model.name,
        tool_call: model.tools ?? source.defaults.tools,
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.reasoningOptions === undefined
          ? {}
          : { reasoning_options: model.reasoningOptions }),
        ...manual,
        ...(model.modalities === undefined
          ? {}
          : {
              modalities: { input: ["text"], output: ["text"], ...model.modalities },
            }),
        ...(model.reasoningOptions === undefined
          ? {}
          : {
              variants: {
                ...Object.fromEntries(
                  model.reasoningOptions.flatMap((option) =>
                    option.values.map((effort) => [effort, { reasoningEffort: effort }]),
                  ),
                ),
                ...(manualVariants.success ? manualVariants.data.variants : {}),
              },
            }),
        limit: {
          context: model.context ?? source.defaults.context,
          output: model.output ?? source.defaults.output,
          ...manual?.limit,
        },
      };
    }
    config.provider[source.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: source.id,
      ...existing,
      options: { baseURL: source.baseURL, ...(apiKey ? { apiKey } : {}), ...existing?.options },
      models: { ...existing?.models, ...discovered },
    };
  }
}

export async function server(
  input: Pick<PluginInput, "client">,
  options?: unknown,
): Promise<Hooks> {
  const inventories = await discover(options, (diagnostic) => {
    void input.client.app
      .log({
        body: {
          service: "model-discovery",
          level: "warn",
          message: diagnosticMessages[diagnostic.code],
          extra: diagnostic,
        },
      })
      .catch(() => {});
  });
  return {
    config: async (config) => {
      applyConfig(config, inventories);
    },
  };
}
