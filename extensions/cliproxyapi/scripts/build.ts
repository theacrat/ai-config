import { parseManifestJson } from "@openchamber/sdk/schemas";
import manifest from "../package.json";
import { copyFile, mkdir } from "node:fs/promises";

const parsed = parseManifestJson(JSON.stringify(manifest));
if (!parsed.ok) throw new Error("Invalid extension manifest");
await mkdir("licenses", { recursive: true });
await copyFile("node_modules/@openchamber/sdk/LICENSE", "licenses/openchamber-sdk-MIT.txt");
await copyFile("node_modules/zod/LICENSE", "licenses/zod-MIT.txt");
for (const [entrypoint, target, format] of [
  ["panel/main.ts", "browser", "iife"],
  ["service/main.ts", "node", "cjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: entrypoint.split("/")[0],
    target,
    format,
    minify: true,
    naming: "main.js",
  });
  if (!result.success) throw new Error(String(result.logs));
}
