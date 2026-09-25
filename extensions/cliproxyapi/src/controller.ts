import { parseSnapshot } from "./parser";
import {
  authIndexSchema,
  type Account,
  type Action,
  type ActionResult,
  type Snapshot,
} from "./snapshot";
import { context, readLive } from "./live";
import { providers } from "./providers";
import { LiveError, object, providerId, type PrivateAccount } from "./providers/shared";
import { management, Rejected, ServiceError, type Connection } from "./upstream";

export type Controller = ReturnType<typeof createController>;
export function createController(config: () => Promise<Connection>) {
  let cached: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;
  const versions = new Map<string, number>();
  const mutations = new Set<string>();
  const version = (id: string) => versions.get(id) ?? 0;
  const invalidate = (id: string) => versions.set(id, version(id) + 1);
  async function listing(connection: Connection, signal: AbortSignal) {
    const raw = await management(connection, "auth-files", { signal });
    let snapshot: Snapshot;
    try {
      snapshot = parseSnapshot(raw);
    } catch {
      throw new ServiceError("invalid-response");
    }
    const files = object(raw).files;
    const privateAccounts = new Map<string, PrivateAccount>();
    if (Array.isArray(files))
      for (const item of files) {
        const f = object(item);
        const id = authIndexSchema.safeParse(f.auth_index);
        if (!id.success || privateAccounts.has(id.data)) continue;
        privateAccounts.set(id.data, {
          authIndex: id.data,
          name: typeof f.name === "string" ? f.name : "",
          provider: providerId(f.provider),
          file: f,
        });
      }
    return { snapshot, privateAccounts };
  }
  async function update(
    connection: Connection,
    account: Account,
    privateAccount: PrivateAccount | undefined,
    signal: AbortSignal,
  ): Promise<Account> {
    const prior = cached?.accounts.find((a) => a.id === account.id);
    try {
      if (!privateAccount) throw new Error();
      account.live = await readLive(connection, privateAccount, signal);
    } catch (error) {
      account.live = {
        status: "error",
        attemptedAt: Date.now(),
        error:
          error instanceof LiveError
            ? error.message
            : "Live quota read failed; previous readings retained",
        observation: prior?.live?.observation ?? null,
        bank: prior?.live?.bank ?? null,
      };
    }
    account.actions = {
      status: Boolean(privateAccount?.name),
      refreshAuth: Boolean(privateAccount?.name),
      bankReset:
        Boolean(providers.get(account.provider)?.consumeReset) &&
        account.live.status === "fresh" &&
        (account.live.bank?.available ?? 0) > 0,
    };
    return account;
  }
  function bound(snapshot: Snapshot): Snapshot {
    while (Buffer.byteLength(JSON.stringify(snapshot)) > 240000 && snapshot.accounts.length) {
      snapshot.accounts.pop();
      snapshot.omitted++;
    }
    return snapshot;
  }
  async function load(): Promise<Snapshot> {
    const startedVersions = new Map(versions);
    const signal = AbortSignal.timeout(15000);
    const connection = await config();
    const { snapshot, privateAccounts } = await listing(connection, signal);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, snapshot.accounts.length) }, async () => {
        while (cursor < snapshot.accounts.length) {
          const account = snapshot.accounts[cursor++];
          if (!account) break;
          await update(connection, account, privateAccounts.get(account.id), signal);
        }
      }),
    );
    snapshot.accounts = snapshot.accounts.map((account) => {
      if (
        mutations.has(account.id) ||
        version(account.id) !== (startedVersions.get(account.id) ?? 0)
      )
        return cached?.accounts.find((a) => a.id === account.id) ?? account;
      return account;
    });
    cached = bound(snapshot);
    return cached;
  }
  function snapshot(force = false): Promise<Snapshot> {
    if (pending) return pending;
    if (!force && cached && Date.now() - cached.fetchedAt < 30000) return Promise.resolve(cached);
    pending = load().finally(() => {
      pending = null;
    });
    return pending;
  }
  async function action(request: Action): Promise<ActionResult> {
    const id = request.accountId;
    if (mutations.has(id))
      return { status: "busy", message: "An account action is already in progress" };
    mutations.add(id);
    invalidate(id);
    const signal = AbortSignal.timeout(15000);
    let submitted = false;
    let succeeded = false;
    try {
      const connection = await config();
      const current = await listing(connection, signal);
      const target = current.privateAccounts.get(id);
      if (!target?.name) return { status: "rejected", message: "Account is no longer available" };
      if (request.kind === "consume-reset") {
        const consume = providers.get(target.provider)?.consumeReset;
        if (!consume)
          return {
            status: "rejected",
            message: "Banked resets are not supported for this provider",
          };
        const live = await readLive(connection, target, signal);
        if ((live.bank?.available ?? 0) <= 0)
          return { status: "rejected", message: "No banked resets available" };
        submitted = true;
        await consume(context(connection, target, signal));
      } else {
        submitted = true;
        await management(
          connection,
          request.kind === "set-disabled" ? "auth-files/status" : "auth-files/refresh",
          {
            method: request.kind === "set-disabled" ? "PATCH" : "POST",
            body: {
              name: target.name,
              auth_index: id,
              ...(request.kind === "set-disabled" ? { disabled: request.disabled } : {}),
            },
            signal,
            discard: true,
          },
        );
      }
      succeeded = true;
      const refreshed = await listing(connection, signal);
      const account = refreshed.snapshot.accounts.find((a) => a.id === id);
      if (!account) throw new Error();
      await update(connection, account, refreshed.privateAccounts.get(id), signal);
      if (cached)
        cached = bound({
          ...cached,
          accounts: cached.accounts.map((a) => (a.id === id ? account : a)),
        });
      else
        cached = bound({
          ...refreshed.snapshot,
          fetchedAt: 0,
          accounts: refreshed.snapshot.accounts.map((a) => (a.id === id ? account : a)),
        });
      if (account.live?.status === "error") throw new Error();
      return {
        status: "success",
        message:
          request.kind === "consume-reset"
            ? "Banked reset consumed; quotas refreshed"
            : "Account updated; quotas refreshed",
      };
    } catch (error) {
      const account = cached?.accounts.find((a) => a.id === id);
      if (account?.live) {
        account.live = {
          ...account.live,
          status: "error",
          error: "Refresh required after account action",
        };
        if (account.actions) account.actions.bankReset = false;
      }
      if (succeeded)
        return {
          status: "success-refresh-failed",
          message:
            request.kind === "consume-reset"
              ? "Banked reset consumed. Quota refresh failed; refresh to check current usage."
              : "Account updated. Quota refresh failed; refresh to check current state.",
        };
      if (submitted && !(error instanceof Rejected))
        return {
          status: "uncertain",
          message:
            "Outcome uncertain. The request may have completed. Check current state before trying again; no automatic retry was made.",
        };
      return {
        status: "rejected",
        message: "Action rejected or unavailable; refresh account data before trying again",
      };
    } finally {
      invalidate(id);
      mutations.delete(id);
    }
  }
  return {
    snapshot,
    action,
    info: async () => ({
      managementUrl: new URL("/management.html", (await config()).baseUrl).href,
    }),
  };
}
