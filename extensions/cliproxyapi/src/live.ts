import type { Account } from "./snapshot";
import { providers } from "./providers";
import type { PrivateAccount, ProviderContext } from "./providers/shared";
import { apiCall, management, type Connection } from "./upstream";

export function context(
  config: Connection,
  account: PrivateAccount,
  signal: AbortSignal,
): ProviderContext {
  return {
    account,
    call: (request, consume) =>
      apiCall(config, { authIndex: account.authIndex, ...request }, signal, consume),
    download: () =>
      management(config, `auth-files/download?name=${encodeURIComponent(account.name)}`, {
        signal,
      }),
  };
}

export async function readLive(
  config: Connection,
  account: PrivateAccount,
  signal: AbortSignal,
): Promise<NonNullable<Account["live"]>> {
  const attemptedAt = Date.now();
  const provider = providers[account.provider];
  if (!provider)
    return { status: "unsupported", attemptedAt, error: null, observation: null, bank: null };
  const { observation, bank } = await provider.read(context(config, account, signal));
  return { status: "fresh", attemptedAt, error: null, observation, bank: bank ?? null };
}
