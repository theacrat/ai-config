export {};
const build = await Bun.build({
  entrypoints: ["scripts/fixture.ts"],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!build.success || !build.outputs[0]) throw new Error("Fixture build failed");
const script = await build.outputs[0].text();
const page = `<!doctype html><html><head><meta charset="utf-8"><title>CPA SDK fixture</title></head><body style="font:14px system-ui;background:#ddd;padding:16px"><h1>CPA SDK fixture</h1><p>Synthetic data only. Actual SDK hello, ready and service-request messages.</p><nav><button data-mode="success">Success</button> <button data-mode="partial">Partial quota failure</button> <button data-mode="action-refresh-failed">Action succeeds, refresh fails</button> <button data-mode="uncertain">Uncertain action</button> <button data-mode="rejected">Rejected action</button> <button data-mode="error">Refresh failure</button> <button data-mode="setup">Setup error</button> <button data-mode="disconnected">Service disconnected</button> <button data-mode="empty">Empty</button> <button id="theme">Toggle theme</button> <button id="width">Toggle width</button></nav><p id="mode">Next response: success</p><p id="requests">Snapshot requests: 0</p><iframe title="CLIProxyAPI panel" sandbox="allow-scripts" style="width:360px;height:850px;border:1px solid #aaa"></iframe><script src="/fixture.js"></script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2] ?? 4318),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(page, { headers: { "Content-Type": "text/html" } });
    if (path === "/fixture.js")
      return new Response(script, {
        headers: { "Content-Type": "text/javascript" },
      });
    if (["/panel/index.html", "/panel/main.js", "/panel/style.css"].includes(path))
      return new Response(Bun.file(`.${path}`));
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Synthetic SDK fixture: http://127.0.0.1:${server.port}`);
