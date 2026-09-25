import type { Plugin } from "@opencode/plugin";
import { setup } from "./v2";

export type { Options } from "./discovery";

export default {
	id: "model-discovery",
	setup,
} satisfies Plugin.Plugin;
