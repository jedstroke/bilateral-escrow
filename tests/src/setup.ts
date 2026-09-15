import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  CallData,
  Contract,
  RpcProvider,
  hash,
  json,
  logger,
  num,
  shortString,
  type Call,
  type CompiledSierra,
  type CompiledSierraCasm,
} from "starknet";

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(here, "../../contracts/target/dev");

// Devnet has no tip history, and starknet.js warns about it on every transaction.
logger.setLogLevel("ERROR");

export const BPS = 10_000n;

// Devnet mines instantly; the default 5s poll would make every test crawl.
const WAIT = { retryInterval: 250 };

export type Fees = { protection_bps: number; protocol_cut_bps: number };
export type Windows = {
  accept: number;
  ship: number;
  decision: number;
  return_ship: number;
  return_confirm: number;
};

export function loadArtifacts(): { sierra: CompiledSierra; casm: CompiledSierraCasm } {
  const base = path.join(TARGET, "bilateral_escrow_BilateralEscrow");
  const read = (suffix: string) => {
    const file = `${base}.${suffix}`;
    if (!fs.existsSync(file)) {
      throw new Error(`Missing ${file}. Run "scarb build" (or ./dev.ps1 build) first.`);
    }
    return json.parse(fs.readFileSync(file, "utf8"));
  };
  return { sierra: read("contract_class.json"), casm: read("compiled_contract_class.json") };
}

/** Calldata for the constructor, so it can be shown before it is sent. */
export function escrowConstructorCalldata(args: {
  owner: string;
  treasury: string;
  fees: Fees;
  windows: Windows;
}) {
  const { sierra } = loadArtifacts();
  return new CallData(sierra.abi).compile("constructor", args);
}

/** Class hash of the compiled contract, without touching the network. */
export function escrowClassHash(): string {
  return hash.computeContractClassHash(loadArtifacts().sierra);
}

export async function deployEscrow(
  admin: Account,
  args: { treasury: string; fees: Fees; windows: Windows },
): Promise<{ escrow: Contract; classHash: string; alreadyDeclared: boolean }> {
  const { sierra, casm } = loadArtifacts();
  const classHash = escrowClassHash();
  const alreadyDeclared = await admin.provider
    .getClassByHash(classHash)
    .then(() => true)
    .catch(() => false);

  const constructorCalldata = escrowConstructorCalldata({ owner: admin.address, ...args });
  // declareAndDeploy skips the declare when the class is already known, so this is
  // safe to re-run on a network where someone has deployed this contract before.
  const { deploy } = await admin.declareAndDeploy({ contract: sierra, casm, constructorCalldata });
  await admin.provider.waitForTransaction(deploy.transaction_hash, WAIT);

  const escrow = new Contract({
    abi: sierra.abi,
    address: deploy.contract_address,
    providerOrAccount: admin,
  });
  return { escrow, classHash, alreadyDeclared };
}

/** A `Contract` bound to a different signer. Same ABI and address. */
export function as(contract: Contract, account: Account): Contract {
  return new Contract({ abi: contract.abi, address: contract.address, providerOrAccount: account });
}

/** Handle for a predeployed ERC20. Pulls the ABI from the node so we never hardcode it. */
export async function erc20(provider: RpcProvider, address: string): Promise<Contract> {
  const { abi } = await provider.getClassAt(address);
  return new Contract({ abi, address, providerOrAccount: provider });
}

export async function balanceOf(token: Contract, owner: string): Promise<bigint> {
  const fn = token.abi.some((e: { name?: string }) => e.name === "balance_of") ? "balance_of" : "balanceOf";
  return BigInt((await token.call(fn, [owner])) as bigint);
}

/** Send calls from `account` and wait for them to land. Throws if the tx reverts. */
export async function send(account: Account, calls: Call | Call[]) {
  const { transaction_hash } = await account.execute(calls);
  const receipt = await account.provider.waitForTransaction(transaction_hash, WAIT);
  if (!receipt.isSuccess()) {
    throw new Error(`tx ${transaction_hash} did not succeed: ${JSON.stringify(receipt.value)}`);
  }
  return receipt;
}

/** Pull one event out of a receipt by its short name (ABI names are fully qualified). */
export function findEvent(contract: Contract, receipt: Awaited<ReturnType<typeof send>>, name: string) {
  const parsed = contract.parseEvents(receipt);
  for (const entry of parsed) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === name || key.endsWith(`::${name}`)) return value as Record<string, unknown>;
    }
  }
  throw new Error(`event ${name} not found in receipt`);
}

/** Cairo short string -> the felt it becomes, as hex. Useful for `outcome` fields. */
export function felt(text: string): bigint {
  return BigInt(shortString.encodeShortString(text));
}

/**
 * Assert a call reverts with a given Cairo short-string reason, e.g. 'ESC: bad state'.
 * starknet.js surfaces the reason either during fee estimation (RPC error) or in the
 * receipt; both paths carry the felt in hex and usually the decoded text too.
 */
export async function expectRevert(p: Promise<unknown>, reason: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (err === undefined) throw new Error(`expected revert '${reason}' but the call succeeded`);

  const hex = num.toHex(felt(reason)).toLowerCase();
  const seen = describeError(err).toLowerCase();
  const stripped = hex.replace(/^0x0*/, "");
  if (!seen.includes(reason.toLowerCase()) && !seen.includes(stripped)) {
    throw new Error(`expected revert '${reason}' (${hex}) but got:\n${describeError(err)}`);
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const extra = (e as { baseError?: unknown }).baseError;
    return `${e.message}\n${extra ? JSON.stringify(extra) : ""}`;
  }
  return JSON.stringify(e);
}
