/**
 * Deploy the escrow and allow a list of tokens.
 *
 * Devnet (the default): uses predeployed account #0 as admin and #3 as treasury, allows ETH.
 *
 * Any other network: set RPC_URL, ACCOUNT_ADDRESS and PRIVATE_KEY, plus TREASURY and TOKENS.
 * Nothing is sent until you pass CONFIRM=yes - without it the script prints the plan and stops.
 *
 * Optional overrides (all have defaults, all are in the printed plan):
 *   PROTECTION_BPS  fee charged on the price, in basis points          default 500  (5%)
 *   PROTOCOL_CUT_BPS  share of that fee kept by the treasury           default 2000 (20%)
 *   ACCEPT_DAYS SHIP_DAYS DECISION_DAYS RETURN_DAYS CONFIRM_DAYS       default 2 3 7 7 3
 *
 * The result is written to deployments/<network>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Contract, RpcProvider, shortString } from "starknet";
import { ETH, RPC_URL, connect } from "../src/devnet";
import { deployEscrow, escrowClassHash, send, type Fees, type Windows } from "../src/setup";

const DAY = 86_400;
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deployments");

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const FEES: Fees = {
  protection_bps: num("PROTECTION_BPS", 500),
  protocol_cut_bps: num("PROTOCOL_CUT_BPS", 2000),
};
const WINDOWS: Windows = {
  accept: num("ACCEPT_DAYS", 2) * DAY,
  ship: num("SHIP_DAYS", 3) * DAY,
  decision: num("DECISION_DAYS", 7) * DAY,
  return_ship: num("RETURN_DAYS", 7) * DAY,
  return_confirm: num("CONFIRM_DAYS", 3) * DAY,
};

const NETWORKS: Record<string, string> = {
  [shortString.encodeShortString("SN_MAIN")]: "mainnet",
  [shortString.encodeShortString("SN_SEPOLIA")]: "sepolia",
};

function die(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Fail loudly on a mistyped token address instead of allow-listing nothing. */
async function describeToken(provider: RpcProvider, address: string) {
  let contract: Contract;
  try {
    const { abi } = await provider.getClassAt(address);
    contract = new Contract({ abi, address, providerOrAccount: provider });
  } catch {
    die(`No contract found at token address ${address}. Check TOKENS.`);
  }
  try {
    const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);
    const text = typeof symbol === "bigint" ? shortString.decodeShortString(`0x${symbol.toString(16)}`) : symbol;
    return `${address}  (${text}, ${decimals} decimals)`;
  } catch {
    die(`Contract at ${address} does not answer symbol()/decimals(). Is it an ERC20?`);
  }
}

async function main() {
  const usingDevnet = !process.env.ACCOUNT_ADDRESS && !process.env.PRIVATE_KEY;

  let provider: RpcProvider;
  let admin: Account;
  let treasury: string;

  if (usingDevnet) {
    const conn = await connect();
    provider = conn.provider;
    admin = conn.accounts[0];
    treasury = process.env.TREASURY ?? conn.accounts[3]?.address ?? admin.address;
  } else {
    if (!process.env.ACCOUNT_ADDRESS || !process.env.PRIVATE_KEY) {
      die("Set both ACCOUNT_ADDRESS and PRIVATE_KEY, or neither (to use devnet).");
    }
    provider = await RpcProvider.create({ nodeUrl: RPC_URL });
    admin = new Account({
      provider,
      address: process.env.ACCOUNT_ADDRESS,
      signer: process.env.PRIVATE_KEY,
    });
    treasury = process.env.TREASURY ?? die("Set TREASURY to the address that collects the protocol fee.");
  }

  const chainId = await provider.getChainId();
  // Devnet reports SN_SEPOLIA as its chain id, so the devnet check has to come first.
  const network = usingDevnet ? "devnet" : (NETWORKS[chainId] ?? `chain-${chainId}`);
  const tokens = (process.env.TOKENS ?? (usingDevnet ? ETH : "")).split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) die("Set TOKENS to a comma-separated list of ERC20 addresses to accept.");

  const described = [];
  for (const token of tokens) described.push(await describeToken(provider, token));

  console.log(`
  network     ${network}  (${chainId})
  rpc         ${RPC_URL}
  admin       ${admin.address}
  treasury    ${treasury}
  class hash  ${escrowClassHash()}

  protection fee   ${FEES.protection_bps / 100}% of the price
  treasury cut     ${FEES.protocol_cut_bps / 100}% of that fee
  windows          accept ${WINDOWS.accept / DAY}d, ship ${WINDOWS.ship / DAY}d, decide ${WINDOWS.decision / DAY}d, return ${WINDOWS.return_ship / DAY}d, confirm ${WINDOWS.return_confirm / DAY}d

  tokens
    ${described.join("\n    ")}
`);

  if (!usingDevnet && process.env.CONFIRM !== "yes") {
    console.log("  Nothing sent. Re-run with CONFIRM=yes to deploy.\n");
    return;
  }

  const { escrow, classHash, alreadyDeclared } = await deployEscrow(admin, { treasury, fees: FEES, windows: WINDOWS });
  console.log(`  ${alreadyDeclared ? "class already declared" : "declared"} ${classHash}`);
  console.log(`  deployed at ${escrow.address}`);

  for (const token of tokens) {
    await send(admin, escrow.populate("set_token_allowed", { token, allowed: true }));
    console.log(`  allowed ${token}`);
  }

  const record = {
    network,
    chainId,
    rpcUrl: RPC_URL,
    escrow: escrow.address,
    classHash,
    admin: admin.address,
    treasury,
    tokens,
    fees: FEES,
    windows: WINDOWS,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${network}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n  written to ${path.relative(process.cwd(), file)}\n`);

  if (!usingDevnet) {
    console.log("  Next: hand ownership to your multisig with transfer_ownership, then have");
    console.log("  the multisig call accept_ownership. Until it does, this key is the admin.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
