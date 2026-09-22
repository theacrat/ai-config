import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createService, fetchSnapshot, readConfig } from "../src/service";

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
describe("local service boundary", () => {
  it("authenticates health and snapshot before any work and exposes only fixed GET routes", async () => {
    let reads = 0;
    const origin = await listen(
      createService("fixture-host-token", async () => {
        reads++;
        return { fetchedAt: 1, omitted: 0, accounts: [] };
      }),
    );
    for (const path of ["/health", "/snapshot"]) {
      expect((await fetch(origin + path)).status).toBe(401);
      expect(
        (await fetch(origin + path, { headers: { Authorization: "Bearer wrong-token" } })).status,
      ).toBe(401);
    }
    expect(reads).toBe(0);
    const headers = { Authorization: "Bearer fixture-host-token" };
    expect((await fetch(origin + "/health", { headers })).status).toBe(200);
    expect((await fetch(origin + "/snapshot?path=/secrets", { headers })).status).toBe(404);
    expect((await fetch(origin + "/snapshot", { headers, method: "POST" })).status).toBe(405);
    const responses = await Promise.all([
      fetch(origin + "/snapshot", { headers }),
      fetch(origin + "/snapshot", { headers }),
    ]);
    expect(await responses[0]?.json()).toEqual({ fetchedAt: 1, omitted: 0, accounts: [] });
    expect(reads).toBe(1);
  });
  it("does not disclose thrown messages", async () => {
    const origin = await listen(
      createService("fixture-host-token", async () => {
        throw new Error("private-canary");
      }),
    );
    const response = await fetch(origin + "/snapshot", {
      headers: { Authorization: "Bearer fixture-host-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream-unavailable" });
  });
  it("reads the fixed management endpoint with its key and sanitises the response", async () => {
    let received = "";
    const origin = await listen(
      createServer((req, res) => {
        received = `${req.method} ${req.url} ${req.headers.authorization}`;
        res.end(
          JSON.stringify({
            files: [
              { auth_index: "0123456789abcdef", provider: "codex", id_token: "private-canary" },
            ],
          }),
        );
      }),
    );
    const snapshot = await fetchSnapshot({ baseUrl: origin, managementKey: "test-management-key" });
    expect(received).toBe("GET /v0/management/auth-files Bearer test-management-key");
    expect(snapshot.accounts).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("private-canary");
  });
  it("never follows redirects with the management credential", async () => {
    let forwarded = false;
    const destination = await listen(
      createServer((_req, res) => {
        forwarded = true;
        res.end("{}");
      }),
    );
    const origin = await listen(
      createServer((_req, res) => {
        res.writeHead(302, { Location: destination });
        res.end();
      }),
    );
    await expect(fetchSnapshot({ baseUrl: origin, managementKey: "test" })).rejects.toThrow(
      "upstream-unavailable",
    );
    expect(forwarded).toBe(false);
  });
  it.each([401, 403, 500])("drops server error bodies for HTTP %i", async (status) => {
    const origin = await listen(
      createServer((_req, res) => {
        res.writeHead(status);
        res.end("private-canary");
      }),
    );
    await expect(fetchSnapshot({ baseUrl: origin, managementKey: "test" })).rejects.toThrow(
      status === 500 ? "upstream-unavailable" : "upstream-auth",
    );
  });
  it("bounds response bodies and rejects malformed JSON", async () => {
    const oversized = await listen(
      createServer((_req, res) => res.end("x".repeat(4 * 1024 * 1024 + 1))),
    );
    await expect(fetchSnapshot({ baseUrl: oversized, managementKey: "test" })).rejects.toThrow(
      "too-large",
    );
    const malformed = await listen(createServer((_req, res) => res.end("not-json-private-canary")));
    await expect(fetchSnapshot({ baseUrl: malformed, managementKey: "test" })).rejects.toThrow(
      "invalid-response",
    );
  });
  it("reads only explicit file configuration and rejects unsafe URL forms", async () => {
    const directory = await mkdtemp("/tmp/opencode/cpa-config-test-");
    const path = join(directory, "config.json");
    try {
      await expect(readConfig(path)).rejects.toThrow("setup");
      await writeFile(path, JSON.stringify({ managementKey: "fixture-key" }));
      expect(await readConfig(path)).toEqual({
        baseUrl: "http://cpa.nb",
        managementKey: "fixture-key",
      });
      for (const baseUrl of [
        "file:///etc/passwd",
        "http://user:pass@cpa.nb",
        "http://cpa.nb/path",
        "http://cpa.nb?key=bad",
        "http://cpa.nb#secret",
      ]) {
        await writeFile(path, JSON.stringify({ baseUrl, managementKey: "fixture-key" }));
        await expect(readConfig(path)).rejects.toThrow("setup");
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
