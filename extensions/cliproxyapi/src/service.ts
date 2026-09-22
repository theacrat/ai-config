import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { actionSchema } from "./snapshot";
import { createController, type Controller } from "./controller";
import { ServiceError } from "./upstream";
export { ServiceError } from "./upstream";

export const configPath = () => join(homedir(), ".config/openchamber/cliproxyapi.json");
const configSchema = z.object({
  baseUrl: z.string().default("http://cpa.nb"),
  managementKey: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim() === value && !/[\r\n]/.test(value)),
});
export type Config = z.infer<typeof configSchema>;
export async function readConfig(path = configPath()): Promise<Config> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error();
      const config = configSchema.parse(JSON.parse(await file.readFile("utf8")));
      const url = new URL(config.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error();
      return config;
    } finally {
      await file.close();
    }
  } catch {
    throw new ServiceError("setup");
  }
}
export function createService(
  token: string,
  source: Controller = createController(readConfig),
): Server {
  if (!token || token.length > 4096 || /[\r\n]/.test(token))
    throw new Error("Invalid service token");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true });
      return;
    }
    try {
      if (req.url === "/info" && req.method === "GET") {
        send(200, await source.info());
        return;
      }
      if (req.url === "/actions" && req.method === "POST") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > 4096) {
            send(413, { error: "too-large" });
            return;
          }
          chunks.push(buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          send(400, { error: "invalid-action" });
          return;
        }
        const parsed = actionSchema.safeParse(body);
        if (!parsed.success) {
          send(400, { error: "invalid-action" });
          return;
        }
        send(200, await source.action(parsed.data));
        return;
      }
      if (
        (req.url === "/refresh" && req.method === "POST") ||
        (req.url === "/snapshot" && req.method === "GET")
      ) {
        send(200, await source.snapshot(req.url === "/refresh"));
        return;
      }
      if (req.method !== "GET") {
        send(405, { error: "method-not-allowed" });
        return;
      }
      send(404, { error: "not-found" });
    } catch (error) {
      send(503, {
        error: error instanceof ServiceError ? error.code : "upstream-unavailable",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 32;
  return server;
}
