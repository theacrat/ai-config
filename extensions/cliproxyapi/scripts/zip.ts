import { mkdir, rm } from "node:fs/promises";
const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
if ((await build.exited) !== 0) throw new Error("Build failed");
await mkdir("dist", { recursive: true });
const zip = "dist/openchamber-cliproxyapi.zip";
await rm(zip, { force: true });
const process = Bun.spawn(
  [
    "zip",
    "-q",
    zip,
    "package.json",
    "README.md",
    "panel/index.html",
    "panel/style.css",
    "panel/main.js",
    "service/main.js",
    "licenses/openchamber-sdk-MIT.txt",
    "licenses/zod-MIT.txt",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await process.exited) !== 0) throw new Error("ZIP failed; install the zip command and retry");
console.log(zip);
