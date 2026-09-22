import type { Plugin } from "@opencode/plugin";
import type { PluginModule } from "@opencode-ai/plugin";
import { server } from "./v1";

export type { Options } from "./discovery";

export default {
  id: "model-discovery",
  server,
  async setup(ctx: Parameters<typeof import("./v2").setup>[0]) {
    const { setup } = await import("./v2");
    return setup(ctx);
  },
} satisfies Plugin.Plugin & PluginModule;
