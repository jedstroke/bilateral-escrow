<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/weselling-wordmark-on-dark.png">
  <img src="assets/weselling-wordmark-on-light.png" alt="WeSelling" width="220">
</picture>

# Bilateral Escrow

A [WeSelling](https://weselling.store) initiative.

A buyer and a seller who don't trust each other, and a contract that holds both of their money until the deal is done.

Most escrows protect the customer. This one also protects the merchant. Both sides put money in, both sides have deadlines, and whoever stops cooperating loses something. The contract runs on its own; an admin only steps in when someone raises a dispute.

## The two parties

**Customer** pays the price of the goods plus a small protection fee. Think of the fee as an insurance premium. It buys the right to reject the goods and get the price back.

**Merchant** posts a return bond. This is the money that pays for shipping the goods back if the customer rejects them. It is returned to the merchant when the deal closes normally.

Both amounts are in the same ERC-20 token (a stablecoin, typically). The admin decides which tokens are accepted.

## Where the money goes

Every deal has three pots: the **price**, the **protection fee**, and the **return bond**.

| How the deal ends | Price | Protection fee | Return bond |
|---|---|---|---|
| Customer cancels before the merchant accepts | back to customer | back to customer | never posted |
| Nobody accepts in time | back to customer | back to customer | never posted |
| Merchant accepts, then backs out or never ships | back to customer | back to customer | **to customer** |
| Customer accepts the goods | to merchant | split | back to merchant |
| Customer says nothing until the deadline | to merchant | split | back to merchant |
| Customer rejects but never sends the goods back | to merchant | split | back to merchant |
| Customer returns the goods and the merchant confirms | back to customer | split | **to customer** |
| Customer returns the goods and the merchant ignores it | back to customer | split | **to customer** |
| Admin resolves a dispute | admin picks the split | split | admin picks the split |

"Split" means the protection fee is divided between the treasury and the merchant. The percentages are set by the admin (for example 20% treasury, 80% merchant). Once the goods have shipped, the fee is never refunded: it was the premium for the protection the customer got, whether they used it or not. This is also the merchant's upside for taking part: on a normal sale they earn the price plus most of the fee.

Two things to notice in the table:

- A merchant who commits and then disappears loses the bond to the customer. That is the merchant's integrity check.
- A customer who keeps the goods and goes quiet, or "rejects" but never ships them back, pays the full price. That is the customer's integrity check.

## The life of a deal

```
                 customer pays                 merchant posts bond
   (nothing) ─────────────────► Created ────────────────────────► Accepted
                                  │                                   │
                                  │ cancel / accept window            │ merchant ships (evidence)
                                  │ passes                            │
                                  ▼                                   ▼
                              Cancelled ◄──── backs out / ────── Shipped
                                              ship window            │
                                              passes                 ├── customer accepts ───────────► Completed
                                                                     ├── decision window passes ─────► Completed
                                                                     │
                                                                     └── customer rejects ──► Returning
                                                                                                │
                                                                     ┌── return window passes ─┴─► Completed
                                                                     │
                                                              customer ships back (evidence)
                                                                     │
                                                                     ▼
                                                                  Returned
                                                                     ├── merchant confirms ────────► Refunded
                                                                     └── confirm window passes ────► Refunded

   From Shipped, Returning or Returned either party can raise a dispute ──► Disputed ──(admin)──► Resolved
```

Step by step:

1. **Customer opens the deal.** They name the merchant, the token, the price, the return bond they expect the merchant to post, and a link (IPFS CID) to what they are buying. The contract pulls `price + fee` from their wallet.
2. **Merchant accepts.** The contract pulls the bond. The merchant now has a fixed time to ship. If they don't want the deal, they simply never accept and the customer takes their money back.
3. **Merchant marks it shipped** and attaches evidence: photos, tags, serial numbers, tracking, whatever proves what left the warehouse. This lives on IPFS; the CID is stored on-chain.
4. **Customer decides.** Accept, and the merchant is paid immediately. Reject, and a return starts. Do nothing until the deadline, and anyone can close the deal in the merchant's favour.
5. **If rejected, the customer ships the goods back** and attaches their own evidence. They front the return postage; the bond covers it once the merchant confirms.
6. **Merchant confirms the return** and the customer is refunded. If the merchant says nothing until the deadline, the refund happens anyway.

Every deadline can be enforced by *anyone*, not just the two parties. A bot, the other party, or the platform can call `claim_timeout` once the clock has run out. Nobody can be held hostage by the other side going silent.

## Disputes

After the goods have shipped, either party can freeze the deal. Nothing moves until the admin resolves it. The admin chooses what share of the price and what share of the bond goes to the customer; the rest goes to the merchant. The protection fee is split as usual.

The admin cannot send the money anywhere else. There is no path by which the admin, the treasury, or anyone but the two parties receives the price or the bond.

This is the one place a human is in the loop. Everything else is deterministic.

## Getting paid

Settlement never sends tokens. It credits an internal balance, and each party calls `withdraw(token)` to pull what they are owed. This is deliberate:

- A failing or malicious token transfer to one party can never block the other party's payout.
- There is no external call in the middle of settlement logic, so there is nothing to re-enter.
- Gas for the payout is paid by the person receiving it.

Withdrawals keep working even if the admin later removes the token from the allow-list or pauses the contract.

## What the admin can and cannot do

Can:

- allow or disallow tokens for *new* deals
- change the fee rates and time windows for *new* deals
- change the treasury address
- pause new deals and new acceptances
- resolve disputes between the two parties
- hand ownership to a new admin (two-step, so a typo cannot lock the contract)

Cannot:

- touch a deal that is not disputed
- change the terms of a deal that already exists (fees and windows are copied into the deal when it is created)
- move funds to any address other than the customer, the merchant, or the treasury's share of the fee
- stop anyone from withdrawing what they are owed

## Security notes

The contract is short on purpose. The things that matter:

- **State before transfers.** Every function writes its new state before calling out to the token, and every token call is checked for success. There is also a reentrancy guard on every state-changing function.
- **Pull payments** as described above.
- **Every deal snapshots its terms.** Fee rates and windows are copied into the deal, so admin changes only affect future deals.
- **No unbounded loops.** Nothing iterates over deals or balances.
- **Timeouts are permissionless.** No party can stall a deal past its deadline by refusing to act.
- **Deadlines are checked on the action, not the timeout.** Rejecting after the decision window fails; accepting after it still works, because a late acceptance only helps the merchant.
- **A dispute stops the clock.** Timeouts do not fire on a disputed deal.
- **Amounts add up.** The tests assert that the contract's token balance always equals the sum of open deals plus unclaimed credits.

Things this contract does *not* handle, and assumes the admin handles by choosing tokens carefully: fee-on-transfer tokens, rebasing tokens, tokens whose `transfer` does not return a boolean.

## Choices you might want to change

These are policy decisions, not technical requirements. Each is one line in the contract.

- **Merchant who backs out loses the whole bond.** You could make it a percentage.
- **Merchant keeps their fee share on a refund.** The argument for: they shipped and paid outbound postage. The argument against: they sold something the customer didn't want.
- **Disputes can be raised after a deadline** as long as nobody has claimed the timeout yet. This prevents someone being locked out by a few seconds, at the cost of letting a party who missed their window still reach the admin.
- **The customer chooses the bond amount** when opening the deal. The merchant agrees to it by accepting. You could have the admin set a minimum, or tie it to the price.
- **Only the customer's acceptance releases payment.** The merchant does not co-sign. They already agreed by accepting and shipping; requiring a second signature would only give a merchant a way to stall their own payout, which helps nobody.

## Interface

Customer: `create_deal`, `cancel_deal`, `accept_goods`, `reject_goods`, `mark_returned`
Merchant: `accept_deal`, `back_out`, `mark_shipped`, `confirm_return`
Either party: `raise_dispute`
Anyone: `claim_timeout`, `withdraw`
Admin: `resolve_dispute`, `set_token_allowed`, `set_fees`, `set_windows`, `set_treasury`, `pause`, `unpause`, `transfer_ownership`, `accept_ownership`
Views: `get_deal`, `get_metadata`, `get_shipment_evidence`, `get_return_evidence`, `get_balance`, `is_token_allowed`, `get_fees`, `get_windows`, `get_treasury`, `deal_count`, `quote_protection_fee`

Full signatures are in [contracts/src/interface.cairo](../contracts/src/interface.cairo). Every terminal state emits one `DealSettled` event with the outcome and the exact amounts credited to each side; that is the event an indexer should watch.
