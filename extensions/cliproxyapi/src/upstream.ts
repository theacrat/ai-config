import { z } from "zod";

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
export class Rejected extends Error {}
export type Connection = { baseUrl: string; managementKey: string };
export async function management(
  config: Connection,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    discard?: boolean;
    timeout?: number;
  } = {},
): Promise<unknown> {
  const response = await fetch(new URL(`/v0/management/${path}`, config.baseUrl), {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.managementKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "error",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 3500)])
      : AbortSignal.timeout(8000),
  }).catch(() => {
    throw new ServiceError("upstream-unavailable");
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (
      options.method &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      throw new Rejected();
    throw new ServiceError(
      response.status === 401 || response.status === 403 ? "upstream-auth" : "upstream-unavailable",
    );
  }
  if (options.discard) {
    await response.body?.cancel();
    return null;
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid-response");
  }
}
export type CallOptions = { consume?: boolean; timeout?: number };
const envelope = z.object({ status_code: z.number().int(), body: z.string() });
export async function apiCall(
  config: Connection,
  request: {
    authIndex: string;
    method: "GET" | "POST";
    url: string;
    header: Record<string, string>;
    data?: string;
  },
  signal: AbortSignal,
  { consume = false, timeout }: CallOptions = {},
): Promise<unknown> {
  const result = envelope.parse(
    await management(config, "api-call", { method: "POST", body: request, signal, timeout }),
  );
  if (result.status_code < 200 || result.status_code >= 300) {
    if (result.status_code >= 400 && result.status_code < 500 && result.status_code !== 408)
      throw new Rejected();
    throw new ServiceError("upstream-unavailable");
  }
  if (consume) return null;
  try {
    return JSON.parse(result.body);
  } catch {
    throw new ServiceError("invalid-response");
  }
}
