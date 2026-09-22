import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Model, Provider } from "@opencode/plugin";
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider";
import type { Config } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import plugin from "../src/index";
import { discover } from "../src/discovery";
import { applyConfig } from "../src/v1";
import { applyProviders } from "../src/v2";
import type { Diagnostic } from "../src/discovery";

const closers: Array<() => Promise<void>> = [];
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function editorFixture(initial: ProviderRecord[] = []) {
  const records = new Map(initial.map((record) => [record.provider.id, record]));
  const editor: ProviderEditor = {
    list: () => [...records.values()],
    get: (id) => records.get(Provider.ID.make(id)),
    add: ({ info, models }) => {
      records.set(info.id, {
        provider: info,
        models: new Map(models.map((model) => [model.id, model])),
      });
    },
    update: (id, update) => {
      const record = editor.get(id);
      if (!record) return;
      const draft = { ...record.provider };
      update(draft);
      records.set(draft.id, { ...record, provider: draft });
    },
    remove: (id) => {
      records.delete(Provider.ID.make(id));
    },
    models: {
      set: (id, models) => {
        const record = editor.get(id);
        if (record)
          records.set(record.provider.id, {
            ...record,
            models: new Map(models.map((model) => [model.id, model])),
          });
      },
      update: () => {
        throw new Error("Unexpected model update");
      },
      remove: () => {
        throw new Error("Unexpected model removal");
      },
    },
  };
  return editor;
}

describe("discovery", () => {
  it("fetches authenticated metadata, slash IDs and defaults once for V1, preserving manual fields", async () => {
    vi.stubEnv("DISCOVERY_TEST_KEY", "test-only-secret");
    const requests: string[] = [];
    const baseURL = await endpoint((request, response) => {
      requests.push(request.url ?? "");
      expect(request.headers.authorization).toBe("Bearer test-only-secret");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "org/coder",
              name: "Coder",
              context_length: 64000,
              max_output_tokens: 8192,
              supports_tools: false,
            },
            { id: "bare" },
            { id: "alias", max_context_length: 128000 },
          ],
        }),
      );
    });
    const hooks = await plugin.server(
      { client: createOpencodeClient({ baseUrl: baseURL }) },
      {
        sources: [{ id: "local", baseURL: `${baseURL}/v1/`, apiKeyEnv: "DISCOVERY_TEST_KEY" }],
      },
    );
    const config: Config = {
      theme: "manual",
      provider: {
        local: {
          name: "Manual provider",
          options: { timeout: 321 },
          models: {
            "org/coder": {
              name: "Manual coder",
              limit: { context: 96000, output: 1234 },
              tool_call: true,
              options: { temperature: 0.2 },
            },
            "manual-only": { name: "Retained" },
          },
        },
        unrelated: { name: "Unrelated" },
      },
    };
    await hooks.config?.(config);
    await hooks.config?.(config);
    expect(requests).toEqual(["/v1/models"]);
    expect(config.theme).toBe("manual");
    expect(config.provider?.unrelated).toEqual({ name: "Unrelated" });
    expect(config.provider?.local).toMatchObject({
      name: "Manual provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${baseURL}/v1/`, apiKey: "test-only-secret", timeout: 321 },
      models: {
        "org/coder": {
          name: "Manual coder",
          limit: { context: 96000, output: 1234 },
          tool_call: true,
          options: { temperature: 0.2 },
        },
        bare: { name: "bare", limit: { context: 32768, output: 4096 }, tool_call: true },
        alias: { limit: { context: 128000, output: 4096 } },
        "manual-only": { name: "Retained" },
      },
    });
    expect(config.provider?.local?.models?.bare).not.toHaveProperty("cost");
    expect(config.provider?.local?.models?.bare).not.toHaveProperty("reasoning");
  });

  it("registers V2 source definitions, retains manual models/settings and disposes its registration", async () => {
    const baseURL = await endpoint((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      response.end(
        JSON.stringify({
          data: [
            { id: "manual" },
            { id: "org/new", max_context_length: 75000, tool_call: false },
            { id: "bare" },
          ],
        }),
      );
    });
    const id = Provider.ID.make("local");
    const manual = {
      ...Model.Info.default(id, Model.ID.make("manual")),
      name: "Manual",
      enabled: false,
      limit: { context: 500, output: 100 },
    };
    const info = {
      ...Provider.Info.empty(id),
      name: "Custom",
      activation: "disabled",
      headers: { "x-test": "keep" },
      settings: { timeout: 123, baseURL: "http://manual.invalid/v1" },
    } satisfies Provider.Info;
    const editor = editorFixture([{ provider: info, models: new Map([[manual.id, manual]]) }]);
    const dispose = vi.fn(async () => {});
    const cleanup = await plugin.setup({
      options: {
        sources: [
          { id: "local", baseURL, defaults: { context: 16000, output: 2048, tools: false } },
          { id: "new", baseURL },
        ],
      },
      provider: {
        transform: async (transform) => {
          transform(editor);
          return { dispose };
        },
      },
    });
    expect(editor.get("local")?.provider).toEqual(info);
    expect(editor.get("local")?.models.get("manual")).toEqual(manual);
    expect(editor.get("local")?.models.get("org/new")).toMatchObject({
      name: "org/new",
      enabled: true,
      capabilities: { tools: false },
      limit: { context: 75000, output: 2048 },
      cost: [],
    });
    expect(editor.get("local")?.models.get("bare")).toMatchObject({
      capabilities: { tools: false },
      limit: { context: 16000, output: 2048 },
    });
    expect(editor.get("new")?.provider).toMatchObject({
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL },
    });
    expect(editor.get("new")?.models.get("bare")).toMatchObject({
      enabled: true,
      capabilities: { input: ["text"], output: ["text"], tools: true },
      limit: { context: 32768, output: 4096 },
      cost: [],
    });
    await cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(plugin.id).toBe("model-discovery");
    expect(typeof plugin.setup).toBe("function");
  });

  it("uses the environment fallback and gives explicit options precedence", async () => {
    const paths: string[] = [];
    const baseURL = await endpoint((request, response) => {
      paths.push(request.url ?? "");
      response.end('{"data":[{"id":"a"}]}');
    });
    vi.stubEnv(
      "OPENCODE_MODEL_DISCOVERY",
      JSON.stringify({ sources: [{ id: "env", baseURL, modelsURL: `${baseURL}/catalogue` }] }),
    );
    expect((await discover({}, () => {})).map((item) => item.source.id)).toEqual(["env"]);
    expect(await discover({ sources: [] }, () => {})).toEqual([]);
    expect(paths).toEqual(["/catalogue"]);
  });

  it("keeps failed V2 sources intact while adding authenticated healthy sources", async () => {
    vi.stubEnv("DISCOVERY_TEST_KEY", "test-only-secret");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseURL = await endpoint((request, response) => {
      if (request.url === "/failed") {
        response.writeHead(403);
        response.end("private response");
        return;
      }
      expect(request.headers.authorization).toBe("Bearer test-only-secret");
      response.end('{"data":[{"id":"new-model"}]}');
    });
    const id = Provider.ID.make("failed");
    const info = { ...Provider.Info.empty(id), name: "Keep me" };
    const old = Model.Info.default(id, Model.ID.make("old"));
    const original = { provider: info, models: new Map([[old.id, old]]) };
    const editor = editorFixture([original]);
    const cleanup = await plugin.setup({
      options: {
        sources: [
          { id: "failed", baseURL, modelsURL: `${baseURL}/failed` },
          { id: "healthy", baseURL, apiKeyEnv: "DISCOVERY_TEST_KEY" },
        ],
      },
      provider: {
        transform: async (transform) => {
          transform(editor);
          return { dispose: async () => {} };
        },
      },
    });
    expect(editor.get("failed")).toBe(original);
    expect(editor.get("healthy")?.provider.settings).toEqual({
      baseURL,
      apiKey: "test-only-secret",
    });
    expect([...(editor.get("healthy")?.models.keys() ?? [])]).toEqual(["new-model"]);
    expect(warnings).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toEqual({
      service: "model-discovery",
      message:
        "Model listing access was denied. Check listing credentials or configure explicit models if inference is permitted.",
      code: "authentication-error",
      sourceIndex: 0,
      status: 403,
    });
    await cleanup();
  });

  it("times out while reading a response body and accepts an empty catalogue", async () => {
    const baseURL = await endpoint((request, response) => {
      if (request.url === "/empty") {
        response.end('{"data":[]}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":[');
    });
    const diagnostics: Diagnostic[] = [];
    const result = await discover(
      {
        sources: [
          { id: "slow", baseURL, timeoutMs: 100 },
          { id: "empty", baseURL, modelsURL: `${baseURL}/empty` },
        ],
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );
    expect(result.map((item) => [item.source.id, item.models.size])).toEqual([["empty", 0]]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics).toContainEqual({ code: "invalid-response", sourceIndex: 0 });
    expect(diagnostics).toContainEqual({ code: "empty-catalogue", sourceIndex: 1 });
  });

  it("isolates HTTP, malformed JSON, invalid metadata, missing auth, redirect and timeout failures", async () => {
    const paths: string[] = [];
    const baseURL = await endpoint((request, response) => {
      paths.push(request.url ?? "");
      switch (request.url) {
        case "/http":
          response.writeHead(401);
          response.end("secret server detail");
          break;
        case "/json":
          response.end("secret invalid JSON");
          break;
        case "/metadata":
          response.end('{"data":[{"id":"valid"},{"id":"bad","context_length":0}]}');
          break;
        case "/redirect":
          response.writeHead(302, { location: "/leak" });
          response.end();
          break;
        case "/slow":
          break;
        default:
          response.end('{"data":[{"id":"ok"}]}');
      }
    });
    vi.stubEnv("DISCOVERY_MISSING_KEY", "");
    const diagnostics: Diagnostic[] = [];
    const result = await discover(
      {
        sources: [
          ...["http", "json", "metadata", "redirect", "slow", "ok"].map((id) => ({
            id,
            baseURL,
            modelsURL: `${baseURL}/${id}`,
            timeoutMs: 100,
          })),
          { id: "missing", baseURL, apiKeyEnv: "DISCOVERY_MISSING_KEY" },
        ],
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );
    expect(result.map((item) => item.source.id)).toEqual(["ok"]);
    expect(diagnostics).toHaveLength(6);
    expect(diagnostics).toContainEqual({
      code: "authentication-error",
      sourceIndex: 0,
      status: 401,
    });
    expect(diagnostics).toContainEqual({ code: "missing-api-key", sourceIndex: 6 });
    expect(paths).not.toContain("/leak");
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|127\.0\.0\.1|Bearer/);
  });

  it.each(["__proto__", "prototype", "constructor", "coder#q4", " coder"])(
    "rejects invalid model ID %s without a partial inventory",
    async (id) => {
      const baseURL = await endpoint((_request, response) =>
        response.end(JSON.stringify({ data: [{ id: "valid" }, { id }] })),
      );
      const diagnostics: Diagnostic[] = [];
      expect(
        await discover({ sources: [{ id: "local", baseURL }] }, (value) => diagnostics.push(value)),
      ).toEqual([]);
      expect(diagnostics).toEqual([{ code: "invalid-response", sourceIndex: 0 }]);
    },
  );

  it("rejects duplicate source/model IDs and invalid options with sanitised diagnostics", async () => {
    const baseURL = await endpoint((_request, response) =>
      response.end('{"data":[{"id":"same"},{"id":"same"}]}'),
    );
    for (const sources of [
      [
        { id: "same", baseURL },
        { id: "same", baseURL },
      ],
      [{ id: "__proto__", baseURL }],
      [{ id: "org/local", baseURL }],
      [{ id: "local#one", baseURL }],
      [{ id: "local", baseURL: "file:///secret" }],
      [{ id: "local", baseURL: "http://user:secret@example.com" }],
      [{ id: "local", baseURL, timeoutMs: 0 }],
      [{ id: "local", baseURL, discovery: "false" }],
      [{ id: "local", baseURL, models: ["same", { id: "same" }] }],
      ...["", "__proto__", "prototype", "constructor", "coder#q4", " coder"].map((id) => [
        { id: "local", baseURL, models: [id] },
      ]),
      ...[
        { id: "a", context: 0 },
        { id: "a", output: "100" },
        { id: "a", tools: null },
        { id: "a", name: "" },
        { id: "a", unknown: true },
      ].map((model) => [{ id: "local", baseURL, models: [model] }]),
    ]) {
      const diagnostics: Diagnostic[] = [];
      expect(await discover({ sources }, (value) => diagnostics.push(value))).toEqual([]);
      expect(diagnostics).toEqual([{ code: "invalid-options" }]);
    }
    expect(await discover({ sources: [{ id: "local", baseURL }] }, () => {})).toEqual([]);
    vi.stubEnv("OPENCODE_MODEL_DISCOVERY", "secret bad JSON");
    const diagnostics: Diagnostic[] = [];
    expect(await discover(undefined, (value) => diagnostics.push(value))).toEqual([]);
    expect(diagnostics).toEqual([{ code: "invalid-options" }]);
  });

  it("keeps slash-containing model IDs selectable through OpenCode's public reference parser", async () => {
    const baseURL = await endpoint((_request, response) =>
      response.end('{"data":[{"id":"org/coder"}]}'),
    );
    const inventories = await discover({ sources: [{ id: "local", baseURL }] }, () => {});
    const refs = inventories.flatMap((inventory) =>
      [...inventory.models.keys()].map((id) => Model.Ref.parse(`${inventory.source.id}/${id}`)),
    );
    expect(refs).toEqual([{ providerID: "local", id: "org/coder" }]);
  });

  it("preserves existing V1 providers on failure and sends only sanitised log data", async () => {
    const logs: unknown[] = [];
    const baseURL = await endpoint((request, response) => {
      if (request.url === "/log") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const value: unknown = JSON.parse(body);
          logs.push(value);
          response.end("true");
        });
      } else {
        response.writeHead(500);
        response.end("secret failure");
      }
    });
    const config: Config = {
      provider: { local: { name: "Unchanged", models: { old: { name: "Old" } } } },
    };
    const before = structuredClone(config);
    const hooks = await plugin.server(
      { client: createOpencodeClient({ baseUrl: baseURL }) },
      { sources: [{ id: "local", baseURL }] },
    );
    await hooks.config?.(config);
    expect(config).toEqual(before);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs).toEqual([
      {
        service: "model-discovery",
        level: "warn",
        message:
          "Model listing returned an HTTP error. Check listing access or configure explicit models.",
        extra: { code: "http-error", sourceIndex: 0, status: 500 },
      },
    ]);
  });

  it.each([404, 405, 501, 401, 403, 500])(
    "classifies HTTP %s and uses configured models only when supplied",
    async (status) => {
      const baseURL = await endpoint((_request, response) => {
        response.writeHead(status);
        response.end("private response detail");
      });
      const diagnostics: Diagnostic[] = [];
      const inventories = await discover(
        {
          sources: [
            { id: "bare", baseURL },
            {
              id: "configured",
              baseURL,
              models: [
                "org/manual",
                { id: "named", name: "Named", context: 12345, output: 1234, tools: false },
              ],
            },
          ],
        },
        (value) => diagnostics.push(value),
      );
      expect(inventories.map((item) => [item.source.id, [...item.models.values()]])).toEqual([
        [
          "configured",
          [
            { id: "org/manual", name: "org/manual" },
            { id: "named", name: "Named", context: 12345, output: 1234, tools: false },
          ],
        ],
      ]);
      const code = [404, 405, 501].includes(status)
        ? "discovery-unavailable"
        : [401, 403].includes(status)
          ? "authentication-error"
          : "http-error";
      expect(diagnostics).toEqual([
        { code, sourceIndex: 0, status },
        { code, sourceIndex: 1, status },
      ]);
    },
  );

  it.each(["bad JSON", '{"data":[{"id":"bad","supports_tools":null}]}', '{"data":[]}'])(
    "retains configured models for catalogue %s",
    async (body) => {
      const baseURL = await endpoint((_request, response) => response.end(body));
      const diagnostics: Diagnostic[] = [];
      const inventories = await discover(
        { sources: [{ id: "local", baseURL, models: ["manual"] }] },
        (value) => diagnostics.push(value),
      );
      expect(inventories.map((item) => [...item.models.values()])).toEqual([
        [{ id: "manual", name: "manual" }],
      ]);
      expect(diagnostics).toEqual([
        { code: body === '{"data":[]}' ? "empty-catalogue" : "invalid-response", sourceIndex: 0 },
      ]);
    },
  );

  it("skips HTTP with discovery disabled, keeps empty sources and still requires credentials", async () => {
    let requests = 0;
    const baseURL = await endpoint((_request, response) => {
      requests++;
      response.end("unexpected");
    });
    vi.stubEnv("DISCOVERY_MISSING_KEY", "");
    const diagnostics: Diagnostic[] = [];
    const inventories = await discover(
      {
        sources: [
          {
            id: "local",
            baseURL,
            discovery: false,
            models: ["manual", { id: "no-tools", tools: false }],
          },
          { id: "empty", baseURL, discovery: false },
          {
            id: "missing",
            baseURL,
            discovery: false,
            models: ["manual"],
            apiKeyEnv: "DISCOVERY_MISSING_KEY",
          },
        ],
      },
      (value) => diagnostics.push(value),
    );
    expect(requests).toBe(0);
    expect(inventories.map((item) => [item.source.id, [...item.models.keys()]])).toEqual([
      ["local", ["manual", "no-tools"]],
      ["empty", []],
    ]);
    expect(diagnostics).toEqual([{ code: "missing-api-key", sourceIndex: 2 }]);
    const config: Config = {
      disabled_providers: ["local"],
      provider: {
        local: { blacklist: ["manual"] },
        empty: { models: { native: { name: "Native" } } },
      },
    };
    applyConfig(config, inventories);
    expect(config.disabled_providers).toEqual(["local"]);
    expect(config.provider?.local?.blacklist).toEqual(["manual"]);
    expect(config.provider?.local?.models?.["no-tools"]?.tool_call).toBe(false);
    expect(config.provider?.empty?.models).toEqual({ native: { name: "Native" } });
    const editor = editorFixture();
    applyProviders(editor, inventories);
    expect(editor.get("empty")?.models.size).toBe(0);
    expect(editor.get("local")?.models.get("manual")?.enabled).toBe(true);
    expect(editor.get("local")?.models.get("no-tools")).toMatchObject({
      enabled: true,
      capabilities: { tools: false },
    });
  });

  it("merges configured metadata field by field without losing discovered fields or configured-only IDs", async () => {
    const baseURL = await endpoint((_request, response) =>
      response.end(
        JSON.stringify({
          data: [
            {
              id: "string",
              name: "Server name",
              context_length: 9000,
              max_output_tokens: 2000,
              supports_tools: false,
            },
            {
              id: "override",
              name: "Old",
              context_length: 8000,
              max_output_tokens: 1000,
              supports_tools: true,
            },
            { id: "discovered" },
          ],
        }),
      ),
    );
    const inventories = await discover(
      {
        sources: [
          {
            id: "local",
            baseURL,
            models: [
              "string",
              { id: "override", name: "New", output: 3000, tools: false },
              { id: "manual", context: 7000 },
            ],
          },
        ],
      },
      () => {},
    );
    expect(inventories.map((item) => [...item.models.values()])).toEqual([
      [
        { id: "string", name: "Server name", context: 9000, output: 2000, tools: false },
        { id: "override", name: "New", context: 8000, output: 3000, tools: false },
        { id: "discovered", name: "discovered" },
        { id: "manual", name: "manual", context: 7000 },
      ],
    ]);
    const editor = editorFixture();
    applyProviders(editor, inventories);
    expect(
      [...(editor.get("local")?.models.values() ?? [])].map((model) => [
        model.id,
        model.enabled,
        model.capabilities.tools,
      ]),
    ).toEqual([
      ["string", true, false],
      ["override", true, false],
      ["discovered", true, true],
      ["manual", true, true],
    ]);
  });
});
