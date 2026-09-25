import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { providers } from "../src/providers";
import { snapshotSchema, hasQuotaSignals } from "../src/snapshot";

const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("No local port");
const port = address.port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const token = randomBytes(32).toString("hex");
const child = spawn("node", ["service/main.js"], {
  stdio: "ignore",
  env: {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
  },
});
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}` };
let spawnFailed = false;
child.on("error", () => {
  spawnFailed = true;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnFailed || child.exitCode !== null) break;
    try {
      ready =
        (
          await fetch(`${base}/health`, {
            headers,
            signal: AbortSignal.timeout(500),
          })
        ).status === 200;
    } catch {
      /* Startup may still be binding. */
    }
    if (ready) break;
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("service-start-failed");
  if (
    (await fetch(`${base}/health`)).status !== 401 ||
    (await fetch(`${base}/snapshot`)).status !== 401
  )
    throw new Error("service-auth-failed");
  const response = await fetch(`${base}/snapshot`, {
    headers,
    signal: AbortSignal.timeout(18000),
  });
  if (response.status !== 200) {
    const body: unknown = await response.json();
    const code =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      ["setup", "upstream-auth", "upstream-unavailable", "invalid-response", "too-large"].includes(
        body.error,
      )
        ? body.error
        : "snapshot-failed";
    throw new Error(code);
  }
  const snapshot = snapshotSchema.parse(await response.json());
  if (snapshot.accounts.some((a) => providers.has(a.provider) && a.live?.status !== "fresh"))
    throw new Error("live-quota-failed");
  console.log(
    JSON.stringify(
      {
        result: "verified",
        runtime: "node",
        serviceAuth: "passed",
        accounts: snapshot.accounts.length,
        omitted: snapshot.omitted,
        providerCount: new Set(snapshot.accounts.map((a) => a.provider)).size,
        liveFresh: snapshot.accounts.filter((a) => a.live?.status === "fresh").length,
        liveFailed: snapshot.accounts.filter((a) => a.live?.status === "error").length,
        freshByProvider: Object.fromEntries(
          [...providers.keys()].map((id) => [
            id,
            snapshot.accounts.filter((a) => a.provider === id && a.live?.status === "fresh").length,
          ]),
        ),
        liveWindows: snapshot.accounts.reduce(
          (sum, a) => sum + (a.live?.observation?.windows.length ?? 0),
          0,
        ),
        bankCountsKnown: snapshot.accounts.filter(
          (a) => a.live?.bank?.available !== null && a.live?.bank?.available !== undefined,
        ).length,
        accountWindows: snapshot.accounts.reduce((sum, a) => sum + a.observation.windows.length, 0),
        modelObservations: snapshot.accounts.reduce((sum, a) => sum + a.models.length, 0),
        unknownQuotas: snapshot.accounts.filter((a) => !hasQuotaSignals(a.observation)).length,
        unavailable: snapshot.accounts.filter((a) => a.unavailable).length,
        disabled: snapshot.accounts.filter((a) => a.disabled).length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const safe =
    error instanceof Error &&
    [
      "service-start-failed",
      "service-auth-failed",
      "setup",
      "upstream-auth",
      "upstream-unavailable",
      "invalid-response",
      "too-large",
      "snapshot-failed",
      "live-quota-failed",
    ].includes(error.message)
      ? error.message
      : "verification-failed";
  console.log(JSON.stringify({ result: "not-verified", reason: safe }));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
