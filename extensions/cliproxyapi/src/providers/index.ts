import { antigravity } from "./antigravity";
import { claude } from "./claude";
import { codex } from "./codex";
import { devin } from "./devin";
import { kimi } from "./kimi";
import { meta } from "./meta";
import type { Provider } from "./shared";
import { xai } from "./xai";

export const providers: Record<string, Provider | undefined> = {
  antigravity,
  claude,
  codex,
  devin,
  kimi,
  meta,
  xai,
};
