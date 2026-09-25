import { antigravity } from "./antigravity";
import { claude } from "./claude";
import { codex } from "./codex";
import { devin } from "./devin";
import { kimi } from "./kimi";
import { meta } from "./meta";
import type { Provider } from "./shared";
import { xai } from "./xai";

export const providers = new Map<string, Provider>([
  ["antigravity", antigravity],
  ["claude", claude],
  ["codex", codex],
  ["devin", devin],
  ["kimi", kimi],
  ["meta", meta],
  ["xai", xai],
]);
