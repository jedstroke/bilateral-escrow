/**
 * Deploy the escrow and allow a list of tokens.
 *
 * Devnet (default): uses predeployed account #0 as admin and #3 as treasury, allows ETH.
 * Any other network: set RPC_URL, ACCOUNT_ADDRESS, PRIVATE_KEY, TREASURY and TOKENS
 * (comma-separated token addresses).
 */
import fs from "node:fs";
import { Account, RpcProvider } from "starknet";
import { ETH, RPC_URL, connect } from "../src/devnet";
import { deployEscrow, send } from "../src/setup";

const DAY = 86_400;

async function main() {
  let admin: Account;
  let treasury: string;

  if (process.env.ACCOUNT_ADDRESS && process.env.PRIVATE_KEY) {
    const provider = await RpcProvider.create({ nodeUrl: RPC_URL });
    admin = new Account({ provider, address: process.env.ACCOUNT_ADDRESS, signer: process.env.PRIVATE_KEY });
    treasury = process.env.TREASURY ?? admin.address;
  } else {
    const { accounts } = await connect();
    admin = accounts[0];
    treasury = accounts[3]?.address ?? admin.address;
  }

  const tokens = (process.env.TOKENS ?? ETH).split(",").map((t) => t.trim()).filter(Boolean);

  const escrow = await deployEscrow(admin, {
    treasury,
    fees: { protection_bps: 500, protocol_cut_bps: 2000 },
    windows: { accept: 2 * DAY, ship: 3 * DAY, decision: 7 * DAY, return_ship: 7 * DAY, return_confirm: 3 * DAY },
  });

  for (const token of tokens) {
    await send(admin, escrow.populate("set_token_allowed", { token, allowed: true }));
  }

  const out = { rpcUrl: RPC_URL, escrow: escrow.address, admin: admin.address, treasury, tokens };
  fs.writeFileSync(new URL("../deployment.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
