import { Model, Provider } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import { diagnosticMessages, discover } from "./discovery";
import type { Inventory } from "./discovery";

export function applyProviders(editor: ProviderEditor, inventories: readonly Inventory[]): void {
  for (const { source, apiKey, models } of inventories) {
    const id = Provider.ID.make(source.id);
    const existing = editor.get(id);
    const merged = new Map<string, Model.Info>();
    for (const model of models.values()) {
      const initial = Model.Info.default(id, Model.ID.make(model.id));
      merged.set(model.id, {
        ...initial,
        enabled: true,
        name: model.name,
        capabilities: {
          input: ["text"],
          output: ["text"],
          tools: model.tools ?? source.defaults.tools,
        },
        limit: {
          context: model.context ?? source.defaults.context,
          output: model.output ?? source.defaults.output,
        },
      });
    }
    for (const [key, model] of existing?.models ?? []) merged.set(key, model);
    const settings = {
      baseURL: source.baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...existing?.provider.settings,
    };
    if (existing) {
      editor.update(id, (provider) => {
        provider.settings = settings;
      });
      editor.models.set(id, [...merged.values()]);
    } else {
      editor.add({
        info: {
          ...Provider.Info.empty(id),
          name: source.id,
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings,
        },
        models: [...merged.values()],
      });
    }
  }
}

export async function setup(
  ctx: Pick<Plugin.Context, "options"> & {
    provider: Pick<Plugin.Context["provider"], "transform">;
  },
): Promise<Plugin.Cleanup> {
  const inventories = await discover(ctx.options, (diagnostic) => {
    console.warn(
      JSON.stringify({
        service: "model-discovery",
        message: diagnosticMessages[diagnostic.code],
        ...diagnostic,
      }),
    );
  });
  const registration = await ctx.provider.transform((editor) =>
    applyProviders(editor, inventories),
  );
  return () => registration.dispose();
}
