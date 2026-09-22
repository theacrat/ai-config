import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseSnapshot } from "./parser";
import type { Snapshot } from "./snapshot";

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
export class ServiceError extends Error {
  constructor(
    readonly code:
      | "setup"
      | "upstream-auth"
      | "upstream-unavailable"
      | "invalid-response"
      | "too-large",
  ) {
    super(code);
  }
}
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
export async function fetchSnapshot(config: Config): Promise<Snapshot> {
  try {
    const response = await fetch(new URL("/v0/management/auth-files", config.baseUrl), {
      headers: { Authorization: `Bearer ${config.managementKey}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(
        response.status === 401 || response.status === 403
          ? "upstream-auth"
          : "upstream-unavailable",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceError("invalid-response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new ServiceError("too-large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let snapshot: Snapshot;
    try {
      snapshot = parseSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new ServiceError("invalid-response");
    }
    while (Buffer.byteLength(JSON.stringify(snapshot)) > 240000 && snapshot.accounts.length) {
      snapshot.accounts.pop();
      snapshot.omitted++;
    }
    return snapshot;
  } catch (error) {
    throw error instanceof ServiceError ? error : new ServiceError("upstream-unavailable");
  }
}

export function createService(
  token: string,
  load: () => Promise<Snapshot> = async () => fetchSnapshot(await readConfig()),
): Server {
  if (!token || token.length > 4096 || /[\r\n]/.test(token))
    throw new Error("Invalid service token");
  const expected = Buffer.from(`Bearer ${token}`);
  let pending: Promise<Snapshot> | null = null;
  let last: { snapshot: Snapshot; at: number } | null = null;
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
    if (req.method !== "GET") {
      send(405, { error: "method-not-allowed" });
      return;
    }
    if (req.url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (req.url !== "/snapshot") {
      send(404, { error: "not-found" });
      return;
    }
    try {
      if (last && Date.now() - last.at < 3000) {
        send(200, last.snapshot);
        return;
      }
      pending ??= load()
        .then((snapshot) => {
          last = { snapshot, at: Date.now() };
          return snapshot;
        })
        .finally(() => {
          pending = null;
        });
      send(200, await pending);
    } catch (error) {
      send(503, { error: error instanceof ServiceError ? error.code : "upstream-unavailable" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 32;
  return server;
}
