import { Account, RpcProvider } from "starknet";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:5050/rpc";

/** Fee tokens devnet predeploys at the same addresses as mainnet. */
export const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
export const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

type PredeployedAccount = {
  address: string;
  private_key: string;
  public_key: string;
};

/** Raw call to one of devnet's own `devnet_*` methods. */
export async function devnetRpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Block until devnet answers. Docker compose starts it in parallel with the tests. */
export async function waitForDevnet(timeoutMs = 120_000): Promise<void> {
  const aliveUrl = RPC_URL.replace(/\/rpc\/?$/, "") + "/is_alive";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(aliveUrl);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`devnet did not come up at ${RPC_URL} within ${timeoutMs / 1000}s`);
}

export async function connect(): Promise<{ provider: RpcProvider; accounts: Account[] }> {
  await waitForDevnet();
  const provider = await RpcProvider.create({ nodeUrl: RPC_URL });
  const raw = await devnetRpc<PredeployedAccount[]>("devnet_getPredeployedAccounts");
  const accounts = raw.map(
    (a) => new Account({ provider, address: a.address, signer: a.private_key }),
  );
  return { provider, accounts };
}

/** Move devnet's clock forward. Mines a block at the new time. */
export async function increaseTime(seconds: number | bigint): Promise<void> {
  await devnetRpc("devnet_increaseTime", { time: Number(seconds) });
}
