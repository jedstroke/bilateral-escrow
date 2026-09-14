import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Account, CairoCustomEnum, Contract, RpcProvider } from "starknet";
import { ETH, STRK, connect, increaseTime } from "./devnet";
import {
  BPS,
  as,
  balanceOf,
  deployEscrow,
  erc20,
  expectRevert,
  felt,
  findEvent,
  send,
  type Fees,
  type Windows,
} from "./setup";

const DAY = 86_400;
const WINDOWS: Windows = {
  accept: 1 * DAY,
  ship: 2 * DAY,
  decision: 7 * DAY,
  return_ship: 7 * DAY,
  return_confirm: 3 * DAY,
};
const FEES: Fees = { protection_bps: 500, protocol_cut_bps: 2000 }; // 5% fee, 20% of it to treasury

const PRICE = 10n ** 18n; // 1 ETH
const BOND = 10n ** 17n; // 0.1 ETH
const FEE = (PRICE * 500n) / BPS; // 0.05 ETH
const TREASURY_SHARE = (FEE * 2000n) / BPS; // 0.01 ETH
const MERCHANT_SHARE = FEE - TREASURY_SHARE; // 0.04 ETH

const LISTING = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/listing.json";
const SHIPPED = "ipfs://bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly/tags.json";
const RETURNED = "ipfs://bafybeif5ub2qnr7ohw7vszjbs5xjkxdj7hnzmflhcfhs3lvbkqrlggx4wm/return.json";

let provider: RpcProvider;
let admin: Account;
let customer: Account;
let merchant: Account;
let treasury: Account;
let stranger: Account;
let escrow: Contract;
let eth: Contract;

// ---------------------------------------------------------------- helpers

const stateOf = (deal: { state: CairoCustomEnum }) => deal.state.activeVariant();
const credit = async (who: string) => BigInt(await escrow.get_balance(who, ETH));
const deal = async (id: bigint) => escrow.get_deal(id);

async function createDeal(opts: { token?: string; price?: bigint; merchant?: string } = {}) {
  const price = opts.price ?? PRICE;
  const fee = (price * BigInt(FEES.protection_bps)) / BPS;
  const receipt = await send(customer, [
    eth.populate("approve", { spender: escrow.address, amount: price + fee }),
    escrow.populate("create_deal", {
      merchant: opts.merchant ?? merchant.address,
      token: opts.token ?? ETH,
      price,
      return_bond: BOND,
      metadata: LISTING,
    }),
  ]);
  return { id: BigInt(findEvent(escrow, receipt, "DealCreated").deal_id as bigint), receipt };
}

async function acceptDeal(id: bigint) {
  return send(merchant, [
    eth.populate("approve", { spender: escrow.address, amount: BOND }),
    escrow.populate("accept_deal", { deal_id: id }),
  ]);
}

async function markShipped(id: bigint) {
  return send(merchant, escrow.populate("mark_shipped", { deal_id: id, evidence: SHIPPED }));
}

async function shippedDeal() {
  const { id } = await createDeal();
  await acceptDeal(id);
  await markShipped(id);
  return id;
}

async function rejectGoods(id: bigint) {
  return send(customer, escrow.populate("reject_goods", { deal_id: id, reason: "wrong size" }));
}

/** Withdraw everything `account` is owed in ETH and return how much actually arrived. */
async function withdraw(account: Account) {
  const before = await balanceOf(eth, account.address);
  await send(account, escrow.populate("withdraw", { token: ETH }));
  return (await balanceOf(eth, account.address)) - before;
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  const conn = await connect();
  provider = conn.provider;
  [admin, customer, merchant, treasury, stranger] = conn.accounts;
  if (!stranger) throw new Error("need at least 5 predeployed accounts (start devnet with --accounts 5)");

  eth = await erc20(provider, ETH);
  escrow = await deployEscrow(admin, { treasury: treasury.address, fees: FEES, windows: WINDOWS });
  await send(admin, escrow.populate("set_token_allowed", { token: ETH, allowed: true }));
});

// Start every test with empty credit balances, so `withdraw()` returns exactly what that test earned.
afterEach(async () => {
  for (const a of [admin, customer, merchant, treasury, stranger]) {
    if ((await credit(a.address)) > 0n) await withdraw(a);
  }
});

// ---------------------------------------------------------------- tests

describe("deployment and admin", () => {
  it("stores the constructor settings", async () => {
    expect(await escrow.owner()).toBe(BigInt(admin.address));
    expect(await escrow.get_treasury()).toBe(BigInt(treasury.address));
    const fees = await escrow.get_fees();
    expect(fees.protection_bps).toBe(500n);
    expect(fees.protocol_cut_bps).toBe(2000n);
    expect(await escrow.is_token_allowed(ETH)).toBe(true);
    expect(await escrow.is_token_allowed(STRK)).toBe(false);
    expect(await escrow.quote_protection_fee(PRICE)).toBe(FEE);
  });

  it("only the owner can change settings", async () => {
    const s = as(escrow, stranger);
    await expectRevert(send(stranger, s.populate("set_token_allowed", { token: STRK, allowed: true })), "Caller is not the owner");
    await expectRevert(send(stranger, s.populate("pause", {})), "Caller is not the owner");
    await expectRevert(send(stranger, s.populate("set_fees", { fees: FEES })), "Caller is not the owner");
  });

  it("rejects bad settings", async () => {
    await expectRevert(
      send(admin, escrow.populate("set_fees", { fees: { protection_bps: 10_001, protocol_cut_bps: 0 } })),
      "ESC: bps > 10000",
    );
    await expectRevert(
      send(admin, escrow.populate("set_windows", { windows: { ...WINDOWS, ship: 0 } })),
      "ESC: zero window",
    );
  });
});

describe("creating a deal", () => {
  it("refuses tokens the admin has not allowed", async () => {
    await expectRevert(createDeal({ token: STRK }), "ESC: token not allowed");
  });

  it("refuses a zero price and a self-deal", async () => {
    await expectRevert(createDeal({ price: 0n }), "ESC: zero price");
    await expectRevert(createDeal({ merchant: customer.address }), "ESC: self deal");
  });

  it("locks price + protection fee and records the deal", async () => {
    const before = await balanceOf(eth, customer.address);
    const escrowBefore = await balanceOf(eth, escrow.address);

    const { id, receipt } = await createDeal();

    expect(before - (await balanceOf(eth, customer.address))).toBe(PRICE + FEE);
    expect((await balanceOf(eth, escrow.address)) - escrowBefore).toBe(PRICE + FEE);

    const d = await deal(id);
    expect(stateOf(d)).toBe("Created");
    expect(d.customer).toBe(BigInt(customer.address));
    expect(d.merchant).toBe(BigInt(merchant.address));
    expect(d.price).toBe(PRICE);
    expect(d.protection_fee).toBe(FEE);
    expect(d.return_bond).toBe(BOND);
    expect(d.deadline).toBe(d.created_at + BigInt(WINDOWS.accept));
    expect(await escrow.get_metadata(id)).toBe(LISTING);

    const ev = findEvent(escrow, receipt, "DealCreated");
    expect(ev.price).toBe(PRICE);
    expect(ev.metadata).toBe(LISTING);
  });

  it("is blocked while paused", async () => {
    await send(admin, escrow.populate("pause", {}));
    await expectRevert(createDeal(), "Pausable: paused");
    await send(admin, escrow.populate("unpause", {}));
    await createDeal();
  });
});

describe("before the merchant accepts", () => {
  it("customer can cancel and pull the money back", async () => {
    const { id } = await createDeal();
    await expectRevert(send(merchant, escrow.populate("cancel_deal", { deal_id: id })), "ESC: not customer");

    await send(customer, escrow.populate("cancel_deal", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Cancelled");
    expect(await credit(customer.address)).toBe(PRICE + FEE);
    expect(await withdraw(customer)).toBe(PRICE + FEE);

    // nothing left, and the merchant is locked out
    await expectRevert(send(customer, escrow.populate("withdraw", { token: ETH })), "ESC: nothing to withdraw");
    await expectRevert(acceptDeal(id), "ESC: bad state");
  });

  it("a stale deal can be closed by anyone once the accept window passes", async () => {
    const { id } = await createDeal();
    await expectRevert(send(stranger, escrow.populate("claim_timeout", { deal_id: id })), "ESC: deadline not passed");

    await increaseTime(WINDOWS.accept + 60);
    await expectRevert(acceptDeal(id), "ESC: deadline passed");

    await send(stranger, escrow.populate("claim_timeout", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Cancelled");
    expect(await withdraw(customer)).toBe(PRICE + FEE);
  });
});

describe("accepting and shipping", () => {
  it("only the named merchant can accept, and it costs the bond", async () => {
    const { id } = await createDeal();
    await expectRevert(send(stranger, escrow.populate("accept_deal", { deal_id: id })), "ESC: not merchant");

    const before = await balanceOf(eth, merchant.address);
    await acceptDeal(id);
    expect(before - (await balanceOf(eth, merchant.address))).toBe(BOND);

    const d = await deal(id);
    expect(stateOf(d)).toBe("Accepted");
    expect(d.deadline).toBeGreaterThan(d.created_at);

    // customer can no longer just cancel
    await expectRevert(send(customer, escrow.populate("cancel_deal", { deal_id: id })), "ESC: bad state");
  });

  it("merchant who backs out forfeits the bond to the customer", async () => {
    const { id } = await createDeal();
    await acceptDeal(id);
    const receipt = await send(merchant, escrow.populate("back_out", { deal_id: id }));

    expect(stateOf(await deal(id))).toBe("Cancelled");
    const settled = findEvent(escrow, receipt, "DealSettled");
    expect(settled.outcome).toBe(felt("merchant_backed_out"));
    expect(await withdraw(customer)).toBe(PRICE + FEE + BOND);
  });

  it("merchant who never ships loses the bond to the customer", async () => {
    const { id } = await createDeal();
    await acceptDeal(id);
    await increaseTime(WINDOWS.ship + 60);
    await expectRevert(markShipped(id), "ESC: deadline passed");

    await send(stranger, escrow.populate("claim_timeout", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Cancelled");
    expect(await withdraw(customer)).toBe(PRICE + FEE + BOND);
  });

  it("shipping stores the evidence and starts the decision clock", async () => {
    const { id } = await createDeal();
    await acceptDeal(id);
    const receipt = await markShipped(id);

    const d = await deal(id);
    expect(stateOf(d)).toBe("Shipped");
    expect(await escrow.get_shipment_evidence(id)).toBe(SHIPPED);
    const ev = findEvent(escrow, receipt, "GoodsShipped");
    expect(ev.evidence).toBe(SHIPPED);
    expect(ev.deadline).toBe(d.deadline);
    // Devnet's executed-against timestamp can trail the sealed block by a second or two.
    const block = await provider.getBlock(receipt.value.block_number);
    const startedAt = d.deadline - BigInt(WINDOWS.decision);
    expect(BigInt(block.timestamp) - startedAt).toBeLessThanOrEqual(5n);
  });
});

describe("happy path", () => {
  it("customer accepts, merchant is paid price + bond + fee share, treasury gets its cut", async () => {
    const id = await shippedDeal();
    await expectRevert(send(merchant, escrow.populate("accept_goods", { deal_id: id })), "ESC: not customer");

    const receipt = await send(customer, escrow.populate("accept_goods", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Completed");

    const settled = findEvent(escrow, receipt, "DealSettled");
    expect(settled.outcome).toBe(felt("goods_accepted"));
    expect(settled.to_customer).toBe(0n);
    expect(settled.to_merchant).toBe(PRICE + BOND + MERCHANT_SHARE);
    expect(settled.to_treasury).toBe(TREASURY_SHARE);

    expect(await withdraw(merchant)).toBe(PRICE + BOND + MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
    expect(await credit(customer.address)).toBe(0n);
  });

  it("a finished deal cannot be touched again", async () => {
    const id = await shippedDeal();
    await send(customer, escrow.populate("accept_goods", { deal_id: id }));
    await expectRevert(send(customer, escrow.populate("accept_goods", { deal_id: id })), "ESC: bad state");
    await expectRevert(rejectGoods(id), "ESC: bad state");
    await expectRevert(send(stranger, escrow.populate("claim_timeout", { deal_id: id })), "ESC: bad state");
    await expectRevert(
      send(customer, escrow.populate("raise_dispute", { deal_id: id, reason: "late" })),
      "ESC: bad state",
    );
  });
});

describe("customer goes quiet", () => {
  it("after the decision window anyone can settle in the merchant's favour", async () => {
    const id = await shippedDeal();
    await increaseTime(WINDOWS.decision + 60);

    await expectRevert(rejectGoods(id), "ESC: deadline passed");
    const receipt = await send(stranger, escrow.populate("claim_timeout", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Completed");
    expect(findEvent(escrow, receipt, "DealSettled").outcome).toBe(felt("decision_timeout"));
    expect(await withdraw(merchant)).toBe(PRICE + BOND + MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
  });

  it("customer can still accept after the deadline if nobody claimed yet", async () => {
    const id = await shippedDeal();
    await increaseTime(WINDOWS.decision + 60);
    await send(customer, escrow.populate("accept_goods", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Completed");
    await withdraw(merchant);
    await withdraw(treasury);
  });
});

describe("returns", () => {
  it("reject -> return -> merchant confirms: customer gets price + bond, fee is split", async () => {
    const id = await shippedDeal();

    await rejectGoods(id);
    expect(stateOf(await deal(id))).toBe("Returning");

    await send(customer, escrow.populate("mark_returned", { deal_id: id, evidence: RETURNED }));
    expect(stateOf(await deal(id))).toBe("Returned");
    expect(await escrow.get_return_evidence(id)).toBe(RETURNED);

    await expectRevert(send(customer, escrow.populate("confirm_return", { deal_id: id })), "ESC: not merchant");
    const receipt = await send(merchant, escrow.populate("confirm_return", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Refunded");

    const settled = findEvent(escrow, receipt, "DealSettled");
    expect(settled.outcome).toBe(felt("return_confirmed"));
    expect(await withdraw(customer)).toBe(PRICE + BOND);
    expect(await withdraw(merchant)).toBe(MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
  });

  it("customer rejects but never sends the goods back: merchant is paid", async () => {
    const id = await shippedDeal();
    await rejectGoods(id);
    await increaseTime(WINDOWS.return_ship + 60);

    await expectRevert(
      send(customer, escrow.populate("mark_returned", { deal_id: id, evidence: RETURNED })),
      "ESC: deadline passed",
    );
    const receipt = await send(stranger, escrow.populate("claim_timeout", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Completed");
    expect(findEvent(escrow, receipt, "DealSettled").outcome).toBe(felt("return_timeout"));
    expect(await withdraw(merchant)).toBe(PRICE + BOND + MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
  });

  it("merchant ignores the returned goods: customer is refunded", async () => {
    const id = await shippedDeal();
    await rejectGoods(id);
    await send(customer, escrow.populate("mark_returned", { deal_id: id, evidence: RETURNED }));
    await increaseTime(WINDOWS.return_confirm + 60);

    const receipt = await send(stranger, escrow.populate("claim_timeout", { deal_id: id }));
    expect(stateOf(await deal(id))).toBe("Refunded");
    expect(findEvent(escrow, receipt, "DealSettled").outcome).toBe(felt("return_confirm_timeout"));
    expect(await withdraw(customer)).toBe(PRICE + BOND);
    expect(await withdraw(merchant)).toBe(MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
  });
});

describe("disputes", () => {
  it("only a party can dispute, only after shipping", async () => {
    const { id } = await createDeal();
    await expectRevert(
      send(customer, escrow.populate("raise_dispute", { deal_id: id, reason: "x" })),
      "ESC: bad state",
    );
    await acceptDeal(id);
    await markShipped(id);
    await expectRevert(
      send(stranger, escrow.populate("raise_dispute", { deal_id: id, reason: "x" })),
      "ESC: not a party",
    );
    await send(merchant, escrow.populate("raise_dispute", { deal_id: id, reason: "customer damaged it" }));
    expect(stateOf(await deal(id))).toBe("Disputed");
    await send(admin, escrow.populate("resolve_dispute", { deal_id: id, customer_price_bps: 0, customer_bond_bps: 0 }));
  });

  it("a dispute freezes the clock and only the admin can settle it", async () => {
    const id = await shippedDeal();
    const receipt = await send(customer, escrow.populate("raise_dispute", { deal_id: id, reason: "counterfeit" }));
    expect(findEvent(escrow, receipt, "DisputeRaised").reason).toBe("counterfeit");

    await increaseTime(WINDOWS.decision + 60);
    await expectRevert(send(stranger, escrow.populate("claim_timeout", { deal_id: id })), "ESC: bad state");
    await expectRevert(send(customer, escrow.populate("accept_goods", { deal_id: id })), "ESC: bad state");
    await expectRevert(
      send(stranger, escrow.populate("resolve_dispute", { deal_id: id, customer_price_bps: 5000, customer_bond_bps: 10_000 })),
      "Caller is not the owner",
    );

    // 50% of the price back to the customer, and the whole bond since they must ship it back.
    const resolved = await send(
      admin,
      escrow.populate("resolve_dispute", { deal_id: id, customer_price_bps: 5000, customer_bond_bps: 10_000 }),
    );
    expect(stateOf(await deal(id))).toBe("Resolved");

    const settled = findEvent(escrow, resolved, "DealSettled");
    expect(settled.outcome).toBe(felt("admin_resolved"));
    expect(settled.to_customer).toBe(PRICE / 2n + BOND);
    expect(settled.to_merchant).toBe(PRICE / 2n + MERCHANT_SHARE);
    expect(settled.to_treasury).toBe(TREASURY_SHARE);

    expect(await withdraw(customer)).toBe(PRICE / 2n + BOND);
    expect(await withdraw(merchant)).toBe(PRICE / 2n + MERCHANT_SHARE);
    expect(await withdraw(treasury)).toBe(TREASURY_SHARE);
  });

  it("can be raised from the return leg too", async () => {
    const id = await shippedDeal();
    await rejectGoods(id);
    await send(customer, escrow.populate("mark_returned", { deal_id: id, evidence: RETURNED }));
    await send(merchant, escrow.populate("raise_dispute", { deal_id: id, reason: "came back broken" }));
    expect(stateOf(await deal(id))).toBe("Disputed");
    await send(admin, escrow.populate("resolve_dispute", { deal_id: id, customer_price_bps: 10_000, customer_bond_bps: 10_000 }));
    expect(await withdraw(customer)).toBe(PRICE + BOND);
  });
});

describe("accounting", () => {
  it("the contract never holds more than the sum of open deals plus unclaimed credits", async () => {
    // Every earlier test withdrew what it was owed, apart from a few deals left open on
    // purpose. Whatever is left in the contract must be explained by open deals + credits.
    const held = await balanceOf(eth, escrow.address);
    const count = BigInt(await escrow.deal_count());
    let locked = 0n;
    for (let id = 1n; id <= count; id++) {
      const d = await deal(id);
      const s = stateOf(d);
      if (s === "Created") locked += d.price + d.protection_fee;
      else if (["Accepted", "Shipped", "Returning", "Returned", "Disputed"].includes(s)) {
        locked += d.price + d.protection_fee + d.return_bond;
      }
    }
    let credits = 0n;
    for (const a of [admin, customer, merchant, treasury, stranger]) credits += await credit(a.address);
    expect(held).toBe(locked + credits);
  });
});
