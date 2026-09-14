/**
 * Talk to the local devnet without any dependencies. Node 22's built-in fetch is all it needs,
 * so this works from a fresh clone before anything is installed.
 *
 *   node scripts/devnet.mjs accounts          list predeployed accounts, keys and balances
 *   node scripts/devnet.mjs balance <addr>    balance of any address
 *   node scripts/devnet.mjs mint <addr> [n]   give an address tokens (default 10 STRK and 10 ETH)
 *   node scripts/devnet.mjs status            chain id, block count, RPC and UI URLs
 */

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:5050/rpc";
const BASE = RPC.replace(/\/rpc\/?$/, "");

// Which predeployed account each role in the tests uses.
const ROLES = ["admin", "customer", "merchant", "treasury", "stranger"];

const TOKENS = {
  ETH: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
};

async function rpc(method, params = {}) {
  let res;
  try {
    res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    fail(`Can't reach devnet at ${RPC}. Start it with: npm run up`);
  }
  const body = await res.json();
  if (body.error) fail(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 18-decimal amount as a readable number. */
function human(wei) {
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

async function accounts() {
  const list = await rpc("devnet_getPredeployedAccounts", { with_balance: true });
  const config = await rpc("devnet_getConfig");

  console.log(`\nRPC        ${RPC}`);
  console.log(`Chain id   ${config.chain_id ?? "SN_SEPOLIA"}`);
  console.log(`Explorer   ${BASE}/ui`);
  console.log(`\nFee tokens`);
  console.log(`  ETH   ${TOKENS.ETH}`);
  console.log(`  STRK  ${TOKENS.STRK}`);
  console.log(`\nPredeployed accounts (seed 0, so these are the same every restart)\n`);

  list.forEach((a, i) => {
    const role = ROLES[i] ? `  <- tests use this as the ${ROLES[i]}` : "";
    console.log(`#${i}${role}`);
    console.log(`  address      ${a.address}`);
    console.log(`  private key  ${a.private_key}`);
    if (a.balance) {
      console.log(`  balance      ${human(a.balance.eth.amount)} ETH / ${human(a.balance.strk.amount)} STRK`);
    }
    console.log();
  });

  console.log("These keys are public and worthless. Never reuse them on a real network.\n");
}

async function balance(address) {
  if (!address) fail("usage: npm run balance -- 0xYourAddress");
  const eth = await rpc("devnet_getAccountBalance", { address, unit: "WEI" });
  const strk = await rpc("devnet_getAccountBalance", { address, unit: "FRI" });
  console.log(`${address}\n  ${human(eth.amount)} ETH\n  ${human(strk.amount)} STRK`);
}

async function mint(address, amount) {
  if (!address) fail("usage: npm run mint -- 0xYourAddress [amount]");
  const value = BigInt(amount ?? 10) * 10n ** 18n;
  for (const unit of ["WEI", "FRI"]) {
    const res = await rpc("devnet_mint", { address, amount: Number(value), unit });
    console.log(`${unit === "WEI" ? "ETH " : "STRK"}  new balance ${human(res.new_balance)}  (tx ${res.tx_hash})`);
  }
}

async function status() {
  const s = await rpc("devnet_getStatus");
  const config = await rpc("devnet_getConfig");
  console.log(`RPC        ${RPC}`);
  console.log(`Explorer   ${BASE}/ui`);
  console.log(`Chain id   ${config.chain_id ?? "SN_SEPOLIA"}`);
  console.log(`Blocks     ${s.blocks_count ?? s.block_count ?? "?"}`);
  console.log(`Txs        ${s.transactions_count ?? s.transaction_count ?? "?"}`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { accounts, balance, mint, status };

if (!commands[command]) {
  fail(`usage: node scripts/devnet.mjs <${Object.keys(commands).join(" | ")}> [args]`);
}
await commands[command](...args);
